package app.penmoss.engine.sync

import app.penmoss.engine.api.BatchEntry
import app.penmoss.engine.api.BatchNoteReply
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/** What one note's `/sync/batch` reply means for the device's store (A280). */
data class ExchangeResult(
    val noteId: String,
    val kind: Kind,
    /** An update to store as synced (the server's reply), or null. */
    val append: String? = null,
    /** Drop every synced update first: the reply holds the whole note. */
    val replaceAllSynced: Boolean = false,
    /** Unconfirmed edits the server now has: drop them (the reply carries them back). */
    val confirmPending: List<Long> = emptyList(),
    /** Unconfirmed edits the server will never take: kept apart, never uploaded again. */
    val conflictPending: List<Long> = emptyList(),
    /** The new cursor (the server's state vector); null leaves it, unless [clearCursor]. */
    val cursor: String? = null,
    val clearCursor: Boolean = false,
    val epoch: String? = null,
    /** The content is current up to this workspace clock; null leaves it. */
    val contentClock: Long? = null,
    /** The server no longer has the note (deleted for good, or restored to before it). */
    val gone: Boolean = false,
    /** Some edits were uploaded and more are waiting: exchange the note again now (A289). */
    val uploadedPart: Boolean = false,
    /** The request asked for the note's text (T40 P6, FD4). */
    val textAsked: Boolean = false,
    /** The server's text, when it differs from the phone's copy; null otherwise. */
    val text: String? = null,
    /** Its headings, with [text]. */
    val headings: String? = null,
    /** The SHA-256 of the server's text (alone: the phone's copy is current); null from an older server. */
    val textHash: String? = null,
    /**
     * The server's words when it refused edits that stay waiting and no retry will clear
     * ("Read-only", T42 on Android, A651): sync has stopped for this note, as the web's catch-up
     * says (A582). Null otherwise: no error, a transient one, or edits kept apart for good.
     */
    val refused: String? = null,
    /**
     * The upload filed the note (T43, fix c): [Filed.asked] is the folder the request named,
     * [Filed.landed] where the server put it. Null when not: the phone's filer files it as before.
     */
    val filed: Filed? = null,
) {
    data class Filed(val asked: String?, val landed: String?)

    enum class Kind {
        /** Merged: the store now holds what the server has. */
        APPLIED,

        /** The server was restored since (A5): its whole note replaces the copy here. */
        RESET,

        /** The note is gone from the server. */
        GONE,

        /** Nothing stored; ask again later (deferred, or the note's object was unavailable). */
        RETRY,
    }
}

object Exchange {
    /** Batch errors the server sends (apps/server/src/do/note-doc.ts). */
    const val EPOCH_MISMATCH = "Epoch mismatch"
    const val GONE = "Gone"
    const val READ_ONLY = "Read-only"
    const val MALFORMED_STATE_VECTOR = "Malformed state vector"

    /** A note's object that failed this time (A268): the next exchange tries again. */
    const val UNAVAILABLE = "Unavailable"

    /** Uploads the server refuses for good: retrying would fail the same way. */
    private val REFUSED_FOR_GOOD = setOf("Malformed update", "Client id belongs to another actor")

    /** Past this many stored updates, ask for the whole note once and keep just that. */
    const val REBASELINE_AT = 64

    /** Uploads per note in one request: the server refuses a longer list (`BATCH_MAX_UPDATES`). */
    const val MAX_UPDATES = 200

    /**
     * Base64 characters of uploads per note in one request, so one request stays well
     * under the server's 16 MB limit. The rest go in the next exchange (A289).
     */
    const val MAX_UPLOAD_CHARS = 4 * 1024 * 1024

    /** An edit made on a copy the server has since replaced (A5, A291): never uploaded. */
    fun isStale(edit: StoredUpdate, content: NoteContent): Boolean =
        edit.epoch != null && content.epoch != null && edit.epoch != content.epoch

    /**
     * The batch entry for a note: its cursor (none: the whole note) and its oldest
     * unconfirmed edits, at most [maxUpdates] of them and [MAX_UPLOAD_CHARS] (but
     * always one), in order. Edits from before a restore are left out.
     */
    fun entry(content: NoteContent, maxUpdates: Int = MAX_UPDATES, withText: Boolean = false): BatchEntry {
        val whole = content.cursor == null || content.syncedIds.size > REBASELINE_AT
        val uploads = mutableListOf<String>()
        var chars = 0L
        for (edit in content.pending) {
            if (isStale(edit, content)) continue
            if (uploads.size >= maxUpdates) break
            if (uploads.isNotEmpty() && chars + edit.update.length > MAX_UPLOAD_CHARS) break
            uploads += edit.update
            chars += edit.update.length
        }
        return BatchEntry(
            id = content.noteId,
            stateVector = if (whole) null else content.cursor,
            update = uploads.takeIf { it.isNotEmpty() },
            epoch = content.epoch,
            text = true.takeIf { withText },
            textHash = content.textHash.takeIf { withText },
            // The first upload of a note made here names its folder (T43, fix c).
            folderId = content.fileOnUpload?.takeIf { uploads.isNotEmpty() }?.let { into ->
                into.folderId?.let(::JsonPrimitive) ?: JsonNull
            },
        )
    }

    /** The folder [entry] asked to file the note in, or null when it asked none ([asked] false). */
    private fun askedFolder(request: BatchEntry): Pair<Boolean, String?> = when (val folder = request.folderId) {
        null -> false to null
        is JsonPrimitive -> true to folder.takeIf { it !is JsonNull }?.content
        else -> false to null
    }

    /** The pending edits [entry] put in the request, in order. */
    fun sentEdits(content: NoteContent, request: BatchEntry): List<Long> =
        content.pending.filterNot { isStale(it, content) }.take(request.update?.size ?: 0).map { it.id }

    /** Reads one note's reply against what was sent, with its text when the request asked (FD4). */
    fun decide(sent: NoteContent, request: BatchEntry, reply: BatchNoteReply): ExchangeResult {
        val content = decideContent(sent, request, reply)
        // Filed by this upload (T43, fix c): only when it asked, and the server says where.
        val (asked, folder) = askedFolder(request)
        val decided = if (asked && reply.filed != null && content.kind == ExchangeResult.Kind.APPLIED) {
            content.copy(filed = ExchangeResult.Filed(folder, reply.filed.folderId))
        } else {
            content
        }
        if (request.text != true) return decided
        val carries = decided.kind == ExchangeResult.Kind.APPLIED || decided.kind == ExchangeResult.Kind.RESET
        return decided.copy(
            textAsked = true,
            text = reply.text.takeIf { carries },
            headings = (reply.headings ?: "").takeIf { carries && reply.text != null },
            textHash = reply.textHash.takeIf { carries },
        )
    }

    private fun decideContent(sent: NoteContent, request: BatchEntry, reply: BatchNoteReply): ExchangeResult {
        val id = sent.noteId
        // Only what this request carried: later edits wait for the next exchange (A289).
        val pending = sentEdits(sent, request)
        // Edits from before a restore are kept apart whatever the reply (A291).
        val stale = sent.pending.filter { isStale(it, sent) }.map { it.id }
        // Every edit made on the copy a restore replaced: the sent ones, the stale ones, and any not sent yet.
        val allPending = sent.pending.map { it.id }
        val whole = request.stateVector == null
        val append = reply.update.takeIf { it.isNotEmpty() }
        if (reply.deferred) {
            return if (stale.isEmpty()) ExchangeResult(id, ExchangeResult.Kind.RETRY)
            else ExchangeResult(id, ExchangeResult.Kind.RETRY, conflictPending = stale)
        }
        return when (val error = reply.error) {
            null -> {
                if (reply.epoch == null && append == null) {
                    // The server has no such note and nothing was uploaded: nothing to hold yet.
                    ExchangeResult(id, ExchangeResult.Kind.APPLIED, contentClock = sent.clock)
                } else {
                    ExchangeResult(
                        id,
                        ExchangeResult.Kind.APPLIED,
                        append = append,
                        replaceAllSynced = whole,
                        confirmPending = pending,
                        conflictPending = stale,
                        cursor = reply.stateVector,
                        epoch = reply.epoch,
                        contentClock = sent.clock,
                    )
                }
            }
            EPOCH_MISMATCH -> ExchangeResult(
                id,
                ExchangeResult.Kind.RESET,
                append = append,
                replaceAllSynced = true,
                conflictPending = allPending,
                cursor = reply.stateVector,
                clearCursor = reply.stateVector == null,
                epoch = reply.epoch,
                contentClock = sent.clock,
            )
            GONE -> ExchangeResult(
                id,
                ExchangeResult.Kind.GONE,
                replaceAllSynced = true,
                conflictPending = allPending,
                clearCursor = true,
                gone = true,
                contentClock = sent.clock,
            )
            // The upload was applied (or there was none); the state vector was bad, so the
            // reply is the whole note.
            MALFORMED_STATE_VECTOR -> ExchangeResult(
                id,
                ExchangeResult.Kind.APPLIED,
                append = append,
                replaceAllSynced = true,
                confirmPending = pending.take(reply.applied ?: pending.size),
                conflictPending = stale,
                cursor = reply.stateVector,
                epoch = reply.epoch,
                contentClock = sent.clock,
            )
            else -> when {
                append == null && reply.stateVector == null ->
                    // Nothing came back (the note's object failed): try again later.
                    ExchangeResult(id, ExchangeResult.Kind.RETRY)
                // The server's side came back, but it did not take the upload, or not all of it:
                // it applied the first `applied` (A289) and refused the next; later ones were
                // not tried and stay pending. A server that does not say refused them all.
                else -> ExchangeResult(
                    id,
                    ExchangeResult.Kind.APPLIED,
                    append = append,
                    replaceAllSynced = whole,
                    confirmPending = pending.take(reply.applied ?: 0),
                    conflictPending = stale + when {
                        error !in REFUSED_FOR_GOOD -> emptyList()
                        reply.applied == null -> pending
                        else -> listOfNotNull(pending.getOrNull(reply.applied))
                    },
                    cursor = reply.stateVector,
                    epoch = reply.epoch,
                    // Read-only or a transient failure: the edits stay due, so the note does too.
                    contentClock = if (error == READ_ONLY) sent.clock else null,
                    // Edits still waiting that the next pass would send to the same refusal (A651).
                    refused = error.takeIf { it != UNAVAILABLE && it !in REFUSED_FOR_GOOD && pending.size > (reply.applied ?: 0) },
                )
            }
        }
    }
}
