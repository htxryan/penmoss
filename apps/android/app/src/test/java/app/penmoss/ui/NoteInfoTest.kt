package app.penmoss.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Modifier
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.test.core.app.ApplicationProvider
import app.penmoss.FakeApi
import app.penmoss.data.BacklinkSource
import app.penmoss.data.FolderEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.editor.NoteCounts
import app.penmoss.engine.api.BacklinksReply
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.InfoField
import app.penmoss.engine.notes.BacklinkLists
import app.penmoss.engine.notes.ContextPart
import app.penmoss.engine.notes.LinkRef
import app.penmoss.engine.notes.LinkedNote
import app.penmoss.engine.notes.Mention
import app.penmoss.engine.notes.SnippetPart
import app.penmoss.engine.notes.UnlinkedNote
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.robolectric.annotation.GraphicsMode
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.time.ZonedDateTime

/**
 * The note's Info sheet (T40 P7, NT23, LK5, LK6; A474, A475): the web's Info panel's details
 * and Backlinks panel's lists in its words, online from the server and cached, offline from the
 * phone's own links.
 */
@RunWith(RobolectricTestRunner::class)
class NoteInfoTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
    private val store = NoteStore(db, now = { NOW - 3_600_000 })

    @After
    fun close() {
        // The models' loads stop before the database closes (a later test's runTest would get
        // a query that failed on it).
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }
        db.close()
    }

    private val noteId = "01JD3A0000000000000000LNK1"
    private val info = FromEditor.NoteInfo(
        noteId,
        "2026-10-23T10:00:00-05:00",
        "daily",
        "2026-10-23",
        listOf(InfoField("id", noteId), InfoField("tags", "[garden, plans]"), InfoField("type", "daily")),
        emptyList(),
    )

    @Test
    fun theDetailsReadAsTheWebsInfoPanel() {
        val rows = infoRows(listOf("Projects", "Garden"), info, editedAt = NOW - 60_000, now = NOW)
        // No Kind row since T42 (A572, A653): a periodic note's label is at the top instead.
        assertEquals(listOf("Folder", "Created", "Edited", "Saved", "Length"), rows.map { it.label })
        assertEquals("Projects / Garden", rows[0].value)
        assertEquals(shortWhen(ZonedDateTime.parse("2026-10-23T10:00:00-05:00").toInstant().toEpochMilli(), NOW), rows[1].value)
        assertEquals(InfoKind("Daily note", "2026-10-23"), infoKind(info))
        assertEquals(InfoKind("Weekly note", "2026-W43"), infoKind(info.copy(kind = "weekly", period = "2026-W43")))
        // An ordinary note, or a kind the phone does not know, carries no label.
        assertEquals(null, infoKind(info.copy(kind = "note", period = null)))
        assertEquals(null, infoKind(info.copy(kind = "meeting")))
        assertEquals(null, infoKind(null))
        val plain = infoRows(emptyList(), info.copy(kind = "note", period = null, created = null), editedAt = null, now = NOW)
        // Before the page has counted and the sync state is known, ellipses, as the web's.
        assertEquals(listOf("Top level", "Unknown", "—", "…", "…"), plain.map { it.value })
        val counted = infoRows(
            emptyList(), info, NOW, NOW,
            saved = NoteSync(NoteSyncState.WAITING),
            counts = NoteCounts(words = 1, characters = 5, minutes = 0, selection = null),
        )
        // The sync icon's words, and the web's status-bar counts (no reading time under a minute).
        assertEquals("Waiting to upload", counted[3].value)
        assertEquals("1 word · 5 characters", counted[4].value)
        // A date the phone cannot read is shown as written; before the page says, an ellipsis.
        assertEquals("yesterday-ish", createdLabel("yesterday-ish", NOW))
        assertEquals("…", infoRows(emptyList(), null, null, NOW)[1].value)
    }

    @Test
    fun theNotebookRowNamesTheNotesNotebookAsTheWebs() {
        val work = FolderEntity("nb1", "Work", null, "a", "manual", notebook = true)
        val plans = FolderEntity("f1", "Plans", "nb1", "a", "manual")
        val garden = FolderEntity("f2", "Garden", null, "b", "manual")
        val folders = listOf(work, plans, garden)
        // One notebook only, as the web: no row.
        assertNull(infoNotebook(listOf(garden), "f2", "Personal"))
        assertEquals(listOf("Folder", "Created", "Edited", "Saved", "Length"), infoRows(emptyList(), info, NOW, NOW, notebook = null).map { it.label })
        // With another notebook: the default's name at the top level and in its folders, else the notebook's.
        assertEquals("Personal", infoNotebook(folders, null, "Personal"))
        assertEquals("Home", infoNotebook(folders, "f2", "Home"))
        assertEquals("Work", infoNotebook(folders, "f1", "Personal"))
        assertEquals("Work (closed on this phone)", infoNotebook(folders, "nb1", "Personal", closed = setOf("nb1")))
        val rows = infoRows(listOf("Plans"), info, NOW, NOW, notebook = "Work")
        assertEquals(listOf("Notebook", "Folder", "Created", "Edited", "Saved", "Length"), rows.map { it.label })
        assertEquals("Work", rows[0].value)
    }

    @Test
    fun inlineTagsAreTheNotesTagsItsFrontmatterDoesNotHave() {
        assertEquals(listOf("t51test"), inlineTags(listOf("t51test"), emptyList()))
        assertEquals(listOf("idea", "zz"), inlineTags(listOf("zz", "garden", "idea", "idea"), listOf("garden", "plans")))
        // Before the page says which are frontmatter: none.
        assertEquals(emptyList<String>(), inlineTags(listOf("t51test"), null))
        assertEquals("In the text: #idea #zz", inlineTagsLine(listOf("idea", "zz")))
        assertNull(inlineTagsLine(emptyList()))
    }

    /**
     * Large text in a narrow panel puts each label over its value, so "Notebook" never breaks
     * into "Noteboo" and "k" (T53 pass); with room, they stay side by side.
     */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun labelsGoOverTheirValuesWhenTheyWouldBreakMidWord() {
        var fontScale by mutableStateOf(2f)
        var width by mutableStateOf(300.dp)
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                PenmossTheme {
                    Box(Modifier.width(width)) {
                        InfoSheet(
                            noteId = noteId,
                            rows = infoRows(listOf("Plans"), info, NOW, NOW, notebook = "Personal"),
                            tags = emptyList(),
                            canTag = false,
                            fields = listOf(InfoField("lastReviewed", "2026-10-01")),
                            backlinks = BacklinksUi(loading = false, view = BacklinksView(emptyList(), emptyList(), BacklinksSource.SERVER)),
                            titleOf = { null },
                            onTags = {},
                            onOpen = {},
                            onDismiss = {},
                            now = NOW,
                            embedded = true,
                        )
                    }
                }
            }
        }
        fun bounds(text: String) = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("stacked", bounds("Personal").top >= bounds("Notebook").bottom)
        fontScale = 1f
        width = 420.dp
        compose.waitForIdle()
        assertEquals("side by side", bounds("Notebook").top, bounds("Personal").top)
    }

    @Test
    fun theSheetListsInlineTagsApartNotAsNoTags() {
        compose.setContent {
            PenmossTheme {
                InfoSheet(
                    noteId = noteId,
                    rows = infoRows(emptyList(), info, NOW, NOW, notebook = "Personal"),
                    tags = emptyList(),
                    canTag = true,
                    fields = emptyList(),
                    backlinks = BacklinksUi(loading = false, view = BacklinksView(emptyList(), emptyList(), BacklinksSource.SERVER)),
                    titleOf = { null },
                    onTags = {},
                    onOpen = {},
                    onDismiss = {},
                    now = NOW,
                    inline = listOf("t51test"),
                )
            }
        }
        compose.onNodeWithTag("infoRow-Notebook").assertExists()
        compose.onNodeWithText("Personal").assertExists()
        compose.onNodeWithText("No tags yet.").assertDoesNotExist()
        // Under the tags, scrolled into the half-height sheet's view first.
        compose.onNodeWithTag("infoList").performScrollToNode(hasTestTag("infoInlineTags"))
        compose.onNodeWithText("In the text: #t51test").assertExists()
        compose.onNodeWithTag("infoEditTags").assertExists()
    }

    private fun linked(id: String, updatedAt: Long, vararg contexts: List<ContextPart>) =
        LinkedNote(id, id.replaceFirstChar { it.uppercase() }, updatedAt, contexts.map { Mention(it, false, null) })

    @Test
    fun thePhonesOwnLinksAreLaidOverTheServersLists() {
        val server = BacklinkLists(
            linked = listOf(linked("review", 20, listOf(ContextPart.Text("See the plan.")))),
            unlinked = listOf(
                UnlinkedNote("shop", "Shopping", listOf(SnippetPart("Seeds for the ", false), SnippetPart("garden", true))),
                UnlinkedNote("draft", "Draft", emptyList()),
            ),
        )
        val local = listOf(
            BacklinkSource("draft", "Draft", "", 40),
            BacklinkSource("review", "Review", "", 20),
        )
        val view = backlinksView(server, local, BacklinksSource.SERVER)
        // The draft links here since this phone edited it: listed first (newest), with no text yet,
        // and it is no longer an unlinked mention.
        assertEquals(listOf("draft", "review"), view.linked.map { it.id })
        assertTrue(view.linked[0].mentions.isEmpty())
        assertEquals(listOf("shop"), view.unlinked.map { it.id })
        // Offline with nothing read: the phone's links alone.
        assertEquals(listOf("draft", "review"), backlinksView(null, local, BacklinksSource.LOCAL).linked.map { it.id })
    }

    @Test
    fun aNoteEditedHereToRemoveItsLinkLeavesTheServersList() {
        val server = BacklinkLists(
            linked = listOf(
                linked("seeds", 30, listOf(ContextPart.Text("For the garden."))),
                linked("review", 20, listOf(ContextPart.Text("See the plan."))),
            ),
            unlinked = emptyList(),
        )
        // Seeds was edited on this phone and no longer links here (its edits not indexed yet):
        // Room has no link from it, so it leaves the list, as the web's withRecent takes it out.
        val local = listOf(BacklinkSource("review", "Review", "", 20))
        val view = backlinksView(server, local, BacklinksSource.SERVER, recent = setOf("seeds"))
        assertEquals(listOf("review"), view.linked.map { it.id })
        // The review keeps the server's text around its link.
        assertEquals(1, view.linked.single().mentions.size)
        // From the cache offline, the same.
        assertEquals(listOf("review"), backlinksView(server, local, BacklinksSource.CACHED, NOW, setOf("seeds")).linked.map { it.id })
        // A note the phone has not edited stays as the server lists it, even before Room has its row.
        assertEquals(listOf("seeds", "review"), backlinksView(server, emptyList(), BacklinksSource.SERVER).linked.map { it.id })
    }

    @Test
    fun theModelTakesRecentNotesFromTheStore() {
        runBlocking {
            store.saveChanges(
                app.penmoss.engine.api.ChangesPage(
                    2,
                    notes = listOf(
                        app.penmoss.engine.api.ChangedNote(noteId, 1, "Garden", "", 1, seq = 1, links = emptyList()),
                        app.penmoss.engine.api.ChangedNote("01JD3A0000000000000000SEED", 2, "Seeds", "", 2, seq = 2, links = listOf(noteId)),
                    ),
                ),
            )
            // Typed on this phone: Seeds no longer links to the garden.
            store.addPending("01JD3A0000000000000000SEED", "AAA=", null)
            store.setOwnLinks("01JD3A0000000000000000SEED", emptyList())
            withTimeout(5_000) {
                while ("01JD3A0000000000000000SEED" !in store.observeRecentLinkers().first()) kotlinx.coroutines.delay(10)
            }
        }
    }

    @Test
    fun theSheetSaysWhereTheBacklinksCameFrom() {
        assertNull(backlinksNote(BacklinksView(emptyList(), emptyList(), BacklinksSource.SERVER), NOW))
        assertEquals(
            "Offline: as of ${shortWhen(NOW - 60_000, NOW)}, with this phone's own links",
            backlinksNote(BacklinksView(emptyList(), emptyList(), BacklinksSource.CACHED, NOW - 60_000), NOW),
        )
        assertTrue(backlinksNote(BacklinksView(emptyList(), emptyList(), BacklinksSource.LOCAL), NOW)!!.startsWith("Offline: from this phone"))
    }

    @Test
    fun aBacklinksContextShowsLinksByTitleAndMarksTheOnesHere() {
        val context = listOf(
            ContextPart.Text("Started the "),
            ContextPart.Link(LinkRef(noteId, "Garden plan", null, null)),
            ContextPart.Text(" by the "),
            ContextPart.Link(LinkRef("shed", "Shed", "Tools", null)),
        )
        val text = contextString(context, embed = true, noteId = noteId) { if (it == noteId) "Garden" else null }
        assertEquals("Embeds Started the Garden by the Shed › Tools", text.text)
        // The link to this note is the bold one.
        val bold = text.spanStyles.single()
        assertEquals("Garden", text.text.substring(bold.start, bold.end))
    }

    private fun waitFor(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) { while (!condition()) kotlinx.coroutines.delay(10) }
    }

    @Test
    fun loadsOnlineCachesAndReadsTheCacheOffline() {
        val api = FakeApi()
        api.backlinksReply = { _, _ ->
            BacklinksReply(
                "Garden",
                linked = listOf(BacklinksReply.LinkedRow("review", "Review", 20, context = listOf(JsonPrimitive("See it.")))),
                unlinked = listOf(BacklinksReply.MentionRow("shop", "Shopping", 30, "the \u0002garden\u0003")),
            )
        }
        val model = BacklinksModel(noteId, store, api, scope)
        model.load("Garden")
        waitFor { model.ui.value.view?.source == BacklinksSource.SERVER }
        assertEquals(listOf(noteId to "Garden"), api.backlinksAsked.toList())
        assertEquals(listOf("review"), model.ui.value.view!!.linked.map { it.id })
        // Offline later: the answer read before, saying when it was read.
        api.backlinksReply = { _, _ -> throw java.io.IOException("offline") }
        val offline = BacklinksModel(noteId, store, api, scope)
        offline.load("Garden")
        waitFor { offline.ui.value.view?.source == BacklinksSource.CACHED }
        assertEquals(listOf("shop"), offline.ui.value.view!!.unlinked.map { it.id })
        assertEquals(NOW - 3_600_000, offline.ui.value.view!!.readAt)
        // Nothing read for another note: the phone's links alone.
        val other = BacklinksModel("other", store, api, scope)
        other.localChanged(listOf(BacklinkSource("draft", "Draft", "", 1)))
        other.load("Other")
        waitFor { other.ui.value.view?.source == BacklinksSource.LOCAL && !other.ui.value.loading }
        assertEquals(listOf("draft"), other.ui.value.view!!.linked.map { it.id })
    }

    @Test
    fun theInfoButtonSaysHowManyNotesLinkHere() {
        val count = androidx.compose.runtime.mutableIntStateOf(0)
        compose.setContent { PenmossTheme { InfoButton(linked = count.intValue, onClick = {}) } }
        compose.onNodeWithTag("noteInfo").assertContentDescriptionEquals("Info")
        count.intValue = 1
        compose.onNodeWithTag("noteInfo").assertContentDescriptionEquals("Info, linked from 1 note")
        count.intValue = 3
        compose.onNodeWithTag("noteInfo").assertContentDescriptionEquals("Info, linked from 3 notes")
        compose.onNodeWithText("3").assertExists()
    }

    @Test
    fun theSheetShowsDetailsTagsFrontmatterAndBacklinksAndOpensThem() {
        val events = mutableListOf<String>()
        val view = BacklinksView(
            linked = listOf(linked("review", 20, listOf(ContextPart.Text("See "), ContextPart.Link(LinkRef(noteId, "Garden", null, null))))),
            unlinked = listOf(UnlinkedNote("shop", "Shopping", listOf(SnippetPart("the ", false), SnippetPart("garden", true)))),
            source = BacklinksSource.SERVER,
        )
        compose.setContent {
            PenmossTheme {
                InfoSheet(
                    noteId = noteId,
                    rows = infoRows(listOf("Projects"), info, NOW, NOW),
                    tags = listOf("garden", "plans"),
                    canTag = true,
                    fields = info.fields,
                    backlinks = BacklinksUi(loading = false, view = view),
                    titleOf = { if (it == noteId) "Garden" else null },
                    onTags = { events += "tags" },
                    onOpen = { events += "open:$it" },
                    onDismiss = { events += "dismiss" },
                    now = NOW,
                    kind = infoKind(info),
                )
            }
        }
        compose.onNodeWithText("Projects").assertExists()
        // The label first, with its period, and no Kind row (A572, A653).
        compose.onNodeWithTag("infoKind").assertExists()
        compose.onNodeWithText("Daily note").assertExists()
        compose.onNodeWithText("2026-10-23").assertExists()
        compose.onNodeWithTag("infoRow-Kind").assertDoesNotExist()
        compose.onNodeWithText("#garden").assertExists()
        val list = compose.onNodeWithTag("infoList")
        // One line lower with the label (A653): scrolled into the sheet's view first.
        list.performScrollToNode(hasTestTag("infoEditTags"))
        compose.onNodeWithTag("infoEditTags").performClick()
        list.performScrollToNode(hasTestTag("frontmatter-tags"))
        compose.onNodeWithText("[garden, plans]").assertExists()
        list.performScrollToNode(hasText("Backlinks 1"))
        list.performScrollToNode(hasTestTag("linked-review"))
        compose.onNodeWithText("See Garden").assertExists()
        compose.onNodeWithTag("linked-review").performClick()
        list.performScrollToNode(hasTestTag("unlinked-shop"))
        compose.onNodeWithText("Unlinked mentions 1").assertExists()
        compose.onNodeWithTag("unlinked-shop").performClick()
        assertEquals(listOf("tags", "open:review", "open:shop"), events)
    }

    @Test
    fun theSheetSaysSoWhenNothingLinksHere() {
        compose.setContent {
            PenmossTheme {
                InfoSheet(
                    noteId = noteId,
                    rows = infoRows(emptyList(), info, NOW, NOW),
                    tags = emptyList(),
                    canTag = false,
                    fields = emptyList(),
                    backlinks = BacklinksUi(loading = false, view = BacklinksView(emptyList(), emptyList(), BacklinksSource.LOCAL)),
                    titleOf = { null },
                    onTags = {},
                    onOpen = {},
                    onDismiss = {},
                    now = NOW,
                )
            }
        }
        val list = compose.onNodeWithTag("infoList")
        // An ordinary note: no label.
        compose.onNodeWithTag("infoKind").assertDoesNotExist()
        compose.onNodeWithText("No tags yet.").assertExists()
        list.performScrollToNode(hasTestTag("noLinkedMentions"))
        compose.onNodeWithText("No other notes link here yet.").assertExists()
        compose.onNodeWithTag("backlinksNote").assertExists()
        list.performScrollToNode(hasTestTag("noUnlinkedMentions"))
        compose.onNodeWithText("No other notes mention this title.").assertExists()
    }

    private companion object {
        val NOW = ZonedDateTime.parse("2026-10-25T12:00:00-05:00").toInstant().toEpochMilli()
    }
}
