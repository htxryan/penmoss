package app.penmoss.editor

import app.penmoss.data.FoldStore
import app.penmoss.engine.bridge.BlockAction
import app.penmoss.engine.bridge.BlockEntry
import app.penmoss.engine.bridge.BlockPurpose
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.CopyFormat
import app.penmoss.engine.bridge.CopyScope
import app.penmoss.engine.bridge.ParityFromEditor
import app.penmoss.engine.bridge.ParityToEditor
import app.penmoss.engine.bridge.TextCounts
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

/** The open note's counts (T41, A505; T40 P8, NT24), as the page last took them. */
data class NoteCounts(val words: Int, val characters: Int, val minutes: Int, val selection: TextCounts?) {
    /** `1,204 words · 6,780 characters · 5 min read`, as the web's status bar reads. */
    val label: String
        get() = listOfNotNull(wordsLabel(words), charactersLabel(characters), readingLabel(minutes)).joinToString(" · ")

    /** `2 words and 9 characters selected`, or null with nothing selected. */
    val selectionLabel: String?
        get() = selection?.let { "${wordsLabel(it.words)} and ${charactersLabel(it.characters)} selected" }

    companion object {
        private val number = NumberFormat.getIntegerInstance(Locale.ENGLISH)
        private fun plural(count: Int, one: String) = "${number.format(count)} ${if (count == 1) one else "${one}s"}"

        fun wordsLabel(count: Int) = plural(count, "word")

        fun charactersLabel(count: Int) = plural(count, "character")

        fun readingLabel(minutes: Int): String? = if (minutes == 0) null else "$minutes min read"
    }
}

/** The page's answer for the + sheet or Turn into: the entries for one search. */
data class BlockChoices(val purpose: BlockPurpose, val query: String, val items: List<BlockEntry>)

/**
 * The editor's parity with the web on the phone (T40 P8), for one open note: Copy as Markdown
 * and rich text (ED9), paste and match style (ED11), the Markdown source (ED17), the + sheet
 * and the Block menu (ED4, ED5), toggles kept in Room (ED8) and the counts (NT24). It sends the
 * page's messages and keeps what the page answers; [NoteEditorController] hands it the page's
 * messages and asks it for the note's toggles before each `open`.
 */
class NoteTools(
    private val noteId: String,
    private val send: (String) -> Unit,
    private val scope: CoroutineScope,
    /** Where toggles are kept; without it they are remembered until the note closes. */
    private val folds: FoldStore?,
    /** Whether the page shows the note now: nothing is sent before. */
    private val showing: () -> Boolean,
    private val notify: (String) -> Unit,
) {
    private val _clips = MutableSharedFlow<ParityFromEditor.Clipboard>(extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** What the page asked to put on the clipboard: the note screen writes it (ED9, ED7). */
    val clips: SharedFlow<ParityFromEditor.Clipboard> = _clips.asSharedFlow()

    private val _counts = MutableStateFlow<NoteCounts?>(null)

    /** The note's counts once typing pauses, and the selection's (NT24); null until the page says. */
    val counts: StateFlow<NoteCounts?> = _counts.asStateFlow()

    private val _choices = MutableStateFlow<BlockChoices?>(null)

    /** The page's latest answer for the + sheet or Turn into (ED4, ED5). */
    val choices: StateFlow<BlockChoices?> = _choices.asStateFlow()

    private val _source = MutableStateFlow(false)

    /** The Markdown source shows in place of the note (ED17). */
    val source: StateFlow<Boolean> = _source.asStateFlow()

    /** The toggles the page last reported: newer than Room's while a save is under way. */
    private var held: Map<String, Boolean>? = null

    /**
     * The newest toggles to keep (review S1). Each message carries every toggle, so only the
     * newest matters: one collector writes them in turn, and a newer set replaces a waiting one,
     * so an older set never lands after a newer.
     */
    private val toSave = MutableStateFlow<Map<String, Boolean>?>(null)

    private val _deleted = MutableSharedFlow<String>(extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** What Delete block removed ("List", "Table"): the note screen offers Undo (review S4). */
    val deleted: SharedFlow<String> = _deleted.asSharedFlow()

    init {
        if (folds != null) {
            scope.launch { toSave.filterNotNull().collect { folds.save(noteId, it) } }
        }
    }

    /** A message of these from the page. */
    fun onMessage(message: ParityFromEditor) {
        if (message.noteId != noteId) return
        when (message) {
            is ParityFromEditor.Clipboard -> _clips.tryEmit(message)
            is ParityFromEditor.Counts -> _counts.value = NoteCounts(message.words, message.characters, message.minutes, message.selection)
            is ParityFromEditor.Blocks -> _choices.value = BlockChoices(message.purpose, message.query, message.items)
            is ParityFromEditor.Folds -> {
                held = message.folds
                toSave.value = message.folds
            }
            // What shows, as the page says after each change (review S6).
            is ParityFromEditor.Source -> _source.value = message.on
            is ParityFromEditor.BlockDeleted -> _deleted.tryEmit(message.label)
            // Files are [NoteFiles]'.
            is ParityFromEditor.File, is ParityFromEditor.FileInfo, is ParityFromEditor.OpenFile -> Unit
        }
    }

    /** Sends the note's toggles as this phone left them: called right before each `open` (ED8). */
    suspend fun sendFolds() {
        val known = held ?: folds?.folds(noteId) ?: emptyMap()
        // None kept: the page opens every toggle as the note says, so there is nothing to send.
        if (known.isNotEmpty()) send(BridgeProtocol.encode(ParityToEditor.Folds(noteId, known)))
    }

    /** The page is new (reloaded): it shows the note, not its source. */
    fun pageReloaded() {
        _source.value = false
        _choices.value = null
    }

    /** Copy as Markdown or rich text (ED9): the note, or the selection. */
    fun copy(format: CopyFormat, what: CopyScope) {
        if (!showing()) return notify(OPENING)
        send(BridgeProtocol.encode(ParityToEditor.Copy(noteId, format, what)))
    }

    /**
     * Paste and match style (ED11): clipboard text as ⌘⇧V pastes it. Past the cap, the start of
     * it, never splitting a character, and the person is told (review S3).
     */
    fun pastePlain(text: String?) {
        if (text.isNullOrEmpty()) return notify(NO_TEXT)
        if (!showing()) return notify(OPENING)
        val capped = capped(text)
        send(BridgeProtocol.encode(ParityToEditor.InsertPlain(noteId, capped)))
        if (capped.length < text.length) notify(TRUNCATED)
    }

    /** The selection menu opened: the page keeps what is selected and where (review B2). */
    fun capture() {
        if (showing()) send(BridgeProtocol.encode(ParityToEditor.CaptureSelection(noteId)))
    }

    /**
     * The snackbar's Undo after Delete block: undoes that delete, not whatever was typed since
     * (re-review); the page says so when the note changed after it.
     */
    fun undoDelete() {
        if (showing()) send(BridgeProtocol.encode(ParityToEditor.UndoDelete(noteId)))
    }

    /** Shows the Markdown source ([on]) or the note again (ED17). */
    fun setSource(on: Boolean) {
        if (!showing()) return notify(OPENING)
        _source.value = on
        send(BridgeProtocol.encode(ParityToEditor.Source(noteId, on)))
    }

    /** Asks the page for the + sheet's or Turn into's entries for [query]. */
    fun requestBlocks(purpose: BlockPurpose, query: String) {
        if (!showing()) return
        send(BridgeProtocol.encode(ParityToEditor.Blocks(noteId, purpose, query.take(MAX_BLOCK_QUERY))))
    }

    /** Inserts a catalogue block at the caret (ED4). */
    fun insert(item: String) {
        if (showing()) send(BridgeProtocol.encode(ParityToEditor.Insert(noteId, item)))
    }

    /** Turns the selected blocks into a catalogue kind (ED5). */
    fun turnInto(item: String) {
        if (showing()) send(BridgeProtocol.encode(ParityToEditor.TurnInto(noteId, item)))
    }

    /** One of the Block menu's actions (ED5). */
    fun block(action: BlockAction) {
        if (showing()) send(BridgeProtocol.encode(ParityToEditor.Block(noteId, action)))
    }

    companion object {
        const val MAX_PLAIN_CHARS = 1_000_000
        const val MAX_BLOCK_QUERY = 100
        private const val OPENING = "Still opening the note. Try again in a moment."
        const val NO_TEXT = "There is no text on the clipboard to paste."
        const val TRUNCATED = "Only the first 1,000,000 characters were pasted."

        /** The first [MAX_PLAIN_CHARS] characters, ending before a split surrogate pair. */
        fun capped(text: String): String {
            if (text.length <= MAX_PLAIN_CHARS) return text
            val end = if (Character.isHighSurrogate(text[MAX_PLAIN_CHARS - 1])) MAX_PLAIN_CHARS - 1 else MAX_PLAIN_CHARS
            return text.substring(0, end)
        }
    }
}
