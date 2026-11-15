package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.bridge.Compacted
import app.penmoss.engine.sync.StoredUpdate
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map

/**
 * The editor's store (A280): every write is one transaction, so an editor compaction never loses
 * an update stored meanwhile. Also the note lists and counts the screens read around it.
 */
class EditorStore(
    private val db: PenmossDatabase,
    private val now: () -> Long,
    private val syncedSettings: SettingsStore,
) {
    private val notes = db.notes()
    private val updates = db.updates()
    private val pendingSettings = db.pendingSettings()

    // --- the editor ---

    /** What the editor page opens: the updates the server has, this device's unconfirmed ones, and their epoch. */
    data class EditorContent(val synced: List<StoredUpdate>, val pending: List<StoredUpdate>, val epoch: String?)

    suspend fun editorContent(noteId: String): EditorContent = db.withTransaction {
        val epoch = notes.note(noteId)?.epoch
        EditorContent(
            updates.updates(noteId, UpdateEntity.SYNCED).map { StoredUpdate(it.id, it.update) },
            // Never an edit from before a restore (A291): those are conflicts, not part of this copy.
            updates.updates(noteId, UpdateEntity.PENDING)
                .filter { it.epoch == null || epoch == null || it.epoch == epoch }
                .map { StoredUpdate(it.id, it.update, it.epoch) },
            epoch,
        )
    }

    /** The note's unconfirmed edits, oldest first. */
    suspend fun pending(noteId: String): List<StoredUpdate> =
        updates.updates(noteId, UpdateEntity.PENDING).map { StoredUpdate(it.id, it.update, it.epoch) }

    suspend fun pendingCount(noteId: String): Int = updates.count(noteId, UpdateEntity.PENDING)

    /** Whether this device holds any of the note's content. */
    suspend fun holds(noteId: String): Boolean =
        updates.syncedCount(noteId) > 0 || updates.ids(noteId, UpdateEntity.PENDING).isNotEmpty()

    /**
     * Stores an edit the editor made on the copy of `epoch`, to upload; kept apart as a
     * conflict if the server has replaced that copy since (A291, A5).
     */
    suspend fun addPending(noteId: String, update: String, epoch: String?): Long = db.withTransaction {
        notes.insertIgnore(NoteEntity(noteId))
        val note = notes.note(noteId)
        val current = note?.epoch
        // A note the server no longer has takes no edits: they join its conflict copy (A310).
        if (note?.gone == true) {
            return@withTransaction updates.insert(
                UpdateEntity(noteId = noteId, state = UpdateEntity.CONFLICT, update = update, epoch = epoch ?: current),
            )
        }
        val stale = epoch != null && current != null && epoch != current
        val state = if (stale) UpdateEntity.CONFLICT else UpdateEntity.PENDING
        updates.insert(UpdateEntity(noteId = noteId, state = state, update = update, epoch = epoch))
    }

    /**
     * Swaps updates the editor merged for the merged one, only if every one is still
     * stored in that state (an exchange may have confirmed or replaced them meanwhile).
     */
    suspend fun compact(noteId: String, compacted: Compacted, state: Int): Boolean = db.withTransaction {
        val ids = compacted.replaces.distinct()
        if (ids.size < 2 || updates.count(noteId, ids, state) != ids.size) return@withTransaction false
        // Edits are merged only within one copy's epoch, which the merged one keeps.
        val epochs = updates.epochsOf(ids)
        if (epochs.size != 1) return@withTransaction false
        updates.delete(ids)
        updates.insert(UpdateEntity(noteId = noteId, state = state, update = compacted.update, epoch = epochs.single()))
        true
    }

    /** The title the editor shows, so the lists follow typing before the server re-indexes. */
    suspend fun setLocalTitle(noteId: String, title: String) = notes.updateTitle(noteId, title)

    suspend fun note(noteId: String): NoteEntity? = notes.note(noteId)

    /** The held notes' ids that end with [end] (PEN-69: two notes a short reference could name). */
    suspend fun idsEndingWith(end: String): List<String> = notes.idsEndingWith(end)

    /** How many live notes the notebook has on this phone, Trash left out (PEN-148). */
    suspend fun noteCount(): Int = notes.liveCount()

    fun observeNote(noteId: String): Flow<NoteEntity?> = notes.observe(noteId)

    /** A note's title as the phone holds it; null for one it does not. */
    suspend fun noteTitle(noteId: String): String? = notes.note(noteId)?.title

    fun observeList(): Flow<List<NoteListRow>> = notes.observeList()

    /**
     * The notes pinned to Quick Access (T51, A946), in pin order: those the phone holds and are
     * not in Trash. A trashed note drops out without being unpinned.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun observeQuickAccess(pins: Flow<List<String>> = syncedSettings.observeSettings().map { it.settings.quickAccess }): Flow<List<NoteListRow>> =
        pins.distinctUntilChanged().flatMapLatest { ids ->
            if (ids.isEmpty()) flowOf(emptyList())
            else notes.observeListOf(ids).map { rows -> rows.associateBy { it.id }.let { byId -> ids.mapNotNull(byId::get) } }
        }

    /**
     * Edits made here that the notebook does not have (unconfirmed, or kept apart as conflicts),
     * captures waiting to be sent (A337), notes moved or made here that are still to file (their
     * edits aside, A360), and settings changed here (A411). Captures Penmoss refused are not
     * counted (A345).
     */
    suspend fun unsentCount(): Int =
        updates.unsentCount() + db.captures().waitingCount() + notes.unfiledCount() + pendingSettings.count() +
            notes.trashChangesWaiting() + db.folderOps().count() + unsentFeedbackCount()

    /**
     * Feedback reports not filed yet, waiting or refused (T49): counted in [unsentCount].
     */
    suspend fun unsentFeedbackCount(): Int = db.feedback().count()

    /** Edits waiting to be sent, on every note (not those kept apart, which wait for an editor). */
    suspend fun pendingCount(): Int = updates.pendingCount()

    /** This phone opened the note now (T40 P6, FD7): Home's Recent and Ctrl+E rank by it. */
    suspend fun markOpened(noteId: String) = notes.markOpened(noteId, now())

    /** Live notes most recently used first, opened here or edited anywhere (FD7). */
    fun observeRecent(limit: Int): Flow<List<NoteListRow>> = notes.observeRecent(limit)

    fun observeUnsentCount(noteId: String): Flow<Int> = updates.observeUnsentCount(noteId)

    /** Note titles and folder names: what feedback's Recent errors are scrubbed of (A427, A791). */
    suspend fun names(): List<String> = notes.titles() + db.folders().names()

    /** A stamp that moves whenever the note's content the page reads changes (T40 P7, A471). */
    fun observeContentStamp(noteId: String): Flow<String> = updates.observeContentStamp(noteId)

    /** The last version list read for a note (T40 P3b, NT16): the server's answer as JSON. */
    suspend fun cachedHistory(noteId: String): HistoryCacheEntity? = db.historyCache().get(noteId)

    /** Keeps the last version list read, so the history screen still reads offline. */
    suspend fun cacheHistory(noteId: String, json: String) =
        db.historyCache().put(HistoryCacheEntity(noteId, json, now()))
}
