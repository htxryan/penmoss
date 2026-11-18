package app.penmoss.git.firstrun

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Browsing GitHub for the first run (A1404, A1405; the Mac's `github-browse.ts`, T81, A1164): the
 * repositories a token reaches, one repository's folders with the notebooks in them, the owners a
 * new repository can go under, and making an empty private repository. The token goes only to
 * [api], and a redirect is never followed with it.
 */
class GitHubBrowse(private val http: BrowseHttp, api: String = GITHUB_API) {
    private val api = api.trimEnd('/')

    private fun headers(token: String) = mapOf(
        "Accept" to "application/vnd.github+json",
        "Authorization" to "Bearer $token",
        "X-GitHub-Api-Version" to "2022-11-28",
        "User-Agent" to "Penmoss",
    )

    private sealed interface Call {
        data class Ok(val response: BrowseResponse) : Call
        data class Failed(val status: Int, val error: BrowseError) : Call
    }

    private suspend fun call(url: String, token: String, method: String = "GET", body: JsonObject? = null): Call {
        // A Link header naming another host is never followed with the token.
        if (!url.startsWith("$api/")) return Call.Failed(0, BrowseError(BrowseReason.GITHUB, "GitHub answered with another host."))
        val response = try {
            http.call(method, url, headers(token), body?.toString())
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            return Call.Failed(0, BrowseError(BrowseReason.OFFLINE, "Can’t reach GitHub. Check the connection, or paste an address."))
        }
        if (response.status in 200..299) return Call.Ok(response)
        val said = messageOf(response.body)
        val status = response.status
        val limited = (status == 403 || status == 429) &&
            (response.header("x-ratelimit-remaining") == "0" || said?.contains("rate limit", ignoreCase = true) == true)
        val error = when {
            limited -> BrowseError(BrowseReason.RATE_LIMITED, "GitHub is limiting requests for now. Try again in a few minutes, or paste an address.")
            status == 401 -> BrowseError(BrowseReason.UNAUTHORIZED, "GitHub refused the sign-in Penmoss has for it.")
            status == 403 -> BrowseError(BrowseReason.FORBIDDEN, said?.let { "GitHub refused: $it" } ?: "GitHub refused.")
            status == 404 -> BrowseError(BrowseReason.NOT_FOUND, "GitHub has no such repository, or it is not shown to this sign-in.")
            status == 422 && said?.contains("already exists", ignoreCase = true) == true ->
                BrowseError(BrowseReason.EXISTS, "A repository of that name is there already.")
            status == 422 -> BrowseError(BrowseReason.INVALID, said?.let { "GitHub refused: $it" } ?: "GitHub refused the name.")
            else -> BrowseError(BrowseReason.GITHUB, "GitHub answered $status${said?.let { ": $it" }.orEmpty()}.")
        }
        return Call.Failed(status, error)
    }

    /** The repositories the token reaches, most recently pushed first, at most [MAX_REPOS]. */
    suspend fun repos(token: String): BrowseResult<RepoList> {
        val repos = mutableListOf<GitHubRepo>()
        var url: String? = "$api/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=$PAGE"
        var pages = 0
        while (url != null && pages < MAX_REPOS / PAGE) {
            val answer = call(url, token)
            if (answer is Call.Failed) return BrowseResult.Failed(answer.error)
            answer as Call.Ok
            val body = parse(answer.response.body) as? JsonArray
                ?: return BrowseResult.Failed(BrowseError(BrowseReason.GITHUB, "GitHub sent a list Penmoss cannot read."))
            body.forEach { raw -> (raw as? JsonObject)?.let(::repoOf)?.let(repos::add) }
            pages += 1
            url = nextLink(answer.response.header("link"))
        }
        return BrowseResult.Ok(RepoList(repos.take(MAX_REPOS), more = url != null))
    }

    /**
     * One repository's branches, the default first and then by name, at most [MAX_BRANCHES]: Pick
     * Branch lists them, since a branch can hold other folders (A1621).
     */
    suspend fun branches(token: String, fullName: String, defaultBranch: String): BrowseResult<List<String>> {
        val parts = fullName.split('/')
        if (parts.size != 2 || !ownerOk(parts[0]) || !repoNameOk(parts[1])) {
            return BrowseResult.Failed(BrowseError(BrowseReason.INVALID, "That is not a GitHub repository name."))
        }
        val names = mutableListOf<String>()
        var url: String? = "$api/repos/${parts[0]}/${parts[1]}/branches?per_page=$PAGE"
        var pages = 0
        while (url != null && pages < MAX_BRANCHES / PAGE) {
            val answer = call(url, token)
            if (answer is Call.Failed) return BrowseResult.Failed(answer.error)
            answer as Call.Ok
            val body = parse(answer.response.body) as? JsonArray
                ?: return BrowseResult.Failed(BrowseError(BrowseReason.GITHUB, "GitHub sent a list Penmoss cannot read."))
            body.forEach { raw -> (raw as? JsonObject)?.text("name")?.takeIf { it.isNotEmpty() }?.let(names::add) }
            pages += 1
            url = nextLink(answer.response.header("link"))
        }
        val sorted = names.distinct().sortedWith(compareBy<String> { it != defaultBranch }.thenBy { it.lowercase() })
        return BrowseResult.Ok(sorted)
    }

    /**
     * One repository's folders at [branch]: the root first, without dot-folders or the subfolders
     * of a folder holding a notebook, each with the notebook it holds.
     */
    suspend fun folders(token: String, fullName: String, branch: String): BrowseResult<RepoFolders> {
        val parts = fullName.split('/')
        if (parts.size != 2 || !ownerOk(parts[0]) || !repoNameOk(parts[1])) {
            return BrowseResult.Failed(BrowseError(BrowseReason.INVALID, "That is not a GitHub repository name."))
        }
        if (!branchNameOk(branch)) return BrowseResult.Failed(BrowseError(BrowseReason.INVALID, "“$branch” is not a branch name git takes."))
        val base = "$api/repos/${parts[0]}/${parts[1]}"
        val answer = call("$base/git/trees/${java.net.URLEncoder.encode(branch, "UTF-8")}?recursive=1", token)
        if (answer is Call.Failed) {
            // An empty repository has no tree yet; a missing branch of one that has commits is a 404.
            if (answer.status == 409) return BrowseResult.Ok(RepoFolders(empty = true, truncated = false, folders = listOf(RepoFolder("", null))))
            return BrowseResult.Failed(answer.error)
        }
        answer as Call.Ok
        val body = parse(answer.response.body) as? JsonObject
        val entries = (body?.get("tree") as? JsonArray).orEmpty()
        val dirs = sortedSetOf<String>()
        val notebookBlobs = linkedMapOf<String, String>()
        for (entry in entries) {
            val item = entry as? JsonObject ?: continue
            val path = item.text("path") ?: continue
            val type = item.text("type")
            if (type == "tree") dirs += path
            if (type == "blob" && (path == NOTEBOOK_JSON || path.endsWith("/$NOTEBOOK_JSON"))) {
                val sha = item.text("sha") ?: continue
                notebookBlobs[path.removeSuffix(NOTEBOOK_JSON).trimEnd('/')] = sha
            }
        }
        val notebooks = linkedMapOf<String, FolderNotebook>()
        for ((folder, sha) in notebookBlobs.entries.take(MAX_NOTEBOOKS)) {
            val blob = call("$base/git/blobs/$sha", token) as? Call.Ok ?: continue
            runCatching {
                val content = (parse(blob.response.body) as JsonObject).text("content").orEmpty()
                val decoded = String(java.util.Base64.getMimeDecoder().decode(content), Charsets.UTF_8)
                val parsed = parse(decoded) as JsonObject
                val id = parsed.text("id")
                if (id != null) notebooks[folder] = FolderNotebook(id, parsed.text("name")?.ifEmpty { null } ?: "Notebook")
            }
            // A notebook.json Penmoss cannot read is listed as a plain folder.
        }
        fun hidden(path: String) = path.split('/').any { it.startsWith('.') } ||
            notebooks.keys.any { folder -> folder.isEmpty() || path.startsWith("$folder/") }
        val folders = mutableListOf(RepoFolder("", notebooks[""]))
        for (path in dirs) if (!hidden(path)) folders += RepoFolder(path, notebooks[path])
        return BrowseResult.Ok(RepoFolders(empty = false, truncated = (body?.get("truncated") as? JsonPrimitive)?.booleanOrNull == true, folders = folders))
    }

    /** The owners a new repository can go under: the account, then its organisations. */
    suspend fun owners(token: String): BrowseResult<List<GitHubOwner>> {
        val me = call("$api/user", token)
        if (me is Call.Failed) return BrowseResult.Failed(me.error)
        val login = (parse((me as Call.Ok).response.body) as? JsonObject)?.text("login")
            ?: return BrowseResult.Failed(BrowseError(BrowseReason.GITHUB, "GitHub did not say who is signed in."))
        val owners = mutableListOf(GitHubOwner(login, org = false))
        val orgs = call("$api/user/orgs?per_page=100", token)
        if (orgs is Call.Ok) {
            (parse(orgs.response.body) as? JsonArray)?.forEach { org ->
                (org as? JsonObject)?.text("login")?.let { owners += GitHubOwner(it, org = true) }
            }
        }
        return BrowseResult.Ok(owners)
    }

    /** Makes an empty private repository under [owner] (the account's own, or an organisation's). */
    suspend fun createRepo(token: String, owner: GitHubOwner, name: String): BrowseResult<GitHubRepo> {
        if (!ownerOk(owner.login)) return BrowseResult.Failed(BrowseError(BrowseReason.INVALID, "That is not a GitHub account or organisation."))
        if (!repoNameOk(name)) {
            return BrowseResult.Failed(BrowseError(BrowseReason.INVALID, "Use letters, digits, hyphens, dots and underscores for the repository name."))
        }
        val url = if (owner.org) "$api/orgs/${owner.login}/repos" else "$api/user/repos"
        val body = buildJsonObject {
            put("name", name)
            put("private", true)
            put("auto_init", false)
            put("description", "Notes kept by Penmoss")
        }
        val answer = call(url, token, "POST", body)
        if (answer is Call.Failed) return BrowseResult.Failed(answer.error)
        val repo = (parse((answer as Call.Ok).response.body) as? JsonObject)?.let(::repoOf)
            ?: return BrowseResult.Failed(BrowseError(BrowseReason.GITHUB, "GitHub made the repository but did not say where."))
        return BrowseResult.Ok(repo.copy(canPush = true, empty = true))
    }

    companion object {
        const val GITHUB_API = "https://api.github.com"

        /** At most this many repositories load (D62: 3 pages of 100). */
        const val MAX_REPOS = 300
        const val MAX_BRANCHES = 300
        private const val PAGE = 100

        /** The notebook names read from one tree. */
        private const val MAX_NOTEBOOKS = 20
        private const val NOTEBOOK_JSON = ".penmoss/notebook.json"

        private val OWNER = Regex("^[A-Za-z0-9][A-Za-z0-9-]{0,38}$")
        private val REPO = Regex("^[A-Za-z0-9._-]{1,100}$")

        fun ownerOk(owner: String) = OWNER.matches(owner)

        fun repoNameOk(name: String) = REPO.matches(name) && name != "." && name != ".." && !name.endsWith(".git")

        /** A branch name git takes (the rules of `git check-ref-format --branch`). */
        fun branchNameOk(branch: String): Boolean {
            if (branch.isEmpty() || branch.length > 200) return false
            if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false
            if (branch.endsWith('.') || branch.endsWith(".lock") || branch == "@") return false
            if (Regex("""\.\.|//|@\{|/\.|^\.""").containsMatchIn(branch)) return false
            if (branch.any { it.code <= 0x20 || it.code == 0x7f || it in "~^:?*[\\" }) return false
            return branch.split('/').none { it.endsWith(".lock") }
        }

        /** The `rel="next"` address of a Link header, or null. */
        internal fun nextLink(link: String?): String? {
            if (link == null) return null
            for (part in link.split(',')) {
                Regex("""<([^>]+)>\s*;\s*rel="next"""").find(part)?.let { return it.groupValues[1] }
            }
            return null
        }

        private fun parse(text: String): JsonElement? = runCatching { Json.parseToJsonElement(text) }.getOrNull()

        private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun messageOf(body: String): String? {
            val json = parse(body) as? JsonObject ?: return null
            val first = (json["errors"] as? JsonArray)?.firstNotNullOfOrNull { (it as? JsonObject)?.text("message") }
            return first ?: json.text("message")
        }

        private fun repoOf(raw: JsonObject): GitHubRepo? {
            val fullName = raw.text("full_name") ?: return null
            val name = raw.text("name") ?: return null
            val owner = (raw["owner"] as? JsonObject)?.text("login") ?: return null
            val cloneUrl = raw.text("clone_url") ?: return null
            val isPrivate = (raw["private"] as? JsonPrimitive)?.booleanOrNull
            val visibility = when {
                raw.text("visibility") == "internal" -> RepoVisibility.INTERNAL
                raw.text("visibility") == "public" || isPrivate == false -> RepoVisibility.PUBLIC
                else -> RepoVisibility.PRIVATE
            }
            val permissions = raw["permissions"] as? JsonObject
            fun flag(key: String) = (permissions?.get(key) as? JsonPrimitive)?.booleanOrNull == true
            return GitHubRepo(
                fullName = fullName,
                owner = owner,
                name = name,
                visibility = visibility,
                defaultBranch = raw.text("default_branch")?.ifEmpty { null } ?: "main",
                cloneUrl = cloneUrl,
                pushedAt = raw.text("pushed_at"),
                canPush = flag("push") || flag("admin"),
                empty = (raw["size"] as? JsonPrimitive)?.longOrNull == 0L,
            )
        }
    }
}

/** A call to GitHub's API: the method, address, headers and JSON body; never follows a redirect. */
fun interface BrowseHttp {
    suspend fun call(method: String, url: String, headers: Map<String, String>, body: String?): BrowseResponse
}

/** GitHub's answer: its status, headers (names in lower case) and body. */
data class BrowseResponse(val status: Int, val headers: Map<String, String>, val body: String) {
    fun header(name: String): String? = headers[name.lowercase()]
}

/** [BrowseHttp] over OkHttp, with redirects off so the token never goes anywhere else. */
fun okHttpBrowse(http: OkHttpClient): BrowseHttp {
    val client = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
    return BrowseHttp { method, url, headers, body ->
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(url).apply {
                headers.forEach { (key, value) -> header(key, value) }
                if (body != null) method(method, body.toRequestBody(JSON)) else method(method, null)
            }.build()
            client.newCall(request).execute().use { response ->
                BrowseResponse(
                    response.code,
                    response.headers.names().associate { it.lowercase() to (response.header(it) ?: "") },
                    response.body.string(),
                )
            }
        }
    }
}

private val JSON = "application/json; charset=utf-8".toMediaType()

enum class RepoVisibility(val words: String) { PRIVATE("Private"), PUBLIC("Public"), INTERNAL("Internal") }

/** A repository the token reaches. */
data class GitHubRepo(
    /** `owner/name`. */
    val fullName: String,
    val owner: String,
    val name: String,
    val visibility: RepoVisibility,
    val defaultBranch: String,
    /** The HTTPS clone address. */
    val cloneUrl: String,
    /** When it was last pushed (ISO), or null for never. */
    val pushedAt: String?,
    /** The account can push to it; a read-only one can't hold a notebook. */
    val canPush: Boolean,
    /** GitHub's size is 0: probably empty (only a hint, for ordering). */
    val empty: Boolean,
)

data class RepoList(val repos: List<GitHubRepo>, val more: Boolean)

/** The notebook a folder holds: its `notebook.json` id and name. */
data class FolderNotebook(val id: String, val name: String)

/** A folder of a repository: `""` is its root. */
data class RepoFolder(val path: String, val notebook: FolderNotebook?)

data class RepoFolders(
    /** The branch has no commit yet (GitHub answers 409). */
    val empty: Boolean,
    /** GitHub left some of the tree out: not every folder is listed. */
    val truncated: Boolean,
    /** The root first, then the rest in path order. */
    val folders: List<RepoFolder>,
)

data class GitHubOwner(val login: String, val org: Boolean)

enum class BrowseReason { UNAUTHORIZED, FORBIDDEN, RATE_LIMITED, NOT_FOUND, INVALID, EXISTS, OFFLINE, GITHUB }

data class BrowseError(val reason: BrowseReason, val message: String)

sealed interface BrowseResult<out T> {
    data class Ok<T>(val value: T) : BrowseResult<T>
    data class Failed(val error: BrowseError) : BrowseResult<Nothing>
}
