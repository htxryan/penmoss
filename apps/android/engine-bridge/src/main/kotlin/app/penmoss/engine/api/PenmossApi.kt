package app.penmoss.engine.api

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resumeWithException
import okio.BufferedSink
import okio.source

/**
 * What the app asks of a git notebook's notes server (A874): the engine page answers these routes
 * on the phone, in the shapes the Penmoss server used (T59: the server and its sign-in are gone).
 */
interface PenmossApi {
    suspend fun changes(since: Long): ChangesPage

    suspend fun batch(notes: List<BatchEntry>): BatchReply

    suspend fun tree(since: String?): SyncTree

    /**
     * `GET /api/search` (T22, T23): [mode], [filters] (T40 P6, FD2, FD3), the last word a
     * prefix (search as you type), and [partial] when that word is still being typed.
     */
    suspend fun search(
        query: String,
        limit: Int = 30,
        mode: SearchMode = SearchMode.FULL_TEXT,
        filters: SearchFilters = SearchFilters(),
        partial: Boolean = false,
    ): SearchReply

    /**
     * Files a daily or weekly note in the Journal (`POST /api/daily`, T40 P5): `{ date?, period }`,
     * where `date` is an explicit day (a calendar tap) or null for today in the user's time
     * zone setting, and `period` is `daily` or `weekly`. The server files it under
     * `Journal/<year>/<month>` (or `/Weekly`) and creates or merges it with A144 semantics:
     * one note, one copy of the template; a daily note in Trash is restored.
     */
    suspend fun dailyNote(date: String?, period: String): DailyNoteRef

    /**
     * Every tag in the workspace with how many notes carry it (`GET /api/tags`, T18), from the
     * server's index: the suggestions the tag sheet offers (T38). Tags themselves live in each
     * note's document, which only the editor page reads.
     */
    suspend fun tags(): List<TagCount>

    /**
     * Renames a tag, or merges it into another, in every note that has it (`POST /api/tags/rename`,
     * T24; T40 P6, TG3): the server rewrites each note through its own document, in the background,
     * and the phone gets the changes by sync like any other edit. [noteIds]: the notes this phone
     * holds with the tag, so the rename covers them whatever the server's index says. Refused with
     * the server's message (400 an invalid tag or one moved inside itself, 422 too many notes,
     * 429 too many renames running).
     */
    suspend fun renameTag(from: String, to: String, noteIds: List<String>): TagRenameReply

    /**
     * Files a note in a folder (null: the top level): a note made on the phone (a link's
     * new note, a conflict copy) joins the workspace's tree once it is uploaded (A303). With
     * [from], only if the note is still in that folder (or already in [folderId]): one moved
     * since is refused, 409 `note_moved` (A359). With [place] (T40 P4, NT7), the note also
     * takes its manual order from the server's live document; a missing anchor means the end.
     * A note in Trash is refused, 409 `in_trash`. A folder gone since (T43, A757: fail closed):
     * the server files it in the nearest folder above it within its notebook and answers that
     * folder ([FiledNote.folderId]), never the default notebook's top level for a notebook's
     * note; a note already filed with no safe place is 422 `folder_not_found` and stays put.
     */
    suspend fun moveNote(
        noteId: String,
        folderId: String?,
        from: InFolder? = null,
        place: NotePlace? = null,
        /** The notebook the phone saw the note in when it was moved, `default` for the default (T43, A766). */
        fromNotebook: String? = null,
    ): FiledNote

    /**
     * Makes a folder (`POST /api/folders`, T40 P4, NT2): [id] is this phone's ULID, so a retry
     * answers the folder it made. A parent gone since (A352, T43 A757: fail closed): the server
     * makes it in the nearest folder above within the same notebook (the reply's `parentId`), or
     * in Trash with its deleted notebook ([FolderRef.inTrash]); 422 `folder_not_found` only when
     * there is no safe place, and the phone drops it. [notebook] makes a notebook (T43, A750): at
     * the top level only (422 otherwise).
     */
    suspend fun createFolder(id: String, name: String, parentId: String?, notebook: Boolean = false): FolderRef

    /**
     * Renames, moves, sorts and reorders a folder (`PATCH /api/folders/:id`, T40 P4, NT3–NT7).
     * A change overtaken elsewhere is refused (409 `folder_changed` or `folder_moved`), and a
     * move into the folder itself or a subfolder is 422 `folder_cycle`. A move into a parent
     * gone since goes to the nearest folder above it within its notebook (the reply's
     * `parentId`, T43 A757), or is 422 `folder_not_found` with no safe place: the folder stays.
     */
    suspend fun patchFolder(id: String, patch: FolderPatch): FolderRef

    /** The top level's sort mode (`PATCH /api/folders/root`, T40 P4, NT6). */
    suspend fun setRootSortMode(sortMode: String)

    /**
     * Renames the default notebook (`PATCH /api/folders/root { notebookName }`, T43, A751): an
     * empty name gives back "Personal". Answers the name the server now has.
     */
    suspend fun setDefaultNotebookName(name: String): String

    /**
     * Deletes a folder and its subfolders (`DELETE /api/folders/:id`, T40 P4, NT4): their notes
     * move up. A notebook goes to Trash with its notes instead (T43, A755). Idempotent: a missing
     * folder answers false.
     */
    suspend fun deleteFolder(id: String): Boolean

    /**
     * Moves a note to Trash (`POST /api/notes/:id/trash`, T40 P3a, NT12): the server records
     * the deletion in the note's document as a device's own would, and takes the note out of the
     * tree; the content stays on the server. [knownSeq] is the newest index seq this phone has
     * seen for the note: a restore made elsewhere after it wins, 409 `restored_since`. No clock
     * is sent. Idempotent.
     */
    suspend fun trashNote(noteId: String, knownSeq: Long): TrashedNote

    /**
     * Takes a note out of Trash (`POST /api/notes/:id/restore`, T21): the folder it was deleted
     * from, which the phone files it back in (null: the top level, or not recorded), whether it
     * was in Trash, and the index seq the restore was made after. [into] is the person's choice
     * of folder (T43, A757; `InFolder(null)`: the top level), sent as `{ folderId }`. Without it,
     * a note whose folder is gone and whose way up passes a deleted notebook (or one Trash forgot)
     * is not restored: 409 `restore_needs_folder`, with the notebook in [ApiException.notebook],
     * and the app asks where it goes.
     */
    suspend fun restoreNote(noteId: String, into: InFolder? = null): RestoredNote

    /** Notes in Trash, newest deletion first (`GET /api/trash`, T21). */
    suspend fun trash(): List<TrashListed>

    /** Deleted folders in Trash, newest first (`GET /api/folders/trash`, T40 P9, NT25). */
    suspend fun folderTrash(): List<TrashedFolderListed>

    /**
     * Restores a folder from Trash with its subfolders and notes (`POST /api/folders/:id/restore`).
     * Its parent gone, it comes back in the nearest folder above within its notebook; when the
     * way up passes a deleted notebook nothing is restored: 409 `restore_needs_folder` with that
     * notebook in [ApiException.notebook] (T43, A757), to restore first.
     */
    suspend fun restoreFolder(id: String): RestoredFolder

    /** What agent tokens changed in the last 30 days, newest first (`GET /api/agent-activity`, AC11). */
    suspend fun agentActivity(): List<AgentActivityEntry>

    /**
     * Undoes an agent's change as this person's (`POST /api/agent-activity/:id/undo`, AC11); a
     * 409 `changed_since` [ApiException] says what changed since, and nothing was changed.
     */
    suspend fun undoAgentActivity(id: Long): ActivityUndone

    /**
     * A note's versions, newest first (`GET /api/notes/:id/versions`, T21; T40 P3b, NT16):
     * each with its time, authors (device or agent) and summary. Read scope.
     */
    suspend fun history(noteId: String): NoteHistory

    /** One version's markdown and its line diff against the version before it (NT17). Read scope. */
    suspend fun versionDetail(noteId: String, version: Long): VersionDetail

    /**
     * The notes linking to a note and those mentioning [title] without a link
     * (`GET /api/notes/:id/backlinks`, T16; T40 P7, LK5, LK6). [title] is the title as the phone
     * has it, which can be newer than the index. Read scope.
     */
    suspend fun backlinks(noteId: String, title: String): BacklinksReply

    /**
     * Brings a version's content back as a new change (`POST …/versions/:version/restore`, NT18;
     * the epoch stays, so pending edits merge as usual). Write scope.
     */
    suspend fun restoreVersion(noteId: String, version: Long): RestoredVersion

    /**
     * Undoes what a version changed (`POST …/versions/:version/revert`, NT19): a three-way merge
     * keeping later edits, reporting overlaps. Write scope.
     */
    suspend fun revertVersion(noteId: String, version: Long): RevertedVersion

    /**
     * Saves the note's current state as a version now (`POST …/versions`, NT20). Answers 201.
     * Write scope.
     */
    suspend fun saveVersion(noteId: String)

    /**
     * Uploads a picture or a file (`PUT /api/attachments/:sha256`, A304, T13). The server checks
     * the bytes against the hash and sniffs the type; `noteId` records where it was first used,
     * and `ext` the extension of a file that is not a picture or a PDF (T40 P8, ED12). The file
     * is streamed, never read whole (review PS2). A failure once its bytes had started going out
     * is [UploadInterrupted]: the upload was tried, not the phone offline.
     */
    suspend fun putAttachment(sha256: String, file: File, noteId: String?, ext: String? = null)

    /**
     * A stored file's size (`HEAD /api/attachments/:sha256`, no bytes), as the web's chips ask
     * for a file added elsewhere (review PS3); null when the server has no such file.
     */
    suspend fun attachmentSize(sha256: String): Long?

    /** A picture's bytes (`GET /api/attachments/:sha256`), for the editor to show. */
    suspend fun attachment(sha256: String): ByteArray

    /**
     * Saves a quick capture the phone stored, possibly while offline (`POST /api/capture`,
     * T34, A335): the server adds it to the day's note or a new Inbox note as the apps do. A
     * retry with the same id adds nothing.
     */
    suspend fun capture(request: CaptureRequest): CaptureReply

    /**
     * Changes the user's synced settings (`PUT /api/settings`, T40 P1, A410), as the web's
     * Settings does in the WorkspaceDoc. Refused with 409 `setting_changed` when one was
     * changed elsewhere since its base, naming those in [ApiException.keys].
     */
    suspend fun putSettings(change: SettingsChange): SettingsReply
}

/**
 * Deletes a note in Trash for good (`DELETE /api/notes/:id`, T40 P3a, NT15; A83). In a git
 * notebook the engine page asks the person first, in the notebook's own words (A877).
 */
interface PenmossPurgeApi {
    suspend fun purgeNote(noteId: String)
}

/** An upload cut short after its bytes had started going out (a slow uplink's timeout): an attempt, not offline (review PS2). */
class UploadInterrupted(cause: IOException) : IOException("The upload was cut short", cause)

/**
 * A reply other than 2xx: the status and the API's `error.code`, and the settings `error.keys`
 * names (a settings change refused, A410).
 */
class ApiException(
    val status: Int,
    val code: String?,
    message: String,
    val keys: List<String> = emptyList(),
    /** The settings as the server holds them, sent with a refused settings change (A410). */
    val settings: JsonObject? = null,
    /**
     * The notebook a 409 `restore_needs_folder` names (T43, A757): the deleted notebook the note
     * or folder was in, to restore first; null when Trash no longer knows it.
     */
    val notebook: NotebookRef? = null,
) : IOException(message) {
    /** A 401: the sync stops its pass and tries again later (no notes server on the phone asks for one). */
    val unauthorized: Boolean get() = status == 401

    /**
     * The server says the note itself is not there (deleted for good, or never there): only a
     * positive match, `note_not_found` from the Trash routes (T40 P3a) or an older server's
     * `not_found` "No such note". Any other 404 says nothing about the note, so nothing is
     * dropped for it (second review of #94): a proxy's page, or a route the server does not have,
     * which it answers with Hono's plain "404 Not Found" (its JSON catch-all is never reached).
     */
    val noSuchNote: Boolean
        get() = status == 404 && message == NO_SUCH_NOTE && (code == NOTE_NOT_FOUND || code == NOT_FOUND)

    companion object {
        /** What the server says for a note it does not have. */
        const val NO_SUCH_NOTE = "No such note"

        /** The Trash routes' code for a note the server does not have (T40 P3a, A431). */
        const val NOTE_NOT_FOUND = "note_not_found"

        const val NOT_FOUND = "not_found"
    }
}

class HttpPenmossApi(
    private val apiOrigin: HttpUrl,
    private val client: OkHttpClient,
) : PenmossApi, PenmossPurgeApi, PenmossCommentsApi {
    constructor(apiOrigin: String, client: OkHttpClient) : this(apiOrigin.toHttpUrl(), client)

    private suspend fun sendEmpty(request: Request) = call(request) { response ->
        if (!response.isSuccessful) throw errorOf(response, response.body.string())
    }

    override suspend fun changes(since: Long): ChangesPage =
        get(url("sync/changes") { addQueryParameter("since", since.toString()) }, ChangesPage.serializer())

    override suspend fun batch(notes: List<BatchEntry>): BatchReply =
        send("POST", url("sync/batch"), json(BatchRequest.serializer(), BatchRequest(notes)), BatchReply.serializer())

    override suspend fun tree(since: String?): SyncTree =
        get(url("sync/tree") { if (since != null) addQueryParameter("since", since) }, SyncTree.serializer())

    override suspend fun search(query: String, limit: Int, mode: SearchMode, filters: SearchFilters, partial: Boolean): SearchReply =
        get(
            url("api/search") {
                addQueryParameter("q", query)
                addQueryParameter("limit", limit.toString())
                addQueryParameter("mode", mode.wire)
                addQueryParameter("prefix", "1")
                if (partial) addQueryParameter("partial", "1")
                filters.folderId?.let { addQueryParameter("folder", it) }
                filters.tag?.let { addQueryParameter("tag", it) }
                filters.updatedAfter?.let { addQueryParameter("after", it.toString()) }
                filters.notebooks?.let { addQueryParameter("notebooks", it.joinToString(",")) }
            },
            SearchReply.serializer(),
        )

    override suspend fun dailyNote(date: String?, period: String): DailyNoteRef =
        send(
            "POST",
            url("api/daily"),
            buildJsonObject {
                if (date != null) put("date", date)
                put("period", period)
            }.toString().toRequestBody(JSON_TYPE),
            DailyNoteRef.serializer(),
        )

    override suspend fun capture(request: CaptureRequest): CaptureReply =
        send("POST", url("api/capture"), json(CaptureRequest.serializer(), request), CaptureReply.serializer())

    override suspend fun tags(): List<TagCount> = get(url("api/tags"), TagList.serializer()).tags

    override suspend fun renameTag(from: String, to: String, noteIds: List<String>): TagRenameReply {
        val body = buildJsonObject {
            put("from", from)
            put("to", to)
            put("noteIds", JsonArray(noteIds.map(::JsonPrimitive)))
        }
        return send("POST", url("api/tags/rename"), body.toString().toRequestBody(JSON_TYPE), TagRenameReply.serializer())
    }

    override suspend fun putSettings(change: SettingsChange): SettingsReply =
        send("PUT", url("api/settings"), json(SettingsChange.serializer(), change), SettingsReply.serializer())

    /**
     * A git notebook's device map (A1014): `GET /android/device-settings` on its notes server in
     * the engine page, never the Penmoss server. The device's settings when it is the Journal
     * notebook and there is no account.
     */
    suspend fun deviceSettings(): DeviceSettingsReply = get(url("android/device-settings"), DeviceSettingsReply.serializer())

    /**
     * Changes the device's settings in a git notebook's device map (A1014): `PUT
     * /android/device-settings` `{ set }`, a null removing one. Answers the map after the change.
     */
    suspend fun changeDeviceSettings(set: JsonObject): DeviceSettingsReply =
        send("PUT", url("android/device-settings"), JsonObject(mapOf("set" to set)).toString().toRequestBody(JSON_TYPE), DeviceSettingsReply.serializer())

    /**
     * Send to…'s sessions (T60, A1076): `GET /android/agent-sessions` on the notebook's notes
     * server in the engine page, read from the notebook's WorkspaceDoc.
     */
    override suspend fun agentSessions(): AgentSessionList = get(url("android/agent-sessions"), AgentSessionList.serializer())

    override suspend fun moveNote(noteId: String, folderId: String?, from: InFolder?, place: NotePlace?, fromNotebook: String?): FiledNote {
        // `folderId` is sent even when null, which files the note at the top level; so is
        // `fromFolderId` when there is one, null meaning the top level.
        val body = buildJsonObject {
            put("folderId", folderId?.let(::JsonPrimitive) ?: JsonNull)
            if (from != null) put("fromFolderId", from.folderId?.let(::JsonPrimitive) ?: JsonNull)
            fromNotebook?.let { put("fromNotebook", it) }
            if (place != null) {
                put("place", buildJsonObject {
                    place.before?.let { put("before", it) }
                    place.after?.let { put("after", it) }
                })
            }
        }
        val reply = send("POST", url("api/notes/$noteId/move"), body.toString().toRequestBody(JSON_TYPE), JsonObject.serializer())
        // The folder the server filed it in (a gone folder's safe place, T43 A757); an older
        // server does not say, and filed it where asked.
        val used = reply["folderId"] ?: return FiledNote(folderId)
        return FiledNote(if (used is JsonNull) null else used.jsonPrimitive.content)
    }

    override suspend fun createFolder(id: String, name: String, parentId: String?, notebook: Boolean): FolderRef {
        val body = buildJsonObject {
            put("id", id)
            put("name", name)
            put("parentId", parentId?.let(::JsonPrimitive) ?: JsonNull)
            if (notebook) put("notebook", true)
        }
        return send("POST", url("api/folders"), body.toString().toRequestBody(JSON_TYPE), FolderRef.serializer())
    }

    override suspend fun patchFolder(id: String, patch: FolderPatch): FolderRef {
        val from = buildJsonObject {
            if (patch.checkName) put("name", patch.fromName ?: "")
            if (patch.checkParent) put("parentId", patch.fromParentId?.let(::JsonPrimitive) ?: JsonNull)
        }
        val body = buildJsonObject {
            patch.name?.let { put("name", it) }
            if (patch.changeParent) put("parentId", patch.parentId?.let(::JsonPrimitive) ?: JsonNull)
            if (patch.changeParent) patch.fromNotebook?.let { put("fromNotebook", it) }
            patch.sortMode?.let { put("sortMode", it) }
            patch.notebook?.let { put("notebook", it) }
            if (from.isNotEmpty()) put("from", from)
            patch.place?.let { place ->
                put("place", buildJsonObject {
                    place.before?.let { put("before", it) }
                    place.after?.let { put("after", it) }
                })
            }
        }
        return send("PATCH", url("api/folders/$id"), body.toString().toRequestBody(JSON_TYPE), FolderRef.serializer())
    }

    override suspend fun setRootSortMode(sortMode: String) {
        val body = buildJsonObject { put("sortMode", sortMode) }
        sendEmpty(request(url("api/folders/root")).method("PATCH", body.toString().toRequestBody(JSON_TYPE)).build())
    }

    override suspend fun setDefaultNotebookName(name: String): String {
        val body = buildJsonObject { put("notebookName", name) }
        return send("PATCH", url("api/folders/root"), body.toString().toRequestBody(JSON_TYPE), RootReply.serializer()).notebookName ?: name
    }

    @Serializable
    private data class RootReply(val notebookName: String? = null)

    override suspend fun deleteFolder(id: String): Boolean {
        val reply = send("DELETE", url("api/folders/$id"), "{}".toRequestBody(JSON_TYPE), FolderDeleted.serializer())
        return reply.deleted
    }

    @Serializable
    private data class FolderDeleted(val deleted: Boolean = false)

    override suspend fun trashNote(noteId: String, knownSeq: Long): TrashedNote =
        send("POST", url("api/notes/$noteId/trash"), json(TrashRequest.serializer(), TrashRequest(knownSeq)), TrashedNote.serializer())

    override suspend fun restoreNote(noteId: String, into: InFolder?): RestoredNote {
        val body = if (into == null) "{}" else buildJsonObject { put("folderId", into.folderId?.let(::JsonPrimitive) ?: JsonNull) }.toString()
        return send("POST", url("api/notes/$noteId/restore"), body.toRequestBody(JSON_TYPE), RestoredNote.serializer())
    }

    override suspend fun trash(): List<TrashListed> = get(url("api/trash"), TrashList.serializer()).notes

    override suspend fun folderTrash(): List<TrashedFolderListed> =
        get(url("api/folders/trash"), FolderTrashList.serializer()).folders

    override suspend fun restoreFolder(id: String): RestoredFolder =
        send("POST", url("api/folders/$id/restore"), "{}".toRequestBody(JSON_TYPE), RestoredFolder.serializer())

    override suspend fun agentActivity(): List<AgentActivityEntry> =
        get(url("api/agent-activity"), AgentActivityList.serializer()).entries

    override suspend fun undoAgentActivity(id: Long): ActivityUndone =
        send("POST", url("api/agent-activity/$id/undo"), "{}".toRequestBody(JSON_TYPE), ActivityUndone.serializer())

    override suspend fun history(noteId: String): NoteHistory =
        get(url("api/notes/$noteId/versions"), NoteHistory.serializer())

    override suspend fun backlinks(noteId: String, title: String): BacklinksReply =
        get(
            url("api/notes/$noteId/backlinks") { addQueryParameter("title", title) },
            BacklinksReply.serializer(),
        )

    override suspend fun versionDetail(noteId: String, version: Long): VersionDetail =
        get(url("api/notes/$noteId/versions/$version"), VersionDetail.serializer())

    override suspend fun restoreVersion(noteId: String, version: Long): RestoredVersion =
        send("POST", url("api/notes/$noteId/versions/$version/restore"), "{}".toRequestBody(JSON_TYPE), RestoredVersion.serializer())

    override suspend fun revertVersion(noteId: String, version: Long): RevertedVersion =
        send("POST", url("api/notes/$noteId/versions/$version/revert"), "{}".toRequestBody(JSON_TYPE), RevertedVersion.serializer())

    override suspend fun saveVersion(noteId: String) {
        sendEmpty(request(url("api/notes/$noteId/versions")).post("{}".toRequestBody(JSON_TYPE)).build())
    }

    override suspend fun purgeNote(noteId: String) {
        sendEmpty(request(url("api/notes/$noteId")).delete().build())
    }

    @Serializable
    private data class TrashRequest(val knownSeq: Long)

    override suspend fun putAttachment(sha256: String, file: File, noteId: String?, ext: String?) {
        val target = url("api/attachments/$sha256") {
            if (noteId != null) addQueryParameter("note", noteId)
            if (ext != null) addQueryParameter("ext", ext)
        }
        val started = AtomicBoolean(false)
        // Streamed from the file (review PS2), with its length, which the server checks.
        val body = object : RequestBody() {
            override fun contentType() = OCTET_STREAM

            override fun contentLength() = file.length()

            override fun writeTo(sink: BufferedSink) {
                started.set(true)
                file.source().use { sink.writeAll(it) }
            }
        }
        val request = request(target).put(body).build()
        try {
            call(request) { response ->
                if (!response.isSuccessful) throw errorOf(response, response.body.string())
            }
        } catch (error: ApiException) {
            throw error
        } catch (error: IOException) {
            throw if (started.get()) UploadInterrupted(error) else error
        }
    }

    override suspend fun attachmentSize(sha256: String): Long? {
        val request = request(url("api/attachments/$sha256")).head().build()
        return call(request) { response ->
            when {
                response.code == 404 -> null
                !response.isSuccessful -> throw errorOf(response, "")
                else -> response.header("Content-Length")?.toLongOrNull()?.takeIf { it >= 0 }
            }
        }
    }

    override suspend fun attachment(sha256: String): ByteArray {
        val request = request(url("api/attachments/$sha256")).header("Accept", "*/*").get().build()
        return call(request) { response ->
            if (!response.isSuccessful) throw errorOf(response, response.body.string())
            response.body.bytes()
        }
    }

    private fun url(path: String, query: HttpUrl.Builder.() -> Unit = {}): HttpUrl =
        apiOrigin.newBuilder().addPathSegments(path).apply(query).build()

    private fun request(url: HttpUrl): Request.Builder = Request.Builder().url(url).header("Accept", "application/json")

    private fun <T> json(serializer: KSerializer<T>, value: T): RequestBody =
        PenmossJson.encodeToString(serializer, value).toRequestBody(JSON_TYPE)

    private suspend fun <T> get(url: HttpUrl, serializer: KSerializer<T>): T =
        execute(request(url).get().build(), serializer)

    private suspend fun <T> send(
        method: String,
        url: HttpUrl,
        body: RequestBody,
        serializer: KSerializer<T>,
    ): T = execute(request(url).method(method, body).build(), serializer)

    private suspend fun <T> execute(request: Request, serializer: KSerializer<T>): T =
        call(request) { response ->
            val text = response.body.string()
            if (!response.isSuccessful) throw errorOf(response, text)
            PenmossJson.decodeFromString(serializer, text)
        }

    /**
     * Runs [request], reading its response with [read] on OkHttp's thread. Cancelling the
     * coroutine cancels the call at once (A329): a background run WorkManager stops does not
     * wait for a slow request to end.
     */
    private suspend fun <R> call(request: Request, read: (Response) -> R): R =
        suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)

                    override fun onResponse(call: Call, response: Response) =
                        continuation.resumeWith(runCatching { response.use(read) })
                },
            )
        }

    private fun errorOf(response: Response, text: String): ApiException {
        val status = response.code
        val body = runCatching { PenmossJson.parseToJsonElement(text).jsonObject }.getOrNull()
        val error = runCatching { body?.get("error")?.jsonObject }.getOrNull()
        val code = error?.get("code")?.jsonPrimitive?.content
        val message = error?.get("message")?.jsonPrimitive?.content ?: "HTTP $status"
        val keys = runCatching { error?.get("keys")?.jsonArray?.map { it.jsonPrimitive.content } }.getOrNull().orEmpty()
        val settings = body?.get("settings") as? JsonObject
        val notebook = runCatching { (body?.get("notebook") as? JsonObject)?.let { PenmossJson.decodeFromJsonElement(NotebookRef.serializer(), it) } }.getOrNull()
        return ApiException(status, code, message, keys, settings, notebook)
    }

    private companion object {
        val JSON_TYPE = "application/json".toMediaType()
        val OCTET_STREAM = "application/octet-stream".toMediaType()
    }
}
