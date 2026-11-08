package app.penmoss.sync

import app.penmoss.capture.Captures
import app.penmoss.data.Attachments
import app.penmoss.data.NoteStore
import app.penmoss.editor.OpenEditors

/**
 * What each sync pass, and each note's own exchange, does besides the engine's
 * work (T33): pictures go up before the notes that name them, so no other
 * device shows one missing (A313); base rows no edit needs are dropped, never
 * those of a copy an open editor still holds (A309); notes made on the phone
 * are filed once the server has them (A303); captures saved on the phone go
 * up after their pictures and before the pass reads what changed, so the
 * note they land in comes back in the same pass (A338).
 */
class PassWork(
    private val store: NoteStore,
    private val attachments: Attachments,
    private val filer: NoteFiler,
    private val openEditors: OpenEditors,
    /** Quick captures (T34): sent after the pictures they name, before the notes are exchanged (A338). */
    private val captures: Captures? = null,
    /** Settings changed here (T40 P1): sent first, so the tree the pass reads has them (A411). */
    private val settings: SettingsSender? = null,
    /** Folder changes made here (T40 P4, NT2–NT7): sent after the settings, before the notes are filed. */
    private val folders: FolderSender? = null,
    /**
     * Trash and restores asked here (T40 P3a, A430): restores before the notes are exchanged,
     * so the pass reads them back and files them; moves to Trash after, once their edits went.
     */
    private val trash: TrashSender? = null,
    /** Feedback waiting to go (T49, A796, A803): sent after each pass, once the phone is known to be online. */
    private val feedback: app.penmoss.feedback.FeedbackOutbox? = null,
) {
    suspend fun beforePass() {
        settings?.sendDue()
        folders?.sendDue()
        store.dropUnneededBases(openEditors::holds)
        attachments.uploadDue()
        captures?.sendDue()
        trash?.sendRestores()
    }

    suspend fun afterPass() {
        // Moves first: a note moved here and then to Trash is filed where this phone had it, so
        // the server records that folder for a later restore (A430).
        filer.fileDue()
        trash?.sendTrashes()
        feedback?.sendDue()
    }

    suspend fun beforeNote() {
        attachments.uploadDue()
    }
}
