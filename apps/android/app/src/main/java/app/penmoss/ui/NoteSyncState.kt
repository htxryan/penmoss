package app.penmoss.ui

import app.penmoss.sync.SyncStatus

// --- The note's sync icon (PL10) ---

/** Where one note stands with its notebook's notes server (PL10, A429), from the phone's own state. */
enum class NoteSyncState(val label: String, val explanation: String) {
    SYNCED("Synced", "Penmoss has every edit made to this note on this phone."),
    SYNCING("Syncing", "This note's edits are being sent now."),
    WAITING("Waiting to upload", "Edits or pictures made here are on this phone and go to Penmoss with the next sync."),
    PICTURES_FAILED("Pictures failed", ""),
    OFFLINE("Offline", "Penmoss can't be reached. This note is as it was last synced, and edits made here stay on this phone until it can be."),
    FAILING("Not synced", "Penmoss answered with an error at the last sync. Edits made here stay on this phone and are tried again."),
}

/** The note's state, and how many of its pictures failed for good, in words. */
data class NoteSync(val state: NoteSyncState, val picturesFailed: Int = 0) {
    /** As the web's pill says it ("2 images failed"), in the phone's word for them. */
    val label: String
        get() = if (state == NoteSyncState.PICTURES_FAILED) "$picturesFailed picture${if (picturesFailed == 1) "" else "s"} failed" else state.label

    val explanation: String
        get() = when {
            state != NoteSyncState.PICTURES_FAILED -> state.explanation
            picturesFailed == 1 -> "1 picture could not be uploaded, so other devices show it as missing. It is kept on this phone: retry, or add it again."
            else -> "$picturesFailed pictures could not be uploaded, so other devices show them as missing. They are kept on this phone: retry, or add them again."
        }
}

/**
 * The note's state (A429): offline or failing first, then pictures that failed for good (which
 * no pass changes until Retry), then sending, waiting, or synced. [unsent] counts edits waiting
 * to be sent or kept apart for the editor; edits kept for good (never sent, A323) are not
 * waiting for anything, and Sync and storage lists them.
 */
fun noteSyncState(status: SyncStatus, unsent: Int, picturesWaiting: Int, picturesFailed: Int = 0): NoteSync {
    val waiting = unsent + picturesWaiting > 0
    val state = when {
        status is SyncStatus.Offline && !status.serverError -> NoteSyncState.OFFLINE
        status is SyncStatus.Offline && waiting -> NoteSyncState.FAILING
        picturesFailed > 0 -> NoteSyncState.PICTURES_FAILED
        status is SyncStatus.Syncing && waiting -> NoteSyncState.SYNCING
        waiting -> NoteSyncState.WAITING
        else -> NoteSyncState.SYNCED
    }
    return NoteSync(state, picturesFailed)
}
