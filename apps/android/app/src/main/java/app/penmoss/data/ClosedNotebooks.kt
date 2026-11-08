package app.penmoss.data

import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The notebooks closed on this phone (T43, A752): open or closed is each device's own, never
 * synced. Kept with the workspace they belong to, so another workspace's are never applied, and
 * cleared at sign-out with the cache, as [app.penmoss.ui.MirrorCache] is. The default notebook is
 * always open: it is never stored here.
 */
class ClosedNotebooks(
    private val prefs: SharedPreferences,
    /** The workspace signed in to now; null when signed out. */
    private val workspace: () -> String?,
    /** A git notebook's graph (A912): no notebooks in it, so none is closed, whatever is stored. */
    private val inGitNotebook: Boolean = false,
) {
    // Read on first use: the session the workspace comes from is made after this.
    private val state by lazy { MutableStateFlow(load()) }

    /** The closed notebooks' ids. */
    val closed: StateFlow<Set<String>> get() = state

    /** Opens ([open]) or closes a notebook on this phone. */
    fun setOpen(notebook: String, open: Boolean) {
        if (notebook == Notebooks.DEFAULT || inGitNotebook) return
        val next = if (open) state.value - notebook else state.value + notebook
        if (next == state.value) return
        prefs.edit {
            workspace()?.let { putString(WORKSPACE, it) }
            putStringSet(CLOSED, next)
        }
        state.value = next
    }

    fun clear() {
        prefs.edit { clear() }
        state.value = emptySet()
    }

    private fun load(): Set<String> {
        if (inGitNotebook) return emptySet()
        val stored = prefs.getString(WORKSPACE, null)
        val current = runCatching { workspace() }.getOrNull()
        if (stored != null && current != null && stored != current) return emptySet()
        return prefs.getStringSet(CLOSED, null)?.toSet().orEmpty()
    }

    companion object {
        const val PREFS = "penmoss.notebooks"
        private const val WORKSPACE = "workspaceId"
        private const val CLOSED = "closed"
    }
}
