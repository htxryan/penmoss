package app.penmoss.engine.git

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** How a notebook's sync stands, as its engine page says (`GitSyncStatus` in `host.ts`). */
@Serializable
data class GitEngineStatus(
    /** `starting`, `syncing`, `synced`, `offline` or `stopped`. */
    val phase: String = "starting",
    val detail: String? = null,
    val hostMessage: String? = null,
    val code: String? = null,
    /** When the sync running now began: past a while, the app says "Waiting for …" (A859). */
    val since: Long? = null,
    val lastSyncAt: Long? = null,
    val nextRetryAt: Long? = null,
    val pending: List<String> = emptyList(),
    val handEdits: List<String> = emptyList(),
    val skipped: Map<String, String> = emptyMap(),
    val head: String? = null,
)

/** A note brought back after the page's store was cleared (A886): [from] Room's copy, as the new note [id]. */
data class RecoveredNote(val from: String, val id: String, val title: String)

/** What the page made of one of Room's old copies (A886). */
sealed interface RecoverAnswer {
    /** No sync has landed since the page opened: nothing compared yet, Room keeps the copy. */
    data object Later : RecoverAnswer

    /** Git has all of it, or it was deleted for good: nothing comes back. */
    data object Done : RecoverAnswer

    data class Recovered(val note: RecoveredNote) : RecoverAnswer
}

/** What could be read of an old copy, for the person to save (A886). */
data class OldCopyText(val title: String, val markdown: String)

/** One answer of the notes server: a status, headers and the body's bytes. */
class LocalHttpAnswer(val status: Int, val headers: Map<String, String>, val body: ByteArray)

/**
 * The owner checks a notebook's page may ask for, only while the app's own request for them is
 * in flight (A877): a Delete for good or a History restore the person started in the app. A page
 * that asks for one on its own is refused, and nobody is asked.
 *
 * Each request is an [Ask] with one outcome (A887): the person's answer is kept only if the
 * request is still waiting for it ([Ask.commit]), and a request that runs out is withdrawn
 * first ([Ask.withdraw]), so a late confirmation does nothing and what the app says happened is
 * what happens. While the person is being asked, the request's time does not run.
 */
class OwnerAsks {
    private val open = ConcurrentHashMap<String, MutableList<Ask>>()

    class Ask internal constructor(val key: String, private val clock: () -> Long) {
        private val state = AtomicInteger(OPEN)
        private val since = AtomicLong(-1)
        private val asked = AtomicLong(0)

        /** Still waiting: neither answered and kept, nor withdrawn. */
        val live: Boolean get() = state.get() == OPEN

        val committed: Boolean get() = state.get() == COMMITTED

        val withdrawn: Boolean get() = state.get() == WITHDRAWN

        /** The person is being asked now (the prompt is up). */
        val prompting: Boolean get() = since.get() >= 0

        /** How long the person has been asked in all, the prompt up now included. */
        fun promptedMs(): Long = asked.get() + since.get().let { if (it >= 0) clock() - it else 0 }

        fun prompt(on: Boolean) {
            if (on) {
                since.compareAndSet(-1, clock())
            } else {
                val began = since.getAndSet(-1)
                if (began >= 0) asked.addAndGet(clock() - began)
            }
        }

        /** The person confirmed: kept only if the request still waits (else it ran out first). */
        fun commit(): Boolean = state.compareAndSet(OPEN, COMMITTED)

        /** The request ran out: a confirmation after this is not kept. False once committed. */
        fun withdraw(): Boolean = state.compareAndSet(OPEN, WITHDRAWN)

        private companion object {
            const val OPEN = 0
            const val COMMITTED = 1
            const val WITHDRAWN = 2
        }
    }

    /** The app's own request for [key] starts. */
    fun begin(key: String, clock: () -> Long = System::currentTimeMillis): Ask {
        val ask = Ask(key, clock)
        open.compute(key) { _, list -> (list ?: mutableListOf()).apply { add(ask) } }
        return ask
    }

    fun end(ask: Ask) {
        ask.withdraw()
        open.computeIfPresent(ask.key) { _, list -> list.apply { remove(ask) }.takeIf { it.isNotEmpty() } }
    }

    /** Ends the oldest request for [key] (a test's begin and end by key). */
    fun end(key: String) {
        open[key]?.firstOrNull()?.let(::end)
    }

    /** The request waiting for [key], if one does. */
    fun waiting(key: String): Ask? = open[key]?.toList()?.firstOrNull { it.live }

    fun asked(key: String): Boolean = waiting(key) != null

    companion object {
        /** Why a withdrawn request was never shown its prompt (A887). */
        const val WITHDRAWN = "the request ran out before the prompt showed."

        fun purge(noteId: String) = "purge:$noteId"

        fun restore(noteId: String, version: Long) = "restore:$noteId:$version"
    }
}

/**
 * One notebook's engine page (T50 G7, A872), as the app drives it: the page calls the app's git
 * ([GitNotebooks.op], behind its checks), the writer's secret and the owner checks; the app calls
 * the page's engine and its notes server ([http], which `LocalGitApi` uses).
 */
class GitEngine(
    val localId: String,
    port: FramePort,
    private val notebooks: GitNotebooks,
    scope: CoroutineScope,
    private val asks: OwnerAsks = OwnerAsks(),
    private val onLog: (String) -> Unit = {},
    /** Where copies withheld from the push are kept (A886); without one, the page's sync stops first. */
    private val withheld: WithheldCopies? = null,
) {
    private val state = MutableStateFlow(GitEngineStatus())
    val status: StateFlow<GitEngineStatus> = state.asStateFlow()

    /** Told when a sync brought changes the phone should pull (its next pass). */
    @Volatile
    var onChanged: () -> Unit = {}

    @Volatile
    var epoch: String? = null
        private set

    /** The page's store was made afresh at the last open (A886): a first open, or Android cleared it. */
    @Volatile
    var fresh: Boolean = false
        private set

    /** What `navigator.storage.persist()` answered (A886); null where the page could not ask. */
    @Volatile
    var persisted: Boolean? = null
        private set

    private val json = Json { ignoreUnknownKeys = true }

    private val channel = GitChannel(
        port,
        scope,
        buildMap {
            for (op in GitNotebooks.OPS) put("git.$op", GitHandler { call, reply -> notebooks.op(localId, op, call, reply) })
            put("git.cancel", GitHandler { _, _ ->
                notebooks.cancel(localId)
                JsonNull
            })
            put("secret.get", GitHandler { _, _ -> notebooks.writerSecret(localId)?.let(::JsonPrimitive) ?: JsonNull })
            put("secret.set", GitHandler { call, _ ->
                notebooks.setWriterSecret(localId, call.args.text() ?: throw GitRefusal("invalid_request", "Not a writer secret."))
                JsonNull
            })
            put("owner.purge", GitHandler { call, _ ->
                val noteId = (call.args as? JsonObject)?.get("noteId").text() ?: throw GitRefusal("invalid_request", "Not a note id.")
                val ask = asks.waiting(OwnerAsks.purge(noteId)) ?: throw GitRefusal("not_asked", "Nobody asked to delete that note for good on this phone.")
                notebooks.confirmPurge(localId, noteId, ask)
                JsonNull
            })
            // A copy withheld from the push (A886), before it leaves the notebook: kept aside here,
            // or the page's sync stops with nothing changed or pushed.
            put("copy.withhold", GitHandler { call, _ ->
                val keeper = withheld ?: throw GitRefusal("not_kept", "This phone could not keep a copy aside, so nothing was pushed.")
                val invalid = GitRefusal("invalid_request", "Not a copy to keep.")
                val list = (call.args as? JsonObject)?.get("copies") as? JsonArray ?: throw invalid
                if (list.isEmpty() || list.size > GitNotebooks.MAX_PURGES) throw invalid
                val copies = list.map { item ->
                    val each = item as? JsonObject ?: throw invalid
                    WithheldCopy(
                        noteId = each["noteId"].text()?.takeIf { GitNotebooks.NOTE_ID.matches(it) } ?: throw invalid,
                        origin = each["origin"].text()?.takeIf { GitNotebooks.NOTE_ID.matches(it) } ?: throw invalid,
                        title = each["title"].text().orEmpty().take(1_000),
                        folderId = each["folderId"].text()?.takeIf { GitNotebooks.NOTE_ID.matches(it) },
                        // Opaque to Kotlin (A11): kept as the base64 Room keeps every update in.
                        updates = listOf(java.util.Base64.getEncoder().encodeToString(call.bytes(each["update"]) ?: throw invalid)),
                    )
                }
                keeper.withhold(copies)
                JsonNull
            })
            put("owner.restore", GitHandler { call, _ ->
                val args = call.args as? JsonObject ?: throw GitRefusal("invalid_request", "Not a note id.")
                val noteId = args["noteId"].text() ?: throw GitRefusal("invalid_request", "Not a note id.")
                val version = (args["version"] as? JsonPrimitive)?.longOrNull ?: throw GitRefusal("invalid_request", "Not a version.")
                val ask = asks.waiting(OwnerAsks.restore(noteId, version)) ?: throw GitRefusal("not_asked", "Nobody asked to restore that version on this phone.")
                notebooks.confirmRestore(localId, noteId, (args["revert"] as? JsonPrimitive)?.booleanOrNull == true, ask)
                JsonNull
            })
        },
        onLost = { error -> onLog("An answer to the page was lost: ${error.message ?: error::class.java.simpleName}") },
    )

    init {
        channel.onEvent { name, value ->
            when (name) {
                "status" -> runCatching { json.decodeFromJsonElement(GitEngineStatus.serializer(), value) }.getOrNull()?.let { state.value = it }
                "changed" -> onChanged()
                "log" -> value.text()?.let(onLog)
            }
        }
    }

    /** Opens the notebook in the page: its engine, its server, its first sync. */
    suspend fun open(entry: GitNotebookEntry, label: String, front: Boolean, roomEpochs: List<String> = emptyList()): String {
        val answer = channel.call("open", OPEN_MS) {
            JsonObject(
                mapOf(
                    "notebookId" to JsonPrimitive(entry.notebookId),
                    "name" to JsonPrimitive(entry.name),
                    "create" to JsonPrimitive(entry.create),
                    "host" to JsonPrimitive(GitRemotes.hostOf(entry.remote) ?: "this phone"),
                    "label" to JsonPrimitive(label),
                    "root" to JsonPrimitive(GitRemotes.rootOf(entry.dir)),
                    "pushDelayS" to JsonPrimitive(entry.pushDelayS),
                    "pullEveryMin" to JsonPrimitive(entry.pullEveryMin),
                    "front" to JsonPrimitive(front),
                    // Room's copies of other epochs wait for recovery (A886).
                    "roomEpochs" to JsonArray(roomEpochs.map(::JsonPrimitive)),
                ),
            )
        }
        val value = answer.value as? JsonObject
        val opened = value?.get("epoch").text() ?: throw GitRefusal("error", "The notebook did not open.")
        fresh = (value?.get("fresh") as? JsonPrimitive)?.booleanOrNull == true
        persisted = (value?.get("persisted") as? JsonPrimitive)?.booleanOrNull
        epoch = opened
        return opened
    }

    /**
     * A note as Room held it before the page's store was made afresh (A886): [updates] are Room's
     * whole copy, the strings Room keeps; the page decodes them (Kotlin never reads Yjs, A11).
     * They go in parts of at most [partChars], an update cut across parts when it is longer, so
     * no frame passes its limit.
     */
    suspend fun recover(noteId: String, updates: List<String>, folderId: String?, partChars: Int = PART_CHARS, timeoutMs: Long = HTTP_MS): RecoverAnswer {
        val answer = parts("recover", noteId, updates, partChars, timeoutMs, mapOf("folderId" to (folderId?.let(::JsonPrimitive) ?: JsonNull)))
        val value = answer.value as? JsonObject ?: throw GitRefusal("error", "The page gave no answer for the note.")
        return when (value["status"].text()) {
            "later" -> RecoverAnswer.Later
            "done" -> RecoverAnswer.Done
            "recovered" -> RecoverAnswer.Recovered(
                RecoveredNote(noteId, value["id"].text() ?: throw GitRefusal("error", "The page named no note."), value["title"].text() ?: ""),
            )
            else -> throw GitRefusal("error", "The page gave no answer for the note.")
        }
    }

    /** What the page can read of an old copy (A886), for the person to save; null when none of it. */
    suspend fun oldCopyText(noteId: String, updates: List<String>, partChars: Int = PART_CHARS, timeoutMs: Long = HTTP_MS): OldCopyText? {
        val value = parts("recover.text", noteId, updates, partChars, timeoutMs, emptyMap()).value as? JsonObject ?: return null
        return OldCopyText(value["title"].text() ?: "Untitled", value["markdown"].text() ?: return null)
    }

    /**
     * Keep and sync (A886): a withheld copy back in the notebook, after the person's owner check
     * ([GitNotebooks.confirmKeepCopy]); its rows go in parts, as an old copy's do. The title it has.
     */
    suspend fun keepCopy(copy: WithheldCopy, partChars: Int = PART_CHARS, timeoutMs: Long = HTTP_MS): String {
        val extra = mapOf("origin" to JsonPrimitive(copy.origin), "folderId" to (copy.folderId?.let(::JsonPrimitive) ?: JsonNull))
        val value = parts("copy.keep", copy.noteId, copy.updates, partChars, timeoutMs, extra).value as? JsonObject
        if (value?.get("status").text() != "kept") throw GitRefusal("error", "The page did not take the copy back.")
        return value?.get("title").text() ?: copy.title
    }

    /** A withheld copy deleted for good on this phone (A886): the page forgets it too. */
    suspend fun forgetCopy(noteId: String) {
        channel.call("copy.forget", CALL_MS) { JsonObject(mapOf("noteId" to JsonPrimitive(noteId))) }
    }

    /** An old copy kept in Room, not brought back (A886): Room's exchange of the note goes ahead. */
    suspend fun releaseOldCopy(noteId: String) {
        channel.call("recover.release", HTTP_MS) { JsonObject(mapOf("noteId" to JsonPrimitive(noteId))) }
    }

    /** No old copy waits any more (A886). */
    suspend fun endOldCopies() {
        channel.call("recover.end", HTTP_MS) { JsonNull }
    }

    private val sequences = AtomicLong(0)

    private suspend fun parts(op: String, noteId: String, updates: List<String>, partChars: Int, timeoutMs: Long, last: Map<String, JsonElement>): GitAnswer {
        val size = partChars.coerceAtLeast(1)
        val pieces = updates.withIndex().flatMap { (n, update) ->
            if (update.isEmpty()) listOf(n to "") else (update.indices step size).map { n to update.substring(it, minOf(update.length, it + size)) }
        }
        val grouped = mutableListOf<MutableList<Pair<Int, String>>>(mutableListOf())
        var chars = 0
        for (piece in pieces) {
            if (grouped.last().isNotEmpty() && chars + piece.second.length > size) {
                grouped += mutableListOf<Pair<Int, String>>()
                chars = 0
            }
            grouped.last() += piece
            chars += piece.second.length
        }
        // This sequence's own token: another for the same note at once (Save their text during a
        // pass) never mixes with it.
        val token = "${noteId.takeLast(8)}-${sequences.incrementAndGet()}"
        fun args(index: Int, extra: Map<String, JsonElement>) = JsonObject(
            mapOf(
                "token" to JsonPrimitive(token),
                "noteId" to JsonPrimitive(noteId),
                "first" to JsonPrimitive(index == 0),
                "pieces" to JsonArray(grouped[index].map { (n, text) -> JsonObject(mapOf("n" to JsonPrimitive(n), "s" to JsonPrimitive(text))) }),
            ) + extra,
        )
        for (index in 0 until grouped.size - 1) channel.call("recover.part", timeoutMs) { args(index, emptyMap()) }
        return channel.call(op, timeoutMs) { args(grouped.size - 1, last) }
    }

    /** One request to the notebook's notes server. */
    suspend fun http(method: String, path: String, headers: Map<String, String>, body: ByteArray?, timeoutMs: Long? = HTTP_MS): LocalHttpAnswer {
        val answer = channel.call("http", timeoutMs) { frame ->
            JsonObject(
                buildMap {
                    put("method", JsonPrimitive(method))
                    put("path", JsonPrimitive(path))
                    put("headers", JsonObject(headers.mapValues { JsonPrimitive(it.value) }))
                    put("body", body?.let(frame::blob) ?: JsonNull)
                },
            )
        }
        val value = answer.value as? JsonObject ?: throw GitRefusal("error", "The notes server gave no answer.")
        val status = (value["status"] as? JsonPrimitive)?.intOrNull ?: 500
        val headers = (value["headers"] as? JsonObject)?.mapNotNull { (key, each) -> each.text()?.let { key to it } }?.toMap().orEmpty()
        return LocalHttpAnswer(status, headers, answer.bytes(value["body"]) ?: ByteArray(0))
    }

    /** Syncs now and waits for it (and any asked for meanwhile): a background run, Sync now. */
    suspend fun sync(limitMs: Long? = null, background: Boolean = false): GitEngineStatus {
        val answer = channel.call("sync", (limitMs ?: SYNC_WAIT_MS) + 30_000) {
            JsonObject(
                buildMap {
                    put("reason", JsonPrimitive(if (background) "background" else "now"))
                    if (limitMs != null) put("limitMs", JsonPrimitive(limitMs))
                },
            )
        }
        return runCatching { json.decodeFromJsonElement(GitEngineStatus.serializer(), answer.value) }.getOrNull()?.also { state.value = it } ?: state.value
    }

    suspend fun setFront(front: Boolean) {
        channel.call("front", CALL_MS) { JsonObject(mapOf("front" to JsonPrimitive(front))) }
    }

    suspend fun setCadence(pushDelayS: Int, pullEveryMin: Int) {
        channel.call("cadence", CALL_MS) { JsonObject(mapOf("pushDelayS" to JsonPrimitive(pushDelayS), "pullEveryMin" to JsonPrimitive(pullEveryMin))) }
    }

    /** What the engine has not pushed yet (notes, and `workspace` for the folder tree). */
    suspend fun pending(): List<String> =
        (channel.call("pending", CALL_MS).value as? JsonArray)?.mapNotNull { it.text() }.orEmpty()

    /**
     * Keep note (A855): takes back a Delete for good that has not landed ([keep]), or marks it
     * again (Undo). The caller checks the branch first ([GitNotebooks.purgesToConfirm]).
     */
    suspend fun keep(noteId: String, keep: Boolean) {
        channel.call("keep", CALL_MS) { JsonObject(mapOf("noteId" to JsonPrimitive(noteId), "keep" to JsonPrimitive(keep))) }
    }

    /**
     * As the notebook's screen pauses: one short sync of what waits (A825, #170 F8). Only a real
     * leave ([leaving]: the app leaves the screen, or the screen finishes) stops a push still
     * running at the time limit; a plain pause (the file picker, the share sheet) never does
     * (#174 delta review).
     */
    suspend fun close(leaving: Boolean = false) {
        channel.call("close", CALL_MS + 10_000) { JsonObject(mapOf("leaving" to JsonPrimitive(leaving))) }
    }

    /** Stops its timers: the page is about to go. */
    suspend fun stop() {
        runCatching { channel.call("stop", CALL_MS) }
    }

    /** Deletes the notebook's store in the page (Remove). */
    suspend fun forget(notebookId: String) {
        channel.call("forget", CALL_MS) { JsonObject(mapOf("notebookId" to JsonPrimitive(notebookId))) }
    }

    /** The page went away (its renderer died): every call waiting fails. */
    fun closed(reason: String) = channel.closeAll(reason)

    companion object {
        const val OPEN_MS = 120_000L
        const val HTTP_MS = 120_000L

        /** Base64 characters of an old copy in one call (A886): well under the frame header's 16 MB. */
        const val PART_CHARS = 4 * 1024 * 1024
        const val CALL_MS = 15_000L

        /** A sync in front is bounded by the page at 90 s (A859); this is the app's own backstop. */
        const val SYNC_WAIT_MS = 100_000L
    }
}

/**
 * The commit check (A876) in its own page: stateless, and it reads the head through the app's
 * JGit ([GitNotebooks.headList], [GitNotebooks.headRead]), never through an engine page.
 */
class PageGuard(port: FramePort, scope: CoroutineScope, notebooks: () -> GitNotebooks) : GitGuard {
    private val channel = GitChannel(
        port,
        scope,
        mapOf(
            "head.list" to GitHandler { call, _ ->
                val args = call.args as? JsonArray ?: throw GitRefusal("invalid_request", "Expected [localId, head]")
                val listed = notebooks().headList(args.getOrNull(0).text() ?: "", args.getOrNull(1).text() ?: "")
                JsonArray(listed.map { (path, blob) -> JsonArray(listOf(JsonPrimitive(path), JsonPrimitive(blob))) })
            },
            "head.read" to GitHandler { call, reply ->
                val args = call.args as? JsonArray ?: throw GitRefusal("invalid_request", "Expected [localId, head, paths]")
                val paths = (args.getOrNull(2) as? JsonArray)?.mapNotNull { it.text() }.orEmpty()
                val read = notebooks().headRead(args.getOrNull(0).text() ?: "", args.getOrNull(1).text() ?: "", paths)
                JsonArray(read.map { (path, bytes) -> JsonArray(listOf(JsonPrimitive(path), reply.blob(bytes))) })
            },
        ),
    )

    private fun target(localId: String, root: String, head: String?): MutableMap<String, JsonElement> =
        mutableMapOf("localId" to JsonPrimitive(localId), "root" to JsonPrimitive(root), "head" to (head?.let(::JsonPrimitive) ?: JsonNull))

    override suspend fun commitPurges(localId: String, root: String, head: String?, changes: Map<String, ByteArray?>): CommitPurges {
        val answer = channel.call("guard.commit", GUARD_MS) { frame ->
            JsonObject(
                target(localId, root, head).apply {
                    put("changes", JsonArray(changes.map { (path, bytes) -> JsonArray(listOf(JsonPrimitive(path), bytes?.let(frame::blob) ?: JsonNull)) }))
                },
            )
        }
        val value = answer.value as? JsonObject ?: throw GitRefusal("guard", "The commit check gave no answer, so nothing was pushed.")
        fun ids(key: String) = (value[key] as? JsonArray ?: throw GitRefusal("guard", "The commit check gave no answer, so nothing was pushed.")).mapNotNull { it.text() }
        return CommitPurges(ids("added"), ids("stray"), ids("shrunk"), ids("reversed"), ids("raced"), ids("undoneMarks"))
    }

    override suspend fun purgedAt(localId: String, root: String, head: String?): Set<String> =
        (channel.call("guard.purgedAt", GUARD_MS) { JsonObject(target(localId, root, head)) }.value as? JsonArray)
            ?.mapNotNull { it.text() }?.toSet() ?: throw GitRefusal("guard", "The commit check gave no answer.")

    override suspend fun titles(localId: String, root: String, head: String?, ids: List<String>): Map<String, String> {
        val answer = channel.call("guard.titles", GUARD_MS) {
            JsonObject(target(localId, root, head).apply { put("ids", JsonArray(ids.map(::JsonPrimitive))) })
        }
        return (answer.value as? JsonArray)?.mapNotNull { pair ->
            val list = pair as? JsonArray ?: return@mapNotNull null
            val id = list.getOrNull(0).text() ?: return@mapNotNull null
            id to (list.getOrNull(1).text() ?: "")
        }?.toMap().orEmpty()
    }

    /** The page went away: every call waiting fails, so a commit is refused, never let through. */
    fun closed(reason: String) = channel.closeAll(reason)

    companion object {
        const val GUARD_MS = 120_000L
    }
}
