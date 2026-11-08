package app.penmoss.editor

import android.util.Log
import androidx.annotation.VisibleForTesting
import app.penmoss.data.FoldStore
import app.penmoss.data.NoteStore
import app.penmoss.data.PictureRefused
import app.penmoss.data.PictureStore
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.CommentFromEditor
import app.penmoss.engine.bridge.FormatCommand
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ParityFromEditor
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.sync.NoteSync
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

data class EditorUiState(
    val phase: Phase = Phase.LOADING,
    val title: String = "",
    val message: String? = null,
    /** The note holds content this version cannot edit (A158): shown read-only. */
    val readOnly: Boolean = false,
    /** The note is not on the phone and could not be fetched: the screen offers Try again (T39). */
    val canRetry: Boolean = false,
) {
    enum class Phase { LOADING, READY, UNAVAILABLE, GONE }
}

/** What the formatting bar shows (A301), as the page last reported it. */
data class FormatState(
    val active: Set<FormatCommand> = emptySet(),
    val canUndo: Boolean = false,
    val canRedo: Boolean = false,
    val canIndent: Boolean = false,
    val canOutdent: Boolean = false,
    val href: String? = null,
    /** A menu of the editor's is open: Back closes it first (A302). */
    val menu: Boolean = false,
    /** The caret is in a table: the bar shows its cell, row and column buttons (T40 P8, ED6). */
    val inTable: Boolean = false,
    /** The caret is in a code block: Indent and Outdent indent its lines (ED7). */
    val inCode: Boolean = false,
    /** What the Block menu can do with the block holding the caret (ED5). */
    val canMoveUp: Boolean = false,
    val canMoveDown: Boolean = false,
    val canTurnInto: Boolean = false,
    /** The caret is in the title: the bar goes, since its buttons act on the text (T39 pass 3, A554). */
    val inTitle: Boolean = false,
    /** The symbol slots every selected line has (T44, A747), ticked in the symbol sheet. */
    val symbols: Set<Int> = emptySet(),
    /** A selected line may carry a symbol: the bar's Symbol button works. */
    val canSymbol: Boolean = false,
)

/** A note to make on this phone as it opens (T38): New note, filed in [folderId] (null: the top level). */
data class NewNoteRequest(val folderId: String?)

/**
 * A daily or weekly note to make on this phone as it opens (T40 P5): Today, This week, the
 * Journal calendar and the period row all open one. [day] is an explicit calendar day, or null
 * for today in the synced time zone setting (never the phone's zone); the page resolves the
 * period and answers with the note, which the app stores and files through the daily intent.
 */
data class PeriodicNoteRequest(val kind: ToEditor.PeriodKind, val day: String?)

/**
 * One open note (T32, A282): it hands the editor page the note's stored
 * updates, stores every edit the page makes as pending and has it synced,
 * and passes what the server sends back to the page. Kotlin moves the bytes;
 * the page's Yjs document is the only thing that reads them.
 */
class NoteEditorController(
    val noteId: String,
    private val store: NoteStore,
    private val sync: NoteSync,
    private val scope: CoroutineScope,
    /** Posts one JSON message to the page. */
    private val send: (String) -> Unit,
    private val onOpenNote: (String) -> Unit,
    private val pollMs: Long = POLL_MS,
    /** Where pasted and picked pictures are stored (A304); without it, they are refused. */
    private val pictures: PictureStore? = null,
    /** Told which copies of the note this editor may still send edits of (A309). */
    private val openEditors: OpenEditors? = null,
    /**
     * New note (T38): the page makes the note with this id when the phone does not hold it yet,
     * offline too, and the app stores it to upload and file in the folder asked for.
     */
    private val create: NewNoteRequest? = null,
    /** A note [create] asked for was stored: sync soon, so it is filed where it belongs. */
    private val onCreated: () -> Unit = {},
    /**
     * A daily or weekly note (T40 P5): the page makes it with the synced time zone and
     * template when the phone does not hold it yet, offline too, and the app stores it to
     * upload and file through the daily intent. A note held already is just opened.
     */
    private val periodic: PeriodicNoteRequest? = null,
    /** The note [periodic] asked for is stored (or was held): open it. */
    private val onPeriodicMade: (id: String) -> Unit = {},
    /** The page reported an error: kept for feedback's Recent errors (T49, A791). */
    private val onPageError: (String) -> Unit = {},
    /** Where the note's toggles are kept on this phone (T40 P8, ED8). */
    folds: FoldStore? = null,
    /** Where files dropped, pasted or picked are kept (T40 P8, ED12); without it, they are refused. */
    files: app.penmoss.data.FileStore? = null,
    /** How pictures from web addresses show in a note opened now (ED13); null: not at all. */
    webPictures: (() -> app.penmoss.engine.bridge.WebPictureMode)? = null,
    /**
     * A link followed to a heading (`[[Note#Heading]]`, T40 P7, LK3): the note and the heading,
     * or null for the note's top. Without it, links open by [onOpenNote].
     */
    private val onOpenAt: ((noteId: String, heading: String?) -> Unit)? = null,
    /** The heading this screen opens the note at (T40 P7, LK3): scrolled to once it shows. */
    private val heading: String? = null,
    /** A `#tag` in the note was tapped while reading, or Ctrl-tapped (T40 P6, TG5): its notes. */
    private val onOpenTag: (String) -> Unit = {},
    /**
     * How long Today or This week waits for the page to make the note before saying it could
     * not (T40 P9 review S8): a page that cannot read the request cannot name it in its error.
     */
    private val periodicWaitMs: Long = PERIODIC_WAIT_MS,
    /**
     * A thread was sent to an agent session (T60, A1078), and the page's update for it is stored:
     * the notebook syncs now, skipping the push delay.
     */
    private val onCommentSent: () -> Unit = {},
) {
    private val _state = MutableStateFlow(EditorUiState())
    val state: StateFlow<EditorUiState> = _state.asStateFlow()

    private val _format = MutableStateFlow(FormatState())

    /** What the formatting bar shows (A301). */
    val format: StateFlow<FormatState> = _format.asStateFlow()

    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Short messages for the person: a picture that could not be added, a link refused. */
    val notices: SharedFlow<String> = _notices.asSharedFlow()

    /** Copy, paste as plain text, the source, the + sheet, the Block menu, folds, counts (T40 P8). */
    val tools = NoteTools(noteId, send, scope, folds, showing = { opened }, notify = { _notices.tryEmit(it) })

    /** Files through the app and pictures from web addresses (T40 P8, ED12, ED13). */
    val files = NoteFiles(
        noteId,
        send,
        scope,
        files,
        webPictures,
        // As for pictures: not while reloading, or reopening on a restored copy.
        showing = { opened && openEpochs.isEmpty() },
        notify = { _notices.tryEmit(it) },
    )

    /** The note's comment threads (T48): the Comments sheet's list, and its changes, through the page. */
    val comments = NoteComments(noteId, send, showing = { opened }, notify = { _notices.tryEmit(it) }, onSent = { commentSent() })

    /**
     * Send to… (T60, A1078): the page posted the thread's update before `commentSent`, so it is
     * being stored now; the sync waits for that (at most [CLOSE_TIMEOUT_MS]), then goes.
     */
    private fun commentSent() {
        scope.launch {
            withTimeoutOrNull(CLOSE_TIMEOUT_MS) {
                while (storing.isNotEmpty()) delay(FLUSH_QUIET_MS)
            }
            onCommentSent()
        }
    }

    private val _tags = MutableStateFlow<List<String>?>(null)

    /** Tags sent to the page to add, until it says the note has them. */
    private val adding: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /**
     * The note's frontmatter tags as the page reads them (T38), sorted; null until it has said.
     * Inline `#tags` stay in the text, as on the web (A188).
     */
    val tags: StateFlow<List<String>?> = _tags.asStateFlow()

    /** The page is to make the note (T38): asked once it is ready, and again if it reloads first. */
    private var awaitingCreate = false

    /** The page is to make the period's note (T40 P5): asked once it is ready, and again if it reloads first. */
    private var awaitingPeriodic = false

    /** The synced settings a periodic note is made with (T40 P5): read once, when asked. */
    private var periodicSettings: NoteStore.SettingsState? = null

    private val _periodicNav = MutableStateFlow<FromEditor.PeriodicNavData?>(null)

    /** The open note's period and neighbours, for the row under its top bar (T40 P5, JR4). */
    val periodicNav: StateFlow<FromEditor.PeriodicNavData?> = _periodicNav.asStateFlow()

    /** The tag of the `createPeriodic` asked last (T40 P9, P5 review N7): only its error ends the wait. */
    private var periodicRequest: String? = null
    private var periodicRequests = 0

    /** The key bindings and app commands the page dispatches (T40 P9, A493); sent again to a reloaded page. */
    private var keys: ToEditor.Keys? = null

    /**
     * One of the app's commands, from a key the page's dispatcher took (T40 P9, PL9, A493): only
     * ids sent in [keys] reach it; the screen runs its own handler for the id, or nothing.
     */
    var onCommand: (String) -> Unit = {}

    /** The period row was asked of the page: asked once, since a note's period never changes. */
    private var navAsked = false

    private val _info = MutableStateFlow<FromEditor.NoteInfo?>(null)

    /**
     * The open note's details for the Info sheet as the page reads them (T40 P7, NT23): when it
     * was made, its kind and period, its frontmatter, and the notes it links to. Null until said.
     */
    val info: StateFlow<FromEditor.NoteInfo?> = _info.asStateFlow()

    /** The heading asked for was scrolled to (once: a reopen after a restore keeps the place). */
    private var headingShown = false

    /** A picture's message, waiting for its bytes, which come next (A304). */
    private var awaitingBytes: FromEditor.Attachment? = null

    private var pageReady = false
    private var contentReady = false
    private var opened = false
    private var openStarted = false

    /** Between reading the stored content and sending it: exchanges meanwhile are held (S7). */
    private var opening = false

    /** For tests: an open has read, or is reading, the stored note and not sent it yet. */
    @VisibleForTesting
    val isOpening: Boolean get() = opening

    /** For tests: the phone holds the note, so it opens as soon as the page is ready. */
    @VisibleForTesting
    val isContentReady: Boolean get() = contentReady
    private val heldRemotes = mutableListOf<String>()
    private var resetWhileOpening = false

    /** The epoch of each `open` sent, until the page says `opened` (A291). */
    private val openEpochs = ArrayDeque<String?>()

    /** The epoch of the copy the page is editing: its edits are stored against it. */
    private var editorEpoch: String? = null
    /** Edits being stored, by the epoch they are stored against (A309). */
    private val storing = mutableMapOf<String?, Int>()

    /** Pictures picked while the page was not showing the note: inserted once it is. */
    private val waitingPictures = mutableListOf<String>()
    private var pageAlive = false
    private var compacting = false
    private var compactRequested = false
    private var closing: CompletableDeferred<Unit>? = null
    private val jobs = mutableListOf<Job>()

    /** The note is not on the phone and could not be fetched: [retry] (or sync bringing it) opens it. */
    private var missing = false

    init {
        jobs += scope.launch { load() }
        jobs += scope.launch {
            sync.exchanges.filter { it.noteId == noteId }.collect(::onExchange)
        }
        // Other devices' changes while the note is open (no WebSocket on Android yet, A286), only
        // while the app is in front (A327). Left in the background with the note on screen, the
        // background runs bring them, through the same feed.
        jobs += scope.launch {
            while (true) {
                delay(pollMs)
                if (!sync.foreground.value) {
                    // Coming back to the front syncs everything anyway: the next check is a period later.
                    sync.foreground.first { it }
                    continue
                }
                if (opened) sync.refreshNote(noteId)
            }
        }
    }

    /** Reads the note, fetching it when the phone does not hold it, and opens it once the page is ready. */
    private suspend fun load() {
        store.note(noteId)?.title?.let { title -> _state.update { it.copy(title = title) } }
        // The period's note: made by the page with the synced time zone and template (T40 P5),
        // offline too; a note held already is just opened (the page rebuilds the same bytes).
        if (periodic != null) {
            awaitingPeriodic = true
            if (pageReady) requestPeriodicSoon()
            return
        }
        // New note: made by the page, offline too, unless an earlier start already stored it.
        if (create != null && !store.holds(noteId)) {
            awaitingCreate = true
            if (pageReady) requestCreate()
            return
        }
        if (!store.holds(noteId)) sync.syncNote(noteId)
        if (!store.holds(noteId)) {
            val gone = store.note(noteId)?.gone == true
            missing = !gone
            _state.value = EditorUiState(
                if (gone) EditorUiState.Phase.GONE else EditorUiState.Phase.UNAVAILABLE,
                _state.value.title,
                if (gone) GONE_MESSAGE else MISSING_MESSAGE,
                canRetry = !gone,
            )
            return
        }
        contentReady = true
        openIfReady()
    }

    /**
     * Tries again to fetch a note the phone did not hold (T39): back online, the screen opens
     * it without leaving. Does nothing unless the note was missing.
     */
    fun retry() {
        if (!missing) return
        missing = false
        _state.update { it.copy(phase = EditorUiState.Phase.LOADING, message = null, canRetry = false) }
        jobs += scope.launch { load() }
    }

    /** A message from the page. */
    fun onPageMessage(raw: String) {
        val message = BridgeProtocol.decodeFromEditor(raw)
        if (message == null) {
            Log.w(TAG, "Unreadable message from the editor page")
            return
        }
        when (message) {
            // The note screen keeps the lightbox's state itself (T51, A948).
            is FromEditor.Lightbox -> Unit
            FromEditor.Ready -> {
                // A page says `ready` once, so a second one is a new page (reloaded) that holds
                // nothing: it gets the note again (T39 review), and opens sent to the page before
                // it will never be answered.
                val again = openStarted
                if (again) {
                    openEpochs.clear()
                    publishHeld()
                    tools.pageReloaded()
                    comments.pageReloaded()
                }
                pageReady = true
                pageAlive = true
                keys?.let { send(BridgeProtocol.encode(it)) }
                if (awaitingCreate) requestCreate()
                if (awaitingPeriodic) requestPeriodicSoon()
                openIfReady(again)
            }
            is FromEditor.Created -> if (message.noteId == noteId && awaitingCreate && create != null) {
                awaitingCreate = false
                scope.launch {
                    // Stored once whatever happens to the page; a note stored already is left as it is.
                    if (store.addLocalNote(message.note, create.folderId)) {
                        sync.noteEdited(noteId)
                        onCreated()
                    } else if (!store.holds(noteId)) {
                        // A row with no content under this id (a note deleted for good, its edits
                        // kept apart): never opened as an empty document with no identity.
                        _state.update { it.copy(phase = EditorUiState.Phase.UNAVAILABLE, message = "The note could not be made.") }
                        return@launch
                    }
                    contentReady = true
                    openIfReady()
                }
            }
            is FromEditor.CreatedPeriodic -> if (awaitingPeriodic && periodic != null) {
                awaitingPeriodic = false
                scope.launch {
                    // Stored once whatever happens to the page; a note stored already is left as
                    // it is (Today twice offline makes one note). Either way it opens now.
                    val made = store.addPeriodicNote(
                        message.note,
                        message.kind.wire,
                        message.period,
                        message.kind.wire,
                        message.date,
                    )
                    if (made) sync.noteEdited(message.note.id)
                    onPeriodicMade(message.note.id)
                }
            }
            is FromEditor.Tags -> if (message.noteId == noteId) {
                _tags.value = message.tags
                // A tag added here joins the suggestions once the page has set it (not if it refused).
                val set = adding.filter { it in message.tags }
                if (set.isNotEmpty()) {
                    adding.removeAll(set.toSet())
                    scope.launch { set.forEach { store.rememberTag(it) } }
                }
            }
            // This phone's own text for the offline index (T40 P6, FD4), found before it uploads.
            is FromEditor.Text -> if (message.noteId == noteId) {
                scope.launch { store.savePageText(noteId, message.text, message.headings, message.tags) }
            }
            is FromEditor.Opened -> if (message.noteId == noteId) {
                // Edits from here on are made on the copy this open sent. Any the page sent
                // before (its last edits of a copy a restore replaced) kept the old epoch.
                if (openEpochs.isNotEmpty()) editorEpoch = openEpochs.removeFirst()
                compacting = false
                publishHeld()
                _state.update { it.copy(phase = EditorUiState.Phase.READY, title = message.title) }
                if (waitingPictures.isNotEmpty()) {
                    send(BridgeProtocol.encode(ToEditor.InsertImages(noteId, waitingPictures.toList())))
                    waitingPictures.clear()
                }
                files.opened()
                scope.launch {
                    message.compacted?.let { store.compact(noteId, it, UpdateEntity.SYNCED) }
                    message.compactedPending?.let { store.compact(noteId, it, UpdateEntity.PENDING) }
                }
                // What period the open note is, for the row under its top bar (T40 P5, JR4).
                requestPeriodicNav()
                // A link to a heading opened this screen (T40 P7, LK3): the page scrolls to it.
                if (heading != null && !headingShown) {
                    headingShown = true
                    send(BridgeProtocol.encode(ToEditor.ShowHeading(noteId, heading)))
                }
            }
            is FromEditor.NoteInfo -> if (message.noteId == noteId) {
                _info.value = message
                // The phone's own links show in backlinks before the server indexes them (A473).
                scope.launch { store.setOwnLinks(noteId, message.links) }
            }
            is FromEditor.PeriodicNav -> if (message.noteId == noteId) {
                _periodicNav.value = message.nav
            }
            is FromEditor.Update -> if (message.noteId == noteId) {
                val epoch = editorEpoch
                // Held until stored: a copy of the edits kept apart from this copy waits for it.
                storing[epoch] = (storing[epoch] ?: 0) + 1
                publishHeld()
                scope.launch {
                    try {
                        store.addPending(noteId, message.update, epoch)
                    } finally {
                        val left = (storing[epoch] ?: 1) - 1
                        if (left == 0) storing.remove(epoch) else storing[epoch] = left
                        publishHeld()
                    }
                    sync.noteEdited(noteId)
                    compactIfLong()
                }
            }
            is FromEditor.Merged -> if (message.noteId == noteId) {
                scope.launch {
                    store.compact(noteId, message.compacted, UpdateEntity.PENDING)
                    compacting = false
                }
            }
            is FromEditor.Title -> if (message.noteId == noteId) {
                _state.update { it.copy(title = message.title) }
                scope.launch { store.setLocalTitle(noteId, message.title) }
            }
            is FromEditor.Unsupported -> _state.update {
                it.copy(readOnly = true, message = "This note has content a newer Penmoss wrote; it shows read-only.")
            }
            is FromEditor.OpenNote -> when {
                // A link into this note (T40 P7 review S4): scroll, as the web's NoteView does,
                // rather than a second screen of the same note.
                message.noteId == noteId -> message.heading?.let { send(BridgeProtocol.encode(ToEditor.ShowHeading(noteId, it))) }
                else -> onOpenAt?.invoke(message.noteId, message.heading) ?: onOpenNote(message.noteId)
            }
            is FromEditor.OpenTag -> if (message.noteId == noteId) onOpenTag(message.tag)
            is FromEditor.Closed -> if (message.noteId == noteId) closing?.complete(Unit)
            is FromEditor.State -> if (message.noteId == noteId) {
                _format.value = FormatState(
                    message.active.toSet(),
                    message.canUndo,
                    message.canRedo,
                    message.canIndent,
                    message.canOutdent,
                    message.href,
                    message.menu,
                    message.inTable,
                    message.inCode,
                    message.canMoveUp,
                    message.canMoveDown,
                    message.canTurnInto,
                    message.inTitle,
                    message.symbols.toSet(),
                    message.canSymbol,
                )
            }
            is FromEditor.Attachment -> if (message.noteId == noteId) {
                awaitingBytes = message
                files.pictureMessage()
            }
            is FromEditor.NewNote -> if (message.noteId == noteId) {
                scope.launch {
                    // Filed beside the note its link is in, as the web app does (T16); where that
                    // one will be filed, when it was made here too and is not filed yet.
                    val source = store.note(noteId)
                    val folder = source?.folderId ?: source?.fileIn?.takeIf { source.toFile }
                    if (store.addLocalNote(message.note, folder)) sync.noteEdited(message.note.id)
                }
            }
            is FromEditor.Notice -> if (message.noteId == noteId) _notices.tryEmit(message.message)
            // A key for one of the app's commands (T40 P9): only those the screen said it runs.
            is FromEditor.Command -> if (keys?.app?.contains(message.id) == true && (message.noteId == null || message.noteId == noteId)) {
                onCommand(message.id)
            }
            // Conflict copies are made for the app as a whole (EditorPageServices), and other
            // notes' content for links and embeds by LinkedNotes (T40 P7).
            is FromEditor.ConflictCopy, is FromEditor.CopyFailed -> Unit
            is ParityFromEditor.File -> {
                if (message.noteId == noteId) awaitingBytes = null
                files.onMessage(message)
            }
            is ParityFromEditor.FileInfo, is ParityFromEditor.OpenFile -> files.onMessage(message)
            is ParityFromEditor -> tools.onMessage(message)
            is CommentFromEditor -> comments.onMessage(message)
            is FromEditor.NoteContent, is FromEditor.WatchNote -> Unit
            is FromEditor.Error -> {
                Log.w(TAG, "Editor page: ${message.message}")
                onPageError(message.message)
                // The period's note could not be made (T40 P5): say so instead of loading. Only the
                // error of the request asked last ends the wait; any other error leaves it waiting
                // (T40 P9, P5 review N7): the page answers each request, or says why it could not.
                if (awaitingPeriodic) {
                    if (message.request != null && message.request == periodicRequest) {
                        awaitingPeriodic = false
                        _state.update { it.copy(phase = EditorUiState.Phase.UNAVAILABLE, message = "The note could not be made.") }
                    }
                    return
                }
                if (message.noteId == noteId) {
                    when {
                        compacting -> compacting = false
                        // An open the page could not do: it never says `opened`, so its epoch
                        // must not be taken for the next one's.
                        openEpochs.isNotEmpty() -> {
                            openEpochs.removeFirst()
                            publishHeld()
                        }
                    }
                }
                if (!opened) {
                    _state.update { it.copy(phase = EditorUiState.Phase.UNAVAILABLE, message = "The note could not be opened.") }
                }
            }
        }
    }

    /**
     * A picture's bytes from the page (A304): those of the `attachment` message just before,
     * stored if they are what its path names, and uploaded when the phone can.
     */
    fun onPageBytes(bytes: ByteArray) {
        if (files.onBytes(bytes)) return
        val picture = awaitingBytes ?: return
        awaitingBytes = null
        val store = pictures
        if (bytes.size.toLong() != picture.size || store == null) {
            stored(picture.path, ok = false)
            return
        }
        scope.launch {
            // The page inserts the picture only once it is stored here (A311).
            val path = try {
                store.addFromPage(picture.path, bytes, noteId)
            } catch (error: java.io.IOException) {
                null
            }
            stored(picture.path, ok = path != null)
        }
    }

    private fun stored(path: String, ok: Boolean) {
        send(BridgeProtocol.encode(ToEditor.AttachmentStored(noteId, path, ok)))
    }

    /** A button of the formatting bar (A301). */
    fun format(command: FormatCommand, href: String? = null) {
        if (!opened) return
        val link = if (command == FormatCommand.LINK) href.orEmpty() else null
        send(BridgeProtocol.encode(ToEditor.Format(noteId, command, link)))
    }

    /** The symbol sheet (T44, A747): toggle symbol [index] on the selected lines, one undo step. */
    fun toggleSymbol(index: Int) {
        if (opened) send(BridgeProtocol.encode(ToEditor.Symbol(noteId, index)))
    }

    /** Back with one of the editor's menus open: close the menu (A302). */
    fun dismissMenu() {
        if (opened) send(BridgeProtocol.encode(ToEditor.Dismiss(noteId)))
    }

    /** The note takes the focus back after a native dialog. */
    fun refocus() {
        if (opened) send(BridgeProtocol.encode(ToEditor.Focus(noteId)))
    }

    /** Rename from a list (T40 P4, NT10): the caret goes in the note's title. */
    fun focusTitle() {
        if (opened) send(BridgeProtocol.encode(ToEditor.FocusTitle(noteId)))
    }

    /**
     * Pictures from the photo picker (A304): stored on the phone first, then inserted at the
     * selection, so a note written offline keeps them and they upload later.
     */
    suspend fun insertPictures(pictures: List<ByteArray>) {
        val store = this.pictures ?: return
        val paths = mutableListOf<String>()
        for (bytes in pictures) {
            try {
                paths += store.add(bytes, noteId)
            } catch (refused: PictureRefused) {
                _notices.tryEmit(refused.message ?: "The picture could not be added.")
            } catch (error: java.io.IOException) {
                _notices.tryEmit("The picture could not be stored on this phone.")
            }
        }
        if (paths.isEmpty()) return
        // Not showing the note (reloading, or reopening on a restored copy): inserted once it is.
        if (opened && openEpochs.isEmpty()) send(BridgeProtocol.encode(ToEditor.InsertImages(noteId, paths)))
        else waitingPictures += paths
    }

    /**
     * Adds ([on]) or removes a frontmatter tag (T38). The page changes the note's document, as
     * the web's tag chips do, and the change is stored and synced as any edit is, offline too.
     * Not sent while the note is still opening, nor when it is read-only.
     */
    fun setTag(tag: String, on: Boolean): TagChange {
        val current = _state.value
        if (current.readOnly) return TagChange.READ_ONLY
        if (!opened || current.phase != EditorUiState.Phase.READY) return TagChange.OPENING
        if (on) adding += tag else adding -= tag
        send(BridgeProtocol.encode(ToEditor.SetTag(noteId, tag, on)))
        return TagChange.SENT
    }

    /** What [setTag] did. */
    enum class TagChange { SENT, OPENING, READ_ONLY }

    /** Tells the person something about the note (a picture the phone could not read). */
    fun notify(message: String) {
        _notices.tryEmit(message)
    }

    /** The app is pausing: have the page send the edits it is batching. */
    fun flush() {
        if (opened) send(BridgeProtocol.encode(ToEditor.Flush(noteId)))
    }

    /**
     * Flushes the page's batched edits and waits until they are stored (T40 P3b, NT18–NT20):
     * history actions (restore, revert, save now) must include the phone's last edits. The page
     * posts no ack for a flush, so quiescence ends the wait: nothing being stored for several
     * checks in a row, at most a second, as [close]'s wait. The first quiet check sends `Flush`
     * again, so a page that had not answered the first one yet still lands its Update before the
     * wait ends (T40 P3b fixup). A page slower than the whole streak (about 250 ms) still beats
     * the wait: its edits then land as a follow-up change on the next pass, never lost.
     */
    suspend fun flushAndWait() {
        if (!opened) return
        send(BridgeProtocol.encode(ToEditor.Flush(noteId)))
        withTimeoutOrNull(CLOSE_TIMEOUT_MS) {
            var quiet = 0
            var reflushed = false
            while (quiet < FLUSH_QUIET_CHECKS) {
                delay(FLUSH_QUIET_MS)
                if (storing.isNotEmpty()) {
                    quiet = 0
                    reflushed = false
                } else if (!reflushed) {
                    send(BridgeProtocol.encode(ToEditor.Flush(noteId)))
                    reflushed = true
                    quiet++
                } else {
                    quiet++
                }
            }
        }
    }

    /**
     * Closes the note: the page sends its last edits and says `closed`, waited
     * for (up to a second) so they are stored before the WebView goes away.
     */
    suspend fun close() {
        if (opened) {
            val done = CompletableDeferred<Unit>()
            closing = done
            send(BridgeProtocol.encode(ToEditor.Close(noteId)))
            withTimeoutOrNull(CLOSE_TIMEOUT_MS) { done.await() }
        }
        opened = false
        pageAlive = false
        jobs.forEach { it.cancel() }
        publishHeld()
    }

    /** The editor's renderer crashed or was killed: the stored edits are safe; the page is not. */
    fun pageGone() {
        opened = false
        pageReady = false
        pageAlive = false
        openEpochs.clear()
        publishHeld()
        _state.value = EditorUiState(
            EditorUiState.Phase.UNAVAILABLE,
            _state.value.title,
            "The editor stopped. Go back and open the note again; your stored edits are kept.",
        )
    }

    /** Tells [OpenEditors] which copies this editor may still send edits of (A309). */
    private fun publishHeld() {
        val registry = openEditors ?: return
        val epochs = buildSet {
            addAll(storing.keys)
            if (pageAlive && (opened || openStarted)) {
                add(editorEpoch)
                addAll(openEpochs)
            }
        }
        registry.set(this, noteId, epochs)
    }

    /**
     * Offline typing piles up pending edits (one every couple of seconds): once there
     * are [COMPACT_AT], the page merges them into one (A289), so an upload stays short.
     */
    private suspend fun compactIfLong() {
        // An edit stored while another check runs asks that check to look again.
        compactRequested = true
        if (compacting || !opened) return
        // Claimed before the first suspension: one check, and one `compact`, at a time.
        compacting = true
        while (compactRequested) {
            compactRequested = false
            if (store.pendingCount(noteId) < COMPACT_AT) continue
            val pending = store.pending(noteId).filter { it.epoch == editorEpoch }
            if (pending.size >= COMPACT_AT) {
                // `compacting` stays set until the page answers.
                send(BridgeProtocol.encode(ToEditor.Compact(noteId, pending)))
                return
            }
        }
        compacting = false
    }

    private fun requestCreate() {
        jobs += scope.launch {
            // The note records the notebook of the folder it is made in (T43, A766).
            val notebook = store.notebookOfFolder(create?.folderId)
            send(BridgeProtocol.encode(ToEditor.Create(noteId, notebook)))
        }
    }

    /** Asks the page for the period's note with the synced time zone and template (T40 P5). */
    private fun requestPeriodicSoon() {
        jobs += scope.launch {
            val settings = periodicSettings ?: store.settingsNow().also { periodicSettings = it }
            requestPeriodic(settings)
        }
    }

    private fun requestPeriodic(state: NoteStore.SettingsState) {
        val request = periodic ?: return
        val templateKey = if (request.kind == ToEditor.PeriodKind.DAILY) {
            SettingKeys.DAILY_TEMPLATE
        } else {
            SettingKeys.WEEKLY_TEMPLATE
        }
        val tag = "p-${++periodicRequests}"
        periodicRequest = tag
        send(
            BridgeProtocol.encode(
                ToEditor.CreatePeriodic(
                    request.kind,
                    request.day,
                    System.currentTimeMillis(),
                    state.settings.timeZone,
                    state.settings.templateOrDefault(templateKey),
                    tag,
                ),
            ),
        )
        jobs += scope.launch {
            delay(periodicWaitMs)
            if (awaitingPeriodic && periodicRequest == tag) {
                awaitingPeriodic = false
                _state.update { it.copy(phase = EditorUiState.Phase.UNAVAILABLE, message = "The note could not be made.") }
            }
        }
    }

    /**
     * The user's key bindings and the commands this screen runs (T40 P9, A493), for the page's
     * dispatcher: sent now when the page is ready, again whenever they change and to a page that
     * reloads. Unchanged, nothing is sent.
     */
    fun keys(bindings: Map<String, List<String>>, app: List<String>) {
        val next = ToEditor.Keys(bindings, app.sorted())
        if (next == keys) return
        keys = next
        if (pageReady) send(BridgeProtocol.encode(next))
    }

    /** Asks the page what period the open note is, once: a note's period never changes (T40 P5). */
    private fun requestPeriodicNav() {
        if (navAsked) return
        navAsked = true
        send(BridgeProtocol.encode(ToEditor.PeriodicNav(noteId)))
    }

    /** Sends the note to the page once both are ready; `again` reopens it (after a restore). */
    private fun openIfReady(again: Boolean = false) {
        if (!pageReady || !contentReady || (openStarted && !again)) return
        if (opening) {
            // Already reading: open again with what is stored once this open is sent.
            resetWhileOpening = resetWhileOpening || again
            return
        }
        openStarted = true
        opening = true
        heldRemotes.clear()
        scope.launch {
            val content = store.editorContent(noteId)
            // Opened here: Recent and Ctrl+E rank it by this (T40 P6, FD7).
            store.markOpened(noteId)
            openEpochs.addLast(content.epoch)
            publishHeld()
            // Toggles open as this phone left them (T40 P8, ED8): the page reads them as it opens.
            tools.sendFolds()
            files.beforeOpen()
            // Where the phone sees it (T43, A766): a link's new note made in it records that notebook.
            val notebook = store.notebookOfNote(noteId)
            send(BridgeProtocol.encode(ToEditor.Open(noteId, content.synced, content.pending, editable = true, notebook = notebook)))
            // What the server sent while the content was read may not be in it: the page gets
            // it now. An update it already holds changes nothing (Yjs merges are idempotent).
            heldRemotes.forEach { send(BridgeProtocol.encode(ToEditor.Remote(noteId, it))) }
            heldRemotes.clear()
            opening = false
            opened = true
            if (resetWhileOpening) {
                resetWhileOpening = false
                openIfReady(again = true)
            }
        }
    }

    private fun onExchange(result: ExchangeResult) {
        when (result.kind) {
            ExchangeResult.Kind.APPLIED -> {
                // A pass brought the note this screen could not fetch: open it now (T39).
                if (missing) {
                    retry()
                    return
                }
                // A note opened before it had an epoch (made on this phone): its edits from
                // now on are of the copy the server just named, so a restore keeps them apart.
                if (editorEpoch == null && openEpochs.isEmpty() && opened && result.epoch != null) {
                    editorEpoch = result.epoch
                    publishHeld()
                }
                val update = result.append ?: return
                when {
                    opening -> heldRemotes += update
                    opened -> send(BridgeProtocol.encode(ToEditor.Remote(noteId, update)))
                }
            }
            // The server was restored (A5): the page reopens on its copy; this device's
            // edits since are kept apart, not merged.
            ExchangeResult.Kind.RESET -> {
                _state.update { it.copy(message = "Penmoss restored this note on the server; your recent edits here are kept apart.") }
                when {
                    opening -> {
                        heldRemotes.clear()
                        resetWhileOpening = true
                    }
                    opened -> openIfReady(again = true)
                }
            }
            ExchangeResult.Kind.GONE -> _state.value = EditorUiState(EditorUiState.Phase.GONE, _state.value.title, GONE_MESSAGE)
            ExchangeResult.Kind.RETRY -> Unit
        }
    }

    companion object {
        const val POLL_MS = 10_000L

        /** Far longer than the page takes to make a period's note, even on a slow phone. */
        const val PERIODIC_WAIT_MS = 20_000L
        const val CLOSE_TIMEOUT_MS = 1_000L

        /** Between quiescence checks while waiting for a flush to be stored. */
        const val FLUSH_QUIET_MS = 50L

        /** Consecutive quiet checks before the flush wait ends (about 250 ms; T40 P3b fixup). */
        const val FLUSH_QUIET_CHECKS = 5

        /** Pending edits of the open note before the page merges them (A289). */
        const val COMPACT_AT = 32
        private const val TAG = "PenmossEditor"
        private const val GONE_MESSAGE = "This note was deleted for good."
        private const val MISSING_MESSAGE = "This note isn't on the phone yet. Connect to the internet to open it."
    }
}
