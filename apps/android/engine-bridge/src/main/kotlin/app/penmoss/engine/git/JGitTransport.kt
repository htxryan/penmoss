package app.penmoss.engine.git

import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.errors.GitAPIException
import org.eclipse.jgit.api.errors.TransportException
import org.eclipse.jgit.dircache.DirCache
import org.eclipse.jgit.dircache.DirCacheEditor
import org.eclipse.jgit.dircache.DirCacheEntry
import org.eclipse.jgit.errors.MissingObjectException
import org.eclipse.jgit.errors.NoRemoteRepositoryException
import org.eclipse.jgit.internal.JGitText
import org.eclipse.jgit.lib.CommitBuilder
import org.eclipse.jgit.lib.GpgSignature
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.FileMode
import org.eclipse.jgit.lib.ObjectId
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.lib.ProgressMonitor
import org.eclipse.jgit.lib.RefUpdate
import org.eclipse.jgit.lib.Repository
import org.eclipse.jgit.revwalk.RevCommit
import org.eclipse.jgit.revwalk.RevWalk
import org.eclipse.jgit.storage.file.FileRepositoryBuilder
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.RemoteConfig
import org.eclipse.jgit.transport.RemoteRefUpdate
import org.eclipse.jgit.transport.TagOpt
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider
import org.eclipse.jgit.treewalk.TreeWalk
import org.eclipse.jgit.treewalk.filter.AndTreeFilter
import org.eclipse.jgit.treewalk.filter.PathFilter
import org.eclipse.jgit.treewalk.filter.PathFilterGroup
import org.eclipse.jgit.treewalk.filter.TreeFilter
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.text.MessageFormat
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.SSLException

/**
 * The engine's `GitTransport` over JGit (T50 G7, A824, A870): what Android's git notebooks sync
 * through. The engine page runs `@penmoss/git-notebook` and calls these operations over the
 * bridge; Kotlin only moves the files' bytes (A11).
 *
 * - **A bare clone with no working tree**, in the app's files. Commits are built in an in-core
 *   `DirCache` on the fetched remote head (A822, A837): no merge, no rebase, no checkout.
 * - **Shallow** (depth 1), deepened when History needs older commits (A824). JGit has no
 *   partial clone, so a directory target fetches the whole tree at head (A871).
 * - **HTTPS with a token** (or a `file://` repository on this phone, which a person confirms,
 *   A855). No SSH (A824). The remote is checked against the clone's config before every call
 *   that reaches the host, so a rewrite (`insteadOf`, `pushInsteadOf`, `pushurl`) is refused
 *   before the token is handed over; redirects are not followed.
 * - **Never JGit's gc** (it needs `ProcessHandle`): past [maxStoreBytes] the clone is thrown
 *   away and made again, shallow (G0 change 4).
 * - **Bounded:** every network call has [timeoutSeconds] per read and connect; [cancel] stops
 *   every call running or waiting now (A852), each failing as [GitErrorCode.TIMEOUT].
 */
class JGitTransport(
    /** The clone's git directory (`…/repo.git`), made on first use. */
    private val gitDir: File,
    /** The remote exactly as added: `https://host/owner/repo(.git)` or `file:///path`. */
    private val remote: String,
    private val branch: String,
    /** '' or a directory ending in `/` (`docs/notes/`). */
    val root: String,
    private val author: () -> GitIdentity,
    private val credentials: () -> GitCredentials?,
    private val timeoutSeconds: Int = 30,
    private val maxStoreBytes: Long = 20L * 1024 * 1024,
    private val clock: () -> Long = System::currentTimeMillis,
    /** Whether this notebook's commits are signed, read at each commit (#172, A921). */
    private val signing: () -> CommitSigning = { CommitSigning.Off },
) {
    init {
        require(root.isEmpty() || (root.endsWith("/") && !root.startsWith("/"))) { "root must be '' or end in /: $root" }
    }

    private val trackingRef = "refs/remotes/origin/$branch"
    private val branchRef = "${Constants.R_HEADS}$branch"
    private var repository: Repository? = null
    private var listed: Pair<String, Map<String, String>>? = null
    private val lock = Any()

    /** Raised by [cancel]: a call that started (or was asked for) under an older value stops. */
    private val generation = AtomicLong(0)

    /** Stops every call running or waiting now (A852): each fails as a timeout. Later calls run. */
    fun cancel() {
        generation.incrementAndGet()
    }

    private fun <T> exclusive(work: (Long) -> T): T {
        val asked = generation.get()
        synchronized(lock) {
            if (generation.get() != asked) throw stopped()
            return work(asked)
        }
    }

    private fun stopped() = GitException(GitErrorCode.TIMEOUT, "The sync was stopped: it ran out of time.")

    private fun monitor(asked: Long) = object : ProgressMonitor {
        override fun start(totalTasks: Int) = Unit
        override fun beginTask(title: String?, totalWork: Int) = Unit
        override fun update(completed: Int) = Unit
        override fun endTask() = Unit
        override fun showDuration(enabled: Boolean) = Unit
        override fun isCancelled(): Boolean = generation.get() != asked
    }

    /** The clone, made (bare, with Penmoss's config) when it is not there. */
    private fun repo(): Repository {
        repository?.let { return it }
        val made = FileRepositoryBuilder().setGitDir(gitDir).setBare().build()
        if (!File(gitDir, "HEAD").isFile) {
            gitDir.mkdirs()
            made.create(true)
        }
        made.config.apply {
            setString("remote", "origin", "url", remote)
            setString("remote", "origin", "fetch", "+$branchRef:$trackingRef")
            setString("remote", "origin", "tagOpt", "--no-tags")
            // Never JGit's gc (G0: it needs ProcessHandle); the clone is made again instead.
            setInt("gc", null, "auto", 0)
            setBoolean("gc", null, "autoDetach", false)
            setBoolean("core", null, "logAllRefUpdates", false)
            // Only the repository shown private: a redirect never takes the token elsewhere.
            setString("http", null, "followRedirects", "false")
            save()
        }
        repository = made
        return made
    }

    /**
     * Refuses unless git would fetch from and push to exactly the remote shown private (A855): a
     * rewrite in the clone's config (`url.<base>.insteadOf`, `pushInsteadOf`, `remote.origin.pushurl`)
     * is refused before any credential is handed over. Remotes are compared as exact strings.
     */
    private fun ensureTarget(repo: Repository) {
        val config = repo.config
        val url = config.getString("remote", "origin", "url")
        val pushUrls = config.getStringList("remote", "origin", "pushurl").toList()
        val rewrites = config.getSubsections("url").filter { base ->
            config.getStringList("url", base, "insteadOf").isNotEmpty() || config.getStringList("url", base, "pushInsteadOf").isNotEmpty()
        }
        val parsed = RemoteConfig(config, "origin")
        val fetchTo = parsed.urIs.map { it.toPrivateString() }
        val pushTo = parsed.pushURIs.map { it.toPrivateString() }
        val fine = url == remote && pushUrls.isEmpty() && rewrites.isEmpty() &&
            fetchTo == listOf(remote) && (pushTo.isEmpty() || pushTo == listOf(remote))
        if (!fine) {
            val where = (pushTo.ifEmpty { fetchTo }).firstOrNull()?.let(GitRemotes::redact) ?: "another URL"
            throw GitException(
                GitErrorCode.REDIRECTED,
                "This clone's git configuration would send the notebook's fetches or pushes to $where, not to " +
                    "${GitRemotes.redact(remote)}, the repository shown private. Nothing was sent.",
            )
        }
    }

    private fun credentialsProvider(): UsernamePasswordCredentialsProvider? =
        credentials()?.let { UsernamePasswordCredentialsProvider(it.user, it.token) }

    /** Fetches the branch, shallow; its head, or null while the branch does not exist. */
    fun fetch(): String? = exclusive { asked ->
        val repo = repo()
        ensureTarget(repo)
        try {
            Git.wrap(repo).fetch()
                .setRemote("origin")
                .setRefSpecs(RefSpec("+$branchRef:$trackingRef"))
                .setTagOpt(TagOpt.NO_TAGS)
                .setDepth(depth(repo))
                .setCredentialsProvider(credentialsProvider())
                .setTimeout(timeoutSeconds)
                .setProgressMonitor(monitor(asked))
                .call()
        } catch (error: Throwable) {
            if (missingBranch(error)) {
                // A new notebook on a new branch, or one deleted on the host.
                repo.exactRef(trackingRef)?.let { forceDelete(repo, trackingRef) }
                listed = null
                return@exclusive null
            }
            throw classify(error, asked)
        }
        repo.exactRef(trackingRef)?.objectId?.name
    }

    /** How deep fetches go: 1 until History asks for more (A824). */
    private fun depth(repo: Repository): Int = repo.config.getInt("penmoss", null, "depth", 1).coerceAtLeast(1)

    private fun missingBranch(error: Throwable): Boolean {
        val expected = MessageFormat.format(JGitText.get().remoteDoesNotHaveSpec, branchRef)
        var cause: Throwable? = error
        while (cause != null) {
            if (cause.message?.contains(expected) == true) return true
            cause = cause.cause
        }
        return false
    }

    private fun forceDelete(repo: Repository, ref: String) {
        val update = repo.updateRef(ref)
        update.setForceUpdate(true)
        update.delete()
    }

    private fun commitOf(repo: Repository, sha: String): RevCommit {
        val id = parseSha(sha)
        RevWalk(repo).use { walk ->
            return try {
                walk.parseCommit(id)
            } catch (error: MissingObjectException) {
                throw GitException(GitErrorCode.GIT, "This clone does not have commit ${sha.take(7)}.", cause = error)
            }
        }
    }

    /** Every file under [root] at [head]: path → blob id. */
    fun list(head: String): Map<String, String> = exclusive { listLocked(head) }

    private fun listLocked(head: String): Map<String, String> {
        listed?.let { (at, files) -> if (at == head) return files }
        val repo = repo()
        val commit = commitOf(repo, head)
        val files = LinkedHashMap<String, String>()
        TreeWalk(repo).use { walk ->
            walk.addTree(commit.tree)
            walk.isRecursive = true
            if (root.isNotEmpty()) walk.filter = PathFilter.create(root.removeSuffix("/"))
            while (walk.next()) {
                if (walk.fileMode.objectType == Constants.OBJ_BLOB) files[walk.pathString] = walk.getObjectId(0).name
            }
        }
        listed = head to files
        return files
    }

    /** The sizes of [paths] at [head], so the engine never loads a huge log (A822). */
    fun sizes(head: String, paths: List<String>): Map<String, Long> = exclusive {
        val files = listLocked(head)
        val out = LinkedHashMap<String, Long>()
        repo().newObjectReader().use { reader ->
            for (path in paths) {
                val id = files[path] ?: continue
                out[path] = reader.getObjectSize(ObjectId.fromString(id), Constants.OBJ_BLOB)
            }
        }
        out
    }

    /** Paths under [root] that differ between two commits; null when [from] is not in this clone. */
    fun changed(from: String, to: String): List<String>? = exclusive {
        val repo = repo()
        val older = try {
            commitOf(repo, from)
        } catch (error: GitException) {
            return@exclusive null
        }
        val newer = commitOf(repo, to)
        val out = mutableListOf<String>()
        TreeWalk(repo).use { walk ->
            walk.addTree(older.tree)
            walk.addTree(newer.tree)
            walk.isRecursive = true
            walk.filter = if (root.isEmpty()) TreeFilter.ANY_DIFF else AndTreeFilter.create(PathFilter.create(root.removeSuffix("/")), TreeFilter.ANY_DIFF)
            while (walk.next()) out += walk.pathString
        }
        out.sorted()
    }

    /** The bytes of [paths] at [head] (a path not there is left out). */
    fun read(head: String, paths: List<String>): Map<String, ByteArray> = exclusive {
        val files = listLocked(head)
        readBlobs(paths.mapNotNull { path -> files[path]?.let { path to it } })
    }

    private fun readBlobs(wanted: List<Pair<String, String>>): Map<String, ByteArray> {
        val out = LinkedHashMap<String, ByteArray>()
        repo().newObjectReader().use { reader ->
            for ((path, id) in wanted) {
                out[path] = reader.open(ObjectId.fromString(id), Constants.OBJ_BLOB).getCachedBytes(MAX_BLOB_BYTES)
            }
        }
        return out
    }

    /**
     * A commit on [head] (null: the branch's first) setting each path to its bytes or removing
     * it (null); null when the tree would not change. Every path must be under [root]. Built in
     * an in-core index: nothing is checked out, merged or rebased (A822).
     */
    fun commit(head: String?, changes: Map<String, ByteArray?>, message: String): String? = exclusive {
        for (path in changes.keys) checkPath(path)
        val repo = repo()
        repo.newObjectInserter().use { inserter ->
            val parent = head?.let { commitOf(repo, it) }
            val index = if (parent == null) {
                DirCache.newInCore()
            } else {
                repo.newObjectReader().use { reader -> DirCache.read(reader, parent.tree) }
            }
            val editor = index.editor()
            for ((path, bytes) in changes) {
                if (bytes == null) {
                    editor.add(DirCacheEditor.DeletePath(path))
                } else {
                    val blob = inserter.insert(Constants.OBJ_BLOB, bytes)
                    editor.add(object : DirCacheEditor.PathEdit(path) {
                        override fun apply(entry: DirCacheEntry) {
                            entry.fileMode = FileMode.REGULAR_FILE
                            entry.setObjectId(blob)
                        }
                    })
                }
            }
            editor.finish()
            val tree = index.writeTree(inserter)
            if (parent != null && parent.tree.id == tree) return@exclusive null
            val who = author()
            val at = PersonIdent(who.name, who.email, Instant.ofEpochMilli(clock()), java.time.ZoneOffset.UTC)
            val built = CommitBuilder().apply {
                setAuthor(at)
                committer = at
                if (parent != null) setParentId(parent)
                setTreeId(tree)
                this.message = message
            }
            when (val wanted = signing()) {
                CommitSigning.Off -> Unit
                // Fails closed: with signing on, a commit is signed, or none is made.
                is CommitSigning.On -> built.gpgSignature = GpgSignature(signed(wanted, built.build()))
            }
            val id = inserter.insert(built)
            inserter.flush()
            id.name
        }
    }

    /** The commit's SSH signature, checked against the key before it is used (#172, A921). */
    private fun signed(wanted: CommitSigning.On, commit: ByteArray): ByteArray {
        val armored = try {
            val signer = wanted.signer()
            signer.sign(commit).also { if (!signer.verifies(commit, it)) error("the signature does not verify") }
        } catch (error: Exception) {
            throw GitException(
                GitErrorCode.SIGNING,
                "Sync stopped: signing. This phone could not sign the commit (${error.message ?: "no key"}), " +
                    "so nothing was committed; turn Sign commits off, or make a new key, in Settings → Git notebooks.",
                cause = error,
            )
        }
        return armored.toByteArray(Charsets.US_ASCII)
    }

    private fun checkPath(path: String) {
        val parts = path.split('/')
        val bad = !path.startsWith(root) || path.length > 4096 || path.contains('\u0000') ||
            parts.any { it.isEmpty() || it == "." || it == ".." || it.equals(".git", ignoreCase = true) }
        if (bad) throw GitException(GitErrorCode.GIT, "Refusing to write outside ${root.ifEmpty { "/" }}: $path")
    }

    /** Makes [commit] the branch's head if that is a fast-forward; rejected when it is not. */
    fun push(commit: String): PushOutcome = exclusive { asked ->
        val repo = repo()
        ensureTarget(repo)
        val results = try {
            Git.wrap(repo).push()
                .setRemote("origin")
                .setRefSpecs(RefSpec("$commit:$branchRef"))
                .setCredentialsProvider(credentialsProvider())
                .setTimeout(timeoutSeconds)
                .setProgressMonitor(monitor(asked))
                .call()
                .toList()
        } catch (error: Throwable) {
            throw classify(error, asked)
        }
        val update = results.firstNotNullOfOrNull { it.getRemoteUpdate(branchRef) }
            ?: throw GitException(GitErrorCode.GIT, "The host gave no answer for the push.")
        val said = results.joinToString("\n") { it.messages.orEmpty() }.lines()
            .map { it.removePrefix("remote:").trim() }.filter { it.isNotEmpty() }.joinToString("\n").ifEmpty { null }
        when (update.status) {
            RemoteRefUpdate.Status.OK, RemoteRefUpdate.Status.UP_TO_DATE -> {
                // The remote-tracking ref follows, so History and the next sync see the commit at once.
                val ref = repo.updateRef(trackingRef)
                ref.setNewObjectId(ObjectId.fromString(commit))
                ref.setForceUpdate(true)
                val done = ref.update()
                if (done == RefUpdate.Result.LOCK_FAILURE || done == RefUpdate.Result.IO_FAILURE) {
                    throw GitException(GitErrorCode.GIT, "Pushed, but this clone could not record it ($done).")
                }
                PushOutcome.PUSHED
            }
            RemoteRefUpdate.Status.REJECTED_NONFASTFORWARD, RemoteRefUpdate.Status.REJECTED_REMOTE_CHANGED -> PushOutcome.REJECTED
            else -> throw refusedPush(update, said)
        }
    }

    private fun refusedPush(update: RemoteRefUpdate, said: String?): GitException {
        val words = listOfNotNull(update.message, said).joinToString("\n").ifEmpty { null }
        val text = words.orEmpty().lowercase()
        val code = when {
            "protected branch" in text || "gh006" in text -> GitErrorCode.PROTECTED
            "gh013" in text || "repository rule" in text || "push rule" in text || "secret" in text -> GitErrorCode.RULES
            else -> GitErrorCode.REFUSED
        }
        return GitException(code, "The host refused the push (${update.status.name.lowercase()}).", hostMessage = words)
    }

    /**
     * The commits that touched [paths] (all of [root] when null), newest first, at most [limit].
     * A shallow clone deepens until it has that many or the whole history (A824): a commit at the
     * shallow edge looks like a root and is never listed until its parent is here.
     */
    fun log(paths: List<String>?, limit: Int?): List<GitCommitInfo> = exclusive { asked ->
        val wanted = (limit ?: Int.MAX_VALUE).coerceAtLeast(1)
        var found = emptyList<GitCommitInfo>()
        for (attempt in 0..4) {
            val repo = repo()
            val head = repo.exactRef(trackingRef)?.objectId ?: return@exclusive emptyList()
            val (commits, complete) = walkLog(repo, head, paths, wanted)
            found = commits
            if (complete || commits.size >= wanted || attempt == 4) break
            deepen(repo, asked, attempt)
        }
        found
    }

    private fun walkLog(repo: Repository, head: ObjectId, paths: List<String>?, limit: Int): Pair<List<GitCommitInfo>, Boolean> {
        val filters = (paths ?: listOf(root).filter { it.isNotEmpty() }).map { it.removeSuffix("/") }.filter { it.isNotEmpty() }
        val shallow = repo.objectDatabase.shallowCommits
        val out = mutableListOf<GitCommitInfo>()
        var reachedEdge = false
        RevWalk(repo).use { walk ->
            if (filters.isNotEmpty()) walk.setTreeFilter(AndTreeFilter.create(PathFilterGroup.createFromStrings(filters), TreeFilter.ANY_DIFF))
            walk.markStart(walk.parseCommit(head))
            for (commit in walk) {
                if (commit.id in shallow) {
                    reachedEdge = true
                    break
                }
                out += GitCommitInfo(
                    id = commit.name,
                    parents = commit.parents.map { it.name },
                    authorName = commit.authorIdent.name,
                    authorEmail = commit.authorIdent.emailAddress,
                    at = commit.authorIdent.whenAsInstant.toEpochMilli(),
                    message = commit.fullMessage.trimEnd(),
                )
                if (out.size >= limit) break
            }
        }
        // A path filter can skip the edge commit itself: any shallow edge means older history is missing.
        val complete = !reachedEdge && shallow.isEmpty()
        return out to complete
    }

    /** Fetches more of the history: 50, 500, 5,000 commits deep, then all of it. */
    private fun deepen(repo: Repository, asked: Long, attempt: Int) {
        ensureTarget(repo)
        val depth = when (attempt) {
            0 -> 50
            1 -> 500
            2 -> 5_000
            else -> 0
        }
        try {
            val fetch = Git.wrap(repo).fetch()
                .setRemote("origin")
                .setRefSpecs(RefSpec("+$branchRef:$trackingRef"))
                .setTagOpt(TagOpt.NO_TAGS)
                .setCredentialsProvider(credentialsProvider())
                .setTimeout(timeoutSeconds)
                .setProgressMonitor(monitor(asked))
            if (depth > 0) fetch.setDepth(depth) else fetch.setUnshallow(true)
            fetch.call()
        } catch (error: Throwable) {
            throw classify(error, asked)
        }
        repo.config.apply {
            setInt("penmoss", null, "depth", if (depth > 0) depth else Int.MAX_VALUE / 2)
            save()
        }
        listed = null
    }

    /** A file's bytes at any commit this clone has (History). */
    fun readAt(commit: String, path: String): ByteArray? = exclusive {
        val repo = repo()
        val at = try {
            commitOf(repo, commit)
        } catch (error: GitException) {
            return@exclusive null
        }
        TreeWalk.forPath(repo, path, at.tree)?.use { walk ->
            readBlobs(listOf(path to walk.getObjectId(0).name))[path]
        }
    }

    /** Housekeeping after a sync: past [maxStoreBytes], the clone is made again, shallow (G0). */
    fun maintain() = exclusive {
        if (storeBytes() <= maxStoreBytes) return@exclusive
        repository?.close()
        repository = null
        listed = null
        gitDir.deleteRecursively()
    }

    /** The clone's object store in bytes (Status, and [maintain]). */
    fun storeBytes(): Long = File(gitDir, "objects").walkTopDown().filter { it.isFile }.sumOf { it.length() }

    /** The remote-tracking head as of the last fetch, without fetching. */
    fun head(): String? = exclusive { repo().exactRef(trackingRef)?.objectId?.name }

    fun close() = synchronized(lock) {
        repository?.close()
        repository = null
    }

    /** A JGit failure as the engine reads it (A824): the code, our words, the host's. */
    private fun classify(error: Throwable, asked: Long): GitException {
        if (error is GitException) return error
        if (generation.get() != asked) return stopped()
        val host = GitRemotes.hostOf(remote) ?: "the git host"
        val chain = generateSequence(error) { it.cause }.toList()
        val text = chain.joinToString(" ") { it.message.orEmpty() }.lowercase()
        // HTTP Negotiate (Kerberos) needs org.ietf.jgss, which Android lacks (G0): a class error.
        if (chain.any { it is LinkageError }) {
            return GitException(GitErrorCode.AUTH, "Can't authenticate to $host: it asks for a sign-in this phone can't do. Use a personal access token.", cause = error)
        }
        return when {
            chain.any { it is NoRemoteRepositoryException } || "not found" in text || "repository not found" in text ->
                GitException(GitErrorCode.NOT_FOUND, "The repository or branch is not on $host, or this token can't see it.", cause = error)
            "not authorized" in text || "authentication is required" in text || "401" in text || "403" in text || "authentication not supported" in text ->
                GitException(GitErrorCode.AUTH, "Can't sign in to $host.", cause = error)
            "cancel" in text -> stopped()
            chain.any { it is SocketTimeoutException } || "timed out" in text || "read timed out" in text ->
                GitException(GitErrorCode.TIMEOUT, "$host did not answer in time.", cause = error)
            chain.any { it is UnknownHostException || it is ConnectException || it is NoRouteToHostException || it is SocketException || it is SSLException } ->
                GitException(GitErrorCode.NETWORK, "Can't reach $host.", cause = error)
            error is TransportException || error is GitAPIException || error is IOException ->
                GitException(GitErrorCode.GIT, error.message ?: "git failed.", cause = error)
            else -> GitException(GitErrorCode.GIT, error.message ?: error::class.java.simpleName, cause = error)
        }
    }

    companion object {
        /** No blob larger than this is read (the engine caps logs at 32 MB, A822). */
        const val MAX_BLOB_BYTES = 64 * 1024 * 1024

        private val SHA = Regex("^[0-9a-f]{40}$")

        fun parseSha(value: String): ObjectId {
            if (!SHA.matches(value)) throw GitException(GitErrorCode.GIT, "Not a commit id.")
            return ObjectId.fromString(value)
        }
    }
}
