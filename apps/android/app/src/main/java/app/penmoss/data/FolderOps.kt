package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.api.PenmossJson
import app.penmoss.engine.notes.Ulid
import app.penmoss.engine.tree.FolderTree
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

/**
 * Folders (T40 P4, NT2–NT7, A443): every change shows at once and waits in the folder-op queue to
 * send, offline too, and is laid over each tree read until sent.
 */
class FolderOps(
    private val db: PenmossDatabase,
) {
    private val notes = db.notes()
    private val settings = db.settings()

    fun observeFolders(): Flow<List<FolderEntity>> = db.folders().observeAll()

    fun observeRootSortMode(): Flow<String> = settings.observe(ROOT_SORT_MODE).map { it ?: "manual" }

    /** Folder changes made here and not sent yet, oldest first. */
    suspend fun folderOpsDue(): List<FolderOpEntity> = db.folderOps().all()

    /** Folder changes made here: signing out keeps them (A443). */
    suspend fun folderOpsWaiting(): Int = db.folderOps().count()

    /**
     * Makes a folder here (NT2): shown at once in its parent, queued to send, offline too.
     * Returns its id (this phone's ULID, which the server's idempotent create reuses).
     * Refused for a parent the phone does not know.
     */
    suspend fun createFolder(name: String, parentId: String?): String? = db.withTransaction {
        if (parentId != null && db.folders().get(parentId) == null) return@withTransaction null
        val id = Ulid.next()
        db.folders().put(FolderEntity(id, name, parentId, endFolderPosition(parentId), FolderTree.MANUAL))
        db.folderOps().insert(
            FolderOpEntity(folderId = id, kind = FolderOpEntity.CREATE, name = name, parentId = parentId, label = name),
        )
        id
    }

    /**
     * Renames a folder here (NT3): shown at once, queued with what was seen, so a rename made
     * elsewhere since wins (409, as moves do, A359). False for a folder the phone does not know.
     */
    suspend fun renameFolder(id: String, name: String): Boolean = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction false
        db.folders().rename(id, name)
        db.folderOps().insert(
            FolderOpEntity(
                folderId = id, kind = FolderOpEntity.RENAME, name = name,
                fromName = folder.name, checkName = true, label = name,
            ),
        )
        true
    }

    /** What [moveFolder] did. */
    enum class FolderMove { MOVED, ALREADY_THERE, REFUSED }

    /**
     * Moves a folder here (NT4, NT5): shown at once at its new parent's end, queued with the
     * parent seen, so a move made elsewhere since wins (409). Refused for an unknown folder or
     * parent, or moving into itself or a subfolder (the server refuses those too).
     */
    suspend fun moveFolder(id: String, parentId: String?): FolderMove = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction FolderMove.REFUSED
        if (parentId != null && db.folders().get(parentId) == null) return@withTransaction FolderMove.REFUSED
        if (parentId != null && isWithin(id, parentId)) return@withTransaction FolderMove.REFUSED
        if (folder.parentId == parentId) return@withTransaction FolderMove.ALREADY_THERE
        db.folders().move(id, parentId, endFolderPosition(parentId, exclude = id))
        db.folderOps().insert(
            FolderOpEntity(
                folderId = id, kind = FolderOpEntity.MOVE, parentId = parentId,
                fromParentId = folder.parentId, checkParent = true, label = folder.name,
            ),
        )
        FolderMove.MOVED
    }

    /** Whether [folderId] sits inside [id] (or is it): a move there would be a cycle (NT5). */
    private suspend fun isWithin(id: String, folderId: String): Boolean {
        var current: String? = folderId
        val seen = HashSet<String>()
        while (current != null && seen.add(current)) {
            if (current == id) return true
            current = db.folders().get(current)?.parentId
        }
        return false
    }

    /**
     * What deleting a folder here asks about (NT4): how many notes and subfolders move up, and
     * to where. Null for a folder the phone does not know.
     */
    data class FolderDeleteSummary(
        val notes: Int,
        val subfolders: Int,
        val destination: String?,
    )

    suspend fun folderDeleteSummary(id: String): FolderDeleteSummary? = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction null
        val all = db.folders().all()
        val subtree = subtreeIds(all, id)
        val notes = db.notes().inFolders(subtree.toList()).size
        FolderDeleteSummary(
            notes = notes,
            subfolders = subtree.size - 1,
            destination = all.firstOrNull { it.id == folder.parentId }?.name,
        )
    }

    /**
     * Deletes a folder and its subfolders here (NT4): their notes move up at once, offline too,
     * as the server deletes them. Changes queued for the subtree never reach the server: a create
     * and its delete cancel out silently — unless the create was tried with no answer (the
     * server may hold the folder), when the delete is queued instead (T40 P4 review B3; DELETE
     * is idempotent, so sending it when unsure is safe).
     */
    suspend fun deleteFolder(id: String): Boolean = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction false
        val all = db.folders().all()
        val subtree = subtreeIds(all, id)
        // A folder made here and deleted before anything was sent never reaches the server: its
        // queued changes go silently, and no delete is queued. Anything else queues one delete.
        val queued = db.folderOps().all()
        val createdHere = queued.any { it.folderId == id && it.kind == FolderOpEntity.CREATE }
        val tried = queued.any { it.folderId == id && it.kind == FolderOpEntity.CREATE && it.tried }
        for (fid in subtree) db.folderOps().deleteFor(fid)
        if (!createdHere || tried) {
            db.folderOps().insert(FolderOpEntity(folderId = id, kind = FolderOpEntity.DELETE, label = folder.name))
        }
        val notes = db.notes().inFolders(subtree.toList())
        // Their notes move up to the deleted folder's parent (null when it has gone), at its end.
        val destination = folder.parentId?.takeIf { pid -> all.any { it.id == pid } }
        var last = lastNotePosition(destination)
        for (note in notes.sortedWith { a, b -> FolderTree.compareOrder(a.position, a.id, b.position, b.id) }) {
            if (note.toFile) continue
            last += NotePlacement.END_KEY
            db.notes().place(note.id, destination, last)
        }
        for (fid in subtree) db.folders().delete(fid)
        true
    }

    /**
     * Sets a folder's sort mode here (NT6), or the top level's when [id] is null: shown at once,
     * queued to send (last write wins). False for a folder the phone does not know.
     */
    suspend fun setSortMode(id: String?, mode: String): Boolean = db.withTransaction {
        if (mode != FolderTree.MANUAL && mode != FolderTree.ALPHA && mode != FolderTree.MODIFIED) {
            return@withTransaction false
        }
        if (id == null) {
            settings.put(SettingEntity(ROOT_SORT_MODE, mode))
            // Choosing again replaces the choice not sent yet: last write wins, one request.
            db.folderOps().deleteKind(null, FolderOpEntity.ROOT_SORT)
            db.folderOps().insert(FolderOpEntity(folderId = null, kind = FolderOpEntity.ROOT_SORT, sortMode = mode))
        } else {
            if (db.folders().get(id) == null) return@withTransaction false
            db.folders().setSortMode(id, mode)
            db.folderOps().deleteKind(id, FolderOpEntity.SORT)
            db.folderOps().insert(
                FolderOpEntity(folderId = id, kind = FolderOpEntity.SORT, sortMode = mode, label = db.folders().get(id)?.name),
            )
        }
        true
    }

    /**
     * Reorders a folder among its siblings here (NT7): shown at once at the anchor, queued as
     * `place`, which the server computes from its live document. A missing anchor means the end.
     * False for a folder the phone does not know.
     */
    suspend fun reorderFolder(id: String, before: String?, after: String?): Boolean = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction false
        val siblings = db.folders().children(folder.parentId).map { FolderTree.ReorderSibling(it.id, it.position) }
        val key = FolderTree.reorderKey(siblings, id, before, after)
        db.folders().setPosition(id, key.position)
        db.folderOps().insert(
            FolderOpEntity(
                folderId = id, kind = FolderOpEntity.REORDER,
                placeBefore = key.before, placeAfter = key.after, label = folder.name,
            ),
        )
        true
    }

    /** Drops a sent folder change (T40 P4). */
    suspend fun dropFolderOp(rowId: Long) = db.folderOps().delete(rowId)

    /** A folder change went out and its answer never came: the server may hold it (T40 P4 review B3). */
    suspend fun markFolderOpTried(rowId: Long) = db.folderOps().markTried(rowId)

    /**
     * Drops one sent folder change refused for good, and says why once (A757): a move into a
     * parent gone since with no safe place for it. The folder's other changes go on.
     */
    suspend fun dropFolderOp(rowId: Long, label: String?, reason: FolderDropReason) = db.withTransaction {
        db.folderOps().delete(rowId)
        noticeFolderChange(folderDropText(label, reason))
    }

    /**
     * A folder the server no longer has: its queued changes are dropped, and the person is told
     * once, naming it (T40 P4). [reason] says how it went: gone (404), or overtaken by a rename
     * or a move made elsewhere (409), which the notice names (T40 P4 review B2). A queued delete
     * is already the wanted end state: dropped silently.
     */
    suspend fun dropFolderOpsFor(
        folderId: String,
        label: String?,
        reason: FolderDropReason = FolderDropReason.DELETED,
    ) {
        val ops = db.folderOps().all().filter { it.folderId == folderId }
        if (ops.isEmpty()) return
        db.withTransaction {
            db.folderOps().deleteFor(folderId)
            if (ops.any { it.kind != FolderOpEntity.DELETE }) {
                noticeFolderChange(folderDropText(label, reason))
            }
        }
    }

    private fun folderDropText(label: String?, reason: FolderDropReason): String {
        val named = "“${label ?: "Untitled folder"}”"
        return when (reason) {
            FolderDropReason.DELETED -> "$named was deleted on another device, so the change was dropped."
            FolderDropReason.RENAMED -> "$named was renamed on another device, so the change was dropped."
            FolderDropReason.MOVED -> "$named was moved on another device, so the change was dropped."
            FolderDropReason.PARENT_GONE ->
                "The folder $named was going into was deleted on another device, and nowhere else in its notebook is safe, so the change was dropped."
        }
    }

    /**
     * How a folder change was dropped: gone on another device, or overtaken by a rename or move
     * there; or (A757) its parent gone with no safe place for it ([PARENT_GONE]). Never sent again
     * at the top level.
     */
    enum class FolderDropReason { DELETED, RENAMED, MOVED, PARENT_GONE }

    /** Folder changes the server refused, not said yet, oldest first. */
    fun observeFolderNotices(): Flow<List<String>> = settings.observe(FOLDER_NOTICES).map(::folderNoticesOf)

    suspend fun dismissFolderNotice(text: String) = db.withTransaction {
        val kept = folderNoticesOf(settings.get(FOLDER_NOTICES)).filter { it != text }
        settings.put(SettingEntity(FOLDER_NOTICES, PenmossJson.encodeToString(FOLDER_NOTICE_LIST, kept)))
    }

    private suspend fun noticeFolderChange(text: String) {
        val kept = (folderNoticesOf(settings.get(FOLDER_NOTICES)) + text).takeLast(5)
        settings.put(SettingEntity(FOLDER_NOTICES, PenmossJson.encodeToString(FOLDER_NOTICE_LIST, kept)))
    }

    /**
     * Folder changes made here, laid over a tree just read (T40 P4, A443). Runs inside
     * [RoomSyncStore.saveTree]'s transaction: creates reappear with their parent (listed at the
     * top level on this phone only while it has gone: the server places it, A757), renames,
     * moves, sorts and reorders apply again, and
     * changes for folders the tree no longer has are dropped with a notice (deleted elsewhere).
     * The top level's sort, which lives in settings, is applied last.
     */
    internal suspend fun reapplyFolderOps(treeIds: Set<String>) {
        val known = treeIds.toHashSet()
        for (op in db.folderOps().all()) {
            when (op.kind) {
                FolderOpEntity.CREATE -> {
                    val id = op.folderId ?: continue
                    if (db.folders().get(id) == null) {
                        val parent = op.parentId?.takeIf { it in known }
                        db.folders().put(FolderEntity(id, op.name ?: "Untitled folder", parent, endFolderPosition(parent), FolderTree.MANUAL))
                    }
                    known += id
                }
                FolderOpEntity.RENAME -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else db.folders().rename(folder.id, op.name ?: folder.name)
                }
                FolderOpEntity.MOVE -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else db.folders().move(folder.id, op.parentId?.takeIf { it in known }, endFolderPosition(op.parentId?.takeIf { it in known }, exclude = folder.id))
                }
                FolderOpEntity.SORT -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else db.folders().setSortMode(folder.id, op.sortMode ?: FolderTree.MANUAL)
                }
                FolderOpEntity.REORDER -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else {
                        val siblings = db.folders().children(folder.parentId).map { FolderTree.ReorderSibling(it.id, it.position) }
                        val key = FolderTree.reorderKey(siblings, folder.id, op.placeBefore, op.placeAfter)
                        db.folders().setPosition(folder.id, key.position)
                    }
                }
                FolderOpEntity.DELETE -> {
                    // The tree still has it: the sender deletes it. Gone already: the wanted end state.
                    if (op.folderId != null && db.folders().get(op.folderId) == null) db.folderOps().delete(op.rowId)
                }
                FolderOpEntity.ROOT_SORT -> settings.put(SettingEntity(ROOT_SORT_MODE, op.sortMode ?: FolderTree.MANUAL))
            }
        }
    }

    private fun folderNoticesOf(json: String?): List<String> =
        json?.let { runCatching { PenmossJson.decodeFromString(FOLDER_NOTICE_LIST, it) }.getOrNull() }.orEmpty()

    /** A folder and every folder below it, depth first (T40 P4, NT4). */
    private fun subtreeIds(all: List<FolderEntity>, id: String): Set<String> {
        val out = LinkedHashSet<String>()
        fun visit(folderId: String) {
            if (!out.add(folderId)) return
            for (child in all.filter { it.parentId == folderId }) visit(child.id)
        }
        visit(id)
        return out
    }

    /** Shows a folder at the end of its parent (T40 P4, NT2): the next key after the last sibling. */
    private suspend fun endFolderPosition(parentId: String?, exclude: String? = null): String {
        val siblings = db.folders().children(parentId).filter { it.id != exclude }.map { it.id to it.position }
        return FolderTree.reorderKey(siblings.map { FolderTree.ReorderSibling(it.first, it.second) }, exclude ?: "", null, null).position
    }

    /** The last position among a folder's notes, so a note moved up shows at its end (NT4). */
    private suspend fun lastNotePosition(folderId: String?): String = notes.lastPosition(folderId).orEmpty()

    internal companion object {
        const val ROOT_SORT_MODE = "rootSortMode"

        /** Folder changes the server refused, to say once (T40 P4, A443). */
        private const val FOLDER_NOTICES = "folderNotices"
        private val FOLDER_NOTICE_LIST = ListSerializer(String.serializer())
    }
}
