package app.penmoss.ui

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.sync.ExchangeResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Version history's state (T40 P3b, NT16–NT20) through the real client against a canned server:
 * the list with its authors, the cached list offline, restore/revert/save flushing first and
 * exchanging at once, and overlaps listed.
 */
@RunWith(AndroidJUnit4::class)
class HistoryModelTest {
    private val server = MockWebServer()
    private val paths = CopyOnWriteArrayList<String>()
    private val answers = mutableMapOf<String, Pair<Int, String>>()
    private lateinit var api: HttpPenmossApi
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    /** Flushes and exchanges, in order, as the model calls them; null when the exchange fails. */
    private val events = CopyOnWriteArrayList<String>()
    private var exchangeAnswer: ExchangeResult? = ExchangeResult("n", ExchangeResult.Kind.APPLIED)

    private val listJson = """{"versions":[{"id":3,"createdAt":1761376800000,"reason":"edit","summary":"Appended","actors":["a1"],"authors":[{"id":"a1","kind":"agent","label":"Claude"}]},{"id":2,"createdAt":1761376700000,"reason":"manual","summary":"","actors":["d1"],"authors":[{"id":"d1","kind":"device","label":"Pixel"}]}],"unversioned":null}"""
    private val detailJson = """{"id":3,"previousId":2,"markdown":"# T\nnew\n","diff":[{"op":"same","line":"# T"},{"op":"add","line":"new"}]}"""

    @Before
    fun start() {
        server.start()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val key = "${request.method} ${request.url.encodedPath}"
                paths += key
                val (code, body) = answers[key] ?: (404 to """{"error":{"code":"not_found","message":"No such note"}}""")
                return MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()
            }
        }
        answers["GET /api/notes/n/versions"] = 200 to listJson
        answers["GET /api/notes/n/versions/3"] = 200 to detailJson
        api = HttpPenmossApi(server.url("/").toString(), OkHttpClient())
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1761376900000L })
    }

    @After
    fun stop() {
        db.close()
        server.close()
    }

    private fun withModel(block: suspend Scope.() -> Unit) = runBlocking {
        val job = SupervisorJob()
        val model = HistoryModel(
            "n",
            store,
            api,
            flushEditor = { events += "flush" },
            exchangeNow = { events += "exchange"; exchangeAnswer },
            scope = CoroutineScope(coroutineContext + job),
            now = { 1761376900000L },
        )
        try {
            Scope(model).block()
        } finally {
            // Joined (A690): a read still running would fail on the closed database later.
            job.cancelAndJoin()
        }
    }

    class Scope(val model: HistoryModel) {
        suspend fun until(what: (HistoryUi) -> Boolean): HistoryUi = withTimeout(5_000) { model.ui.first(what) }
    }

    @Test
    fun loadsTheHistoryListWithItsAuthorsAndCachesIt() = withModel {
        model.load()
        val ui = until { it.history != null && !it.loading }
        assertNull(ui.problem)
        assertEquals(listOf(3L, 2L), ui.history!!.versions.map { it.id })
        assertEquals("Claude", ui.history!!.versions[0].authors.single().label)
        assertEquals("Pixel", ui.history!!.versions[1].authors.single().label)
        // The newest version is selected, and its diff read.
        val detail = until { it.detail?.id == 3L }
        assertEquals(listOf("same", "add"), detail.detail!!.diff.map { it.op })
        // Cached for reading offline.
        val cached = runBlocking { store.cachedHistory("n") }
        assertTrue(cached != null && cached.json.contains("\"summary\":\"Appended\""))
    }

    @Test
    fun theRowSaysWhatEachVersionChanged() {
        val saved = app.penmoss.engine.api.NoteVersion(2, reason = "manual", summary = "")
        assertEquals("Saved by hand", versionLine(saved))
        val edit = app.penmoss.engine.api.NoteVersion(3, reason = "edit", summary = "Appended")
        assertEquals("Appended", versionLine(edit))
        assertTrue(isAgentVersion(app.penmoss.engine.api.NoteVersion(3, authors = listOf(app.penmoss.engine.api.HistoryAuthor("a1", "agent", "Claude")))))
    }

    @Test
    fun longUnchangedRunsFoldAroundEachChange() {
        val diff = listOf(
            app.penmoss.engine.api.DiffOp("same", "a"),
            app.penmoss.engine.api.DiffOp("same", "b"),
            app.penmoss.engine.api.DiffOp("same", "c"),
            app.penmoss.engine.api.DiffOp("same", "d"),
            app.penmoss.engine.api.DiffOp("same", "e"),
            app.penmoss.engine.api.DiffOp("add", "new"),
            app.penmoss.engine.api.DiffOp("same", "f"),
            app.penmoss.engine.api.DiffOp("same", "g"),
            app.penmoss.engine.api.DiffOp("same", "h"),
            app.penmoss.engine.api.DiffOp("same", "i"),
            app.penmoss.engine.api.DiffOp("same", "j"),
        )
        // CONTEXT keeps two lines each side of the change; the rest folds.
        assertEquals(
            listOf(
                DiffRow.Fold(3),
                DiffRow.Line("same", "d"),
                DiffRow.Line("same", "e"),
                DiffRow.Line("add", "new"),
                DiffRow.Line("same", "f"),
                DiffRow.Line("same", "g"),
                DiffRow.Fold(3),
            ),
            diffRows(diff),
        )
    }

    @Test
    fun restoresFlushFirstThenExchangesAtOnce() = withModel {
        answers["POST /api/notes/n/versions/3/restore"] = 200 to """{"version":{"id":4},"changed":true}"""
        model.load()
        until { it.history != null }
        events.clear()
        paths.clear()
        model.restore(3)
        val ui = until { it.message != null && !it.busy }
        // The editor flushed, then the restore went, then the note was exchanged at once.
        assertEquals(listOf("flush", "exchange"), events)
        assertTrue(ui.message!!.startsWith("Restored the version of"))
        // The list is read again after the restore (the reload GET lands after the POST).
        withTimeout(5_000) { while (!paths.contains("GET /api/notes/n/versions")) kotlinx.coroutines.delay(10) }
        assertTrue(paths.indexOf("POST /api/notes/n/versions/3/restore") < paths.indexOf("GET /api/notes/n/versions"))
    }

    @Test
    fun aRestoreThatChangedNothingSaysSo() = withModel {
        answers["POST /api/notes/n/versions/3/restore"] = 200 to """{"version":{"id":3},"changed":false}"""
        model.load()
        until { it.history != null }
        model.restore(3)
        val ui = until { it.message != null && !it.busy }
        assertEquals("The note already matches this version.", ui.message)
        assertEquals(listOf("flush", "exchange"), events)
    }

    @Test
    fun revertUndoesTheAgentsChangeAndListsWhatOverlapped() = withModel {
        answers["POST /api/notes/n/versions/3/revert"] = 200 to
            """{"version":{"id":4},"changed":true,"conflicts":[{"part":"body","ours":["kept"],"theirs":["gone"]},{"part":"title","ours":[],"theirs":["Old"]}]}"""
        model.load()
        until { it.history != null }
        events.clear()
        model.revert(3)
        val ui = until { it.message != null && !it.busy }
        assertEquals(listOf("flush", "exchange"), events)
        assertEquals(2, ui.conflicts.size)
        assertEquals(listOf("body", "title"), ui.conflicts.map { it.part })
        assertEquals(listOf("kept"), ui.conflicts[0].ours)
        assertTrue(ui.message!!.contains("2 parts were changed again since"))
    }

    @Test
    fun saveFlushesExchangesThenSaves() = withModel {
        answers["POST /api/notes/n/versions"] = 201 to """{}"""
        model.load()
        until { it.history != null }
        events.clear()
        paths.clear()
        model.saveNow()
        val ui = until { it.message != null && !it.busy }
        // The version includes the phone's last edits: flush, exchange, then save.
        assertEquals(listOf("flush", "exchange"), events)
        val saves = paths.mapIndexedNotNull { i, path -> i.takeIf { path == "POST /api/notes/n/versions" } }
        assertEquals(1, saves.size)
        assertEquals("Saved a version of the note as it is now.", ui.message)
    }

    // --- T40 P3b fixup: unsent edits, failed exchanges, retained detail ---

    private suspend fun pendingUpdates() = store.pending("n").map { it.update }

    @Test
    fun restoreKeepsUnsentEdits() = withModel {
        answers["POST /api/notes/n/versions/3/restore"] = 200 to """{"version":{"id":4},"changed":true}"""
        store.addPending("n", "EDIT", "e1")
        model.load()
        until { it.history != null }
        events.clear()
        model.restore(3)
        val ui = until { it.message != null && !it.busy }
        assertEquals(listOf("flush", "exchange"), events)
        assertTrue(ui.message!!.startsWith("Restored the version of"))
        assertEquals(listOf("EDIT"), pendingUpdates())
    }

    @Test
    fun revertKeepsUnsentEdits() = withModel {
        answers["POST /api/notes/n/versions/3/revert"] = 200 to """{"version":{"id":4},"changed":true,"conflicts":[]}"""
        store.addPending("n", "EDIT", "e1")
        model.load()
        until { it.history != null }
        events.clear()
        model.revert(3)
        val ui = until { it.message != null && !it.busy }
        assertEquals(listOf("flush", "exchange"), events)
        assertEquals("Reverted the agent’s edit; later edits are kept.", ui.message)
        assertEquals(listOf("EDIT"), pendingUpdates())
    }

    @Test
    fun saveKeepsUnsentEdits() = withModel {
        answers["POST /api/notes/n/versions"] = 201 to """{}"""
        store.addPending("n", "EDIT", "e1")
        model.load()
        until { it.history != null }
        events.clear()
        model.saveNow()
        val ui = until { it.message != null && !it.busy }
        assertEquals(listOf("flush", "exchange"), events)
        assertEquals("Saved a version of the note as it is now.", ui.message)
        assertEquals(listOf("EDIT"), pendingUpdates())
    }

    @Test
    fun restoreFailureKeepsUnsentEditsAndSkipsTheExchange() = withModel {
        answers["POST /api/notes/n/versions/3/restore"] = 500 to """{"error":{"code":"boom","message":"Broken"}}"""
        store.addPending("n", "EDIT", "e1")
        model.load()
        until { it.history != null }
        events.clear()
        model.restore(3)
        val ui = until { it.message != null && !it.busy }
        // The POST threw, so the exchange never ran; nothing queued was dropped.
        assertEquals(listOf("flush"), events)
        assertTrue(ui.message!!.startsWith("The server could not do that"))
        assertEquals(listOf("EDIT"), pendingUpdates())
    }

    @Test
    fun revertFailureKeepsUnsentEditsAndSkipsTheExchange() = withModel {
        answers["POST /api/notes/n/versions/3/revert"] = 500 to """{"error":{"code":"boom","message":"Broken"}}"""
        store.addPending("n", "EDIT", "e1")
        model.load()
        until { it.history != null }
        events.clear()
        model.revert(3)
        val ui = until { it.message != null && !it.busy }
        assertEquals(listOf("flush"), events)
        assertTrue(ui.message!!.startsWith("The server could not do that"))
        assertEquals(listOf("EDIT"), pendingUpdates())
    }

    @Test
    fun saveFailureKeepsUnsentEdits() = withModel {
        answers["POST /api/notes/n/versions"] = 500 to """{"error":{"code":"boom","message":"Broken"}}"""
        store.addPending("n", "EDIT", "e1")
        model.load()
        until { it.history != null }
        events.clear()
        model.saveNow()
        val ui = until { it.message != null && !it.busy }
        assertEquals(listOf("flush", "exchange"), events)
        assertTrue(ui.message!!.startsWith("The server could not do that"))
        assertEquals(listOf("EDIT"), pendingUpdates())
    }

    @Test
    fun saveAbortsWhenTheExchangeDidNotGoThrough() = withModel {
        answers["POST /api/notes/n/versions"] = 201 to """{}"""
        store.addPending("n", "EDIT", "e1")
        model.load()
        until { it.history != null }
        events.clear()
        paths.clear()
        exchangeAnswer = null
        model.saveNow()
        val ui = until { it.message != null && !it.busy }
        // The exchange failed, so the version is not saved without the phone's last edits.
        assertEquals(listOf("flush", "exchange"), events)
        assertTrue(paths.none { it == "POST /api/notes/n/versions" })
        assertEquals("The version was not saved: the note could not be exchanged. Check the connection and try again.", ui.message)
        assertEquals(listOf("EDIT"), pendingUpdates())
    }

    @Test
    fun restoreSaysTheContentIsStillComingWhenTheExchangeFails() = withModel {
        answers["POST /api/notes/n/versions/3/restore"] = 200 to """{"version":{"id":4},"changed":true}"""
        store.addPending("n", "EDIT", "e1")
        model.load()
        until { it.history != null }
        events.clear()
        exchangeAnswer = null
        model.restore(3)
        val ui = until { it.message != null && !it.busy }
        // The restore went; only the at-once exchange missed, so the content follows.
        assertEquals(listOf("flush", "exchange"), events)
        assertTrue(ui.message!!.startsWith("Restored the version of"))
        assertTrue(ui.message!!.contains("still coming"))
        assertEquals(listOf("EDIT"), pendingUpdates())
    }

    @Test
    fun revertSaysTheContentIsStillComingWhenTheExchangeFails() = withModel {
        answers["POST /api/notes/n/versions/3/revert"] = 200 to """{"version":{"id":4},"changed":true,"conflicts":[]}"""
        model.load()
        until { it.history != null }
        events.clear()
        exchangeAnswer = null
        model.revert(3)
        val ui = until { it.message != null && !it.busy }
        assertEquals(listOf("flush", "exchange"), events)
        assertTrue(ui.message!!.startsWith("Reverted the agent’s edit"))
        assertTrue(ui.message!!.contains("still coming"))
    }

    @Test
    fun aFailedSelectKeepsTheDetailAlreadyRead() = withModel {
        model.load()
        until { it.detail?.id == 3L }
        // v2 will not load (404): the v3 diff stays, with the error said.
        model.select(2)
        val failed = until { it.detailError != null && !it.detailLoading }
        assertEquals(2L, failed.selected)
        assertEquals(3L, failed.detail?.id)
        // Back on v3 while it will not load either: its diff still shows.
        answers.remove("GET /api/notes/n/versions/3")
        model.select(3)
        val back = until { it.detailError != null && !it.detailLoading && it.selected == 3L }
        assertEquals(3L, back.detail?.id)
    }

    @Test
    fun offlineShowsTheCachedListAndSaysSo() = runBlocking {
        store.cacheHistory("n", listJson)
        val closed = HttpPenmossApi("http://127.0.0.1:9/", OkHttpClient())
        val job = SupervisorJob()
        val model = HistoryModel(
            "n",
            store,
            closed,
            flushEditor = { events += "flush" },
            exchangeNow = { events += "exchange"; exchangeAnswer },
            scope = CoroutineScope(coroutineContext + job),
            now = { 1761376900000L },
        )
        try {
            model.load()
            val ui = withTimeout(5_000) { model.ui.first { it.history != null && !it.loading } }
            assertEquals(listOf(3L, 2L), ui.history!!.versions.map { it.id })
            assertTrue(ui.problem!!.startsWith("Offline: showing versions from"))
        } finally {
            // Joined (A690): a read still running would fail on the closed database later.
            job.cancelAndJoin()
        }
    }

    @Test
    fun offlineWithNothingCachedSaysHistoryNeedsAConnection() = runBlocking {
        val closed = HttpPenmossApi("http://127.0.0.1:9/", OkHttpClient())
        val job = SupervisorJob()
        val model = HistoryModel(
            "n",
            store,
            closed,
            flushEditor = {},
            exchangeNow = { null },
            scope = CoroutineScope(coroutineContext + job),
            now = { 1761376900000L },
        )
        try {
            model.load()
            val ui = withTimeout(5_000) { model.ui.first { !it.loading && it.problem != null } }
            assertNull(ui.history)
            assertEquals("Version history needs a connection to the server.", ui.problem)
        } finally {
            // Joined (A690): a read still running would fail on the closed database later.
            job.cancelAndJoin()
        }
    }

    @Test
    fun aRefusalSaysTheServerCouldNotLoadIt() = withModel {
        // A 401 is a refusal like any other since T59 (A1040): no sign-in to lose.
        answers["GET /api/notes/n/versions"] = 401 to """{"error":{"code":"unauthorized","message":"Unauthorized"}}"""
        model.load()
        val ui = withTimeout(5_000) { model.ui.first { it.problem != null } }
        assertEquals("The server could not load the history (error 401). Try again in a moment.", ui.problem)
    }
}
