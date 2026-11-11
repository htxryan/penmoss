package app.penmoss.ui

import app.penmoss.engine.settings.QuickAccess
import app.penmoss.engine.settings.SettingKeys
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.ui.Alignment
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.penmoss.capture.Captures
import app.penmoss.capture.RefusedCapturesScreen
import app.penmoss.data.CapturesWaiting
import app.penmoss.data.NoteStore
import android.net.Uri
import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import androidx.navigation.NavType
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.CompositionLocalProvider
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.penmoss.AppGraph
import app.penmoss.editor.NewNoteRequest
import app.penmoss.editor.PeriodicNoteRequest
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.notes.Ulid
import app.penmoss.feedback.AboutScreen
import app.penmoss.feedback.FeedbackRoute
import app.penmoss.feedback.FeedbackRoutes
import app.penmoss.feedback.FeedbackWhere
import app.penmoss.feedback.NoteExtras
import app.penmoss.feedback.WhereFacts
import app.penmoss.feedback.feedbackActivity
import app.penmoss.sync.SyncStatus
import app.penmoss.ui.FolderItem
import app.penmoss.ui.JournalMarks
import app.penmoss.ui.NoteItem
import app.penmoss.ui.journalMarksOf
import app.penmoss.ui.screens.AllNotesScreen
import app.penmoss.ui.screens.FolderScreen
import app.penmoss.ui.screens.HomeScreen
import app.penmoss.ui.screens.JournalScreen
import app.penmoss.ui.keys.CommandRoutes
import app.penmoss.ui.keys.FolderCommands
import app.penmoss.ui.keys.RootCommands
import app.penmoss.ui.keys.ShortcutsRoute
import app.penmoss.ui.keys.openCapture
import app.penmoss.ui.keys.rootActions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

/** The note in front, when a note's screen is: feedback's context describes it (T49). */
private fun noteOpen(nav: NavController): String? =
    nav.currentBackStackEntry?.takeIf { it.destination.route == NOTE_ROUTE }?.arguments?.getString("id")

/** How long Search takes to close before the screen behind it is captured (T49). */
private const val SEARCH_CLOSE_MS = 450L

/** How many recently changed notes Home reads: Recent Notes' longest (Settings → Display sets how many show, T53). */
private const val RECENT = app.penmoss.engine.settings.SidebarLayout.RECENT_MAX

/**
 * A git notebook's screens (T32; T50 G7, A880): the native screens around the editor. Since T59
 * every graph shown here is a git notebook's: the app's own opens on the notebooks themselves
 * ([app.penmoss.git.NotebooksHome], A1040).
 */
@Composable
fun PenmossRoot(graph: AppGraph, deepLinks: DeepLinkInbox = DeepLinkInbox()) {
    LaunchedEffect(graph) { graph.sync.requestSync() }
    // The lists' selection mode (T42 on Android, NT26, A652), which their rows join.
    val selection = remember { NoteSelection() }
    CompositionLocalProvider(LocalNoteSelection provides selection) { Screens(graph, deepLinks) }
}

@Composable
private fun Screens(graph: AppGraph, deepLinks: DeepLinkInbox) {
    val nav = rememberNavController()
    val context = LocalContext.current
    val status by graph.sync.status.collectAsStateWithLifecycle()
    // While a pass runs, the line keeps saying when the last one ended (T39): the minute's pass
    // no longer turns it into "Syncing…" and back.
    var settled by remember { mutableStateOf<SyncStatus>(SyncStatus.Idle) }
    LaunchedEffect(status) { if (status !is SyncStatus.Syncing) settled = status }
    // Stopped, the line says so and leads to what resolves it (T42 on Android, AC12, A651).
    val stop by graph.sync.stop.collectAsStateWithLifecycle()
    val passText = statusText(if (status is SyncStatus.Syncing && settled !is SyncStatus.Idle) settled else status)
    val statusText = stop?.let(::stoppedLine) ?: passText
    val openNote: (String) -> Unit = { id -> nav.open("note/$id") }
    /** A link followed to a heading (T40 P7, LK3): the note opens there. */
    val openNoteAt: (String, String?) -> Unit = { id, heading -> nav.open(noteRouteAt(id, heading)) }
    // A `penmoss://note/<id>` link (T40 P7, PL5): opens the note, over whatever is in front,
    // unless it is the note in front already. Opening is all it does (A476).
    val linked by deepLinks.note.collectAsStateWithLifecycle()
    LaunchedEffect(linked) {
        val id = linked ?: return@LaunchedEffect
        val front = nav.currentBackStackEntry
        if (!(front?.destination?.route == NOTE_ROUTE && front.arguments?.getString("id") == id)) nav.navigate("note/$id")
        deepLinks.opened(id)
    }
    /** New note (T38): named here, made by the editor as its screen opens, offline too. */
    val newNote: (String?) -> Unit = { folder -> nav.startNewNote(folder) }
    /** The folder picker over every screen: for a new note, or to move a note. */
    var choosing by remember { mutableStateOf<Choosing?>(null) }
    val moveFromList: (NoteItem) -> Unit = { note ->
        graph.scope.launch { choosing = Choosing.Move(note.id, note.title, graph.store.folderOf(note.id)) }
    }
    /** Says what happened to a note over every screen, with Undo (Move to Trash, NT12). */
    val rootSnackbar = remember { SnackbarHostState() }
    val trashNote: (String) -> Unit = { id -> graph.scope.moveToTrashWithUndo(graph.store, { graph.sync.requestSync() }, rootSnackbar, id) }
    // A move to Trash a restore elsewhere overruled (409 `restored_since`, A430): said once,
    // also when a background pass met it while the app was closed (kept in the database).
    LaunchedEffect(graph.store) {
        graph.store.observeTrashNotices().collect { notices ->
            val notice = notices.firstOrNull() ?: return@collect
            graph.store.trashNoticeShown(notice.id)
            rootSnackbar.say(trashRefusedMessage(notice.title), SnackbarTone.Error, duration = SnackbarDuration.Long)
        }
    }
    /** Copy Agent Reference from a list (T52 item 4): read from Room, said over every screen. */
    val copyAgentReference: (String) -> Unit = { id ->
        graph.scope.launch {
            val said = agentReferenceOf(graph.store, id, (graph.source as? app.penmoss.git.GraphSource.Git)?.name)?.let { AgentReference.copy(context, it) }
                ?: "This note isn't on this phone any more"
            rootSnackbar.currentSnackbarData?.dismiss()
            rootSnackbar.say(said, if (said == AgentReference.COPIED) SnackbarTone.Done else SnackbarTone.Error)
        }
    }
    /** A long press on a search result (T40 P3a, NT10): Move to folder…, Rename, Move to Trash. */
    var acting by remember { mutableStateOf<NoteItem?>(null) }
    val searchNoteActions: (NoteItem) -> Unit = { acting = it }
    /** A long press on a note in a list starts selection mode (T42 on Android, NT26, A652). */
    val selection = LocalNoteSelection.current ?: remember { NoteSelection() }
    val noteActions: (NoteItem) -> Unit = { selection.start(it) }
    /** A long press on a folder (T40 P4, NT3–NT5): rename it, make a subfolder, move or delete it. */
    var folderActing by remember { mutableStateOf<FolderItem?>(null) }
    /** Naming a folder made or renamed here (T40 P4, NT2, NT3). */
    var folderNaming by remember { mutableStateOf<FolderNaming?>(null) }
    /** Deleting a folder (T40 P4, NT4): counts what moves up. */
    var folderDeleting by remember { mutableStateOf<FolderItem?>(null) }
    /** Turning a notebook back into a folder (T43, A756): asked first. */
    var notebookTurningBack by remember { mutableStateOf<FolderItem?>(null) }
    val setNotebook: (FolderItem, Boolean) -> Unit = { folder, on ->
        graph.scope.launch { Toast.makeText(context, setNotebookAndSay(graph, folder.id, folder.name, on), Toast.LENGTH_SHORT).show() }
    }
    /** Reordering the top level's folders (T40 P4, NT7). */
    var homeReordering by remember { mutableStateOf(false) }
    /** Reordering inside a folder (T40 P4, NT7): the folder, or null when not. */
    var folderReordering by remember { mutableStateOf<String?>(null) }
    /** Says what a folder action did, over every screen. */
    fun sayFolder(message: String) = Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    val createFolder: (String, String?) -> Unit = { name, parent ->
        graph.scope.launch { sayFolder(createFolderAndSay(graph, name, parent)) }
    }
    val renameFolder: (String, String) -> Unit = { id, name ->
        graph.scope.launch { sayFolder(renameFolderAndSay(graph, id, name)) }
    }
    val moveFolder: (String, String?) -> Unit = { id, parent ->
        graph.scope.launch { sayFolder(moveFolderAndSay(graph, id, parent)) }
    }
    val deleteFolder: (String) -> Unit = { id ->
        graph.scope.launch { sayFolder(deleteFolderAndSay(graph, id)) }
    }
    val createNotebook: (String) -> Unit = { name ->
        graph.scope.launch { sayFolder(createNotebookAndSay(graph, name)) }
    }
    val sortFolder: (String?, String) -> Unit = { id, mode ->
        graph.scope.launch { sayFolder(sortFolderAndSay(graph, id, mode)) }
    }
    // A folder change the server refused because the folder is gone there (dropped, A443): said
    // once, also when a background pass met it while the app was closed (kept in the database).
    LaunchedEffect(graph.store) {
        graph.store.observeFolderNotices().collect { notices ->
            val notice = notices.firstOrNull() ?: return@collect
            graph.store.dismissFolderNotice(notice)
            rootSnackbar.say(notice, SnackbarTone.Error, duration = SnackbarDuration.Long)
        }
    }
    /** Opens Today, a calendar day or a week's note: made by the editor page, offline too (T40 P5). */
    val openPeriodic: (ToEditor.PeriodKind, String?) -> Unit = { kind, day ->
        // Today and This week go to the Journal notebook (T50 G7, A827): a git one opens there.
        val journal = (graph.journalGraph()?.source as? app.penmoss.git.GraphSource.Git)?.takeIf { day == null && !graph.isGit }
        if (journal != null) {
            app.penmoss.git.GitNotebookActivity.open(
                context,
                journal.localId,
                if (kind == ToEditor.PeriodKind.DAILY) app.penmoss.ui.keys.LauncherAction.Today else app.penmoss.ui.keys.LauncherAction.ThisWeek,
            )
        } else {
            nav.open(periodicNoteRoute(kind.wire, day))
        }
    }
    /** A tag's notes (T40 P6, TG2): from Tags, and from a `#tag` tapped in a note (TG5). */
    val openTag: (String) -> Unit = { tag -> nav.open("tag/${Uri.encode(tag)}") }
    // Send feedback (T49, D41): the screen in front and its context are captured first, then
    // the form opens over it (A801). [settle] waits for a screen closing to go first.
    val window = remember(context) { context.feedbackActivity()?.window }
    val openFeedback: (from: String, noteId: String?, extras: NoteExtras?, panel: String?, settle: Long) -> Unit = { from, noteId, extras, panel, settle ->
        graph.scope.launch {
            if (settle > 0) kotlinx.coroutines.delay(settle)
            val entry = nav.currentBackStackEntry
            val pattern = entry?.destination?.route
            val args = entry?.arguments
            val folderId = if (pattern?.startsWith("folder/") == true) args?.getString("id") else noteId?.let { graph.store.folderOf(it) }
            val where = WhereFacts(
                route = FeedbackWhere.route(pattern) { args?.getString(it) },
                screen = FeedbackWhere.screen(pattern),
                panel = panel,
                openedFrom = from,
                folderPath = graph.feedback.collector.folderPath(folderId),
                notebook = graph.feedback.collector.notebookName(folderId),
            )
            graph.feedback.open(where, noteId, extras, window) { nav.open(FeedbackRoutes.FORM) }
        }
    }
    // Once sent, wherever the app is: "Sent as #123" with a link to the issue (A796).
    LaunchedEffect(graph.feedbackOutbox) {
        graph.feedbackOutbox.sent.collect { filed ->
            val result = rootSnackbar.showSnackbar("Sent as #${filed.number}", actionLabel = "Open", withDismissAction = true, duration = SnackbarDuration.Long)
            if (result == androidx.compose.material3.SnackbarResult.ActionPerformed) {
                runCatching { androidx.browser.customtabs.CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(filed.url)) }
            }
        }
    }
    // Search's actions (T40 P6, FD6): Search gives way to what each opens, as the palette closes.
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
    val actionTargets = ActionTargets(
        open = { route -> nav.navigate(route) { popUpTo(SEARCH_ROUTE) { inclusive = true } } },
        home = { nav.popBackStack("home", false) },
        newNote = {
            nav.popBackStack(SEARCH_ROUTE, true)
            choosing = Choosing.NewNote(null)
        },
        newFolder = {
            nav.popBackStack(SEARCH_ROUTE, true)
            folderNaming = FolderNaming.Create(null)
        },
        capture = {
            nav.popBackStack(SEARCH_ROUTE, true)
            context.startActivity(app.penmoss.capture.CaptureTileService.captureIntent(context))
        },
        periodic = { kind -> nav.navigate(periodicNoteRoute(kind.wire, null)) { popUpTo(SEARCH_ROUTE) { inclusive = true } } },
        toggleDark = {
            nav.popBackStack(SEARCH_ROUTE, true)
            graph.device.changeSetting(app.penmoss.engine.settings.SettingKeys.MODE, kotlinx.serialization.json.JsonPrimitive(if (appearance.isDark(systemDark)) "light" else "dark"))
        },
        // The screen behind Search, once Search has closed, is what is captured (A801).
        feedback = {
            nav.popBackStack(SEARCH_ROUTE, true)
            openFeedback("Search's actions", null, null, null, SEARCH_CLOSE_MS)
        },
    )
    // A hardware keyboard's commands on every screen, and launcher shortcuts (T40 P9, A494, A496);
    // Ctrl+K (`app.palette`) opens Search with its actions listed (FD6, A466).
    RootCommands(
        rootActions(
            graph, nav, context, openPeriodic, newNote,
            feedback = { openFeedback("a keyboard shortcut", noteOpen(nav), null, null, 0) },
        ) {
            folderNaming = FolderNaming.Create(null)
        },
        deepLinks,
    )

    // Selection ends when the screen it was made on goes (A652).
    val front by nav.currentBackStackEntryAsState()
    LaunchedEffect(front?.id) { selection.clear() }

    // Screens slide sideways like the rest of Android (A351, PenmossNavHost).
    Box(Modifier.fillMaxSize()) {
        PenmossNavHost(nav, startDestination = "home") {
            composable("home") {
                val home by remember {
                    // Recent: opened here or edited anywhere, whichever is later (T40 P6, FD7).
                    // Open notebooks only (T43, A752); the open notebooks at the top (A750).
                    combine(
                        graph.store.observeRecent(RECENT, graph.hiddenFolders), graph.store.observeFolders(), graph.store.observeRootSortMode(),
                        graph.closedNotebooks.closed, graph.store.observeDefaultNotebookName(),
                    ) { notes, folders, mode, closed, notebookName ->
                        val now = System.currentTimeMillis()
                        val (notebooks, topFolders) = Items.home(mode, folders, closed, now)
                        HomeView(Items.notes(notes, now), notebooks, topFolders, notebookName)
                    }.distinctUntilChanged().flowOn(Dispatchers.Default)
                }.collectAsStateWithLifecycle(HomeView())
                val rootSort by remember { graph.store.observeRootSortMode().distinctUntilChanged() }.collectAsStateWithLifecycle("manual")
                val keptApart by remember { graph.store.observeConflictNotes().distinctUntilChanged() }.collectAsStateWithLifecycle(0)
                val capturesWaiting by remember { graph.captures.observeWaitingSummary().distinctUntilChanged() }.collectAsStateWithLifecycle(CapturesWaiting())
                val capturesRefused by remember { graph.captures.observeRefused().distinctUntilChanged() }.collectAsStateWithLifecycle(0)
                val settingsNow by graph.device.settings.collectAsStateWithLifecycle()
                // Quick Access (T51, A946): the notes pinned, in pin order.
                val quickAccess by remember {
                    // The device's pins (A1014), this notebook's notes.
                    graph.store.observeQuickAccess(graph.device.settings.map { it.settings.quickAccess }).map { Items.notes(it, System.currentTimeMillis()) }.distinctUntilChanged().flowOn(Dispatchers.Default)
                }.collectAsStateWithLifecycle(emptyList())
                // Each pinned note's notebook, for Quick Access's notebook names (T53 item 10).
                val quickAccessNotebooks by remember {
                    combine(graph.store.observeQuickAccess(graph.device.settings.map { it.settings.quickAccess }), graph.store.observeFolders(), graph.store.observeDefaultNotebookName()) { pins, folders, defaultName ->
                        val index = app.penmoss.data.Notebooks.index(folders)
                        val names = folders.associate { it.id to it.name }
                        pins.associate { pin -> pin.id to (index.ofFolder(pin.folderId)?.let(names::get) ?: defaultName) }
                    }.distinctUntilChanged().flowOn(Dispatchers.Default)
                }.collectAsStateWithLifecycle(emptyMap())
                val layout = HomeLayout.of(settingsNow.settings)
                /** A change to the sidebar's layout, once the phone knows the settings (A411). */
                val changeLayout = { key: String, value: kotlinx.serialization.json.JsonElement ->
                    if (graph.device.settings.value.known) graph.device.changeSetting(key, value)
                }
                HomeScreen(
                    title = (graph.source as? app.penmoss.git.GraphSource.Git)?.name ?: "Penmoss",
                    quickAccess = quickAccess,
                    // The sidebar's sections and Quick Access (T53 items 8 and 10), synced settings.
                    layout = layout,
                    onSectionHidden = { section, hide ->
                        val hidden = graph.device.settings.value.settings.hiddenSections
                        changeLayout(SettingKeys.HIDDEN_SECTIONS, app.penmoss.engine.settings.SidebarLayout.toJson(app.penmoss.engine.settings.SidebarLayout.withHidden(hidden, section, hide)))
                    },
                    onSectionMove = { section, index ->
                        val order = graph.device.settings.value.settings.sectionOrder
                        changeLayout(SettingKeys.SECTION_ORDER, app.penmoss.engine.settings.SidebarLayout.toJson(app.penmoss.engine.settings.SidebarLayout.moved(order, section, index)))
                    },
                    quickAccessNotebooks = quickAccessNotebooks,
                    onQuickAccessRemove = { id ->
                        val pins = graph.device.settings.value.settings.quickAccess
                        QuickAccess.toggled(pins, id)?.let { changeLayout(SettingKeys.QUICK_ACCESS, QuickAccess.toJson(it)) }
                    },
                    onQuickAccessMove = { id, index ->
                        val pins = graph.device.settings.value.settings.quickAccess
                        val shown = quickAccess.map { it.id }
                        // The index among the pins shown; trashed pins keep their places around them.
                        val target = shown.getOrNull(index)
                        if (target != null) {
                            val rest = pins - id
                            val at = rest.indexOf(target) + if (index > shown.indexOf(id)) 1 else 0
                            changeLayout(SettingKeys.QUICK_ACCESS, QuickAccess.toJson(QuickAccess.moved(pins, id, at)))
                        }
                    },
                    onNotebookNewNote = { newNote(null) },
                    recent = home.recent,
                    folders = home.folders,
                    notebooks = home.notebooks,
                    defaultNotebook = home.defaultNotebook,
                    onNewNotebook = { folderNaming = FolderNaming.CreateNotebook }.takeUnless { graph.isGit },
                    status = statusText,
                    statusAlert = (if (status is SyncStatus.Syncing) settled else status) is SyncStatus.Offline,
                    syncing = status is SyncStatus.Syncing,
                    onSearch = { nav.open("search") },
                    onSettings = { nav.open("settings") },
                    onAllNotes = { nav.open("notes") },
                    onFolder = { nav.open("folder/$it") },
                    onOpen = openNote,
                    onToday = { openPeriodic(ToEditor.PeriodKind.DAILY, null) },
                    onThisWeek = { openPeriodic(ToEditor.PeriodKind.WEEKLY, null) },
                    onJournal = { nav.open("journal") },
                    onGraph = { nav.open(graphRoute(null)) },
                    // From Home, the top level unless another folder is picked (T38).
                    onNewNote = { choosing = Choosing.NewNote(null) },
                    keptApart = keptApart,
                    capturesWaiting = capturesWaiting.count,
                    capturesRefused = capturesRefused,
                    capturesWaitingWhy = capturesWhy(capturesWaiting, System.currentTimeMillis()),
                    onRefusedCaptures = { nav.open("captures") },
                    onNoteLongPress = noteActions,
                    onRefresh = { graph.sync.syncNow() },
                    onTrash = { nav.open(TrashRoutes.TRASH) },
                    onTags = { nav.open("tags") },
                    // Folders at the top level (T40 P4, NT2–NT7).
                    onNewFolder = { folderNaming = FolderNaming.Create(null) },
                    sortMode = rootSort,
                    onSort = { sortFolder(null, it) },
                    reordering = homeReordering,
                    onReorder = { homeReordering = it },
                    onMoveFolder = { id, before, after ->
                        graph.scope.launch { reorderFolderAndSay(graph, id, before, after) }
                    },
                    onFolderLongPress = { folderActing = it },
                    onCapture = { openCapture(context) },
                    shortcuts = HomeShortcuts.of(settingsNow.settings),
                    onCommands = { nav.open("search?actions=true") },
                    stopped = stop != null,
                    onStatus = { nav.open(SettingsRoutes.SYNC) },
                    onFeedback = { openFeedback("Home's ⋮ menu", null, null, null, 0) },
                )
            }
            composable("folder/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                val folderId = entry.arguments?.getString("id")
                // A folder's own New note, New folder and sort, over the root's (T40 P9).
                FolderCommands(
                    newNote = { newNote(folderId) },
                    newFolder = { folderNaming = FolderNaming.Create(folderId) },
                    sort = { if (folderId != null) sortFolder(folderId, it) },
                )
                val contents by remember(folderId) {
                    combine(graph.store.observeList(), graph.store.observeFolders(), graph.store.observeRootSortMode()) { notes, folders, mode ->
                        val folder = folders.firstOrNull { it.id == folderId }
                        val name = folder?.name ?: "Folder"
                        val (subfolders, filed) = Items.folder(folderId, mode, folders, notes, System.currentTimeMillis())
                        val above = Items.folderPath(folders, folder?.parentId)
                        val item = folder?.let { Items.item(it, folders) }
                        FolderView(
                            name = name,
                            folders = subfolders,
                            notes = filed,
                            sortMode = folder?.sortMode ?: "manual",
                            subtitle = Items.pathText(above.map { it.name }).takeIf { above.isNotEmpty() }
                                ?: "Notebook".takeIf { item?.notebook == true },
                            notebook = item?.notebook == true,
                            canBeNotebook = item?.canBeNotebook == true,
                        )
                    }.distinctUntilChanged().flowOn(Dispatchers.Default)
                }.collectAsStateWithLifecycle(FolderView("", emptyList(), emptyList(), "manual", null))
                FolderScreen(
                    title = contents.name,
                    folders = contents.folders,
                    notes = contents.notes,
                    onBack = { nav.leave(entry) },
                    onFolder = { nav.open("folder/$it") },
                    onOpen = openNote,
                    onNewNote = { newNote(folderId) },
                    onNewNoteIn = { choosing = Choosing.NewNote(folderId) },
                    onNoteLongPress = noteActions,
                    subtitle = contents.subtitle,
                    sortMode = contents.sortMode,
                    onSort = { if (folderId != null) sortFolder(folderId, it) },
                    onNewFolder = { folderNaming = FolderNaming.Create(folderId) },
                    onRenameFolder = { if (folderId != null) folderNaming = FolderNaming.Rename(folderId, contents.name, contents.notebook) },
                    onMoveFolderTo = { if (folderId != null) choosing = Choosing.MoveFolder(folderId, contents.name) },
                    onDeleteFolder = {
                        if (folderId != null) {
                            graph.scope.launch {
                                folderDeleting = graph.store.observeFolders().first()
                                    .firstOrNull { it.id == folderId }
                                    ?.let { FolderItem(it.id, it.name, notebook = it.notebook) }
                            }
                        }
                    },
                    // Notebooks (T43, A750, A756).
                    notebook = contents.notebook,
                    onTurnIntoNotebook = if (folderId != null && notebookOffers(FolderItem(folderId, contents.name, canBeNotebook = contents.canBeNotebook), graph.isGit).turnInto) {
                        { setNotebook(FolderItem(folderId, contents.name), true) }
                    } else {
                        null
                    },
                    onTurnBack = { if (folderId != null) notebookTurningBack = FolderItem(folderId, contents.name, notebook = true) },
                    onFolderLongPress = { folderActing = it },
                    reordering = folderReordering == folderId,
                    onReorder = { folderReordering = if (it) folderId else null },
                    onMoveFolder = { id, before, after ->
                        graph.scope.launch { reorderFolderAndSay(graph, id, before, after) }
                    },
                    onMoveNote = { id, before, after ->
                        graph.scope.launch { reorderNoteAndSay(graph, id, before, after) }
                    },
                )
            }
            composable("notes") { entry ->
                val notes by remember {
                    graph.store.observeList().map { Items.notes(it, System.currentTimeMillis()) }.distinctUntilChanged().flowOn(Dispatchers.Default)
                }.collectAsStateWithLifecycle(emptyList())
                AllNotesScreen(notes, onBack = { nav.leave(entry) }, onOpen = openNote, onNoteLongPress = noteActions)
            }
            composable(SEARCH_ROUTE, arguments = listOf(navArgument("actions") { type = NavType.BoolType; defaultValue = false })) { entry ->
                SearchRoute(
                    graph,
                    onBack = { nav.leave(entry) },
                    openNote,
                    searchNoteActions,
                    actionsFirst = entry.arguments?.getBoolean("actions") == true,
                    onAction = { runSearchAction(it.id, actionTargets) },
                )
            }
            // Tags (T40 P6, TG1–TG3): the tree, a tag's notes, rename and merge.
            composable("tags") { entry -> TagsRoute(graph, onBack = { nav.leave(entry) }, onOpenTag = openTag) }
            composable("tag/{tag}", arguments = listOf(navArgument("tag") { type = NavType.StringType })) { entry ->
                val tag = entry.arguments?.getString("tag") ?: return@composable
                app.penmoss.ui.keys.TaggedCommands(clear = { nav.leave(entry) })
                TaggedRoute(graph, tag, onBack = { nav.leave(entry) }, onOpen = openNote, onNoteLongPress = noteActions)
            }
            composable(TrashRoutes.TRASH) { entry ->
                TrashRoute(graph, onOpen = openNote, onBack = { nav.leave(entry) })
            }
            composable("captures") { entry ->
                val refused by remember { graph.captures.observeRefusedList() }.collectAsStateWithLifecycle(emptyList())
                val format = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
                RefusedCapturesScreen(
                    captures = refused,
                    dateOf = { format.format(Date(it)) },
                    onBack = { nav.leave(entry) },
                    onCopy = { copyCaptures(context, listOf(it)) },
                    onRetry = { graph.scope.launch { graph.captures.retry(it.id) } },
                    onWithoutPictures = { graph.scope.launch { graph.captures.sendWithoutMissingPictures(it.id) } },
                    onDiscard = { graph.scope.launch { graph.captures.discard(it.id) } },
                )
            }
            composable(NOTE_ROUTE, arguments = noteArguments) { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                // New note (T38): the editor makes it with this id and it is filed in the folder chosen.
                NoteRoute(
                    graph,
                    id,
                    onBack = { nav.leave(entry) },
                    onOpenNote = openNote,
                    onOpenNoteAt = openNoteAt,
                    onLocalGraph = { nav.open(graphRoute(id)) },
                    heading = entry.arguments?.getString("heading"),
                    onOpenTag = openTag,
                    create = newNoteRequest(entry),
                    onMade = entry::markNoteMade,
                    onSyncStorage = { nav.open(SettingsRoutes.SYNC) },
                    // Leaves the note (its last edits are stored as it goes), then moves it to Trash.
                    onTrash = {
                        nav.leave(entry)
                        trashNote(id)
                    },
                    focusTitle = entry.arguments?.getBoolean("focusTitle") == true,
                    // The breadcrumb's folder (T40 P4, NT11): back to Home for the top level,
                    // else the folder, leaving the note behind as the web navigates.
                    onOpenFolder = { folder ->
                        if (folder == null) nav.popBackStack("home", false)
                        else nav.navigate("folder/$folder") { popUpTo("home") }
                    },
                )
            }
            // The graph (T40 P7, LK7, LK8): from Room, offline too; a note's local graph.
            composable(GRAPH_ROUTE, arguments = graphArguments) { entry ->
                GraphRoute(graph, entry.arguments?.getString("note"), onBack = { nav.leave(entry) }, onOpen = openNote)
            }
            // The Journal calendar (T40 P5, JR3): month marks from Room, offline too.
            composable("journal") { entry ->
                val settings by graph.settings.collectAsStateWithLifecycle()
                val marks by remember {
                    graph.store.observeJournalMarks().map(::journalMarksOf)
                        .distinctUntilChanged().flowOn(Dispatchers.Default)
                }.collectAsStateWithLifecycle(JournalMarks())
                JournalScreen(
                    timeZone = settings.settings.timeZone,
                    marks = marks,
                    onBack = { nav.leave(entry) },
                    onOpenDay = { day -> openPeriodic(ToEditor.PeriodKind.DAILY, day) },
                    onOpenWeek = { monday -> openPeriodic(ToEditor.PeriodKind.WEEKLY, monday) },
                    onOpenToday = { openPeriodic(ToEditor.PeriodKind.DAILY, null) },
                )
            }
            // Today, a calendar day or a week's note (T40 P5, JR1, JR2): the editor page makes
            // it with the synced time zone and template, offline too; a note held already is
            // just opened. The screen is transient: once made, the note itself opens.
            composable(PERIODIC_ROUTE, arguments = periodicArguments) { entry ->
                val kind = ToEditor.PeriodKind.of(entry.arguments?.getString("kind")) ?: ToEditor.PeriodKind.DAILY
                val day = entry.arguments?.getString("day")
                NoteRoute(
                    graph,
                    periodicScreenId(kind, day),
                    onBack = { nav.leave(entry) },
                    onOpenNote = openNote,
                    onOpenTag = openTag,
                    periodic = PeriodicNoteRequest(kind, day),
                    onPeriodicMade = { id ->
                        if (nav.replaceWithNote(entry, id)) graph.sync.requestSync()
                    },
                    onOpenPeriodic = { next, date -> openPeriodic(next, date) },
                    onSyncStorage = { nav.open(SettingsRoutes.SYNC) },
                    onOpenFolder = { folder ->
                        if (folder == null) nav.popBackStack("home", false)
                        else nav.navigate("folder/$folder") { popUpTo("home") }
                    },
                )
            }
            // Settings → Keyboard shortcuts (T40 P9, ST8, A495).
            composable(CommandRoutes.SHORTCUTS) { entry -> ShortcutsRoute(graph.device, onBack = { nav.leave(entry) }) }
            // Send feedback (T49, D41): over the screen it was opened from, captured first.
            composable(FeedbackRoutes.FORM) { entry -> FeedbackRoute(graph, onClose = { nav.leave(entry) }) }
            // Settings → About (T49): the version, and Send feedback.
            composable(FeedbackRoutes.ABOUT) { entry ->
                AboutScreen(
                    version = graph.feedback.version,
                    onSendFeedback = { openFeedback("Settings → About", null, null, "Settings → About", 0) },
                    onBack = { nav.leave(entry) },
                    // Read again each time About is shown (back from the token's screen too).
                    githubToken = FeedbackRoutes.tokenSummary(graph.githubToken.hasToken, graph.githubToken.login()),
                    onGitHubToken = { nav.open(FeedbackRoutes.GITHUB_TOKEN) },
                    // Feedback still on the phone (A1046), with Retry, Edit and Discard.
                    outbox = { app.penmoss.feedback.FeedbackOutboxRoute(graph, openForm = { nav.open(FeedbackRoutes.FORM) }) },
                )
            }
            // Settings → About → GitHub Token (A1012): the token Send feedback files with.
            composable(FeedbackRoutes.GITHUB_TOKEN) { entry -> app.penmoss.feedback.GitHubTokenRoute(graph, onBack = { nav.leave(entry) }) }
            composable(SettingsRoutes.HOME) { entry ->
                SettingsHomeRoute(graph, statusText, onOpen = { nav.open(it) }, onBack = { nav.leave(entry) })
            }
            // What agents changed, with Undo (T42, A561; T40 P9, AC11).
            composable(AgentActivityRoutes.ACTIVITY) { entry -> AgentActivityRoute(graph, onBack = { nav.leave(entry) }) }
            // Which notebooks are open on this phone, and the default notebook's name (T43, A751, A752).
            composable(NotebookRoutes.SETTINGS) { entry -> NotebooksRoute(graph, onBack = { nav.leave(entry) }) }
            // Settings → Git notebooks (T50 G7, A856): the app's hub, from a git notebook's screens too.
            composable(app.penmoss.ui.keys.CommandRoutes.GIT_NOTEBOOKS) { entry ->
                app.penmoss.git.GitNotebooksRoute(
                    graph.git,
                    onOpen = { app.penmoss.git.GitNotebookActivity.open(context, it) },
                    onBack = { nav.leave(entry) },
                )
            }
            // Appearance, Display, Symbols, Quick capture and the shortcuts are the device's (A827).
            composable(SettingsRoutes.APPEARANCE) { entry ->
                AppearanceRoute(graph.device, onEditTheme = { nav.open(SettingsRoutes.theme(it)) }, onBack = { nav.leave(entry) })
            }
            composable(SettingsRoutes.THEME, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                ThemeEditorRoute(graph.device, id, onEditTheme = { nav.open(SettingsRoutes.theme(it)) }, onBack = { nav.leave(entry) })
            }
            composable(SettingsRoutes.DAILY) { entry ->
                DailyNotesRoute(graph, onTimeZone = { nav.open(SettingsRoutes.ZONE) }, onBack = { nav.leave(entry) })
            }
            composable(SettingsRoutes.ZONE) { entry -> TimeZoneRoute(graph, onBack = { nav.leave(entry) }) }
            composable(SettingsRoutes.CAPTURE) { entry -> QuickCaptureRoute(graph.device, onBack = { nav.leave(entry) }) }
            composable(SettingsRoutes.SYNC) { entry ->
                // A git notebook's sync is its own: the repository, the page, what waits (A880).
                app.penmoss.git.GitSyncRoute(graph, passText, onGitNotebooks = { nav.open(app.penmoss.ui.keys.CommandRoutes.GIT_NOTEBOOKS) }, onBack = { nav.leave(entry) }, onAgentActivity = { nav.open(AgentActivityRoutes.ACTIVITY) })
            }
            // Home's shortcuts, synced with the web's sidebar (T42, A576; T40 ST12, A650).
            composable(SettingsRoutes.DISPLAY) { entry -> DisplayRoute(graph.device, onBack = { nav.leave(entry) }) }
            // The line symbols, synced with the web's (T44, ST13, A747).
            composable(SettingsRoutes.SYMBOLS) { entry ->
                SymbolsRoute(graph.device, onShortcuts = { nav.open(app.penmoss.ui.keys.CommandRoutes.SHORTCUTS) }, onBack = { nav.leave(entry) })
            }
        }

        // Over the screen's own top bar while notes are chosen (A652); Back ends it first.
        if (selection.active) {
            BackHandler { selection.clear() }
            SelectionBar(
                picked = selection.picked,
                onClose = selection::clear,
                onMove = {
                    val picked = selection.picked
                    graph.scope.launch {
                        val folders = picked.map { graph.store.folderOf(it.id) }.distinct()
                        choosing = Choosing.MoveMany(picked, folders.toSet())
                    }
                },
                onTrash = {
                    val picked = selection.picked
                    selection.clear()
                    if (picked.size == 1) trashNote(picked.single().id)
                    else graph.scope.moveNotesToTrashWithUndo(graph.store, { graph.sync.requestSync() }, rootSnackbar, picked.map { it.id })
                },
                onRename = {
                    val note = selection.picked.single()
                    selection.clear()
                    nav.open("note/${note.id}?focusTitle=true")
                },
                modifier = Modifier.align(Alignment.TopCenter),
                // Beside the one note chosen, in its folder (T53 item 12).
                onNewNoteHere = {
                    val note = selection.picked.single()
                    selection.clear()
                    graph.scope.launch { val folder = graph.store.folderOf(note.id); withContext(Dispatchers.Main) { newNote(folder) } }
                },
                onNewFolderHere = {
                    val note = selection.picked.single()
                    selection.clear()
                    graph.scope.launch { val folder = graph.store.folderOf(note.id); withContext(Dispatchers.Main) { folderNaming = FolderNaming.Create(folder) } }
                },
                onCopyAgentReference = {
                    val note = selection.picked.single()
                    selection.clear()
                    copyAgentReference(note.id)
                },
            )
        }
        // Above the lists' New note button, which it would otherwise cover for its 5 seconds.
        SnackbarHost(rootSnackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = 72.dp)) { PenmossSnackbar(it) }
        // Ctrl+E on a hardware keyboard: the recent-notes switcher (T40 P6, FD7).
        val shown by nav.currentBackStackEntryAsState()
        RecentSwitcherHost(graph, shown?.takeIf { it.destination.route == NOTE_ROUTE }?.arguments?.getString("id"), openNote)
    }

    acting?.let { note ->
        NoteActionsSheet(
            note.title,
            onRename = {
                acting = null
                nav.open("note/${note.id}?focusTitle=true")
            },
            onMove = {
                acting = null
                moveFromList(note)
            },
            onTrash = {
                acting = null
                trashNote(note.id)
            },
            onDismiss = { acting = null },
            onCopyAgentReference = {
                acting = null
                copyAgentReference(note.id)
            },
            // Beside the note, in its folder (T53 item 12).
            onNewNoteHere = {
                acting = null
                graph.scope.launch { val folder = graph.store.folderOf(note.id); withContext(Dispatchers.Main) { newNote(folder) } }
            },
            onNewFolderHere = {
                acting = null
                graph.scope.launch { val folder = graph.store.folderOf(note.id); withContext(Dispatchers.Main) { folderNaming = FolderNaming.Create(folder) } }
            },
        )
    }

    folderActing?.let { folder ->
        FolderSheet(
            name = folder.name,
            onRename = {
                folderNaming = FolderNaming.Rename(folder.id, folder.name, folder.notebook)
                folderActing = null
            },
            onNewSubfolder = {
                folderNaming = FolderNaming.Create(folder.id)
                folderActing = null
            },
            onMove = {
                choosing = Choosing.MoveFolder(folder.id, folder.name)
                folderActing = null
            },
            onDelete = {
                folderDeleting = folder
                folderActing = null
            },
            onDismiss = { folderActing = null },
            // New Note Here (T52 item 1): made in this folder and opened, as the sidebar's menu does.
            onNewNoteHere = {
                folderActing = null
                newNote(folder.id)
            },
            notebook = folder.notebook,
            onTurnIntoNotebook = if (notebookOffers(folder, graph.isGit).turnInto) {
                {
                    setNotebook(folder, true)
                    folderActing = null
                }
            } else {
                null
            },
            onTurnBack = {
                notebookTurningBack = folder
                folderActing = null
            },
            // As the web's (A752): it leaves the lists, search and Recent here; Settings opens it again.
            onClose = if (notebookOffers(folder, graph.isGit).close) {
                {
                    graph.closedNotebooks.setOpen(folder.id, false)
                    sayFolder(notebookClosedMessage(folder.name))
                    folderActing = null
                }
            } else {
                null
            },
        )
    }

    notebookTurningBack?.let { folder ->
        val defaultName by remember { graph.store.observeDefaultNotebookName() }.collectAsStateWithLifecycle(app.penmoss.data.Notebooks.DEFAULT_NAME)
        NotebookTurnBackDialog(
            name = folder.name,
            defaultName = defaultName,
            onConfirm = {
                setNotebook(folder, false)
                notebookTurningBack = null
            },
            onDismiss = { notebookTurningBack = null },
        )
    }

    folderNaming?.let { naming ->
        when (naming) {
            is FolderNaming.Create -> NewFolderDialog(
                onConfirm = { name ->
                    createFolder(name, naming.parentId)
                    folderNaming = null
                },
                onDismiss = { folderNaming = null },
            )
            FolderNaming.CreateNotebook -> FolderNameDialog(
                title = "New Notebook",
                onConfirm = { name ->
                    createNotebook(name)
                    folderNaming = null
                },
                onDismiss = { folderNaming = null },
            )
            is FolderNaming.Rename -> FolderNameDialog(
                title = if (naming.notebook) "Rename Notebook" else "Rename Folder",
                initial = naming.current,
                onConfirm = { name ->
                    renameFolder(naming.id, name)
                    folderNaming = null
                },
                onDismiss = { folderNaming = null },
            )
        }
    }

    folderDeleting?.let { folder ->
        FolderDeleteHost(graph, folder) { folderDeleting = null }
    }

    when (val choice = choosing) {
        null -> Unit
        is Choosing.NewNote -> FolderPickerFor(
            graph,
            title = "New Note in…",
            current = choice.current,
            onPick = { folder ->
                choosing = null
                newNote(folder)
            },
            onDismiss = { choosing = null },
        )
        is Choosing.Move -> FolderPickerFor(
            graph,
            title = "Move “${choice.title}” to…",
            current = choice.current,
            onPick = { folder ->
                choosing = null
                graph.scope.launch {
                    Toast.makeText(context, moveNoteAndSay(graph, choice.noteId, folder), Toast.LENGTH_SHORT).show()
                }
            },
            onDismiss = { choosing = null },
        )
        is Choosing.MoveMany -> FolderPickerFor(
            graph,
            title = moveTitle(choice.picked),
            // The folder they share is marked; notes from several folders mark none.
            current = if (choice.shared.size == 1) choice.shared.single() else MIXED_FOLDERS,
            onPick = { folder ->
                choosing = null
                selection.clear()
                graph.scope.launch {
                    val name = folder?.let { id -> graph.store.observeFolders().first().firstOrNull { it.id == id }?.name?.ifBlank { null } }
                        ?: if (folder == null) Items.TOP_LEVEL else "the folder"
                    val said = moveNotesAndSay(graph.store, choice.picked.map { it.id }, folder, name) { graph.sync.requestSync() }
                    Toast.makeText(context, said, Toast.LENGTH_SHORT).show()
                }
            },
            onDismiss = { choosing = null },
        )
        is Choosing.MoveFolder -> {
            // The mark starts where the folder is (null: the top level).
            val parents by remember { graph.store.observeFolders() }.collectAsStateWithLifecycle(emptyList())
            val current = remember(parents) { parents.firstOrNull { it.id == choice.folderId }?.parentId }
            FolderPickerForMove(
                graph,
                title = "Move “${choice.title}” to…",
                current = current,
                exclude = choice.folderId,
                onPick = { folder ->
                    choosing = null
                    moveFolder(choice.folderId, folder)
                },
                onDismiss = { choosing = null },
            )
        }
    }
}

/** What the folder picker over the screens is choosing (T38). */
private sealed interface Choosing {
    /** A folder for a new note, starting from [current] (null: the top level). */
    data class NewNote(val current: String?) : Choosing

    /** Where to move a note, starting from where it is ([current]). */
    data class Move(val noteId: String, val title: String, val current: String?) : Choosing

    /** A parent for a folder: without the folder itself and its subfolders (T40 P4, NT5). */
    data class MoveFolder(val folderId: String, val title: String) : Choosing

    /**
     * Where to move the notes chosen in selection mode (A652), all in one pick; [shared] holds
     * the folders they are in (one: that folder is marked).
     */
    data class MoveMany(val picked: List<Picked>, val shared: Set<String?>) : Choosing
}

/** Marks no folder in the picker: the notes chosen are in several. */
private const val MIXED_FOLDERS = "\u0000several"

/** Naming a folder made or renamed here (T40 P4, NT2, NT3). */
private sealed interface FolderNaming {
    /** A folder under [parentId] (null: the top level). */
    data class Create(val parentId: String?) : FolderNaming

    /** A new name for [id], starting from [current]; [notebook]: a notebook's (T43). */
    data class Rename(val id: String, val current: String, val notebook: Boolean = false) : FolderNaming

    /** A notebook at the top level (T43, A750). */
    data object CreateNotebook : FolderNaming
}

/** Deletes a folder after saying what moves up (T40 P4, NT4); gone meanwhile: nothing to ask. */
@Composable
private fun FolderDeleteHost(graph: AppGraph, folder: FolderItem, onDone: () -> Unit) {
    val context = LocalContext.current
    val summary by produceState<NoteStore.FolderDeleteSummary?>(initialValue = null, folder.id) {
        value = graph.store.folderDeleteSummary(folder.id)
    }
    val counted = summary ?: return
    if (counted.notebook) {
        // A notebook goes to Trash with its notes (T43, A755).
        NotebookDeleteDialog(
            name = folder.name,
            notes = counted.notes,
            onConfirm = {
                graph.scope.launch {
                    Toast.makeText(context, deleteFolderAndSay(graph, folder.id, folder.name, notebook = true), Toast.LENGTH_SHORT).show()
                }
                onDone()
            },
            onDismiss = onDone,
        )
        return
    }
    FolderDeleteDialog(
        name = folder.name,
        notes = counted.notes,
        subfolders = counted.subfolders,
        destination = counted.destination,
        onConfirm = {
            graph.scope.launch {
                Toast.makeText(context, deleteFolderAndSay(graph, folder.id, folder.name), Toast.LENGTH_SHORT).show()
            }
            onDone()
        },
        onDismiss = onDone,
    )
}

/** A folder's screen: its name, rows, sort order and path from the top (T40 P4). */
private data class FolderView(
    val name: String,
    val folders: List<FolderItem>,
    val notes: List<NoteItem>,
    val sortMode: String,
    val subtitle: String?,
    val notebook: Boolean = false,
    val canBeNotebook: Boolean = false,
)

/** Home's lists (T43): Recent, the open notebooks, and the default notebook's top-level folders. */
private data class HomeView(
    val recent: List<NoteItem> = emptyList(),
    val notebooks: List<FolderItem> = emptyList(),
    val folders: List<FolderItem> = emptyList(),
    val defaultNotebook: String = app.penmoss.data.Notebooks.DEFAULT_NAME,
)

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

/** Puts captures' text on the clipboard, one after another (A345). */
private fun copyCaptures(context: Context, captures: List<Captures.Refused>) {
    val text = captures.joinToString("\n\n---\n\n") { it.text }
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Penmoss captures", text))
    Toast.makeText(context, if (captures.size == 1) "Copied." else "Copied ${captures.size} captures.", Toast.LENGTH_SHORT).show()
}

/** Why captures still wait, when worth saying (A345): a server not updated yet, or their age. */
internal fun capturesWhy(waiting: CapturesWaiting, now: Long): String? {
    if (waiting.count == 0) return null
    if (waiting.serverOutdated) return "Penmoss on the server has not been updated to take captures yet."
    val oldest = waiting.oldest ?: return null
    if (now - oldest < 24 * 60 * 60_000L) return null
    return "The oldest is from ${DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(oldest))}."
}
