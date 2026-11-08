package app.penmoss.engine.api

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Send to… on the phone (T60, A1076): `GET /android/agent-sessions` on the notebook's notes
 * server, which reads the WorkspaceDoc's `agentSessions`; no Penmoss server.
 */
class CommentsApiTest {
    private val server = MockWebServer()
    private lateinit var api: HttpPenmossApi

    @Before
    fun start() {
        server.start()
        api = HttpPenmossApi(server.url("/").toString(), OkHttpClient())
    }

    @After
    fun stop() = server.close()

    private fun respond(code: Int, body: String) =
        server.enqueue(MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build())

    @Test
    fun listsTheSessionsTheNotebookHolds() = runTest {
        respond(
            200,
            """{"now":100,"synced":true,"sessions":[{"key":"0123456789abcdef01234567","writer":"01JD2Z7Q8R4T6Y8W0E2R4T6YW1","label":"Claude Code · garden","name":"mac:/src/garden","host":"mac","startedAt":1,"lastSeen":90,"active":true,"offered":true},{"key":"89abcdef0123456789abcdef","writer":"01JD2Z7Q8R4T6Y8W0E2R4T6YW1","label":"Claude Code · old","name":"mac:/src/old","host":"mac","startedAt":1,"lastSeen":2,"active":false,"offered":false}]}""",
        )
        val listed = api.agentSessions()
        val live = AgentSession("0123456789abcdef01234567", "01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "Claude Code · garden", "mac:/src/garden", "mac", 1, 90, active = true, offered = true)
        assertEquals(100, listed.now)
        assertTrue(listed.synced)
        assertEquals(live, listed.sessions.first())
        // Send to… offers only the sessions seen this week.
        assertEquals(listOf(live), listed.offered)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/android/agent-sessions", request.url.encodedPath)
    }

    @Test
    fun readsAnEmptyListAndSaysWhyItWasRefused() = runTest {
        respond(200, """{"now":1,"synced":false,"sessions":[]}""")
        assertEquals(AgentSessionList(now = 1), api.agentSessions())
        respond(503, """{"error":{"code":"starting","message":"The notebook is opening"}}""")
        val error = runCatching { api.agentSessions() }.exceptionOrNull()
        assertTrue(error is ApiException)
        assertEquals("starting", (error as ApiException).code)
    }
}
