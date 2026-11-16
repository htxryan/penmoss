package app.penmoss.ui.home

import androidx.activity.compose.BackHandler
import app.penmoss.ui.settings.HomeLayout
import app.penmoss.engine.settings.SidebarLayout
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.material3.HorizontalDivider
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import app.penmoss.ui.settings.HomeShortcuts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.material.icons.Icons
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.DrawerValue
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import app.penmoss.ui.common.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import app.penmoss.ui.common.FilledTonalButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import app.penmoss.ui.common.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.produceState
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.delay
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.ui.common.EmptyMessage
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.FolderRowView
import app.penmoss.ui.common.LocalNoteSelection
import app.penmoss.ui.common.NoteItem
import app.penmoss.ui.common.NoteList
import app.penmoss.ui.common.KeepSelectionShown
import app.penmoss.ui.common.NoteRowView
import app.penmoss.ui.common.underSelectionBar
import app.penmoss.ui.folders.ReorderList
import app.penmoss.ui.common.SectionTitle
import app.penmoss.ui.folders.SortMenu
import app.penmoss.ui.common.DotState
import app.penmoss.ui.common.SectionTitleWithDot
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.NotebookBadgeView
import app.penmoss.ui.common.SyncDot
import app.penmoss.ui.common.SyncStateDot
import app.penmoss.ui.common.rememberLucideIcons
import app.penmoss.ui.common.TipIconButton
import app.penmoss.ui.settings.SettingsIcons
import androidx.compose.foundation.layout.size
import androidx.compose.ui.semantics.contentDescription

@Composable
private fun BackButton(onBack: () -> Unit) {
    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
}

/**
 * The notebook screen's pages (Ryan's Android feedback, 15 Nov 2026, item 11; A1608): the Mac
 * sidebar's sections, each a page of its own that the drawer picks, instead of one long Home.
 * A notebook opens on its notes list.
 */
enum class HomePage(val title: String?) {
    /** The notebook's folders and its top-level notes, under its heading; titled by the notebook. */
    NOTES(null),
    QUICK_ACCESS("Quick Access"),
    RECENT("Recent Notes"),
}

/** What Home shows (A6): its lists, the sync state and the person's layout. */
@Immutable
data class HomeUi(
    /** The page shown (A1608). */
    val page: HomePage = HomePage.NOTES,
    /** The notebook's top-level notes, under its folders on the notes list (A1608). */
    val notes: List<NoteItem> = emptyList(),
    val recent: List<NoteItem> = emptyList(),
    val folders: List<FolderItem> = emptyList(),
    val status: String = "",
    val syncing: Boolean = false,
    /** Notes holding edits kept apart that wait for a conflict copy (A323). */
    val keptApart: Int = 0,
    /** Captures saved on the phone and not sent yet, and those Penmoss refused (A337). */
    val capturesWaiting: Int = 0,
    val capturesRefused: Int = 0,
    /** Why captures still wait, when it is worth saying (A345): their age, or the server. */
    val capturesWaitingWhy: String? = null,
    /**
     * The status needs attention (offline, or the server failing): TalkBack reads it out when it
     * changes. "Synced at …" changes after every pass and is not read out (A530).
     */
    val statusAlert: Boolean = false,
    /** The top level's sort order (T40 P4, NT6), from the Sort icon. */
    val sortMode: String = "manual",
    /** Manual order (T40 P4, NT7): the folders list becomes handles to drag. */
    val reordering: Boolean = false,
    /** Which of Home's shortcuts show (T42 on Android, ST12, A650): Settings → Display. */
    val shortcuts: HomeShortcuts = HomeShortcuts(),
    /** Sync has stopped (T42 on Android, AC12, A651): the status line is a link to what resolves it. */
    val stopped: Boolean = false,
    /**
     * The notebook's name, on the heading over [folders] and under Quick Access's notes: the git
     * notebook's, as the web's sidebar names its section (A1538).
     */
    val notebook: String = "",
    /** The notebook's badge (A1579), before its name on that heading, as the Mac's sidebar has it. */
    val badge: app.penmoss.engine.settings.NotebookBadge? = null,
    /** The top bar's title: Penmoss, or a git notebook's name (T50 G7, A880). */
    val title: String = "Penmoss",
    /** The notes pinned to Quick Access (T51, A946); the section shows with none too, saying No Notes. */
    val quickAccess: List<NoteItem> = emptyList(),
    /** Home's sections, their order and which show (T53 item 8, A983): the synced settings. */
    val layout: HomeLayout = HomeLayout(),
    /** Each Quick Access note's notebook, by note id, when Settings shows it (T53 item 10). */
    val quickAccessNotebooks: Map<String, String> = emptyMap(),
    /** This notebook's local id, which the drawer marks among [notebooks] (A1604). */
    val notebookId: String = "",
    /** The notebooks on this phone, the drawer's Notebooks (A1604). */
    val notebooks: List<DrawerNotebook> = emptyList(),
)

/** What Home's taps, presses and pulls do (A6). */
class HomeActions(
    val onSearch: () -> Unit = {},
    val onSettings: () -> Unit = {},
    val onAllNotes: () -> Unit = {},
    val onFolder: (String) -> Unit = {},
    val onOpen: (String) -> Unit = {},
    val onToday: () -> Unit = {},
    /** This week's note, made from the template offline too (T40 P5, JR2). */
    val onThisWeek: () -> Unit = {},
    val onNewNote: () -> Unit = {},
    /** Opens the list of refused captures (A345). */
    val onRefusedCaptures: () -> Unit = {},
    /** A long press on a note: its actions, Move to folder… and Move to Trash (T38, T40 P3a). */
    val onNoteLongPress: ((NoteItem) -> Unit)? = null,
    /**
     * Pulling the list down, or Sync now, asks for a sync now (T39), and returns once the pass
     * it asked for has ended (SyncCoordinator.syncNow).
     */
    val onRefresh: suspend () -> Unit = {},
    /** Opens Trash (T40 P3a, NT13), from the top bar's overflow menu. */
    val onTrash: () -> Unit = {},
    /** Opens the Journal calendar (T40 P5, JR3), from the top bar's overflow menu. */
    val onJournal: () -> Unit = {},
    /** Opens the graph (T40 P7, LK7), from the top bar's overflow menu. */
    val onGraph: () -> Unit = {},
    /** Opens Tags (T40 P6, TG1), from the top bar's overflow menu. */
    val onTags: () -> Unit = {},
    /** Makes a folder at the top level (T40 P4, NT2), from the overflow menu. */
    val onNewFolder: () -> Unit = {},
    val onSort: (String) -> Unit = {},
    val onReorder: (Boolean) -> Unit = {},
    val onMoveFolder: (id: String, before: String?, after: String?) -> Unit = { _, _, _ -> },
    /** A long press on a folder (T40 P4, NT3–NT5): rename it, make a subfolder, move or delete it. */
    val onFolderLongPress: ((FolderItem) -> Unit)? = null,
    /** Quick capture inside the app (T40 P9, PL1): the sheet the tile and widget open. */
    val onCapture: () -> Unit = {},
    /** Search with every action listed, the web's Commands (FD6), from the overflow menu. */
    val onCommands: () -> Unit = {},
    /** A stopped sync's dot opens what resolves it (T42 on Android, AC12, A651). */
    val onStatus: () -> Unit = {},
    /** Send feedback (T49, D41), last in the overflow menu; none when null. */
    val onFeedback: (() -> Unit)? = null,
    /** A Quick Access note's long press: Remove from Quick Access (T53 item 10). */
    val onQuickAccessRemove: (String) -> Unit = {},
    /** Moves a pinned note to an index in Quick Access (its Move Up and Move Down). */
    val onQuickAccessMove: (id: String, index: Int) -> Unit = { _, _ -> },
    /** A new note at the notebook's top level, from its heading's long press (T53 item 4). */
    val onNotebookNewNote: () -> Unit = onNewNote,
    /** Opens another notebook on this phone, from the drawer (A1604). */
    val onNotebook: (localId: String) -> Unit = {},
    /** The app's first screen, every notebook on this phone (A1604). */
    val onAllNotebooks: () -> Unit = {},
    /** Shows one of the notebook screen's pages, from the drawer, or the notes list on Back (A1608). */
    val onPage: (HomePage) -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(ui: HomeUi, actions: HomeActions) {
    // The spinner shows until the pass asked for ends: not one already running, and not 3 s
    // more when the pass fails at once (T39 review).
    var pulled by remember { mutableStateOf(false) }
    // System Back ends Reorder mode first, instead of leaving Home (T40 P4 review S6).
    BackHandler(enabled = ui.reordering) { actions.onReorder(false) }
    val refresh by rememberUpdatedState(actions.onRefresh)
    val pull = { pulled = true }
    // The minute's pass usually takes well under a second: the bar shows only for a longer one,
    // so Home does not flicker every minute (T39).
    val slowSync by produceState(false, ui.syncing) {
        if (ui.syncing) {
            delay(SLOW_SYNC_MS)
            value = true
        } else {
            value = false
        }
    }
    LaunchedEffect(pulled) {
        if (!pulled) return@LaunchedEffect
        refresh()
        pulled = false
    }
    // A chosen note the page stops listing is no longer chosen (A652, review S2).
    if (actions.onNoteLongPress != null) KeepSelectionShown(if (ui.page == HomePage.RECENT) ui.recent else ui.notes)
    // Back from Quick Access or Recent Notes goes to the notes list, the notebook's first page (A1608).
    BackHandler(enabled = ui.page != HomePage.NOTES && !ui.reordering) { actions.onPage(HomePage.NOTES) }
    val notesPage = ui.page == HomePage.NOTES
    // The notebook's sync state as a dot (T51, A933), with the status line's words.
    val personalDot = when {
        ui.stopped -> SyncDot(DotState.STOPPED, ui.status, actions.onStatus)
        ui.statusAlert -> SyncDot(DotState.OFFLINE, ui.status)
        slowSync || pulled -> SyncDot(DotState.SYNCING, "Syncing…")
        ui.status.isEmpty() -> SyncDot(DotState.IDLE, "Not synced yet")
        else -> SyncDot(DotState.SYNCED, ui.status)
    }
    // The hamburger's drawer, with the Mac sidebar's areas (A1604).
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val drawerScope = rememberCoroutineScope()
    BackHandler(enabled = drawer.isOpen) { drawerScope.launch { drawer.close() } }
    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = !ui.reordering,
        drawerContent = { HomeDrawerSheet(ui, actions) { drawerScope.launch { drawer.close() } } },
    ) {
    Scaffold(
        topBar = {
            TopAppBar(
                // Under the selection bar while notes are chosen: out of TalkBack's reach (review S4).
                modifier = Modifier.underSelectionBar(),
                // The notes list is titled by its notebook: its badge, its name and its sync dot
                // (A1613), once, where the list had a heading of its own under the bar (A933).
                title = {
                    val name = if (ui.reordering) "Reorder Folders" else ui.page.title ?: ui.notebook.ifEmpty { ui.title }
                    if (notesPage && !ui.reordering) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ui.badge?.let {
                                NotebookBadgeView(it, ui.notebook, size = 24.dp, decorative = true)
                                Spacer(Modifier.width(12.dp))
                            }
                            Text(name, Modifier.weight(1f, fill = false).testTag("homeTitle"), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            SyncStateDot(personalDot, Modifier.testTag("syncDot"))
                        }
                    } else {
                        Text(name, Modifier.testTag("homeTitle"))
                    }
                },
                navigationIcon = {
                    if (ui.reordering) {
                        BackButton { actions.onReorder(false) }
                    } else {
                        TipIconButton(Icons.Default.Menu, "Open Menu", onClick = { drawerScope.launch { drawer.open() } }, modifier = Modifier.testTag("homeMenu"))
                    }
                },
                actions = {
                    if (ui.reordering) {
                        TextButton(onClick = { actions.onReorder(false) }, modifier = Modifier.testTag("reorderDone")) { Text("Done") }
                    } else {
                        // Pull to refresh as a button, for TalkBack, Switch Access and anyone who doesn't pull.
                        TipIconButton(Icons.Default.Refresh, "Sync Now", onClick = pull, enabled = !pulled, modifier = Modifier.testTag("homeSyncNow"))
                        // Sort moved to the notebook's heading, beside New Folder and Trash (T52 item 10).
                        // The gear, as the sidebar's footer has it (T51, A935).
                        TipIconButton(SettingsIcons.Gear, "Settings", onClick = actions.onSettings, modifier = Modifier.testTag("homeSettings"))
                        var more by remember { mutableStateOf(false) }
                        var sorting by remember { mutableStateOf(false) }
                        // New Folder and Reorder Folders act on the notes list; the other pages have no ⋮.
                        if (notesPage) Box {
                            TipIconButton(Icons.Default.MoreVert, "More Options", onClick = { more = true }, modifier = Modifier.testTag("homeMore"))
                            DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                                DropdownMenuItem(
                                    text = { Text("New Folder") },
                                    onClick = {
                                        more = false
                                        actions.onNewFolder()
                                    },
                                    modifier = Modifier.testTag("homeNewFolder"),
                                )
                                // The notebook heading's actions (T52 item 10), now the heading is the title (A1613).
                                DropdownMenuItem(
                                    text = { Text("Sort Order…") },
                                    onClick = {
                                        more = false
                                        sorting = true
                                    },
                                    modifier = Modifier.testTag("homeSort"),
                                )
                                if (ui.sortMode == "manual") {
                                    DropdownMenuItem(
                                        text = { Text("Reorder Folders") },
                                        onClick = {
                                            more = false
                                            actions.onReorder(true)
                                        },
                                        modifier = Modifier.testTag("homeReorder"),
                                    )
                                }
                            }
                            SortMenu(expanded = sorting, current = ui.sortMode, onPick = { sorting = false; actions.onSort(it) }, onDismiss = { sorting = false })
                        }
                    }
                },
            )
        },
        floatingActionButton = {
            if (!ui.reordering) {
                FloatingActionButton(onClick = actions.onNewNote) { Icon(Icons.Default.Add, contentDescription = "New Note") }
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = pulled,
            onRefresh = pull,
            modifier = Modifier.fillMaxSize().padding(padding).testTag("homeRefresh"),
        ) {
            Column(Modifier.fillMaxSize()) {
                if (slowSync && !pulled) LinearProgressIndicator(Modifier.fillMaxWidth().testTag("syncProgress"))
                // The sidebar's shortcuts as one row of icons (T51, A932); Display hides any but Search.
                if (!ui.reordering && notesPage) HomeShortcutRow(ui.shortcuts, actions.onSearch, actions.onToday, actions.onThisWeek, actions.onGraph, actions.onCommands, actions.onTags, actions.onJournal, actions.onAllNotes, actions.onCapture)
                // The status line became a dot on the section titles (T51, A933). Going offline or
                // stopping is still announced, from above the list, which a dot in it scrolled
                // away would not be (A530).
                Box(
                    Modifier
                        .size(1.dp)
                        .testTag("syncStatus")
                        .semantics {
                            contentDescription = ui.status
                            if (ui.statusAlert || ui.stopped) liveRegion = LiveRegionMode.Polite
                        },
                )
                if (ui.reordering) {
                    ReorderList(
                        folders = ui.folders,
                        notes = emptyList(),
                        onCommitFolder = { id, before, after -> actions.onMoveFolder(id, before, after) },
                        onCommitNote = { _, _, _ -> },
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                val choosing = actions.onNoteLongPress != null && LocalNoteSelection.current?.active == true
                // Each page starts at its top (A1608).
                val homeList = remember(ui.page) { androidx.compose.foundation.lazy.LazyListState() }
                // Each page is one of the sidebar's sections (A1608), so no section titles.
                val shown = listOf(
                    when (ui.page) {
                        HomePage.NOTES -> SidebarLayout.NOTEBOOKS
                        HomePage.QUICK_ACCESS -> SidebarLayout.QUICK_ACCESS
                        HomePage.RECENT -> SidebarLayout.RECENT
                    },
                )
                // A notice at the top coming or going (kept-apart edits, captures waiting) while the
                // list is at its top stays in view (T53 pass): the list keeps its first item in place
                // by key, so it would land above the screen. Asked before the next measure.
                val top = Pair(shown, listOf(ui.keptApart > 0, ui.capturesWaiting > 0 || ui.capturesRefused > 0))
                val topBefore = remember { arrayOf(top) }
                SideEffect {
                    if (top != topBefore[0]) {
                        val atTop = homeList.firstVisibleItemScrollOffset == 0 && homeList.firstVisibleItemIndex <= 1
                        if (atTop) homeList.requestScrollToItem(0)
                        topBefore[0] = top
                    }
                }
                NoteList(
                    notes = emptyList(),
                    onOpen = actions.onOpen,
                    state = homeList,
                    contentPadding = PaddingValues(bottom = FAB_CLEARANCE),
                    header = {
                        item(key = "actions", contentType = "actions") {
                            if (ui.keptApart > 0) KeptApartNotice(ui.keptApart)
                            if (ui.capturesWaiting > 0 || ui.capturesRefused > 0) {
                                CapturesNotice(ui.capturesWaiting, ui.capturesRefused, ui.capturesWaitingWhy, actions.onRefusedCaptures)
                            }
                        }
                        for (section in shown) {
                            when (section) {
                                // Quick Access (T51, A946): the pinned notes. With none it still shows, as
                                // on the web (T53 pass).
                                SidebarLayout.QUICK_ACCESS -> {
                                    if (ui.quickAccess.isEmpty()) {
                                        item(key = "quickAccessEmpty", contentType = "hint") {
                                            Text(
                                                // No drag to pin here, so not the web's "Drag Here to Pin"; as quiet.
                                                "No Notes",
                                                Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("homeQuickAccessEmpty"),
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                    items(ui.quickAccess, key = { "quick:${it.id}" }, contentType = { "pin" }) { note ->
                                        val at = ui.quickAccess.indexOf(note)
                                        QuickAccessRow(
                                            note = note,
                                            notebook = ui.quickAccessNotebooks[note.id].takeIf { ui.layout.quickAccessNotebook },
                                            onOpen = actions.onOpen,
                                            onRemove = { actions.onQuickAccessRemove(note.id) },
                                            onMoveUp = if (at > 0) ({ actions.onQuickAccessMove(note.id, at - 1) }) else null,
                                            onMoveDown = if (at < ui.quickAccess.size - 1) ({ actions.onQuickAccessMove(note.id, at + 1) }) else null,
                                            modifier = Modifier.testTag("homeQuickAccess-${note.id}"),
                                        )
                                    }
                                }
                                SidebarLayout.NOTEBOOKS -> {
                                    // No heading: the bar's title is the notebook, with its badge and dot (A1613).
                                    items(ui.folders, key = { "folder:${it.id}" }, contentType = { "folder" }) { folder ->
                                        FolderRowView(folder, actions.onFolder, onLongPress = actions.onFolderLongPress, enabled = !choosing)
                                    }
                                    // Then its top-level notes, as a folder's page lists its own (A1608).
                                    items(ui.notes, key = { "note:${it.id}" }, contentType = { "note" }) { note ->
                                        NoteRowView(note, actions.onOpen, onLongPress = actions.onNoteLongPress, selectable = true)
                                    }
                                }
                                SidebarLayout.RECENT -> {
                                    items(ui.recent.take(ui.layout.recentCount), key = { it.id }, contentType = { "note" }) { note ->
                                        NoteRowView(note, actions.onOpen, onLongPress = actions.onNoteLongPress, selectable = true)
                                    }
                                }
                            }
                        }
                        val empty = when (ui.page) {
                            HomePage.NOTES -> ui.folders.isEmpty() && ui.notes.isEmpty()
                            HomePage.RECENT -> ui.recent.isEmpty()
                            HomePage.QUICK_ACCESS -> false
                        }
                        if (empty) {
                            item(key = "empty") { EmptyMessage("No notes yet. They appear here once the phone has synced.") }
                        }
                    },
                )
                }
            }
        }
    }
    }
}

/**
 * A Quick Access note on Home (T51, A946): its title, and its notebook in subtle text under it
 * when Settings → Display says so (T53 item 10). A long press offers Remove from Quick Access, and
 * Move Up and Move Down for its place in the list (the web drags it).
 */
@Composable
private fun QuickAccessRow(
    note: NoteItem,
    notebook: String?,
    onOpen: (String) -> Unit,
    onRemove: () -> Unit,
    onMoveUp: (() -> Unit)?,
    onMoveDown: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    var menu by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    Box(modifier) {
        Column(
            Modifier
                .fillMaxWidth()
                .combinedClickable(
                    role = Role.Button,
                    onClickLabel = "Open",
                    onLongClickLabel = "Quick Access Actions",
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        menu = true
                    },
                ) { onOpen(note.id) }
                .padding(horizontal = 16.dp, vertical = 10.dp),
        ) {
            Text(note.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (notebook != null) {
                Text(
                    notebook,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("quickAccessNotebook"),
                )
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("Remove from Quick Access") }, onClick = { menu = false; onRemove() }, modifier = Modifier.testTag("quickAccessRemove"))
            if (onMoveUp != null) DropdownMenuItem(text = { Text("Move Up") }, onClick = { menu = false; onMoveUp() }, modifier = Modifier.testTag("quickAccessMoveUp"))
            if (onMoveDown != null) DropdownMenuItem(text = { Text("Move Down") }, onClick = { menu = false; onMoveDown() }, modifier = Modifier.testTag("quickAccessMoveDown"))
        }
    }
}

/**
 * Edits sync kept apart, possibly in the background, where no conflict copy can be made: only
 * the editor page reads Yjs (A306, A323). They wait on the phone until a note is open.
 */
@Composable
private fun KeptApartNotice(notes: Int) {
    Text(
        "Edits on this phone to ${if (notes == 1) "1 note" else "$notes notes"} could not sync: the note was " +
            "restored or deleted elsewhere, or Penmoss refused them. They are kept here and become " +
            "conflict copies the next time you open a note.",
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("keptApart"),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.error,
    )
}

/**
 * Captures saved offline wait on the phone until sync sends them (A337); those that cannot go
 * as they are open in a list, to copy, try again or discard (A345).
 */
@Composable
private fun CapturesNotice(waiting: Int, refused: Int, why: String?, onRefused: () -> Unit) {
    if (waiting > 0) {
        Text(
            "${if (waiting == 1) "1 capture is" else "$waiting captures are"} saved on this phone and will be added once it syncs.",
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("capturesWaiting"),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (why != null) {
            Text(
                why,
                Modifier.padding(horizontal = 16.dp).testTag("capturesWaitingWhy"),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    if (refused > 0) {
        Text(
            "Penmoss refused ${if (refused == 1) "1 capture" else "$refused captures"}. " +
                "${if (refused == 1) "It is" else "They are"} kept on this phone.",
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("capturesRefused"),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )
        TextButton(onClick = onRefused, Modifier.padding(horizontal = 4.dp).testTag("capturesRefusedOpen")) {
            Text(if (refused == 1) "See It" else "See Them")
        }
    }
}

/**
 * A folder's subfolders and notes, in the folder's sort order; the top level when `title` is
 * "Folders". New note (T38) makes a note in this folder; "New note in…" picks another, starting
 * from this one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderScreen(
    title: String,
    folders: List<FolderItem>,
    notes: List<NoteItem>,
    onBack: () -> Unit,
    onFolder: (String) -> Unit,
    onOpen: (String) -> Unit,
    onNewNote: (() -> Unit)? = null,
    onNewNoteIn: (() -> Unit)? = null,
    onNoteLongPress: ((NoteItem) -> Unit)? = null,
    /** The folder's path from the top (T40 P4), shown under its name. */
    subtitle: String? = null,
    /** The folder's sort order (T40 P4, NT6), from the Sort icon. */
    sortMode: String = "manual",
    onSort: (String) -> Unit = {},
    /** Makes a folder here (T40 P4, NT2). */
    onNewFolder: () -> Unit = {},
    /** Renames, moves or deletes this folder (T40 P4, NT3–NT5). */
    onRenameFolder: () -> Unit = {},
    onMoveFolderTo: () -> Unit = {},
    onDeleteFolder: () -> Unit = {},
    /** A long press on a subfolder (T40 P4, NT3–NT5). */
    onFolderLongPress: ((FolderItem) -> Unit)? = null,
    /** Manual order (T40 P4, NT7): the list becomes handles to drag. */
    reordering: Boolean = false,
    onReorder: (Boolean) -> Unit = {},
    onMoveFolder: (id: String, before: String?, after: String?) -> Unit = { _, _, _ -> },
    onMoveNote: (id: String, before: String?, after: String?) -> Unit = { _, _, _ -> },
) {
    var menu by remember { mutableStateOf(false) }
    var sorting by remember { mutableStateOf(false) }
    // System Back ends Reorder mode first, instead of leaving the folder (T40 P4 review S6).
    BackHandler(enabled = reordering) { onReorder(false) }
    if (onNoteLongPress != null) KeepSelectionShown(notes)
    Scaffold(
        topBar = {
            TopAppBar(
                modifier = Modifier.underSelectionBar(),
                title = {
                    Column {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (subtitle != null) {
                            Text(
                                subtitle,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = { BackButton(onBack = { if (reordering) onReorder(false) else onBack() }) },
                actions = {
                    if (reordering) {
                        TextButton(onClick = { onReorder(false) }, modifier = Modifier.testTag("reorderDone")) { Text("Done") }
                    } else {
                        Box {
                            IconButton(onClick = { sorting = true }, modifier = Modifier.testTag("folderSort")) {
                                Icon(SettingsIcons.Sort, contentDescription = "Sort Order")
                            }
                            SortMenu(expanded = sorting, current = sortMode, onPick = { sorting = false; onSort(it) }, onDismiss = { sorting = false })
                        }
                        Box {
                            IconButton(onClick = { menu = true }, modifier = Modifier.testTag("folderMore")) {
                                Icon(Icons.Default.MoreVert, contentDescription = "More Options")
                            }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                if (onNewNoteIn != null) {
                                    DropdownMenuItem(
                                        text = { Text("New Note in…") },
                                        onClick = {
                                            menu = false
                                            onNewNoteIn()
                                        },
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text("New Folder") },
                                    onClick = {
                                        menu = false
                                        onNewFolder()
                                    },
                                    modifier = Modifier.testTag("folderNew"),
                                )
                                DropdownMenuItem(
                                    text = { Text("Rename Folder") },
                                    onClick = {
                                        menu = false
                                        onRenameFolder()
                                    },
                                    modifier = Modifier.testTag("folderRename"),
                                )
                                DropdownMenuItem(
                                    text = { Text("Move to…") },
                                    onClick = {
                                        menu = false
                                        onMoveFolderTo()
                                    },
                                    modifier = Modifier.testTag("folderMoveTo"),
                                )
                                if (sortMode == "manual") {
                                    DropdownMenuItem(
                                        text = { Text("Reorder") },
                                        onClick = {
                                            menu = false
                                            onReorder(true)
                                        },
                                        modifier = Modifier.testTag("folderReorder"),
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text("Delete Folder…") },
                                    onClick = {
                                        menu = false
                                        onDeleteFolder()
                                    },
                                    modifier = Modifier.testTag("folderDelete"),
                                )
                            }
                        }
                    }
                },
            )
        },
        floatingActionButton = {
            if (onNewNote != null && !reordering) {
                FloatingActionButton(onClick = onNewNote) { Icon(Icons.Default.Add, contentDescription = "New Note in This Folder") }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (reordering) {
                ReorderList(
                    folders = folders,
                    notes = notes,
                    onCommitFolder = { id, before, after -> onMoveFolder(id, before, after) },
                    onCommitNote = { id, before, after -> onMoveNote(id, before, after) },
                    modifier = Modifier.fillMaxSize(),
                )
            } else if (folders.isEmpty() && notes.isEmpty()) {
                EmptyMessage("This folder is empty.")
            } else {
                NoteList(
                    notes = notes,
                    onOpen = onOpen,
                    folders = folders,
                    onFolder = onFolder,
                    // The last row scrolls clear of the New note button.
                    contentPadding = PaddingValues(bottom = FAB_CLEARANCE),
                    onLongPress = onNoteLongPress,
                    onFolderLongPress = onFolderLongPress,
                    selectable = true,
                )
            }
        }
    }
}

/** Every note, newest first: the 5,000-row list the 60 fps criterion is about (A285). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AllNotesScreen(
    notes: List<NoteItem>,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    onNoteLongPress: ((NoteItem) -> Unit)? = null,
) {
    if (onNoteLongPress != null) KeepSelectionShown(notes)
    Scaffold(topBar = { TopAppBar(title = { Text("All Notes") }, modifier = Modifier.underSelectionBar(), navigationIcon = { BackButton(onBack) }) }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (notes.isEmpty()) EmptyMessage("No notes yet.") else NoteList(notes = notes, onOpen = onOpen, onLongPress = onNoteLongPress, selectable = true)
        }
    }
}

/** A full-screen wait or message, with an action when there is something to do ([action]: its label and what it does). */
@Composable
fun CenteredMessage(text: String?, busy: Boolean = false, action: Pair<String, () -> Unit>? = null) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        if (busy) CircularProgressIndicator()
        if (text != null) {
            Text(
                text,
                Modifier.padding(top = 16.dp),
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
            )
        }
        if (action != null) {
            FilledTonalButton(onClick = action.second, Modifier.padding(top = 24.dp).testTag("messageAction")) { Text(action.first) }
        }
    }
}

/** A pass shorter than this shows no progress bar on Home (T39). */
internal const val SLOW_SYNC_MS = 1_000L

/** Room under a list for a floating button (56 dp, its 16 dp margin, and some air). */
internal val FAB_CLEARANCE = 88.dp

/**
 * Home's shortcuts as one row of icons (T51, A932), the sidebar's: Search, Tags (A1438), Today,
 * This Week, then the phone's own Journal and All Notes (A1613), Graph, Commands and the phone's
 * Capture, each with its name as a tooltip and content description. They are the drawer's
 * places no longer (A1613): this row is where they are. Settings → Home hides any but Search;
 * hidden, they still run from their keys and Search's actions (A576). More than fit scroll sideways.
 */
@Composable
internal fun HomeShortcutRow(
    shortcuts: HomeShortcuts,
    onSearch: () -> Unit,
    onToday: () -> Unit,
    onThisWeek: () -> Unit,
    onGraph: () -> Unit,
    onCommands: () -> Unit,
    onTags: () -> Unit = {},
    onJournal: () -> Unit = {},
    onAllNotes: () -> Unit = {},
    onCapture: () -> Unit = {},
) {
    val lucide = rememberLucideIcons()
    @Composable
    fun Lucide(name: String, label: String, tag: String, onClick: () -> Unit) {
        val glyph = lucide?.icon(name) ?: return
        TipIconButton(LucideAssets.vector(glyph), label, onClick = onClick, modifier = Modifier.testTag(tag))
    }
    // Six 48dp targets fit a 320dp phone with no gap between them (each icon is 24dp in its 48);
    // with more shown, the row scrolls sideways rather than squeeze them.
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp).testTag("homeShortcuts")) {
        TipIconButton(SettingsIcons.Search, "Search", onClick = onSearch, modifier = Modifier.testTag("homeSearch"))
        if (shortcuts.tags) TipIconButton(SettingsIcons.Tag, "Tags", onClick = onTags, modifier = Modifier.testTag("homeTagsShortcut"))
        if (shortcuts.today) TipIconButton(SettingsIcons.Today, "Today", onClick = onToday, modifier = Modifier.testTag("homeToday"))
        if (shortcuts.thisWeek) TipIconButton(SettingsIcons.Week, "This Week", onClick = onThisWeek, modifier = Modifier.testTag("homeThisWeek"))
        if (shortcuts.journal) Lucide("book-open", "Journal", "homeJournal", onJournal)
        if (shortcuts.allNotes) Lucide("files", "All Notes", "homeAllNotes", onAllNotes)
        if (shortcuts.graph) TipIconButton(SettingsIcons.Graph, "Graph", onClick = onGraph, modifier = Modifier.testTag("homeGraph"))
        if (shortcuts.commands) TipIconButton(SettingsIcons.Command, "Commands", onClick = onCommands, modifier = Modifier.testTag("homeCommands"))
        if (shortcuts.capture) Lucide("zap", "Capture", "homeCapture", onCapture)
    }
}
