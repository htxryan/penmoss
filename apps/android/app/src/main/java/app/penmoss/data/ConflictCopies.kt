package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.sync.StoredUpdate
import kotlinx.coroutines.flow.Flow

/**
 * Conflict copies (A306, A309): edits kept apart from a note, grouped by the copy they were made
 * on, and the copy the editor makes of them beside the original, or why it made none.
 */
class ConflictCopies(
    private val db: PenmossDatabase,
    private val now: () -> Long,
    private val placement: NotePlacement,
) {
    private val notes = db.notes()
    private val updates = db.updates()

    // --- conflict copies (A306, A309) ---

    /** A conflict copy already made of edits of the same copy, which later ones may be merged into. */
    data class CopyTarget(val noteId: String, val updates: List<StoredUpdate>)

    /**
     * Edits kept apart from a note ([edits]), made on the copy of [epoch], and everything they
     * may build on ([base]): what the server had of that copy, and the edits of it a conflict copy
     * already holds. [into] is that conflict copy, when the phone has it.
     */
    data class ConflictSet(
        val noteId: String,
        val epoch: String?,
        val base: List<StoredUpdate>,
        val edits: List<StoredUpdate>,
        val into: CopyTarget? = null,
    )

    /** Notes holding edits kept apart, oldest first. */
    suspend fun notesWithConflicts(limit: Int = 20): List<String> = updates.notesWithConflicts(limit)

    fun observeConflictCount(): Flow<Int> = updates.observeConflictCount()

    /**
     * How many notes hold edits kept apart and waiting for a conflict copy: Home says so, since
     * a background pass can keep edits apart but only an open editor makes the copy (A323).
     */
    fun observeConflictNotes(): Flow<Int> = updates.observeConflictNotes()

    /** Edits no copy can be made of, kept on this phone (A309): shown on the Settings screen. */
    fun observeKeptCount(): Flow<Int> = updates.observeKeptCount()

    /**
     * The oldest group of a note's edits kept apart (those made on one copy) and what they may
     * build on: the base rows kept for its epoch, or what the phone holds when it is still the
     * server's copy (edits it refused for good), with the edits of that copy already copied. Null
     * when the note has none. Never made up: with no base for a replaced copy, the base is only
     * the copied edits, and the page refuses a copy whose edits lack what they build on.
     */
    suspend fun conflictSet(noteId: String): ConflictSet? = db.withTransaction {
        val conflicts = updates.updates(noteId, UpdateEntity.CONFLICT)
        if (conflicts.isEmpty()) return@withTransaction null
        // One copy at a time: the edits made on the same copy as the oldest one.
        val epoch = conflicts.first().epoch
        val edits = conflicts.filter { it.epoch == epoch }
        val copied = updates.updates(noteId, UpdateEntity.COPIED).filter { it.epoch == epoch }
        val bases = updates.updates(noteId, UpdateEntity.BASE).filter { it.epoch == epoch }
        val base = when {
            bases.isNotEmpty() -> bases
            // Still the server's copy (edits it refused for good): what the phone holds of it.
            epoch == null || notes.note(noteId)?.epoch == epoch -> updates.updates(noteId, UpdateEntity.SYNCED)
            else -> emptyList()
        } + copied
        val into = copied.lastOrNull { it.copiedTo != null }?.copiedTo
            ?.takeIf { notes.note(it) != null }
            ?.let { id -> CopyTarget(id, updates.stored(id).map { StoredUpdate(it.id, it.update) }) }
        ConflictSet(noteId, epoch, base.map { StoredUpdate(it.id, it.update) }, edits.map { StoredUpdate(it.id, it.update) }, into)
    }

    /**
     * Stores the conflict copy the editor made of a [ConflictSet] (A306, A309), in one
     * transaction: a new note to upload and file beside its original, in the original's folder
     * (A757: never the top level by default), or, when [merged], an edit of
     * the copy [ConflictSet.into] named. The edits it holds are marked as copied, never deleted:
     * a later edit of the same copy may build on them. Refused (false) when a replaced edit is no
     * longer kept apart, or the copy is not where it should be.
     */
    suspend fun saveConflictCopy(noteId: String, copy: PageNote, replaces: List<Long>, merged: Boolean = false): Boolean =
        db.withTransaction {
            val rows = keptApart(noteId, replaces) ?: return@withTransaction false
            val target = notes.note(copy.id)
            if (merged) {
                if (target == null) return@withTransaction false
                updates.insert(UpdateEntity(noteId = copy.id, state = UpdateEntity.PENDING, update = copy.update, epoch = target.epoch))
            } else {
                if (target != null) return@withTransaction false
                // Beside its original: where a move not filed yet takes it, else where the tree has it.
                val original = notes.note(noteId)
                val beside = original?.let { if (it.toFile) it.fileIn else it.folderId }
                notes.insert(NoteEntity(copy.id, title = copy.title, updatedAt = now(), toFile = true, fileIn = beside))
                updates.insert(UpdateEntity(noteId = copy.id, state = UpdateEntity.PENDING, update = copy.update))
                // Listed there at once, as a note made here is (T38).
                if (beside != null) placement.placeAtEnd(copy.id, beside.takeIf { placement.folderExists(it) })
            }
            updates.markCopied(rows.map { it.id }, copy.id)
            true
        }

    /** Why the editor made no copy of a group (A309). */
    enum class NoCopy {
        /** The edits build on something this phone does not have: kept, and counted. */
        INCOMPLETE,

        /** The edits cannot be read: kept, and counted. */
        UNREADABLE,

        /** The edits change nothing a copy would show: nothing to keep. */
        EMPTY,
    }

    /** Records that no copy was made of a group, so it is not asked for again. */
    suspend fun saveNoCopy(noteId: String, replaces: List<Long>, why: NoCopy): Boolean = db.withTransaction {
        val rows = keptApart(noteId, replaces) ?: return@withTransaction false
        if (why == NoCopy.EMPTY) updates.markCopied(rows.map { it.id }, null) else updates.markKept(rows.map { it.id })
        true
    }

    /** The rows named, if every one is an edit of this note still kept apart. */
    private suspend fun keptApart(noteId: String, ids: List<Long>): List<UpdateEntity>? {
        val distinct = ids.distinct()
        if (distinct.isEmpty()) return null
        val rows = updates.byIds(distinct)
        if (rows.size != distinct.size || rows.any { it.noteId != noteId || it.state != UpdateEntity.CONFLICT }) return null
        return rows
    }

    /**
     * Base and copied rows no edit can need any more: none of their note is pending or kept
     * apart on their copy, and no open editor still holds that copy ([held]), since it may yet
     * send its last edits of it.
     */
    suspend fun dropUnneededBases(held: (noteId: String, epoch: String?) -> Boolean = { _, _ -> false }): Int =
        db.withTransaction {
            val drop = updates.unneededBases().filterNot { held(it.noteId, it.epoch) }.map { it.id }
            if (drop.isNotEmpty()) updates.delete(drop)
            drop.size
        }
}
