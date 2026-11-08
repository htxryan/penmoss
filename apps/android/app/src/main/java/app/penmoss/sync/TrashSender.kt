package app.penmoss.sync

import app.penmoss.data.NoteStore
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossApi
import java.io.IOException

/**
 * Sends the moves to Trash and the restores asked on this phone (T40 P3a, NT12, NT14, A430).
 * The web changes a note's deleted flag in its document and the tree in the WorkspaceDoc; the
 * phone never reads Yjs, so it asks the server, as it files notes (A303, A352).
 *
 * - **Restores** go before the notes are exchanged, so the same pass reads the note back and
 *   files it where it was deleted from. One the server cannot place (409
 *   `restore_needs_folder`, T43 A757) goes back to Trash, and Trash asks where it goes.
 * - **Moves to Trash** go after, once the note's own edits and its move to file have gone
 *   (`trashesDue`): delete wins, the edits are in Trash with it, and the server records the
 *   folder this phone had it in.
 *
 * Each request is marked in flight, and tried, before it goes: Undo or Restore while it travels,
 * or after it got no answer, queues the opposite request rather than cancelling one the server
 * may already have (both reviews of #94). Offline, a server error, or a 404 that does not say
 * the note is gone: it is queued again, still tried, and the rest wait for the next pass. Only
 * a 404 that says so (`noSuchNote`) drops the phone's copy.
 * Signing out keeps them.
 */
class TrashSender(private val store: NoteStore, private val api: PenmossApi) {
    private companion object {
        const val RESTORE_NEEDS_FOLDER = "restore_needs_folder"
    }

    suspend fun sendRestores() {
        // A pass that ended with a request in flight (the process stopped) left it marked.
        store.requeueTrashInFlight()
        for (note in store.restoresDue()) {
            if (!store.restoreSending(note.id)) continue
            val restored = try {
                api.restoreNote(note.id)
            } catch (error: ApiException) {
                if (error.code == RESTORE_NEEDS_FOLDER) {
                    // Nothing restored (T43, A757: fail closed): its folder is gone and no place
                    // for it is safe, so it is never put in the default notebook. Back in Trash
                    // here, and Trash asks the person where it goes.
                    store.restoreNeedsFolder(note.id, error.notebook?.id, error.notebook?.name, error.message.orEmpty())
                    continue
                }
                store.restoreNotSent(note.id)
                when {
                    error.unauthorized -> throw error
                    // Deleted for good meanwhile: there is nothing to restore. Only when the
                    // server says so: any other 404 waits for the next pass, as an error does.
                    error.noSuchNote -> {
                        store.trashGone(note.id)
                        continue
                    }
                    else -> return
                }
            } catch (error: IOException) {
                store.restoreNotSent(note.id)
                return
            }
            store.restoreSent(note.id, restored.folderId, restored.restored, restored.seq)
        }
    }

    suspend fun sendTrashes() {
        for (note in store.trashesDue()) {
            if (!store.trashSending(note.id)) continue
            val trashed = try {
                // What the phone had seen when the move was asked, not what it has read since.
                api.trashNote(note.id, note.trashSeq)
            } catch (error: ApiException) {
                when {
                    error.unauthorized -> {
                        store.trashNotSent(note.id)
                        throw error
                    }
                    // Restored on another device since this phone last saw it: that restore wins.
                    error.code == "restored_since" -> {
                        store.trashRefused(note.id)
                        continue
                    }
                    // Not on the server (deleted for good, or never there): only this copy goes.
                    // Only when the server says so (second review of #94).
                    error.noSuchNote -> {
                        store.trashGone(note.id)
                        continue
                    }
                    // Any other 404: most likely a server from before the route, which answers
                    // a plain "404 Not Found" (a proxy's page looks the same). Every move waits,
                    // nothing is dropped, and Trash says why.
                    error.status == 404 -> {
                        store.trashNotSent(note.id)
                        store.setTrashRouteMissing(true)
                        return
                    }
                    else -> {
                        store.trashNotSent(note.id)
                        return
                    }
                }
            } catch (error: IOException) {
                store.trashNotSent(note.id)
                return
            }
            store.setTrashRouteMissing(false)
            store.trashSent(note.id, trashed.deletedAt, trashed.seq)
        }
    }
}
