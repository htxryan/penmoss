package app.penmoss.git

import android.content.Context
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
import app.penmoss.AppGraph
import app.penmoss.editor.EditorWebView
import app.penmoss.graph
import app.penmoss.ui.DeepLinkInbox
import app.penmoss.ui.PenmossRoot
import app.penmoss.ui.PenmossTheme
import app.penmoss.ui.followShownVariant
import app.penmoss.ui.keys.AppCommands
import app.penmoss.ui.keys.LocalAppCommands
import kotlinx.coroutines.launch

/**
 * One git notebook's screens (T50 G7, A880): the app's own screens (Home, folders, notes, the
 * editor, search, Trash, History, tags, the graph, Settings) over the notebook's graph, so every
 * thing the app can do, the notebook can (Every client can do everything). Its own task entry, so
 * each notebook sits beside the others in Recents. In front, it pulls on resume and
 * on its interval and pushes after edits settle (A825); leaving it syncs what waits.
 */
class GitNotebookActivity : ComponentActivity() {
    private lateinit var notebook: AppGraph
    private lateinit var localId: String
    private val commands = AppCommands()
    private val deepLinks = DeepLinkInbox()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val id = intent?.getStringExtra(EXTRA_LOCAL_ID)
        val made = id?.let { runCatching { graph.git.graph(it) }.getOrNull() }
        if (id == null || made == null) {
            // Removed meanwhile, or a stale Recents entry: nothing to show.
            finish()
            return
        }
        localId = id
        notebook = made
        title = graph.git.list.value.firstOrNull { it.localId == id }?.name ?: "Git notebook"
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { graph.settings.collect { commands.follow(it.settings.values) } }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                runCatching { graph.git.source(localId).front(true) }
            }
        }
        if (savedInstanceState == null) offer(intent)
        setContent {
            val appearance by graph.appearance.collectAsStateWithLifecycle()
            val dark = appearance.isDark(isSystemInDarkTheme())
            LaunchedEffect(dark) { followShownVariant(dark) }
            PenmossTheme(appearance, dark) {
                CompositionLocalProvider(LocalAppCommands provides commands) {
                    PenmossRoot(notebook, deepLinks)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        offer(intent)
    }

    /** A launcher shortcut's action, or a note link's note (A1040), for the screens to act on. */
    private fun offer(intent: Intent?) {
        app.penmoss.ui.keys.LauncherAction.named(intent?.getStringExtra(EXTRA_ACTION))?.let(deepLinks::offer)
        intent?.getStringExtra(EXTRA_NOTE)?.let(deepLinks::offer)
    }

    override fun onPause() {
        super.onPause()
        if (::localId.isInitialized) {
            val hub = graph.git
            val id = localId
            // A pause for the file picker or the share sheet is not a leave (#174 delta review).
            val leaving = isFinishing
            graph.scope.launch { runCatching { hub.source(id).front(false, leaving) } }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        commands.handle(event, inEditor = EditorWebView.handsKeysToPage(currentFocus)) || super.dispatchKeyEvent(event)

    override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>, menu: Menu?, deviceId: Int) {
        super.onProvideKeyboardShortcuts(data, menu, deviceId)
        data += commands.shortcutGroups()
    }

    companion object {
        const val EXTRA_LOCAL_ID = "app.penmoss.git.localId"

        /** Today or This week, when the notebook is the Journal notebook (A827). */
        const val EXTRA_ACTION = "app.penmoss.git.action"

        /** A note to open, from a `penmoss://note/<id>` link or a launcher shortcut (A1040). */
        const val EXTRA_NOTE = "app.penmoss.git.note"

        /** Opens a notebook's screens; each notebook keeps one task (its document). */
        fun open(context: Context, localId: String, action: app.penmoss.ui.keys.LauncherAction? = null, note: String? = null) {
            context.startActivity(
                Intent(context, GitNotebookActivity::class.java)
                    .putExtra(EXTRA_LOCAL_ID, localId)
                    .apply { if (action != null) putExtra(EXTRA_ACTION, action.name) }
                    .apply { if (note != null) putExtra(EXTRA_NOTE, note) }
                    .setData(android.net.Uri.parse("penmoss-git://notebook/$localId"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }
}
