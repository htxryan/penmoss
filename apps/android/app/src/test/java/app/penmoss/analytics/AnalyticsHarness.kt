package app.penmoss.analytics

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A phone's analytics for a test (PEN-137): an in-memory record, a consent file in a folder of its
 * own, a fake endpoint (MockWebServer) and a clock the test moves. Sends run when the test calls
 * [AnalyticsService.sendDue]; [scheduled] lists the sends asked for.
 */
class AnalyticsHarness(
    var clock: Long = 1_763_000_000_000L,
    private val onDropped: (String, String, String) -> Unit = { problem, kind, name -> throw AssertionError("Dropped $kind $name: $problem") },
) : AutoCloseable {
    val server = MockWebServer()
    val endpoint = Endpoint()
    val dir: File = Files.createTempDirectory("analytics").toFile()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val database = AnalyticsDatabase.inMemory(ApplicationProvider.getApplicationContext())
    val store = AnalyticsStore(database)
    val consent = ConsentStore.create(dir, scope)
    val scheduled = CopyOnWriteArrayList<Long>()
    val limitsSeen = CopyOnWriteArrayList<Limits>()

    init {
        server.dispatcher = endpoint
        server.start()
    }

    val sender = AnalyticsSender(OkHttpClient(), base = { server.url("/").toString() }, now = { clock })

    val service = AnalyticsService(
        store = store,
        consent = consent,
        sender = sender,
        scope = scope,
        fields = { ClientFields(version = "0.4.2", channel = "stable", osVersion = "17", sizeClass = "compact") },
        now = { clock },
        schedule = { scheduled += it },
        onLimits = { limitsSeen += it },
        onDropped = onDropped,
    )

    /** Records [count] tracked clicks, stored at once. */
    suspend fun clicks(count: Int, id: String = "privacy.view-data") {
        repeat(count) {
            check(service.record("click", id))
            clock += 1
        }
        service.flush()
    }

    override fun close() {
        server.close()
        scope.cancel()
        database.close()
        dir.deleteRecursively()
    }

    /** The ingest Worker's stand-in: answers 202 by default, or what the test queues. */
    class Endpoint : Dispatcher() {
        val requests = CopyOnWriteArrayList<Pair<String, String>>()
        val answers = ArrayDeque<MockResponse>()

        override fun dispatch(request: RecordedRequest): MockResponse {
            val body = request.body?.utf8().orEmpty()
            requests += request.url.encodedPath to body
            synchronized(answers) { answers.removeFirstOrNull() }?.let { return it }
            return json(202, """{"accepted":1,"dropped":0,"refused":[]}""")
        }

        fun answer(response: MockResponse) = synchronized(answers) { answers.addLast(response) }

        companion object {
            fun json(code: Int, body: String, headers: Map<String, String> = emptyMap()): MockResponse =
                MockResponse.Builder().code(code).addHeader("Content-Type", "application/json")
                    .apply { headers.forEach { (key, value) -> addHeader(key, value) } }
                    .body(body).build()
        }
    }
}
