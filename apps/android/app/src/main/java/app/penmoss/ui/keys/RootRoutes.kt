package app.penmoss.ui.keys

import android.content.Context
import android.content.res.Configuration
import android.widget.Toast
import androidx.navigation.NavHostController
import app.penmoss.AppGraph
import app.penmoss.capture.CaptureTileService
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.ui.GRAPH_ROUTE
import app.penmoss.ui.SEARCH_ROUTE
import app.penmoss.ui.graphRoute
import app.penmoss.ui.open
import app.penmoss.ui.sortFolderAndSay
import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonPrimitive

/** Quick capture inside the app (T40 P9, PL1, A496): the same sheet the tile and widget open. */
fun openCapture(context: Context) {
    runCatching { context.startActivity(CaptureTileService.captureIntent(context)) }
}

/**
 * The root's commands as the app does them (T40 P9, A494): every one opens what the screen's
 * own button opens, so a key and a tap end in the same place. Settings' screens open over the
 * one in front, as from Home's buttons.
 */
internal fun rootActions(
    graph: AppGraph,
    nav: NavHostController,
    context: Context,
    openPeriodic: (ToEditor.PeriodKind, String?) -> Unit,
    newNote: (String?) -> Unit,
    /** Send feedback (T49): from the screen in front. */
    feedback: () -> Unit = {},
    newFolder: () -> Unit,
): RootActions = RootActions(
    feedback = feedback,
    open = { route -> if (nav.currentDestination?.route != route) nav.open(route) },
    home = { if (nav.currentDestination?.route != "home") nav.popBackStack("home", false) },
    search = { if (nav.currentDestination?.route != SEARCH_ROUTE) nav.open("search") },
    // Ctrl+K: Search with every action listed first (T40 P6, FD6, A466), unless Search is in front.
    palette = { if (nav.currentDestination?.route != SEARCH_ROUTE) nav.open("search?actions=true") },
    today = { openPeriodic(ToEditor.PeriodKind.DAILY, null) },
    thisWeek = { openPeriodic(ToEditor.PeriodKind.WEEKLY, null) },
    newNote = { newNote(null) },
    newFolder = newFolder,
    sort = { mode ->
        graph.scope.launch { Toast.makeText(context, sortFolderAndSay(graph, null, mode), Toast.LENGTH_SHORT).show() }
    },
    capture = { openCapture(context) },
    // The opposite of the variant shown, as the web's `toggleDarkMode` does.
    toggleDark = {
        val systemDark = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val dark = graph.appearance.value.isDark(systemDark)
        graph.changeSetting(SettingKeys.MODE, JsonPrimitive(if (dark) "light" else "dark"))
    },
    toggleFullWidth = { graph.changeSetting(SettingKeys.FULL_WIDTH, JsonPrimitive(!graph.settings.value.settings.fullWidth)) },
    // The whole graph, unless it is in front already (a note's own graph is another).
    graph = {
        val front = nav.currentBackStackEntry
        if (front?.destination?.route != GRAPH_ROUTE || front.arguments?.getString("note") != null) nav.open(graphRoute(null))
    },
    // A launcher shortcut at a cold start waits for Home to settle: `open` acts only from a
    // settled screen (A387), so an early one would be dropped.
    settled = {
        withTimeoutOrNull(5_000) {
            while (nav.currentBackStackEntry?.lifecycle?.currentState != Lifecycle.State.RESUMED) delay(50)
        }
    },
)
