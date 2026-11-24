package app.penmoss.ui.note

import app.penmoss.engine.notes.Tags
import app.penmoss.ui.common.roles
import kotlinx.coroutines.flow.combine
import android.view.View
import android.webkit.WebView
import app.penmoss.ui.keys.NoteActions
import app.penmoss.ui.keys.NoteCommands
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import app.penmoss.ui.common.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import app.penmoss.ui.common.TextButton
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
import kotlinx.coroutines.flow.flowOn
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.toArgb
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.NotebookGraph
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.editor.EditorUiState
import app.penmoss.editor.EditorWebView
import app.penmoss.editor.FormatState
import app.penmoss.editor.NewNoteRequest
import app.penmoss.editor.NoteEditorController
import app.penmoss.editor.NotePages
import app.penmoss.editor.PeriodicNoteRequest
import app.penmoss.editor.SelectionWebView
import app.penmoss.engine.bridge.BlockPurpose
import app.penmoss.engine.bridge.CopyFormat
import app.penmoss.engine.bridge.CopyScope
import app.penmoss.engine.bridge.FormatCommand
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.ui.home.CenteredMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import app.penmoss.ui.common.Items
import app.penmoss.ui.common.PenmossSnackbar
import app.penmoss.ui.common.TipIconButton
import app.penmoss.ui.folders.BreadcrumbBar
import app.penmoss.ui.folders.FolderPickerFor
import app.penmoss.ui.graph.GRAPH_BATCH_MS
import app.penmoss.ui.graph.GraphInput
import app.penmoss.ui.history.HistoryRoute
import app.penmoss.ui.journal.JournalMarks
import app.penmoss.ui.folders.TagSheet
import app.penmoss.ui.graph.atMostEvery
import app.penmoss.ui.journal.journalMarksOf
import app.penmoss.ui.open
import app.penmoss.ui.folders.refreshTagList
import app.penmoss.ui.trash.titleOf
import app.penmoss.ui.common.BackButton

/**
 * An open note (T32; the writing screen, T33): the native top bar, the editor
 * WebView, and the formatting bar, which moves up with the keyboard while the
 * WebView shrinks above it, so the caret stays in view (A301, A307). Back first
 * closes a menu the editor has open (A302); otherwise it leaves the note, and
 * its last edits are stored before the WebView goes.
 *
 * The top bar's menu (T38) moves the note to another folder and shows its tags;
 * with [create], the screen opens on a new note the editor makes, offline too.
 * What it shows and does is [NoteScreenState]'s (A6); this draws it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteRoute(
    graph: NotebookGraph,
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
    val note = rememberNoteScreenState(graph, noteId, onOpenNote, onOpenTag, create, onMade, focusTitle, periodic, onPeriodicMade, heading, onOpenNoteAt)
    // Its panel open or closed, in the layout usage analytics records (PEN-174).
    app.penmoss.analytics.TrackNotePanel(note.panel != null)
    val controller = note.controller
    val tools = note.tools
    val state = note.editor
    val format = note.format
    val source = note.source
    // Back closes the editor's own menu first, as Escape does on the web (A302).
    BackHandler(enabled = format.menu && state.phase == EditorUiState.Phase.READY) { controller.dismissMenu() }
    BackHandler(enabled = note.finding) { note.finding = false }
    BackHandler(enabled = note.lightbox && !note.rendererGone) { note.channel.send(BridgeProtocol.encode(ToEditor.CloseLightbox)) }
    val appCommands = app.penmoss.ui.keys.LocalAppCommands.current
    // A hardware keyboard's commands for this note, and the page's dispatcher (T40 P9, A493, A494).
    NoteCommands(
        controller,
        ready = note.ready,
        editable = note.editable,
        launcherNote = if (!note.makingPeriodic && note.ready) noteId to state.title else null,
        nav = if (note.makingPeriodic) null else note.periodicNav,
        actions = NoteActions(
            trash = { note.trash(onTrash) },
            move = note::startMove,
            history = { note.togglePanel(PanelTab.HISTORY) },
            saveVersion = note::saveVersion,
            tags = { note.tagging = true },
            openPeriodic = onOpenPeriodic,
            copyMarkdown = { tools.copy(CopyFormat.MARKDOWN, CopyScope.NOTE) },
            copyRich = { tools.copy(CopyFormat.RICH, CopyScope.NOTE) },
            toggleSource = { tools.setSource(!source) },
            info = { note.togglePanel(PanelTab.METADATA) },
            localGraph = { note.togglePanel(PanelTab.GRAPH) },
            comments = { note.togglePanel(PanelTab.COMMENTS) },
            pinQuickAccess = note::pin,
            copyAgentReference = note.copyAgentReference,
            addNoteComment = {
                note.openPanel(PanelTab.COMMENTS)
                note.comments.startDraft(app.penmoss.engine.bridge.DraftSource.NOTE)
            },
        ),
    )
    val background = MaterialTheme.colorScheme.background.toArgb()
    val commentsState by note.comments.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            if (!note.lightbox) TopAppBar(
                title = {
                    // A periodic screen names what it makes; a note shows its folder path (T40 P4,
                    // NT11): a tap opens the folder, a long press lists levels.
                    if (note.makingPeriodic) {
                        Text(periodicTitle(periodic))
                    } else {
                        // A top-level note names its notebook (T52, as the web's phone app bar):
                        // the git notebook's.
                        BreadcrumbBar(
                            path = note.crumbs,
                            onOpenFolder = onOpenFolder,
                            notebook = graph.name,
                        )
                    }
                },
                navigationIcon = {
                    BackButton(onBack)
                },
                actions = {
                    if (!note.makingPeriodic) {
                        InfoButton(linked = note.linkingHere.size, onClick = { note.openPanel(PanelTab.METADATA) })
                        // Comments left the bar (T53 item 9, A985): the ⋮ menu and the panel's strip open it.
                        NoteSyncIcon(note.noteSync, onClick = { note.explaining = true })
                        val ready = note.ready
                        NoteMenu(
                            open = note.menu,
                            onOpen = { note.menu = it },
                            ready = ready,
                            onPanel = note::openPanel,
                            source = source,
                            onSource = tools::setSource,
                            onCopy = { tools.copy(it, CopyScope.NOTE) },
                            onFind = { note.finding = true },
                            onCount = { note.counting = true },
                            pinned = note.pinned,
                            onPin = note::pin,
                            // A new note can be moved once it is made (until then it is nowhere).
                            canMove = state.phase != EditorUiState.Phase.GONE && (create == null || ready),
                            onMove = note::startMove,
                            onTrash = { note.trash(onTrash) },
                            openComments = commentsState.open.takeIf { commentsState.known },
                            onCopyAgentReference = note.copyAgentReference,
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(note.snackbar) { PenmossSnackbar(it) } },
    ) { padding ->
        // The keyboard pushes the bar up and shrinks the editor above it (the T2 spike's layout).
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            note.ownCopy?.let { copy ->
                CopyNotice(copy.title, onOpen = { onOpenNote(copy.id) }, onDismiss = { note.ownCopy = null })
            }
            // On a periodic note, the row under the top bar: the previous and next, the period's
            // name, and the week (or the week's days), as the web shows them (T40 P5, JR4).
            val nav = note.periodicNav
            if (!note.makingPeriodic && nav != null && !note.lightbox) {
                // Its Week and day chips marked where the phone holds the note (T40 P9, N4).
                val marks by remember { graph.store.observeJournalMarks().map(::journalMarksOf).distinctUntilChanged() }
                    .collectAsStateWithLifecycle(JournalMarks())
                PeriodNavRow(nav, onOpenPeriodic = onOpenPeriodic, marks = marks)
            }
            if (note.finding) {
                FindBar(remember(noteId) { WebViewFind { note.webView() } }, onClose = { note.finding = false }, refresh = note.counts)
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                NoteBody(state, editorAlive = !note.rendererGone, onRetry = controller::retry, previewOpen = note.previewOpen) { visible ->
                    AndroidView(
                        factory = { context ->
                            graph.notePages.create(
                                context,
                                noteId,
                                note.channel,
                                NotePages.Hooks(
                                    onMessage = { raw ->
                                        if (raw.contains("\"lightbox\"")) {
                                            (BridgeProtocol.decodeFromEditor(raw) as? FromEditor.Lightbox)?.let { note.lightbox = it.open }
                                        }
                                        controller.onPageMessage(raw)
                                        note.services.onPageMessage(raw)
                                        note.linked.onPageMessage(raw)
                                    },
                                    onRendererGone = {
                                        note.rendererGone = true
                                        note.lightbox = false
                                        note.services.stop()
                                        note.linked.stop()
                                        controller.pageGone()
                                    },
                                    onBytes = controller::onPageBytes,
                                    picture = { sha, ext ->
                                        graph.attachments.fileFor(sha, ext)?.let { EditorWebView.pictureResponse(it, ext) }
                                    },
                                    onPickImages = note.pickPictures,
                                    onPickFiles = note.pickFiles,
                                    remote = graph.webPictures::respond,
                                ),
                            ).also {
                                it.setBackgroundColor(background)
                                (it as? SelectionWebView)?.hooks = note.hooks
                                note.holder[0] = it
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
            if (!note.lightbox && showsFormatBar(note.editable, source, format)) {
                FormatBar(
                    format,
                    onCommand = controller::format,
                    onLink = { note.linking = true },
                    onPicture = note.pickPictures,
                    onAttach = note.pickFiles,
                    onInsert = { note.sheet = BlockPurpose.INSERT },
                    onBlock = tools::block,
                    onTurnInto = { note.sheet = BlockPurpose.TURN_INTO },
                    symbols = note.symbols,
                    onSymbol = controller::toggleSymbol,
                    // Settings → Symbols, as the web picker's Edit symbols… (T44, A747).
                    onEditSymbols = { appCommands.run("app.symbols", source = "button") },
                )
            }
        }
    }

    NoteDialogs(note, onSyncStorage)
    note.panel?.let { tab ->
        NotePanelHost(note, tab, openComments = if (commentsState.known) commentsState.open else 0, onOpenNote = onOpenNote, onLocalGraph = onLocalGraph)
    }
}

/** What opens over the note (A6): Word Count, the block sheet, the sync icon's explanation, the move picker, tags and a link. */
@Composable
private fun NoteDialogs(note: NoteScreenState, onSyncStorage: () -> Unit) {
    val graph = note.graph
    val noteId = note.noteId
    val controller = note.controller
    val tools = note.tools
    if (note.counting) WordCountDialog(note.counts, onDismiss = { note.counting = false })
    note.sheet?.let { purpose ->
        BlockSheet(
            purpose,
            note.choices,
            onQuery = { tools.requestBlocks(purpose, it) },
            onPick = { entry ->
                note.sheet = null
                note.focusPage()
                if (purpose == BlockPurpose.INSERT) tools.insert(entry.id) else tools.turnInto(entry.id)
            },
            onDismiss = {
                note.sheet = null
                note.focusPage()
                controller.refocus()
            },
        )
    }
    if (note.explaining) NoteSyncExplanation(note.noteSync, onSyncStorage, onRetryPictures = note::retryPictures, onDismiss = { note.explaining = false })
    note.moving?.let { pick ->
        FolderPickerFor(
            graph,
            title = "Move “${note.editor.title.ifBlank { Items.UNTITLED }}” To…",
            current = pick.current,
            onPick = { folder ->
                note.moving = null
                note.moveTo(folder)
            },
            onDismiss = { note.moving = null },
        )
    }

    if (note.tagging) {
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
            tags = note.tags,
            editable = note.editable,
            known = known,
            onAdd = { tag -> tagRefused(controller.setTag(tag, on = true))?.let(controller::notify) },
            onRemove = { tag -> tagRefused(controller.setTag(tag, on = false))?.let(controller::notify) },
            onDismiss = { note.tagging = false },
        )
    }

    if (note.linking) {
        LinkDialog(
            current = note.format.href,
            onApply = { address ->
                note.linking = false
                note.focusPage()
                controller.format(FormatCommand.LINK, address)
            },
            onDismiss = {
                note.linking = false
                note.focusPage()
                controller.refocus()
            },
        )
    }
}

/** The note panel over the note (T51, A936): its Metadata (the Info sheet), Comments, Version History and Local Graph. */
@Composable
private fun NotePanelHost(note: NoteScreenState, tab: PanelTab, openComments: Int, onOpenNote: (String) -> Unit, onLocalGraph: () -> Unit) {
    val graph = note.graph
    val noteId = note.noteId
    NotePanel(
        tab = tab,
        onTab = note::openPanel,
        onClose = note::closePanel,
        openComments = openComments,
    ) { shown ->
        when (shown) {
            PanelTab.METADATA -> NoteInfoTab(note, onOpenNote)
            PanelTab.COMMENTS -> {
                val comments = note.comments
                // Leaving the tab ends a draft and the highlight, as closing the sheet did.
                DisposableEffect(comments) {
                    onDispose {
                        comments.cancelDraft()
                        comments.setActive(null)
                    }
                }
                NoteCommentsSheet(graph, noteId, comments, editable = note.editable, onDismiss = note::closePanel, embedded = true)
            }
            // Back leaves the panel, not the note; history actions flush the editor first, then
            // the exchange reaches the same page (T40 P3b, NT18–NT20).
            PanelTab.HISTORY -> HistoryRoute(
                graph,
                noteId,
                flushEditor = { note.controller.flushAndWait() },
                exchangeNow = { graph.sync.syncNote(noteId) },
                onBack = note::closePanel,
                embedded = true,
            )
            PanelTab.GRAPH -> {
                val model by remember {
                    graph.store.observeGraph().atMostEvery(GRAPH_BATCH_MS).map(GraphInput::model).flowOn(Dispatchers.Default)
                }.collectAsStateWithLifecycle(null)
                LocalGraphPanel(
                    title = note.editor.title,
                    neighbours = remember(model, noteId) { model?.let { neighbours(it, noteId) } },
                    onOpen = { id ->
                        note.closePanel()
                        onOpenNote(id)
                    },
                    // The whole local graph, on its own screen (the note's page closes for it, A418).
                    onOpenGraph = {
                        note.closePanel()
                        onLocalGraph()
                    },
                )
            }
        }
    }
}

/** The panel's Metadata tab (LK5, LK6, A502, A656): the note's details, its tags and the notes linking here. */
@Composable
private fun NoteInfoTab(note: NoteScreenState, onOpenNote: (String) -> Unit) {
    val graph = note.graph
    val noteId = note.noteId
    val backlinksUi by note.backlinks.ui.collectAsStateWithLifecycle()
    val directory by remember { graph.store.observeDirectory() }.collectAsStateWithLifecycle(emptyList())
    val titles = remember(directory) { directory.associate { it.id to it.title.ifBlank { Items.UNTITLED } } }
    // Read again each time the tab shows, with the title as the phone has it (LK6).
    LaunchedEffect(Unit) { note.backlinks.load(note.editor.title) }
    // Its tags as Room has them, frontmatter and inline (A656): the inline ones listed apart (A502).
    val allTags by remember(noteId) { graph.store.observeTagsOf(noteId) }.collectAsStateWithLifecycle(emptyList())
    val tags = note.tags
    val info = note.info
    // AI Descriptions (PEN-161): where the note's setting comes from, read again as it changes.
    var aiEffective by remember(noteId) { mutableStateOf<app.penmoss.engine.api.AiNoteStatus?>(null) }
    var describing by remember(noteId) { mutableStateOf(false) }
    var describeSaid by remember(noteId) { mutableStateOf<String?>(null) }
    val describeScope = rememberCoroutineScope()
    LaunchedEffect(noteId, info?.ai, info?.description) {
        aiEffective = runCatching { graph.api.aiNote(noteId) }.getOrNull()
    }
    InfoSheet(
        noteId = noteId,
        rows = infoRows(note.crumbs.map { it.name }, info, note.placed?.updatedAt, saved = note.noteSync, counts = note.counts),
        kind = infoKind(info),
        tags = tags,
        inline = remember(allTags, tags) { inlineTags(allTags, tags) },
        canTag = note.ready,
        fields = info?.fields,
        description = info?.let { known ->
            val settings by graph.device.settings.collectAsStateWithLifecycle()
            val key by graph.device.aiDescriptions.key.collectAsStateWithLifecycle()
            DescriptionUi(
                text = known.description,
                by = known.descriptionBy,
                ai = known.ai,
                asks = known.descriptionAsks,
                ready = key.saved && !key.refused && graph.device.aiDescriptions.provider == app.penmoss.ai.AiKeys.ANTHROPIC,
                global = (settings.settings.values[app.penmoss.ai.AiKeys.GLOBAL] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true",
                editable = note.ready && !note.editor.readOnly,
                onText = { note.controller.setDescription(it) },
                onAi = { note.controller.setAiDescription(it) },
                onAnswer = { keep -> note.controller.answerDescription(keep) },
                effective = aiEffective,
                describing = describing,
                said = describeSaid,
                onDescribeNow = {
                    describeScope.launch {
                        describing = true
                        describeSaid = null
                        val answer = runCatching { graph.api.describeNow(noteId) }.getOrNull()
                        describing = false
                        describeSaid = when {
                            answer == null -> "Couldn’t reach the notebook. Try again."
                            answer.ok -> "Described just now"
                            else -> answer.message ?: "The description failed."
                        }
                    }
                },
            )
        },
        backlinks = backlinksUi,
        titleOf = { titles[it] },
        onTags = { note.tagging = true },
        onOpen = { id ->
            note.closePanel()
            onOpenNote(id)
        },
        onDismiss = note::closePanel,
        embedded = true,
    )
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
                        style = MaterialTheme.roles.meta,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

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
        TipIconButton(Icons.Default.MoreVert, "Note Actions", onClick = trackedClick("note.actions.open") { onOpen(true) }, modifier = Modifier.testTag("noteMore"))
        DropdownMenu(expanded = open, onDismissRequest = { onOpen(false) }) {
            val close = { onOpen(false) }
            NoteMenuItem("View Metadata", "noteMetadata", true, close, event = "note.menu.metadata") { onPanel(PanelTab.METADATA) }
            DropdownMenuItem(
                text = { Text("Comments") },
                trailingIcon = { if (openComments != null && openComments > 0) Text(openComments.toString()) },
                onClick = trackedClick("note.menu.comments") {
                    onOpen(false)
                    onPanel(PanelTab.COMMENTS)
                },
                modifier = Modifier.testTag("noteComments"),
            )
            NoteMenuItem("Version History", "noteHistory", ready, close, event = "note.menu.history") { onPanel(PanelTab.HISTORY) }
            NoteMenuItem("Local Graph", "noteLocalGraph", true, close, event = "note.menu.local-graph") { onPanel(PanelTab.GRAPH) }
            // Markdown Source, as the web names it, ticked while it shows (a second tap shows the note).
            DropdownMenuItem(
                text = { Text("Markdown Source") },
                enabled = ready,
                trailingIcon = { if (source) Icon(Icons.Default.Check, contentDescription = null) },
                onClick = trackedClick("note.menu.source") {
                    onOpen(false)
                    onSource(!source)
                },
                modifier = Modifier.testTag("noteSource").semantics {
                    role = Role.Checkbox
                    selected = source
                },
            )
            HorizontalDivider()
            NoteMenuItem("Copy Note as Markdown", "noteCopyMarkdown", ready, close, event = "note.menu.copy-markdown") { onCopy(CopyFormat.MARKDOWN) }
            NoteMenuItem("Copy Note as Rich Text", "noteCopyRich", ready, close, event = "note.menu.copy-rich") { onCopy(CopyFormat.RICH) }
            if (onCopyAgentReference != null) {
                NoteMenuItem("Copy Agent Reference", "noteCopyAgentReference", true, close, event = "note.menu.copy-agent-reference", action = onCopyAgentReference)
            }
            HorizontalDivider()
            NoteMenuItem("Find in Note", "noteFind", ready, close, event = "note.menu.find", action = onFind)
            NoteMenuItem("Word Count", "noteWordCount", ready, close, event = "note.menu.word-count", action = onCount)
            HorizontalDivider()
            if (pinned != null) {
                NoteMenuItem(
                    if (pinned) "Unpin from Quick Access" else "Pin to Quick Access",
                    "notePin",
                    true,
                    close,
                    event = if (pinned) "note.menu.quick-access.unpin" else "note.menu.quick-access.pin",
                    action = onPin,
                )
            }
            NoteMenuItem("Move to Folder…", "noteMove", canMove, close, event = "note.menu.move", action = onMove)
            NoteMenuItem("Move to Trash", "noteTrash", ready, close, event = "note.menu.trash", action = onTrash)
        }
    }
}

/** One item of the note's ⋮ menu: it closes the menu, then does [action], counted as [event]. */
@Composable
private fun NoteMenuItem(label: String, tag: String, enabled: Boolean, close: () -> Unit, event: String, action: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label) },
        enabled = enabled,
        onClick = trackedClick(event) {
            close()
            action()
        },
        modifier = Modifier.testTag(tag),
    )
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
        IconButton(onClick = trackedClick("note.status.save-status", onClick), modifier = Modifier.testTag("noteSync")) {
            Icon(
                icon,
                contentDescription = "Sync: ${sync.label}",
                tint = if (alarming) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** What the sync icon means, with a way to the notebook's Sync tab, and Retry for failed pictures (PL10, AC8). */
@Composable
internal fun NoteSyncExplanation(sync: NoteSync, onSyncStorage: () -> Unit, onRetryPictures: () -> Unit, onDismiss: () -> Unit) {
    val failed = sync.state == NoteSyncState.PICTURES_FAILED
    val tracked = rememberTrackedDialog("noteSync")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(sync.label) },
        text = { Text(sync.explanation, Modifier.testTag("noteSyncExplanation")) },
        confirmButton = {
            if (failed) {
                TextButton(onClick = trackedClick("note.status.retry-pictures", tracked.done {
                    onDismiss()
                    onRetryPictures()
                }), modifier = Modifier.testTag("retryNotePictures")) { Text("Retry") }
            } else {
                TextButton(onClick = trackedClick("dialog.close", onDismiss)) { Text("OK") }
            }
        },
        dismissButton = {
            TextButton(onClick = trackedClick("note.status.notebook-sync", tracked.done {
                onDismiss()
                onSyncStorage()
            }), modifier = Modifier.testTag("openSyncStorage")) { Text("Notebook Sync") }
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
                style = MaterialTheme.roles.body,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = trackedClick("note.copy-notice.dismiss", onDismiss), modifier = Modifier.testTag("dismissCopyNotice")) { Text("Dismiss") }
                TextButton(onClick = trackedClick("note.copy-notice.open", onOpen), modifier = Modifier.testTag("openCopy")) { Text("Open the Copy") }
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
                onClick = trackedClick("journal.period-nav.previous") { onOpenPeriodic(kind, nav.prev.date) },
                modifier = Modifier.testTag("periodPrev").semantics { contentDescription = nav.prev.full },
            ) { Text(nav.prev.label, maxLines = 1) }
            Text(
                nav.label,
                Modifier.weight(1f).testTag("periodLabel"),
                textAlign = TextAlign.Center,
                style = MaterialTheme.roles.item,
                maxLines = 1,
            )
            TextButton(
                onClick = trackedClick("journal.period-nav.next") { onOpenPeriodic(kind, nav.next.date) },
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
                    PeriodChip(week, held = week.period in marks.weeks, tag = "periodWeek", event = "journal.period-nav.week") {
                        onOpenPeriodic(ToEditor.PeriodKind.WEEKLY, week.date)
                    }
                }
                days?.forEach { day ->
                    PeriodChip(day, held = day.period in marks.days, tag = "periodDay-${day.date}", event = "journal.period-nav.day") {
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
private fun PeriodChip(target: FromEditor.NavTarget, held: Boolean, tag: String, event: String, onClick: () -> Unit) {
    AssistChip(
        onClick = trackedClick(event, onClick),
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
