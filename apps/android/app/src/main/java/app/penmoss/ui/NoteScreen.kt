package app.penmoss.ui

import app.penmoss.engine.notes.Tags
import kotlinx.coroutines.flow.combine
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import app.penmoss.ui.keys.NoteActions
import app.penmoss.ui.keys.NoteCommands
import app.penmoss.ui.keys.saveVersionNow
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import app.penmoss.ui.square.TextButton
import app.penmoss.ui.settings.SettingsIcons
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.DisposableEffect
import app.penmoss.engine.settings.QuickAccess
import app.penmoss.engine.settings.SettingKeys
import kotlinx.coroutines.flow.flowOn
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.material.icons.filled.Check
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.editor.EditorPageServices
import app.penmoss.editor.EditorUiState
import app.penmoss.editor.EditorWebView
import app.penmoss.editor.FormatState
import app.penmoss.editor.LinkedNotes
import app.penmoss.editor.NewNoteRequest
import app.penmoss.editor.NoteEditorController
import app.penmoss.editor.NotePages
import app.penmoss.editor.PeriodicNoteRequest
import app.penmoss.editor.NoteClipboard
import app.penmoss.editor.PickedPictures
import app.penmoss.editor.SelectionHooks
import app.penmoss.editor.SelectionWebView
import app.penmoss.engine.bridge.BlockPurpose
import app.penmoss.engine.bridge.CopyFormat
import app.penmoss.engine.bridge.CopyScope
import app.penmoss.engine.bridge.FormatCommand
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.ui.screens.CenteredMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Pictures one trip to the photo picker may bring. */
private const val MAX_PICKED = 10

/**
 * An open note (T32; the writing screen, T33): the native top bar, the editor
 * WebView, and the formatting bar, which moves up with the keyboard while the
 * WebView shrinks above it, so the caret stays in view (A301, A307). Back first
 * closes a menu the editor has open (A302); otherwise it leaves the note, and
 * its last edits are stored before the WebView goes.
 *
 * The top bar's menu (T38) moves the note to another folder and shows its tags;
 * with [create], the screen opens on a new note the editor makes, offline too.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun NoteRoute(
    graph: AppGraph,
    noteId: String,
    onBack: () -> Unit,
    onOpenNote: (String) -> Unit,
    /** A `#tag` tapped in the note (T40 P6, TG5): its notes. */
    onOpenTag: (String) -> Unit = {},
    create: NewNoteRequest? = null,
    /** The new note [create] asked for is stored: this screen must never make it again (S4). */
    onMade: () -> Unit = {},
    /** The sync icon's explanation offers Sync and storage (PL10). */
    onSyncStorage: () -> Unit = {},
    /** Move to Trash (T40 P3a, NT12): the screen leaves, then the note goes, with Undo. */
    onTrash: () -> Unit = {},
    /** Rename from a list (T40 P4, NT10): the caret starts in the title. */
    focusTitle: Boolean = false,
    /** The breadcrumb's folder (T40 P4, NT11): null is the top level, Home. */
    onOpenFolder: (String?) -> Unit = {},
    /**
     * A daily or weekly note to make as this screen opens (T40 P5, JR1, JR2): the editor page
     * makes it with the synced time zone and template, offline too; the screen is transient
     * and the note itself opens once made ([onPeriodicMade]).
     */
    periodic: PeriodicNoteRequest? = null,
    /** The note [periodic] asked for is stored (or was held): open it instead of this screen. */
    onPeriodicMade: (String) -> Unit = {},
    /** A neighbour of the open periodic note (T40 P5, JR4): its kind and an explicit day. */
    onOpenPeriodic: (ToEditor.PeriodKind, String) -> Unit = { _, _ -> },
    /** The heading a link opened this note at (T40 P7, LK3): scrolled to once it shows. */
    heading: String? = null,
    /** A link followed to a heading (T40 P7, LK3): the note, at the heading when there is one. */
    onOpenNoteAt: (String, String?) -> Unit = { id, _ -> onOpenNote(id) },
    /**
     * The note's whole local graph on its own screen (T40 P7, LK8), from the Local Graph tab's
     * Open Full Graph (T51, A936). Send Feedback left the note's menu (A937): Home's ⋮ and
     * Settings → About have it.
     */
    onLocalGraph: () -> Unit = {},
) {
    val channel = remember(noteId) { EditorWebView.Channel() }
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
    /** A copy of this note's own edits (NT21, A434): said on the note until dismissed or left. */
    var ownCopy by remember(noteId) { mutableStateOf<PageNote?>(null) }
    val services = remember(noteId) {
        EditorPageServices(
            graph.store,
            graph.scope,
            channel::send,
            onCopied = { source, copy, merged ->
                graph.sync.noteEdited(copy.id)
                if (source == noteId) ownCopy = copy else copies.tryEmit(copy to merged)
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
            // The page's last edits are stored before the WebView goes (NoteEditorController.close).
            graph.scope.launch {
                controller.close()
                (holder[0] as? WebView)?.let(EditorWebView::destroy)
            }
        }
    }

    // The theme chosen in Settings → Appearance, on the page too (A305).
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    // Never beside the theme editor's preview (A418): the note's WebView waits for it to go.
    val previewOpen by EditorWebView.previewOpen.collectAsStateWithLifecycle()
    val dark = appearance.isDark(isSystemInDarkTheme())
    LaunchedEffect(services, appearance.theme, dark) {
        // With the text colours the screens read in (A498), so the note reads as they do.
        appearance.theme?.let { services.setTheme(ToEditor.Theme(readableTheme(it), if (dark) "dark" else "light")) }
    }
    // Full-width notes (A501), which a tablet or an unfolded phone shows (A413).
    val fullWidth by remember { graph.device.settings.map { it.settings.fullWidth }.distinctUntilChanged() }.collectAsStateWithLifecycle(false)
    LaunchedEffect(services, fullWidth) { services.setWidth(ToEditor.Width(fullWidth)) }
    // The person's fonts (T51, A944): the note's font and size over the theme's, and the page's own interface font.
    val fonts by remember {
        graph.device.settings.map { ToEditor.Fonts(it.settings.interfaceFont, it.settings.noteFont, it.settings.noteFontSize) }.distinctUntilChanged()
    }.collectAsStateWithLifecycle(DEFAULT_FONTS)
    LaunchedEffect(services, fonts) { services.setFonts(fonts) }
    // The person's line symbols (T44, A747): the note's margin and the bar's symbol sheet.
    val appCommands = app.penmoss.ui.keys.LocalAppCommands.current
    val symbols by remember { graph.device.settings.map { it.settings.symbols }.distinctUntilChanged() }
        .collectAsStateWithLifecycle(LineSymbols.DEFAULTS)
    LaunchedEffect(services, symbols) { services.setSymbols(ToEditor.Symbols(symbols)) }
    // Whether the person is typing (A469, review S8, R3): the soft keyboard is up, or a hardware
    // keyboard is connected (the soft one then stays down while typing). A tag tapped otherwise opens.
    val imeVisible = WindowInsets.isImeVisible
    val configuration = LocalConfiguration.current
    val typing = imeVisible || hasHardwareKeyboard(configuration)
    LaunchedEffect(services, typing) { services.setIme(ToEditor.Ime(typing)) }

    val state by controller.state.collectAsStateWithLifecycle()
    val format by controller.format.collectAsStateWithLifecycle()
    // Back closes the editor's own menu first, as Escape does on the web (A302).
    BackHandler(enabled = format.menu && state.phase == EditorUiState.Phase.READY) { controller.dismissMenu() }

    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_PICKED)) { uris ->
        if (uris.isEmpty()) {
            controller.refocus()
            return@rememberLauncherForActivityResult
        }
        graph.scope.launch {
            val pictures = withContext(Dispatchers.IO) { uris.map { PickedPictures.read(context.contentResolver, it) } }
            if (pictures.any { it == null }) controller.notify("A picture could not be read, or is over 50 MB.")
            holder[0]?.requestFocus()
            controller.insertPictures(pictures.filterNotNull())
        }
    }
    val pickPictures = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }

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
    val picturesFailed by remember(noteId) { graph.attachments.observeFailed(noteId) }.collectAsStateWithLifecycle(null as Int?)
    val retryPictures: () -> Unit = {
        graph.scope.launch {
            graph.attachments.retryFailed()
            graph.sync.requestSync()
        }
    }
    PicturesFailedNotice(picturesFailed, snackbar, onRetry = retryPictures)

    // Where this note stands with the server (PL10, A429), from the phone's own state.
    val syncStatus by graph.sync.status.collectAsStateWithLifecycle()
    val unsent by remember(noteId) { graph.store.observeUnsentCount(noteId) }.collectAsStateWithLifecycle(0)
    val picturesWaiting by remember(noteId) { graph.attachments.observeWaiting(noteId) }.collectAsStateWithLifecycle(0)
    val noteSync = noteSyncState(syncStatus, unsent, picturesWaiting, picturesFailed ?: 0)
    var explaining by rememberSaveable(noteId) { mutableStateOf(false) }

    // The note's folder path (T40 P4, NT11): from the folders in Room, root first.
    val folders by remember { graph.store.observeFolders() }.collectAsStateWithLifecycle(emptyList())
    val placed by remember(noteId) { graph.store.observeNote(noteId) }.collectAsStateWithLifecycle(null)
    val crumbs = remember(folders, placed) { Items.folderPath(folders, placed?.folderId) }
    // Its notebook's name when not the default (T43, A752): a link into a closed one still opens it.
    val notebookName = remember(folders, placed) { noteNotebookName(folders, placed?.folderId) }
    val defaultNotebook by remember { graph.store.observeDefaultNotebookName() }.collectAsStateWithLifecycle(app.penmoss.data.Notebooks.defaultName(null))
    // Copy Agent Reference (T52 item 4; PEN-69): the MCP call that reads the note by its short id.
    val copyAgentReference: (() -> Unit)? = placed?.let { _ ->
        {
            graph.scope.launch {
                val reference = agentReferenceIn(graph, noteId)
                controller.notify(reference?.let { AgentReference.copy(context, it) } ?: "This note isn't on this phone any more")
            }
        }
    }

    /** The open note's period and neighbours, for the row under its top bar (T40 P5, JR4). */
    val periodicNav by controller.periodicNav.collectAsStateWithLifecycle()
    // A periodic screen is transient: the page makes the note, then the note itself opens.
    val makingPeriodic = periodic != null

    var linking by rememberSaveable(noteId) { mutableStateOf(false) }
    var menu by remember(noteId) { mutableStateOf(false) }
    /**
     * The note panel's tab, or null while it is closed (T51, A936): Metadata, Comments, Version
     * History and Local Graph, over the note, so the editor stays open for flush and exchange.
     */
    var panelName by rememberSaveable(noteId) { mutableStateOf<String?>(null) }
    val panel = panelName?.let { name -> PanelTab.entries.firstOrNull { it.name == name } }
    val openPanel = { tab: PanelTab ->
        panelName = tab.name
        PanelMemory.remember(context, tab)
    }
    // Each command opens its tab, or closes the panel when its tab shows, as on the web.
    val togglePanel = { tab: PanelTab -> if (panel == tab) panelName = null else openPanel(tab) }
    /** The move picker, open on the folder the note is in (or going to). */
    var moving by remember(noteId) { mutableStateOf<MovePick?>(null) }
    var tagging by rememberSaveable(noteId) { mutableStateOf(false) }
    val tags by controller.tags.collectAsStateWithLifecycle()
    val info by controller.info.collectAsStateWithLifecycle()
    // The notes linking here, offline from Room (LK5): the Info button's badge and the sheet's list.
    val linkingHere by remember(noteId) { graph.store.observeBacklinkSources(noteId) }.collectAsStateWithLifecycle(emptyList())
    val backlinks = remember(noteId) {
        BacklinksModel(noteId, graph.store, graph.api, graph.scope)
    }
    // Notes edited here the index may not have: Room alone says whether they link here (S3).
    val recentLinkers by remember { graph.store.observeRecentLinkers() }.collectAsStateWithLifecycle(emptySet())
    LaunchedEffect(backlinks, linkingHere, recentLinkers) { backlinks.localChanged(linkingHere, recentLinkers) }
    // A new note opens with the caret in its title (A356) and, since the page cannot raise the
    // keyboard by itself, the app raises it once the note is made (T39).
    val isNew = remember(noteId) { create != null }
    var keyboardRaised by rememberSaveable(noteId) { mutableStateOf(false) }
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
    // The editor's parity with the web (T40 P8): copies, the source, find, the + sheet, counts.
    val tools = controller.tools
    val source by tools.source.collectAsStateWithLifecycle()
    val counts by tools.counts.collectAsStateWithLifecycle()
    val choices by tools.choices.collectAsStateWithLifecycle()
    var finding by rememberSaveable(noteId) { mutableStateOf(false) }
    var counting by rememberSaveable(noteId) { mutableStateOf(false) }
    var sheet by remember(noteId) { mutableStateOf<BlockPurpose?>(null) }
    // Comment threads (T48): the Comments sheet, from the ⋮ menu, a tapped highlight or Comment.
    val comments = controller.comments
    val commentsState by comments.state.collectAsStateWithLifecycle()
    LaunchedEffect(comments) { comments.requests.collect { openPanel(PanelTab.COMMENTS) } }
    // Quick Access (T51, A946): the device's pins, synced; in a git notebook only when the pins live
    // in the Journal notebook (no account, A1014), as on the Mac where a pin is any note's id.
    val quickAccess by remember { graph.device.settings.map { it.settings.quickAccess }.distinctUntilChanged() }
        .collectAsStateWithLifecycle(emptyList())
    val pin = {
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
    val menuScope = rememberCoroutineScope()
    BackHandler(enabled = finding) { finding = false }
    // A hardware keyboard's commands for this note, and the page's dispatcher (T40 P9, A493, A494).
    NoteCommands(
        controller,
        ready = state.phase == EditorUiState.Phase.READY,
        editable = state.phase == EditorUiState.Phase.READY && !state.readOnly,
        launcherNote = if (!makingPeriodic && state.phase == EditorUiState.Phase.READY) noteId to state.title else null,
        nav = if (makingPeriodic) null else periodicNav,
        actions = NoteActions(
            trash = { graph.scope.trashAfterClosing(controller::close, onTrash) },
            move = { graph.scope.launch { moving = MovePick(graph.store.folderOf(noteId)) } },
            history = { togglePanel(PanelTab.HISTORY) },
            saveVersion = {
                graph.scope.launch {
                    controller.notify(
                        saveVersionNow(
                            flush = controller::flushAndWait,
                            exchange = { graph.sync.syncNote(noteId) },
                            save = { graph.api.saveVersion(noteId) },
                            failure = { historyFailure(it) },
                        ),
                    )
                }
            },
            tags = { tagging = true },
            openPeriodic = onOpenPeriodic,
            copyMarkdown = { tools.copy(CopyFormat.MARKDOWN, CopyScope.NOTE) },
            copyRich = { tools.copy(CopyFormat.RICH, CopyScope.NOTE) },
            toggleSource = { tools.setSource(!source) },
            info = { togglePanel(PanelTab.METADATA) },
            localGraph = { togglePanel(PanelTab.GRAPH) },
            comments = { togglePanel(PanelTab.COMMENTS) },
            pinQuickAccess = pin,
            copyAgentReference = copyAgentReference,
            addNoteComment = {
                openPanel(PanelTab.COMMENTS)
                comments.startDraft(app.penmoss.engine.bridge.DraftSource.NOTE)
            },
        ),
    )
    val background = MaterialTheme.colorScheme.background.toArgb()
    /** The page's renderer died (A312): that WebView can't be used again, so it leaves the screen. */
    var rendererGone by remember(noteId) { mutableStateOf(false) }
    /**
     * The page's image lightbox is open (T51, A948): the note's bars step aside so it has the
     * screen, and the back gesture closes it, not the note.
     */
    var lightbox by remember(noteId) { mutableStateOf(false) }
    BackHandler(enabled = lightbox && !rendererGone) { channel.send(BridgeProtocol.encode(ToEditor.CloseLightbox)) }
    val editable = state.phase == EditorUiState.Phase.READY && !state.readOnly
    val canPaste by rememberUpdatedState(editable && !source)
    val hooks = remember(noteId) {
        object : SelectionHooks {
            override fun copyAs(format: CopyFormat) = tools.copy(format, CopyScope.SELECTION)
            // Read off the main thread: a clip can be large (review S3).
            override fun pastePlain() {
                menuScope.launch { tools.pastePlain(withContext(Dispatchers.IO) { NoteClipboard.text(context) }) }
            }

            override fun menuShown() = tools.capture()
            override fun comment() = comments.startDraft(app.penmoss.engine.bridge.DraftSource.SELECTION)
            override val canComment: Boolean get() = canPaste
            override fun find() {
                finding = true
            }
            override val editable: Boolean get() = canPaste
        }
    }

    Scaffold(
        topBar = {
            if (!lightbox) TopAppBar(
                title = {
                    // A periodic screen names what it makes; a note shows its folder path (T40 P4,
                    // NT11): a tap opens the folder, a long press lists levels.
                    if (makingPeriodic) {
                        Text(periodicTitle(periodic))
                    } else {
                        androidx.compose.foundation.layout.Column {
                            // A top-level note names its notebook (T52, as the web's phone app bar):
                            // the git notebook's name, or the default notebook's current one.
                            BreadcrumbBar(
                                path = crumbs,
                                onOpenFolder = onOpenFolder,
                                notebook = (graph.source as? app.penmoss.git.GraphSource.Git)?.name ?: defaultNotebook,
                            )
                            if (notebookName != null) NoteNotebookLine(notebookName)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    if (!makingPeriodic) {
                        InfoButton(linked = linkingHere.size, onClick = { openPanel(PanelTab.METADATA) })
                        // Comments left the bar (T53 item 9, A985): the ⋮ menu and the panel's strip open it.
                        NoteSyncIcon(noteSync, onClick = { explaining = true })
                        val ready = state.phase == EditorUiState.Phase.READY
                        NoteMenu(
                            open = menu,
                            onOpen = { menu = it },
                            ready = ready,
                            onPanel = openPanel,
                            source = source,
                            onSource = tools::setSource,
                            onCopy = { tools.copy(it, CopyScope.NOTE) },
                            onFind = { finding = true },
                            onCount = { counting = true },
                            pinned = noteId in quickAccess,
                            onPin = pin,
                            // A new note can be moved once it is made (until then it is nowhere).
                            canMove = state.phase != EditorUiState.Phase.GONE && (create == null || ready),
                            onMove = {
                                graph.scope.launch { moving = MovePick(graph.store.folderOf(noteId)) }
                            },
                            // The note is closed first: the page's last edits are stored (waited for,
                            // as leaving does), so they go before the Trash request (A432). On the
                            // app's scope: Back meanwhile leaves the screen but keeps the move.
                            onTrash = { graph.scope.trashAfterClosing(controller::close, onTrash) },
                            openComments = commentsState.open.takeIf { commentsState.known },
                            onCopyAgentReference = copyAgentReference,
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) { PenmossSnackbar(it) } },
    ) { padding ->
        // The keyboard pushes the bar up and shrinks the editor above it (the T2 spike's layout).
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            ownCopy?.let { copy ->
                CopyNotice(copy.title, onOpen = { onOpenNote(copy.id) }, onDismiss = { ownCopy = null })
            }
            // On a periodic note, the row under the top bar: the previous and next, the period's
            // name, and the week (or the week's days), as the web shows them (T40 P5, JR4).
            val nav = periodicNav
            if (!makingPeriodic && nav != null && !lightbox) {
                // Its Week and day chips marked where the phone holds the note (T40 P9, N4).
                val marks by remember { graph.store.observeJournalMarks().map(::journalMarksOf).distinctUntilChanged() }
                    .collectAsStateWithLifecycle(JournalMarks())
                PeriodNavRow(nav, onOpenPeriodic = onOpenPeriodic, marks = marks)
            }
            if (finding) {
                FindBar(remember(noteId) { WebViewFind { holder[0] as? WebView } }, onClose = { finding = false }, refresh = counts)
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                NoteBody(state, editorAlive = !rendererGone, onRetry = controller::retry, previewOpen = previewOpen) { visible ->
                    AndroidView(
                        factory = { context ->
                            graph.notePages.create(
                                context,
                                noteId,
                                channel,
                                NotePages.Hooks(
                                    onMessage = { raw ->
                                        if (raw.contains("\"lightbox\"")) {
                                            (BridgeProtocol.decodeFromEditor(raw) as? FromEditor.Lightbox)?.let { lightbox = it.open }
                                        }
                                        controller.onPageMessage(raw)
                                        services.onPageMessage(raw)
                                        linked.onPageMessage(raw)
                                    },
                                    onRendererGone = {
                                        rendererGone = true
                                        lightbox = false
                                        services.stop()
                                        linked.stop()
                                        controller.pageGone()
                                    },
                                    onBytes = controller::onPageBytes,
                                    picture = { sha, ext ->
                                        graph.attachments.fileFor(sha, ext)?.let { EditorWebView.pictureResponse(it, ext) }
                                    },
                                    onPickImages = pickPictures,
                                    onPickFiles = pickFiles,
                                    remote = graph.webPictures::respond,
                                ),
                            ).also {
                                it.setBackgroundColor(background)
                                (it as? SelectionWebView)?.hooks = hooks
                                holder[0] = it
                            }
                        },
                        update = {
                            it.setBackgroundColor(background)
                            it.visibility = if (visible) View.VISIBLE else View.INVISIBLE
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
            if (!lightbox && showsFormatBar(editable, source, format)) {
                FormatBar(
                    format,
                    onCommand = controller::format,
                    onLink = { linking = true },
                    onPicture = pickPictures,
                    onAttach = pickFiles,
                    onInsert = { sheet = BlockPurpose.INSERT },
                    onBlock = tools::block,
                    onTurnInto = { sheet = BlockPurpose.TURN_INTO },
                    symbols = symbols,
                    onSymbol = controller::toggleSymbol,
                    // Settings → Symbols, as the web picker's Edit symbols… (T44, A747).
                    onEditSymbols = { appCommands.run("app.symbols") },
                )
            }
        }
    }

    if (counting) WordCountDialog(counts, onDismiss = { counting = false })
    sheet?.let { purpose ->
        BlockSheet(
            purpose,
            choices,
            onQuery = { tools.requestBlocks(purpose, it) },
            onPick = { entry ->
                sheet = null
                holder[0]?.requestFocus()
                if (purpose == BlockPurpose.INSERT) tools.insert(entry.id) else tools.turnInto(entry.id)
            },
            onDismiss = {
                sheet = null
                holder[0]?.requestFocus()
                controller.refocus()
            },
        )
    }
    if (explaining) NoteSyncExplanation(noteSync, onSyncStorage, onRetryPictures = retryPictures, onDismiss = { explaining = false })
    moving?.let { pick ->
        FolderPickerFor(
            graph,
            title = "Move “${state.title.ifBlank { Items.UNTITLED }}” to…",
            current = pick.current,
            onPick = { folder ->
                moving = null
                graph.scope.launch { controller.notify(moveNoteAndSay(graph, noteId, folder)) }
            },
            onDismiss = { moving = null },
        )
    }

    if (tagging) {
        // Every tag on any note (A577, A656): the phone's index, then what `/api/tags` adds; never
        // the note's own, frontmatter or inline.
        val known by remember(noteId) {
            combine(graph.store.observeTagCounts(), graph.store.observeTagList(), graph.store.observeTagsOf(noteId)) { indexed, listed, ownTags ->
                val own = ownTags.toSet()
                Tags.everyTag(indexed.map { it.tag to it.notes }, listed.map { it.name to it.notes }).filter { it.first !in own }
            }
        }.collectAsStateWithLifecycle(emptyList())
        LaunchedEffect(Unit) { refreshTagList(graph) }
        TagSheet(
            tags = tags,
            editable = editable,
            known = known,
            onAdd = { tag -> tagRefused(controller.setTag(tag, on = true))?.let(controller::notify) },
            onRemove = { tag -> tagRefused(controller.setTag(tag, on = false))?.let(controller::notify) },
            onDismiss = { tagging = false },
        )
    }

    if (linking) {
        LinkDialog(
            current = format.href,
            onApply = { address ->
                linking = false
                holder[0]?.requestFocus()
                controller.format(FormatCommand.LINK, address)
            },
            onDismiss = {
                linking = false
                holder[0]?.requestFocus()
                controller.refocus()
            },
        )
    }

    panel?.let { tab ->
        NotePanel(
            tab = tab,
            onTab = openPanel,
            onClose = { panelName = null },
            openComments = if (commentsState.known) commentsState.open else 0,
        ) { shown ->
            when (shown) {
                PanelTab.METADATA -> {
                    val backlinksUi by backlinks.ui.collectAsStateWithLifecycle()
                    val directory by remember { graph.store.observeDirectory() }.collectAsStateWithLifecycle(emptyList())
                    val titles = remember(directory) { directory.associate { it.id to it.title.ifBlank { Items.UNTITLED } } }
                    // Read again each time the tab shows, with the title as the phone has it (LK6).
                    LaunchedEffect(Unit) { backlinks.load(state.title) }
                    // Its tags as Room has them, frontmatter and inline (A656): the inline ones listed apart (A502).
                    val allTags by remember(noteId) { graph.store.observeTagsOf(noteId) }.collectAsStateWithLifecycle(emptyList())
                    val notebook = rememberInfoNotebook(graph, folders, placed?.folderId)
                    InfoSheet(
                        noteId = noteId,
                        rows = infoRows(crumbs.map { it.name }, info, placed?.updatedAt, saved = noteSync, counts = counts, notebook = notebook),
                        kind = infoKind(info),
                        tags = tags,
                        inline = remember(allTags, tags) { inlineTags(allTags, tags) },
                        canTag = state.phase == EditorUiState.Phase.READY,
                        fields = info?.fields,
                        backlinks = backlinksUi,
                        titleOf = { titles[it] },
                        onTags = { tagging = true },
                        onOpen = { id ->
                            panelName = null
                            onOpenNote(id)
                        },
                        onDismiss = { panelName = null },
                        embedded = true,
                    )
                }
                PanelTab.COMMENTS -> {
                    // Leaving the tab ends a draft and the highlight, as closing the sheet did.
                    DisposableEffect(comments) {
                        onDispose {
                            comments.cancelDraft()
                            comments.setActive(null)
                        }
                    }
                    NoteCommentsSheet(graph, noteId, comments, editable = editable, onDismiss = { panelName = null }, embedded = true)
                }
                // Back leaves the panel, not the note; history actions flush the editor first, then
                // the exchange reaches the same page (T40 P3b, NT18–NT20).
                PanelTab.HISTORY -> HistoryRoute(
                    graph,
                    noteId,
                    flushEditor = { controller.flushAndWait() },
                    exchangeNow = { graph.sync.syncNote(noteId) },
                    onBack = { panelName = null },
                    embedded = true,
                )
                PanelTab.GRAPH -> {
                    val model by remember {
                        graph.store.observeGraph(graph.hiddenFolders).atMostEvery(GRAPH_BATCH_MS).map(GraphInput::model).flowOn(Dispatchers.Default)
                    }.collectAsStateWithLifecycle(null)
                    LocalGraphPanel(
                        title = state.title,
                        neighbours = remember(model, noteId) { model?.let { neighbours(it, noteId) } },
                        onOpen = { id ->
                            panelName = null
                            onOpenNote(id)
                        },
                        // The whole local graph, on its own screen (the note's page closes for it, A418).
                        onOpenGraph = {
                            panelName = null
                            onLocalGraph()
                        },
                    )
                }
            }
        }
    }
}

/**
 * The note's slot: the [editor] and, over it, the progress bar and the state's message, or
 * the message alone with Try again when the note can't be shown (T39).
 *
 * The editor stays composed in every phase while its page is alive (T39 review): a note that
 * couldn't be fetched hides the one WebView ([editor] gets `visible = false`) instead of
 * dropping it, so Try again, or a sync bringing the note, opens it on that same page. Built
 * anew, a second WebView took the open while the first, detached page still ran, and the
 * first one leaked. Only a page whose renderer is gone ([editorAlive] false) leaves for good.
 *
 * The editor is not made while the theme editor's preview is alive ([previewOpen], A418): a
 * phone holds one editor WebView at a time. Once made it stays.
 */
@Composable
internal fun NoteBody(
    state: EditorUiState,
    editorAlive: Boolean,
    onRetry: () -> Unit,
    previewOpen: Boolean = false,
    editor: @Composable (visible: Boolean) -> Unit,
) {
    val unavailable = state.phase == EditorUiState.Phase.UNAVAILABLE || state.phase == EditorUiState.Phase.GONE
    var made by remember { mutableStateOf(false) }
    if (!previewOpen) made = true
    Box(Modifier.fillMaxSize()) {
        if (editorAlive && made) editor(!unavailable)
        if (!made && !unavailable) {
            Text(
                "The note opens once the theme preview has closed.",
                Modifier.padding(16.dp).testTag("noteWaiting"),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (unavailable) {
            // Opaque and touch-blocking (Surface), so nothing of the hidden page shows or takes a tap.
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                CenteredMessage(state.message, action = if (state.canRetry) "Try Again" to onRetry else null)
            }
        } else {
            Column(Modifier.fillMaxWidth()) {
                if (state.phase == EditorUiState.Phase.LOADING) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.message?.let {
                    Text(
                        it,
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** Where the move picker starts: the folder the note is in or going to (null: the top level). */
private data class MovePick(val current: String?)

/**
 * The note's ⋮ menu (T51, A937), in the web's groups with the phone's own tools: the panel's
 * tabs and Markdown source; the copies (with Copy Agent Reference, T52 item 4); Find in Note and Word Count; then Pin to Quick Access,
 * Move to Folder… and Move to Trash, last as on the web (T39 pass 3, A890). Tags are in the
 * Metadata tab and Send Feedback in Home's ⋮ and Settings → About.
 */
@Composable
internal fun NoteMenu(
    open: Boolean,
    onOpen: (Boolean) -> Unit,
    /** The note is open in the editor: the tools, Version History and Move to Trash wait for it. */
    ready: Boolean,
    onPanel: (PanelTab) -> Unit,
    /** Whether the Markdown source shows (View Note then), and showing it or the note. */
    source: Boolean = false,
    onSource: (Boolean) -> Unit = {},
    onCopy: (CopyFormat) -> Unit = {},
    onFind: () -> Unit = {},
    onCount: () -> Unit = {},
    /** Whether the note is in Quick Access (T51, A946); none offered when null (a git notebook's note). */
    pinned: Boolean? = null,
    onPin: () -> Unit = {},
    canMove: Boolean = true,
    onMove: () -> Unit = {},
    onTrash: () -> Unit = {},
    /** The note's open comment threads (T48), shown beside Comments; null until the page says. */
    openComments: Int? = null,
    /** Copy Agent Reference (T52 item 4), in the copies; none offered when null (no note yet). */
    onCopyAgentReference: (() -> Unit)? = null,
) {
    Box {
        TipIconButton(Icons.Default.MoreVert, "Note Actions", onClick = { onOpen(true) }, modifier = Modifier.testTag("noteMore"))
        DropdownMenu(expanded = open, onDismissRequest = { onOpen(false) }) {
            val item = @Composable { label: String, tag: String, enabled: Boolean, action: () -> Unit ->
                DropdownMenuItem(
                    text = { Text(label) },
                    enabled = enabled,
                    onClick = {
                        onOpen(false)
                        action()
                    },
                    modifier = Modifier.testTag(tag),
                )
            }
            item("View Metadata", "noteMetadata", true) { onPanel(PanelTab.METADATA) }
            DropdownMenuItem(
                text = { Text("Comments") },
                trailingIcon = { if (openComments != null && openComments > 0) Text(openComments.toString()) },
                onClick = {
                    onOpen(false)
                    onPanel(PanelTab.COMMENTS)
                },
                modifier = Modifier.testTag("noteComments"),
            )
            item("Version History", "noteHistory", ready) { onPanel(PanelTab.HISTORY) }
            item("Local Graph", "noteLocalGraph", true) { onPanel(PanelTab.GRAPH) }
            // Markdown Source, as the web names it, ticked while it shows (a second tap shows the note).
            DropdownMenuItem(
                text = { Text("Markdown Source") },
                enabled = ready,
                trailingIcon = { if (source) Icon(Icons.Default.Check, contentDescription = null) },
                onClick = {
                    onOpen(false)
                    onSource(!source)
                },
                modifier = Modifier.testTag("noteSource").semantics {
                    role = Role.Checkbox
                    selected = source
                },
            )
            HorizontalDivider()
            item("Copy Note as Markdown", "noteCopyMarkdown", ready) { onCopy(CopyFormat.MARKDOWN) }
            item("Copy Note as Rich Text", "noteCopyRich", ready) { onCopy(CopyFormat.RICH) }
            if (onCopyAgentReference != null) item("Copy Agent Reference", "noteCopyAgentReference", true, onCopyAgentReference)
            HorizontalDivider()
            item("Find in Note", "noteFind", ready, onFind)
            item("Word Count", "noteWordCount", ready, onCount)
            HorizontalDivider()
            if (pinned != null) {
                item(if (pinned) "Unpin from Quick Access" else "Pin to Quick Access", "notePin", true, onPin)
            }
            item("Move to Folder…", "noteMove", canMove, onMove)
            item("Move to Trash", "noteTrash", ready, onTrash)
        }
    }
}

/** What to tell Ryan when a tag change was not sent (T38 review). */
private fun tagRefused(change: NoteEditorController.TagChange): String? = when (change) {
    NoteEditorController.TagChange.SENT -> null
    NoteEditorController.TagChange.OPENING -> "Still opening the note. Try again in a moment."
    NoteEditorController.TagChange.READ_ONLY -> "This note can’t be changed here."
}

/** The note's sync icon (PL10, A429): what it shows is said in its content description. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NoteSyncIcon(sync: NoteSync, onClick: () -> Unit) {
    val icon = when (sync.state) {
        NoteSyncState.SYNCED -> SettingsIcons.CloudDone
        NoteSyncState.SYNCING -> SettingsIcons.CloudSync
        NoteSyncState.WAITING -> SettingsIcons.CloudUpload
        NoteSyncState.OFFLINE -> SettingsIcons.CloudOff
        NoteSyncState.FAILING, NoteSyncState.PICTURES_FAILED -> SettingsIcons.CloudAlert
    }
    val alarming = sync.state == NoteSyncState.FAILING || sync.state == NoteSyncState.PICTURES_FAILED
    // The save status in words on a long press (T40 P8, NT24): the web's status bar says it.
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Below),
        tooltip = { PlainTooltip { Text(sync.label, Modifier.testTag("noteSyncTooltip")) } },
        state = rememberTooltipState(),
    ) {
        IconButton(onClick = onClick, modifier = Modifier.testTag("noteSync")) {
            Icon(
                icon,
                contentDescription = "Sync: ${sync.label}",
                tint = if (alarming) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** What the sync icon means, with a way to Sync and storage, and Retry for failed pictures (PL10, AC8). */
@Composable
internal fun NoteSyncExplanation(sync: NoteSync, onSyncStorage: () -> Unit, onRetryPictures: () -> Unit, onDismiss: () -> Unit) {
    val failed = sync.state == NoteSyncState.PICTURES_FAILED
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(sync.label) },
        text = { Text(sync.explanation, Modifier.testTag("noteSyncExplanation")) },
        confirmButton = {
            if (failed) {
                TextButton(onClick = {
                    onDismiss()
                    onRetryPictures()
                }, modifier = Modifier.testTag("retryNotePictures")) { Text("Retry") }
            } else {
                TextButton(onClick = onDismiss) { Text("OK") }
            }
        },
        dismissButton = {
            TextButton(onClick = {
                onDismiss()
                onSyncStorage()
            }, modifier = Modifier.testTag("openSyncStorage")) { Text("Sync and Storage") }
        },
    )
}

/**
 * Says so when one more of this note's pictures fails for good (AC8, A428), with Retry. [failed]
 * is null until Room has answered: the first count is where it starts, so a note opened with a
 * picture already failed says nothing (its sync icon does).
 */
@Composable
internal fun PicturesFailedNotice(failed: Int?, snackbar: SnackbarHostState, onRetry: () -> Unit) {
    val before = remember { intArrayOf(-1) }
    LaunchedEffect(failed) {
        failed ?: return@LaunchedEffect
        val grew = before[0] >= 0 && failed > before[0]
        before[0] = failed
        if (!grew) return@LaunchedEffect
        val shown = snackbar.showSnackbar(
            "A picture in this note could not be uploaded, so other devices show it as missing.",
            actionLabel = "Retry",
            duration = SnackbarDuration.Long,
        )
        if (shown == SnackbarResult.ActionPerformed) onRetry()
    }
}

/**
 * This note's own edits are kept in a conflict copy (T40 P3a, NT21, A434), as the web's note says
 * since T39 (A525): what happened, **Open the copy** and **Dismiss**, until dismissed or the note
 * is left. The server's copy changed under this phone's edits (a restore, most often), so what
 * the phone had that it lacks is in the copy.
 */
@Composable
internal fun CopyNotice(copyTitle: String, onOpen: () -> Unit, onDismiss: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth().testTag("copyNotice")) {
        Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 10.dp)) {
            Text(
                "This note was restored or replaced on the server. What this phone had that it lacks is kept in a conflict copy, “$copyTitle”.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss, modifier = Modifier.testTag("dismissCopyNotice")) { Text("Dismiss") }
                TextButton(onClick = onOpen, modifier = Modifier.testTag("openCopy")) { Text("Open the Copy") }
            }
        }
    }
}

/** What a periodic screen makes: "Today", "This week", or the explicit day (T40 P5). */
internal fun periodicTitle(periodic: PeriodicNoteRequest?): String {
    if (periodic == null) return ""
    if (periodic.day != null) return periodic.day
    return if (periodic.kind == ToEditor.PeriodKind.DAILY) "Today" else "This Week"
}

/**
 * On a periodic note, the row under the top bar (T40 P5, JR4): the previous and next period,
 * the period's name, and the week (or the week's seven days), as the web shows them. Buttons
 * rather than swipes, so swiping never fights text selection. Every target names an explicit
 * day, so the app never computes a period.
 */
@Composable
internal fun PeriodNavRow(
    nav: FromEditor.PeriodicNavData,
    onOpenPeriodic: (ToEditor.PeriodKind, String) -> Unit,
    /** The days and weeks whose notes the phone holds (T40 P9, P5 review N4): their chips are marked. */
    marks: JournalMarks = JournalMarks(),
) {
    val kind = if (nav.kind == ToEditor.PeriodKind.DAILY) ToEditor.PeriodKind.DAILY else ToEditor.PeriodKind.WEEKLY
    // One column of its own: the two rows stack wherever the row is placed, so the chips never
    // sit over the previous and next buttons (a bare test host stacked them at the origin).
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(
                onClick = { onOpenPeriodic(kind, nav.prev.date) },
                modifier = Modifier.testTag("periodPrev").semantics { contentDescription = nav.prev.full },
            ) { Text(nav.prev.label, maxLines = 1) }
            Text(
                nav.label,
                Modifier.weight(1f).testTag("periodLabel"),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
            )
            TextButton(
                onClick = { onOpenPeriodic(kind, nav.next.date) },
                modifier = Modifier.testTag("periodNext").semantics { contentDescription = nav.next.full },
            ) { Text(nav.next.label, maxLines = 1) }
        }
        val week = nav.week
        val days = nav.days
        if (week != null || days != null) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (week != null) {
                    PeriodChip(week, held = week.period in marks.weeks, tag = "periodWeek") {
                        onOpenPeriodic(ToEditor.PeriodKind.WEEKLY, week.date)
                    }
                }
                days?.forEach { day ->
                    PeriodChip(day, held = day.period in marks.days, tag = "periodDay-${day.date}") {
                        onOpenPeriodic(ToEditor.PeriodKind.DAILY, day.date)
                    }
                }
            }
        }
    }
}

/**
 * Whether the formatting bar rides on the keyboard (A301): in an editable note shown as a
 * document, and not while the caret is in the title, where its buttons act on nothing (T39
 * pass 1's proposal 5, settled in pass 3, A554).
 */
internal fun showsFormatBar(editable: Boolean, source: Boolean, format: FormatState): Boolean =
    editable && !source && !format.inTitle

/** A hardware keyboard is connected and in use (T40 P6 review R3). */
internal fun hasHardwareKeyboard(configuration: android.content.res.Configuration): Boolean =
    configuration.keyboard == android.content.res.Configuration.KEYBOARD_QWERTY &&
        configuration.hardKeyboardHidden == android.content.res.Configuration.HARDKEYBOARDHIDDEN_NO

/**
 * A Week or day chip of the period row (T40 P5, JR4). One whose note the phone holds is marked
 * as the web marks it (`data-has-note`, P5 review N4): a dot before its label, and "has a note"
 * in its spoken name, in the calendar's words (A454).
 */
@Composable
private fun PeriodChip(target: FromEditor.NavTarget, held: Boolean, tag: String, onClick: () -> Unit) {
    AssistChip(
        onClick = onClick,
        label = { Text(target.label, maxLines = 1) },
        leadingIcon = if (held) {
            {
                Box(
                    Modifier.size(6.dp).background(MaterialTheme.colorScheme.primary, CircleShape).testTag("$tag-held"),
                )
            }
        } else {
            null
        },
        modifier = Modifier.testTag(tag).semantics {
            contentDescription = if (held) "${target.full}, has a note" else target.full
        },
    )
}

/** The fonts until the settings are read: the theme's own, at the default size (A944). */
private val DEFAULT_FONTS = ToEditor.Fonts(
    app.penmoss.engine.settings.FontSettings.THEME,
    app.penmoss.engine.settings.FontSettings.THEME,
    app.penmoss.engine.settings.FontSettings.SIZE_DEFAULT,
)
