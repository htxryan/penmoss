package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.tree.FolderTree

/**
 * Where the lists show each note (T38, NT7, T43): moves and reorders made here, the queue that
 * files them, and the notebook a note or folder is in as this phone's tree has it.
 */
class NotePlacement(
    private val db: PenmossDatabase,
) {
    private val notes = db.notes()

    /** The notebook a note is in, by name (A752): null for the default notebook or a note not held. */
    suspend fun notebookOf(noteId: String): FolderEntity? {
        val folderId = notes.note(noteId)?.folderId ?: return null
        val folders = db.folders().all()
        val notebook = Notebooks.index(folders).ofFolder(folderId) ?: return null
        return folders.firstOrNull { it.id == notebook }
    }

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
        // Where the phone sees it now, sent with the move (T43, A766).
        notes.fileLater(noteId, folderId, notebookOfFolder(current))
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
     * Filed in [fileIn] (the server put it in [landed]: the nearest folder above within its
     * notebook when that folder had gone, T43 A757), or that move dropped. A later move made meanwhile stays to file, checked against [landed].
     */
    suspend fun markFiled(noteId: String, fileIn: String?, landed: String? = fileIn) = db.withTransaction {
        notes.filed(noteId, fileIn)
        notes.nowIn(noteId, landed)
    }

    /** The server refused the move for good (the note is in Trash, or was moved since): dropped. */
    suspend fun dropMove(noteId: String, fileIn: String?) = notes.filed(noteId, fileIn)

    internal suspend fun folderExists(folderId: String): Boolean = db.folders().exists(folderId)

    /**
     * The notebook [folderId] is in as this phone's tree has it (T43, A766): a notebook's folder id,
     * or `default` for the default notebook, the top level and a folder the phone does not know
     * (the server compares, and holds the note when they differ: fail closed).
     */
    suspend fun notebookOfFolder(folderId: String?): String =
        Notebooks.index(db.folders().all()).ofFolder(folderId) ?: Notebooks.DEFAULT

    /** The notebook a note is in as this phone shows it: where a move not filed yet takes it, else the tree's. */
    suspend fun notebookOfNote(noteId: String): String {
        val note = notes.note(noteId) ?: return Notebooks.DEFAULT
        return notebookOfFolder(if (note.toFile) note.fileIn else note.folderId)
    }

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
        // A note the tree does not place (the server's registry lacks it) and this phone did not
        // make: listed, never written into the tree here, as a reorder would file it (T43, A766).
        if (!note.toFile && note.folderId == null && note.position.isEmpty()) return@withTransaction false
        val folderId = if (note.toFile) note.fileIn else note.folderId
        val siblings = notes.inFolder(folderId).map { FolderTree.ReorderSibling(it.id, it.position) }
        val key = FolderTree.reorderKey(siblings, id, before, after)
        notes.place(id, folderId, key.position)
        if (!note.toFile) notes.fileLater(id, folderId, notebookOfFolder(folderId))
        notes.setPlace(id, key.before, key.after)
        true
    }

    internal companion object {
        /** Sorts after every key it is appended to: the highest UTF-16 code unit. */
        const val END_KEY = "\uFFFF"
    }
}
