package app.penmoss.engine.sync

import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.HttpPenmossApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The sync engine against a fake API (T32, A280): what it asks for, in what
 * order, and what it keeps. The updates are made-up strings: the engine must
 * move them without reading them.
 */
class SyncEngineTest {
    private val server = MockWebServer()
    private val requests = mutableListOf<RecordedRequest>()
    private val handlers = mutableMapOf<String, (RecordedRequest) -> MockResponse>()
    private lateinit var store: InMemorySyncStore
    private lateinit var engine: SyncEngine
    private val exchanged = mutableListOf<ExchangeResult>()

    @Before
    fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                synchronized(requests) { requests += request }
                val handler = handlers[request.url.encodedPath] ?: return json("""{"error":{"code":"not_found"}}""", 404)
                return handler(request)
            }
        }
        server.start()
        store = InMemorySyncStore()
        val api = HttpPenmossApi(server.url("/").toString(), OkHttpClient())
        engine = SyncEngine(api, store) { exchanged += it }
    }

    @After
    fun stop() = server.close()

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun bodyOf(request: RecordedRequest): JsonObject =
        Json.parseToJsonElement(request.body!!.utf8()).jsonObject

    private fun batchRequests() = requests.filter { it.url.encodedPath == "/sync/batch" }.map(::bodyOf)

    @Test
    fun firstSyncFetchesTheTreeEveryChangeAndTheNotesWhole() = runTest {
        handlers["/sync/tree"] = {
            if (it.url.queryParameter("since") == "h1") json("""{"hash":"h1","unchanged":true}""")
            else json("""{"hash":"h1","rootSortMode":"manual","folders":[{"id":"f","name":"Projects"}],"notes":[{"id":"a","folderId":"f"}]}""")
        }
        handlers["/sync/changes"] = {
            when (it.url.queryParameter("since")) {
                "0" -> json("""{"clock":5,"hasMore":true,"notes":[{"id":"a","clock":5,"title":"A","updatedAt":50}]}""")
                "5" -> json("""{"clock":7,"hasMore":false,"notes":[{"id":"b","clock":7,"title":"B","updatedAt":70}]}""")
                else -> json("""{"clock":7,"hasMore":false,"notes":[]}""")
            }
        }
        handlers["/sync/batch"] = { request ->
            val ids = bodyOf(request).getValue("notes").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }
            json("""{"notes":[${ids.joinToString(",") { """{"id":"$it","epoch":"e","update":"WHOLE-$it","stateVector":"SV-$it","error":null}""" }}]}""")
        }

        val report = engine.sync()
        assertTrue(report.treeChanged)
        assertEquals(2, report.notesChanged)
        assertEquals(2, report.exchanged)
        assertTrue(report.complete)
        assertEquals("h1", store.tree?.hash)
        assertEquals(7L, store.clock)
        // Newest first, and with no cursor: the whole note.
        val sent = batchRequests().single().getValue("notes").jsonArray.map { it.jsonObject }
        assertEquals(listOf("b", "a"), sent.map { it.getValue("id").jsonPrimitive.content })
        assertTrue(sent.all { "stateVector" !in it && "update" !in it })
        assertEquals(listOf("WHOLE-a"), store.updates("a", InMemorySyncStore.State.SYNCED))
        assertEquals("SV-a", store.notes.getValue("a").cursor)
        assertEquals(2, exchanged.size)

        // Nothing changed: the second pass sends the tree hash and the clock, and no batch.
        requests.clear()
        val again = engine.sync()
        assertFalse(again.treeChanged)
        assertEquals(0, again.exchanged)
        assertTrue(batchRequests().isEmpty())
        assertEquals("h1", requests.first { it.url.encodedPath == "/sync/tree" }.url.queryParameter("since"))
    }

    @Test
    fun uploadsUnconfirmedEditsWithTheCursorAndKeepsTheReply() = runTest {
        handlers["/sync/tree"] = { json("""{"hash":"h","unchanged":true}""") }
        handlers["/sync/changes"] = { json("""{"clock":3,"hasMore":false,"notes":[{"id":"n","clock":3,"title":"N"}]}""") }
        store.notes["n"] = InMemorySyncStore.Note("n", clock = 3, contentClock = 3, cursor = "SV1", epoch = "e")
        store.tree = app.penmoss.engine.api.SyncTree("h")
        val p1 = store.addPending("n", "EDIT1")
        store.addPending("n", "EDIT2")
        handlers["/sync/batch"] = {
            json("""{"notes":[{"id":"n","epoch":"e","update":"DIFF","stateVector":"SV2","error":null}]}""")
        }

        engine.sync()
        val entry = batchRequests().single().getValue("notes").jsonArray.single().jsonObject
        assertEquals("SV1", entry.getValue("stateVector").jsonPrimitive.content)
        assertEquals(listOf("EDIT1", "EDIT2"), (entry.getValue("update") as JsonArray).map { it.jsonPrimitive.content })
        assertEquals("e", entry.getValue("epoch").jsonPrimitive.content)
        assertEquals(emptyList<String>(), store.updates("n", InMemorySyncStore.State.PENDING))
        assertEquals(listOf("DIFF"), store.updates("n", InMemorySyncStore.State.SYNCED))
        assertEquals("SV2", store.notes.getValue("n").cursor)
        assertTrue(store.rows.none { it.id == p1 })
    }

    @Test
    fun aDeferredNoteWaitsForTheNextPassAndKeepsItsCursor() = runTest {
        handlers["/sync/tree"] = { json("""{"hash":"h","unchanged":true}""") }
        handlers["/sync/changes"] = { json("""{"clock":2,"hasMore":false,"notes":[{"id":"n","clock":2}]}""") }
        store.notes["n"] = InMemorySyncStore.Note("n", contentClock = 1, cursor = "SV1")
        handlers["/sync/batch"] = { json("""{"notes":[{"id":"n","epoch":"e","update":"","error":null,"deferred":true}]}""") }
        val report = engine.sync()
        assertEquals(1, report.retried)
        assertEquals(1, batchRequests().size)
        assertEquals("SV1", store.notes.getValue("n").cursor)
        assertEquals(1L, store.notes.getValue("n").contentClock)
    }

    @Test
    fun syncsTheOpenNoteAlone() = runTest {
        store.notes["n"] = InMemorySyncStore.Note("n", cursor = "SV1", epoch = "e")
        store.addPending("n", "EDIT")
        handlers["/sync/batch"] = { json("""{"notes":[{"id":"n","epoch":"e","update":"ECHO","stateVector":"SV2","error":null}]}""") }
        val result = engine.syncNote("n")
        assertEquals(ExchangeResult.Kind.APPLIED, result?.kind)
        assertEquals("ECHO", exchanged.single().append)
        assertNull(requests.firstOrNull { it.url.encodedPath == "/sync/changes" })
    }

    @Test
    fun pollingTheOpenNoteExchangesItOnlyWhenItChanged() = runTest {
        store.notes["n"] = InMemorySyncStore.Note("n", clock = 3, contentClock = 3, cursor = "SV1", epoch = "e")
        store.clock = 3
        var changes = """{"clock":3,"hasMore":false,"notes":[]}"""
        handlers["/sync/changes"] = { json(changes) }
        handlers["/sync/batch"] = { json("""{"notes":[{"id":"n","epoch":"e","update":"DIFF","stateVector":"SV2","error":null}]}""") }

        assertNull(engine.refreshNote("n"))
        assertTrue(batchRequests().isEmpty())

        // Changed on another device and indexed: now it is exchanged.
        changes = """{"clock":4,"hasMore":false,"notes":[{"id":"n","clock":4,"title":"N"}]}"""
        assertEquals(ExchangeResult.Kind.APPLIED, engine.refreshNote("n")?.kind)
        assertEquals(1, batchRequests().size)

        // An unsent edit is exchanged even when nothing changed on the server.
        changes = """{"clock":4,"hasMore":false,"notes":[]}"""
        store.addPending("n", "EDIT")
        engine.refreshNote("n")
        assertEquals(2, batchRequests().size)
    }

    private fun entriesOf(request: RecordedRequest) = bodyOf(request).getValue("notes").jsonArray.map { it.jsonObject }

    private fun uploadsOf(entry: JsonObject): Int = (entry["update"] as? JsonArray)?.size ?: 0

    /** A server that applies whatever it is sent and echoes it, saying how much it applied. */
    private fun applyingServer(refuse: (List<JsonObject>) -> Int? = { null }): (RecordedRequest) -> MockResponse = { request ->
        val entries = entriesOf(request)
        refuse(entries)?.let { code -> json("""{"error":{"code":"refused"}}""", code) } ?: json(
            """{"notes":[${entries.joinToString(",") {
                val id = it.getValue("id").jsonPrimitive.content
                """{"id":"$id","epoch":"e","update":"ECHO","stateVector":"SV-$id","error":null,"applied":${uploadsOf(it)}}"""
            }}]}""",
        )
    }

    @Test
    fun aNoteWithMoreEditsThanOneRequestTakesSyncsThemAll() = runTest {
        // A minute or more of offline typing (B1): more edits than the server takes at once.
        store.notes["n"] = InMemorySyncStore.Note("n", cursor = "SV1", epoch = "e")
        repeat(250) { store.addPending("n", "EDIT$it", epoch = "e") }
        handlers["/sync/batch"] = applyingServer { entries -> if (entries.any { uploadsOf(it) > 200 }) 400 else null }

        assertEquals(ExchangeResult.Kind.APPLIED, engine.syncNote("n")?.kind)
        assertEquals(listOf(200, 50), batchRequests().map { uploadsOf(it.getValue("notes").jsonArray.single().jsonObject) })
        assertEquals(emptyList<String>(), store.updates("n", InMemorySyncStore.State.PENDING))
        assertEquals(emptyList<String>(), store.updates("n", InMemorySyncStore.State.CONFLICT))
    }

    @Test
    fun aPassAlsoSendsEveryEditOfALongRun() = runTest {
        handlers["/sync/tree"] = { json("""{"hash":"h","unchanged":true}""") }
        handlers["/sync/changes"] = { json("""{"clock":0,"hasMore":false,"notes":[]}""") }
        store.notes["n"] = InMemorySyncStore.Note("n", cursor = "SV1", epoch = "e", contentClock = 0)
        repeat(450) { store.addPending("n", "EDIT$it") }
        handlers["/sync/batch"] = applyingServer()
        assertTrue(engine.sync().complete)
        assertEquals(listOf(200, 200, 50), batchRequests().map { uploadsOf(it.getValue("notes").jsonArray.single().jsonObject) })
        assertEquals(emptyList<String>(), store.updates("n", InMemorySyncStore.State.PENDING))
    }

    @Test
    fun oneNoteTheServerRefusesDoesNotHoldTheOthersBack() = runTest {
        handlers["/sync/tree"] = { json("""{"hash":"h","unchanged":true}""") }
        handlers["/sync/changes"] = { json("""{"clock":0,"hasMore":false,"notes":[]}""") }
        for (id in listOf("a", "b", "c")) {
            store.notes[id] = InMemorySyncStore.Note(id, cursor = "SV1", epoch = "e", contentClock = 0)
            store.addPending(id, "EDIT-$id")
        }
        // Any request carrying `b` is refused whole, as the server does for a malformed entry.
        handlers["/sync/batch"] = applyingServer { entries ->
            if (entries.any { it.getValue("id").jsonPrimitive.content == "b" }) 400 else null
        }
        val report = engine.sync()
        assertEquals(2, report.exchanged)
        assertEquals(1, report.retried)
        assertEquals(emptyList<String>(), store.updates("a", InMemorySyncStore.State.PENDING))
        assertEquals(emptyList<String>(), store.updates("c", InMemorySyncStore.State.PENDING))
        assertEquals(listOf("EDIT-b"), store.updates("b", InMemorySyncStore.State.PENDING))
        // The whole batch, then each note alone.
        assertEquals(listOf(3, 1, 1, 1), batchRequests().map { it.getValue("notes").jsonArray.size })
    }

    @Test
    fun aRequestTooLargeIsHalvedDownToFewerEditsOfOneNote() = runTest {
        store.notes["n"] = InMemorySyncStore.Note("n", cursor = "SV1", epoch = "e")
        repeat(100) { store.addPending("n", "EDIT$it") }
        // As if the edits were large: more than 30 in a request is over the server's limit.
        handlers["/sync/batch"] = applyingServer { entries -> if (entries.sumOf(::uploadsOf) > 30) 413 else null }
        engine.syncNote("n")
        assertEquals(emptyList<String>(), store.updates("n", InMemorySyncStore.State.PENDING))
        val sizes = batchRequests().map { uploadsOf(it.getValue("notes").jsonArray.single().jsonObject) }
        // Halved until the server takes it; the rest follow in later requests.
        assertEquals(listOf(100, 50, 25), sizes.take(3))
        assertEquals(100, sizes.filter { it <= 30 }.sum())
    }

    @Test
    fun manyNotesTooLargeTogetherAreSplitAcrossRequests() = runTest {
        handlers["/sync/tree"] = { json("""{"hash":"h","unchanged":true}""") }
        handlers["/sync/changes"] = { json("""{"clock":0,"hasMore":false,"notes":[]}""") }
        for (i in 1..8) {
            store.notes["n$i"] = InMemorySyncStore.Note("n$i", cursor = "SV1", epoch = "e", contentClock = 0)
            store.addPending("n$i", "EDIT$i")
        }
        handlers["/sync/batch"] = applyingServer { entries -> if (entries.size > 2) 413 else null }
        assertEquals(8, engine.sync().exchanged)
        assertTrue(store.rows.none { it.state == InMemorySyncStore.State.PENDING })
    }

    @Test
    fun aRestoreKeepsApartTheEditsStoredWhileItsRequestWasOut() = runTest {
        store.notes["n"] = InMemorySyncStore.Note("n", cursor = "SV1", epoch = "e1")
        store.addPending("n", "SENT", epoch = "e1")
        handlers["/sync/batch"] = {
            // The editor stores another edit of the e1 copy while the request is out (S3).
            store.addPending("n", "TYPED-MEANWHILE", epoch = "e1")
            json("""{"notes":[{"id":"n","epoch":"e2","update":"WHOLE","stateVector":"SV9","error":"Epoch mismatch"}]}""")
        }
        assertEquals(ExchangeResult.Kind.RESET, engine.syncNote("n")?.kind)
        assertEquals(listOf("SENT", "TYPED-MEANWHILE"), store.updates("n", InMemorySyncStore.State.CONFLICT))
        assertEquals(emptyList<String>(), store.updates("n", InMemorySyncStore.State.PENDING))
        assertEquals(listOf("WHOLE"), store.updates("n", InMemorySyncStore.State.SYNCED))
        // And nothing from before the restore is sent afterwards.
        store.addPending("n", "LATE-OLD-COPY", epoch = "e1")
        store.addPending("n", "NEW-COPY", epoch = "e2")
        handlers["/sync/batch"] = applyingServer()
        engine.syncNote("n")
        val last = batchRequests().last().getValue("notes").jsonArray.single().jsonObject
        assertEquals(listOf("NEW-COPY"), (last.getValue("update") as JsonArray).map { it.jsonPrimitive.content })
        assertTrue("LATE-OLD-COPY" in store.updates("n", InMemorySyncStore.State.CONFLICT))
    }

    @Test
    fun anUnauthorizedAnswerStopsTheSync() = runTest {
        handlers["/sync/tree"] = { json("""{"error":{"code":"unauthorized","message":"No"}}""", 401) }
        val error = runCatching { engine.sync() }.exceptionOrNull()
        assertTrue(error is ApiException && error.unauthorized)
    }
}
