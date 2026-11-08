package app.penmoss.feedback

import android.content.SharedPreferences
import androidx.core.content.edit
import app.penmoss.auth.SecretBox
import app.penmoss.engine.api.FeedbackAnswer
import app.penmoss.engine.api.FeedbackImage
import app.penmoss.engine.api.PenmossFeedbackApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.io.InterruptedIOException
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/*
 * Send feedback filed from the phone with the person's own GitHub token (T57, D48), a port of
 * core's `fileFeedback` (packages/core/src/feedback-github.ts), answering in the shapes the
 * Worker's `POST /api/feedback` gave so the outbox (A803) sorts each answer as before.
 *
 * - A1010: the device files the issue in htxryan/penmoss with its own token, the same checks,
 *   body, labels and footer as the Worker; a retry looks the issue up by its footer first and
 *   never files twice (a ledger keeps what the Worker's row kept).
 * - A1011: screenshots go up from the device as GitHub user attachments, each with its own type
 *   and length.
 * - A1012: the token is the person's, entered in Settings → About → GitHub Token, kept encrypted
 *   with the Android Keystore, checked when it is saved, never logged and kept across sign-out
 *   (it is not the account's). Refusals are said plainly; with no token a report waits, queued.
 */

/** Where feedback is filed (D41): GitHub's hosts, or a fake in tests and a debug build's override. */
data class GitHubFeedbackConfig(
    val api: String = GITHUB_API,
    val uploads: String = GITHUB_UPLOADS,
    val owner: String = "htxryan",
    val repo: String = "penmoss",
    /** The repository's numeric id, which the attachment upload names it by. */
    val repoId: String = "1450019106",
) {
    val repoName: String get() = "$owner/$repo"

    companion object {
        const val GITHUB_API = "https://api.github.com"
        const val GITHUB_UPLOADS = "https://uploads.github.com"

        /**
         * The build's hosts: a release build always files on GitHub; a debug build may point at a
         * fake with `penmoss.githubApi` and `penmoss.githubUploads` in local.properties.
         */
        fun forBuild(debug: Boolean, api: String, uploads: String): GitHubFeedbackConfig =
            if (!debug) GitHubFeedbackConfig() else GitHubFeedbackConfig(api.ifBlank { GITHUB_API }, uploads.ifBlank { GITHUB_UPLOADS })
    }
}

/** What the person is told about their token, in plain words (A1012; core's TOKEN_MESSAGES). */
object GitHubTokenMessages {
    /** Where the token is entered on Android. */
    const val WHERE = "Settings → About → GitHub Token"
    const val MISSING = "Add your GitHub token in $WHERE to send it."
    const val INVALID = "GitHub does not accept this token: it may have expired or been revoked."

    fun cannotFile(repo: String) =
        "This GitHub token cannot open issues in $repo. Use a classic token with the public_repo scope or, as a collaborator, a fine-grained token with Issues and Contents (read and write) on $repo."
}

/**
 * The person's GitHub token (A1012): sealed by the Keystore, in preferences of its own that
 * signing out never clears, with the account it belongs to (not a secret) once checked.
 */
class GitHubTokenStore(private val prefs: SharedPreferences, private val box: SecretBox) {
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    fun token(): String? {
        val sealed = prefs.getString(TOKEN, null) ?: return null
        // A key lost with a restore or a keystore reset: the token is gone, enter it again.
        return runCatching { String(box.open(fromHex(sealed)), Charsets.UTF_8) }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    val hasToken: Boolean get() = prefs.contains(TOKEN)

    /** The GitHub account the saved token signs in as, when the check could say. */
    fun login(): String? = prefs.getString(LOGIN, null)

    fun save(token: String, login: String?) {
        prefs.edit {
            putString(TOKEN, toHex(box.seal(token.toByteArray(Charsets.UTF_8))))
            if (login != null) putString(LOGIN, login) else remove(LOGIN)
        }
        listeners.forEach { runCatching { it() } }
    }

    fun clear() {
        prefs.edit {
            remove(TOKEN)
            remove(LOGIN)
        }
        listeners.forEach { runCatching { it() } }
    }

    /** Told when the token is saved or removed. */
    fun onChange(listener: () -> Unit) {
        listeners += listener
    }

    companion object {
        /** Its own file, never one a sign-out clears. */
        const val PREFS = "penmoss.github-token"
        private const val TOKEN = "token"
        private const val LOGIN = "login"

        private fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

        private fun fromHex(text: String): ByteArray = ByteArray(text.length / 2) { i -> text.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}

/** What the phone remembers of each submission it filed or tried to (A1010; core's FeedbackLedgerEntry). */
data class FeedbackLedgerEntry(
    val createdAt: Long,
    /** [PENDING], [FAILED] or [SENT]. */
    val status: String,
    val number: Long? = null,
    val url: String? = null,
    /** No new attempt before this (epoch ms): the last create may still be landing on GitHub. */
    val settleUntil: Long? = null,
    val updatedAt: Long = createdAt,
) {
    companion object {
        const val PENDING = "pending"
        const val FAILED = "failed"
        const val SENT = "sent"
    }
}

interface FeedbackLedger {
    fun get(submissionId: String): FeedbackLedgerEntry?

    fun set(submissionId: String, entry: FeedbackLedgerEntry)
}

/** The ledger in preferences of its own: kept across sign-out, entries forgotten after 90 days. */
class PrefsFeedbackLedger(private val prefs: SharedPreferences, private val now: () -> Long = System::currentTimeMillis) : FeedbackLedger {
    override fun get(submissionId: String): FeedbackLedgerEntry? {
        val text = prefs.getString(KEY + submissionId, null) ?: return null
        val value = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return null
        fun long(key: String) = (value[key] as? JsonPrimitive)?.longOrNull
        val status = (value["status"] as? JsonPrimitive)?.content ?: return null
        return FeedbackLedgerEntry(
            createdAt = long("createdAt") ?: return null,
            status = status,
            number = long("number"),
            url = (value["url"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            settleUntil = long("settleUntil"),
            updatedAt = long("updatedAt") ?: 0,
        )
    }

    override fun set(submissionId: String, entry: FeedbackLedgerEntry) {
        val text = buildJsonObject {
            put("createdAt", entry.createdAt)
            put("status", entry.status)
            entry.number?.let { put("number", it) }
            entry.url?.let { put("url", it) }
            entry.settleUntil?.let { put("settleUntil", it) }
            put("updatedAt", entry.updatedAt)
        }.toString()
        val cutoff = now() - KEEP_MS
        prefs.edit {
            putString(KEY + submissionId, text)
            for ((key, stored) in prefs.all) {
                if (!key.startsWith(KEY) || key == KEY + submissionId) continue
                val updated = runCatching { ((Json.parseToJsonElement(stored as String) as JsonObject)["updatedAt"] as JsonPrimitive).longOrNull }.getOrNull()
                if (updated == null || updated < cutoff) remove(key)
            }
        }
    }

    companion object {
        const val PREFS = "penmoss.feedback-ledger"
        private const val KEY = "s."
        const val KEEP_MS = 90L * 24 * 60 * 60_000
    }
}

/** An in-memory ledger (tests). */
class MemoryFeedbackLedger : FeedbackLedger {
    val rows = ConcurrentHashMap<String, FeedbackLedgerEntry>()

    override fun get(submissionId: String) = rows[submissionId]

    override fun set(submissionId: String, entry: FeedbackLedgerEntry) {
        rows[submissionId] = entry
    }
}

/** A failed GitHub call; its message never holds the token (core's FeedbackGitHubError). */
class GitHubFeedbackError(
    message: String,
    /** GitHub's status, or 0 when it never answered. */
    val status: Int,
    val retryable: Boolean,
    /** GitHub's Retry-After, in seconds. */
    val retryAfter: Long? = null,
    /** No answer at all and nothing timed out: the phone is offline. */
    val offline: Boolean = false,
) : Exception(message) {
    /** A refusal of the token itself: not valid, or it may not do this to the repository. */
    val tokenRefused: Boolean get() = !retryable && status in setOf(401, 403, 404)
}

/** What a token check found (A1012; core's TokenCheck). */
sealed interface TokenCheck {
    val login: String?

    data class Ok(override val login: String?) : TokenCheck

    data class Problem(override val login: String?, val problem: String, val message: String) : TokenCheck

    companion object {
        const val INVALID = "invalid"
        const val CANNOT_FILE = "cannot_file"
        const val UNREACHABLE = "unreachable"
    }
}

/** The few GitHub calls feedback makes (core's FeedbackGitHub). */
class FeedbackGitHub(private val http: OkHttpClient, private val config: GitHubFeedbackConfig, private val token: String) {
    data class Issue(val number: Long, val url: String)

    data class Listed(val number: Long, val url: String, val body: String)

    private fun request(url: String) = Request.Builder().url(url)
        .header("Authorization", "Bearer $token")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        // GitHub refuses requests without one.
        .header("User-Agent", "penmoss-feedback")

    private suspend fun send(what: String, request: Request): JsonElement = withContext(Dispatchers.IO) {
        val response = try {
            http.newCall(request).execute()
        } catch (error: InterruptedIOException) {
            throw GitHubFeedbackError("$what: GitHub did not answer (timeout)", 0, true)
        } catch (error: IOException) {
            // No connection was made (no network, no address): nothing reached GitHub.
            val unreached = error is java.net.ConnectException || error is java.net.UnknownHostException || error is java.net.NoRouteToHostException
            throw GitHubFeedbackError("$what: GitHub did not answer (${error::class.java.simpleName})", 0, true, offline = unreached)
        }
        response.use {
            val text = runCatching { it.body.string() }.getOrDefault("")
            if (it.code !in 200..299) {
                val detail = reasonOf(text)
                val retryAfter = it.header("Retry-After")?.trim()?.toDoubleOrNull()?.takeIf { s -> s > 0 }?.let { s -> kotlin.math.ceil(s).toLong() }
                // A primary limit (remaining 0), or a secondary one: a 403 or 429 with Retry-After,
                // or GitHub's "secondary rate limit" message.
                val limited = it.code == 429 ||
                    (it.code == 403 && (it.header("x-ratelimit-remaining") == "0" || retryAfter != null || SECONDARY.containsMatchIn(detail)))
                val retryable = it.code >= 500 || limited
                val hint = if (!retryable && it.code in setOf(401, 403, 404)) " (the token cannot write to the repository)" else ""
                throw GitHubFeedbackError(
                    "$what: GitHub answered ${it.code}${if (detail.isNotEmpty()) " ($detail)" else ""}$hint",
                    it.code,
                    retryable,
                    retryAfter,
                )
            }
            try {
                Json.parseToJsonElement(text)
            } catch (error: Exception) {
                throw GitHubFeedbackError("$what: GitHub's answer was not JSON", it.code, true)
            }
        }
    }

    /** Uploads one image as an issue attachment, streamed from its file; answers its address (A1011). */
    suspend fun uploadImage(name: String, contentType: String, file: java.io.File): String {
        val url = "${config.uploads}/user-attachments/assets".toHttpUrl().newBuilder()
            .addQueryParameter("repository_id", config.repoId)
            .addQueryParameter("name", name)
            .build()
        // The file's own type and length (OkHttp sends its Content-Length).
        val body = file.asRequestBody(contentType.toMediaType())
        val answer = send("Uploading $name", request(url.toString()).post(body).build()) as? JsonObject
        val address = (answer?.get("url") as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
        if (!ADDRESS.matches(address)) throw GitHubFeedbackError("Uploading $name: GitHub gave no address", 201, true)
        return address
    }

    /** Opens the issue; answers its number and web address. */
    suspend fun createIssue(title: String, body: String, labels: List<String>): Issue {
        val json = buildJsonObject {
            put("title", title)
            put("body", body)
            putJsonArray("labels") { labels.forEach { add(JsonPrimitive(it)) } }
        }.toString()
        val answer = send(
            "Opening the issue",
            request("${config.api}/repos/${config.owner}/${config.repo}/issues").post(json.toRequestBody(JSON)).build(),
        ) as? JsonObject
        val number = (answer?.get("number") as? JsonPrimitive)?.longOrNull
        val url = (answer?.get("html_url") as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (number == null || url == null) throw GitHubFeedbackError("Opening the issue: GitHub gave no number", 201, false)
        return Issue(number, url)
    }

    /**
     * The issues updated since [since] (epoch ms), newest first, 100 a page: listed, not searched,
     * because the search index lags behind a just-filed issue. Not filtered by the `in-app
     * feedback` label, which GitHub drops when the account filing cannot triage (T80.3).
     */
    suspend fun listFeedbackIssues(since: Long, page: Int): List<Listed> {
        val url = "${config.api}/repos/${config.owner}/${config.repo}/issues".toHttpUrl().newBuilder()
            .addQueryParameter("state", "all")
            .addQueryParameter("sort", "created")
            .addQueryParameter("direction", "desc")
            .addQueryParameter("since", Instant.ofEpochMilli(since).toString())
            .addQueryParameter("per_page", "100")
            .addQueryParameter("page", page.toString())
            .build()
        val list = send("Looking for an issue already filed", request(url.toString()).get().build()) as? JsonArray
            ?: throw GitHubFeedbackError("Looking for an issue already filed: not a list", 200, true)
        return list.mapNotNull { item ->
            val each = item as? JsonObject ?: return@mapNotNull null
            val number = (each["number"] as? JsonPrimitive)?.longOrNull ?: return@mapNotNull null
            val url = (each["html_url"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
            val body = (each["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
            Listed(number, url, body)
        }
    }

    /**
     * What the token may do here (A1012): who it is, and whether it can see the repository and
     * write to it. A token that sees the repository may still lack Issues or Contents write;
     * GitHub says so only when they are used, and the filer says it then.
     */
    suspend fun checkToken(): TokenCheck {
        var login: String? = null
        try {
            val user = send("Checking the token", request("${config.api}/user").get().build()) as? JsonObject
            login = (user?.get("login") as? JsonPrimitive)?.takeIf { it.isString }?.content
        } catch (error: GitHubFeedbackError) {
            if (error.status == 401) return TokenCheck.Problem(null, TokenCheck.INVALID, GitHubTokenMessages.INVALID)
            if (error.retryable) return TokenCheck.Problem(null, TokenCheck.UNREACHABLE, error.message.orEmpty())
            // A fine-grained token with no account permissions may not read /user: carry on.
        }
        return try {
            val found = send("Checking the repository", request("${config.api}/repos/${config.owner}/${config.repo}").get().build()) as? JsonObject
            val permissions = found?.get("permissions") as? JsonObject
            fun flag(key: String) = (permissions?.get(key) as? JsonPrimitive)?.booleanOrNull
            // The account's permissions: in a private repository, an account that cannot write cannot
            // file, whatever the token. Anyone signed in can open an issue in a public one (T80.3).
            val isPublic = (found?.get("private") as? JsonPrimitive)?.booleanOrNull == false
            if (!isPublic && permissions != null && flag("push") == false && flag("triage") == false) {
                TokenCheck.Problem(login, TokenCheck.CANNOT_FILE, GitHubTokenMessages.cannotFile(config.repoName))
            } else {
                TokenCheck.Ok(login)
            }
        } catch (error: GitHubFeedbackError) {
            when {
                error.retryable -> TokenCheck.Problem(login, TokenCheck.UNREACHABLE, error.message.orEmpty())
                error.status == 401 -> TokenCheck.Problem(null, TokenCheck.INVALID, GitHubTokenMessages.INVALID)
                else -> TokenCheck.Problem(login, TokenCheck.CANNOT_FILE, GitHubTokenMessages.cannotFile(config.repoName))
            }
        }
    }

    /** The issue an earlier attempt filed for [submissionId], found by its footer; null when none. */
    suspend fun findIssue(submissionId: String, since: Long): Issue? {
        val footer = "· submission $submissionId"
        for (page in 1..FIND_PAGES) {
            val issues = listFeedbackIssues(since, page)
            issues.firstOrNull { issue -> issue.body.split('\n').any { it.trimEnd().endsWith(footer) } }?.let { return Issue(it.number, it.url) }
            if (issues.size < 100) return null
        }
        return null
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private val ADDRESS = Regex("^https?://\\S+$")
        private val SECONDARY = Regex("secondary rate limit|abuse", RegexOption.IGNORE_CASE)

        /** How many pages of the label's newest issues [findIssue] reads. */
        const val FIND_PAGES = 3

        /** GitHub's own words for a refusal (`message`, and the first error's), cut short. */
        internal fun reasonOf(text: String): String = runCatching {
            val body = Json.parseToJsonElement(text) as JsonObject
            val first = (body["errors"] as? JsonArray)?.firstOrNull() as? JsonObject
            listOf(
                (body["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty(),
                (first?.get("message") as? JsonPrimitive)?.takeIf { it.isString }?.content
                    ?: (first?.get("code") as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty(),
            ).filter { it.isNotEmpty() }.joinToString(": ").take(200)
        }.getOrDefault("")
    }
}

/** The payload, checked as core's `readFeedbackPayload` checks it. */
data class FeedbackSubmission(
    val submissionId: String,
    val type: FeedbackType,
    val priority: Int,
    val title: String,
    val description: String,
    val version: String,
    val context: FeedbackContextData,
)

class FeedbackInvalid(message: String, val status: Int = 400) : Exception(message)

object FeedbackSubmissions {
    private val ULID = Regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
    private val GROUP_IDS = FeedbackGroupId.entries.map { it.wire }.toSet()
    private const val MAX_COLUMNS = 6

    /** The `payload` part, checked; throws [FeedbackInvalid] naming the field. */
    fun read(raw: String): FeedbackSubmission {
        val payload = runCatching { Json.parseToJsonElement(raw) as JsonObject }.getOrNull() ?: throw FeedbackInvalid("payload must be a JSON object")
        fun string(key: String): String? = (payload[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        fun present(key: String) = payload[key] != null && payload[key] !is JsonNull
        val submissionId = string("submissionId")?.takeIf(ULID::matches) ?: throw FeedbackInvalid("submissionId must be a ULID")
        val type = string("type")?.let(FeedbackType::of) ?: throw FeedbackInvalid("type must be bug or feature")
        val priority = (payload["priority"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it in 1..4 }
            ?: throw FeedbackInvalid("priority must be 1, 2, 3 or 4")
        val title = string("title")?.let { Js.trim(Js.collapseSpaces(it)) }.orEmpty()
        if (title.isEmpty()) throw FeedbackInvalid("title is required")
        if (title.length > FeedbackLimits.TITLE_MAX) throw FeedbackInvalid("title must be ${FeedbackLimits.TITLE_MAX} characters at most")
        if (present("description") && string("description") == null) throw FeedbackInvalid("description must be a string")
        val description = string("description").orEmpty()
        if (description.length > FeedbackLimits.DESCRIPTION_MAX) {
            throw FeedbackInvalid("description must be ${FeedbackLimits.DESCRIPTION_MAX} characters at most", 413)
        }
        if (present("version") && string("version") == null) throw FeedbackInvalid("version must be a string")
        val version = Js.trim(Js.collapseSpaces(string("version").orEmpty())).take(FeedbackLimits.VERSION_MAX)
        val context = if (present("context")) context(payload["context"]!!) ?: throw FeedbackInvalid("context is not a valid captured context") else FeedbackContextData()
        return FeedbackSubmission(submissionId, type, priority, title, description, version, context)
    }

    /** Core's `parseFeedbackContext`: known groups once each, small tables of strings. */
    private fun context(value: JsonElement): FeedbackContextData? {
        val groups = ((value as? JsonObject)?.get("groups") as? JsonArray) ?: return null
        if (groups.size > GROUP_IDS.size) return null
        val seen = HashSet<String>()
        val out = mutableListOf<FeedbackGroup>()
        for (raw in groups) {
            val group = raw as? JsonObject ?: return null
            val id = (group["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            if (id !in GROUP_IDS || !seen.add(id)) return null
            val columns = (group["columns"] as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null } ?: return null
            if (columns.isEmpty() || columns.size > MAX_COLUMNS || columns.any { it.length > 40 }) return null
            val rows = group["rows"] as? JsonArray ?: return null
            if (rows.size > FeedbackLimits.GROUP_ROWS) return null
            val checked = rows.map { row ->
                val cells = (row as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null } ?: return null
                if (cells.size != columns.size || cells.any { it.length > FeedbackLimits.CELL }) return null
                cells
            }
            out += FeedbackGroup(id, columns, checked)
        }
        return FeedbackContextData(out)
    }

    /** Each image type's file extension (core's FEEDBACK_IMAGE_TYPES). */
    val IMAGE_TYPES = mapOf("image/png" to "png", "image/jpeg" to "jpg", "image/gif" to "gif", "image/webp" to "webp")

    /** One screenshot's type, checked against its size and first bytes (core's `checkFeedbackImage`). */
    fun checkImage(type: String, size: Long, head: ByteArray): String {
        val kind = type.substringBefore(';').trim().lowercase()
        if (kind !in IMAGE_TYPES) throw FeedbackInvalid("Screenshots must be PNG, JPEG, GIF or WebP images")
        if (size > FeedbackLimits.SCREENSHOT_BYTES) throw FeedbackInvalid("Each screenshot must be 10 MB at most", 413)
        if (size == 0L) throw FeedbackInvalid("A screenshot is empty")
        fun at(i: Int) = head.getOrNull(i)?.toInt()?.and(0xff)
        fun ascii(from: Int, to: Int) = (from until to).map { at(it)?.toChar() ?: ' ' }.joinToString("")
        val matches = when (kind) {
            "image/png" -> listOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a).withIndex().all { (i, b) -> at(i) == b }
            "image/jpeg" -> at(0) == 0xff && at(1) == 0xd8 && at(2) == 0xff
            "image/gif" -> ascii(0, 6) == "GIF87a" || ascii(0, 6) == "GIF89a"
            else -> ascii(0, 4) == "RIFF" && ascii(8, 12) == "WEBP"
        }
        if (!matches) throw FeedbackInvalid("A screenshot is not the $kind it says it is")
        return kind
    }
}

/**
 * Files feedback on GitHub from the phone (A1010–A1012): what the Worker did, with the person's
 * own token. Never throws for GitHub's answers: every outcome is a [FeedbackAnswer]. Only having
 * no network at all before anything reached GitHub is an [IOException], as for the server, so the
 * outbox waits without counting it (A803).
 */
class GitHubFeedbackApi(
    private val http: OkHttpClient,
    private val config: GitHubFeedbackConfig,
    /** The person's token, read at each send; null: none saved. */
    private val token: () -> String?,
    private val ledger: FeedbackLedger,
    private val now: () -> Long = System::currentTimeMillis,
    /** Who files: the footer's client (A794). */
    private val client: String = "android",
) : PenmossFeedbackApi {
    private val client20s: OkHttpClient = http.newBuilder()
        .followRedirects(false)
        .callTimeout(TIMEOUT_S, TimeUnit.SECONDS)
        .build()

    /** One filing at a time per submission: a second asks while one runs (`in_progress`). */
    private val running: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** The repository filed in (`htxryan/penmoss`), as the words name it. */
    val repo: String get() = config.repoName

    /** The token's check, for Settings (A1012). */
    suspend fun checkToken(candidate: String): TokenCheck = FeedbackGitHub(client20s, config, candidate).checkToken()

    override suspend fun sendFeedback(payload: String, images: List<FeedbackImage>): FeedbackAnswer {
        val held = token() ?: return FeedbackAnswer.Refused(0, NO_TOKEN, GitHubTokenMessages.MISSING)
        val submission: FeedbackSubmission
        val shots = mutableListOf<Pair<String, java.io.File>>()
        try {
            submission = FeedbackSubmissions.read(payload)
            if (images.size > FeedbackLimits.SCREENSHOTS) throw FeedbackInvalid("At most ${FeedbackLimits.SCREENSHOTS} screenshots")
            for (image in images) {
                val head = withContext(Dispatchers.IO) { headOf(image.file) }
                shots += FeedbackSubmissions.checkImage(image.contentType, image.file.length(), head) to image.file
            }
        } catch (error: FeedbackInvalid) {
            return refusal(error.status, if (error.status == 413) "too_large" else "invalid_request", error.message.orEmpty())
        } catch (error: IOException) {
            return refusal(400, "invalid_request", "A screenshot could not be read")
        }
        val id = submission.submissionId
        val names = shots.mapIndexed { index, (type, _) -> "screenshot-${index + 1}.${FeedbackSubmissions.IMAGE_TYPES.getValue(type)}" }
        // No token reaches GitHub, whatever the form held (A791).
        fun body(screenshots: List<Pair<String, String>>) = FeedbackMarkdown.issueBody(
            description = FeedbackRedaction.redactSecrets(submission.description),
            screenshots = screenshots,
            context = FeedbackRedaction.contextWithoutSecrets(submission.context),
            client = client,
            version = submission.version,
            submissionId = id,
        )
        val tooLong = refusal(413, "too_large", "The description and context are longer than a GitHub issue allows; shorten them")
        if (body(names.map { it to LONGEST_ASSET_URL }).length > BODY_MAX) return tooLong
        if (!running.add(id)) return refusal(409, IN_PROGRESS, "This feedback is being filed now; try again shortly")
        try {
            val existing = ledger.get(id)
            if (existing?.status == FeedbackLedgerEntry.SENT && existing.number != null && existing.url != null) {
                return FeedbackAnswer.Filed(existing.number, existing.url, duplicate = true)
            }
            val at = now()
            val settle = existing?.settleUntil
            if (settle != null && at < settle) {
                val wait = (settle - at + 999) / 1000
                return refusal(409, IN_PROGRESS, "GitHub may still be filing this feedback; try again shortly", wait)
            }
            val createdAt = existing?.createdAt ?: at
            fun record(status: String, issue: FeedbackGitHub.Issue? = null, settleUntil: Long? = null) {
                runCatching { ledger.set(id, FeedbackLedgerEntry(createdAt, status, issue?.number, issue?.url, settleUntil, now())) }
            }
            record(FeedbackLedgerEntry.PENDING)
            val github = FeedbackGitHub(client20s, config, held)
            var creating = false
            try {
                // An earlier attempt's issue, filed before its answer was lost: adopted, never filed again.
                val earlier = if (existing != null) github.findIssue(id, createdAt - LOOKUP_SLACK_MS) else null
                if (earlier != null) {
                    record(FeedbackLedgerEntry.SENT, earlier)
                    return FeedbackAnswer.Filed(earlier.number, earlier.url, duplicate = true)
                }
                val uploaded = shots.mapIndexed { index, (type, file) -> names[index] to github.uploadImage(names[index], type, file) }
                val text = body(uploaded)
                if (text.length > BODY_MAX) {
                    record(FeedbackLedgerEntry.FAILED)
                    return tooLong
                }
                creating = true
                val issue = github.createIssue(FeedbackRedaction.redactSecrets(submission.title), text, feedbackLabels(submission.type, submission.priority))
                record(FeedbackLedgerEntry.SENT, issue)
                return FeedbackAnswer.Filed(issue.number, issue.url, duplicate = false)
            } catch (error: GitHubFeedbackError) {
                // A create that got a 5xx, no answer or an unreadable one may still land on GitHub's side.
                // No connection made at all can have landed nothing.
                val landing = creating && !error.offline && (error.status == 0 || error.status >= 500 || error.status in 200..299)
                record(FeedbackLedgerEntry.FAILED, settleUntil = if (landing) now() + SETTLE_MS else null)
                // No network: the outbox waits for it, uncounted (A803); the next try looks first.
                if (error.offline) throw IOException(error.message)
                if (error.tokenRefused) {
                    val message = if (error.status == 401) GitHubTokenMessages.INVALID else GitHubTokenMessages.cannotFile(config.repoName)
                    return refusal(424, TOKEN_CANNOT_FILE, message)
                }
                if (!error.retryable) return refusal(424, "github_refused", error.message.orEmpty())
                val wait = maxOf(error.retryAfter ?: 0, if (landing) SETTLE_MS / 1000 else 0)
                return refusal(503, "github_failed", "${error.message}; it will be sent again", wait.takeIf { it > 0 })
            }
        } finally {
            running.remove(id)
        }
    }

    /** A file's first 12 bytes, for its signature. */
    private fun headOf(file: java.io.File): ByteArray = file.inputStream().use { input ->
        val head = ByteArray(12)
        var read = 0
        while (read < head.size) {
            val n = input.read(head, read, head.size - read)
            if (n < 0) break
            read += n
        }
        head.copyOf(read)
    }

    private fun refusal(status: Int, code: String, message: String, retryAfterS: Long? = null) =
        FeedbackAnswer.Refused(status, code, message, retryAfterS?.let { it * 1000 })

    companion object {
        /** How long each GitHub call may take. */
        const val TIMEOUT_S = 20L

        /** No token on the phone: the report waits, queued, until one is saved (A1012). */
        const val NO_TOKEN = "no_token"
        const val IN_PROGRESS = "in_progress"
        const val TOKEN_CANNOT_FILE = "token_cannot_file"

        /** GitHub's limit on an issue body. */
        const val BODY_MAX = 65_536

        /** The longest address an attachment is given, for checking the body's length before uploads. */
        val LONGEST_ASSET_URL = "https://github.com/user-attachments/assets/${"0".repeat(36)}"

        /** After a create that may have landed, a retry waits this long (core's FEEDBACK_SETTLE_MS). */
        const val SETTLE_MS = 60_000L

        /** How far before a submission's first attempt the lookup starts. */
        const val LOOKUP_SLACK_MS = 10 * 60_000L
    }
}
