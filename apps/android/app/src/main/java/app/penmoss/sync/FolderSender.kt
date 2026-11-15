package app.penmoss.sync

import app.penmoss.data.FolderOpEntity
import app.penmoss.data.NoteStore
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.FolderPatch
import app.penmoss.engine.api.FolderPlace
import app.penmoss.engine.api.PenmossApi
import java.io.IOException

/**
 * Sends the folder changes made on this phone (T40 P4, NT2–NT7, A443), in the
 * order they were asked: a create before a rename of it, before a note filed
 * into it (the filer runs after this, in the same pass). The tree lays waiting
 * changes over what it reads, so an older tree never undoes one (as moves do,
 * A359). A 409 drops the change and the rest of its folder's (overtaken
 * elsewhere), and a 404 for its folder drops them with a notice (deleted
 * elsewhere). Signing out keeps them.
 *
 * A parent gone since is the notes server's to place (A352, A757): it makes or moves the folder
 * into the nearest live folder above it. Its 422 `folder_not_found` means there is no safe place:
 * the change is dropped with a notice, never sent again at the top level.
 */
class FolderSender(private val store: NoteStore, private val api: PenmossApi) {
    private companion object {
        const val FOLDER_NOT_FOUND = "folder_not_found"
    }

    suspend fun sendDue() {
        for (op in store.folderOpsDue()) {
            // Dropped with its folder's others by an earlier one in this pass (a 409, or a parent
            // gone with no safe place): never sent.
            if (store.folderOpsDue().none { it.rowId == op.rowId }) continue
            val done = when (op.kind) {
                FolderOpEntity.CREATE -> sendCreate(op)
                FolderOpEntity.DELETE -> sendDelete(op)
                FolderOpEntity.ROOT_SORT -> sendRootSort(op)
                // A rename of the default notebook, or a notebook flag, an older version queued: a
                // git notebook has neither (A912).
                FolderOpEntity.ROOT_NAME, FolderOpEntity.NOTEBOOK -> true.also { store.dropFolderOp(op.rowId) }
                else -> sendPatch(op)
            }
            if (done != true) return
        }
    }

    private suspend fun sendCreate(op: FolderOpEntity): Boolean? {
        val id = op.folderId ?: return true
        // Tried with no answer, the server may hold it: a local delete queues the delete
        // instead of cancelling both (T40 P4 review B3). Marked before sending, so a pass
        // stopped mid-request counts as tried too, as a move to Trash does (A430).
        store.markFolderOpTried(op.rowId)
        try {
            api.createFolder(id, op.name ?: "Untitled folder", op.parentId)
        } catch (error: ApiException) {
            if (error.unauthorized) throw error
            if (error.code == FOLDER_NOT_FOUND && op.parentId != null) {
                // No safe place for it (A757): dropped with the folder's other changes, said once.
                store.dropFolderOpsFor(id, op.label, NoteStore.FolderDropReason.PARENT_GONE)
                return true
            }
            if (error.status == 404 || error.status >= 500 || error.status == 429) return null
            store.dropFolderOp(op.rowId)
            return true
        } catch (error: IOException) {
            return null
        }
        store.dropFolderOp(op.rowId)
        return true
    }

    private suspend fun sendPatch(op: FolderOpEntity): Boolean? {
        val id = op.folderId ?: return true
        // As a create: tried with no answer, the server may hold it (T40 P4 review B3).
        store.markFolderOpTried(op.rowId)
        val patch = when (op.kind) {
            FolderOpEntity.RENAME -> FolderPatch(name = op.name, fromName = op.fromName, checkName = op.checkName)
            FolderOpEntity.MOVE -> FolderPatch(
                parentId = op.parentId,
                changeParent = true,
                fromParentId = op.fromParentId,
                checkParent = op.checkParent,
            )
            FolderOpEntity.SORT -> FolderPatch(sortMode = op.sortMode)
            FolderOpEntity.REORDER -> FolderPatch(place = placeOf(op))
            else -> return true
        }
        try {
            api.patchFolder(id, patch)
        } catch (error: ApiException) {
            if (error.unauthorized) throw error
            if (error.status == 422 && error.code == FOLDER_NOT_FOUND && op.kind == FolderOpEntity.MOVE && patch.parentId != null) {
                // A move into a parent gone since with no safe place for it (A757): the server
                // already tried the nearest folder above. The move is dropped, said once, and the
                // tree's place stands; the folder's other changes go on.
                store.dropFolderOp(op.rowId, op.label, NoteStore.FolderDropReason.PARENT_GONE)
                return true
            }
            if (error.code == "folder_changed") {
                // Overtaken by a rename elsewhere (409): the tree's place
                // stands (A359). The rest of the folder's changes are based on this one, so
                // they go with it. The notice names the rename (T40 P4 review B2).
                store.dropFolderOpsFor(id, op.label, NoteStore.FolderDropReason.RENAMED)
                return true
            }
            if (error.code == "folder_moved") {
                // Overtaken by a move elsewhere (409): as above, naming the move.
                store.dropFolderOpsFor(id, op.label, NoteStore.FolderDropReason.MOVED)
                return true
            }
            if (error.status == 404 && error.code == FOLDER_NOT_FOUND) {
                // Gone there (404 `folder_not_found`): the tree's place
                // stands (A359). The rest of the folder's changes are based on this one, so
                // they go with it. Any other 404 names no folder: the change waits (A449).
                store.dropFolderOpsFor(id, op.label)
                return true
            }
            if (error.status == 404 || error.status >= 500 || error.status == 429) return null
            store.dropFolderOp(op.rowId)
            return true
        } catch (error: IOException) {
            return null
        }
        store.dropFolderOp(op.rowId)
        return true
    }

    // The notes server's delete is idempotent, so a retry is always safe: a 404 waits (A449).
    private suspend fun sendDelete(op: FolderOpEntity): Boolean? {
        val id = op.folderId ?: return true
        // As a create: tried with no answer, the server may hold it (T40 P4 review B3).
        store.markFolderOpTried(op.rowId)
        try {
            api.deleteFolder(id)
        } catch (error: ApiException) {
            return when {
                error.unauthorized -> throw error
                error.status == 404 || error.status >= 500 || error.status == 429 -> null
                else -> {
                    store.dropFolderOp(op.rowId)
                    true
                }
            }
        } catch (error: IOException) {
            return null
        }
        store.dropFolderOp(op.rowId)
        return true
    }

    private suspend fun sendRootSort(op: FolderOpEntity): Boolean? {
        // As a create: tried with no answer, the server may hold it (T40 P4 review B3).
        store.markFolderOpTried(op.rowId)
        try {
            api.setRootSortMode(op.sortMode ?: return true)
        } catch (error: ApiException) {
            return when {
                error.unauthorized -> throw error
                // A 404 waits, as the folders' changes do (A449).
                error.status == 404 || error.status >= 500 || error.status == 429 -> null
                else -> {
                    store.dropFolderOp(op.rowId)
                    true
                }
            }
        } catch (error: IOException) {
            return null
        }
        store.dropFolderOp(op.rowId)
        return true
    }

    private fun placeOf(op: FolderOpEntity): FolderPlace? {
        if (op.placeBefore == null && op.placeAfter == null) return null
        return FolderPlace(before = op.placeBefore, after = op.placeAfter)
    }
}
