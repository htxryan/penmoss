package app.penmoss.ai

import android.content.SharedPreferences
import androidx.core.content.edit
import app.penmoss.engine.git.AiHost
import app.penmoss.security.SecretBox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/*
 * AI Descriptions on the phone (PEN-161 T6, A1656): the Anthropic API key, kept sealed by the
 * Keystore and never backed up (the app backs nothing up, A15), the call to Anthropic's Messages
 * API, and what each notebook's engine page asks ([AiHost]). The phone offers Anthropic with a
 * key only; with none set up it sends nothing, and the Mac describes its notes once they sync.
 */

/** The settings AI Descriptions reads, by key (core's `ai-description.ts`). */
object AiKeys {
    const val GLOBAL = "ai.description.global"
    const val WHEN = "ai.description.when"
    const val PAUSE = "ai.description.pause"
    const val MODEL = "ai.description.model"
    const val PROMPT = "ai.description.prompt"

    /** The prompt for a tag's description (A1677; core's `AI_TAG_PROMPT_SETTING`). */
    const val TAG_PROMPT = "ai.description.tagPrompt"
    const val PROVIDER = "ai.provider"
    const val NOTEBOOK = "ai.description"

    const val ANTHROPIC = "anthropic"
    const val NONE = "none"

    /** Anthropic's models, the fastest first (core's `ANTHROPIC_MODELS`). */
    val MODELS: List<Pair<String, String>> = listOf(
        "claude-haiku-5-5" to "Claude Haiku 5.5",
        "claude-sonnet-5-5" to "Claude Sonnet 5.5",
    )

    /** The pauses offered, in seconds (core's `PAUSE_CHOICES_SECONDS`), 2 minutes by default. */
    val PAUSES: List<Int> = listOf(30, 60, 120, 300, 600)
    const val DEFAULT_PAUSE = 120
}

/** One HTTP exchange: what [AnthropicClient] needs of OkHttp, so tests give a fake. */
fun interface AiHttp {
    suspend fun call(method: String, url: String, headers: Map<String, String>, body: String?): AiResponse
}

data class AiResponse(val code: Int, val body: String)

/** The OkHttp exchange: Anthropic's own host, no redirects followed. */
fun okHttpAi(http: OkHttpClient): AiHttp {
    val client = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
    val json = "application/json".toMediaType()
    return AiHttp { method, url, headers, body ->
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(url).apply {
                headers.forEach { (key, value) -> header(key, value) }
                method(method, body?.toRequestBody(json))
            }.build()
            client.newCall(request).execute().use { response -> AiResponse(response.code, response.body.string()) }
        }
    }
}

/** What a call came to, in the Mac's words (`apps/desktop/src/ai-provider.ts`). */
sealed interface AiResult {
    data class Text(val text: String) : AiResult

    data class Failed(val code: String, val message: String) : AiResult
}

/** Anthropic's Messages API with the person's key: checks a key, and describes a note. */
class AnthropicClient(private val http: AiHttp, private val base: String = "https://api.anthropic.com") {
    private val json = Json { ignoreUnknownKeys = true }

    private fun headers(key: String) = mapOf(
        "x-api-key" to key,
        "anthropic-version" to "2023-06-01",
        "content-type" to "application/json",
    )

    /** Whether Anthropic takes [key]: a list of one model, which costs nothing. */
    suspend fun check(key: String): AiResult = exchange { http.call("GET", "$base/v1/models?limit=1", headers(key), null) }
        ?.let { response -> if (response.code in 200..299) AiResult.Text("") else failure(response.code) }
        ?: OFFLINE

    /** The model's answer to [prompt], at most a few sentences. */
    suspend fun describe(key: String, model: String, prompt: String): AiResult {
        val body = JsonObject(
            mapOf(
                "model" to JsonPrimitive(model),
                "max_tokens" to JsonPrimitive(MAX_TOKENS),
                "messages" to JsonArray(
                    listOf(JsonObject(mapOf("role" to JsonPrimitive("user"), "content" to JsonPrimitive(prompt)))),
                ),
            ),
        )
        val response = exchange { http.call("POST", "$base/v1/messages", headers(key), body.toString()) } ?: return OFFLINE
        if (response.code !in 200..299) return failure(response.code)
        val content = runCatching { json.parseToJsonElement(response.body) as? JsonObject }.getOrNull()?.get("content") as? JsonArray
        val text = content?.mapNotNull { block ->
            (block as? JsonObject)?.takeIf { (it["type"] as? JsonPrimitive)?.contentOrNull == "text" }
                ?.let { (it["text"] as? JsonPrimitive)?.contentOrNull }
        }?.joinToString("")?.trim()
        return if (text.isNullOrEmpty()) AiResult.Failed("failed", "Anthropic answered with no description.") else AiResult.Text(text)
    }

    private suspend fun exchange(run: suspend () -> AiResponse): AiResponse? =
        try {
            run()
        } catch (_: IOException) {
            null
        }

    private fun failure(code: Int): AiResult.Failed = when (code) {
        401, 403 -> AiResult.Failed("refused", "Anthropic refused the API key. Check it in Settings → AI Descriptions.")
        429 -> AiResult.Failed("rate-limited", "Anthropic asked Penmoss to slow down. It tries again later.")
        529, 503 -> AiResult.Failed("failed", "Anthropic is busy. Penmoss tries again later.")
        else -> AiResult.Failed("failed", "Anthropic answered with an error ($code).")
    }

    companion object {
        const val MAX_TOKENS = 300
        val OFFLINE = AiResult.Failed("offline", "No connection to Anthropic. Penmoss tries again when the note next changes or syncs.")
    }
}

/** The Anthropic key on this phone, sealed by the Keystore; never shown again once saved. */
class AiKeyStore(private val prefs: SharedPreferences, private val box: SecretBox) {
    val saved: Boolean get() = prefs.contains(KEY)

    fun key(): String? = prefs.getString(KEY, null)?.let { hex ->
        runCatching { String(box.open(hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()), Charsets.UTF_8) }.getOrNull()
    }

    fun save(key: String) {
        val sealed = box.seal(key.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        prefs.edit {
            putString(KEY, sealed)
            remove(REFUSED)
        }
    }

    fun remove() = prefs.edit {
        remove(KEY)
        remove(REFUSED)
    }

    /** Anthropic refused the saved key: nothing more is sent with it until it changes. */
    var refused: Boolean
        get() = prefs.getBoolean(REFUSED, false)
        set(value) = prefs.edit { putBoolean(REFUSED, value) }

    /** The first run asked "Describe Notes for Agents?" on this phone: it asks once. */
    var asked: Boolean
        get() = prefs.getBoolean(ASKED, false)
        set(value) = prefs.edit { putBoolean(ASKED, value) }

    companion object {
        const val PREFS = "penmoss.ai"
        private const val KEY = "anthropic.key"
        private const val REFUSED = "anthropic.refused"
        private const val ASKED = "firstRun.asked"
    }
}

/** What Settings shows of the key. */
data class AiKeyState(val saved: Boolean, val refused: Boolean)

/**
 * AI Descriptions as the phone runs it: the key (saved only once Anthropic takes it), and what
 * the engine pages ask. [settings] is the device's settings as Settings reads them: the Primary
 * Notebook's, with this phone's own (`ai.provider`) over them.
 */
class AiDescriptions(
    private val keys: AiKeyStore,
    private val client: AnthropicClient,
    private val settings: () -> JsonObject,
) : AiHost {
    private val state = MutableStateFlow(AiKeyState(keys.saved, keys.refused))
    val key: StateFlow<AiKeyState> = state.asStateFlow()

    private fun changed() {
        state.value = AiKeyState(keys.saved, keys.refused)
    }

    private fun text(key: String): String? = (settings()[key] as? JsonPrimitive)?.contentOrNull

    /** The provider this phone uses: Anthropic, or none (the Mac's Claude Code is not here). */
    val provider: String get() = if (text(AiKeys.PROVIDER) == AiKeys.ANTHROPIC) AiKeys.ANTHROPIC else AiKeys.NONE

    /** The model: the one picked when it is Anthropic's, else the fastest. */
    val model: String get() = text(AiKeys.MODEL)?.takeIf { id -> AiKeys.MODELS.any { it.first == id } } ?: AiKeys.MODELS.first().first

    /** Whether a call can be made: Anthropic, a key, and not refused. */
    val ready: Boolean get() = provider == AiKeys.ANTHROPIC && keys.saved && !keys.refused

    /** Checks [key] with Anthropic and keeps it only if Anthropic takes it; the words to show. */
    suspend fun saveKey(key: String): AiResult {
        val clean = key.trim()
        if (clean.isEmpty()) return AiResult.Failed("invalid", "Paste your Anthropic API key first.")
        val checked = client.check(clean)
        if (checked is AiResult.Text) {
            keys.save(clean)
            changed()
            return AiResult.Text("Saved. Anthropic accepted the key.")
        }
        return checked
    }

    /** Checks the saved key again. */
    suspend fun testKey(): AiResult {
        val key = keys.key() ?: return AiResult.Failed("no-key", "No key is saved on this phone.")
        val checked = client.check(key)
        keys.refused = checked is AiResult.Failed && checked.code == "refused"
        changed()
        return if (checked is AiResult.Text) AiResult.Text("The key works with ${AiKeys.MODELS.first { it.first == model }.second}.") else checked
    }

    fun removeKey() {
        keys.remove()
        changed()
    }

    /** Whether the first run still has to ask about AI Descriptions on this phone. */
    val askPending: Boolean get() = !keys.asked

    fun markAsked() {
        keys.asked = true
    }

    override suspend fun config(): JsonElement {
        val values = settings()
        val pause = (values[AiKeys.PAUSE] as? JsonPrimitive)?.intOrNull?.takeIf { it in AiKeys.PAUSES } ?: AiKeys.DEFAULT_PAUSE
        return JsonObject(
            mapOf(
                "ready" to JsonPrimitive(ready),
                "global" to JsonPrimitive((values[AiKeys.GLOBAL] as? JsonPrimitive)?.booleanOrNull == true),
                "when" to JsonPrimitive(if (text(AiKeys.WHEN) == "sync") "sync" else "pause"),
                "pauseS" to JsonPrimitive(pause),
                "prompt" to JsonPrimitive(text(AiKeys.PROMPT) ?: ""),
                "tagPrompt" to JsonPrimitive(text(AiKeys.TAG_PROMPT) ?: ""),
            ),
        )
    }

    override suspend fun describe(prompt: String): JsonElement {
        val key = keys.key()
        if (!ready || key == null) return answer(AiResult.Failed("no-provider", "Choose an AI provider in Settings → AI Descriptions."))
        val result = client.describe(key, model, prompt)
        if (result is AiResult.Failed && result.code == "refused") {
            keys.refused = true
            changed()
        }
        return answer(result)
    }

    private fun answer(result: AiResult): JsonElement = when (result) {
        is AiResult.Text -> JsonObject(mapOf("ok" to JsonPrimitive(true), "text" to JsonPrimitive(result.text)))
        is AiResult.Failed -> JsonObject(
            mapOf("ok" to JsonPrimitive(false), "code" to JsonPrimitive(result.code), "message" to JsonPrimitive(result.message)),
        )
    }
}
