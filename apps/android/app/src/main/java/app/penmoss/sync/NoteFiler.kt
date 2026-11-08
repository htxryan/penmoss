package app.penmoss.sync

import app.penmoss.data.NoteStore
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.InFolder
import app.penmoss.engine.api.NotePlace
import app.penmoss.engine.api.PenmossApi

/**
 * Files notes made on the phone (T33, A303, A306) in the workspace's tree once
 * the server has their content: a link's new note beside the note it was made
 * in, a conflict copy beside its original, a new note in the folder chosen for it
 * (T38). Moves made on the phone, offline included, go the same way (T38). The
 * web app files and moves notes in the WorkspaceDoc itself; the phone, which
 * never reads Yjs, asks the API. A note in Trash is never filed (A358), and a move
 * made here never undoes one made elsewhere since (A359).
 *
 * A folder gone since is the server's to place (A352, T43 A757: fail closed): it files the note
 * in the nearest folder above within its notebook and answers that folder, or, for a note not
 * filed yet with no safe place, where it was meant to go (its repair then puts it in Trash with
 * its deleted notebook). A note already filed with no safe place is refused (422
 * `folder_not_found`) and stays where it is. The phone never retries at the top level, which is
 * the default notebook.
 */
class NoteFiler(private val store: NoteStore, private val api: PenmossApi) {
    suspend fun fileDue(): Int {
        var filed = 0
        for (note in store.readyToFile()) {
            // A periodic note made here (T40 P5) files through the daily intent, not the move
            // route, with the explicit day it was made for (never today-at-filing-time, so a
            // midnight between making and filing files the same note). A144 merges it into one
            // note with one copy of the template, and restores one in Trash.
            if (note.fileKind != null) {
                val outcome = try {
                    filePeriodic(note.id, note.fileKind, note.fileDate)
                } catch (error: java.io.IOException) {
                    // Offline: the next pass files it.
                    null
                }
                when (outcome) {
                    null -> continue
                    // Filed under Journal (the note sits at the top level until the tree says so).
                    is Outcome.Filed -> store.markFiled(note.id, note.fileIn, outcome.landed)
                    // Refused for good: dropped, and the next pass shows the note as it is.
                    Outcome.Dropped -> store.dropMove(note.id, note.fileIn)
                }
                filed++
                continue
            }
            // A move made here is filed only if the note is still where it was moved from (A359).
            val from = if (note.checkFrom) InFolder(note.movedFrom) else null
            val outcome = try {
                move(note.id, note.fileIn, from)
            } catch (error: ApiException) {
                // A revoked token (the only one [move] lets through): the sync coordinator's to handle.
                throw error
            } catch (error: java.io.IOException) {
                // Offline: the next pass files it.
                null
            }
            when (outcome) {
                null -> continue
                // Unless it was moved again meanwhile: that move is filed next, from where this one put it.
                is Outcome.Filed -> store.markFiled(note.id, note.fileIn, outcome.landed)
                // In Trash, or moved elsewhere since (A358, A359), or into a folder gone with no
                // safe place (A757): the move is dropped and the next pass shows the note where the
                // server has it; it is never put back in the tree, nor at the top level.
                Outcome.Dropped -> store.dropMove(note.id, note.fileIn)
            }
            filed++
        }
        return filed
    }

    private sealed interface Outcome {
        data class Filed(val landed: String?) : Outcome

        data object Dropped : Outcome
    }

    /** Files one periodic note through the daily intent (T40 P5): filed, or null to try next pass. */
    private suspend fun filePeriodic(noteId: String, fileKind: String, fileDate: String?): Outcome? = try {
        api.dailyNote(date = fileDate, period = fileKind)
        Outcome.Filed(null)
    } catch (error: ApiException) {
        when {
            error.unauthorized -> throw error
            // A busy server: next pass.
            error.status >= 500 || error.status == 429 -> null
            // Refused for good: dropped. A 404 too: the intent goes only once the content has
            // uploaded, and the daily route makes the note with this phone's write scope, so a
            // 404 never turns into a success by waiting (T40 P5 review N1).
            else -> Outcome.Dropped
        }
    }

    /** Files one note: what came of it, or null to try next pass. */
    private suspend fun move(noteId: String, folderId: String?, from: InFolder?): Outcome? = try {
        val note = store.note(noteId)
        val place = if (note?.filePlaceBefore != null || note?.filePlaceAfter != null) {
            NotePlace(before = note.filePlaceBefore, after = note.filePlaceAfter)
        } else {
            null
        }
        // The notebook the phone saw it in when it was moved (T43, A766): kept with the move, or,
        // for one queued before that was kept, where the phone sees the folder it moved from.
        val fromNotebook = note?.moveNotebook ?: store.notebookOfFolder(if (from != null) from.folderId else note?.fileIn)
        // Where the server filed it: the folder asked for, or a gone folder's safe place (A757).
        Outcome.Filed(api.moveNote(noteId, folderId, from, place, fromNotebook).folderId)
    } catch (error: ApiException) {
        when {
            error.unauthorized -> throw error
            error.code == "in_trash" || error.code == "note_moved" -> Outcome.Dropped
            // Filed already, and the folder it was going to is gone with no safe place: it stays.
            error.code == "folder_not_found" -> Outcome.Dropped
            // Not on the server yet (its upload is still to come), or a busy server: next pass.
            error.status == 404 || error.status >= 500 || error.status == 429 -> null
            // Refused for good: nothing more to try.
            else -> Outcome.Filed(folderId)
        }
    }
}
