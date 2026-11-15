package app.penmoss.ui

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.penmoss.editor.EditorWebView
import app.penmoss.engine.notes.DeepLink
import app.penmoss.engine.notes.DeepLinks
import app.penmoss.git.GitNotebookActivity
import app.penmoss.git.NotebooksHome
import app.penmoss.graph
import app.penmoss.ui.keys.AppCommands
import app.penmoss.ui.keys.LauncherAction
import app.penmoss.ui.keys.LauncherShortcuts
import app.penmoss.ui.keys.LocalAppCommands
import kotlinx.coroutines.launch

/**
 * The app's first screen (T32; T59, A1040): the git notebooks on this phone
 * ([NotebooksHome]), each opening its own screens. With none yet, the first run asks to add or
 * create one. There is no sign-in and no personal notes.
 *
 * It also takes note links from other apps (T40 P7, PL5, A476): `penmoss://note/<id>` opens the
 * note in the git notebook that holds it (`penmoss://capture` opens the capture sheet,
 * CaptureActivity); anything else is ignored, and a link never creates, moves or deletes. A
 * launcher shortcut's New note, Today, This week and Search open the Journal notebook (A827).
 */
class MainActivity : ComponentActivity() {
    /** A hardware keyboard's app shortcuts, with the synced bindings (T40 P9, PL9, A494). */
    private val commands = AppCommands()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { graph.settings.collect { commands.follow(it.settings.values) } }
        }
        // Launcher shortcuts (A496): the fixed four, and the notes opened here last.
        LauncherShortcuts.publish(applicationContext)
        setContent {
            // The theme chosen in Settings → Appearance (A305), and system bars to match it.
            val appearance by graph.appearance.collectAsStateWithLifecycle()
            val dark = appearance.isDark(isSystemInDarkTheme())
            LaunchedEffect(dark) { followShownVariant(dark) }
            PenmossTheme(appearance, dark) {
                CompositionLocalProvider(LocalAppCommands provides commands) {
                    NotebooksHome(graph, onBack = { finish() })
                }
            }
        }
        if (savedInstanceState == null) handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /**
     * App shortcuts go first, ahead of the focused view (A494), except while the note's editor page
     * has focus: its page dispatches them and sends the app's commands back (A493).
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        commands.handle(event, inEditor = EditorWebView.handsKeysToPage(currentFocus)) || super.dispatchKeyEvent(event)

    /** Android's Meta+/ helper lists the shortcuts that work here now (FD8, A495). */
    override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>, menu: Menu?, deviceId: Int) {
        super.onProvideKeyboardShortcuts(data, menu, deviceId)
        data += commands.shortcutGroups()
    }

    private fun handle(intent: Intent?) {
        // Recents replays the intent that started the app after Back closed it: acted on
        // already, so never again (T40 P9 review S5).
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        // A launcher shortcut (T40 P9, PL3, A496): only through the app's own shortcut alias.
        when (val action = LauncherShortcuts.actionOf(intent)) {
            null -> Unit
            is LauncherAction.OpenNote -> return openNote(action.id)
            else -> {
                // The Journal notebook's screens act on it; with no notebook, the first run shows.
                val journal = runCatching { graph.git.journal() }.getOrNull() ?: return
                GitNotebookActivity.open(this, journal, action)
                return
            }
        }
        // `penmoss://capture` goes to the capture sheet's own activity (the manifest's filter there).
        // Anything else is ignored: a link is data from another app.
        (deepLinkOf(intent) as? DeepLink.Note)?.let { note -> openNote(note.id) }
    }

    /**
     * Opens [noteId] in the git notebook that holds it, else in the Journal notebook. A short
     * reference (PEN-69) opens the note it names, in the notebook it names, when this phone has it.
     */
    private fun openNote(noteId: String) {
        lifecycleScope.launch {
            if (noteId.contains('-')) {
                val (notebook, id) = runCatching { graph.git.noteOfRef(noteId) }.getOrNull() ?: return@launch
                GitNotebookActivity.open(this@MainActivity, notebook, note = id)
                return@launch
            }
            val notebook = runCatching { graph.git.notebookOfNote(noteId) }.getOrNull() ?: return@launch
            GitNotebookActivity.open(this@MainActivity, notebook, note = noteId)
        }
    }
}

/**
 * A deep link of [intent] (T40 P7, PL5): `penmoss://note/<ULID>` or `penmoss://capture`, read as
 * the Mac app reads them; null for anything else.
 */
internal fun deepLinkOf(intent: Intent?): DeepLink? {
    if (intent?.action != Intent.ACTION_VIEW) return null
    return DeepLinks.parse(intent.data?.toString())
}
