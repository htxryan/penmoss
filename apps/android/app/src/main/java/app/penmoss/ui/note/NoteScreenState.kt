package app.penmoss.ui.note

import kotlinx.coroutines.CoroutineScope
import android.content.Context
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.NotebookGraph
import app.penmoss.data.BacklinkSource
import app.penmoss.data.FolderEntity
import app.penmoss.data.NoteEntity
import app.penmoss.editor.BlockChoices
import app.penmoss.editor.EditorPageServices
import app.penmoss.editor.EditorUiState
import app.penmoss.editor.EditorWebView
import app.penmoss.editor.FormatState
import app.penmoss.editor.LinkedNotes
import app.penmoss.editor.NewNoteRequest
import app.penmoss.editor.NoteClipboard
import app.penmoss.editor.NoteCounts
import app.penmoss.editor.NoteEditorController
import app.penmoss.editor.PeriodicNoteRequest
import app.penmoss.editor.PickedPictures
import app.penmoss.editor.SelectionHooks
import app.penmoss.engine.bridge.BlockPurpose
import app.penmoss.engine.bridge.CopyFormat
import app.penmoss.engine.bridge.CopyScope
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.settings.LineSymbol
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.engine.settings.QuickAccess
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.sync.SyncStatus
import app.penmoss.ui.keys.saveVersionNow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.Items
import app.penmoss.ui.common.readableTheme
import app.penmoss.ui.history.historyFailure
import app.penmoss.ui.folders.moveNoteAndSay
import app.penmoss.ui.trash.trashAfterClosing

/** Pictures one trip to the photo picker may bring. */
private const val MAX_PICKED = 10

/** Where the move picker starts: the folder the note is in or going to (null: the top level). */
internal data class MovePick(val current: String?)

/**
 * An open note's state (A6): the editor's controller and the page's services wired to the
 * notebook, where the note stands with sync, the move and tag flows, the note panel (its Info tab
 * among them), and what is open over the note. [rememberNoteScreenState] makes it and runs the
 * wiring; [NoteRoute] draws it.
 */
@Stable
internal class NoteScreenState(
    val graph: NotebookGraph,
    val noteId: String,
    private val context: Context,
    /**
     * The note screen's own scope (A6): what it starts only to show (a folder looked up for the
     * move picker, a copy) ends with it. A write the person asked for (a move, a version, the
     * last edits) goes on the notebook's process scope and finishes if they leave meanwhile.
     */
    private val screenScope: CoroutineScope,
    val channel: EditorWebView.Channel,
    val controller: NoteEditorController,
    val services: EditorPageServices,
    val linked: LinkedNotes,
    /** The notes linking here, offline from Room and then the index (LK5): the Info tab's list. */
    val backlinks: BacklinksModel,
    /** The note's WebView, once made. */
    val holder: Array<View?>,
    val snackbar: SnackbarHostState,
    /** A new note this screen makes (T38), or a periodic one ([periodic], T40 P5). */
    val create: NewNoteRequest?,
    val periodic: PeriodicNoteRequest?,
    /** Opens the photo picker, and the document picker (T40 P8, ED12). */
    val pickPictures: () -> Unit,
    val pickFiles: () -> Unit,
    /** The selection menu's hooks (T40 P8): copy as, paste plain, comment and find. */
    val hooks: SelectionHooks,
    private val editorState: State<EditorUiState>,
    private val formatState: State<FormatState>,
    private val tagsState: State<List<String>?>,
    private val infoState: State<FromEditor.NoteInfo?>,
    private val periodicNavState: State<FromEditor.PeriodicNavData?>,
    private val sourceState: State<Boolean>,
    private val countsState: State<NoteCounts?>,
    private val choicesState: State<BlockChoices?>,
    private val syncStatus: State<SyncStatus>,
    private val unsent: State<Int>,
    private val picturesWaiting: State<Int>,
    private val picturesFailedState: State<Int?>,
    private val folders: State<List<FolderEntity>>,
    private val placedState: State<NoteEntity?>,
    private val linkingHereState: State<List<BacklinkSource>>,
    private val quickAccess: State<List<String>>,
    private val symbolsState: State<List<LineSymbol>>,
    private val previewOpenState: State<Boolean>,
    ownCopy: MutableState<PageNote?>,
    explaining: MutableState<Boolean>,
    linking: MutableState<Boolean>,
    panelName: MutableState<String?>,
    tagging: MutableState<Boolean>,
    finding: MutableState<Boolean>,
    counting: MutableState<Boolean>,
) {
    val editor: EditorUiState get() = editorState.value
    val format: FormatState get() = formatState.value
    val tags: List<String>? get() = tagsState.value
    val info: FromEditor.NoteInfo? get() = infoState.value

    /** The open note's period and neighbours, for the row under its top bar (T40 P5, JR4). */
    val periodicNav: FromEditor.PeriodicNavData? get() = periodicNavState.value

    /** The editor's parity with the web (T40 P8): copies, the source, find, the + sheet, counts. */
    val tools get() = controller.tools
    val source: Boolean get() = sourceState.value
    val counts: NoteCounts? get() = countsState.value
    val choices: BlockChoices? get() = choicesState.value

    /** Comment threads (T48): the Comments tab, from the ⋮ menu, a tapped highlight or Comment. */
    val comments get() = controller.comments

    /** This note's pictures given up on (AC8, A428); null until Room has answered. */
    val picturesFailed: Int? get() = picturesFailedState.value

    /** Where this note stands with the server (PL10, A429), from the phone's own state. */
    val noteSync: NoteSync get() = noteSyncState(syncStatus.value, unsent.value, picturesWaiting.value, picturesFailed ?: 0)

    /** The note as Room has it: its folder and when it changed. */
    val placed: NoteEntity? get() = placedState.value

    /** The note's folder path (T40 P4, NT11): from the folders in Room, root first. */
    val crumbs: List<FolderItem> by derivedStateOf { Items.folderPath(folders.value, placedState.value?.folderId) }

    /** The notes linking here, offline from Room (LK5): the Info button's badge. */
    val linkingHere: List<BacklinkSource> get() = linkingHereState.value

    /** Whether the note is pinned to Quick Access (T51, A946). */
    val pinned: Boolean get() = noteId in quickAccess.value

    /** The person's line symbols (T44, A747): the note's margin and the bar's symbol sheet. */
    val symbols: List<LineSymbol> get() = symbolsState.value

    /** The theme editor's preview is alive (A418): the note's WebView waits for it to go. */
    val previewOpen: Boolean get() = previewOpenState.value

    /** A periodic screen is transient: the page makes the note, then the note itself opens. */
    val makingPeriodic: Boolean get() = periodic != null

    val ready: Boolean get() = editor.phase == EditorUiState.Phase.READY
    val editable: Boolean get() = ready && !editor.readOnly

    /** A copy of this note's own edits (NT21, A434): said on the note until dismissed or left. */
    var ownCopy by ownCopy
    var explaining by explaining
    var linking by linking
    var menu by mutableStateOf(false)

    /**
     * The note panel's tab, or null while it is closed (T51, A936): Metadata, Comments, Version
     * History and Local Graph, over the note, so the editor stays open for flush and exchange.
     */
    var panelName by panelName
    val panel: PanelTab? get() = panelName?.let { name -> PanelTab.entries.firstOrNull { it.name == name } }

    /** The move picker, open on the folder the note is in (or going to). */
    var moving by mutableStateOf<MovePick?>(null)
    var tagging by tagging
    var finding by finding
    var counting by counting
    var sheet by mutableStateOf<BlockPurpose?>(null)

    /** The page's renderer died (A312): that WebView can't be used again, so it leaves the screen. */
    var rendererGone by mutableStateOf(false)

    /**
     * The page's image lightbox is open (T51, A948): the note's bars step aside so it has the
     * screen, and the back gesture closes it, not the note.
     */
    var lightbox by mutableStateOf(false)

    fun openPanel(tab: PanelTab) {
        panelName = tab.name
        PanelMemory.remember(context, tab)
    }

    // Each command opens its tab, or closes the panel when its tab shows, as on the web.
    fun togglePanel(tab: PanelTab) {
        if (panel == tab) panelName = null else openPanel(tab)
    }

    fun closePanel() {
        panelName = null
    }

    /** The note takes the focus back, once a sheet or a picker closes. */
    fun focusPage() {
        holder[0]?.requestFocus()
    }

    fun webView(): WebView? = holder[0] as? WebView

    fun retryPictures() {
        // Outlives the screen: the pictures' upload the person asked for again.
        graph.launchReporting(Dispatchers.Main.immediate) {
            graph.attachments.retryFailed()
            graph.sync.requestSync()
        }
    }

    /** Copy Agent Reference (T52 item 4; PEN-69): the MCP call that reads the note by its short id; none until the note is in Room. */
    val copyAgentReference: (() -> Unit)? get() = if (placed == null) null else ::copyReference

    private fun copyReference() {
        screenScope.launch {
            val reference = agentReferenceIn(graph, noteId)
            controller.notify(reference?.let { AgentReference.copy(context, it) } ?: "This note isn't on this phone any more")
        }
    }

    /** Opens the move picker on the folder the note is in. */
    fun startMove() {
        screenScope.launch { moving = MovePick(graph.store.folderOf(noteId)) }
    }

    /** Moves the note to [folder] (null: the top level), and says so. */
    fun moveTo(folder: String?) {
        // Outlives the screen: a move the person asked for.
        graph.launchReporting(Dispatchers.Main.immediate) { controller.notify(moveNoteAndSay(graph, noteId, folder).text) }
    }

    /**
     * The note is closed first: the page's last edits are stored (waited for, as leaving does), so
     * they go before the Trash request (A432). On the app's scope: Back meanwhile leaves the screen
     * but keeps the move.
     */
    fun trash(onTrash: () -> Unit) = graph.scope.trashAfterClosing(controller::close, onTrash)

    fun saveVersion() {
        // Outlives the screen: the version the person asked for, after the last edits are stored.
        graph.launchReporting(Dispatchers.Main.immediate) {
            controller.notify(
                saveVersionNow(
                    flush = controller::flushAndWait,
                    exchange = { graph.sync.syncNote(noteId) },
                    save = { graph.api.saveVersion(noteId) },
                    failure = { historyFailure(it) },
                ),
            )
        }
    }

    /**
     * Quick Access (T51, A946): the device's pins, synced; in a git notebook only when the pins live
     * in the Journal notebook (no account, A1014), as on the Mac where a pin is any note's id.
     */
    fun pin() {
        val now = graph.device.settings.value
        val next = QuickAccess.toggled(now.settings.quickAccess, noteId)
        when {
            !now.known -> controller.notify("Quick Access can be changed once the phone has synced with Penmoss.")
            next == null -> controller.notify("Quick Access holds up to ${QuickAccess.MAX} notes. Unpin one to pin this one.")
            else -> {
                graph.device.changeSetting(SettingKeys.QUICK_ACCESS, QuickAccess.toJson(next))
                controller.notify(if (noteId in next) "Pinned to Quick Access." else "Unpinned from Quick Access.")
            }
        }
    }
}

/**
 * Makes an open note's state and runs its wiring (A6): the editor's controller with the page's
 * services and linked notes, stored before the WebView goes; the page's theme, width, fonts,
 * symbols and keyboard; the note's notices, copies and pictures; where it stands with sync; its
 * backlinks; and the caret for a new note or a rename.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun rememberNoteScreenState(
    graph: NotebookGraph,
    noteId: String,
    onOpenNote: (String) -> Unit,
    onOpenTag: (String) -> Unit,
    create: NewNoteRequest?,
    onMade: () -> Unit,
    focusTitle: Boolean,
    periodic: PeriodicNoteRequest?,
    onPeriodicMade: (String) -> Unit,
    heading: String?,
    onOpenNoteAt: (String, String?) -> Unit,
): NoteScreenState {
    val channel = remember(noteId) { EditorWebView.Channel() }
    // The controller, the page's services and its files work on the notebook's process scope: the
    // note's last edits, its conflict copies and the files picked are stored even as the screen goes.
    val controller = remember(noteId) {
        NoteEditorController(
            noteId,
            graph.store,
            graph.sync,
            graph.scope,
            channel::send,
            onOpenNote,
            onOpenTag = onOpenTag,
            pictures = graph.attachments,
            openEditors = graph.openEditors,
            create = create,
            onCreated = {
                onMade()
                graph.sync.requestSync()
            },
            periodic = periodic,
            onPeriodicMade = onPeriodicMade,
            onPageError = { graph.errors.report(it) },
            folds = graph.folds,
            files = graph.attachments,
            webPictures = graph.webPictures::mode,
            onOpenAt = onOpenNoteAt,
            heading = heading,
            // Send to… (T60, A1078): the notebook syncs at once, no push delay.
            onCommentSent = graph::syncNotebookNow,
        )
    }
    /** Other notes for the page's `[[Title#` headings and live embeds (T40 P7, LK2, LK4). */
    val linked = remember(noteId) { LinkedNotes(graph.store, graph.sync, graph.scope, channel::send) }
    val copies = remember(noteId) { MutableSharedFlow<Pair<PageNote, Boolean>>(extraBufferCapacity = 4) }
    val ownCopy = remember(noteId) { mutableStateOf<PageNote?>(null) }
    val services = remember(noteId) {
        EditorPageServices(
            graph.store,
            graph.scope,
            channel::send,
            onCopied = { source, copy, merged ->
                graph.sync.noteEdited(copy.id)
                if (source == noteId) ownCopy.value = copy else copies.tryEmit(copy to merged)
            },
            openEditors = graph.openEditors,
        )
    }
    val holder = remember(noteId) { arrayOfNulls<View>(1) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(noteId, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) controller.flush()
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            services.stop()
            linked.stop()
            // The page's last edits are stored before the WebView goes (NoteEditorController.close):
            // outlives the screen, which is going.
            graph.launchReporting(Dispatchers.Main.immediate) {
                controller.close()
                (holder[0] as? WebView)?.let(EditorWebView::destroy)
            }
        }
    }

    // The theme chosen in Settings → Appearance, on the page too (A305).
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    // Never beside the theme editor's preview (A418): the note's WebView waits for it to go.
    val previewOpen = EditorWebView.previewOpen.collectAsStateWithLifecycle()
    val dark = appearance.isDark(isSystemInDarkTheme())
    LaunchedEffect(services, appearance.theme, dark) {
        // With the text colours the screens read in (A498), so the note reads as they do.
        appearance.theme?.let { services.setTheme(ToEditor.Theme(readableTheme(it), if (dark) "dark" else "light")) }
    }
    // Full-width notes (A501), which a tablet or an unfolded phone shows (A413).
    val fullWidth by remember { graph.device.settings.map { it.settings.fullWidth }.distinctUntilChanged() }.collectAsStateWithLifecycle(false)
    LaunchedEffect(services, fullWidth) { services.setWidth(ToEditor.Width(fullWidth)) }
    // The description under the title (PEN-161), when Settings → Note says so.
    val underTitle by remember {
        graph.device.settings.map { app.penmoss.ui.settings.descriptionUnderTitle(it.settings.values) }.distinctUntilChanged()
    }.collectAsStateWithLifecycle(false)
    LaunchedEffect(services, underTitle) { services.setUnderTitle(ToEditor.UnderTitle(underTitle)) }
    // The person's fonts (T51, A944): the note's font and size over the theme's, and the page's own interface font.
    val fonts by remember {
        graph.device.settings.map { ToEditor.Fonts(it.settings.interfaceFont, it.settings.noteFont, it.settings.noteFontSize) }.distinctUntilChanged()
    }.collectAsStateWithLifecycle(DEFAULT_FONTS)
    LaunchedEffect(services, fonts) { services.setFonts(fonts) }
    // The person's line symbols (T44, A747): the note's margin and the bar's symbol sheet.
    val symbols = remember { graph.device.settings.map { it.settings.symbols }.distinctUntilChanged() }
        .collectAsStateWithLifecycle(LineSymbols.DEFAULTS)
    LaunchedEffect(services, symbols.value) { services.setSymbols(ToEditor.Symbols(symbols.value)) }
    // Whether the person is typing (A469, review S8, R3): the soft keyboard is up, or a hardware
    // keyboard is connected (the soft one then stays down while typing). A tag tapped otherwise opens.
    val imeVisible = WindowInsets.isImeVisible
    val configuration = LocalConfiguration.current
    val typing = imeVisible || hasHardwareKeyboard(configuration)
    LaunchedEffect(services, typing) { services.setIme(ToEditor.Ime(typing)) }

    val editor = controller.state.collectAsStateWithLifecycle()
    val format = controller.format.collectAsStateWithLifecycle()

    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_PICKED)) { uris ->
        if (uris.isEmpty()) {
            controller.refocus()
            return@rememberLauncherForActivityResult
        }
        // Outlives the screen: the pictures the person picked are stored even if they leave meanwhile.
        graph.launchReporting(Dispatchers.Main.immediate) {
            val pictures = withContext(Dispatchers.IO) { uris.map { PickedPictures.read(context.contentResolver, it) } }
            if (pictures.any { it == null }) controller.notify("A picture could not be read, or is over 50 MB.")
            holder[0]?.requestFocus()
            controller.insertPictures(pictures.filterNotNull())
        }
    }

    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(controller) { controller.notices.collect { snackbar.showSnackbar(it) } }
    // Files through the app (T40 P8, ED12): the document picker, and a chip's Open and Save a copy.
    val pickFiles = rememberNoteFiles(controller.files, graph.scope, snackbar, onRefocus = { holder[0]?.requestFocus() })
    LaunchedEffect(services) {
        copies.collect { (copy, merged) ->
            val shown = snackbar.showSnackbar(
                if (merged) "More edits this phone could not sync were added to “${copy.title}”."
                else "Edits this phone could not sync are kept in “${copy.title}”.",
                actionLabel = "Open",
                duration = SnackbarDuration.Long,
            )
            if (shown == SnackbarResult.ActionPerformed) onOpenNote(copy.id)
        }
    }

    // This note's pictures given up on (AC8, A428): said each time one more fails, with Retry.
    val picturesFailed = remember(noteId) { graph.attachments.observeFailed(noteId) }.collectAsStateWithLifecycle(null as Int?)
    val syncStatus = graph.sync.status.collectAsStateWithLifecycle()
    val unsent = remember(noteId) { graph.store.observeUnsentCount(noteId) }.collectAsStateWithLifecycle(0)
    val picturesWaiting = remember(noteId) { graph.attachments.observeWaiting(noteId) }.collectAsStateWithLifecycle(0)
    val explaining = rememberSaveable(noteId) { mutableStateOf(false) }

    val folders = remember { graph.store.observeFolders() }.collectAsStateWithLifecycle(emptyList())
    val placed = remember(noteId) { graph.store.observeNote(noteId) }.collectAsStateWithLifecycle(null)

    val periodicNav = controller.periodicNav.collectAsStateWithLifecycle()
    val linking = rememberSaveable(noteId) { mutableStateOf(false) }
    val panelName = rememberSaveable(noteId) { mutableStateOf<String?>(null) }
    val tagging = rememberSaveable(noteId) { mutableStateOf(false) }
    val tags = controller.tags.collectAsStateWithLifecycle()
    val info = controller.info.collectAsStateWithLifecycle()
    // The notes linking here, offline from Room (LK5): the Info button's badge and the sheet's list.
    val linkingHere = remember(noteId) { graph.store.observeBacklinkSources(noteId) }.collectAsStateWithLifecycle(emptyList())
    // The screen's own scope: the backlinks are read only to show them.
    val screenScope = rememberCoroutineScope()
    val backlinks = remember(noteId) {
        BacklinksModel(noteId, graph.store, graph.api, screenScope)
    }
    // Notes edited here the index may not have: Room alone says whether they link here (S3).
    val recentLinkers by remember { graph.store.observeRecentLinkers() }.collectAsStateWithLifecycle(emptySet())
    LaunchedEffect(backlinks, linkingHere.value, recentLinkers) { backlinks.localChanged(linkingHere.value, recentLinkers) }
    // A new note opens with the caret in its title (A356) and, since the page cannot raise the
    // keyboard by itself, the app raises it once the note is made (T39).
    val isNew = remember(noteId) { create != null }
    var keyboardRaised by rememberSaveable(noteId) { mutableStateOf(false) }
    val state = editor.value
    LaunchedEffect(state.phase) {
        if (!isNew || keyboardRaised || state.phase != EditorUiState.Phase.READY || state.readOnly) return@LaunchedEffect
        val view = holder[0] ?: return@LaunchedEffect
        keyboardRaised = true
        view.requestFocus()
        view.context.getSystemService(InputMethodManager::class.java)?.showSoftInput(view, 0)
    }
    // Rename from a list (T40 P4, NT10): the caret goes in the title once the note is open.
    var titleFocused by rememberSaveable(noteId) { mutableStateOf(false) }
    LaunchedEffect(state.phase, focusTitle) {
        if (!focusTitle || titleFocused || state.phase != EditorUiState.Phase.READY || state.readOnly) return@LaunchedEffect
        titleFocused = true
        controller.focusTitle()
    }
    val tools = controller.tools
    val source = tools.source.collectAsStateWithLifecycle()
    val counts = tools.counts.collectAsStateWithLifecycle()
    val choices = tools.choices.collectAsStateWithLifecycle()
    val finding = rememberSaveable(noteId) { mutableStateOf(false) }
    val counting = rememberSaveable(noteId) { mutableStateOf(false) }
    val quickAccess = remember { graph.device.settings.map { it.settings.quickAccess }.distinctUntilChanged() }
        .collectAsStateWithLifecycle(emptyList())
    // The snackbar runs on its own: a second copy is written at once, not after the first's
    // snackbar goes (review S2).
    LaunchedEffect(tools) { tools.clips.collect { clip -> NoteClipboard.write(context, clip)?.let { launch { snackbar.showSnackbar(it) } } } }
    // Delete block took a whole list or table with one tap: offer Undo (review S4).
    LaunchedEffect(tools) {
        tools.deleted.collect { label ->
            launch {
                val shown = snackbar.showSnackbar("$label deleted", actionLabel = "Undo", duration = SnackbarDuration.Long)
                if (shown == SnackbarResult.ActionPerformed) tools.undoDelete()
            }
        }
    }
    val editable = state.phase == EditorUiState.Phase.READY && !state.readOnly
    val canPaste by rememberUpdatedState(editable && !source.value)
    val hooks = remember(noteId) {
        object : SelectionHooks {
            override fun copyAs(format: CopyFormat) = tools.copy(format, CopyScope.SELECTION)
            // Read off the main thread: a clip can be large (review S3).
            override fun pastePlain() {
                screenScope.launch { tools.pastePlain(withContext(Dispatchers.IO) { NoteClipboard.text(context) }) }
            }

            override fun menuShown() = tools.capture()
            override fun comment() = controller.comments.startDraft(app.penmoss.engine.bridge.DraftSource.SELECTION)
            override val canComment: Boolean get() = canPaste
            override fun find() {
                finding.value = true
            }
            override val editable: Boolean get() = canPaste
        }
    }

    val note = remember(noteId) {
        NoteScreenState(
            graph = graph,
            noteId = noteId,
            context = context,
            screenScope = screenScope,
            channel = channel,
            controller = controller,
            services = services,
            linked = linked,
            backlinks = backlinks,
            holder = holder,
            snackbar = snackbar,
            create = create,
            periodic = periodic,
            pickPictures = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            pickFiles = pickFiles,
            hooks = hooks,
            editorState = editor,
            formatState = format,
            tagsState = tags,
            infoState = info,
            periodicNavState = periodicNav,
            sourceState = source,
            countsState = counts,
            choicesState = choices,
            syncStatus = syncStatus,
            unsent = unsent,
            picturesWaiting = picturesWaiting,
            picturesFailedState = picturesFailed,
            folders = folders,
            placedState = placed,
            linkingHereState = linkingHere,
            quickAccess = quickAccess,
            symbolsState = symbols,
            previewOpenState = previewOpen,
            ownCopy = ownCopy,
            explaining = explaining,
            linking = linking,
            panelName = panelName,
            tagging = tagging,
            finding = finding,
            counting = counting,
        )
    }
    PicturesFailedNotice(picturesFailed.value, snackbar, onRetry = note::retryPictures)
    // Comment threads (T48): the Comments tab, from the ⋮ menu, a tapped highlight or Comment.
    LaunchedEffect(note.comments) { note.comments.requests.collect { note.openPanel(PanelTab.COMMENTS) } }
    return note
}

/** The fonts until the settings are read: the theme's own, at the default size (A944). */
private val DEFAULT_FONTS = ToEditor.Fonts(
    app.penmoss.engine.settings.FontSettings.THEME,
    app.penmoss.engine.settings.FontSettings.THEME,
    app.penmoss.engine.settings.FontSettings.PHONE_SIZE_DEFAULT,
)
