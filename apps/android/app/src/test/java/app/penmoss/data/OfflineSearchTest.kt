package app.penmoss.data

import androidx.room.withTransaction
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SearchFilters
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TreeNote
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

/**
 * The offline full-text index (T40 P6, FD3, FD4): text from `/sync/batch` and from the editor
 * page, read the way the server reads a query, ranked like it, filtered in Room.
 */
@RunWith(AndroidJUnit4::class)
class OfflineSearchTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var search: OfflineSearch
    private var clock = 0L

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 5_000 })
        search = OfflineSearch(db)
    }

    @After
    fun close() = db.close()

    /** A note the server indexed, then its text in a front exchange, as a pass stores them. */
    private suspend fun note(
        id: String,
        title: String,
        text: String,
        updatedAt: Long = 100,
        tags: List<String> = emptyList(),
        deleted: Boolean = false,
    ) {
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote(id, clock, title, text.take(40), updatedAt, deleted, tags = tags))))
        val sent = store.content(id)
        val entry = Exchange.entry(sent, withText = true)
        store.saveExchange(Exchange.decide(sent, entry, BatchNoteReply(id, "e1", "U$id", "SV", null, text = text, textHash = textHash(text))))
    }

    private suspend fun ids(query: String, filters: SearchFilters = SearchFilters(), prefixLast: Boolean = false) =
        search.search(query, filters, prefixLast = prefixLast).map { it.noteId }

    @Test
    fun findsAWordInANotesBodyOffline() = runTest {
        note("a", "Garden plan", "Tomatoes along the fence.\nBasil by the door.")
        note("b", "Groceries", "Oat milk and lemons")
        assertEquals(listOf("a"), ids("basil"))
        assertEquals(listOf("b"), ids("lemons"))
        // Its text is stored, not due again, with the server's hash to send next time.
        val row = store.note("a")!!
        assertFalse(row.textDue)
        assertEquals(textHash("Tomatoes along the fence.\nBasil by the door."), row.textHash)
        assertEquals(textHash("Tomatoes along the fence.\nBasil by the door."), store.content("a").textHash)
    }

    @Test
    fun marksTheMatchedWordsInTheSnippetAndTheTitle() = runTest {
        note("a", "Garden plan", "the garden hose drips all summer")
        val hit = search.search("garden").single()
        assertEquals("the \u0002garden\u0003 hose drips all summer", hit.snippet)
        assertEquals("\u0002Garden\u0003 plan", hit.titleMarked)
        // A title without the word is left unmarked.
        note("b", "Hoses", "a garden hose")
        assertEquals("", search.search("garden").first { it.noteId == "b" }.titleMarked)
    }

    @Test
    fun readsQueriesAsTheServerDoes() = runTest {
        note("a", "Trip", "Train to Lisbon then the coast road")
        note("b", "Notes", "the coast and then a train")
        note("c", "Lisbon guide", "Where to eat")
        // Every word must match; a quoted phrase is consecutive words.
        assertEquals(setOf("a", "b"), ids("train coast").toSet())
        assertEquals(listOf("a"), ids("\"coast road\""))
        // A prefix: typed, with a star, or the last word while typing.
        assertEquals(listOf("a"), ids("Lisb* train"))
        assertEquals(setOf("a", "c"), ids("lisb", prefixLast = true).toSet())
        assertEquals(emptyList<String>(), ids("lisb"))
        // `-word` leaves notes out; `title:` looks in titles only.
        assertEquals(listOf("a"), ids("train -notes -\"and then\""))
        assertEquals(listOf("c"), ids("title:lisbon"))
        // Only exclusions: nothing to look for, as on the server.
        assertEquals(emptyList<String>(), ids("-train"))
        // Nothing typed is FTS syntax.
        assertEquals(emptyList<String>(), ids("\"unclosed OR NEAR( * :"))
    }

    @Test
    fun stemsEnglishWordsAsTheServerDoes() = runTest {
        note("a", "Gardening", "Planting the gardens in spring")
        assertEquals(listOf("a"), ids("garden"))
        assertEquals(listOf("a"), ids("planted"))
    }

    /**
     * Review R4: FTS4's porter tokenizer kept only the first and last 3 bytes of a longer word
     * with a digit, and the first and last 10 bytes of a word over 20 bytes (a long CJK or
     * Cyrillic run too), so prefixes missed and different words matched (5551234567 and
     * 555999567 were both 555567). The phone now stems in Kotlin as core does and indexes with
     * the simple tokenizer.
     */
    @Test
    fun findsWordsWithDigitsLongWordsAndLongRunsWhole() = runTest {
        note("phone", "Call back", "Phone 5551234567 after lunch")
        note("sha", "Release", "Fixed in commit 07f7c6f, ticket rh12345")
        note("long", "History", "The counterrevolutionaries regrouped")
        note("cjk", "日记", "我们今天去公园散步")
        note("ru", "Москва", "Достопримечательности города")
        note("other", "Numbers", "Phone 5559991234 and commit 07fc6f00")
        // Prefixes as they are typed.
        assertEquals(listOf("phone"), ids("555123", prefixLast = true))
        assertEquals(listOf("sha"), ids("07f7c", prefixLast = true))
        assertEquals(listOf("sha"), ids("rh123", prefixLast = true))
        assertEquals(listOf("long"), ids("counterrevolution", prefixLast = true))
        assertEquals(listOf("cjk"), ids("我们今天", prefixLast = true))
        assertEquals(listOf("ru"), ids("достопримечательн", prefixLast = true))
        // Whole words: the held ones match, and ones that differ only past FTS4's cut do not.
        assertEquals(listOf("phone"), ids("5551234567"))
        assertEquals(listOf("long"), ids("counterrevolutionaries"))
        assertEquals(emptyList<String>(), ids("555999567"))
        assertEquals(emptyList<String>(), ids("07fc6f"))
        assertEquals(emptyList<String>(), ids("我们今天"))
        // The whole held word is marked.
        assertEquals("Phone \u00025551234567\u0003 after lunch", search.search("555123", prefixLast = true).single().snippet)
    }

    @Test
    fun ranksATitleMatchAboveABodyMatch() = runTest {
        note("body", "Weekly review", "lemon tart and other things", updatedAt = 300)
        note("title", "Lemon tart", "a recipe", updatedAt = 100)
        assertEquals(listOf("title", "body"), ids("lemon"))
    }

    @Test
    fun appliesTheFoldersTagsAndUpdatedFiltersOffline() = runTest {
        note("a", "In projects", "shared word", updatedAt = 1_000, tags = listOf("area/cooking"))
        note("b", "In penmoss", "shared word", updatedAt = 3_000, tags = listOf("area"))
        note("c", "At the top", "shared word", updatedAt = 5_000, tags = listOf("areas"))
        store.saveTree(
            SyncTree(
                hash = "h",
                folders = listOf(TreeFolder("p", "Projects", null, "a0"), TreeFolder("pm", "Penmoss", "p", "a0")),
                notes = listOf(TreeNote("a", "p", "a0"), TreeNote("b", "pm", "a0"), TreeNote("c", null, "a0")),
            ),
        )
        // A folder with its subfolders.
        assertEquals(setOf("a", "b"), ids("shared", SearchFilters(folderId = "p")).toSet())
        assertEquals(listOf("b"), ids("shared", SearchFilters(folderId = "pm")))
        // A tag with the tags under it, never one that only starts the same.
        assertEquals(setOf("a", "b"), ids("shared", SearchFilters(tag = "area")).toSet())
        assertEquals(listOf("a"), ids("shared", SearchFilters(tag = "area/cooking")))
        // Updated at or after.
        assertEquals(setOf("b", "c"), ids("shared", SearchFilters(updatedAfter = 3_000)).toSet())
        assertEquals(listOf("b"), ids("shared", SearchFilters(folderId = "p", tag = "area", updatedAfter = 2_000)))
    }

    @Test
    fun keepsEachNotesTagsFromChangesAndDropsThemInTrash() = runTest {
        note("a", "Tagged", "body", tags = listOf("project", "area/cooking", "project"))
        assertEquals(listOf("area/cooking", "project"), db.search().tagsOf("a"))
        assertEquals(listOf(TagCountRow("area/cooking", 1), TagCountRow("project", 1)), store.observeTagCounts().first())
        // An older server sends no tags: they stay as they were.
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote("a", clock, "Tagged", "", 200))))
        assertEquals(listOf("area/cooking", "project"), db.search().tagsOf("a"))
        // An older row never replaces a newer one's tags.
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote("a", 1, "Tagged", "", 200, tags = listOf("stale")))))
        assertEquals(listOf("area/cooking", "project"), db.search().tagsOf("a"))
        // In Trash: the server sends none, and the note leaves search and the counts.
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote("a", clock, "Tagged", "", 300, deleted = true, tags = emptyList()))))
        assertEquals(emptyList<String>(), db.search().tagsOf("a"))
        assertEquals(emptyList<String>(), ids("body"))
        assertEquals(emptyList<TagCountRow>(), store.observeTagCounts().first())
    }

    @Test
    fun aRenameElsewhereIsFoundByItsNewTitleAtOnce() = runTest {
        note("a", "Old name", "body text")
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote("a", clock, "Fresh name", "", 200, tags = listOf("new")))))
        assertEquals(listOf("a"), ids("fresh"))
        assertEquals(listOf("a"), ids("new"))
        assertEquals(emptyList<String>(), ids("old"))
    }

    @Test
    fun findsThePhonesOwnUnsentTextFromThePage() = runTest {
        note("a", "Draft", "first words")
        store.addPending("a", "EDIT", "e1")
        store.savePageText("a", "first words and the phone's own sentence about otters")
        assertEquals(listOf("a"), ids("otters"))
        // The server's reply comes before it holds the edit (it was not in the request): its
        // text lacks the edit, so the page's stands.
        val sent = store.content("a").copy(pending = emptyList())
        store.saveExchange(
            Exchange.decide(sent, Exchange.entry(sent, withText = true), BatchNoteReply("a", "e1", "U2", "SV2", null, text = "first words", textHash = textHash("first words"))),
        )
        assertEquals(listOf("a"), ids("otters"))
        // Once the server holds it, its text (the edit merged with others') replaces the page's.
        val all = store.content("a")
        store.saveExchange(
            Exchange.decide(all, Exchange.entry(all, withText = true), BatchNoteReply("a", "e1", "U3", "SV3", null, text = "first words otters and a web edit", textHash = "h3")),
        )
        assertEquals(listOf("a"), ids("web"))
        assertEquals("h3", store.note("a")!!.textHash)
    }

    @Test
    fun textChangedOnAPassThatAskedForNoneIsDueAgain() = runTest {
        note("a", "Kept", "old text")
        assertFalse(store.note("a")!!.textDue)
        val sent = store.content("a").copy(clock = 9)
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("a", "e1", "NEW", "SV9", null)))
        assertTrue(store.note("a")!!.textDue)
        // The old text stays searchable until the next pass that may prefetch fetches the new.
        assertEquals(listOf("a"), ids("old"))
        assertEquals(listOf("a"), store.dueContent(10, prefetch = true, skip = emptySet()).map { it.noteId })
        assertEquals(emptyList<String>(), store.dueContent(10, prefetch = false, skip = emptySet()).map { it.noteId })
    }

    /** Review nit: a deferred reply kept for its stale edits (no text, no hash) leaves the text due. */
    @Test
    fun aDeferredReplyKeptForItsStaleEditsLeavesTheTextDue() = runTest {
        note("a", "Kept", "old text")
        val sent = store.content("a").copy(clock = 9)
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("a", "e1", "NEW", "SV9", null)))
        assertTrue(store.note("a")!!.textDue)
        store.saveExchange(app.penmoss.engine.sync.ExchangeResult("a", app.penmoss.engine.sync.ExchangeResult.Kind.RETRY, conflictPending = listOf(1L), textAsked = true))
        assertTrue(store.note("a")!!.textDue)
        // An applied reply that says the phone's copy is current settles it.
        store.saveExchange(app.penmoss.engine.sync.ExchangeResult("a", app.penmoss.engine.sync.ExchangeResult.Kind.APPLIED, textAsked = true, textHash = store.note("a")!!.textHash))
        assertFalse(store.note("a")!!.textDue)
    }

    @Test
    fun anOlderServerThatSendsNoTextIsNotAskedAgainAndAgain() = runTest {
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote("a", clock, "Old server", "first line", 100))))
        val sent = store.content("a")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent, withText = true), BatchNoteReply("a", "e1", "U", "SV", null)))
        assertFalse(store.note("a")!!.textDue)
        assertEquals(emptyList<String>(), store.dueContent(10, prefetch = true, skip = emptySet()).map { it.noteId })
        // Its title and first line are still found, as before the index.
        assertEquals(listOf("a"), ids("first"))
    }

    @Test
    fun searchesTitlesAndFirstLinesOfNotesNotFetchedYet() = runTest {
        store.saveChanges(
            ChangesPage(
                1,
                notes = listOf(
                    ChangedNote("a", 1, "Garden plan", "Tomatoes along the fence", 2),
                    ChangedNote("b", 1, "100% done", "", 1),
                    ChangedNote("c", 1, "Trash", "garden", 3, deleted = true),
                ),
            ),
        )
        assertEquals(listOf("a"), ids("garden"))
        assertEquals(listOf("a"), ids("FENCE"))
        assertEquals(listOf("b"), ids("100%"))
        assertEquals(emptyList<String>(), ids("  "))
        assertEquals("Tomatoes along the fence", search.search("garden").single().excerpt)
    }

    @Test
    fun aNoteDeletedForGoodLeavesTheIndex() = runTest {
        note("a", "Doomed", "unique words")
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote("a", clock, purged = true))))
        assertEquals(null, db.search().text("a"))
        assertEquals(emptyList<String>(), ids("unique"))
    }

    @Test
    fun saysWhenTheLastWordIsStillBeingTyped() = runTest {
        note("a", "Lemons", "lemon tart")
        assertTrue(search.unfinished("lem"))
        assertFalse(search.unfinished("lemon"))
        assertFalse(search.unfinished("lem "))
        assertFalse(search.unfinished("zzz"))
    }

    /** #120 (A680): a word typed past its stem finds what the whole word finds. */
    @Test
    fun findsAWordTypedPastItsStem() = runTest {
        note("joy", "Happiness", "Notes on happiness, and on being happy")
        note("gym", "Training", "Conditioning work for three generations of runners")
        note("family", "Family tree", "Four generations, and the ties that bind them")
        for (other in listOf("Boiler", "Bread", "Car", "Dentist", "Holiday", "Taxes")) note(other, other, "$other reminders")
        for ((typed, word) in listOf("happin" to "happiness", "conditio" to "conditioning", "generati" to "generations", "tie" to "ties")) {
            val partly = search.search(typed, prefixLast = true)
            val whole = search.search(word, prefixLast = false)
            assertEquals(typed, whole.map { it.noteId to it.score }, partly.map { it.noteId to it.score })
            assertTrue(typed, partly.isNotEmpty())
        }
        assertEquals(listOf("gym"), ids("runners conditio", prefixLast = true))
        assertEquals(listOf("joy"), ids("title:happin", prefixLast = true))
        assertEquals(emptyList<String>(), ids("title:conditio", prefixLast = true))
        assertEquals(emptyList<String>(), ids("happin"))
        // Marked as the whole word would be.
        val hit = search.search("happin", prefixLast = true).single()
        assertEquals("\u0002Happiness\u0003", hit.titleMarked)
        assertTrue(hit.snippet, hit.snippet.contains("\u0002happiness\u0003, and on being \u0002happy\u0003"))
        assertTrue(search.unfinished("happin"))
        assertTrue(search.unfinished("conditio"))
        assertFalse(search.unfinished("happiness"))
        // A note gone takes its words with it.
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote("joy", clock, purged = true))))
        assertEquals(emptyList<String>(), ids("happin", prefixLast = true))
        assertFalse(search.unfinished("happin"))
    }

    /** Review B1: the phone cuts and folds text where the server's unicode61 does. */
    @Test
    fun foldsTextAndQueriesAsTheServerDoes() = runTest {
        note("apos", "Notes", "Ryan’s garden")
        note("dash", "Notes", "foo—bar notes")
        note("nbsp", "Notes", "non\u00a0breaking")
        note("curly", "Notes", "“quoted” words")
        note("dots", "Notes", "ellipsis…next")
        note("accent", "Café Éclair", "pastry")
        assertEquals(listOf("apos"), ids("ryan"))
        assertEquals(listOf("dash"), ids("foo"))
        assertEquals(listOf("dash"), ids("bar"))
        assertEquals(listOf("nbsp"), ids("breaking"))
        assertEquals(listOf("curly"), ids("quoted"))
        assertEquals(listOf("dots"), ids("next"))
        // Case and accents fold both ways, in the index and the query.
        assertEquals(listOf("accent"), ids("éclair"))
        assertEquals(listOf("accent"), ids("ECLAIR"))
        assertEquals(listOf("accent"), ids("cafe"))
        assertEquals(listOf("accent"), ids("title:Éclair"))
        // A typed apostrophe or dash separates as the server's does.
        assertEquals(listOf("apos"), ids("Ryan’s"))
        assertEquals(listOf("dash"), ids("\"foo—bar\""))
    }

    @Test
    fun marksTheOriginalCharactersOfFoldedMatches() = runTest {
        note("a", "Café Éclair", "ÉCLAIR — Ryan’s “cream” filling")
        val hit = search.search("eclair cream").single()
        assertEquals("Café \u0002Éclair\u0003", hit.titleMarked)
        assertEquals("\u0002ÉCLAIR\u0003 — Ryan’s “\u0002cream\u0003” filling", hit.snippet)
    }

    /** Review S6: headings are their own column (weight 4), and their snippet shows when the body has no match. */
    @Test
    fun indexesHeadingsAndShowsTheirSnippetWhenTheBodyHasNoMatch() = runTest {
        noteWithHeadings("h", "Recipes", "Desserts\nlemon tart for later", "Desserts")
        note("b", "Other", "desserts once")
        val hits = search.search("desserts")
        // A heading word (4) outweighs a body word (1).
        assertEquals(listOf("h", "b"), hits.map { it.noteId })
        noteWithHeadings("only", "Plan", "tomatoes", "Sauces")
        assertEquals("\u0002Sauces\u0003", search.search("sauces").single().snippet)
    }

    /** Review B2: the page's same text again writes nothing to the index. */
    @Test
    fun thePagesSameTextAgainWritesNothing() = runTest {
        note("a", "Draft", "first words")
        store.savePageText("a", "first words and more", "", emptyList())
        val before = totalChanges()
        store.savePageText("a", "first words and more", "", emptyList())
        assertEquals(before, totalChanges())
        store.savePageText("a", "first words and more again", "", emptyList())
        assertTrue(totalChanges() > before)
        assertEquals(textHash("first words and more again", ""), store.note("a")!!.textHash)
    }

    /**
     * A large vault (review nit, as A101 timed the web's): 5,000 notes, and a two-letter prefix
     * (every keystroke's worst case) answered in well under a keystroke's pause.
     */
    /**
     * Review S-A (A610): marks take each word's place from the stored, stemmed column, never by
     * stemming again at read time. A row stemmed by an older [SearchStem] (here `runningxx` for
     * `running`) still marks the right word, which re-stemming today's way would miss (N6).
     */
    @Test
    fun marksFollowTheStoredWordsNotTodaysStems() = runTest {
        note("a", "Walks", "running dogs in the park")
        db.openHelper.writableDatabase.execSQL("UPDATE note_texts SET fbody = 'runningxx dog in the park' WHERE noteId = 'a'")
        assertEquals("running \u0002dogs\u0003 in the park", search.search("dog").single().snippet)
        assertEquals("…the \u0002park\u0003", search.search("park").single().snippet)
    }

    /**
     * Review S-A (A610): 30 hits of about 30 KB each, every one marked, in the title and the
     * snippet, where the words are; quickly, since this runs on each pause in typing.
     */
    @Test
    fun marksThirtyLongHitsQuickly() = runTest {
        val filler = listOf("happiness", "relational", "conditioning", "Café", "我们今天", "ørsteds", "running", "generations")
        db.withTransaction {
            (1..30).forEach { i ->
                val id = "n%02d".format(i)
                store.saveChanges(ChangesPage(i.toLong(), notes = listOf(ChangedNote(id, i.toLong(), "Gardens $i", "", i.toLong()))))
                val body = buildString {
                    var k = 0
                    while (length < 30_000) append(filler[(i + k++) % filler.size]).append(if (k % 9 == 0) ".\n" else " ")
                    append("the target word at the end")
                }
                db.search().putText(NoteTextEntity.of(id, "Gardens $i", body, "", ""))
            }
        }
        search.search("garden target") // warm up
        val started = System.nanoTime()
        val hits = search.search("garden target")
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertEquals(30, hits.size)
        hits.forEach { hit ->
            assertTrue(hit.titleMarked, hit.titleMarked.startsWith("\u0002Gardens\u0003 "))
            assertTrue(hit.snippet, hit.snippet.endsWith("the \u0002target\u0003 word at the end"))
        }
        println("offline search, 30 hits of 30 KB: $elapsedMs ms")
        assertTrue("took $elapsedMs ms", elapsedMs < 100)
    }

    /**
     * Review S-A (A610): a search does its work on [OfflineSearch]'s own dispatcher (the
     * default one in the app), never on the thread that asked, so Main never folds or ranks.
     * While that dispatcher is held, the search cannot finish; once it is free, it gives the
     * same answer.
     */
    @Test
    fun searchesOnItsOwnDispatcherNotTheCallers() = runTest {
        note("a", "Garden plan", "the garden hose drips all summer")
        val expected = search.search("garden")
        val pool = Executors.newSingleThreadExecutor()
        try {
            val held = CountDownLatch(1)
            pool.execute { held.await() }
            val offMain = OfflineSearch(db, work = pool.asCoroutineDispatcher())
            val answer = CoroutineScope(Dispatchers.Unconfined).async { offMain.search("garden") }
            val early = runCatching { withContext(Dispatchers.IO) { withTimeout(1_000) { answer.await() } } }
            assertTrue("answered while its dispatcher was held: $early", early.isFailure)
            held.countDown()
            assertEquals(expected, withContext(Dispatchers.IO) { withTimeout(5_000) { answer.await() } })
            assertTrue(withContext(Dispatchers.IO) { withTimeout(5_000) { CoroutineScope(Dispatchers.Unconfined).async { offMain.unfinished("gard") }.await() } })
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun answersATwoLetterPrefixOverFiveThousandNotesQuickly() = runTest {
        val words = listOf("garden", "lemon", "basil", "train", "coast", "memory", "kitchen", "budget", "backup", "recipe", "gate", "gap")
        val ids = (1..5_000).map { "n%04d".format(it) }
        store.saveChanges(ChangesPage(1, notes = ids.mapIndexed { i, id -> ChangedNote(id, 1, "Note $i ${words[i % words.size]}", "", i.toLong()) }))
        db.withTransaction {
            ids.forEachIndexed { i, id ->
                val body = (0 until 60).joinToString(" ") { words[(i + it * 7) % words.size] + if (it % 5 == 0) "s" else "" }
                db.search().putText(NoteTextEntity.of(id, "Note $i ${words[i % words.size]}", body, "", ""))
            }
        }
        search.search("ga", prefixLast = true) // warm up
        val started = System.nanoTime()
        val hits = search.search("ga", prefixLast = true)
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertEquals(OfflineSearch.DEFAULT_LIMIT, hits.size)
        assertTrue("took $elapsedMs ms", elapsedMs < 300)
        println("offline search, 5,000 notes, \"ga\" as typed: $elapsedMs ms")
    }

    private fun totalChanges(): Long = db.openHelper.writableDatabase.query("SELECT total_changes()").use { it.moveToFirst(); it.getLong(0) }

    private suspend fun noteWithHeadings(id: String, title: String, text: String, headings: String) {
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote(id, clock, title, "", 100))))
        val sent = store.content(id)
        val entry = Exchange.entry(sent, withText = true)
        store.saveExchange(Exchange.decide(sent, entry, BatchNoteReply(id, "e1", "U$id", "SV", null, text = text, headings = headings, textHash = textHash(text, headings))))
    }
}
