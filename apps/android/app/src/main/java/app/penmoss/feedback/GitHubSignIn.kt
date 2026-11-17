package app.penmoss.feedback

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request

/** What a sign-in with GitHub shows (PEN-146): never the device code or the token. */
sealed interface SignInState {
    data object Idle : SignInState

    /** The code to enter on GitHub (`WDJB-MJHT`), where, and when it stops working. */
    data class Waiting(val userCode: String, val verificationUri: String, val expiresAt: Long) : SignInState

    data class SignedIn(val login: String?, val message: String) : SignInState

    data object Denied : SignInState

    data object Expired : SignInState

    data object Cancelled : SignInState

    data class Failed(val message: String) : SignInState
}

/** A form POST to GitHub's web host, answering its status and body. */
fun interface SignInPost {
    suspend fun post(path: String, fields: Map<String, String>): Pair<Int, String>
}

/** [SignInPost] over OkHttp, to [web] (github.com), asking for JSON. */
fun okHttpSignInPost(http: OkHttpClient, web: String = GitHubDeviceSignIn.GITHUB_WEB) = SignInPost { path, fields ->
    withContext(Dispatchers.IO) {
        val body = FormBody.Builder().apply { fields.forEach { (key, value) -> add(key, value) } }.build()
        val request = Request.Builder().url("${web.trimEnd('/')}$path").post(body)
            .header("Accept", "application/json").header("User-Agent", "Penmoss").build()
        http.newCall(request).execute().use { it.code to it.body.string() }
    }
}

/**
 * Sign In with GitHub on the phone (PEN-146; the Mac's T82, D63, A1170): GitHub's device flow for
 * Penmoss's OAuth app. GitHub gives a short code; the person enters it at github.com/login/device
 * and approves; this polls until GitHub hands over the token, which [keep] checks and keeps in
 * the GitHub token store (A1012). No password and no client secret: the client id is public.
 */
class GitHubDeviceSignIn(
    private val post: SignInPost,
    private val clientId: String? = CLIENT_ID,
    /** Keeps the token: whether it was kept, and what to say. */
    private val keep: suspend (token: String) -> GitHubTokenModel.Saved,
    private val web: String = GITHUB_WEB,
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private val _state = MutableStateFlow<SignInState>(SignInState.Idle)
    val state: StateFlow<SignInState> = _state.asStateFlow()
    private var running: Job? = null

    /** Whether this build can sign in at all (it has Penmoss's OAuth app). */
    val available: Boolean get() = !clientId.isNullOrBlank()

    private fun json(text: String): JsonObject = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())

    private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.number(key: String) = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

    /** Asks GitHub for a code and waits for the person in [scope]; [open] shows GitHub's page. */
    fun start(scope: CoroutineScope, open: (String) -> Unit = {}) {
        val id = clientId
        if (id.isNullOrBlank()) {
            _state.value = SignInState.Failed("This build of Penmoss can’t sign in to GitHub. Use a token instead.")
            return
        }
        running?.cancel()
        running = scope.launch {
            val (status, text) = try {
                post.post("/login/device/code", mapOf("client_id" to id, "scope" to SCOPES))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _state.value = SignInState.Failed("Can’t reach GitHub to sign in. ${error.message.orEmpty()}".trim())
                return@launch
            }
            val body = json(text)
            if (status != 200) {
                _state.value = SignInState.Failed("Can’t reach GitHub to sign in. ${body.text("error_description") ?: "GitHub answered $status."}")
                return@launch
            }
            val deviceCode = body.text("device_code").orEmpty()
            val userCode = body.text("user_code").orEmpty()
            val uri = body.text("verification_uri").orEmpty()
            // Only GitHub's own page is ever opened (A1170).
            if (deviceCode.isEmpty() || !USER_CODE.matches(userCode) || uri != "${web.trimEnd('/')}/login/device") {
                _state.value = SignInState.Failed("GitHub answered the sign-in in a way Penmoss does not expect.")
                return@launch
            }
            val expiresAt = now() + (body.number("expires_in")?.takeIf { it > 0 } ?: 900) * 1000
            var interval = body.number("interval")?.takeIf { it > 0 } ?: 5
            _state.value = SignInState.Waiting(userCode, uri, expiresAt)
            runCatching { open(uri) }
            while (true) {
                sleep(interval * 1000)
                if (now() >= expiresAt) {
                    _state.value = SignInState.Expired
                    return@launch
                }
                val answer = try {
                    json(post.post("/login/oauth/access_token", mapOf("client_id" to id, "device_code" to deviceCode, "grant_type" to GRANT)).second)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // Offline for a moment: try again at the next interval, until the code expires.
                    continue
                }
                val token = answer.text("access_token")
                if (!token.isNullOrEmpty()) {
                    val kept = keep(token)
                    _state.value = if (kept.kept) SignInState.SignedIn(kept.login, kept.message) else SignInState.Failed(kept.message)
                    return@launch
                }
                when (answer.text("error")) {
                    "authorization_pending" -> Unit
                    // 5 s more each time, or the new interval GitHub names if that is longer.
                    "slow_down" -> interval = maxOf(interval + 5, answer.number("interval") ?: 0)
                    "access_denied" -> {
                        _state.value = SignInState.Denied
                        return@launch
                    }
                    "expired_token" -> {
                        _state.value = SignInState.Expired
                        return@launch
                    }
                    else -> {
                        _state.value = SignInState.Failed("GitHub refused the sign-in (${answer.text("error") ?: "no answer"}).")
                        return@launch
                    }
                }
            }
        }
    }

    /** Stops waiting. */
    fun cancel() {
        if (running?.isActive == true) _state.value = SignInState.Cancelled
        running?.cancel()
        running = null
    }

    /** Back to nothing said, once the screen has shown the outcome. */
    fun reset() {
        if (running?.isActive != true) _state.value = SignInState.Idle
    }

    companion object {
        const val GITHUB_WEB = "https://github.com"

        /** Penmoss's OAuth app, the Mac's (`GITHUB_CLIENT_ID` in apps/desktop/src/config.ts): public. */
        const val CLIENT_ID = "Ov23liU4eAFD4vcdWWOR"

        /** What the token may do: the Mac's scopes (repositories, and orgs to list them). */
        const val SCOPES = "repo read:org"

        private const val GRANT = "urn:ietf:params:oauth:grant-type:device_code"

        private val USER_CODE = Regex("^[A-Z0-9]{4}-[A-Z0-9]{4}$")
    }
}
