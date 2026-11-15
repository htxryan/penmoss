package app.penmoss.engine.sync

import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree

/** The SyncStore contract in memory, as the Room store implements it in the app. */
class InMemorySyncStore : SyncStore {
    data class Note(
        val id: String,
        var title: String = "",
        var clock: Long = 0,
        var updatedAt: Long = 0,
        var deleted: Boolean = false,
        var contentClock: Long = -1,
        var cursor: String? = null,
        var epoch: String? = null,
        var gone: Boolean = false,
    )

    data class Row(val id: Long, val noteId: String, val update: String, var state: State, val epoch: String? = null)

    enum class State { SYNCED, PENDING, CONFLICT }

    val notes = linkedMapOf<String, Note>()
    val rows = mutableListOf<Row>()
    var clock = 0L
    var tree: SyncTree? = null
    private var nextId = 1L

    fun addPending(noteId: String, update: String, epoch: String? = null): Long {
        notes.getOrPut(noteId) { Note(noteId) }
        val row = Row(nextId++, noteId, update, State.PENDING, epoch)
        rows += row
        return row.id
    }

    fun updates(noteId: String, state: State) = rows.filter { it.noteId == noteId && it.state == state }.map { it.update }

    override suspend fun changesClock() = clock

    override suspend fun treeHash() = tree?.hash

    override suspend fun saveTree(tree: SyncTree) {
        this.tree = tree
    }

    override suspend fun saveChanges(page: ChangesPage) {
        for (changed in page.notes) {
            if (changed.purged) {
                rows.removeAll { it.noteId == changed.id && it.state == State.SYNCED }
                if (rows.none { it.noteId == changed.id }) notes.remove(changed.id)
                continue
            }
            val note = notes.getOrPut(changed.id) { Note(changed.id) }
            if (note.clock > changed.clock) continue
            note.title = changed.title
            note.clock = changed.clock
            note.updatedAt = changed.updatedAt
            note.deleted = changed.deleted
        }
        clock = maxOf(clock, page.clock)
    }

    override suspend fun dueContent(limit: Int, prefetch: Boolean, skip: Set<String>): List<NoteContent> {
        val candidates = notes.values.filter { it.id !in skip && !it.gone }
        val pending = candidates.filter { note -> rows.any { it.noteId == note.id && it.state == State.PENDING } }
        val stale = candidates.filter { it.contentClock >= 0 && it.clock > it.contentClock }
        val missing = if (prefetch) {
            candidates.filter { it.contentClock < 0 && !it.deleted }.sortedByDescending { it.updatedAt }
        } else {
            emptyList()
        }
        return (pending + stale + missing).distinctBy { it.id }.take(limit).map { content(it.id) }
    }

    override suspend fun content(noteId: String): NoteContent {
        val note = notes[noteId] ?: Note(noteId)
        return NoteContent(
            noteId = noteId,
            cursor = note.cursor,
            epoch = note.epoch,
            syncedIds = rows.filter { it.noteId == noteId && it.state == State.SYNCED }.map { it.id },
            pending = rows.filter { it.noteId == noteId && it.state == State.PENDING }.map { StoredUpdate(it.id, it.update, it.epoch) },
            clock = note.clock,
            contentClock = note.contentClock,
        )
    }

    override suspend fun saveExchange(result: ExchangeResult) {
        val note = notes.getOrPut(result.noteId) { Note(result.noteId) }
        if (result.replaceAllSynced) rows.removeAll { it.noteId == result.noteId && it.state == State.SYNCED }
        rows.removeAll { it.id in result.confirmPending }
        rows.filter { it.id in result.conflictPending }.forEach { it.state = State.CONFLICT }
        result.append?.let { rows += Row(nextId++, result.noteId, it, State.SYNCED) }
        if (result.cursor != null) note.cursor = result.cursor else if (result.clearCursor) note.cursor = null
        if (result.epoch != null || result.gone) note.epoch = result.epoch
        result.epoch?.let { epoch ->
            rows.filter { it.noteId == result.noteId && it.state == State.PENDING && it.epoch != null && it.epoch != epoch }
                .forEach { it.state = State.CONFLICT }
        }
        result.contentClock?.let { note.contentClock = it }
        if (result.gone) note.gone = true
    }
}
