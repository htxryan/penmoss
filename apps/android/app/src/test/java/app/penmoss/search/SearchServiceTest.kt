package app.penmoss.search

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.OfflineSearch
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.textHash
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SearchFilters
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Search's answers (T40 P6, FD1–FD4, A1466): the phone's own keyword index, with the filters, for
 * every search, whether or not a network is up.
 */
@RunWith(AndroidJUnit4::class)
class SearchServiceTest {
    private lateinit var db: PenmossDatabase
    private lateinit var service: SearchService

    @Before
    fun open() = runTest {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        val store = NoteStore(db)
        store.saveChanges(
            ChangesPage(
                1,
                notes = listOf(
                    ChangedNote("a", 1, "Otter notes", "", 100, tags = listOf("trip")),
                    ChangedNote("b", 2, "Heron sightings", "", 200),
                ),
            ),
        )
        for ((id, text) in listOf("a" to "otters by the river", "b" to "herons by the river")) {
            val sent = store.content(id)
            store.saveExchange(Exchange.decide(sent, Exchange.entry(sent, withText = true), BatchNoteReply(id, "e", "U", "SV", null, text = text, textHash = textHash(text))))
        }
        service = SearchService(OfflineSearch(db))
    }

    @After
    fun close() = db.close()

    @Test
    fun findsByTheWordsWithTheirMatchesMarked() = runTest {
        val results = service.search(SearchRequest("otters"))
        assertEquals(listOf("a"), results.map { it.id })
        val hit = results.single()
        assertEquals("Otter notes", hit.title)
        assertTrue(hit.snippet, hit.snippet.contains("\u0002otters\u0003"))
        assertEquals(100L, hit.updatedAt)
    }

    @Test
    fun findsWhileTheLastWordIsStillBeingTyped() = runTest {
        assertEquals(listOf("a"), service.search(SearchRequest("otte")).map { it.id })
    }

    @Test
    fun theFiltersNarrowTheAnswer() = runTest {
        assertEquals(setOf("a", "b"), service.search(SearchRequest("river")).map { it.id }.toSet())
        assertEquals(listOf("a"), service.search(SearchRequest("river", SearchFilters(tag = "trip"))).map { it.id })
        assertEquals(listOf("b"), service.search(SearchRequest("river", SearchFilters(updatedAfter = 150))).map { it.id })
    }

    @Test
    fun nothingCloseIsNoResults() = runTest {
        assertEquals(emptyList<SearchResult>(), service.search(SearchRequest("badgers")))
    }

    @Test
    fun answersAsSoonAsTypingPauses() {
        // One search per burst of keys (A111), and no longer wait for a server that is never asked.
        assertEquals(60L, SearchService.TYPING_MS)
    }
}
