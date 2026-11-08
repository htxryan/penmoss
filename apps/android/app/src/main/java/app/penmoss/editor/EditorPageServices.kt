package app.penmoss.editor

import app.penmoss.data.NoteStore
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.CopyFailure
import app.penmoss.engine.bridge.CopyInto
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.bridge.ToEditor
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * What the editor page gets beyond the open note (T33), one per editor WebView:
 * the theme to show (A305), the phone's notes for wikilinks (A303), and the
 * conflict copies only the page can build, since only it reads Yjs (A306).
 *
 * Any edits kept apart from any note (a restore or a deletion replaced the
 * copy they were made on, or the server refused them for good) are turned into
 * conflict copies while an editor is open: the page builds each copy, the
 * store records it with the edits in one transaction, and [onCopied] says so.
 * A group waits while an open editor may still send edits of its copy
 * ([OpenEditors], A309), so a restore's last seconds of typing are in the copy.
 */
class EditorPageServices(
    private val store: NoteStore,
    private val scope: CoroutineScope,
    /** Posts one JSON message to the page. */
    private val send: (String) -> Unit,
    /**
     * A conflict copy of [source]'s edits was stored (or, with `merged`, added to): upload it,
     * and tell the person (on [source]'s own screen, a notice, NT21).
     */
    private val onCopied: (source: String, copy: PageNote, merged: Boolean) -> Unit = { _, _, _ -> },
    /** The copies open editors may still send edits of: those wait (A309). */
    private val openEditors: OpenEditors? = null,
    private val directoryEveryMs: Long = DIRECTORY_EVERY_MS,
    private val copyTimeoutMs: Long = COPY_TIMEOUT_MS,
) {
    private var ready = false
    private var theme: ToEditor.Theme? = null
    private var width: ToEditor.Width? = null
    private var fonts: ToEditor.Fonts? = null
    private var ime: ToEditor.Ime? = null
    private var symbols: ToEditor.Symbols? = null
    private val jobs = mutableListOf<Job>()

    /** The note whose copy the page is building, and where its answer goes. */
    private var awaiting: Pair<String, CompletableDeferred<FromEditor?>>? = null

    /** The theme to show; sent now if the page is ready, else once it is. */
    fun setTheme(message: ToEditor.Theme) {
        if (message == theme) return
        theme = message
        if (ready) send(BridgeProtocol.encode(message))
    }

    /** The note column's width (A413); sent now if the page is ready, else once it is. */
    fun setWidth(message: ToEditor.Width) {
        if (message == width) return
        width = message
        if (ready) send(BridgeProtocol.encode(message))
    }

    /** The person's fonts (T51, A944), after the theme they override; sent now if the page is ready, else once it is. */
    fun setFonts(message: ToEditor.Fonts) {
        if (message == fonts) return
        fonts = message
        if (ready) send(BridgeProtocol.encode(message))
    }

    /** The person's line symbols (T44, A747); sent now if the page is ready, else once it is. */
    fun setSymbols(message: ToEditor.Symbols) {
        if (message == symbols) return
        symbols = message
        if (ready) send(BridgeProtocol.encode(message))
    }

    /**
     * Whether the keyboard is up (T40 P6, A469, review S8); sent now if the page is ready, else
     * once it is. Hiding it leaves the note focused, so the page cannot tell on its own.
     */
    fun setIme(message: ToEditor.Ime) {
        if (message == ime) return
        ime = message
        if (ready) send(BridgeProtocol.encode(message))
    }

    /** A message from the page; those for the open note are the controller's. */
    fun onPageMessage(raw: String) {
        when (val message = BridgeProtocol.decodeFromEditor(raw)) {
            FromEditor.Ready -> pageReady()
            is FromEditor.ConflictCopy -> awaiting?.takeIf { it.first == message.noteId }?.second?.complete(message)
            is FromEditor.CopyFailed -> awaiting?.takeIf { it.first == message.noteId }?.second?.complete(message)
            else -> Unit
        }
    }

    /** The page is gone (closed, or its renderer died): nothing more is sent to it. */
    fun stop() {
        ready = false
        jobs.forEach { it.cancel() }
        jobs.clear()
        awaiting?.second?.complete(null)
        awaiting = null
    }

    private fun pageReady() {
        stop()
        ready = true
        theme?.let { send(BridgeProtocol.encode(it)) }
        width?.let { send(BridgeProtocol.encode(it)) }
        fonts?.let { send(BridgeProtocol.encode(it)) }
        symbols?.let { send(BridgeProtocol.encode(it)) }
        ime?.let { send(BridgeProtocol.encode(it)) }
        jobs += scope.launch {
            // At once, then at most every directoryEveryMs while sync files notes in.
            store.observeDirectory().distinctUntilChanged().conflate().collect { notes ->
                send(BridgeProtocol.encode(ToEditor.Directory(notes)))
                delay(directoryEveryMs)
            }
        }
        jobs += scope.launch {
            // Again whenever an editor lets go of a copy: its group may now be complete.
            combine(store.observeConflictCount(), openEditors?.held ?: flowOf(Unit)) { count, _ -> count }
                .conflate()
                .collect { count -> if (count > 0) copyConflicts() }
        }
    }

    /** Makes a copy of each note's edits kept apart, one note and one copy at a time. */
    private suspend fun copyConflicts() {
        val tried = mutableSetOf<String>()
        repeat(MAX_COPIES_PER_RUN) {
            val noteId = store.notesWithConflicts().firstOrNull { it !in tried } ?: return
            val set = store.conflictSet(noteId)
            // An editor may still send edits of that copy: they belong in the same copy (A309).
            if (set == null || openEditors?.holds(noteId, set.epoch) == true) {
                tried += noteId
                return@repeat
            }
            val reply = CompletableDeferred<FromEditor?>()
            awaiting = noteId to reply
            val into = set.into?.let { CopyInto(it.noteId, it.updates) }
            // The original's notebook as the phone sees it: the copy's when the note does not say (A766).
            val notebook = store.notebookOfNote(noteId)
            send(BridgeProtocol.encode(ToEditor.CopyConflicts(noteId, set.base, set.edits, into, notebook)))
            val answer = withTimeoutOrNull(copyTimeoutMs) { reply.await() }
            awaiting = null
            val replaces = set.edits.map { it.id }
            // Stored only for the edits asked about, and only if each is still kept apart.
            val saved = when {
                answer is FromEditor.ConflictCopy && answer.replaces.toSet() == replaces.toSet() ->
                    store.saveConflictCopy(noteId, answer.note, answer.replaces, answer.merged).also {
                        if (it) onCopied(noteId, answer.note, answer.merged)
                    }
                answer is FromEditor.CopyFailed && answer.replaces.toSet() == replaces.toSet() ->
                    store.saveNoCopy(noteId, answer.replaces, answer.reason.noCopy())
                else -> false
            }
            if (!saved) tried += noteId
        }
    }

    private fun CopyFailure.noCopy() = when (this) {
        CopyFailure.INCOMPLETE -> NoteStore.NoCopy.INCOMPLETE
        CopyFailure.UNREADABLE -> NoteStore.NoCopy.UNREADABLE
        CopyFailure.EMPTY -> NoteStore.NoCopy.EMPTY
    }

    companion object {
        const val DIRECTORY_EVERY_MS = 500L
        const val COPY_TIMEOUT_MS = 10_000L
        private const val MAX_COPIES_PER_RUN = 50
    }
}
