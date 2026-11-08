package app.penmoss.ui

import app.penmoss.ui.keys.LauncherAction
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The note a `penmoss://note/<id>` link asked to open (T40 P7, PL5, A476), until the screens
 * open it: held while the phone is signed out, so the note opens once it signs in. A later
 * link replaces one not opened yet. Opening is all a link does. A launcher shortcut's note comes
 * here too, and its New note, Today and Search wait in [action] (T40 P9, PL3, A496).
 */
class DeepLinkInbox {
    private val pending = MutableStateFlow<String?>(null)
    private val launched = MutableStateFlow<LauncherAction?>(null)

    val note: StateFlow<String?> = pending.asStateFlow()

    /** A launcher shortcut's New note, Today or Search, until the screens act on it. */
    val action: StateFlow<LauncherAction?> = launched.asStateFlow()

    fun offer(action: LauncherAction) {
        launched.value = action
    }

    /** The screens acted on [action]; a newer one offered meanwhile stays. */
    fun acted(action: LauncherAction) {
        launched.compareAndSet(action, null)
    }

    fun offer(noteId: String) {
        pending.value = noteId
    }

    /** The screens opened [noteId]; a newer link offered meanwhile stays. */
    fun opened(noteId: String) {
        pending.compareAndSet(noteId, null)
    }
}
