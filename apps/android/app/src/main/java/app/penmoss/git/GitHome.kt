package app.penmoss.git

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import app.penmoss.ui.common.Button
import app.penmoss.ui.common.FilledTonalButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.penmoss.ui.open
import app.penmoss.ui.settings.SettingsHost
import app.penmoss.ui.settings.settingsRoutes
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.NotebookGraph
import app.penmoss.ui.common.DotState
import app.penmoss.ui.common.SectionTitle
import app.penmoss.ui.common.SyncDot
import app.penmoss.ui.common.SyncStateDot
import app.penmoss.ui.settings.GroupTitle
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen
import kotlinx.coroutines.launch

/**
 * The app's home (T50 G7, A828; T59, A1040; PEN-146): the git notebooks on this phone, each opening
 * its own screens, with Add and a gear to Settings, which opens here too (not only from inside a
 * notebook). With none yet, the first run asks to add or create one; there is no sign-in and no
 * personal notes.
 */
@Composable
fun NotebooksHome(graph: app.penmoss.DeviceGraph, onBack: () -> Unit) {
    val context = LocalContext.current
    val nav = rememberNavController()
    // Settings' (i) names the primary notebook on every Settings screen (A1560).
    androidx.compose.runtime.CompositionLocalProvider(
        app.penmoss.ui.settings.LocalPrimaryNotebookName provides app.penmoss.ui.settings.rememberPrimaryName(graph),
    ) {
        app.penmoss.ui.PenmossNavHost(nav, startDestination = HOME_ROUTE) {
            composable(HOME_ROUTE) {
                GitNotebooksRoute(
                    graph.git,
                    onOpen = { GitNotebookActivity.open(context, it) },
                    onBack = onBack,
                    home = true,
                    onSettings = { nav.open(app.penmoss.ui.settings.SettingsRoutes.HOME) },
                )
            }
            settingsRoutes(SettingsHost(graph, nav, context))
        }
    }
}

/** The app's home's own route, under the Settings routes it shares with a notebook's screens. */
internal const val HOME_ROUTE = "notebooks"

/**
 * Rendered files someone edited by hand in the repository: the sync overwrote them from the
 * notes, which are the source, as the Mac's Settings and the CLI say. They said "read back", which
 * told Ryan his edits were kept when they were replaced (git's history still has them) (T39 pass 3, A893).
 */
internal fun handEditsText(paths: List<String>): String {
    val shown = paths.take(5).joinToString(", ") + if (paths.size > 5) "…" else ""
    return "Edited by hand: Penmoss wrote ${if (paths.size == 1) "it" else "these"} again from the notes (edit them in Penmoss): $shown"
}
