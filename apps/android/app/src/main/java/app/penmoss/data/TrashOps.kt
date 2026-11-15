package app.penmoss.data

import androidx.room.withTransaction
import kotlinx.coroutines.flow.Flow

/**
 * Trash (T40 P3a, NT12–NT15, A430): moves to Trash and restores made here, held until the server
 * and then its index agree; and notes deleted for good, their unsent edits kept apart for a
 * conflict copy (A306, A310).
 */
class TrashOps(
    private val db: PenmossDatabase,
    private val now: () -> Long,
    private val placement: NotePlacement,
) {
    private val notes = db.notes()
    private val updates = db.updates()
    private val search = db.search()

    // --- Trash (T40 P3a, NT12–NT15, A430) ---

    /**
     * Moves a note to Trash on this phone: it leaves every list at once, offline too, and the
     * server is asked (`POST /api/notes/:id/trash`) by a later pass, once the note's own edits
     * have gone. False for a note the phone does not list.
     */
    suspend fun moveToTrash(noteId: String): Boolean = db.withTransaction {
        val note = notes.note(noteId) ?: return@withTransaction false
        if (note.deleted || note.gone) return@withTransaction false
        notes.trashHere(noteId, now())
        true
    }

    /** What [restoreFromTrash] did. */
    enum class Restore {
        /** A move to Trash never tried: cancelled, so the server never knew. */
        CANCELLED,

        /** Restored here; the server is asked next, then the note is filed where it was. */
        QUEUED,

        /** Not in Trash (restored already), or deleted for good. */
        NOT_IN_TRASH,
    }

    /**
     * Takes a note out of Trash on this phone (NT14): back in the lists at once. A note the
     * phone only knows from the server's Trash ([title]) is added, to fetch once restored.
     */
    suspend fun restoreFromTrash(noteId: String, title: String = ""): Restore = db.withTransaction {
        val note = notes.note(noteId)
        if (note == null) notes.insertIgnore(NoteEntity(noteId, title = title, deleted = true))
        else if (!note.deleted || note.gone) return@withTransaction Restore.NOT_IN_TRASH
        // Tried with no answer: the server may have it in Trash, so a restore is queued (A430).
        val cancelled = note?.trashChange == NoteEntity.TRASH_QUEUED && !note.trashTried
        notes.restoreHere(noteId, now())
        if (cancelled) Restore.CANCELLED else Restore.QUEUED
    }

    /** Moves to Trash to send now: those whose own edits and move have all gone first. */
    suspend fun trashesDue(): List<NoteEntity> = notes.trashesDue()

    /**
     * A move to Trash or a restore the server confirmed is held until the index agrees (A430): a
     * row from before the server made the change (its seq not after the one the server answered)
     * still says what was, and must not bring a note trashed here back, nor hide one restored
     * here (and drop its filing). Once a row says what was asked, or comes from after the change
     * (changed again elsewhere since), the server has the last word again. Seqs only: no clock
     * is compared, so neither the phone's nor the server's can tip it.
     */
    internal suspend fun settleTrashChange(id: String, deleted: Boolean, seq: Long) {
        val note = notes.note(id) ?: return
        val asked = when (note.trashChange) {
            NoteEntity.TRASH_SENT -> true
            NoteEntity.RESTORE_SENT -> false
            else -> return
        }
        if (deleted != asked && seq <= note.trashSeq) return
        notes.trashChanged(id, note.trashChange, 0)
        notes.updateMetadata(id, note.title, note.excerpt, note.updatedAt, note.clock, deleted, seq, note.kind, note.period)
    }

    suspend fun restoresDue(): List<NoteEntity> = notes.restoresDue()

    /** A pass that ended with a change in flight (the process stopped): queued again. */
    suspend fun requeueTrashInFlight() = notes.requeueInFlight()

    /**
     * About to send this note's move to Trash: in flight, so Undo or Restore meanwhile queues a
     * restore rather than cancelling a move the server may already have. False if it changed.
     */
    suspend fun trashSending(noteId: String): Boolean =
        notes.trashChanged(noteId, NoteEntity.TRASH_QUEUED, NoteEntity.TRASH_SENDING) == 1

    /** About to send this note's restore: Move to Trash meanwhile queues a move. */
    suspend fun restoreSending(noteId: String): Boolean =
        notes.trashChanged(noteId, NoteEntity.RESTORE_QUEUED, NoteEntity.RESTORE_SENDING) == 1

    /**
     * The move to Trash got no answer that says what Penmoss did (offline, a server error):
     * queued again (unless undone meanwhile), still tried, as it may have reached the server.
     */
    suspend fun trashNotSent(noteId: String) =
        notes.trashChanged(noteId, NoteEntity.TRASH_SENDING, NoteEntity.TRASH_QUEUED)

    /** The restore got no answer that says what Penmoss did: queued again, still tried. */
    suspend fun restoreNotSent(noteId: String) =
        notes.trashChanged(noteId, NoteEntity.RESTORE_SENDING, NoteEntity.RESTORE_QUEUED)

    /**
     * The server has it in Trash since [deletedAt] (its clock, shown only), made after index seq
     * [seq]: held so until a later row comes. Restored here while it was in flight: that
     * restore stays queued and goes next.
     */
    suspend fun trashSent(noteId: String, deletedAt: Long, seq: Long) {
        notes.trashConfirmed(noteId, NoteEntity.TRASH_SENDING, NoteEntity.TRASH_SENT, seq, deletedAt)
    }

    /**
     * Restored on another device since this phone last saw the note (409 `restored_since`): it
     * stays out of Trash, and the person is told ([observeTrashNotices]). The notice is kept in
     * the database, so one met by a background pass is said when the app is next open.
     */
    suspend fun trashRefused(noteId: String) {
        notes.trashRefused(noteId)
    }

    /** Notes whose move to Trash a restore elsewhere overruled, not said yet, oldest first. */
    fun observeTrashNotices(): Flow<List<TrashNotice>> = notes.observeTrashNotices()

    suspend fun trashNoticeShown(noteId: String) = notes.trashNoticeShown(noteId)

    /**
     * The server restored it ([restored]; false: it was not in Trash there), from [folderId]
     * (null: the top level), after index seq [seq]. It is filed back there by the next pass (a
     * folder gone since is the server's to place, never the top level of another notebook, A757), and listed there now,
     * or at the top level while this phone does not know that folder. Moved to Trash here while
     * the restore was in flight: it is still filed first, so that move records the folder.
     */
    suspend fun restoreSent(noteId: String, folderId: String?, restored: Boolean, seq: Long) = db.withTransaction {
        notes.trashConfirmed(noteId, NoteEntity.RESTORE_SENDING, NoteEntity.RESTORE_SENT, seq, now())
        val row = notes.note(noteId) ?: return@withTransaction
        // The server's restore is this phone's own: its view includes it, so a later move to
        // Trash is never refused over it (A431).
        if (seq + 1 > row.seq) notes.seenSeq(noteId, seq + 1)
        if (!restored) return@withTransaction
        notes.fileRestored(noteId, folderId)
        if (!row.deleted) placement.placeAtEnd(noteId, folderId?.takeIf { placement.folderExists(it) })
    }

    /**
     * A restore, or a move to Trash, of a note the server does not have (404 "No such note":
     * deleted for good, or never there): nothing to send, and this copy goes, its unsent edits
     * kept apart for their conflict copy (A310). Whatever was asked meanwhile goes with it.
     */
    suspend fun trashGone(noteId: String) = db.withTransaction {
        val note = notes.note(noteId) ?: return@withTransaction
        notes.trashChanged(noteId, note.trashChange, 0)
        dropPurged(noteId)
    }

    /** Trash as the phone holds it, newest first (NT13). */
    fun observeTrash(): Flow<List<TrashRow>> = notes.observeTrash()

    suspend fun trashChangesWaiting(): Int = notes.trashChangesWaiting()

    /**
     * Deleted for good (NT15, or a tombstone from `/sync/changes`, T21): what the server had
     * goes, but never this phone's unsent edits nor the note they need; they are kept apart for
     * their conflict copy and the note leaves every list (A306, A310).
     */
    suspend fun purged(noteId: String) = db.withTransaction { dropPurged(noteId) }

    internal suspend fun dropPurged(noteId: String) {
        // The cached version list goes with the note (T40 P3b fixup): one small row per note ever
        // read, never evicted otherwise.
        db.historyCache().delete(noteId)
        // And its toggles kept on this phone (T40 P8 review).
        db.folds().delete(noteId)
        // Its links and the backlinks read for it (T40 P7): a purged note links nowhere.
        db.noteLinks().clearFrom(noteId)
        // Links to it too: the server unresolves them without moving the sources (review N2).
        db.noteLinks().clearTo(noteId)
        db.backlinksCache().delete(noteId)
        // Out of the offline index, and its tags with it (T40 P6).
        search.deleteText(noteId)
        search.clearTags(noteId)
        if (updates.count(noteId, UpdateEntity.WITHHELD) > 0) {
            // A git notebook's copy withheld from the push (A886): all of it stays aside, its
            // pending edits too, and its row with its title, out of every list.
            updates.withholdRest(noteId)
            notes.markGone(noteId)
            return
        }
        if (updates.unsentCount(noteId) == 0) {
            updates.deleteSynced(noteId)
            notes.delete(noteId)
        } else {
            val epoch = notes.note(noteId)?.epoch
            updates.keepAsBase(noteId, epoch)
            updates.keepPendingApart(noteId, epoch)
            notes.markGone(noteId)
        }
    }
}

