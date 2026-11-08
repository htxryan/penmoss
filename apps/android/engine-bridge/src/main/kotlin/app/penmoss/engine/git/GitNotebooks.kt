package app.penmoss.engine.git

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.io.File
import java.security.SecureRandom

/** One note the phone's owner confirmed deleting for good, and when (epoch ms). */
@Serializable
data class PurgeConfirmation(val id: String, val at: Long)

/** What `git-notebooks.json` keeps of each notebook on this phone (A856): never a secret. */
@Serializable
data class GitNotebookEntry(
    /** This phone's own id for the clone (its folder); not the notebook's. */
    val localId: String,
    /** The notebook's id (`.penmoss/notebook.json`): its engine store and Room database. */
    val notebookId: String,
    val name: String,
    /** This phone makes the notebook: the target held none when it was added. */
    val create: Boolean = false,
    val remote: String,
    val branch: String = "main",
    /** '' or a directory such as `docs/notes` (no slashes at the ends). */
    val dir: String = "",
    /** A1013: push 12 s after edits settle and pull every minute while the app is visible. */
    val pushDelayS: Int = GitCadence.PUSH_DELAY_S,
    val pullEveryMin: Int = GitCadence.PULL_EVERY_MIN,
    /** Background syncs only on an unmetered network (G8). */
    val wifiOnly: Boolean = false,
    /** The user name sent with a token (github.com needs none). */
    val tokenUser: String? = null,
    val added: Long = 0,
    // A registry from before D51 may hold `confirmed`, a sealed confirmation that the repository
    // is private: it is read past (ignoreUnknownKeys) and gone from the next write (A1090).
    /** Notes the owner confirmed deleting for good whose purge has not landed yet (A855). */
    val purges: List<PurgeConfirmation> = emptyList(),
    /**
     * Copies withheld from the push the owner confirmed keeping and syncing (A886), each bound to
     * its copy and spent once its push lands: only these may a commit add although their original
     * is deleted for good at head.
     */
    val keeps: List<PurgeConfirmation> = emptyList(),
    /** Every commit from this phone is signed with its key (#172, A921), or none is made. */
    val signCommits: Boolean = false,
    /** This notebook's own commit name and email (#170 F6), over Commits from this phone's. */
    val authorName: String? = null,
    val authorEmail: String? = null,
)

@Serializable
private data class Registry(
    /** A registry with none is from before version 2. */
    val version: Int = 1,
    val notebooks: List<GitNotebookEntry> = emptyList())

/**
 * The sync cadence (A1013): git notebooks push 12 s after edits settle and pull every minute while
 * the app is visible, as on the Mac. Notebooks still on the old defaults (60 s and 2 min, A825)
 * move to the new ones once, when the registry is first read in version 2; a notebook set to
 * anything else keeps its values.
 */
object GitCadence {
    const val PUSH_DELAY_S = 12
    const val PULL_EVERY_MIN = 1

    /** The defaults before A1013. */
    const val OLD_PUSH_DELAY_S = 60
    const val OLD_PULL_EVERY_MIN = 2

    /** Version 2: the cadence migrated (A1013). */
    const val REGISTRY_VERSION = 2

    /** An entry of a registry before version 2, with the old defaults moved to the new. */
    fun migrated(entry: GitNotebookEntry): GitNotebookEntry =
        if (entry.pushDelayS == OLD_PUSH_DELAY_S && entry.pullEveryMin == OLD_PULL_EVERY_MIN) {
            entry.copy(pushDelayS = PUSH_DELAY_S, pullEveryMin = PULL_EVERY_MIN)
        } else {
            entry
        }
}

/** What Settings shows of a notebook: never its token. */
data class GitNotebookView(
    val localId: String,
    val notebookId: String,
    val name: String,
    val create: Boolean,
    val remote: String,
    /** `github.com/owner/repo`, or a path on this phone. */
    val repository: String,
    val host: String,
    val branch: String,
    val dir: String,
    val pushDelayS: Int,
    val pullEveryMin: Int,
    val wifiOnly: Boolean,
    val hasToken: Boolean,
    /** Sign commits (#172, A921). */
    val signCommits: Boolean = false,
    /** This notebook's own commit identity (#170 F6), or null for Commits from this phone's. */
    val author: GitIdentity? = null,
)

/** A note a sync would delete for good, as Settings lists it before confirming again (A855). */
data class PendingPurge(val id: String, val title: String, val confirmedBefore: Boolean)

/** A refusal from the phone's own checks (or git's), shown as it is: a code and plain words. */
class GitRefusal(val code: String, message: String, val hostMessage: String? = null) : Exception(message)

/** Seals with the Keystore's key (`KeystoreSecretBox`); null when it cannot (nothing is kept then). */
interface SecretSeal {
    fun seal(plain: String): String?

    fun unseal(sealed: String): String?
}

sealed interface OwnerAnswer {
    data object Confirmed : OwnerAnswer

    data class Refused(val message: String) : OwnerAnswer
}

/**
 * The phone's owner check (A855): BiometricPrompt with the screen lock allowed, over the app's
 * own screen, with these words, which are Kotlin's own. Never an agent, an intent or a page.
 */
fun interface OwnerConfirm {
    suspend fun confirm(words: String): OwnerAnswer

    /**
     * As [confirm], for a request that may be withdrawn while the person is asked (A887):
     * [live] is checked again right before the prompt shows, and a request no longer live is
     * never shown. The app's BiometricPrompt checks it as late as it can.
     */
    suspend fun confirm(words: String, live: () -> Boolean): OwnerAnswer =
        if (live()) confirm(words) else OwnerAnswer.Refused(OwnerAsks.WITHDRAWN)
}

/** What a commit deletes for good, as the guard page reads it from the head (A876). */
data class CommitPurges(
    val added: List<String>,
    val stray: List<String>,
    val shrunk: List<String>,
    val reversed: List<String>,
    val raced: List<String> = emptyList(),
    /** Commits whose undo mark (`agentUndone`) the commit adds, changes or removes (#174 delta review). */
    val undoneMarks: List<String> = emptyList(),
)

/** The `Penmoss-Writer` trailer's kind (`device` or `agent`), as `commitWriter` reads it; null without one. */
internal fun commitWriterKind(message: String): String? =
    Regex("^Penmoss-Writer: [0-9A-Z]{26} \\((device|agent) \"[^\"]*\"\\)$", RegexOption.MULTILINE).find(message)?.groupValues?.get(1)

/** The commit check (A876): the guard page, which reads the head through [GitNotebooks.headList] and [GitNotebooks.headRead]. */
interface GitGuard {
    suspend fun commitPurges(localId: String, root: String, head: String?, changes: Map<String, ByteArray?>): CommitPurges

    suspend fun purgedAt(localId: String, root: String, head: String?): Set<String>

    suspend fun titles(localId: String, root: String, head: String?, ids: List<String>): Map<String, String>
}

sealed interface AddResult {
    data class Added(val notebook: GitNotebookView, val created: Boolean) : AddResult

    data object NeedsName : AddResult
}

/**
 * Git notebooks on this phone (T50 G7, A856, A876): the registry, the secrets and the commit
 * checks, as the Mac's main process keeps them (`apps/desktop/src/git-notebooks.ts`), for the
 * engine pages, which it trusts no more than the Mac trusts its page:
 *
 * - nobody is asked whether the repository is private (D61);
 * - the clone refuses a config rewrite before any credential is handed over (`JGitTransport`);
 * - a commit may delete a note for good only when this phone's owner confirmed that note in the
 *   last 10 minutes, never takes back a landed purge, and never shrinks a log (the guard, A876);
 * - the token and the writer's secret are sealed with the Keystore; nothing secret is in plain text.
 */
class GitNotebooks(
    private val dir: File,
    private val seal: SecretSeal,
    private val owner: OwnerConfirm,
    private val guard: GitGuard,
    /** Who commits from this phone (Settings → Git notebooks; A825). */
    private val identity: () -> GitIdentity,
    private val now: () -> Long = System::currentTimeMillis,
    private val timeoutSeconds: Int = 30,
    private val maxStoreBytes: Long = 20L * 1024 * 1024,
    /** This phone's commit-signing key (#172, A921); null where none can be kept. */
    private val signingKeys: CommitKeyStore? = null,
) {
    private val registryFile = File(dir, "git-notebooks.json")
    private val secretsFile = File(dir, "git-secrets.json")
    private val changes = Mutex()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
    private val transports = java.util.concurrent.ConcurrentHashMap<String, JGitTransport>()
    /** Commits made with confirmed purges in them, until their push lands. */
    private val commitPurges = java.util.concurrent.ConcurrentHashMap<String, List<String>>()
    /** Per notebook: purges a commit this phone let through carried, until they land (no TTL then). */
    private val approvedPurges = java.util.concurrent.ConcurrentHashMap<String, MutableSet<String>>()
    /** Commits made with confirmed copies in them (A886), until their push lands. */
    private val commitKeeps = java.util.concurrent.ConcurrentHashMap<String, List<String>>()
    /** Per notebook: confirmed copies a commit this phone let through carried, until they land. */
    private val approvedKeeps = java.util.concurrent.ConcurrentHashMap<String, MutableSet<String>>()
    /** Per notebook: what the last refused commit would have deleted for good unconfirmed. */
    private val refusedPurges = java.util.concurrent.ConcurrentHashMap<String, List<String>>()
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    init {
        JGitSetup.install(File(dir, "jgit"))
        migrateCadence()
    }

    /**
     * A registry written before version 2 is written again in version 2, its old default cadences
     * moved to the new ones (A1013), so a notebook set to 60 s and 2 min later keeps them.
     */
    private fun migrateCadence() {
        val text = runCatching { registryFile.readText() }.getOrNull() ?: return
        val version = runCatching { json.decodeFromString(Registry.serializer(), text).version }.getOrNull() ?: return
        if (version >= GitCadence.REGISTRY_VERSION) return
        runCatching { writeAtomic(registryFile, json.encodeToString(Registry.serializer(), readRegistry())) }
    }

    /** Told when the list changes, so Settings reads it again. */
    fun onChange(listener: () -> Unit) {
        listeners += listener
    }

    private fun changed() = listeners.forEach { runCatching { it() } }

    fun cloneDir(localId: String): File = File(dir, "git/$localId")

    // --- the registry and the secrets, written whole and renamed over ---

    private fun readRegistry(): Registry = try {
        val parsed = json.decodeFromString(Registry.serializer(), registryFile.readText())
        // Before version 2, the old default cadence is the new one (A1013).
        val notebooks = if (parsed.version < GitCadence.REGISTRY_VERSION) parsed.notebooks.map(GitCadence::migrated) else parsed.notebooks
        Registry(GitCadence.REGISTRY_VERSION, notebooks.filter { LOCAL_ID.matches(it.localId) && NOTEBOOK_ID.matches(it.notebookId) && it.purges.all { p -> NOTE_ID.matches(p.id) } && it.keeps.all { k -> NOTE_ID.matches(k.id) } })
    } catch (error: Exception) {
        Registry(GitCadence.REGISTRY_VERSION)
    }

    private fun writeAtomic(file: File, text: String) {
        dir.mkdirs()
        val temporary = File(dir, "${file.name}.${System.nanoTime()}.tmp")
        temporary.writeText(text)
        if (!temporary.renameTo(file)) {
            temporary.delete()
            throw GitRefusal("storage", "Penmoss could not save the git notebooks on this phone.")
        }
    }

    private suspend fun change(edit: (Registry) -> Registry) = changes.withLock {
        writeAtomic(registryFile, json.encodeToString(Registry.serializer(), edit(readRegistry())))
        changed()
    }

    private fun readSecrets(): Map<String, String> = try {
        (Json.parseToJsonElement(secretsFile.readText()) as JsonObject).mapNotNull { (key, value) -> value.text()?.let { key to it } }.toMap()
    } catch (error: Exception) {
        emptyMap()
    }

    private fun secret(key: String): String? = readSecrets()[key]?.let { runCatching { seal.unseal(it) }.getOrNull() }

    private suspend fun setSecret(key: String, plain: String?): Boolean = changes.withLock {
        val secrets = readSecrets().toMutableMap()
        if (plain == null) {
            secrets.remove(key)
        } else {
            secrets[key] = seal.seal(plain) ?: return@withLock false
        }
        writeAtomic(secretsFile, JsonObject(secrets.mapValues { JsonPrimitive(it.value) }).toString())
        true
    }

    private fun token(entry: GitNotebookEntry): String? = secret("token:${entry.localId}")

    fun entry(localId: String): GitNotebookEntry? =
        if (!LOCAL_ID.matches(localId)) null else readRegistry().notebooks.firstOrNull { it.localId == localId }

    fun entries(): List<GitNotebookEntry> = readRegistry().notebooks

    fun list(): List<GitNotebookView> {
        val secrets = readSecrets()
        return readRegistry().notebooks.map { view(it, "token:${it.localId}" in secrets) }
    }

    private fun view(entry: GitNotebookEntry, hasToken: Boolean): GitNotebookView = GitNotebookView(
        localId = entry.localId,
        notebookId = entry.notebookId,
        name = entry.name,
        create = entry.create,
        remote = GitRemotes.redact(entry.remote),
        repository = GitRemotes.repositoryName(entry.remote),
        host = GitRemotes.hostOf(entry.remote) ?: "this phone",
        branch = entry.branch,
        dir = entry.dir,
        pushDelayS = entry.pushDelayS,
        pullEveryMin = entry.pullEveryMin,
        wifiOnly = entry.wifiOnly,
        signCommits = entry.signCommits,
        author = entry.authorEmail?.let { GitIdentity(entry.authorName ?: identity().name, it) },
        hasToken = hasToken,
    )

    /** Before any call that can reach the host: a remote with a credential in it is refused. */
    private fun checkRemote(entry: GitNotebookEntry) {
        val parts = GitRemotes.parts(entry.remote)
        if (parts == null || parts.credentials) throw GitRefusal("remote_credentials", "The remote has a user name or password in it.")
    }

    /**
     * Asks the owner. With [request] (the app's own request the page asked for this in, A877):
     * its time does not run while the person is asked, and the answer counts only if the request
     * still waits for it (A887): one that ran out meanwhile was withdrawn, and the app has said
     * nothing happened, so nothing does.
     */
    private suspend fun ask(words: String, request: OwnerAsks.Ask? = null) {
        // A request that ran out while its titles were read is never shown a prompt (A887).
        if (request != null && !request.live) throw withdrawn()
        request?.prompt(true)
        val answer = try {
            if (request == null) owner.confirm(words) else owner.confirm(words) { request.live }
        } finally {
            request?.prompt(false)
        }
        if (request != null && answer is OwnerAnswer.Refused && !request.live && !request.committed) throw withdrawn()
        when (answer) {
            OwnerAnswer.Confirmed -> if (request != null && !request.commit()) throw withdrawn()
            is OwnerAnswer.Refused -> throw GitRefusal("not_confirmed", answer.message)
        }
    }

    private fun withdrawn() = GitRefusal("timeout", "The request ran out before you confirmed, so nothing was done. Try again.")

    // --- add and remove (A856) ---

    /**
     * Add: any repository, with nobody asked whether it is private (D51, D61). Joins the notebook
     * the target holds, or makes one when it holds none and a name is given.
     */
    suspend fun add(remoteInput: String, branchInput: String?, dirInput: String?, nameInput: String?, tokenInput: String? = null): AddResult {
        val remote = remoteInput.trim()
        if (GitRemotes.isSsh(remote)) throw GitRefusal("ssh_unsupported", "Android syncs over HTTPS only: give the https:// address of the repository and a personal access token.")
        val parts = GitRemotes.parts(remote) ?: throw GitRefusal("invalid_remote", "That is not a git remote: give an https:// URL.")
        if (parts.credentials) throw GitRefusal("remote_credentials", "The remote has a user name or password in it. Give the remote without it, and the token in its own field.")
        if (parts.protocol == GitRemotes.Protocol.HTTP) throw GitRefusal("insecure_remote", "Use the https:// address: a token is never sent over plain http.")
        val branch = branchInput?.trim()?.ifEmpty { null } ?: "main"
        if (!GitRemotes.branchOk(branch)) throw GitRefusal("invalid_branch", "“$branch” is not a branch name git takes.")
        val dirName = GitRemotes.cleanDir(dirInput) ?: throw GitRefusal("invalid_dir", "The directory must be a path inside the repository, such as docs/notes.")
        val name = nameInput?.trim()?.take(MAX_NAME)?.ifEmpty { null }
        val token = tokenInput?.trim()?.ifEmpty { null }
        if (token != null && !SECRET.matches(token)) throw GitRefusal("invalid_token", "That does not look like a token.")
        val registry = readRegistry()
        if (registry.notebooks.any { it.remote == remote && it.branch == branch && it.dir == dirName }) {
            throw GitRefusal("notebook_exists", "This notebook is on this phone already.")
        }
        val localId = newLocalId()
        val root = GitRemotes.rootOf(dirName)
        val clone = cloneDir(localId)
        val transport = JGitTransport(
            File(clone, "repo.git"), remote, branch, root,
            author = identity,
            credentials = { token?.let { GitCredentials(it) } },
            timeoutSeconds = timeoutSeconds,
            maxStoreBytes = maxStoreBytes,
        )
        try {
            val head = withContext(Dispatchers.IO) { transport.fetch() }
            val info = head?.let { withContext(Dispatchers.IO) { transport.read(it, listOf("$root.penmoss/notebook.json")) }["$root.penmoss/notebook.json"] }
            val notebookId: String
            val notebookName: String
            var create = false
            if (info != null) {
                val parsed = runCatching { Json.parseToJsonElement(info.toString(Charsets.UTF_8)) as JsonObject }.getOrNull()
                    ?: throw GitRefusal("git", "The target holds a notebook.json Penmoss cannot read.")
                val id = parsed["id"].text()
                if (id == null || !NOTEBOOK_ID.matches(id)) throw GitRefusal("git", "The target holds a notebook.json Penmoss cannot read.")
                notebookId = id
                notebookName = parsed["name"].text()?.take(MAX_NAME)?.ifEmpty { null } ?: "Notebook"
            } else {
                if (name == null) {
                    transport.close()
                    clone.deleteRecursively()
                    return AddResult.NeedsName
                }
                notebookId = newLocalId()
                notebookName = name
                create = true
            }
            if (registry.notebooks.any { it.notebookId == notebookId }) {
                transport.close()
                clone.deleteRecursively()
                throw GitRefusal("notebook_exists", "The notebook “$notebookName” is on this phone already.")
            }
            val entry = GitNotebookEntry(
                localId = localId,
                notebookId = notebookId,
                name = notebookName,
                create = create,
                remote = remote,
                branch = branch,
                dir = dirName,
                added = now(),
            )
            if (token != null && !setSecret("token:$localId", token)) {
                transport.close()
                clone.deleteRecursively()
                throw GitRefusal("no_keystore", "Penmoss could not keep the token: the Keystore is not available.")
            }
            change { current -> current.copy(notebooks = current.notebooks + entry) }
            // Its git opens again from the registry and the Keystore (transportFor), never with
            // the token typed here held on: a new token in Settings is the one used.
            transport.close()
            return AddResult.Added(view(entry, token != null), create)
        } catch (error: GitException) {
            transport.close()
            clone.deleteRecursively()
            throw GitRefusal(error.code.wire, error.message ?: error.code.wire, error.hostMessage)
        } catch (error: GitRefusal) {
            // Not added: nothing of it stays on the phone.
            if (entry(localId) == null) {
                transport.close()
                clone.deleteRecursively()
            }
            throw error
        }
    }

    /**
     * Remove (A856): the owner check first, naming the repository (never the notebook's name, which
     * the repository sets) and saying how many changes are lost; then the clone and its secrets go.
     * [unpushed] null: the phone cannot tell, and the words say changes may be lost.
     */
    suspend fun remove(localId: String, unpushed: Int?, oldCopies: Int = 0): String {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        // Room's copies from before Android cleared the store (A886), never brought back yet.
        val old = when {
            oldCopies <= 0 -> ""
            oldCopies == 1 -> "1 note from before its storage was cleared"
            else -> "$oldCopies notes from before its storage was cleared"
        }
        val lost = when {
            unpushed == null -> " and lose any changes not pushed yet" + (if (old.isEmpty()) "" else " and $old")
            unpushed == 0 && old.isEmpty() -> ""
            unpushed == 0 -> " and lose $old"
            unpushed == 1 -> " and lose 1 change never pushed" + (if (old.isEmpty()) "" else " and $old")
            else -> " and lose $unpushed changes never pushed" + (if (old.isEmpty()) "" else " and $old")
        }
        ask(OwnerWords.fit("remove the git notebook at ", GitRemotes.repositoryWords(entry.remote), " from this phone$lost"))
        change { registry -> registry.copy(notebooks = registry.notebooks.filterNot { it.localId == entry.localId }) }
        transports.remove(entry.localId)?.let { it.cancel(); it.close() }
        withContext(Dispatchers.IO) { cloneDir(entry.localId).deleteRecursively() }
        setSecret("token:${entry.localId}", null)
        setSecret("writer:${entry.localId}", null)
        return entry.notebookId
    }

    /** Cadence, Wi-Fi only and the token's user name, per notebook on this phone (A825, G8). */
    suspend fun update(localId: String, pushDelayS: Int? = null, pullEveryMin: Int? = null, wifiOnly: Boolean? = null, tokenUser: String? = null, clearTokenUser: Boolean = false): GitNotebookView {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (pushDelayS != null && pushDelayS !in 5..3600) throw GitRefusal("invalid_request", "Push after: 5 seconds to an hour.")
        if (pullEveryMin != null && pullEveryMin !in 1..1440) throw GitRefusal("invalid_request", "Pull every: 1 minute to a day.")
        if (tokenUser != null && !TOKEN_USER.matches(tokenUser)) throw GitRefusal("invalid_request", "A token user name is letters, digits, ., _ and -.")
        val next = entry.copy(
            pushDelayS = pushDelayS ?: entry.pushDelayS,
            pullEveryMin = pullEveryMin ?: entry.pullEveryMin,
            wifiOnly = wifiOnly ?: entry.wifiOnly,
            tokenUser = if (clearTokenUser) null else tokenUser ?: entry.tokenUser,
        )
        change { registry -> registry.copy(notebooks = registry.notebooks.map { if (it.localId == localId) next else it }) }
        if (tokenUser != null || clearTokenUser) transports.remove(localId)?.close()
        return view(next, "token:$localId" in readSecrets())
    }

    /**
     * Sign commits, per notebook (#172, A921). Turned on, this phone's key is made first if it
     * has none; from then on each commit is signed with it, or the sync stops.
     */
    suspend fun setSignCommits(localId: String, on: Boolean): GitNotebookView {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (on) {
            val keys = signingKeys ?: throw GitRefusal("signing", "Sync stopped: signing. This phone cannot keep a signing key.")
            withContext(Dispatchers.IO) { keys.key() ?: keys.create() }
        }
        val next = entry.copy(signCommits = on)
        change { registry -> registry.copy(notebooks = registry.notebooks.map { if (it.localId == localId) next else it }) }
        return view(next, "token:$localId" in readSecrets())
    }

    /**
     * This notebook's own commit name and email (#170 F6), over Commits from this phone's: a
     * GitHub no-reply address when the account keeps its email private (GH007). Null for both
     * goes back to the phone's.
     */
    suspend fun setAuthor(localId: String, name: String?, email: String?): GitNotebookView {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        val cleanName = name?.trim()?.ifEmpty { null }
        val cleanEmail = email?.trim()?.ifEmpty { null }
        // Plain text only (#174 review): no NUL, control, bidi or other format character, as the
        // Mac and the CLI (`@penmoss/git-notebook/identity`).
        if (cleanName != null && (cleanName.length > 200 || invisible(cleanName) || cleanName.any { it == '<' || it == '>' })) {
            throw GitRefusal("invalid_request", "A commit name is one line of plain text, without < or >.")
        }
        if (cleanEmail != null && (cleanEmail.length > 254 || invisible(cleanEmail) || !COMMIT_EMAIL.matches(cleanEmail))) {
            throw GitRefusal("invalid_request", "A commit email is an email address, such as 1234+you@users.noreply.github.com.")
        }
        if (cleanName != null && cleanEmail == null) throw GitRefusal("invalid_request", "Give the email with the name.")
        val next = entry.copy(authorName = cleanName, authorEmail = cleanEmail)
        change { registry -> registry.copy(notebooks = registry.notebooks.map { if (it.localId == localId) next else it }) }
        return view(next, "token:$localId" in readSecrets())
    }

    /** Who commits a notebook's next commit (#170 F3, F6): its own identity, or the phone's now. */
    private fun authorOf(localId: String): GitIdentity {
        val entry = entry(localId)
        val email = entry?.authorEmail ?: return identity()
        return GitIdentity(entry.authorName ?: identity().name, email)
    }

    /** The public half of this phone's signing key, for GitHub's signing keys; null when none was made. */
    fun signingKeyLine(comment: String): String? = signingKeys?.key()?.let { SshCommitSigner(it).publicKeyLine(comment) }

    /** Settings → Git notebooks → token (A857): written only, never read back; null forgets it. */
    suspend fun setToken(localId: String, token: String?) {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        val clean = token?.trim()
        if (clean != null && !SECRET.matches(clean)) throw GitRefusal("invalid_token", "That does not look like a token.")
        if (!setSecret("token:${entry.localId}", clean)) throw GitRefusal("no_keystore", "Penmoss could not keep the token: the Keystore is not available.")
        transports.remove(entry.localId)?.close()
        changed()
    }

    /** The writer's secret (A821), for the engine page: read, or kept once made. */
    fun writerSecret(localId: String): String? = entry(localId)?.let { secret("writer:${it.localId}") }

    suspend fun setWriterSecret(localId: String, value: String) {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (!WRITER_SECRET.matches(value)) throw GitRefusal("invalid_request", "Not a writer secret.")
        // Without the Keystore the writer is new at every start (A821 keeps that safe).
        setSecret("writer:${entry.localId}", value)
    }

    // --- Delete for good and History's restore (A855, A877) ---

    /**
     * Delete for good of one note: the owner check, in the phone's own words, naming the note as
     * the branch has it (never as the page says). Only a commit that deletes for good a note
     * confirmed here gets through [op]; the confirmation goes once its push lands.
     */
    suspend fun confirmPurge(localId: String, noteId: String, request: OwnerAsks.Ask? = null) {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (!NOTE_ID.matches(noteId)) throw GitRefusal("invalid_request", "Not a note id.")
        val transport = transportFor(entry)
        val root = GitRemotes.rootOf(entry.dir)
        val head = withContext(Dispatchers.IO) { transport.head() }
        val title = guard.titles(localId, root, head, listOf(noteId))[noteId]
        ask(
            OwnerWords.fit(
                "delete 1 note for good (git history keeps it) in the git notebook at ",
                GitRemotes.repositoryWords(entry.remote),
                ": ${OwnerWords.note(noteId, title)}",
            ),
            request,
        )
        record(entry.localId, listOf(noteId))
    }

    /**
     * Confirming again (a confirmation ran out before its sync): only notes this phone confirmed
     * once already, whose confirmation ran out, and not deleted on the branch yet. A note never
     * confirmed here is refused, never confirmed with the person: Keep note is its way out.
     */
    suspend fun confirmPurgesAgain(localId: String, noteIds: List<String>) {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (noteIds.isEmpty() || noteIds.size > MAX_PURGES || !noteIds.all { NOTE_ID.matches(it) }) throw GitRefusal("invalid_request", "Not a note id.")
        val transport = transportFor(entry)
        val root = GitRemotes.rootOf(entry.dir)
        val head = withContext(Dispatchers.IO) { transport.head() }
        val landed = guard.purgedAt(localId, root, head)
        var wanted = noteIds.distinct().filterNot { it in landed }
        val held = entry.purges.associate { it.id to it.at }
        val never = wanted.filterNot { it in held }
        if (never.isNotEmpty()) {
            throw GitRefusal(
                "never_confirmed",
                "${if (never.size == 1) "A note" else "${never.size} notes"} here ${if (never.size == 1) "was" else "were"} never confirmed for Delete for good on this phone, so none was confirmed again and the sync stays stopped. Keep the note, or delete it for good again.",
            )
        }
        val approved = approvedPurges[localId].orEmpty()
        wanted = wanted.filter { now() - held.getValue(it) >= PURGE_TTL_MS && it !in approved }
        if (wanted.isEmpty()) return
        val count = if (wanted.size == 1) "1 note" else "${wanted.size} notes"
        ask(
            OwnerWords.fit(
                "delete $count for good, confirmed once already on this phone (git history keeps ${if (wanted.size == 1) "it" else "them"}), in the git notebook at ",
                GitRemotes.repositoryWords(entry.remote),
                "",
            ),
        )
        record(entry.localId, wanted)
    }

    private suspend fun record(localId: String, ids: List<String>) {
        val at = now()
        change { registry ->
            registry.copy(
                notebooks = registry.notebooks.map { each ->
                    if (each.localId != localId) each else each.copy(purges = (each.purges.filterNot { it.id in ids } + ids.map { PurgeConfirmation(it, at) }).takeLast(MAX_PURGES))
                },
            )
        }
    }

    /**
     * What "Confirm Delete for good" in Settings would confirm again (A855), named from the branch:
     * what the last refused sync would have deleted, and confirmations here that ran out, not
     * deleted on the branch yet. `confirmedBefore` false: never confirmed here (Keep note only).
     */
    suspend fun purgesToConfirm(localId: String, also: List<String> = emptyList()): List<PendingPurge> {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (also.size > MAX_PURGES || !also.all { NOTE_ID.matches(it) }) throw GitRefusal("invalid_request", "Not a note id.")
        val approved = approvedPurges[localId].orEmpty()
        val held = entry.purges.associate { it.id to it.at }
        val needs = { id: String -> id !in held || (now() - held.getValue(id) >= PURGE_TTL_MS && id !in approved) }
        val ids = ((refusedPurges[localId].orEmpty() + held.keys).distinct().filter(needs) + also).distinct()
        if (ids.isEmpty()) return emptyList()
        val transport = transportFor(entry)
        val root = GitRemotes.rootOf(entry.dir)
        val head = withContext(Dispatchers.IO) { transport.head() }
        val landed = guard.purgedAt(localId, root, head)
        val left = ids.filterNot { it in landed }
        val titles = guard.titles(localId, root, head, left)
        return left.map { PendingPurge(it, titles[it] ?: "", it in held) }
    }

    /**
     * Keep and sync of a copy withheld from the push (A886): the owner check, in the phone's own
     * words, naming the copy as this phone keeps it (it was never on the branch). Only a commit
     * adding a copy confirmed here gets through [op] although its original is deleted for good at
     * head; the confirmation is bound to that copy and spent once its push lands.
     */
    suspend fun confirmKeepCopy(localId: String, noteId: String, title: String) {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (!NOTE_ID.matches(noteId)) throw GitRefusal("invalid_request", "Not a note id.")
        ask(
            OwnerWords.fit(
                "push a copy kept on this phone, of a note deleted for good on another device, as a new note to ",
                GitRemotes.repositoryWords(entry.remote),
                ": ${OwnerWords.note(noteId, title)}",
            ),
        )
        val at = now()
        change { registry ->
            registry.copy(
                notebooks = registry.notebooks.map { each ->
                    if (each.localId != localId) each else each.copy(keeps = (each.keeps.filterNot { it.id == noteId } + PurgeConfirmation(noteId, at)).takeLast(MAX_PURGES))
                },
            )
        }
    }

    /**
     * Delete for good of a copy withheld from the push (A886): the owner check, as for a note's
     * Delete for good, naming the copy. It was never pushed, so git has nothing of it to keep.
     */
    suspend fun confirmDropCopy(localId: String, noteId: String, title: String) {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (!NOTE_ID.matches(noteId)) throw GitRefusal("invalid_request", "Not a note id.")
        ask(
            OwnerWords.fit(
                "delete for good a copy kept on this phone only (never pushed, so git has none of it), of ",
                GitRemotes.repositoryWords(entry.remote),
                ": ${OwnerWords.note(noteId, title)}",
            ),
        )
    }

    /** History's restore or revert (A877): the owner check, naming the note from the branch. */
    suspend fun confirmRestore(localId: String, noteId: String, revert: Boolean, request: OwnerAsks.Ask? = null) {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (!NOTE_ID.matches(noteId)) throw GitRefusal("invalid_request", "Not a note id.")
        val transport = transportFor(entry)
        val head = withContext(Dispatchers.IO) { transport.head() }
        val title = guard.titles(localId, GitRemotes.rootOf(entry.dir), head, listOf(noteId))[noteId]
        val what = if (revert) "undo an earlier change (the note as it is now is saved as a version first)" else "restore an earlier version (the note as it is now is saved as a version first)"
        ask(OwnerWords.fit("$what in the git notebook at ", GitRemotes.repositoryWords(entry.remote), ": ${OwnerWords.note(noteId, title)}"), request)
    }

    // --- the engine page's git (A836, A876) ---

    private fun transportFor(entry: GitNotebookEntry): JGitTransport = transports.getOrPut(entry.localId) {
        JGitTransport(
            File(cloneDir(entry.localId), "repo.git"),
            entry.remote,
            entry.branch,
            GitRemotes.rootOf(entry.dir),
            author = { authorOf(entry.localId) },
            credentials = {
                val current = entry(entry.localId)
                current?.let { token(it) }?.let { GitCredentials(it, current.tokenUser ?: GitCredentials.DEFAULT_TOKEN_USER) }
            },
            timeoutSeconds = timeoutSeconds,
            maxStoreBytes = maxStoreBytes,
            // Read at each commit: turned on, a commit is signed with this phone's key or not made.
            signing = {
                if (entry(entry.localId)?.signCommits != true) {
                    CommitSigning.Off
                } else {
                    CommitSigning.On {
                        val key = signingKeys?.key() ?: error("this phone has no signing key; make one in Settings → Git notebooks")
                        SshCommitSigner(key)
                    }
                }
            },
        )
    }

    /** Stops the git a notebook runs now, and what waits (A859: Sync now while one hangs; a stopped sync). */
    fun cancel(localId: String) {
        transports[localId]?.cancel()
    }

    /** The guard page's view of the head: the list of files, read here (A876). */
    suspend fun headList(localId: String, head: String): Map<String, String> {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        return withContext(Dispatchers.IO) { transportFor(entry).list(sha(head)) }
    }

    suspend fun headRead(localId: String, head: String, paths: List<String>): Map<String, ByteArray> {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        return withContext(Dispatchers.IO) { transportFor(entry).read(sha(head), paths) }
    }

    /**
     * One transport call for a notebook's engine page. Calls that can reach the host are checked
     * private first; arguments are checked here, never trusted from the page.
     */
    suspend fun op(localId: String, op: String, call: GitCall, reply: FrameBuilder): JsonElement {
        val entry = entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
        if (op !in OPS) throw GitRefusal("invalid_request", "Unknown git call.")
        if (op in NETWORK_OPS) checkRemote(entry)
        val transport = transportFor(entry)
        val args = call.args as? JsonArray ?: JsonArray(emptyList())
        return withContext(Dispatchers.IO) { run(entry, transport, op, args, call, reply) }
    }

    private suspend fun run(entry: GitNotebookEntry, transport: JGitTransport, op: String, args: JsonArray, call: GitCall, reply: FrameBuilder): JsonElement =
        when (op) {
            "fetch" -> transport.fetch()?.let(::JsonPrimitive) ?: JsonNull
            "list" -> pairs(transport.list(sha(args.getOrNull(0))).map { (path, blob) -> path to JsonPrimitive(blob) })
            "sizes" -> pairs(transport.sizes(sha(args.getOrNull(0)), paths(args.getOrNull(1))).map { (path, size) -> path to JsonPrimitive(size) })
            "changed" -> transport.changed(sha(args.getOrNull(0)), sha(args.getOrNull(1)))?.let { list -> JsonArray(list.map(::JsonPrimitive)) } ?: JsonNull
            "read" -> pairs(transport.read(sha(args.getOrNull(0)), paths(args.getOrNull(1))).map { (path, bytes) -> path to reply.blob(bytes) })
            "commit" -> commit(entry, transport, args, call)
            "push" -> push(entry, transport, sha(args.getOrNull(0)))
            "log" -> {
                val options = args.getOrNull(0) as? JsonObject
                val wanted = options?.get("paths")?.let(::paths)
                val limit = (options?.get("limit") as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 }?.coerceAtMost(10_000)
                JsonArray(
                    transport.log(wanted, limit).map { commit ->
                        JsonObject(
                            mapOf(
                                "id" to JsonPrimitive(commit.id),
                                "parents" to JsonArray(commit.parents.map(::JsonPrimitive)),
                                "author" to JsonObject(mapOf("name" to JsonPrimitive(commit.authorName), "email" to JsonPrimitive(commit.authorEmail))),
                                "at" to JsonPrimitive(commit.at),
                                "message" to JsonPrimitive(commit.message),
                            ),
                        )
                    },
                )
            }
            "readAt" -> transport.readAt(sha(args.getOrNull(0)), paths(JsonArray(listOfNotNull(args.getOrNull(1)))).single())?.let(reply::blob) ?: JsonNull
            "maintain" -> {
                transport.maintain()
                JsonNull
            }
            else -> throw GitRefusal("invalid_request", "Unknown git call.")
        }

    private suspend fun commit(entry: GitNotebookEntry, transport: JGitTransport, args: JsonArray, call: GitCall): JsonElement {
        val head = args.getOrNull(0)?.takeUnless { it is JsonNull }?.let(::sha)
        val raw = args.getOrNull(1) as? JsonArray ?: throw GitException(GitErrorCode.GIT, "Not a list of changes.")
        val changes = linkedMapOf<String, ByteArray?>()
        for (item in raw) {
            val pair = item as? JsonArray ?: throw GitException(GitErrorCode.GIT, "Not a change.")
            val path = pair.getOrNull(0).text()?.takeIf { it.length <= 4096 } ?: throw GitException(GitErrorCode.GIT, "Not a change.")
            val value = pair.getOrNull(1)
            changes[path] = if (value == null || value is JsonNull) null else call.bytes(value) ?: throw GitException(GitErrorCode.GIT, "Not file bytes.")
        }
        val message = args.getOrNull(2).text()?.take(10_000) ?: "Penmoss"
        // What the commit deletes for good, from the head as JGit reads it (A876).
        val purges = guard.commitPurges(entry.localId, GitRemotes.rootOf(entry.dir), head, changes)
        if (purges.reversed.isNotEmpty()) {
            val one = purges.reversed.size == 1
            throw GitRefusal(
                "purge_reversed",
                "This sync would take back ${if (one) "a note" else "${purges.reversed.size} notes"} already deleted for good in the repository, which would bring ${if (one) "it" else "them"} back from any device with an old copy, so nothing was pushed.",
            )
        }
        // A copy brought back after the store was cleared whose original another device deleted
        // for good at head (A886): the engine withholds one; it goes through only once the person
        // confirmed keeping and syncing that copy (Keep and sync), else it is refused.
        val current = entry(entry.localId) ?: entry
        val keptOk = approvedKeeps.getOrPut(entry.localId) { java.util.concurrent.ConcurrentHashMap.newKeySet() }
        val confirmedKeeps = current.keeps.filter { now() - it.at < PURGE_TTL_MS }.map { it.id }.toSet() + keptOk
        if (purges.raced.any { it !in confirmedKeeps }) {
            throw GitRefusal("purge_raced", "This sync would add a copy of a note already deleted for good in the repository, so nothing was pushed.")
        }
        // Only a person's writer marks an agent's change undone (#174 delta review).
        if (purges.undoneMarks.isNotEmpty() && commitWriterKind(message) == "agent") {
            throw GitRefusal(
                "agent_undone",
                "This sync would mark an agent’s change undone from an agent’s writer, but only you mark an agent’s change undone, so nothing was pushed.",
            )
        }
        if (purges.shrunk.isNotEmpty()) {
            throw GitRefusal("log_shrunk", "This sync would replace a log in the repository with less than it holds, which would wipe notes or folders without deleting them, so nothing was pushed.")
        }
        val approved = approvedPurges.getOrPut(entry.localId) { java.util.concurrent.ConcurrentHashMap.newKeySet() }
        val confirmed = current.purges.filter { now() - it.at < PURGE_TTL_MS }.map { it.id }.toSet() + approved
        val unconfirmed = purges.added.filterNot { it in confirmed } + purges.stray
        if (unconfirmed.isNotEmpty()) {
            refusedPurges[entry.localId] = unconfirmed
            changed()
            throw GitRefusal(
                "purge_unconfirmed",
                "This sync would delete ${if (unconfirmed.size == 1) "a note" else "${unconfirmed.size} notes"} for good that nobody confirmed on this phone in the last ${PURGE_TTL_MS / 60_000} minutes, so nothing was pushed. Confirm Delete for good again in Settings → Git notebooks, or keep the note.",
            )
        }
        refusedPurges.remove(entry.localId)
        val commit = transport.commit(head, changes, message)
        if (commit != null && purges.added.isNotEmpty()) {
            commitPurges[commit] = purges.added
            approved += purges.added
        }
        if (commit != null && purges.raced.isNotEmpty()) {
            commitKeeps[commit] = purges.raced
            keptOk += purges.raced
        }
        return commit?.let(::JsonPrimitive) ?: JsonNull
    }

    private suspend fun push(entry: GitNotebookEntry, transport: JGitTransport, commit: String): JsonElement {
        val outcome = transport.push(commit)
        val landed = commitPurges[commit]
        if (outcome == PushOutcome.PUSHED && landed != null) {
            // Those purges are on the branch: their confirmations are spent.
            commitPurges.remove(commit)
            approvedPurges[entry.localId]?.removeAll(landed.toSet())
            change { registry -> registry.copy(notebooks = registry.notebooks.map { if (it.localId == entry.localId) it.copy(purges = it.purges.filterNot { p -> p.id in landed }) else it }) }
        }
        val kept = commitKeeps[commit]
        if (outcome == PushOutcome.PUSHED && kept != null) {
            // Those copies are on the branch: their confirmations are spent (single use).
            commitKeeps.remove(commit)
            approvedKeeps[entry.localId]?.removeAll(kept.toSet())
            change { registry -> registry.copy(notebooks = registry.notebooks.map { if (it.localId == entry.localId) it.copy(keeps = it.keeps.filterNot { k -> k.id in kept }) else it }) }
        }
        return JsonPrimitive(outcome.wire)
    }

    /** How the clone stands, for Settings (its size; the head). */
    suspend fun storeBytes(localId: String): Long = entry(localId)?.let { withContext(Dispatchers.IO) { transportFor(it).storeBytes() } } ?: 0

    private fun newLocalId(): String {
        // A ULID: 48 bits of time, 80 of randomness, Crockford's base32.
        val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        val time = now()
        val out = StringBuilder()
        for (shift in 45 downTo 0 step 5) out.append(alphabet[((time shr shift) and 31).toInt()])
        val random = SecureRandom()
        repeat(16) { out.append(alphabet[random.nextInt(32)]) }
        return out.toString()
    }

    companion object {
        /** A Delete for good confirmed here counts this long for a first commit to carry it (A855). */
        const val PURGE_TTL_MS = 10 * 60_000L
        const val MAX_PURGES = 1000
        const val MAX_NAME = 80

        val OPS = setOf("fetch", "list", "sizes", "changed", "read", "commit", "push", "log", "readAt", "maintain")

        /** Ops that may reach the host (fetch, push, a deepening log; reads after a deepening). */
        val NETWORK_OPS = setOf("fetch", "push", "read", "sizes", "readAt", "log")

        private val SECRET = Regex("^[A-Za-z0-9_.~+/=-]{8,1000}$")
        private val TOKEN_USER = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
        private val COMMIT_EMAIL = Regex("^[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+$")

        /** Controls (NUL too), format characters (bidi among them), line and paragraph separators. */
        private fun invisible(text: String): Boolean = text.codePoints().anyMatch { code ->
            when (Character.getType(code).toByte()) {
                Character.CONTROL, Character.FORMAT, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR -> true
                else -> false
            }
        }
        private val LOCAL_ID = Regex("^[0-9A-HJKMNP-TV-Z]{26}$")
        private val NOTEBOOK_ID = Regex("^[0-9A-Z]{26}$")
        internal val NOTE_ID = Regex("^[0-9A-Z]{26}$")
        private val WRITER_SECRET = Regex("^[0-9a-f]{64}$")
        private val SHA = Regex("^[0-9a-f]{40}([0-9a-f]{24})?$")

        private fun sha(value: JsonElement?): String = sha(value.text())

        private fun sha(value: String?): String = value?.takeIf { SHA.matches(it) } ?: throw GitException(GitErrorCode.GIT, "Not a commit id.")

        private fun paths(value: JsonElement?): List<String> {
            val list = value as? JsonArray ?: throw GitException(GitErrorCode.GIT, "Not a list of paths.")
            if (list.size > 100_000) throw GitException(GitErrorCode.GIT, "Not a list of paths.")
            return list.map { it.text()?.takeIf { path -> path.length <= 4096 } ?: throw GitException(GitErrorCode.GIT, "Not a path.") }
        }

        private fun pairs(entries: List<Pair<String, JsonElement>>): JsonArray =
            JsonArray(entries.map { (key, value) -> JsonArray(listOf(JsonPrimitive(key), value)) })
    }
}
