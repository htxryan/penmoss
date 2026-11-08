package app.penmoss.search

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.data.NoteStore
import app.penmoss.data.OfflineSearch
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.textHash
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SearchFilters
import app.penmoss.engine.api.SearchHit
import app.penmoss.engine.api.SearchMode
import app.penmoss.engine.api.SearchReply
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/** Search's answers (T40 P6, FD1–FD4): the server's, Hybrid always with the filters asked, else the phone's. */
@RunWith(AndroidJUnit4::class)
class SearchServiceTest {
    private lateinit var db: PenmossDatabase
    private val asked = mutableListOf<List<Any?>>()
    private var answer: () -> SearchReply = { throw IOException("offline") }
    private val api = object : FakeApi() {
        override suspend fun search(query: String, limit: Int, mode: SearchMode, filters: SearchFilters, partial: Boolean): SearchReply {
            asked += listOf(query, mode, filters, partial)
            return answer()
        }
    }
    private lateinit var service: SearchService

    @Before
    fun open() = runTest {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        val store = NoteStore(db)
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("a", 1, "Otter notes", "", 100))))
        val sent = store.content("a")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent, withText = true), BatchNoteReply("a", "e", "U", "SV", null, text = "otters by the river", textHash = textHash("otters by the river"))))
        service = SearchService(api, OfflineSearch(db))
    }

    @After
    fun close() = db.close()

    @Test
    fun asksTheServerForHybridWithTheFiltersAndReadsWhatItFound() = runTest {
        answer = {
            SearchReply(listOf(SearchHit("s", "River", "the \u0002otters\u0003", 5, "River", heading = "Wildlife", tags = listOf("trip"), sources = listOf("semantic"))))
        }
        val filters = SearchFilters(folderId = "f", tag = "trip", updatedAfter = 9)
        val outcome = service.search(SearchRequest("otters", filters))
        assertEquals(SearchOutcome.Source.SERVER, outcome.source)
        val hit = outcome.results.single()
        assertEquals("Wildlife", hit.heading)
        assertTrue(hit.semantic)
        // A title with no marks shows plainly.
        assertEquals("", hit.titleMarked)
        assertNull(outcome.wordsOnly)
        // Hybrid always (T42, review S1): no mode to choose.
        assertEquals(listOf<Any?>("otters", SearchMode.HYBRID, filters, false), asked.single())
    }

    @Test
    fun aHybridAnswerByWordsAloneSaysWordsOnlyQuietlyWithTheWebsReason() = runTest {
        // The server's HYBRID_LIMIT and HYBRID_FULL_TEXT (`apps/server/src/search/route.ts`).
        answer = { SearchReply(notice = "Semantic search has used today’s allowance; showing full-text results.") }
        val limited = service.search(SearchRequest("otters"))
        assertNull(limited.notice)
        assertEquals(SearchService.WORDS_ONLY_LIMIT, limited.wordsOnly)
        answer = { SearchReply(notice = "Semantic search is unavailable right now; showing full-text results.") }
        assertEquals(SearchService.WORDS_ONLY_UNAVAILABLE, service.search(SearchRequest("otters")).wordsOnly)
    }

    /**
     * T42 on Android (FD2, A657): the 0.45 floor is the server's (A571, `fuseHybrid`). When it
     * leaves nothing, the phone shows nothing, never its own typing results in their place, and
     * says nothing of Words only: meaning did answer.
     */
    @Test
    fun aHybridAnswerWithNothingCloseIsNoNotesNotThePhonesOwn() = runTest {
        // The phone's index would find "otters"; the server's hybrid found nothing close enough.
        assertEquals(listOf("a"), service.typing(SearchRequest("otters")).results.map { it.id })
        answer = { SearchReply(emptyList()) }
        val outcome = service.search(SearchRequest("otters", submitted = true))
        assertEquals(SearchOutcome.Source.SERVER, outcome.source)
        assertEquals(emptyList<SearchResult>(), outcome.results)
        assertNull(outcome.wordsOnly)
        assertNull(outcome.notice)
        assertEquals(SearchMode.HYBRID, asked.single()[1])
    }

    @Test
    fun saysTheLastWordIsUnfinishedWhileTypingButNotOnEnter() = runTest {
        answer = { SearchReply() }
        service.search(SearchRequest("ott"))
        service.search(SearchRequest("ott", submitted = true))
        assertEquals(listOf(true, false), asked.map { it[3] })
    }

    @Test
    fun offlineThePhoneAnswersAndSaysItIsWordsOnly() = runTest {
        val outcome = service.search(SearchRequest("river"))
        assertEquals(SearchOutcome.Source.DEVICE, outcome.source)
        assertEquals(listOf("a"), outcome.results.map { it.id })
        assertNull(outcome.notice)
        assertEquals(SearchService.WORDS_ONLY_OFFLINE, outcome.wordsOnly)
        // The web's notice on offline results (`search/service.ts` WORDS_ONLY_OFFLINE), word for word
        // (T39 pass 3 review: not the empty search's status line).
        assertEquals("Offline: matching by meaning needs a connection, so these results match your words.", outcome.wordsOnly)
    }

    @Test
    fun answersWhileTypingFromThePhoneAndOfflineSaysWordsOnly() = runTest {
        val typing = service.typing(SearchRequest("otte"))
        assertTrue(typing.preview)
        assertNull(typing.wordsOnly)
        assertEquals(listOf("a"), typing.results.map { it.id })
        assertTrue(asked.isEmpty())
        val offline = SearchService(api, OfflineSearch(db), online = { false }).typing(SearchRequest("otte"))
        assertEquals(listOf("a"), offline.results.map { it.id })
        assertEquals(SearchService.WORDS_ONLY_OFFLINE, offline.wordsOnly)
        // Offline the phone's answer is the only one: no pause before it (review nit).
        assertEquals(SearchService.TYPING_MS, SearchService.pauseMs(online = false))
        assertEquals(700L, SearchService.pauseMs(online = true))
    }

    @Test
    fun aRefusalStillLetsThePhoneAnswer() = runTest {
        answer = { throw ApiException(401, "unauthorized", "Unauthorized") }
        val outcome = service.search(SearchRequest("river"))
        assertEquals(listOf("a"), outcome.results.map { it.id })
    }
}
