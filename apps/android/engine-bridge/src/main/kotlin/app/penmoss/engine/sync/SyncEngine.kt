package app.penmoss.engine.sync

import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossApi
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Told about every stored exchange, e.g. to hand a reply to the open note's editor. */
fun interface ExchangeListener {
    fun onExchange(result: ExchangeResult)
}

/** What one sync pass did. */
data class SyncReport(
    val treeChanged: Boolean,
    val notesChanged: Int,
    val exchanged: Int,
    val retried: Int,
    /** False when the pass stopped at its batch limit with notes still due. */
    val complete: Boolean,
)

/**
 * Catch-up sync in Kotlin (T32, A11, A280): the folder tree, then the notes
 * changed since the device's clock (`/sync/changes`), then their content
 * through `/sync/batch` as opaque update bytes. Kotlin never reads Yjs: it
 * stores what the server sends, uploads what the editor produced, and keeps
 * the server's state vector as a cursor. Background scheduling is T35's; the
 * app runs a pass when it starts, comes to the foreground or saves an edit.
 */
class SyncEngine(
    private val api: PenmossApi,
    private val store: SyncStore,
    private val listener: ExchangeListener = ExchangeListener {},
) {
    /** One exchange at a time, so two never decide on the same stored state. */
    private val exchanges = Mutex()

    suspend fun sync(prefetch: Boolean = true, maxBatches: Int = MAX_BATCHES): SyncReport {
        val treeChanged = syncTree()
        val notesChanged = syncChanges()
        var exchanged = 0
        var retried = 0
        val skip = mutableSetOf<String>()
        var batches = 0
        while (batches < maxBatches) {
            val due = store.dueContent(BATCH_NOTES, prefetch, skip)
            if (due.isEmpty()) return SyncReport(treeChanged, notesChanged, exchanged, retried, complete = true)
            // Text for the offline index only when the pass may prefetch: never on a metered
            // background run (A328, T40 P6).
            val results = exchange(due, withText = prefetch)
            for (result in results) {
                // Each note once a pass (a retried or refused note waits for the next), unless
                // it sent part of a long run of edits and more wait: it goes again (A289).
                if (!result.uploadedPart) skip += result.noteId
                if (result.kind == ExchangeResult.Kind.RETRY) retried++ else exchanged++
            }
            batches++
        }
        return SyncReport(treeChanged, notesChanged, exchanged, retried, complete = false)
    }

    /**
     * Exchanges one note now (opening it, or after an edit), in front. With its text (FD4) only
     * when it uploads nothing: an exchange carrying this phone's edits would bring back the
     * whole text for every burst of typing, and the editor page already reports the text it
     * shows, merged edits from elsewhere included (T40 P6 review B2).
     */
    suspend fun syncNote(noteId: String): ExchangeResult? {
        var content = store.content(noteId)
        var result = exchange(listOf(content), withText = content.pending.isEmpty()).firstOrNull()
        // A long run of edits goes in several requests (A289); each one confirms some.
        while (result != null && result.uploadedPart) {
            content = store.content(noteId)
            result = exchange(listOf(content), withText = content.pending.isEmpty()).firstOrNull()
        }
        return result
    }

    /**
     * The open note's poll: catches up on `/sync/changes` and exchanges the note only
     * when it changed on the server or has unsent edits. An exchange always carries the
     * note's whole delete set (Yjs state vectors do not cover deletions), so polling
     * with exchanges would store a new update every time.
     */
    suspend fun refreshNote(noteId: String): ExchangeResult? {
        syncChanges()
        return if (store.content(noteId).due) syncNote(noteId) else null
    }

    /** The folder tree, unless its hash is unchanged. True when it changed. */
    suspend fun syncTree(): Boolean {
        val tree = api.tree(store.treeHash())
        if (tree.unchanged) return false
        store.saveTree(tree)
        return true
    }

    /** Pages through `/sync/changes` from the stored clock. Returns how many notes changed. */
    suspend fun syncChanges(): Int {
        var count = 0
        var since = store.changesClock()
        while (true) {
            val page = api.changes(since)
            store.saveChanges(page)
            count += page.notes.size
            if (!page.hasMore || page.clock <= since) return count
            since = page.clock
        }
    }

    private suspend fun exchange(due: List<NoteContent>, withText: Boolean): List<ExchangeResult> = exchanges.withLock {
        // Read again under the lock: an earlier exchange may have changed these notes.
        val current = due.map { item ->
            store.content(item.noteId).let { it.copy(clock = maxOf(item.clock, it.clock)) }
        }
        // Requests kept under the server's size limit: notes go in the next one once full.
        val groups = mutableListOf<MutableList<NoteContent>>()
        var chars = 0L
        for (content in current) {
            val size = Exchange.entry(content).let { entry ->
                (entry.stateVector?.length ?: 0) + (entry.update?.sumOf { it.length } ?: 0) + 200L
            }
            if (groups.isEmpty() || chars + size > MAX_REQUEST_CHARS) {
                groups += mutableListOf<NoteContent>()
                chars = 0
            }
            groups.last() += content
            chars += size
        }
        groups.flatMap { send(it, Exchange.MAX_UPDATES, withText) }
    }

    /**
     * One `/sync/batch` request, and what to do when the server refuses it whole
     * (A289): too large (413), it is halved, down to one note and then fewer of its
     * edits, as the web client does; malformed (400), each note goes alone, so one
     * bad note never holds the others back. A note refused alone waits for the
     * next pass. Any other failure (offline, 401) stops the exchange.
     */
    private suspend fun send(notes: List<NoteContent>, maxUpdates: Int, withText: Boolean): List<ExchangeResult> {
        val entries = notes.map { Exchange.entry(it, maxUpdates, withText) }
        val reply = try {
            api.batch(entries)
        } catch (error: ApiException) {
            val uploads = entries.singleOrNull()?.update?.size ?: 0
            return when {
                error.status == 413 && notes.size > 1 ->
                    send(notes.subList(0, notes.size / 2), maxUpdates, withText) +
                        send(notes.subList(notes.size / 2, notes.size), maxUpdates, withText)
                error.status == 413 && uploads > 1 -> send(notes, uploads / 2, withText)
                error.status == 400 && notes.size > 1 -> notes.flatMap { send(listOf(it), maxUpdates, withText) }
                error.status == 400 || error.status == 413 -> notes.map { retry(it.noteId) }
                else -> throw error
            }
        }
        val byId = reply.notes.associateBy { it.id }
        return notes.mapIndexed { index, sent ->
            val noteReply = byId[sent.noteId]
            val decided = if (noteReply == null) {
                ExchangeResult(sent.noteId, ExchangeResult.Kind.RETRY)
            } else {
                Exchange.decide(sent, entries[index], noteReply)
            }
            val result = decided.copy(
                uploadedPart = decided.confirmPending.isNotEmpty() &&
                    sent.pending.size > decided.confirmPending.size + decided.conflictPending.size,
            )
            if (result.kind != ExchangeResult.Kind.RETRY || result.conflictPending.isNotEmpty()) {
                store.saveExchange(result)
            }
            listener.onExchange(result)
            result
        }
    }

    private fun retry(noteId: String): ExchangeResult =
        ExchangeResult(noteId, ExchangeResult.Kind.RETRY).also(listener::onExchange)

    companion object {
        /** Notes per `/sync/batch` request (the server's limit). */
        const val BATCH_NOTES = 50

        /** Batches per pass: 2,000 notes, so a first sync of a large vault spreads over passes. */
        const val MAX_BATCHES = 40

        /** Base64 characters per request: half the server's 16 MB request limit. */
        const val MAX_REQUEST_CHARS = 8L * 1024 * 1024
    }
}
