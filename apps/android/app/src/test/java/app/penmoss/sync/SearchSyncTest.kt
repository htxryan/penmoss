package app.penmoss.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.OfflineSearch
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.api.SearchFilters
import app.penmoss.engine.sync.SyncEngine
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/**
 * The offline index filled by sync (T40 P6, FD3, FD4): the app's real engine, Room store and HTTP
 * client against the fake Penmoss server. Text comes with `/sync/batch` on passes that may
 * prefetch, only when it changed; tags come with `/sync/changes`; then search works offline.
 */
@RunWith(AndroidJUnit4::class)
class SearchSyncTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val penmoss = FakePenmoss()

    @Volatile
    private var online = true

    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var engine: SyncEngine
    private lateinit var search: OfflineSearch

    @Before
    fun setUp() {
        server.dispatcher = penmoss
        server.start()
        val http = OkHttpClient.Builder()
            .addInterceptor { chain -> if (!online) throw IOException("airplane mode") else chain.proceed(chain.request()) }
            .build()
        val api = HttpPenmossApi(server.url("/").toString(), http)
        db = PenmossDatabase.inMemory(context)
        store = NoteStore(db)
        engine = SyncEngine(api, store)
        search = OfflineSearch(db)
    }

    @After
    fun tearDown() {
        db.close()
        server.close()
    }

    private fun ids(query: String, filters: SearchFilters = SearchFilters()) = runBlocking { search.search(query, filters, prefixLast = false).map { it.noteId } }

    @Test
    fun aFrontPassBringsEachNotesTextSoItsBodyIsFoundOffline() = runBlocking {
        penmoss.write("a", "Garden plan", "Tomatoes along the fence and basil by the door", tags = listOf("garden"))
        penmoss.write("b", "Groceries", "Oat milk and lemons")
        engine.sync(prefetch = true)
        online = false
        assertEquals(listOf("a"), ids("basil"))
        assertEquals(listOf("b"), ids("lemons"))
        // The tag filter, offline.
        assertEquals(listOf("a"), ids("and", SearchFilters(tag = "garden")))
        // Every exchange asked for text, with no hash: the phone had none.
        assertEquals(setOf("a" to null, "b" to null), penmoss.textAsks.toSet())
    }

    @Test
    fun aMeteredPassAsksForNoTextAndTheNextFrontPassCatchesUp() = runBlocking {
        penmoss.write("a", "Plan", "first draft")
        engine.sync(prefetch = true)
        val firstHash = store.note("a")!!.textHash
        penmoss.write("a", "Plan", "second draft with otters")
        penmoss.textAsks.clear()
        // A metered background run: content, but no text (A328).
        engine.sync(prefetch = false)
        assertTrue(penmoss.textAsks.isEmpty())
        assertTrue(store.note("a")!!.textDue)
        assertEquals(emptyList<String>(), ids("otters"))
        // The next pass that may prefetch asks again, naming the copy it holds.
        engine.sync(prefetch = true)
        assertEquals(listOf("a" to firstHash), penmoss.textAsks.toList())
        assertEquals(listOf("a"), ids("otters"))
        assertFalse(store.note("a")!!.textDue)
    }

    @Test
    fun anUnchangedNoteIsNotSentAgainAndTheServerSendsOnlyItsHash() = runBlocking {
        penmoss.write("a", "Plan", "steady text")
        engine.sync(prefetch = true)
        val held = store.note("a")!!.textHash
        // Opening the note exchanges it in front: the hash goes, the text does not come back.
        penmoss.textAsks.clear()
        engine.syncNote("a")
        assertEquals(listOf("a" to held), penmoss.textAsks.toList())
        assertEquals(held, store.note("a")!!.textHash)
        assertEquals(listOf("a"), ids("steady"))
        // A pass with nothing changed exchanges nothing.
        penmoss.textAsks.clear()
        engine.sync(prefetch = true)
        assertTrue(penmoss.textAsks.isEmpty())
    }

    /** Review B2: the page reports this phone's own text, so an exchange that uploads asks for none. */
    @Test
    fun anEditExchangeOfTheOpenNoteAsksForNoText() = runBlocking {
        penmoss.write("a", "Plan", "steady text")
        engine.sync(prefetch = true)
        penmoss.textAsks.clear()
        penmoss.batchEntries.clear()
        store.addPending("a", "UEhPTkU=", store.note("a")!!.epoch)
        val result = engine.syncNote("a")!!
        assertEquals(listOf("a" to false), penmoss.batchEntries.toList())
        assertTrue(penmoss.textAsks.isEmpty())
        assertNull(result.text)
        // Opening it again with nothing to send asks, naming the copy it holds.
        engine.syncNote("a")
        assertEquals(listOf("a" to true), penmoss.batchEntries.drop(1))
    }

    @Test
    fun theServersHeadingsAreIndexedWithItsText() = runBlocking {
        penmoss.write("a", "Recipes", "Desserts lemon tart", headings = "Desserts")
        engine.sync(prefetch = true)
        assertEquals("Desserts", db.search().text("a")!!.headings)
        assertEquals(app.penmoss.data.textHash("Desserts lemon tart", "Desserts"), store.note("a")!!.textHash)
    }

    @Test
    fun notesHeldBeforeTheIndexGetTheirTextOnceThenNeverAgainFromAnOlderServer() = runBlocking {
        penmoss.write("a", "Old note", "body from before")
        penmoss.textMissing = true
        engine.sync(prefetch = true)
        // An older server sends no text and no tags: asked once, not every pass.
        assertEquals(listOf("a" to null), penmoss.textAsks.toList())
        assertFalse(store.note("a")!!.textDue)
        assertNull(store.note("a")!!.textHash)
        engine.sync(prefetch = true)
        assertEquals(1, penmoss.textAsks.size)
        // Its title is still found, as before.
        assertEquals(listOf("a"), ids("old"))
    }
}
