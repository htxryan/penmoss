package app.penmoss.ui.home

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import app.penmoss.capture.Captures
import app.penmoss.capture.RefusedCapturesScreen
import app.penmoss.data.CapturesWaiting
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.settings.QuickAccess
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.ui.Choosing
import app.penmoss.ui.FolderNaming
import app.penmoss.ui.HomeLayout
import app.penmoss.ui.HomeShortcuts
import app.penmoss.ui.RootUi
import app.penmoss.ui.SettingsRoutes
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.Items
import app.penmoss.ui.common.NoteItem
import app.penmoss.ui.graphRoute
import app.penmoss.ui.keys.openCapture
import app.penmoss.ui.leave
import app.penmoss.ui.open
import app.penmoss.ui.trash.TrashRoutes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import java.text.DateFormat
import java.util.Date

/** How many recently changed notes Home reads: Recent Notes' longest (Settings → Display sets how many show, T53). */
private const val RECENT = app.penmoss.engine.settings.SidebarLayout.RECENT_MAX

/**
 * The notebook's sync line (T39, A651), as Home's dot and Settings show it: [text] says a stop
 * when sync has stopped, else the last pass ([pass]); [alert] the phone is offline.
 */
@Immutable
internal data class SyncLine(
    val text: String = "",
    val pass: String = "",
    val alert: Boolean = false,
    val syncing: Boolean = false,
    val stopped: Boolean = false,
)

/** Home (T32; T51, T53), All Notes, and the captures Penmoss refused (A345). */
internal fun NavGraphBuilder.homeRoutes(root: RootUi, sync: SyncLine) {
    val graph = root.graph
    val nav = root.nav
    composable("home") {
        val home by remember {
            // Recent: opened here or edited anywhere, whichever is later (T40 P6, FD7).
            combine(graph.store.observeRecent(RECENT), graph.store.observeFolders(), graph.store.observeRootSortMode()) { notes, folders, mode ->
                val now = System.currentTimeMillis()
                HomeView(Items.notes(notes, now), Items.home(mode, folders, now))
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
        val layout = HomeLayout.of(settingsNow.settings)
        /** A change to the sidebar's layout, once the phone knows the settings (A411). */
        val changeLayout = { key: String, value: kotlinx.serialization.json.JsonElement ->
            if (graph.device.settings.value.known) graph.device.changeSetting(key, value)
        }
        HomeScreen(
            HomeUi(
                title = graph.name,
                quickAccess = quickAccess,
                // The sidebar's sections and Quick Access (T53 items 8 and 10), synced settings.
                layout = layout,
                // Every pin is this notebook's note, named as its heading is (T53 item 10).
                quickAccessNotebooks = quickAccess.associate { it.id to app.penmoss.ui.home.HOME_NOTEBOOK_NAME },
                recent = home.recent,
                folders = home.folders,
                status = sync.text,
                statusAlert = sync.alert,
                syncing = sync.syncing,
                keptApart = keptApart,
                capturesWaiting = capturesWaiting.count,
                capturesRefused = capturesRefused,
                capturesWaitingWhy = capturesWhy(capturesWaiting, System.currentTimeMillis()),
                sortMode = rootSort,
                reordering = root.homeReordering,
                shortcuts = HomeShortcuts.of(settingsNow.settings),
                stopped = sync.stopped,
            ),
            HomeActions(
                onSectionHidden = { section, hide ->
                    val hidden = graph.device.settings.value.settings.hiddenSections
                    changeLayout(SettingKeys.HIDDEN_SECTIONS, app.penmoss.engine.settings.SidebarLayout.toJson(app.penmoss.engine.settings.SidebarLayout.withHidden(hidden, section, hide)))
                },
                onSectionMove = { section, index ->
                    val order = graph.device.settings.value.settings.sectionOrder
                    changeLayout(SettingKeys.SECTION_ORDER, app.penmoss.engine.settings.SidebarLayout.toJson(app.penmoss.engine.settings.SidebarLayout.moved(order, section, index)))
                },
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
                onNotebookNewNote = { root.newNote(null) },
                onSearch = { nav.open("search") },
                onSettings = { nav.open("settings") },
                onAllNotes = { nav.open("notes") },
                onFolder = { nav.open("folder/$it") },
                onOpen = root::openNote,
                onToday = { root.openPeriodic(ToEditor.PeriodKind.DAILY, null) },
                onThisWeek = { root.openPeriodic(ToEditor.PeriodKind.WEEKLY, null) },
                onJournal = { nav.open("journal") },
                onGraph = { nav.open(graphRoute(null)) },
                // From Home, the top level unless another folder is picked (T38).
                onNewNote = { root.choosing = Choosing.NewNote(null) },
                onRefusedCaptures = { nav.open("captures") },
                onNoteLongPress = root::startSelection,
                onRefresh = { graph.sync.syncNow() },
                onTrash = { nav.open(TrashRoutes.TRASH) },
                onTags = { nav.open("tags") },
                // Folders at the top level (T40 P4, NT2–NT7).
                onNewFolder = { root.folderNaming = FolderNaming.Create(null) },
                onSort = { root.sortFolder(null, it) },
                onReorder = { root.homeReordering = it },
                onMoveFolder = root::reorderFolder,
                onFolderLongPress = { root.folderActing = it },
                onCapture = { openCapture(root.context) },
                onCommands = { nav.open("search?actions=true") },
                onStatus = { nav.open(SettingsRoutes.SYNC) },
                onFeedback = { root.openFeedback("Home's ⋮ menu", null, null, null, 0) },
            ),
        )
    }
    composable("notes") { entry ->
        val notes by remember {
            graph.store.observeList().map { Items.notes(it, System.currentTimeMillis()) }.distinctUntilChanged().flowOn(Dispatchers.Default)
        }.collectAsStateWithLifecycle(emptyList())
        AllNotesScreen(notes, onBack = { nav.leave(entry) }, onOpen = root::openNote, onNoteLongPress = root::startSelection)
    }
    composable("captures") { entry ->
        val refused by remember { graph.captures.observeRefusedList() }.collectAsStateWithLifecycle(emptyList())
        val format = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
        RefusedCapturesScreen(
            captures = refused,
            dateOf = { format.format(Date(it)) },
            onBack = { nav.leave(entry) },
            onCopy = { copyCaptures(root.context, listOf(it)) },
            // Each outlives the screen: a capture sent again, or discarded, as the person asked.
            onRetry = { graph.launchReporting(Dispatchers.Main.immediate) { graph.captures.retry(it.id) } },
            onWithoutPictures = { graph.launchReporting(Dispatchers.Main.immediate) { graph.captures.sendWithoutMissingPictures(it.id) } },
            onDiscard = { graph.launchReporting(Dispatchers.Main.immediate) { graph.captures.discard(it.id) } },
        )
    }
}

/** Home's lists: Recent and the top-level folders. */
private data class HomeView(
    val recent: List<NoteItem> = emptyList(),
    val folders: List<FolderItem> = emptyList(),
)

/** Puts captures' text on the clipboard, one after another (A345). */
private fun copyCaptures(context: Context, captures: List<Captures.Refused>) {
    val text = captures.joinToString("\n\n---\n\n") { it.text }
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Penmoss captures", text))
    Toast.makeText(context, if (captures.size == 1) "Copied." else "Copied ${captures.size} captures.", Toast.LENGTH_SHORT).show()
}

/** Why captures still wait, when worth saying (A345): their age. */
internal fun capturesWhy(waiting: CapturesWaiting, now: Long): String? {
    if (waiting.count == 0) return null
    val oldest = waiting.oldest ?: return null
    if (now - oldest < 24 * 60 * 60_000L) return null
    return "The oldest is from ${DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(oldest))}."
}
