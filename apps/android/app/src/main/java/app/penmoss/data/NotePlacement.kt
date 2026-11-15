package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.tree.FolderTree

/**
 * Where the lists show each note (T38, NT7): moves and reorders made here, and the queue that
 * files them.
 */
class NotePlacement(
    private val db: PenmossDatabase,
) {
    private val notes = db.notes()

    /**
     * Moves a note to [folderId] (null: the top level) on this phone (T38). The lists show it
     * there at once; the server is asked with `POST /api/notes/:id/move` once it can be, by the
     * same queue that files the notes made here (A303), so a move made offline syncs later.
     * Refused for a note the phone does not list (unknown, in Trash, deleted for good), and told
     * apart for a folder it does not know (#137, A658): then no note can move there.
     */
    suspend fun moveNote(noteId: String, folderId: String?): Move = db.withTransaction {
        if (folderId != null && !folderExists(folderId)) return@withTransaction Move.NO_FOLDER
        val note = notes.note(noteId) ?: return@withTransaction Move.REFUSED
        if (note.deleted || note.gone) return@withTransaction Move.REFUSED
        val current = if (note.toFile) note.fileIn else note.folderId
        if (current == folderId && note.folderId == folderId) return@withTransaction Move.ALREADY_THERE
        notes.fileLater(noteId, folderId)
        placeAtEnd(noteId, folderId)
        Move.MOVED
    }

    /** What [moveNote] did: [REFUSED] is the note's doing, [NO_FOLDER] the folder's. */
    enum class Move { MOVED, ALREADY_THERE, REFUSED, NO_FOLDER }

    /**
     * Where the lists show a note: where a move not filed yet takes it, else where the tree has it.
     */
    suspend fun folderOf(noteId: String): String? = notes.note(noteId)?.folderId

    /** Notes made or moved here that the server has, to file in the tree. */
    suspend fun readyToFile(): List<NoteEntity> = notes.readyToFile()

    /**
     * Filed in [fileIn] (the server put it in [landed]: the nearest folder above when that folder
     * had gone, A757), or that move dropped. A later move made meanwhile stays to file, checked
     * against [landed].
     */
    suspend fun markFiled(noteId: String, fileIn: String?, landed: String? = fileIn) = db.withTransaction {
        notes.filed(noteId, fileIn)
        notes.nowIn(noteId, landed)
    }

    /** The server refused the move for good (the note is in Trash, or was moved since): dropped. */
    suspend fun dropMove(noteId: String, fileIn: String?) = notes.filed(noteId, fileIn)

    internal suspend fun folderExists(folderId: String): Boolean = db.folders().exists(folderId)

    /** Shows a note at the end of a folder (A17's order keys compare as strings; any longer key sorts after). */
    internal suspend fun placeAtEnd(noteId: String, folderId: String?) {
        val last = notes.lastPosition(folderId).orEmpty()
        notes.place(noteId, folderId, last + END_KEY)
    }

    /**
     * Reorders a note within its folder here (NT7): shown at once at the anchor, filed with
     * `place` (a same-folder move with a precondition, as T38 files moves). A missing anchor
     * means the end. False for a note the phone does not list, or one in Trash or gone.
     */
    suspend fun reorderNote(id: String, before: String?, after: String?): Boolean = db.withTransaction {
        val note = notes.note(id) ?: return@withTransaction false
        if (note.deleted || note.gone) return@withTransaction false
        // A note the tree does not place (the registry lacks it) and this phone did not make:
        // listed, never written into the tree here, as a reorder would file it (A766).
        if (!note.toFile && note.folderId == null && note.position.isEmpty()) return@withTransaction false
        val folderId = if (note.toFile) note.fileIn else note.folderId
        val siblings = notes.inFolder(folderId).map { FolderTree.ReorderSibling(it.id, it.position) }
        val key = FolderTree.reorderKey(siblings, id, before, after)
        notes.place(id, folderId, key.position)
        if (!note.toFile) notes.fileLater(id, folderId)
        notes.setPlace(id, key.before, key.after)
        true
    }

    internal companion object {
        /** Sorts after every key it is appended to: the highest UTF-16 code unit. */
        const val END_KEY = "\uFFFF"
    }
}
