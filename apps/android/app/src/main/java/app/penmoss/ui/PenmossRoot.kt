package app.penmoss.ui

import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHost
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import androidx.navigation.NavType
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.penmoss.NotebookGraph
import app.penmoss.editor.NewNoteRequest
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.notes.Ulid
import app.penmoss.sync.SyncStatus
import app.penmoss.ui.common.LocalNoteSelection
import app.penmoss.ui.common.NoteSelection
import app.penmoss.ui.common.PenmossSnackbar
import app.penmoss.ui.folders.folderRoutes
import app.penmoss.ui.graph.graphRoutes
import app.penmoss.ui.home.SyncLine
import app.penmoss.ui.home.homeRoutes
import app.penmoss.ui.home.stoppedLine
import app.penmoss.ui.journal.journalRoutes
import app.penmoss.ui.keys.RootCommands
import app.penmoss.ui.keys.rootActions
import app.penmoss.ui.note.noteRoutes
import app.penmoss.ui.search.ActionTargets
import app.penmoss.ui.search.searchRoutes
import app.penmoss.ui.settings.feedbackRoutes
import app.penmoss.ui.settings.settingsRoutes
import app.penmoss.ui.tags.tagRoutes
import app.penmoss.ui.trash.trashRoutes
import java.text.DateFormat
import java.util.Date

/** The note in front, when a note's screen is: feedback's context describes it (T49). */
private fun noteOpen(nav: NavController): String? =
    nav.currentBackStackEntry?.takeIf { it.destination.route == NOTE_ROUTE }?.arguments?.getString("id")

/** How long Search takes to close before the screen behind it is captured (T49). */
private const val SEARCH_CLOSE_MS = 450L

/**
 * A git notebook's screens (T32; T50 G7, A880): the native screens around the editor. Since T59
 * every graph shown here is a git notebook's: the app's own opens on the notebooks themselves
 * ([app.penmoss.git.NotebooksHome], A1040).
 */
@Composable
fun PenmossRoot(graph: NotebookGraph, deepLinks: DeepLinkInbox = DeepLinkInbox()) {
    LaunchedEffect(graph) { graph.sync.requestSync() }
    // The lists' selection mode (T42 on Android, NT26, A652), which their rows join.
    val selection = remember { NoteSelection() }
    CompositionLocalProvider(LocalNoteSelection provides selection) { Screens(graph, deepLinks) }
}

/**
 * The screens (A6): each feature's routes ([homeRoutes], [folderRoutes] and the rest) over the
 * state they share ([RootUi]), the selection bar and snackbar over them, and the app-wide dialogs.
 */
@Composable
private fun Screens(graph: NotebookGraph, deepLinks: DeepLinkInbox) {
    val nav = rememberNavController()
    val root = rememberRootUi(graph, nav)
    val sync = rememberSyncLine(graph)
    // A `penmoss://note/<id>` link (T40 P7, PL5): opens the note, over whatever is in front,
    // unless it is the note in front already. Opening is all it does (A476).
    val linked by deepLinks.note.collectAsStateWithLifecycle()
    LaunchedEffect(linked) {
        val id = linked ?: return@LaunchedEffect
        val front = nav.currentBackStackEntry
        if (!(front?.destination?.route == NOTE_ROUTE && front.arguments?.getString("id") == id)) nav.navigate("note/$id")
        deepLinks.opened(id)
    }
    RootNotices(root)
    // Search's actions (T40 P6, FD6): Search gives way to what each opens, as the palette closes.
    val targets = rememberActionTargets(root)
    // A hardware keyboard's commands on every screen, and launcher shortcuts (T40 P9, A494, A496);
    // Ctrl+K (`app.palette`) opens Search with its actions listed (FD6, A466).
    RootCommands(
        rootActions(
            graph, nav, root.context, root::openPeriodic, root::newNote,
            sort = { root.sortFolder(null, it) },
            feedback = { root.openFeedback("a keyboard shortcut", noteOpen(nav), null, null, 0) },
        ) {
            root.folderNaming = FolderNaming.Create(null)
        },
        deepLinks,
    )

    // Selection ends when the screen it was made on goes (A652).
    val front by nav.currentBackStackEntryAsState()
    LaunchedEffect(front?.id) { root.selection.clear() }

    // Screens slide sideways like the rest of Android (A351, PenmossNavHost).
    Box(Modifier.fillMaxSize()) {
        // Settings' (i) names the primary notebook on every Settings screen (A1560).
        CompositionLocalProvider(app.penmoss.ui.settings.LocalPrimaryNotebookName provides app.penmoss.ui.settings.rememberPrimaryName(graph.device)) {
            PenmossNavHost(nav, startDestination = "home") {
                homeRoutes(root, sync)
                folderRoutes(root)
                searchRoutes(root, targets)
                tagRoutes(root)
                trashRoutes(root)
                noteRoutes(root)
                graphRoutes(root)
                journalRoutes(root)
                // Settings over this notebook's screens (PEN-146): the same screens as the app's first screen's.
                settingsRoutes(
                    app.penmoss.ui.settings.SettingsHost(
                        graph.device,
                        nav,
                        root.context,
                        notebook = graph,
                        openFeedback = { from -> root.openFeedback(from, null, null, from, 0) },
                        syncPass = sync.pass,
                        openNotebook = { id ->
                            if (id == graph.localId) nav.popBackStack("home", false) else app.penmoss.git.GitNotebookActivity.open(root.context, id)
                        },
                    ),
                )
                feedbackRoutes(root)
            }
        }

        RootSelectionBar(root, Modifier.align(Alignment.TopCenter))
        // Above the lists' New note button, which it would otherwise cover for its 5 seconds.
        SnackbarHost(root.snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = 72.dp)) { PenmossSnackbar(it) }
        // Ctrl+E on a hardware keyboard: the recent-notes switcher (T40 P6, FD7).
        RecentSwitcherHost(graph, front?.takeIf { it.destination.route == NOTE_ROUTE }?.arguments?.getString("id"), root::openNote)
    }

    RootDialogs(root)
}

/**
 * The notebook's sync line (T39, A651). While a pass runs, the line keeps saying when the last
 * one ended: the minute's pass no longer turns it into "Syncing…" and back. Stopped, the line
 * says so and leads to what resolves it (T42 on Android, AC12, A651).
 */
@Composable
private fun rememberSyncLine(graph: NotebookGraph): SyncLine {
    val status by graph.sync.status.collectAsStateWithLifecycle()
    var settled by remember { mutableStateOf<SyncStatus>(SyncStatus.Idle) }
    LaunchedEffect(status) { if (status !is SyncStatus.Syncing) settled = status }
    val stop by graph.sync.stop.collectAsStateWithLifecycle()
    val pass = statusText(if (status is SyncStatus.Syncing && settled !is SyncStatus.Idle) settled else status)
    return SyncLine(
        text = stop?.let(::stoppedLine) ?: pass,
        pass = pass,
        alert = (if (status is SyncStatus.Syncing) settled else status) is SyncStatus.Offline,
        syncing = status is SyncStatus.Syncing,
        stopped = stop != null,
    )
}

/** What Search's actions open (T40 P6, FD6): each gives way to what it opens as the palette closes. */
@Composable
private fun rememberActionTargets(root: RootUi): ActionTargets {
    val nav = root.nav
    val context = root.context
    val appearance by root.graph.appearance.collectAsStateWithLifecycle()
    val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
    return ActionTargets(
        open = { route -> nav.navigate(route) { popUpTo(SEARCH_ROUTE) { inclusive = true } } },
        home = { nav.popBackStack("home", false) },
        newNote = {
            nav.popBackStack(SEARCH_ROUTE, true)
            root.choosing = Choosing.NewNote(null)
        },
        newFolder = {
            nav.popBackStack(SEARCH_ROUTE, true)
            root.folderNaming = FolderNaming.Create(null)
        },
        capture = {
            nav.popBackStack(SEARCH_ROUTE, true)
            context.startActivity(app.penmoss.capture.CaptureTileService.captureIntent(context))
        },
        periodic = { kind -> nav.navigate(periodicNoteRoute(kind.wire, null)) { popUpTo(SEARCH_ROUTE) { inclusive = true } } },
        toggleDark = {
            nav.popBackStack(SEARCH_ROUTE, true)
            root.graph.device.changeSetting(app.penmoss.engine.settings.SettingKeys.MODE, kotlinx.serialization.json.JsonPrimitive(if (appearance.isDark(systemDark)) "light" else "dark"))
        },
        // The screen behind Search, once Search has closed, is what is captured (A801).
        feedback = {
            nav.popBackStack(SEARCH_ROUTE, true)
            root.openFeedback("Search's actions", null, null, null, SEARCH_CLOSE_MS)
        },
    )
}

/** The route of a new note's screen (T38): its id, and the folder it goes in when there is one. */
fun newNoteRoute(id: String, folder: String?): String =
    if (folder == null) "note/$id?new=true" else "note/$id?new=true&folder=${Uri.encode(folder)}"

/**
 * A note's screen: `note/<id>` to open one, or a new note's route (T38); `heading` scrolls it to
 * a heading once it shows (T40 P7, LK3).
 */
internal const val NOTE_ROUTE = "note/{id}?new={new}&folder={folder}&focusTitle={focusTitle}&heading={heading}"

/** The route opening a note at a heading (T40 P7, LK3), or at its top when [heading] is null. */
fun noteRouteAt(id: String, heading: String?): String =
    if (heading.isNullOrBlank()) "note/$id" else "note/$id?heading=${Uri.encode(heading)}"

/**
 * A periodic note's screen (T40 P5, JR1, JR2): `periodic?kind=daily&day=2026-10-21`, the day
 * null for today in the synced time zone. The page makes the note; the screen is transient
 * and the note itself opens once made. The `day` is an explicit calendar day, or null.
 */
/** Search (T32; T40 P6): `search?actions=true` lists every action first, as Ctrl+K opens it (FD6). */
internal const val SEARCH_ROUTE = "search?actions={actions}"

internal const val PERIODIC_ROUTE = "periodic?kind={kind}&day={day}"

internal val periodicArguments = listOf(
    navArgument("kind") { type = NavType.StringType },
    navArgument("day") {
        type = NavType.StringType
        nullable = true
        defaultValue = null
    },
)

/** The route opening the period's note: its kind, and an explicit day when one is named. */
fun periodicNoteRoute(kind: String, day: String?): String =
    if (day == null) "periodic?kind=$kind" else "periodic?kind=$kind&day=${Uri.encode(day)}"

/** The controller's key on a periodic screen: one screen per kind and day (T40 P5). */
fun periodicScreenId(kind: ToEditor.PeriodKind, day: String?): String = "periodic/${kind.wire}/${day ?: "today"}"

internal val noteArguments = listOf(
    navArgument("id") { type = NavType.StringType },
    navArgument("new") {
        type = NavType.BoolType
        defaultValue = false
    },
    navArgument("folder") {
        type = NavType.StringType
        nullable = true
        defaultValue = null
    },
    navArgument("focusTitle") {
        type = NavType.BoolType
        defaultValue = false
    },
    navArgument("heading") {
        type = NavType.StringType
        nullable = true
        defaultValue = null
    },
)

private const val NOTE_MADE = "noteMade"

/**
 * Opens [route] from the screen in front, once it has settled (T39, A387): a second tap while
 * the new screen still slides in does nothing, so two quick taps open one screen, not two.
 */
internal fun NavController.open(route: String) {
    if (currentBackStackEntry?.lifecycle?.currentState != Lifecycle.State.RESUMED) return
    navigate(route)
}

/**
 * Leaves [entry]'s screen (its Back button), only while it is the settled screen in front
 * (T39, A387). Two quick taps on Back used to pop Home too, leaving a blank window.
 */
internal fun NavController.leave(entry: NavBackStackEntry) {
    if (entry.lifecycle.currentState != Lifecycle.State.RESUMED || currentBackStackEntry != entry) return
    popBackStack()
}

/**
 * Opens a new note's screen (T38), unless one is already in front: a second tap on New note
 * before the first screen shows makes no second note (A362).
 */
internal fun NavController.startNewNote(folder: String?) {
    val front = currentBackStackEntry
    if (front?.destination?.route == NOTE_ROUTE && front.arguments?.getBoolean("new") == true) return
    navigate(newNoteRoute(Ulid.next(), folder))
}

/**
 * What a note's screen asks the editor for: a new note while its route says so and it is not
 * made yet. Once made, the entry remembers (saved with it), so coming back to it, even after the
 * note was deleted for good, never makes the note again under the same id (A362).
 */
internal fun newNoteRequest(entry: NavBackStackEntry): NewNoteRequest? {
    val args = entry.arguments ?: return null
    if (!args.getBoolean("new") || entry.savedStateHandle.get<Boolean>(NOTE_MADE) == true) return null
    return NewNoteRequest(args.getString("folder"))
}

/** The new note this entry asked for is stored. */
internal fun NavBackStackEntry.markNoteMade() {
    savedStateHandle[NOTE_MADE] = true
}


internal fun statusText(status: SyncStatus): String = when (status) {
    SyncStatus.Idle -> ""
    SyncStatus.Syncing -> "Syncing…"
    is SyncStatus.Synced -> "Synced at ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(status.at))}"
    is SyncStatus.Offline ->
        if (status.serverError) "Penmoss couldn’t sync just now and will try again. Showing what’s on this phone."
        else "Offline: showing what’s on this phone"
}
