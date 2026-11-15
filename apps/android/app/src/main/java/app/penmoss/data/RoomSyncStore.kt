package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.engine.sync.NoteContent
import app.penmoss.engine.sync.StoredUpdate
import app.penmoss.engine.sync.SyncStore

/**
 * The Room side of sync (T32, A280): every method is one transaction, so a reply's update and its
 * cursor are saved together or not at all. The tree's folders, settings and Trash go through
 * their own parts, inside the same transaction.
 */
class RoomSyncStore(
    private val db: PenmossDatabase,
    private val index: NoteIndex,
    private val placement: NotePlacement,
    private val folders: FolderOps,
    private val syncedSettings: SettingsStore,
    private val trash: TrashOps,
) : SyncStore {
    private val notes = db.notes()
    private val updates = db.updates()
    private val settings = db.settings()

    override suspend fun changesClock(): Long = settings.get(CHANGES_CLOCK)?.toLongOrNull() ?: 0

    override suspend fun treeHash(): String? = settings.get(TREE_HASH)

    override suspend fun saveTree(tree: SyncTree) = db.withTransaction {
        // A note reordered here keeps its optimistic key until the server files the reorder
        // (T40 P4): captured before the tree's placements overwrite it (see below).
        val reordered = notes.waitingToFile()
            .filter { it.filePlaceBefore != null || it.filePlaceAfter != null }
            .associate { it.id to it.position }
        db.folders().clear()
        db.folders().insertAll(
            tree.folders.map { FolderEntity(it.id, it.name, it.parentId, it.position, it.sortMode, notebook = it.notebook) },
        )
        notes.clearPlacements()
        for (placement in tree.notes) {
            // Filed before it was ever indexed: listed (untitled) until /sync/changes names it.
            notes.insertIgnore(NoteEntity(placement.id))
            notes.place(placement.id, placement.folderId, placement.position)
            // A daily or weekly note's identity from the tree (T40 P5): a tree lists every
            // note, so the calendar's marks are complete; older servers send neither.
            val kind = journalKind(placement.kind)
            if (kind != "note" && placement.period != null) {
                notes.updateKindPeriod(placement.id, kind, placement.period)
            }
        }
        // Notes moved or made on this phone and not filed yet show where they are going (T38),
        // or at the top level on this phone only while that folder has gone: the server files
        // them in a safe place, never the default notebook's top level for another's (A757). A move
        // whose note the tree shows somewhere else than where it was moved from was overtaken
        // by a move made elsewhere: it is dropped and the tree's place stands (A359). A note
        // reordered here keeps its optimistic key until the server files the reorder (T40 P4):
        // the tree still shows where it was.
        val folderIds = tree.folders.mapTo(HashSet()) { it.id }
        val placed = tree.notes.associate { it.id to it.folderId }
        for (waiting in notes.waitingToFile()) {
            if (waiting.checkFrom && waiting.id in placed && placed[waiting.id] != waiting.movedFrom) {
                notes.filed(waiting.id, waiting.fileIn)
                continue
            }
            val kept = reordered[waiting.id]
            if (kept != null && waiting.fileIn?.takeIf { it in folderIds } == waiting.fileIn) {
                notes.place(waiting.id, waiting.fileIn?.takeIf { it in folderIds }, kept)
            } else {
                placement.placeAtEnd(waiting.id, waiting.fileIn?.takeIf { it in folderIds })
            }
        }
        // Folder changes made here and not sent yet show on top of the tree (T40 P4, A443):
        // creates reappear, renames, moves, sorts and reorders apply again, and changes for
        // folders the tree no longer has are dropped with a notice (deleted elsewhere).
        // The top level's sort, which lives in settings rather than the folders table, is
        // re-applied after the tree's own (T40 P4, NT6).
        settings.put(SettingEntity(FolderOps.ROOT_SORT_MODE, tree.rootSortMode))
        folders.reapplyFolderOps(folderIds)
        // The settings the phone shows and changes, where captures go and a git notebook's device
        // map (A410, A411, A336, A1014): [SettingsStore.saveTreeSettings].
        syncedSettings.saveTreeSettings(tree)
        settings.put(SettingEntity(TREE_HASH, tree.hash))
    }

    override suspend fun saveChanges(page: ChangesPage) = db.withTransaction {
        for (changed in page.notes) {
            if (changed.purged) {
                // Deleted for good everywhere (T21): drop what the server had, but never this
                // device's unsent edits, pending or kept apart as conflicts, nor the note they need.
                // What the server had stays with them as the base of their conflict copy, pending
                // edits are kept apart at once (they can never upload), and the note leaves every
                // list (A306, A310).
                trash.dropPurged(changed.id)
                continue
            }
            notes.insertIgnore(NoteEntity(changed.id))
            // A row from a server older than T40 P5 carries no kind: what Room holds stands, as
            // the tree's rule is (review N2). Identity never changes, so a row with one is right.
            val held = if (changed.kind == null) notes.note(changed.id) else null
            val kind = if (held != null) held.kind else journalKind(changed.kind)
            val period = if (held != null) held.period else changed.period?.takeIf { kind != "note" }
            notes.updateMetadata(
                changed.id, changed.title, changed.excerpt, changed.updatedAt, changed.clock,
                changed.deleted, changed.seq, kind, period,
            )
            // Its tags (T40 P6): only from the row that landed, never an older one, and never over
            // the page's own while this phone has edits the server lacks (review S5).
            if (notes.note(changed.id)?.clock == changed.clock && updates.count(changed.id, UpdateEntity.PENDING) == 0) {
                index.saveTags(changed.id, changed.tags)
            }
            trash.settleTrashChange(changed.id, changed.deleted, changed.seq)
            // Which notes it links to (T40 P7, A473). A note with edits not sent yet keeps what the
            // page reported of it: the index has not seen those edits.
            if (updates.ids(changed.id, UpdateEntity.PENDING).isEmpty()) index.replaceLinks(changed.id, changed.links)
            // Moved to Trash elsewhere: a move made here is dropped, never applied on a restore (T38).
            if (notes.note(changed.id)?.deleted == true) notes.dropMoveIfDeleted(changed.id)
        }
        // Two catch-ups may finish out of order (a pass and the open note's poll): never go back.
        if (page.clock > changesClock()) settings.put(SettingEntity(CHANGES_CLOCK, page.clock.toString()))
    }

    override suspend fun dueContent(limit: Int, prefetch: Boolean, skip: Set<String>): List<NoteContent> {
        val ids = LinkedHashSet<String>()
        val room = limit + skip.size
        updates.notesWithPending(room).forEach { ids += it }
        notes.stale(room).forEach { ids += it.id }
        if (prefetch) notes.missing(room).forEach { ids += it.id }
        // The offline index's text, one pass at a time and never on a metered run (T40 P6, A328).
        if (prefetch) notes.textMissing(room).forEach { ids += it.id }
        return ids.asSequence().filter { it !in skip }.take(limit).toList().map { content(it) }
    }

    override suspend fun content(noteId: String): NoteContent = db.withTransaction {
        val note = notes.note(noteId)
        NoteContent(
            noteId = noteId,
            cursor = note?.cursor,
            epoch = note?.epoch,
            syncedIds = updates.ids(noteId, UpdateEntity.SYNCED),
            pending = updates.updates(noteId, UpdateEntity.PENDING).map { StoredUpdate(it.id, it.update, it.epoch) },
            clock = note?.clock ?: 0,
            contentClock = note?.contentClock ?: -1,
            textHash = note?.textHash,
            // Made here, never uploaded nor filed (T43, fix c): its first upload names its folder.
            fileOnUpload = note?.takeIf { it.toFile && !it.checkFrom && it.fileKind == null && it.epoch == null && !it.deleted }
                ?.let { app.penmoss.engine.api.InFolder(it.fileIn) },
        )
    }

    override suspend fun saveExchange(result: ExchangeResult) = db.withTransaction {
        val id = result.noteId
        notes.insertIgnore(NoteEntity(id))
        // The copy this phone held before the reply: the one its edits were made on.
        val held = notes.note(id)?.epoch
        if (result.replaceAllSynced) {
            val replaced = result.kind == ExchangeResult.Kind.RESET || result.kind == ExchangeResult.Kind.GONE
            // A restore or a deletion replaced the copy this phone's edits were made on: what the
            // server had of it stays as their base, so they can become a conflict copy (A306). Kept
            // even with no edits yet: an open editor may still send its last ones. The next sync
            // pass drops a base no edit needs.
            if (replaced) updates.keepAsBase(id, held) else updates.deleteSynced(id)
        }
        if (result.confirmPending.isNotEmpty()) updates.delete(result.confirmPending)
        if (result.conflictPending.isNotEmpty()) updates.markConflict(result.conflictPending, held)
        result.append?.let { updates.insert(UpdateEntity(noteId = id, state = UpdateEntity.SYNCED, update = it)) }
        val note = notes.note(id)!!
        // After a restore, edits made on the old copy since the request went out are kept apart too.
        result.epoch?.let { updates.markStale(id, it) }
        notes.updateContentState(
            id,
            cursor = when {
                result.cursor != null -> result.cursor
                result.clearCursor -> null
                else -> note.cursor
            },
            epoch = if (result.epoch != null || result.gone) result.epoch else note.epoch,
            contentClock = result.contentClock ?: note.contentClock,
            gone = note.gone || result.gone,
        )
        index.saveExchangedText(result)
        // A copy withheld from the push (A886): what this reply kept apart joins it, never a
        // conflict copy of its own.
        if (updates.count(id, UpdateEntity.WITHHELD) > 0) updates.withholdRest(id)
        // Filed by its first upload (T43, fix c), as the filer marks a move filed: a move made
        // meanwhile (another fileIn) is still to file, from where this one put it.
        val filed = result.filed
        if (filed != null) {
            notes.filed(id, filed.asked)
            notes.nowIn(id, filed.landed)
        }
    }

    private companion object {
        const val CHANGES_CLOCK = "changesClock"
        const val TREE_HASH = "treeHash"
    }
}

/** A `/sync` row's kind, as Room holds it: daily or weekly, else `note` (T40 P5). */

internal fun journalKind(kind: String?): String = if (kind == "daily" || kind == "weekly") kind else "note"
