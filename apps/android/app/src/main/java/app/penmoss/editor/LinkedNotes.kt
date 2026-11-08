package app.penmoss.editor

import app.penmoss.data.NoteStore
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.ContentState
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.sync.StoredUpdate
import app.penmoss.sync.NoteSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Other notes for the editor page's links and embeds (T40 P7, LK2, LK4; A470, A471), one per
 * editor WebView.
 *
 * `noteContent`: the page asks for a note's content; the answer is what Room stores of it, the
 * updates the server has and this phone's own edits of the current copy, exactly the bytes an
 * `open` of it would send. Kotlin never reads them (A11). A note the phone does not hold is
 * fetched first, as opening it would be; past [BridgeProtocol.MAX_CONTENT_CHARS] the page is
 * told `tooLarge` instead of being handed it.
 *
 * `watchNote`: while an embed shows a note, a Room observer on its stored rows says
 * `noteChanged` whenever they change, from this phone or from a sync, and the page renders it
 * again. A watched note the open note's poll finds changed on the server (its row's clock past
 * its content) is fetched at once, so an embed follows another device's edits within the poll's
 * 10 s rather than the next pass. At most [MAX_WATCHED] notes are followed at once, as the web
 * keeps at most eight embedded notes live; the rest wait for a turn, showing what was read.
 */
class LinkedNotes(
    private val store: NoteStore,
    private val sync: NoteSync,
    private val scope: CoroutineScope,
    /** Posts one JSON message to the page. */
    private val send: (String) -> Unit,
    private val maxChars: Int = BridgeProtocol.MAX_CONTENT_CHARS,
) {
    private val watching = LinkedHashMap<String, Job>()
    private val waiting = LinkedHashSet<String>()
    private var stopped = false

    /**
     * The content stamp each note had just before the page was last answered about it (review
     * N7): a watch that begins on a later stamp says so at once. The latest few notes only.
     */
    private val answeredAt = object : LinkedHashMap<String, String>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > MAX_ANSWERED
    }

    /** The notes followed now, for tests. */
    val watched: Set<String> get() = watching.keys.toSet()

    /** A message from the page; only `noteContent` and `watchNote` are this class's. */
    fun onPageMessage(raw: String) {
        when (val message = BridgeProtocol.decodeFromEditor(raw)) {
            // A reloaded page holds nothing: what it watched, it asks for again.
            FromEditor.Ready -> unwatchAll()
            is FromEditor.NoteContent -> scope.launch { answer(message.noteId) }
            is FromEditor.WatchNote -> if (message.on) watch(message.noteId) else unwatch(message.noteId)
            else -> Unit
        }
    }

    /** The page is gone: nothing more is sent to it, and nothing is followed. */
    fun stop() {
        stopped = true
        unwatchAll()
    }

    private suspend fun answer(noteId: String) {
        // Not on the phone: fetched as opening it would be (offline or signed out, it stays missing).
        if (!store.holds(noteId)) runCatching { sync.syncNote(noteId) }
        // Read before the content: a change from here on shows as another stamp to the watch.
        store.observeContentStamp(noteId).first().let { stamp -> synchronized(answeredAt) { answeredAt[noteId] = stamp } }
        val message = if (!store.holds(noteId)) {
            ToEditor.NoteContent(noteId, ContentState.MISSING, emptyList())
        } else {
            val content = store.editorContent(noteId)
            // Ids only: the page reads the bytes, never the epoch the pending rows carry.
            val updates = (content.synced + content.pending).map { StoredUpdate(it.id, it.update) }
            if (updates.sumOf { it.update.length.toLong() } > maxChars) {
                ToEditor.NoteContent(noteId, ContentState.TOO_LARGE, emptyList())
            } else {
                ToEditor.NoteContent(noteId, ContentState.OK, updates)
            }
        }
        if (!stopped) send(BridgeProtocol.encode(message))
    }

    private fun watch(noteId: String) {
        if (stopped || noteId in watching) return
        if (watching.size >= MAX_WATCHED) {
            waiting += noteId
            return
        }
        waiting -= noteId
        watching[noteId] = scope.launch {
            launch {
                // Any change to what the page reads of it, after the first (what it read already),
                // unless the first is already past what the page was answered.
                var first = true
                store.observeContentStamp(noteId).distinctUntilChanged().collect { stamp ->
                    val answered = synchronized(answeredAt) { answeredAt[noteId] }
                    val read = first && (answered == null || answered == stamp)
                    first = false
                    if (!read && !stopped) send(BridgeProtocol.encode(ToEditor.NoteChanged(noteId)))
                }
            }
            launch {
                // Changed on the server, as the open note's poll and every pass find out: fetched
                // now, while the app is in front, once per change.
                var fetchedAt = Long.MIN_VALUE
                store.observeNote(noteId).collect { note ->
                    if (note == null || note.gone || note.contentClock < 0) return@collect
                    if (note.clock > note.contentClock && note.clock != fetchedAt && sync.foreground.value) {
                        fetchedAt = note.clock
                        runCatching { sync.syncNote(noteId) }
                    }
                }
            }
        }
    }

    private fun unwatch(noteId: String) {
        waiting -= noteId
        watching.remove(noteId)?.cancel() ?: return
        // A turn is free: the oldest note waiting for one is followed now.
        waiting.firstOrNull()?.let(::watch)
    }

    private fun unwatchAll() {
        watching.values.forEach { it.cancel() }
        watching.clear()
        waiting.clear()
        synchronized(answeredAt) { answeredAt.clear() }
    }

    companion object {
        /** Notes followed at once, as the web keeps at most eight embedded notes live (T13). */
        const val MAX_WATCHED = 8

        /** Notes whose answered stamp is kept, well past the page's own cache (MAX_UNWATCHED_CACHED). */
        private const val MAX_ANSWERED = 64
    }
}
