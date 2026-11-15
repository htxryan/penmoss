package app.penmoss.feedback

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sign In with GitHub on the phone (PEN-146): GitHub's device flow, over a fake GitHub. The code is
 * shown, only github.com's own page opens, the poll keeps GitHub's pace, and the token goes to the
 * token store, never to the screen.
 */
class GitHubDeviceSignInTest {
    private val code = """{"device_code":"dc1","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"""

    private class Fake(val answers: ArrayDeque<String>, val code: String) : SignInPost {
        val calls = mutableListOf<Pair<String, Map<String, String>>>()
        override suspend fun post(path: String, fields: Map<String, String>): Pair<Int, String> {
            calls += path to fields
            return if (path == "/login/device/code") 200 to code else 200 to answers.removeFirst()
        }
    }

    private fun run(
        polls: List<String>,
        code: String = this.code,
        kept: GitHubTokenModel.Saved = GitHubTokenModel.Saved(true, "Signed in as htxryan."),
        block: suspend (GitHubDeviceSignIn, Fake, MutableList<String>, MutableList<Long>, MutableList<String>) -> Unit,
    ) = runBlocking {
        val fake = Fake(ArrayDeque(polls), code)
        val tokens = mutableListOf<String>()
        val slept = mutableListOf<Long>()
        val opened = mutableListOf<String>()
        var clock = 0L
        val signIn = GitHubDeviceSignIn(
            fake,
            keep = { tokens += it; kept },
            now = { clock },
            sleep = { slept += it; clock += it },
        )
        val job = SupervisorJob()
        try {
            signIn.start(CoroutineScope(coroutineContext + job)) { opened += it }
            block(signIn, fake, tokens, slept, opened)
        } finally {
            job.cancelAndJoin()
        }
    }

    private suspend fun GitHubDeviceSignIn.until(what: (SignInState) -> Boolean) = withTimeout(5_000) { state.first(what) }

    @Test
    fun theTokenIsKeptOnceApprovedAtGitHubsPace() = run(
        listOf(
            """{"error":"authorization_pending"}""",
            """{"error":"slow_down","interval":10}""",
            """{"access_token":"gho_secret","token_type":"bearer"}""",
        ),
    ) { signIn, fake, tokens, slept, opened ->
        val done = signIn.until { it is SignInState.SignedIn }
        assertEquals(SignInState.SignedIn(null, "Signed in as htxryan."), done)
        assertEquals(listOf("gho_secret"), tokens)
        assertEquals(listOf("https://github.com/login/device"), opened)
        // 5 s, 5 s, then 10 s after slow_down (5 more, or GitHub's 10 if longer).
        assertEquals(listOf(5_000L, 5_000L, 10_000L), slept)
        assertEquals(mapOf("client_id" to GitHubDeviceSignIn.CLIENT_ID, "scope" to "repo read:org"), fake.calls.first().second)
        assertEquals("urn:ietf:params:oauth:grant-type:device_code", fake.calls.last().second["grant_type"])
        assertFalse(done.toString().contains("gho_secret"))
    }

    @Test
    fun aDeclinedSignInKeepsNothing() = run(listOf("""{"error":"access_denied"}""")) { signIn, _, tokens, _, _ ->
        assertEquals(SignInState.Denied, signIn.until { it == SignInState.Denied })
        assertTrue(tokens.isEmpty())
    }

    @Test
    fun aPageThatIsNotGitHubsOwnIsNeverOpened() = run(
        emptyList(),
        code = """{"device_code":"dc1","user_code":"WDJB-MJHT","verification_uri":"https://evil.example/login/device","interval":5}""",
    ) { signIn, _, _, _, opened ->
        assertTrue(signIn.until { it is SignInState.Failed } is SignInState.Failed)
        assertTrue(opened.isEmpty())
    }

    @Test
    fun theCodeRunsOutAndNothingIsKept() {
        run(List(200) { """{"error":"authorization_pending"}""" }, code = code.replace("900", "12")) { signIn, _, tokens, _, _ ->
            assertEquals(SignInState.Expired, signIn.until { it == SignInState.Expired })
            assertTrue(tokens.isEmpty())
        }
    }

    @Test
    fun aTokenTheStoreRefusesIsSaid() = run(
        listOf("""{"access_token":"gho_secret"}"""),
        kept = GitHubTokenModel.Saved(false, "GitHub refused the token."),
    ) { signIn, _, _, _, _ ->
        assertEquals(SignInState.Failed("GitHub refused the token."), signIn.until { it is SignInState.Failed })
    }

    @Test
    fun aBuildWithoutTheOAuthAppSaysToUseAToken() {
        val signIn = GitHubDeviceSignIn({ _, _ -> error("not called") }, clientId = null, keep = { error("not called") })
        assertFalse(signIn.available)
        signIn.start(CoroutineScope(SupervisorJob()))
        assertTrue((signIn.state.value as SignInState.Failed).message.contains("Use a token instead"))
    }
}
