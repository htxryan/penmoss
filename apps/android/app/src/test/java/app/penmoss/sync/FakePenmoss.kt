package app.penmoss.sync

import app.penmoss.engine.tree.OrderKeys
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.temporal.IsoFields
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Enough of Penmoss's sync API for these tests (A280, A281): each note is a list of
 * opaque updates in an epoch; the cursor the phone holds names how many it has; a
 * reply carries the ones it lacks, joined, as the server's merge would.
 */
internal class FakePenmoss : Dispatcher() {
    private class Note(
        val id: String,
        var title: String,
        var epoch: String,
        val updates: MutableList<String> = mutableListOf(),
        var clock: Long = 0,
        /** Where the tree files it (T38): null is the top level. */
        var folderId: String? = null,
        var position: String = "",
        /** In Trash: out of the tree, and never filed back in it (A358). */
        var deleted: Boolean = false,
        /** The folder it was in when it went to Trash (T40 P3a), which a restore answers. */
        var deletedFrom: String? = null,
        /**
         * Its last restore (T40 P3a, A431): the index seq it was made after (-1: never), and by
         * whom ("phone" for this phone's own, else "web"), for `restored_since`.
         */
        var restoredSeq: Long = -1,
        var deletedAt: Long = 0,
        var restoredBy: String = "",
        /** A daily or weekly note's kind and period, as the server indexed them (T40 P5). */
        var kind: String = "note",
        var period: String? = null,
        /** Its plain text as the server renders it (T40 P6): set by [write], else its updates joined. */
        var text: String? = null,
        /** Its tags as the index has them (T40 P6). */
        var tags: List<String> = emptyList(),
        /** Its headings, one per line, sent with its text (T40 P6 review S6). */
        var headings: String = "",
    )

    /** A server from before T40 P6: no `text` in `/sync/batch` replies, no `tags` in `/sync/changes`. */
    @Volatile
    var textMissing = false

    /** Each `/sync/batch` entry that asked for text, as (id, textHash sent), in order (T40 P6). */
    val textAsks = CopyOnWriteArrayList<Pair<String, String?>>()

    /** Each `/sync/batch` entry, as its id and whether it asked for text, in order (T40 P6). */
    val batchEntries = CopyOnWriteArrayList<Pair<String, Boolean>>()

    /** A note written on the web (T40 P6): its text, with an update the phone will fetch. */
    @Synchronized
    fun write(id: String, title: String, text: String, tags: List<String> = emptyList(), headings: String = "") {
        val note = notes.getOrPut(id) { Note(id, title, "e1") }
        note.updates += "w${note.updates.size}"
        note.title = title
        note.text = text
        note.tags = tags
        note.headings = headings
        note.clock = ++clock
    }

    fun textOf(id: String): String {
        val note = notes.getValue(id)
        return note.text ?: note.updates.joinToString(" ")
    }

    /** Runs as a move to Trash is answered, after the server applied it (a request in flight). */
    @Volatile
    var onTrashAnswered: ((String) -> Unit)? = null

    /** Runs as a restore is answered, after the server applied it. */
    @Volatile
    var onRestoreAnswered: ((String) -> Unit)? = null

    /**
     * The next move to Trash or restore is applied, then answered with this status instead (a
     * 500, as when the tree's step fails after the NoteDoc's), once (second review of #94).
     */
    @Volatile
    var failAfterApplying: Int? = null

    /** The next `/trash` or `/restore` is answered 404 with a page that is not JSON (a proxy's), once. */
    @Volatile
    var proxyNotFound = false

    /** Every `POST /api/notes/:id/trash` and `/restore`, as "trash:id" and "restore:id", in order (T40 P3a). */
    val trashCalls = CopyOnWriteArrayList<String>()

    /** A server from before T40 P3a: `POST /api/notes/:id/trash` is an unknown endpoint, 404. */
    @Volatile
    var trashRouteMissing = false

    /** How many of a note's edits the server had when its move to Trash arrived. */
    val updatesWhenTrashed = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /** The workspace's folders (T40 P4): parent, name, order key and sort mode. */
    private data class FolderState(
        var parent: String?,
        var name: String,
        var position: String = "",
        var sortMode: String = "manual",
    )

    private val folders = LinkedHashMap<String, FolderState>()

    /** Every `POST /api/notes/:id/move`, as (note, folder), in order (T38). */
    val moves = CopyOnWriteArrayList<Pair<String, String?>>()

    /** Each move's `fromFolderId` (A359): absent (no check), or the folder, "" for the top level. */
    val froms = CopyOnWriteArrayList<String?>()

    /** Every `POST /api/notes/:id/move`'s `place` (T40 P4, NT7): before/after, or null. */
    val places = CopyOnWriteArrayList<Pair<String?, String?>?>()

    /** Every `POST /api/daily`, as (date, period), in order (T40 P5). */
    val dailyCalls = CopyOnWriteArrayList<Pair<String?, String>>()

    /**
     * Daily intents that came before the note's content (review N5): the phone files a note it
     * made only once its upload is in, so every test expects none.
     */
    val dailyBeforeContent = CopyOnWriteArrayList<String>()

    /**
     * Maps a daily intent to the note it files, as the server's journal does (T40 P5): filing
     * restores a daily note in Trash (A144). Null: answered without filing, as for a note the
     * server has not indexed.
     */
    var dailyNoteId: ((date: String?, period: String) -> String?)? = null

    private val notes = LinkedHashMap<String, Note>()
    private var clock = 0L
    private val replies = mutableMapOf<String, MutableList<String>>()
    val uploads = CopyOnWriteArrayList<String>()
    val requests = AtomicInteger()
    val trees = AtomicInteger()
    val batches = AtomicInteger()
    private val inFlight = AtomicInteger()
    val maxInFlight = AtomicInteger()

    @Volatile
    var treeGate: CountDownLatch? = null

    /** Notes whose uploads `/sync/batch` refuses as "Read-only" (T42 on Android, AC12). */
    val readOnly: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /**
     * `/sync/batch` files a note on its first upload in the folder it names (T43, fix c), as the
     * new server does; off, it ignores the folder, as an older server does.
     */
    @Volatile
    var filesOnUpload = false

    /** Each first upload's `folderId` (T43, fix c), as (note, folder), in order. */
    val uploadFolders = CopyOnWriteArrayList<Pair<String, String?>>()

    /** Holds the next `/sync/batch` until counted down. */
    @Volatile
    var batchGate: CountDownLatch? = null

    /** Answers every request 403, as for a sign-in that may not sync (T42 on Android, AC12). */
    @Volatile
    var forbidding = false

    /** Refuses every token, as after a revoke elsewhere. */
    @Volatile
    var refusing = false

    /**
     * The user's synced settings as the server holds them (T40 P1, A410): the tree sends them, and
     * `PUT /api/settings` changes them only while each still has the base the phone sent.
     */
    val settings = java.util.concurrent.ConcurrentHashMap<String, Any>()

    /** Every `PUT /api/settings` body, in order. */
    val settingsChanges = CopyOnWriteArrayList<JSONObject>()

    /** A setting changed on the web or the Mac (null: removed). */
    @Synchronized
    fun setOnWeb(key: String, value: Any?) {
        if (value == null) settings.remove(key) else settings[key] = value
    }

    /** `PUT /api/settings` fails with a 503, as a server having a bad moment. */
    @Volatile
    var settingsDown = false

    /** The top level's sort mode (T40 P4, NT6). */
    @Volatile
    var rootSortMode = "manual"

    /** Whether the tree carries settings: false is a server without the settings channel. */
    @Volatile
    var settingsChannel = true

    /** Runs while a `PUT /api/settings` is with the server, before it is answered (a tap meanwhile). */
    @Volatile
    var whileSettingsOut: (() -> Unit)? = null

    /** The next `PUT /api/settings` is refused with this status and body, and not applied. */
    @Volatile
    var refuseSettings: Pair<Int, JSONObject>? = null

    /** Quick captures received (T34), as their ids, in order. */
    val captures = CopyOnWriteArrayList<String>()

    /** Every request's path and whether it carried a token, in order. */
    val seen = CopyOnWriteArrayList<Pair<String, Boolean>>()

    @Synchronized
    fun edit(id: String, update: String, title: String) {
        val note = notes.getOrPut(id) { Note(id, title, "e1") }
        note.updates += update
        note.title = title
        note.clock = ++clock
    }

    /** A restore on the web (A5): a new epoch whose note is the older version. */
    @Synchronized
    fun restore(id: String, update: String) {
        val note = notes.getValue(id)
        note.epoch = "e" + (clock + 2)
        note.updates.clear()
        note.updates += update
        note.clock = ++clock
    }

    /** The last order key issued: every fake key chains off it, so all are valid and ordered. */
    private var lastKey: String? = null

    private fun nextKey(): String {
        lastKey = OrderKeys.keyBetween(lastKey, null)
        return lastKey as String
    }

    /** A folder made on the web (T38). */
    @Synchronized
    fun folder(id: String, parentId: String? = null, name: String? = null, position: String? = null) {
        folders[id] = FolderState(parentId, name ?: "Folder $id", position ?: nextKey())
    }

    /** A folder renamed on the web (T40 P4): a rename from the phone with an older base loses. */
    @Synchronized
    fun renameFolderOnWeb(id: String, name: String) {
        folders.getValue(id).name = name
    }

    /** A folder moved on the web (T40 P4): a move from the phone with an older base loses. */
    @Synchronized
    fun moveFolderOnWeb(id: String, parentId: String?) {
        folders.getValue(id).parent = parentId
    }

    /** A folder's sort mode on the web (T40 P4): last write wins, no precondition. */
    @Synchronized
    fun sortFolderOnWeb(id: String, mode: String) {
        folders.getValue(id).sortMode = mode
    }

    /** A folder deleted on the web: its notes go to the top level, as the web files orphans (T38). */
    @Synchronized
    fun forgetFolder(id: String) {
        val doomed = folders.keys.filter { it == id || isWithin(it, id) }.toSet()
        // Trash remembers where each was (T42), which the safe place reads through (A757).
        for (gone in doomed) trashed[gone] = folders.getValue(gone).parent
        for (gone in doomed) folders.remove(gone)
        notes.values.filter { it.folderId in doomed }.forEach { it.folderId = null }
    }

    /** Folders deleted on the web, and the parent each had: Trash's records (T42). */
    private val trashed = HashMap<String, String?>()

    /** Trash forgets a folder (purged): no safe place can be read through it (A757). */
    @Synchronized
    fun purgeFolderRecord(id: String) {
        trashed.remove(id)
    }

    /**
     * The real server's place for something meant for a folder gone since (T43, A757, core's
     * `notebookLineage().fallback`): the nearest live folder above it through Trash's records, or
     * the top level when the way up ends (this fake has no notebooks). [REFUSED] when Trash no
     * longer knows a folder on the way up: no safe place.
     */
    private fun safePlace(folderId: String?): String? {
        var at = folderId
        val seen = HashSet<String>()
        while (at != null) {
            if (at in folders) return at
            if (!trashed.containsKey(at) || !seen.add(at)) return REFUSED
            at = trashed[at]
        }
        return null
    }


    private fun isWithin(candidate: String, ancestor: String): Boolean {
        var current: String? = candidate
        while (current != null) {
            if (current == ancestor) return true
            current = folders[current]?.parent
        }
        return false
    }

    /** A note moved on the web or the Mac (T38): at the end of [folderId]. */
    @Synchronized
    fun moveOnWeb(id: String, folderId: String?) {
        val note = notes.getValue(id)
        note.folderId = folderId
        note.position = nextKey()
    }

    /** A note's journal identity, as the server indexed it (T40 P5). */
    @Synchronized
    fun journal(id: String, kind: String, period: String) {
        val note = notes.getValue(id)
        note.kind = kind
        note.period = period
        note.clock = ++clock
    }

    /** A note moved to Trash elsewhere: out of the tree, and `deleted` in `/sync/changes`. */
    @Synchronized
    fun trash(id: String) {
        val note = notes.getValue(id)
        note.deletedFrom = note.folderId
        note.deleted = true
        note.deletedAt = System.currentTimeMillis()
        note.clock = ++clock
    }

    /** Restored from Trash elsewhere (the web's Restore). */
    @Synchronized
    fun restoreFromTrash(id: String) {
        val note = notes.getValue(id)
        note.deleted = false
        note.restoredSeq = note.clock
        note.restoredBy = "web"
        note.clock = ++clock
    }

    @Synchronized
    fun deletedFrom(id: String): String? = notes.getValue(id).deletedFrom

    @Synchronized
    fun inTrash(id: String): Boolean = notes[id]?.deleted == true

    /** Deleted for good elsewhere, and not yet a tombstone in `/sync/changes`: the server answers 404. */
    @Synchronized
    fun forget(id: String) {
        notes.remove(id)
    }

    /** Where the server's tree files a note (T38). */
    @Synchronized
    fun folderOf(id: String): String? = notes.getValue(id).folderId

    @Synchronized
    fun has(id: String): Boolean = id in notes

    /** Whether the tree lists the note (a note in Trash is not in it). */
    @Synchronized
    fun inTree(id: String): Boolean = notes[id]?.deleted == false

    @Synchronized
    fun updates(id: String): List<String> = notes.getValue(id).updates.toList()

    /** What the server sent the phone for a note, in order. */
    @Synchronized
    fun sent(id: String): List<String> = replies[id].orEmpty().toList()

    override fun dispatch(request: RecordedRequest): MockResponse {
        requests.incrementAndGet()
        seen += request.url.encodedPath to (request.headers["Authorization"] != null)
        if (refusing) return json(JSONObject().put("error", JSONObject().put("code", "unauthorized").put("message", "Signed out")), 401)
        if (forbidding) return json(JSONObject().put("error", JSONObject().put("code", "forbidden").put("message", "This token may not sync")), 403)
        val now = inFlight.incrementAndGet()
        maxInFlight.updateAndGet { maxOf(it, now) }
        try {
            return when (request.url.encodedPath) {
                "/sync/tree" -> {
                    trees.incrementAndGet()
                    treeGate?.let {
                        treeGate = null
                        it.await(10, TimeUnit.SECONDS)
                    }
                    tree(request.url.queryParameter("since"))
                }
                "/sync/changes" -> changes(request.url.queryParameter("since")!!.toLong())
                "/sync/batch" -> {
                    batches.incrementAndGet()
                    batchGate?.let {
                        batchGate = null
                        it.await(10, TimeUnit.SECONDS)
                    }
                    batch(JSONObject(request.body!!.utf8()).getJSONArray("notes"))
                }
                "/api/auth/token" -> MockResponse.Builder().code(204).build()
                "/api/settings" -> {
                    settingsChanges += JSONObject(request.body!!.utf8())
                    whileSettingsOut?.invoke()
                    val refusal = refuseSettings?.also { refuseSettings = null }
                    if (refusal != null) json(refusal.second, refusal.first) else if (settingsDown) json(JSONObject().put("error", JSONObject().put("code", "unavailable")), 503) else if (settingsChannel) putSettings(JSONObject(request.body!!.utf8())) else json(JSONObject().put("error", JSONObject().put("code", "not_found")), 404)
                }
                "/api/capture" -> {
                    val capture = JSONObject(request.body!!.utf8())
                    captures += capture.getString("id")
                    // A capture that picked the other destination changes it for every app (A346).
                    if (capture.optBoolean("remember")) setOnWeb("capture.destination", capture.getString("destination"))
                    json(JSONObject().put("id", capture.getString("id")).put("noteId", "daily").put("destination", capture.getString("destination")).put("changed", true))
                }
                else -> {
                    val folder = FOLDER.matchEntire(request.url.encodedPath)
                    val move = MOVE.matchEntire(request.url.encodedPath)
                    val trash = TRASH.matchEntire(request.url.encodedPath)
                    if (request.url.encodedPath == "/api/folders" && request.method == "POST") {
                        folderCreate(JSONObject(request.body!!.utf8()))
                    } else if (folder != null && folder.groupValues[1] == "root" && request.method == "PATCH") {
                        folderRoot(JSONObject(request.body!!.utf8()))
                    } else if (folder != null && request.method == "PATCH") {
                        folderPatch(folder.groupValues[1], JSONObject(request.body!!.utf8()))
                    } else if (folder != null && request.method == "DELETE") {
                        folderDelete(folder.groupValues[1])
                    } else if (move != null && request.method == "POST") {
                        move(move.groupValues[1], JSONObject(request.body!!.utf8()))
                    } else if (request.url.encodedPath == "/api/daily" && request.method == "POST") {
                        daily(JSONObject(request.body!!.utf8()))
                    } else if (trash != null && request.method == "POST") {
                        val id = trash.groupValues[1]
                        if (proxyNotFound) {
                            proxyNotFound = false
                            trashCalls += "${trash.groupValues[2]}:$id (proxy 404)"
                            return MockResponse.Builder().code(404).addHeader("Content-Type", "text/html").body("<html>Not Found</html>").build()
                        }
                        val answer = if (trash.groupValues[2] == "trash") {
                            trashHere(id, JSONObject(request.body!!.utf8())).also { onTrashAnswered?.invoke(id) }
                        } else {
                            restoreHere(id).also { onRestoreAnswered?.invoke(id) }
                        }
                        val failed = failAfterApplying?.also { failAfterApplying = null }
                        if (failed != null) json(JSONObject().put("error", JSONObject().put("code", "internal").put("message", "Internal error")), failed) else answer
                    } else {
                        json(JSONObject().put("error", JSONObject().put("code", "not_found")), 404)
                    }
                }
            }
        } finally {
            inFlight.decrementAndGet()
        }
    }

    @Synchronized
    private fun tree(since: String?): MockResponse {
        val hash = "h" + (notes.values.joinToString(",") { "${it.id}@${it.folderId}:${it.position}:${it.deleted}:${it.kind}:${it.period}" } + folders.toString() + settings.toSortedMap().toString()).hashCode()
        if (since == hash) return json(JSONObject().put("hash", hash).put("unchanged", true))
        val placed = JSONArray().apply {
            notes.values.filter { !it.deleted }.forEach {
                val entry = JSONObject().put("id", it.id).put("folderId", it.folderId ?: JSONObject.NULL).put("position", it.position)
                if (it.kind == "daily" || it.kind == "weekly") {
                    entry.put("kind", it.kind)
                    if (it.period != null) entry.put("period", it.period)
                }
                put(entry)
            }
        }
        val tree = JSONArray().apply {
            folders.forEach { (id, state) ->
                put(
                    JSONObject().put("id", id).put("name", state.name).put("parentId", state.parent ?: JSONObject.NULL)
                        .put("position", state.position).put("sortMode", state.sortMode),
                )
            }
        }
        val reply = JSONObject().put("hash", hash).put("rootSortMode", rootSortMode).put("folders", tree).put("notes", placed)
        if (settingsChannel) reply.put("settings", settingsJson())
        return json(reply)
    }

    private fun settingsJson() = JSONObject().apply { settings.forEach { (key, value) -> put(key, value) } }

    /** `PUT /api/settings` as the WorkspaceDoc answers it (A410): all or nothing, 409 naming those changed since. */
    @Synchronized
    private fun putSettings(body: JSONObject): MockResponse {
        val set = body.getJSONObject("set")
        val base = body.getJSONObject("base")
        // At most 20 at once; the refusal names no setting (`parseSettingsChange`).
        if (set.length() > 20) {
            return json(JSONObject().put("error", JSONObject().put("code", "invalid_request").put("message", "At most 20 settings at once")), 400)
        }
        val changed = mutableListOf<String>()
        val writes = mutableListOf<Pair<String, Any?>>()
        for (key in set.keys()) {
            val now = settings[key]
            if (key.startsWith("theme.custom.")) {
                when (val plan = planTheme(set.getJSONObject(key), base.optJSONObject(key), now)) {
                    null -> changed += key
                    Unit -> Unit
                    else -> writes += key to plan
                }
                continue
            }
            val wanted = set.opt(key).takeUnless { it == JSONObject.NULL }
            val was = base.opt(key).takeUnless { it == JSONObject.NULL }
            if (now == wanted) continue
            if (now != was) changed += key else writes += key to wanted
        }
        if (changed.isNotEmpty()) {
            val error = JSONObject().put("code", "setting_changed").put("message", "Changed since").put("keys", JSONArray(changed))
            return json(JSONObject().put("error", error).put("settings", settingsJson()), 409)
        }
        for ((key, value) in writes) if (value == null) settings.remove(key) else settings[key] = value
        return json(JSONObject().put("settings", settingsJson()).put("changed", writes.isNotEmpty()))
    }

    /**
     * A custom theme's change as the server plans it (A416): what to store, Unit for nothing to
     * write, or null for a conflict (409). An edit is merged three ways: only the fields changed
     * since its base are written over what is stored. A deletion is stored as `{id, base,
     * deleted}`, and deleting a theme never had writes nothing.
     */
    private fun planTheme(value: JSONObject, base: JSONObject?, now: Any?): Any? {
        val live = (now as? JSONObject)?.takeUnless { it.optBoolean("deleted") }
        if (value.optBoolean("deleted")) {
            if (live == null) return Unit
            return JSONObject().put("id", value.getString("id")).put("base", value.getString("base")).put("deleted", true)
        }
        if (base == null) {
            return when {
                now == null -> value
                live != null && same(live, value) -> Unit
                else -> null
            }
        }
        if (live == null) return null
        val merged = merge(live, value, base)
        return if (same(merged, live)) Unit else merged
    }

    private fun merge(stored: JSONObject, mine: JSONObject, began: JSONObject): JSONObject {
        val out = JSONObject(stored.toString())
        for (key in mine.keys()) {
            val value = mine.get(key)
            val was = began.opt(key)
            if (value is JSONObject && was is JSONObject) {
                out.put(key, merge(stored.optJSONObject(key) ?: JSONObject(), value, was))
            } else if (!same(value, was)) {
                out.put(key, value)
            }
        }
        return out
    }

    private fun same(a: Any?, b: Any?): Boolean =
        kotlinx.serialization.json.Json.parseToJsonElement(JSONArray().put(a ?: JSONObject.NULL).toString()) ==
            kotlinx.serialization.json.Json.parseToJsonElement(JSONArray().put(b ?: JSONObject.NULL).toString())

    /**
     * Folder intent routes as the server answers them (T40 P4): create is idempotent by id,
     * renames and moves carry `from` preconditions (409 when overtaken), a missing folder is 404,
     * a delete moves notes up, and `place` orders from the anchor (missing: the end).
     */
    /** Every folder call, as "POST /api/folders", "PATCH <id>", "ROOT", "DELETE <id>", in order. */
    val folderCalls = CopyOnWriteArrayList<String>()

    /** A server from before T40 P4: the folder routes are unknown endpoints, 404 (A449). */
    @Volatile
    var foldersRouteMissing = false

    /**
     * The next `POST /api/folders` is applied, then answered with this status instead (its reply
     * lost on the way back): the create stays queued, tried, for a create+delete test (T40 P4
     * review B3). Consumed once.
     */
    @Volatile
    var folderCreateAppliedThenFails: Int? = null

    private fun foldersMissing(): MockResponse? {
        if (!foldersRouteMissing) return null
        // What the real server answers for a route it does not have (folders.test.ts).
        return MockResponse.Builder().code(404).addHeader("Content-Type", "application/json")
            .body(JSONObject().put("error", JSONObject().put("code", "not_found").put("message", "No such endpoint")).toString()).build()
    }

    @Synchronized
    private fun folderCreate(body: JSONObject): MockResponse {
        folderCalls += "POST /api/folders"
        foldersMissing()?.let { return it }
        val id = body.getString("id")
        val parent = if (body.isNull("parentId")) null else body.getString("parentId")
        folders[id]?.let { return folderJson(id, it, 200) }
        // A parent gone since: the nearest live folder above it (T43, A757), or 422 with no safe place.
        val placed = if (parent != null && parent !in folders) safePlace(parent) else parent
        if (placed == REFUSED) {
            return json(JSONObject().put("error", JSONObject().put("code", "folder_not_found").put("message", "No such folder")), 422)
        }
        folders[id] = FolderState(placed, body.getString("name"), nextKey())
        // Applied, but the answer never came back: the phone's op stays queued, tried.
        folderCreateAppliedThenFails?.let { status ->
            folderCreateAppliedThenFails = null
            return json(JSONObject().put("error", JSONObject().put("code", "internal").put("message", "Internal error")), status)
        }
        return folderJson(id, folders.getValue(id), 201)
    }

    @Synchronized
    private fun folderPatch(id: String, body: JSONObject): MockResponse {
        folderCalls += "PATCH $id"
        foldersMissing()?.let { return it }
        val state = folders[id] ?: return json(
            JSONObject().put("error", JSONObject().put("code", "folder_not_found").put("message", "No such folder")),
            404,
        )
        val from = body.optJSONObject("from")
        // A retry of an applied rename answers the folder, as the server does (T40 P4 review B1).
        if (from != null && from.has("name") && from.getString("name") != state.name &&
            !(body.has("name") && body.getString("name") == state.name)
        ) {
            return json(JSONObject().put("error", JSONObject().put("code", "folder_changed").put("message", "Changed since")), 409)
        }
        if (from != null && from.has("parentId")) {
            val seen = if (from.isNull("parentId")) null else from.getString("parentId")
            val changeParent = body.has("parentId")
            val wanted = if (changeParent) {
                if (body.isNull("parentId")) null else body.getString("parentId")
            } else {
                state.parent
            }
            // A retry of an applied move answers the folder (T40 P4 review B1).
            if (seen != state.parent && !(changeParent && state.parent == wanted)) {
                return json(JSONObject().put("error", JSONObject().put("code", "folder_moved").put("message", "Moved since")), 409)
            }
        }
        if (body.has("name")) state.name = body.getString("name")
        if (body.has("parentId")) {
            val asked = if (body.isNull("parentId")) null else body.getString("parentId")
            // A parent gone since: the nearest live folder above it (T43, A757), or 422 with no safe place.
            val parent = if (asked != null && asked !in folders) safePlace(asked) else asked
            if (parent == REFUSED) {
                return json(JSONObject().put("error", JSONObject().put("code", "folder_not_found").put("message", "No such folder")), 422)
            }
            if (parent != null && isWithin(parent, id)) {
                return json(JSONObject().put("error", JSONObject().put("code", "folder_cycle").put("message", "A cycle")), 422)
            }
            state.parent = parent
        }
        if (body.has("sortMode")) {
            val mode = body.getString("sortMode")
            if (mode != "manual" && mode != "alpha" && mode != "modified") {
                return json(JSONObject().put("error", JSONObject().put("code", "invalid_request").put("message", "Bad sort mode")), 400)
            }
            state.sortMode = mode
        }
        val place = body.optJSONObject("place")
        if (place != null) {
            val siblings = folders.entries.filter { it.value.parent == state.parent && it.key != id }
                .sortedWith { a, b -> a.value.position.compareTo(b.value.position).takeIf { it != 0 } ?: a.key.compareTo(b.key) }
                .map { it.key to it.value }.toMutableList()
            val anchor = listOfNotNull(
                place.optString("before", null).takeIf { place.has("before") },
                place.optString("after", null).takeIf { place.has("after") },
            ).firstOrNull { anchor -> siblings.any { it.first == anchor } }
            val at = siblings.indexOfFirst { it.first == anchor }
            val insertAt = when {
                anchor == null -> siblings.size
                place.has("before") -> at
                else -> at + 1
            }
            siblings.add(insertAt.coerceIn(0, siblings.size), id to state)
            var previous: String? = null
            for (sibling in siblings) {
                previous = OrderKeys.keyBetween(previous, null)
                sibling.second.position = previous
            }
            lastKey = previous
        }
        return folderJson(id, state, 200)
    }

    @Synchronized
    private fun folderRoot(body: JSONObject): MockResponse {
        folderCalls += "ROOT"
        foldersMissing()?.let { return it }
        val mode = body.optString("sortMode", "")
        if (mode != "manual" && mode != "alpha" && mode != "modified") {
            return json(JSONObject().put("error", JSONObject().put("code", "invalid_request").put("message", "Bad sort mode")), 400)
        }
        rootSortMode = mode
        return json(JSONObject().put("sortMode", mode))
    }

    @Synchronized
    private fun folderDelete(id: String): MockResponse {
        folderCalls += "DELETE $id"
        foldersMissing()?.let { return it }
        val state = folders[id] ?: return json(JSONObject().put("id", id).put("deleted", false))
        val destination = state.parent
        val doomed = folders.keys.filter { it == id || isWithin(it, id) }.toSet()
        for (gone in doomed) folders.remove(gone)
        notes.values.filter { it.folderId in doomed }.forEach { it.folderId = destination }
        return json(JSONObject().put("id", id).put("deleted", true))
    }

    private fun folderJson(id: String, state: FolderState, code: Int): MockResponse =
        json(
            JSONObject().put("id", id).put("name", state.name)
                .put("parentId", state.parent ?: JSONObject.NULL).put("sortMode", state.sortMode),
            code,
        )

    /**
     * `POST /api/notes/:id/move` as `moveNote` answers it: filed at the end of the folder; a note
     * in Trash refused (A358), and one moved since `fromFolderId` left where it is (A359). With
     * `place` (T40 P4, NT7) the note takes its order from the anchor; a missing anchor means the end.
     */
    @Synchronized
    private fun move(id: String, body: JSONObject): MockResponse {
        val asked = if (body.isNull("folderId")) null else body.getString("folderId")
        val checked = body.has("fromFolderId")
        val from = if (body.isNull("fromFolderId")) null else body.optString("fromFolderId")
        val place = body.optJSONObject("place")
        places += if (place == null) {
            null
        } else {
            (if (place.has("before")) place.optString("before") else null) to
                (if (place.has("after")) place.optString("after") else null)
        }
        moves += id to asked
        froms += if (!checked) null else from ?: ""
        // A folder gone since: the nearest live folder above it (T43, A757); with no safe place the
        // note stays where it is (422).
        val folderId = if (asked != null && asked !in folders) safePlace(asked) else asked
        if (folderId == REFUSED) {
            return json(JSONObject().put("error", JSONObject().put("code", "folder_not_found").put("message", "No such folder")), 422)
        }
        val note = notes[id] ?: return json(JSONObject().put("error", JSONObject().put("code", "not_found").put("message", "No such note")), 404)
        if (note.deleted) return json(JSONObject().put("error", JSONObject().put("code", "in_trash").put("message", "In Trash")), 409)
        if (checked && note.folderId != folderId && note.folderId != from) {
            return json(JSONObject().put("error", JSONObject().put("code", "note_moved").put("message", "Moved since")), 409)
        }
        if (place != null) {
            val siblings = notes.values.filter { it.folderId == folderId && it.id != id }
                .sortedWith { a, b -> a.position.compareTo(b.position).takeIf { it != 0 } ?: a.id.compareTo(b.id) }.toMutableList()
            val anchor = listOfNotNull(
                place.optString("before", null).takeIf { place.has("before") },
                place.optString("after", null).takeIf { place.has("after") },
            ).firstOrNull { anchor -> siblings.any { it.id == anchor } }
            val at = siblings.indexOfFirst { it.id == anchor }
            val insertAt = when {
                anchor == null -> siblings.size
                place.has("before") -> at
                else -> at + 1
            }
            siblings.add(insertAt.coerceIn(0, siblings.size), note)
            var previous: String? = null
            for (sibling in siblings) {
                previous = OrderKeys.keyBetween(previous, null)
                sibling.position = previous
            }
            lastKey = previous
            note.folderId = folderId
        } else if (note.folderId != folderId) {
            note.folderId = folderId
            note.position = nextKey()
        }
        return json(JSONObject().put("id", id).put("folderId", folderId ?: JSONObject.NULL))
    }

    /**
     * `POST /api/daily` as the server answers it (T40 P5, A144): filed under Journal (restored
     * from Trash when needed), one note with one copy of the template; 201 when made here.
     */
    @Synchronized
    private fun daily(body: JSONObject): MockResponse {
        val date = if (body.isNull("date")) null else body.getString("date")
        val kind = body.getString("period")
        dailyCalls += date to kind
        val id = dailyNoteId?.invoke(date, kind)
        if (id != null) {
            if (notes[id]?.updates.isNullOrEmpty()) dailyBeforeContent += id
            val note = notes.getOrPut(id) { Note(id, "", "e1", clock = ++clock) }
            // A daily note in Trash is restored, filed back under Journal (A144).
            note.deleted = false
            note.kind = kind
            note.period = if (kind == "daily") date else date?.let { isoWeekOf(LocalDate.parse(it)) }
            note.folderId = journalFolder(date, kind)
            note.position = nextKey()
            note.clock = ++clock
        }
        return json(JSONObject().put("id", id ?: "daily-fake").put("created", true))
    }

    /** The ISO week of a day (`2026-W43`), as core's `isoWeek` writes it (T40 P5). */
    private fun isoWeekOf(day: LocalDate): String =
        "%04d-W%02d".format(day.get(IsoFields.WEEK_BASED_YEAR), day.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR))

    /**
     * The Journal folder a daily intent files under (T40 P5): `Journal/<year>/<month>` (or
     * `/Weekly`), made with deterministic ids as the server files them. A null date files at
     * the top level, as an intent that names no day yet would.
     */
    private fun journalFolder(date: String?, kind: String): String? {
        if (date == null) return null
        val year = date.take(4)
        val month = if (kind == "daily") date.substring(5, 7) else "Weekly"
        for ((id, parent, name) in listOf(
            Triple("Journal", null, "Journal"),
            Triple("Journal/$year", "Journal", year),
            Triple("Journal/$year/$month", "Journal/$year", month),
        )) {
            if (id !in folders) folders[id] = FolderState(parent, name, nextKey())
        }
        return "Journal/$year/$month"
    }

    /**
     * `POST /api/notes/:id/trash` as the server answers it (T40 P3a): the deletion and the
     * folder recorded, out of the tree; idempotent; 409 `restored_since` for a request older
     * than the last restore.
     */
    @Synchronized
    private fun trashHere(id: String, body: JSONObject): MockResponse {
        trashCalls += "trash:$id"
        if (trashRouteMissing) {
            // What the real server answers for a route it does not have (trash-route.test.ts).
            return MockResponse.Builder().code(404).addHeader("Content-Type", "text/plain; charset=UTF-8").body("404 Not Found").build()
        }
        // The route's own code for a note it does not have (second review of #94).
        val note = notes[id] ?: return json(JSONObject().put("error", JSONObject().put("code", "note_not_found").put("message", "No such note")), 404)
        updatesWhenTrashed[id] = note.updates.size
        var seq = note.clock
        if (!note.deleted) {
            // Refused only for a restore made by someone else that the phone has not seen.
            val known = body.optLong("knownSeq", Long.MAX_VALUE)
            if (note.restoredSeq >= 0 && note.restoredBy != "phone" && known <= note.restoredSeq) {
                return json(JSONObject().put("error", JSONObject().put("code", "restored_since").put("message", "Restored since")), 409)
            }
            note.deletedFrom = note.folderId
            note.deleted = true
            note.deletedAt = System.currentTimeMillis()
            seq = note.clock
            note.clock = ++clock
        }
        return json(JSONObject().put("folderId", note.deletedFrom ?: JSONObject.NULL).put("deletedAt", note.deletedAt).put("seq", seq))
    }

    /** `POST /api/notes/:id/restore`: out of Trash, answering the folder it was deleted from. */
    @Synchronized
    private fun restoreHere(id: String): MockResponse {
        trashCalls += "restore:$id"
        // As a server from before `note_not_found` answers: the phone still knows it (A431).
        val note = notes[id] ?: return json(JSONObject().put("error", JSONObject().put("code", "not_found").put("message", "No such note")), 404)
        // Where it goes (T43, A757): the folder it was deleted from, or the nearest live one above;
        // with no safe place nothing is restored (409 `restore_needs_folder`).
        val restoredTo = if (note.deleted) safePlace(note.deletedFrom) else note.deletedFrom
        if (restoredTo == REFUSED) {
            return json(
                JSONObject().put("error", JSONObject().put("code", "restore_needs_folder").put("message", "The folder the note was deleted from is gone"))
                    .put("notebook", JSONObject.NULL),
                409,
            )
        }
        val restored = note.deleted
        var seq = note.clock
        if (restored) {
            note.deleted = false
            note.restoredSeq = note.clock
            note.restoredBy = "phone"
            seq = note.clock
            note.clock = ++clock
        }
        return json(JSONObject().put("folderId", restoredTo ?: JSONObject.NULL).put("restored", restored).put("seq", seq))
    }

    @Synchronized
    private fun changes(since: Long): MockResponse {
        val changed = JSONArray()
        notes.values.filter { it.clock > since }.sortedBy { it.clock }.forEach {
            val row = JSONObject().put("id", it.id).put("clock", it.clock).put("seq", it.clock).put("title", it.title)
                .put("updatedAt", it.clock * 1000).put("deleted", it.deleted)
            if (it.kind == "daily" || it.kind == "weekly") {
                row.put("kind", it.kind)
                if (it.period != null) row.put("period", it.period)
            }
            if (!textMissing) row.put("tags", JSONArray(if (it.deleted) emptyList() else it.tags.sorted()))
            changed.put(row)
        }
        return json(JSONObject().put("clock", clock).put("hasMore", false).put("notes", changed))
    }

    @Synchronized
    private fun batch(entries: JSONArray): MockResponse {
        val out = JSONArray()
        for (i in 0 until entries.length()) {
            val entry = entries.getJSONObject(i)
            val first = entry.optJSONArray("update")
            // The folder a first upload names (T43, fix c): recorded; filed only by a server that does.
            val asked = if (entry.has("folderId")) (if (entry.isNull("folderId")) null else entry.getString("folderId")) else NOT_ASKED
            if (asked != NOT_ASKED) uploadFolders += entry.getString("id") to asked
            var filedNow: String? = NOT_ASKED
            // A note made on the phone (T33, T38): its first upload makes it, as the NoteDoc does.
            if (entry.getString("id") !in notes && first != null && first.length() > 0) {
                notes[entry.getString("id")] = Note(entry.getString("id"), "", "e1", clock = ++clock)
                if (filesOnUpload && asked != NOT_ASKED) {
                    // Not in the registry yet: filed there, or the nearest live folder above (A764).
                    val placed = if (asked != null && asked !in folders) safePlace(asked) else asked
                    if (placed != REFUSED) {
                        notes.getValue(entry.getString("id")).apply {
                            folderId = placed
                            position = nextKey()
                        }
                        filedNow = placed
                    }
                }
            }
            val note = notes[entry.getString("id")]
            if (note == null) {
                out.put(JSONObject().put("id", entry.getString("id")).put("update", ""))
                continue
            }
            val cursor = entry.optString("stateVector", "").split(':')
            val held = if (cursor.size == 3 && cursor[1] == note.epoch) cursor[2].toInt() else 0
            val epoch = entry.optString("epoch", "")
            val reply = JSONObject().put("id", note.id).put("epoch", note.epoch)
            if (epoch.isNotEmpty() && epoch != note.epoch) {
                // A restore since: the whole of the new copy, and nothing applied.
                reply.put("error", "Epoch mismatch")
                reply.put("update", reply(note, 0)).put("stateVector", cursorOf(note))
            } else {
                val uploaded = entry.optJSONArray("update")
                if (uploaded != null && note.id in readOnly) {
                    // A sign-in that cannot write (A630's agents, a read token): nothing applied.
                    reply.put("error", "Read-only").put("applied", 0)
                } else if (uploaded != null) {
                    for (j in 0 until uploaded.length()) {
                        uploads += uploaded.getString(j)
                        note.updates += uploaded.getString(j)
                    }
                    reply.put("applied", uploaded.length())
                }
                reply.put("update", reply(note, held)).put("stateVector", cursorOf(note))
            }
            if (filedNow != NOT_ASKED) reply.put("filed", JSONObject().put("folderId", filedNow ?: JSONObject.NULL))
            val textAsked = entry.optBoolean("text", false)
            batchEntries += note.id to textAsked
            if (textAsked) {
                val sentHash = if (entry.has("textHash") && !entry.isNull("textHash")) entry.getString("textHash") else null
                textAsks += note.id to sentHash
                if (!textMissing) {
                    // As the NoteDoc: the hash of the text, a NUL and the headings (core's `noteTextKey`).
                    val text = textOf(note.id)
                    val hash = sha256("$text\u0000${note.headings}")
                    reply.put("textHash", hash)
                    if (hash != sentHash) reply.put("text", text).put("headings", note.headings)
                }
            }
            out.put(reply)
        }
        return json(JSONObject().put("notes", out))
    }

    private fun reply(note: Note, from: Int): String =
        note.updates.drop(from).joinToString(".").also { if (it.isNotEmpty()) replies.getOrPut(note.id) { mutableListOf() } += it }

    private fun cursorOf(note: Note) = "SV:${note.epoch}:${note.updates.size}"

    private fun sha256(text: String): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    private companion object {
        /** [safePlace]'s answer when there is no safe place: never a folder id. */
        const val REFUSED = "\u0000refused"

        /** No `folderId` in a batch entry: never a folder id. */
        const val NOT_ASKED = "\u0000none"
        val FOLDER = Regex("^/api/folders/([A-Za-z0-9_-]+)$")
        val MOVE = Regex("^/api/notes/([A-Za-z0-9_-]+)/move$")
        val TRASH = Regex("^/api/notes/([A-Za-z0-9_-]+)/(trash|restore)$")
    }

    private fun json(body: JSONObject, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body.toString()).build()
}
