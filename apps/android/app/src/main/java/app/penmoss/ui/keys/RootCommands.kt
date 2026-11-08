package app.penmoss.ui.keys

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.ui.DeepLinkInbox

/**
 * What the app's commands do on any screen (T40 P9, PL9, A494): each opens its screen or does its
 * action, as the web's do. Lambdas, so the screens test without the app's graph.
 */
data class RootActions(
    val open: (route: String) -> Unit,
    val home: () -> Unit,
    val search: () -> Unit,
    /** Search with its actions listed first, the web's palette (T40 P6, FD6). */
    val palette: () -> Unit = search,
    val today: () -> Unit,
    val thisWeek: () -> Unit,
    val newNote: () -> Unit,
    val newFolder: () -> Unit,
    val sort: (mode: String) -> Unit,
    val capture: () -> Unit,
    val toggleDark: () -> Unit,
    val toggleFullWidth: () -> Unit,
    /** The graph of every note (T40 P7, LK7). */
    val graph: () -> Unit = {},
    /** Send feedback (T49): captures the screen in front, then opens the form over it. */
    val feedback: () -> Unit = {},
    /** Waits until the screen in front can open another (a launcher shortcut at a cold start). */
    val settled: suspend () -> Unit = {},
)

/** The routes the root's commands open (the screens' own route names). */
object CommandRoutes {
    const val SETTINGS = "settings"
    const val SHORTCUTS = "settings/shortcuts"
    const val APPEARANCE = "settings/appearance"
    const val DAILY = "settings/daily"
    const val DISPLAY = "settings/display"
    const val SYMBOLS = "settings/symbols"

    /** Settings → Git notebooks (T50 G7, A856). */
    const val GIT_NOTEBOOKS = "settings/git"
    /** Feedback still on the phone and the GitHub token (T59, A1046). */
    const val ABOUT = "settings/about"
    const val TRASH = "trash"
    const val JOURNAL = "journal"
}

/**
 * The commands every screen has (T40 P9, A494), registered while the notes' screens are shown;
 * a screen in front registers its own over them (a folder's New note files there). Also acts on
 * a launcher shortcut's New note, Today or Search (PL3, A496) once these screens are up; its
 * note opens as a deep link's does, through the same [inbox].
 */
@Composable
fun RootCommands(actions: RootActions, inbox: DeepLinkInbox) {
    RegisterCommand("app.palette") { actions.palette() }
    RegisterCommand("app.quickOpen") { actions.search() }
    RegisterCommand("app.search") { actions.search() }
    RegisterCommand("app.cheatsheet") { actions.open(CommandRoutes.SHORTCUTS) }
    RegisterCommand("app.shortcuts") { actions.open(CommandRoutes.SHORTCUTS) }
    RegisterCommand("app.settings") { actions.open(CommandRoutes.SETTINGS) }
    RegisterCommand("app.gitNotebooks") { actions.open(CommandRoutes.GIT_NOTEBOOKS) }
    RegisterCommand("app.status") { actions.open(CommandRoutes.ABOUT) }
    RegisterCommand("app.sendFeedback") { actions.feedback() }
    RegisterCommand("app.appearance") { actions.open(CommandRoutes.APPEARANCE) }
    RegisterCommand("app.display") { actions.open(CommandRoutes.DISPLAY) }
    RegisterCommand("app.symbols") { actions.open(CommandRoutes.SYMBOLS) }
    RegisterCommand("theme.switch") { actions.open(CommandRoutes.APPEARANCE) }
    RegisterCommand("journal.settings") { actions.open(CommandRoutes.DAILY) }
    RegisterCommand("journal.calendar") { actions.open(CommandRoutes.JOURNAL) }
    RegisterCommand("app.trash") { actions.open(CommandRoutes.TRASH) }
    RegisterCommand("app.home") { actions.home() }
    RegisterCommand("journal.today") { actions.today() }
    RegisterCommand("journal.thisWeek") { actions.thisWeek() }
    RegisterCommand("note.new") { actions.newNote() }
    RegisterCommand("folder.new") { actions.newFolder() }
    RegisterCommand("folder.sortManual") { actions.sort("manual") }
    RegisterCommand("folder.sortAlpha") { actions.sort("alpha") }
    RegisterCommand("folder.sortModified") { actions.sort("modified") }
    RegisterCommand("app.capture") { actions.capture() }
    RegisterCommand("theme.toggleDark") { actions.toggleDark() }
    RegisterCommand("note.fullWidth") { actions.toggleFullWidth() }
    RegisterCommand("app.graph") { actions.graph() }

    val launched by inbox.action.collectAsStateWithLifecycle()
    LaunchedEffect(launched) {
        val action = launched ?: return@LaunchedEffect
        actions.settled()
        when (action) {
            LauncherAction.NewNote -> actions.newNote()
            LauncherAction.Today -> actions.today()
            LauncherAction.Search -> actions.search()
            LauncherAction.ThisWeek -> actions.thisWeek()
            // Offered as a link (MainActivity), so never here.
            is LauncherAction.OpenNote -> Unit
        }
        inbox.acted(action)
    }
}

/** What a folder's screen does with the folder commands (T40 P9): its own folder, not the top level. */
@Composable
fun FolderCommands(newNote: () -> Unit, newFolder: () -> Unit, sort: (String) -> Unit) {
    RegisterCommand("note.new") { newNote() }
    RegisterCommand("folder.new") { newFolder() }
    RegisterCommand("folder.sortManual") { sort("manual") }
    RegisterCommand("folder.sortAlpha") { sort("alpha") }
    RegisterCommand("folder.sortModified") { sort("modified") }
}

/**
 * A tag's notes (T40 P6, TG2): the web's Show all notes clears the sidebar's tag filter; here the
 * filter is this screen, so it is Back ([clear]).
 */
@Composable
fun TaggedCommands(clear: () -> Unit) {
    RegisterCommand("tags.clearFilter", run = clear)
}
