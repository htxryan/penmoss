package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.PenmossJson
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TagCount
import app.penmoss.engine.bridge.Compacted
import app.penmoss.engine.bridge.DirectoryEntry
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.engine.sync.NoteContent
import app.penmoss.engine.sync.StoredUpdate
import app.penmoss.engine.sync.SyncStore
import app.penmoss.engine.settings.SettingDefaults
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.SettingLimits
import app.penmoss.engine.settings.Settings
import app.penmoss.engine.settings.ThemeEdits
import app.penmoss.engine.notes.Ulid
import app.penmoss.engine.tree.FolderTree
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The Room side of sync (T32, A280) and the editor's store: every method is
 * one transaction, so a reply's update and its cursor are saved together or
 * not at all, and an editor compaction never loses an update stored meanwhile.
 */
class NoteStore(
    private val db: PenmossDatabase,
    /** Also forgets what lives outside the database (pictures' files) when the cache is cleared. */
    private val now: () -> Long = System::currentTimeMillis,
) : SyncStore {
    private val notes = db.notes()
    private val updates = db.updates()
    private val settings = db.settings()
    private val pendingSettings = db.pendingSettings()
    private val search = db.search()

    /** When the page last changed each note's own links in this process (T40 P7 review S3). */
    private val ownLinksAt = MutableStateFlow<Map<String, Long>>(emptyMap())

    // --- SyncStore ---

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
                placeAtEnd(waiting.id, waiting.fileIn?.takeIf { it in folderIds })
            }
        }
        // Folder changes made here and not sent yet show on top of the tree (T40 P4, A443):
        // creates reappear, renames, moves, sorts and reorders apply again, and changes for
        // folders the tree no longer has are dropped with a notice (deleted elsewhere).
        // The top level's sort, which lives in settings rather than the folders table, is
        // re-applied after the tree's own (T40 P4, NT6).
        settings.put(SettingEntity(ROOT_SORT_MODE, tree.rootSortMode))
        // The default notebook's name (T43, A751), absent while unnamed: "Personal". A rename
        // made here and not sent yet is laid over it next, as the top level's sort is.
        val notebookName = tree.defaultNotebook?.takeIf { it.isNotBlank() }
        if (notebookName != null) settings.put(SettingEntity(DEFAULT_NOTEBOOK, notebookName)) else settings.delete(DEFAULT_NOTEBOOK)
        reapplyFolderOps(folderIds)
        // The theme chosen in Settings → Appearance, as the server resolved it (A305).
        tree.appearance?.let { settings.put(SettingEntity(APPEARANCE, it.toString())) }
        // The settings the phone shows and changes (T40 P1, A410, A411). A change made here that
        // the tree shows overtaken (the setting is no longer what it was when changed here) was
        // beaten by a newer one made elsewhere: it is dropped and the tree's value stands.
        // A tree showing a value this phone sent and has no answer for is its own change landing:
        // the change is done, or what was chosen since is based on it (A411).
        tree.settings?.let { sent ->
            settings.put(SettingEntity(SYNCED_SETTINGS, sent.toString()))
            for (row in pendingSettings.all()) {
                val now = sent[row.key] ?: JsonNull
                when {
                    now == jsonOf(row.base) -> Unit
                    now in sentOf(row) -> landed(row, now)
                    ownNewTheme(row, now) -> basedOnOwnTheme(row)
                    themeEditStands(row, now) -> Unit
                    else -> pendingSettings.delete(row.key)
                }
            }
        }
        // Where captures go, as the web and Mac apps remember it (T34, A336), unless a capture
        // that changes it is still waiting to tell the server (A346) or a change made in Settings
        // here is (A411); and the time zone a capture made now is read in (A344).
        val destination = tree.capture?.destination ?: tree.settings?.let { Settings(it).captureDestination }
        if (destination != null && db.captures().rememberingCount() == 0 && pendingSettings.get(SettingKeys.CAPTURE) == null) {
            settings.put(SettingEntity(CAPTURE_DESTINATION, destination))
        }
        tree.capture?.timeZone?.let { settings.put(SettingEntity(CAPTURE_TIME_ZONE, it)) }
        // A git notebook's device map (A1014): the device's settings if this is the Journal.
        tree.device?.let { settings.put(SettingEntity(DEVICE_SETTINGS, it.toString())) }
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
                dropPurged(changed.id)
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
                saveTags(changed.id, changed.tags)
            }
            settleTrashChange(changed.id, changed.deleted, changed.seq)
            // Which notes it links to (T40 P7, A473), from D1's index; an older server sends
            // none, leaving what the phone has. A note with edits not sent yet keeps what the page
            // reported of it: the index has not seen those edits.
            changed.links?.let { links -> if (updates.ids(changed.id, UpdateEntity.PENDING).isEmpty()) replaceLinks(changed.id, links) }
            // Moved to Trash elsewhere: a move made here is dropped, never applied on a restore (T38).
            if (notes.note(changed.id)?.deleted == true) notes.dropMoveIfDeleted(changed.id)
        }
        // Two catch-ups may finish out of order (a pass and the open note's poll): never go back.
        if (page.clock > changesClock()) settings.put(SettingEntity(CHANGES_CLOCK, page.clock.toString()))
    }

    /**
     * A move to Trash or a restore the server confirmed is held until the index agrees (A430): a
     * row from before the server made the change (its seq not after the one the server answered)
     * still says what was, and must not bring a note trashed here back, nor hide one restored
     * here (and drop its filing). Once a row says what was asked, or comes from after the change
     * (changed again elsewhere since), the server has the last word again. Seqs only: no clock
     * is compared, so neither the phone's nor the server's can tip it.
     */
    private suspend fun settleTrashChange(id: String, deleted: Boolean, seq: Long) {
        val note = notes.note(id) ?: return
        val asked = when (note.trashChange) {
            // Trashed with a notebook deleted here (T43): the server's delete does it.
            NoteEntity.TRASH_SENT, NoteEntity.TRASH_WITH_NOTEBOOK -> true
            NoteEntity.RESTORE_SENT -> false
            else -> return
        }
        if (deleted != asked && seq <= note.trashSeq) return
        notes.trashChanged(id, note.trashChange, 0)
        notes.updateMetadata(id, note.title, note.excerpt, note.updatedAt, note.clock, deleted, seq, note.kind, note.period)
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
        saveExchangedText(result)
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

    /**
     * The offline index's side of an exchange (T40 P6, FD4): the server's text is kept only once
     * the server holds every edit made here (else it lacks them, and the page's text stands until
     * they are sent). A reply that applied or restored and says the phone's copy is current
     * settles it, as does an older server's applied reply, which sends no text at all (A463);
     * any other reply (deferred, kept apart) leaves it due (review nit). Content that changed on
     * a pass that asked for no text (metered, A328) leaves the text due for the next pass that
     * may prefetch.
     */
    private suspend fun saveExchangedText(result: ExchangeResult) {
        val id = result.noteId
        if (!result.textAsked) {
            if (result.append != null) notes.setTextDue(id, true)
            return
        }
        val text = result.text
        when {
            text != null && updates.count(id, UpdateEntity.PENDING) == 0 -> {
                val headings = result.headings.orEmpty()
                putText(id, text, headings)
                notes.setText(id, result.textHash ?: textHash(text, headings), due = false)
            }
            text != null -> Unit
            result.textHash != null && (result.kind == ExchangeResult.Kind.APPLIED || result.kind == ExchangeResult.Kind.RESET) -> notes.setTextDue(id, false)
            result.textHash == null && result.kind == ExchangeResult.Kind.APPLIED -> notes.setTextDue(id, false)
            else -> Unit
        }
    }

    // --- the offline index and tags (T40 P6, FD3, FD4) ---

    /** The note's row in the offline index: [text] and [headings], its title and tags as Room holds them, folded. */
    private suspend fun putText(noteId: String, text: String, headings: String) {
        val note = notes.note(noteId) ?: return
        search.putText(NoteTextEntity.of(noteId, note.title, text, search.tagsOf(noteId).joinToString(" "), headings))
    }

    /**
     * The open note's text, headings and tags from the editor page (FD4): this phone's own
     * edits, found offline before the server has them. Its hash goes with the next exchange, so
     * the server sends its text only once it differs (the edits merged with others'). The same
     * text again writes nothing (review B2). Its tags are this phone's own (review S5): the tag
     * browser and filter see a tag typed here at once, until a landed `/sync/changes` row once
     * the edits are sent replaces them.
     */
    suspend fun savePageText(noteId: String, text: String, headings: String = "", tags: List<String> = emptyList()) = db.withTransaction {
        val note = notes.note(noteId) ?: return@withTransaction
        val hash = textHash(text, headings)
        val now = tags.distinct().sorted()
        val tagsChanged = search.tagsOf(noteId) != now
        if (tagsChanged) {
            search.clearTags(noteId)
            search.addTags(now.map { NoteTagEntity(noteId, it) })
        }
        if (hash == note.textHash && !tagsChanged) return@withTransaction
        putText(noteId, text, headings)
        if (hash != note.textHash) notes.setText(noteId, hash, due = note.textDue)
    }

    /** The note's tags ([tags] null: an older server, which leaves them), and its index row refolded with its title and tags. */
    private suspend fun saveTags(noteId: String, tags: List<String>?) {
        val now = tags?.distinct()?.sorted() ?: search.tagsOf(noteId)
        if (tags != null && search.tagsOf(noteId) != now) {
            search.clearTags(noteId)
            search.addTags(now.map { NoteTagEntity(noteId, it) })
        }
        reindex(noteId)
    }

    /** The note's index row again, its text kept, with the title and tags Room holds now. */
    private suspend fun reindex(noteId: String) {
        val row = search.text(noteId) ?: return
        val note = notes.note(noteId) ?: return
        val tags = search.tagsOf(noteId).joinToString(" ")
        if (row.title == note.title && row.tags == tags) return
        search.putText(NoteTextEntity.of(noteId, note.title, row.body, tags, row.headings))
    }

    /**
     * A tag renamed on the server (TG3, review S5): [from] becomes [to] here at once, the tags
     * under it too (`a/x` becomes `b/x`), on [noteIds] (the notes the server named). The rows a
     * later `/sync/changes` lands correct it.
     */
    suspend fun renameTagLocally(from: String, to: String, noteIds: List<String>) = db.withTransaction {
        if (noteIds.isEmpty()) return@withTransaction
        val byNote = search.tagsOfNotes(noteIds).groupBy({ it.noteId }, { it.tag })
        for ((noteId, tags) in byNote) {
            val renamed = tags.map { tag ->
                when {
                    tag == from -> to
                    tag.startsWith("$from/") -> to + tag.substring(from.length)
                    else -> tag
                }
            }.distinct().sorted()
            if (renamed == tags.sorted()) continue
            search.clearTags(noteId)
            search.addTags(renamed.map { NoteTagEntity(noteId, it) })
            reindex(noteId)
        }
    }

    /** Every tag on a live note and how many carry it, A–Z, from Room (offline). */
    fun observeTagCounts(): Flow<List<TagCountRow>> = search.observeTagCounts()

    /** One note's own tags, frontmatter and inline, as the phone has them (TG6, A656). */
    fun observeTagsOf(noteId: String): Flow<List<String>> = search.observeTagsOf(noteId)

    /** Each live note's tags, by note (T40 P6, TG1). */
    fun observeNoteTags(): Flow<List<List<String>>> = search.observeNoteTags().map { rows ->
        rows.groupBy({ it.noteId }, { it.tag }).values.toList()
    }

    /** The live notes with [tag] or a tag under it, newest first (TG2). */
    fun observeTagged(tag: String): Flow<List<NoteListRow>> = search.observeTagged(tag)

    /** Every note held with [tag] or a tag under it: the ids a rename sends (TG3). */
    suspend fun taggedIds(tag: String): List<String> = search.taggedIds(tag)

    /** This phone's sendable edits, to any note, and waiting captures: a rename waits for them (TG3, A468, review S4, R2). */
    fun observeUnsent(): Flow<Int> = search.observeUnsent()

    /** This phone opened the note now (T40 P6, FD7): Home's Recent and Ctrl+E rank by it. */
    suspend fun markOpened(noteId: String) = notes.markOpened(noteId, now())

    /** Live notes most recently used first, opened here or edited anywhere (FD7). */
    fun observeRecent(limit: Int): Flow<List<NoteListRow>> = notes.observeRecent(limit)

    // --- notebooks (T43, A750–A756) ---

    /**
     * The folders of the notebooks [closed] on this phone (A752): Recent, the switcher, search,
     * tags and the graph leave their notes out. The default notebook is never closed.
     */
    fun observeHiddenFolders(closed: Flow<Set<String>>): Flow<Set<String>> =
        combine(db.folders().observeAll(), closed) { folders, shut -> Notebooks.hiddenFolders(folders, shut) }.distinctUntilChanged()

    /** Recent, without the notes of notebooks closed here (A752). */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun observeRecent(limit: Int, hidden: Flow<Set<String>>): Flow<List<NoteListRow>> =
        hidden.flatMapLatest { if (it.isEmpty()) notes.observeRecent(limit) else notes.observeRecentOutside(limit, it.toList()) }

    /** Each live note's tags, without closed notebooks' notes (A752). */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun observeNoteTags(hidden: Flow<Set<String>>): Flow<List<List<String>>> = hidden.flatMapLatest { shut ->
        (if (shut.isEmpty()) search.observeNoteTags() else search.observeNoteTagsOutside(shut.toList())).map { rows ->
            rows.groupBy({ it.noteId }, { it.tag }).values.toList()
        }
    }

    /** Every tag with its count, without closed notebooks' notes (A752). */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun observeTagCounts(hidden: Flow<Set<String>>): Flow<List<TagCountRow>> =
        hidden.flatMapLatest { if (it.isEmpty()) search.observeTagCounts() else search.observeTagCountsOutside(it.toList()) }

    /** A tag's notes, without closed notebooks' (A752). */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun observeTagged(tag: String, hidden: Flow<Set<String>>): Flow<List<NoteListRow>> =
        hidden.flatMapLatest { if (it.isEmpty()) search.observeTagged(tag) else search.observeTaggedOutside(tag, it.toList()) }

    /** What a search leaves out with notebooks [closed] here (A752): from the folders now. */
    suspend fun notebookScope(closed: Set<String>): NotebookScope =
        if (closed.isEmpty()) NotebookScope.ALL else Notebooks.scope(db.folders().all(), closed)

    /** The default notebook's name (A751): as the tree last said, or a rename made here; "Personal" unnamed. */
    fun observeDefaultNotebookName(): Flow<String> = settings.observe(DEFAULT_NOTEBOOK).map(Notebooks::defaultName)

    suspend fun defaultNotebookName(): String = Notebooks.defaultName(settings.get(DEFAULT_NOTEBOOK))

    /** The notebook a note is in, by name (A752): null for the default notebook or a note not held. */
    suspend fun notebookOf(noteId: String): FolderEntity? {
        val folderId = notes.note(noteId)?.folderId ?: return null
        val folders = db.folders().all()
        val notebook = Notebooks.index(folders).ofFolder(folderId) ?: return null
        return folders.firstOrNull { it.id == notebook }
    }

    /**
     * Makes a notebook here (A750): a top-level folder flagged at once, queued as one create
     * (`POST /api/folders { notebook: true }`), offline too. Returns its id.
     */
    suspend fun createNotebook(name: String): String = db.withTransaction {
        val id = Ulid.next()
        db.folders().put(FolderEntity(id, name, null, endFolderPosition(null), FolderTree.MANUAL, notebook = true))
        db.folderOps().insert(
            FolderOpEntity(folderId = id, kind = FolderOpEntity.CREATE, name = name, parentId = null, label = name, notebook = true),
        )
        id
    }

    /** What [setNotebook] did: [refusal] says why not, in the server's words. */
    data class NotebookFlag(val changed: Boolean, val refusal: String? = null)

    /**
     * Turns a top-level folder into a notebook ([on]) or a notebook back into a folder (A756):
     * shown at once, queued as `PATCH /api/folders/:id { notebook }`. Refused, as the server
     * refuses, for a folder inside another or one holding Journal or the Inbox.
     */
    suspend fun setNotebook(id: String, on: Boolean): NotebookFlag = db.withTransaction {
        val folders = db.folders().all()
        val folder = folders.firstOrNull { it.id == id } ?: return@withTransaction NotebookFlag(false, "That folder isn't on this phone anymore")
        if (folder.notebook == on) return@withTransaction NotebookFlag(false)
        Notebooks.flagRefusal(folders, id, on)?.let { return@withTransaction NotebookFlag(false, it) }
        db.folders().put(folder.copy(notebook = on))
        // Undoing a change never tried cancels it: the server still has the folder as it was.
        val waiting = db.folderOps().all().lastOrNull { it.folderId == id && it.kind == FolderOpEntity.NOTEBOOK }
        if (waiting != null && !waiting.tried) {
            db.folderOps().delete(waiting.rowId)
        } else {
            db.folderOps().insert(FolderOpEntity(folderId = id, kind = FolderOpEntity.NOTEBOOK, notebook = on, label = folder.name))
        }
        NotebookFlag(true)
    }

    /**
     * Renames the default notebook here (A751): shown at once, queued as
     * `PATCH /api/folders/root { notebookName }`; a blank name gives back "Personal".
     */
    suspend fun renameDefaultNotebook(name: String) = db.withTransaction {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) settings.delete(DEFAULT_NOTEBOOK) else settings.put(SettingEntity(DEFAULT_NOTEBOOK, trimmed))
        db.folderOps().deleteKind(null, FolderOpEntity.ROOT_NAME)
        db.folderOps().insert(FolderOpEntity(folderId = null, kind = FolderOpEntity.ROOT_NAME, name = trimmed))
    }

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

    fun observeNote(noteId: String): Flow<NoteEntity?> = notes.observe(noteId)

    /** A note's title as the phone holds it; null for one it does not. */
    suspend fun noteTitle(noteId: String): String? = notes.note(noteId)?.title

    fun observeList(): Flow<List<NoteListRow>> = notes.observeList()

    /**
     * The notes pinned to Quick Access (T51, A946), in pin order: those the phone holds and are
     * not in Trash. A trashed note drops out without being unpinned.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun observeQuickAccess(pins: Flow<List<String>> = observeSettings().map { it.settings.quickAccess }): Flow<List<NoteListRow>> =
        pins.distinctUntilChanged().flatMapLatest { ids ->
            if (ids.isEmpty()) flowOf(emptyList())
            else notes.observeListOf(ids).map { rows -> rows.associateBy { it.id }.let { byId -> ids.mapNotNull(byId::get) } }
        }

    fun observeFolders(): Flow<List<FolderEntity>> = db.folders().observeAll()

    fun observeRootSortMode(): Flow<String> = settings.observe(ROOT_SORT_MODE).map { it ?: "manual" }

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

    // --- the theme (A305) ---

    /** The theme and mode `/sync/tree` last sent, as JSON text; null until the first pass. */
    fun observeAppearance(): Flow<String?> = settings.observe(APPEARANCE)

    // --- quick capture (A336) ---

    /** Where captures go unless the person picks the other: the last pass's word, or today's note. */
    suspend fun captureDestination(): String =
        settings.get(CAPTURE_DESTINATION)?.takeIf { it == CaptureRequest.INBOX } ?: CaptureRequest.DAILY

    /** The synced time zone the last pass brought, or null before one did (A344). */
    suspend fun captureTimeZone(): String? = settings.get(CAPTURE_TIME_ZONE)

    // --- synced settings (T40 P1, A410, A411) ---

    /**
     * The settings as the phone shows them: what the last `/sync/tree` sent, with the changes made
     * here and not sent yet laid over it. [SettingsState.known] is false until a tree from a server
     * with the settings channel has come; until then nothing can be changed here.
     */
    data class SettingsState(
        val settings: Settings = Settings(),
        val known: Boolean = false,
        val unsent: Set<String> = emptySet(),
        /** Changes the server refused for good and the phone dropped, until the person dismisses it. */
        val refused: SettingsRefusal? = null,
    )

    /** Settings changed here that the server would not take (400, 413 or 403), and its reason. */
    data class SettingsRefusal(val keys: List<String>, val message: String)

    fun observeSettings(): Flow<SettingsState> =
        combine(settings.observe(SYNCED_SETTINGS), pendingSettings.observeAll(), settings.observe(SETTINGS_REFUSED)) { synced, pending, refused ->
            settingsOf(synced, pending, refused)
        }

    suspend fun settingsNow(): SettingsState =
        db.withTransaction { settingsOf(settings.get(SYNCED_SETTINGS), pendingSettings.all(), settings.get(SETTINGS_REFUSED)) }

    // --- a git notebook's device map (A1014) ---

    /** A git notebook's device map as its last tree sent it; null before one has. */
    fun observeDeviceMap(): Flow<JsonObject?> = settings.observe(DEVICE_SETTINGS).map { it?.let(::objectOf) }

    suspend fun deviceMapNow(): JsonObject? = settings.get(DEVICE_SETTINGS)?.let(::objectOf)

    /** The device map as a change to it answered, before the next tree brings it. */
    suspend fun putDeviceMap(map: JsonObject) = settings.put(SettingEntity(DEVICE_SETTINGS, map.toString()))

    /** The synced settings as stored, to compare with what they should be. */
    fun observeSyncedSettings(): Flow<JsonObject?> = settings.observe(SYNCED_SETTINGS).map { it?.let(::objectOf) }

    suspend fun syncedSettingsNow(): JsonObject? = settings.get(SYNCED_SETTINGS)?.let(::objectOf)

    /**
     * The device's settings from the Journal notebook's device map, with no account (A1014): they
     * stand where the account's would, so every screen reads and changes them as before.
     */
    suspend fun useDeviceSettings(map: JsonObject) = settings.put(SettingEntity(SYNCED_SETTINGS, map.toString()))

    /** [changes] shown at once over the settings (a null removes one), while they are written. */
    suspend fun showSettingChanges(changes: Map<String, JsonElement?>) = db.withTransaction {
        val now = objectOf(settings.get(SYNCED_SETTINGS)).toMutableMap()
        for ((key, value) in changes) if (value == null || value is JsonNull) now.remove(key) else now[key] = value
        settings.put(SettingEntity(SYNCED_SETTINGS, JsonObject(now).toString()))
    }

    private fun settingsOf(synced: String?, pending: List<PendingSettingEntity>, refused: String?): SettingsState {
        var shown = Settings(objectOf(synced))
        for (row in pending) shown = shown.with(row.key, jsonOf(row.value))
        return SettingsState(shown, known = synced != null, unsent = pending.mapTo(HashSet()) { it.key }, refused = refusalOf(refused))
    }

    private fun refusalOf(json: String?): SettingsRefusal? {
        val stored = objectOf(json).takeIf { it.isNotEmpty() } ?: return null
        val keys = (stored["keys"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty()
        val message = (stored["message"] as? JsonPrimitive)?.content.orEmpty()
        return SettingsRefusal(keys, message)
    }

    /**
     * Changes a setting on this phone ([value] null: back to its default): it shows at once and is
     * sent with `PUT /api/settings` by the next pass, offline too (A411). One row per setting: a
     * second change replaces the first and keeps what the phone saw before the first, its base.
     * Changing it back to that removes the row, unless a value was sent for it without an answer
     * yet: the server may hold that one, so the row stays to put the base back (A411). False until
     * the server has sent any settings.
     */
    suspend fun changeSetting(key: String, value: JsonElement?): Boolean = db.withTransaction {
        val synced = settings.get(SYNCED_SETTINGS) ?: return@withTransaction false
        val wanted = value?.takeUnless { it is JsonNull }
        val row = pendingSettings.get(key)
        val base = (if (row != null) jsonOf(row.base) else objectOf(synced)[key])?.takeUnless { it is JsonNull }
        if (wanted == base && row?.sent == null) {
            if (row != null) pendingSettings.delete(key)
        } else {
            pendingSettings.put(PendingSettingEntity(key, wanted?.toString(), base?.toString(), now(), row?.sent))
        }
        // The capture sheet starts on the destination chosen here (A336), and captures still
        // waiting no longer change it when sent: the choice made here is the later one (A411).
        if (key == SettingKeys.CAPTURE) {
            settings.put(SettingEntity(CAPTURE_DESTINATION, (wanted as? JsonPrimitive)?.content ?: SettingDefaults.CAPTURE))
            db.captures().forgetDestination()
        }
        true
    }

    /**
     * The settings to send now, at most [limit] (the server takes 20 at once; the rest go in the
     * next request), each marked as sent with its value until the server answers: if the answer is
     * lost, a tree or a 409 that shows that value is known for this phone's own. Custom themes go
     * first, so a new theme lands no later than the `theme.id` that chooses it (A416).
     */
    suspend fun settingsToSend(limit: Int = SettingLimits.PER_REQUEST): List<PendingSettingEntity> = db.withTransaction {
        pendingSettings.all().sortedBy { !it.key.startsWith(SettingKeys.CUSTOM_THEME_PREFIX) }.take(limit).onEach { row ->
            val value = jsonOf(row.value)
            val sent = sentOf(row)
            if (value !in sent) pendingSettings.put(row.copy(sent = JsonArray(sent + value).toString()))
        }
    }

    /**
     * A custom theme's change survives a tree showing another version of it (T40 P1b, A417): the
     * server merges an edit onto whatever is stored, field by field, so another device's edit to
     * the theme is not a conflict, and a deletion always goes. Only an edit of a theme deleted
     * since (or a new theme whose id is taken) is dropped, as the server would refuse it.
     */
    private fun themeEditStands(row: PendingSettingEntity, now: JsonElement): Boolean {
        if (!row.key.startsWith(SettingKeys.CUSTOM_THEME_PREFIX)) return false
        val value = jsonOf(row.value) as? JsonObject ?: return false
        if (isDeletion(value)) return true
        val live = (now as? JsonObject)?.takeUnless(::isDeletion)
        return live != null && row.base != null
    }

    private fun isDeletion(theme: JsonObject) = (theme["deleted"] as? JsonPrimitive)?.content == "true"

    /**
     * A theme this phone made (its row has no base) and sent without an answer, which the server
     * now holds in another form than any sent (another device edited it since): this phone's own,
     * landed (A417). What was changed here since is not dropped but goes next.
     */
    private fun ownNewTheme(row: PendingSettingEntity, now: JsonElement): Boolean =
        row.key.startsWith(SettingKeys.CUSTOM_THEME_PREFIX) && row.base == null && madeHere(row) != null &&
            (now as? JsonObject)?.takeUnless(::isDeletion) != null

    /** The theme as this phone first sent it, made here. */
    private fun madeHere(row: PendingSettingEntity): JsonObject? =
        sentOf(row).firstNotNullOfOrNull { (it as? JsonObject)?.takeUnless(::isDeletion) }

    /**
     * Bases [row] on the theme as this phone made it, which the server holds: the server merges
     * the edit made since onto its copy, keeping the other device's edits (A416). The versions
     * sent stay known, for `baseToSend`.
     */
    private suspend fun basedOnOwnTheme(row: PendingSettingEntity) {
        pendingSettings.put(row.copy(base = madeHere(row).toString()))
    }

    /**
     * The base to send for [row]: what the phone saw before its change, or for a custom theme
     * with versions sent without an answer, one the server's merge cannot mistake for no change
     * (`ThemeEdits.sendingBase`, A416).
     */
    fun baseToSend(row: PendingSettingEntity): JsonElement {
        val base = jsonOf(row.base)
        val value = jsonOf(row.value) as? JsonObject
        if (!row.key.startsWith(SettingKeys.CUSTOM_THEME_PREFIX) || base !is JsonObject || value == null || isDeletion(value)) return base
        val sent = sentOf(row).mapNotNull { it as? JsonObject }.filterNot(::isDeletion)
        return ThemeEdits.sendingBase(base, value, sent)
    }

    private fun sentOf(row: PendingSettingEntity): List<JsonElement> =
        row.sent?.let { runCatching { PenmossJson.parseToJsonElement(it) as? JsonArray }.getOrNull() }.orEmpty()

    /**
     * The server holds [now], a value this phone sent for [row]: that change is done, and a newer
     * choice made since goes next, based on it.
     */
    private suspend fun landed(row: PendingSettingEntity, now: JsonElement) {
        if (jsonOf(row.value) == now) {
            pendingSettings.delete(row.key)
        } else {
            pendingSettings.put(row.copy(base = now.takeUnless { it is JsonNull }?.toString(), sent = null))
        }
    }

    /** The settings changed here and not sent yet, by key. */
    suspend fun pendingSettings(): List<PendingSettingEntity> = pendingSettings.all()

    suspend fun pendingSettingsCount(): Int = pendingSettings.count()

    /**
     * `PUT /api/settings` took [sent]: [now] is the settings as the server has them. Each row sent is
     * done; one changed again meanwhile stays to send, now based on what was sent, which the server
     * holds (as a move filed while another was made, A359).
     */
    suspend fun settingsSent(sent: List<PendingSettingEntity>, now: JsonObject) = db.withTransaction {
        if (settings.get(SYNCED_SETTINGS) != null) settings.put(SettingEntity(SYNCED_SETTINGS, now.toString()))
        for (done in sent) {
            val row = pendingSettings.get(done.key) ?: continue
            when {
                row.value == done.value -> pendingSettings.delete(done.key)
                else -> pendingSettings.put(row.copy(base = done.value, sent = null))
            }
        }
    }

    /**
     * The server refused [keys] as changed since their base (409); [server] is what it holds. A
     * setting it shows at a value this phone sent without an answer is this phone's own change,
     * landed: it is done or rebased, and the rest are dropped, a newer choice made elsewhere
     * winning (A410, A411). Returns how many were rebased, to send again.
     */
    suspend fun settingsOvertaken(keys: Collection<String>, server: JsonObject?): Int = db.withTransaction {
        var rebased = 0
        for (key in keys) {
            val row = pendingSettings.get(key) ?: continue
            val now = server?.let { it[key] ?: JsonNull }
            if (now != null && now in sentOf(row)) {
                landed(row, now)
                if (pendingSettings.get(key) != null) rebased++
            } else if (now != null && ownNewTheme(row, now)) {
                basedOnOwnTheme(row)
                rebased++
            } else {
                pendingSettings.delete(key)
            }
        }
        rebased
    }

    /**
     * The server will never take these changes (a 400, 413 or 403): they are dropped, and Settings
     * says which and why until the person dismisses it (A411).
     */
    suspend fun settingsRefused(keys: Collection<String>, message: String) = db.withTransaction {
        for (key in keys) pendingSettings.delete(key)
        val stored = JsonObject(mapOf("keys" to JsonArray(keys.map(::JsonPrimitive)), "message" to JsonPrimitive(message)))
        settings.put(SettingEntity(SETTINGS_REFUSED, stored.toString()))
    }

    suspend fun dismissSettingsRefusal() = db.withTransaction { settings.delete(SETTINGS_REFUSED) }

    /** Drops these changes without a word (tests, and a sign-in to another account). */
    suspend fun dropSettings(keys: Collection<String>) = db.withTransaction {
        for (key in keys) pendingSettings.delete(key)
    }

    private fun objectOf(json: String?): JsonObject =
        json?.let { runCatching { PenmossJson.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: JsonObject(emptyMap())

    private fun jsonOf(json: String?): JsonElement =
        json?.let { runCatching { PenmossJson.parseToJsonElement(it) }.getOrNull() } ?: JsonNull

    // --- wikilinks (A303) ---

    /** The phone's notes, newest first, each with its folder's name. */
    fun observeDirectory(): Flow<List<DirectoryEntry>> =
        combine(notes.observeDirectory(), db.folders().observeAll()) { rows, folders ->
            val names = folders.associate { it.id to it.name }
            rows.map { DirectoryEntry(it.id, it.title, it.folderId?.let(names::get)) }
        }

    /**
     * Stores a daily or weekly note the editor made (T40 P5): its whole content as one pending
     * edit, filed through the daily intent once uploaded. True when the note was stored here.
     *
     * - A note the phone lists is just opened, whether or not it holds the content: Today twice
     *   offline makes one note, and a note listed but not fetched yet is fetched by its screen
     *   (offline: unavailable), never rebuilt from this phone's template (review R1).
     * - A note in Trash is restored here at once, as the web's Today does, and filed through the
     *   daily intent, so it lands under Journal (A144, review S3); a move made here and still
     *   to file is kept instead.
     * - A note deleted for good is made afresh: its row and synced edits go, its kept-apart
     *   edits stay for their conflict copy, as a purge leaves them.
     */
    suspend fun addPeriodicNote(note: PageNote, kind: String, period: String, fileKind: String, fileDate: String): Boolean =
        db.withTransaction {
            val existing = notes.note(note.id)
            if (existing != null && !existing.gone) {
                if (existing.kind == "note" || existing.period == null) {
                    notes.updateKindPeriod(note.id, kind, period)
                }
                if (existing.deleted) {
                    // Cancels a move to Trash never tried, or queues a restore (A430).
                    notes.restoreHere(note.id, now())
                    // Then filed under Journal, unless a move made here waits to be filed first
                    // (moved, then trashed, A430): that choice stands (review R-N1).
                    val moveWaiting = existing.toFile && existing.fileKind == null
                    if (!moveWaiting) notes.fileDaily(note.id, fileKind, fileDate)
                }
                // Listed: the server has the note, so nothing is stored here, held or not. The
                // note's screen fetches what it does not hold, as the web's `ensurePeriodic`
                // leaves a listed note to the normal open; offline, it says the note is
                // unavailable. The page's bytes match the server's only for the same template
                // and codec, so storing them could add a second body to the note (A4, review R1).
                return@withTransaction false
            }
            if (existing != null) {
                updates.deleteSynced(note.id)
                notes.delete(note.id)
            }
            notes.insert(NoteEntity(note.id, title = note.title, updatedAt = now(), kind = kind, period = period, toFile = true))
            updates.insert(UpdateEntity(noteId = note.id, state = UpdateEntity.PENDING, update = note.update))
            notes.fileDaily(note.id, fileKind, fileDate)
            // Listed at the top level at once, offline too; the tree files it under Journal (T40 P5).
            placeAtEnd(note.id, null)
            true
        }

    /** Every daily or weekly note's kind and period, for the Journal calendar's marks (T40 P5). */
    fun observeJournalMarks(): Flow<List<JournalMark>> = notes.observeJournalMarks()

    /**
     * Stores a note the editor made (a link's new note, A303): its whole content as one
     * pending edit, filed in `fileIn` once uploaded. A note already stored is left alone.
     */
    suspend fun addLocalNote(note: PageNote, fileIn: String?): Boolean = db.withTransaction {
        if (notes.note(note.id) != null) return@withTransaction false
        notes.insert(NoteEntity(note.id, title = note.title, updatedAt = now(), toFile = true, fileIn = fileIn, moveNotebook = notebookOfFolder(fileIn)))
        updates.insert(UpdateEntity(noteId = note.id, state = UpdateEntity.PENDING, update = note.update))
        // Listed in its folder at once, offline too (T38); the tree says so once it is filed.
        placeAtEnd(note.id, fileIn?.takeIf { folderExists(it) })
        true
    }

    /**
     * Moves a note to [folderId] (null: the top level) on this phone (T38). The lists show it
     * there at once; the server is asked with `POST /api/notes/:id/move` once it can be, by the
     * same queue that files the notes made here (A303), so a move made offline syncs later.
     * Refused for a note the phone does not list (unknown, in Trash, deleted for good), and told
     * apart for a folder it does not know (#137, A658): then no note can move there.
     */
    suspend fun moveNote(noteId: String, folderId: String?): Move = db.withTransaction {
        if (folderId != null && !folderExists(folderId)) return@withTransaction Move.NO_FOLDER
        val note = notes.note(noteId) ?: return@withTransaction Move.REFUSED
        if (note.deleted || note.gone) return@withTransaction Move.REFUSED
        val current = if (note.toFile) note.fileIn else note.folderId
        if (current == folderId && note.folderId == folderId) return@withTransaction Move.ALREADY_THERE
        // Where the phone sees it now, sent with the move (T43, A766).
        notes.fileLater(noteId, folderId, notebookOfFolder(current))
        placeAtEnd(noteId, folderId)
        Move.MOVED
    }

    /** What [moveNote] did: [REFUSED] is the note's doing, [NO_FOLDER] the folder's. */
    enum class Move { MOVED, ALREADY_THERE, REFUSED, NO_FOLDER }

    // --- Trash (T40 P3a, NT12–NT15, A430) ---

    /**
     * Moves a note to Trash on this phone: it leaves every list at once, offline too, and the
     * server is asked (`POST /api/notes/:id/trash`) by a later pass, once the note's own edits
     * have gone. False for a note the phone does not list.
     */
    suspend fun moveToTrash(noteId: String): Boolean = db.withTransaction {
        val note = notes.note(noteId) ?: return@withTransaction false
        if (note.deleted || note.gone) return@withTransaction false
        notes.trashHere(noteId, now())
        true
    }

    /** What [restoreFromTrash] did. */
    enum class Restore {
        /** A move to Trash never tried: cancelled, so the server never knew. */
        CANCELLED,

        /** Restored here; the server is asked next, then the note is filed where it was. */
        QUEUED,

        /** Not in Trash (restored already), or deleted for good. */
        NOT_IN_TRASH,
    }

    /**
     * Takes a note out of Trash on this phone (NT14): back in the lists at once. A note the
     * phone only knows from the server's Trash ([title]) is added, to fetch once restored.
     */
    suspend fun restoreFromTrash(noteId: String, title: String = ""): Restore = db.withTransaction {
        val note = notes.note(noteId)
        if (note == null) notes.insertIgnore(NoteEntity(noteId, title = title, deleted = true))
        else if (!note.deleted || note.gone) return@withTransaction Restore.NOT_IN_TRASH
        // Tried with no answer: the server may have it in Trash, so a restore is queued (A430).
        val cancelled = note?.trashChange == NoteEntity.TRASH_QUEUED && !note.trashTried
        notes.restoreHere(noteId, now())
        if (cancelled) Restore.CANCELLED else Restore.QUEUED
    }

    /** Moves to Trash to send now: those whose own edits and move have all gone first. */
    suspend fun trashesDue(): List<NoteEntity> = notes.trashesDue()

    /** The last version list read for a note (T40 P3b, NT16): the server's answer as JSON. */
    suspend fun cachedHistory(noteId: String): HistoryCacheEntity? = db.historyCache().get(noteId)

    // --- links (T40 P7) ---

    /** Replaces the notes [noteId] links to (A473); never itself. */
    private suspend fun replaceLinks(noteId: String, targets: Collection<String>) {
        val links = db.noteLinks()
        links.clearFrom(noteId)
        links.insertAll(targets.filter { it != noteId }.distinct().map { NoteLinkEntity(noteId, it) })
    }

    /**
     * The notes the open note links to, as the editor page reads them from its own document
     * (T40 P7, A473): the phone's own edits show in backlinks before the server indexes them.
     */
    suspend fun setOwnLinks(noteId: String, targets: List<String>) = db.withTransaction {
        if (db.noteLinks().targetsOf(noteId) != targets.filter { it != noteId }.distinct().sorted()) {
            replaceLinks(noteId, targets)
            ownLinksAt.update { it + (noteId to now()) }
        }
    }

    /**
     * Notes edited here that the server's index may not have reached (T40 P7 review S3, as the
     * web's `withRecent`): those with edits not sent, and those whose links the page changed in
     * the last [INDEX_LAG_MS]. For them Room's links, not the server's backlinks, say whether
     * they link to a note. The second set is this process's only: after a restart the index
     * has long caught up.
     */
    fun observeRecentLinkers(): Flow<Set<String>> =
        combine(updates.observePendingNoteIds(), ownLinksAt) { pending, own ->
            val since = now() - INDEX_LAG_MS
            pending.toSet() + own.filterValues { it > since }.keys
        }


    /** The notes [noteId] links to, sorted. */
    suspend fun linksOf(noteId: String): List<String> = db.noteLinks().targetsOf(noteId)

    /** What the graph is drawn from (T40 P7, LK7, LK8; A478): live notes, their links, the folders. */
    fun observeGraph(): Flow<GraphSource> =
        combine(notes.observeDirectory(), db.noteLinks().observeAll(), db.folders().observeAll(), observeRootSortMode(), ::GraphSource)

    /** The graph without closed notebooks (T43, A752): their notes, links and folders left out. */
    fun observeGraph(hidden: Flow<Set<String>>): Flow<GraphSource> = combine(observeGraph(), hidden) { source, shut ->
        if (shut.isEmpty()) {
            source
        } else {
            val notes = source.notes.filter { it.folderId == null || it.folderId !in shut }
            val live = notes.mapTo(HashSet()) { it.id }
            GraphSource(
                notes,
                source.links.filter { it.sourceId in live && it.targetId in live },
                source.folders.filter { it.id !in shut },
                source.rootSortMode,
            )
        }
    }

    /** The live notes linking to [noteId], most recently edited first (LK5), offline. */
    fun observeBacklinkSources(noteId: String): Flow<List<BacklinkSource>> = db.noteLinks().observeSources(noteId)

    suspend fun cachedBacklinks(noteId: String): BacklinksCacheEntity? = db.backlinksCache().get(noteId)

    suspend fun cacheBacklinks(noteId: String, json: String) {
        db.backlinksCache().put(BacklinksCacheEntity(noteId, json, now()))
    }

    /** A stamp that moves whenever the note's content the page reads changes (T40 P7, A471). */
    fun observeContentStamp(noteId: String): Flow<String> = updates.observeContentStamp(noteId)

    /** Keeps the last version list read, so the history screen still reads offline. */
    suspend fun cacheHistory(noteId: String, json: String) =
        db.historyCache().put(HistoryCacheEntity(noteId, json, now()))

    suspend fun restoresDue(): List<NoteEntity> = notes.restoresDue()

    /** A pass that ended with a change in flight (the process stopped): queued again. */
    suspend fun requeueTrashInFlight() = notes.requeueInFlight()

    /**
     * About to send this note's move to Trash: in flight, so Undo or Restore meanwhile queues a
     * restore rather than cancelling a move the server may already have. False if it changed.
     */
    suspend fun trashSending(noteId: String): Boolean =
        notes.trashChanged(noteId, NoteEntity.TRASH_QUEUED, NoteEntity.TRASH_SENDING) == 1

    /** About to send this note's restore: Move to Trash meanwhile queues a move. */
    suspend fun restoreSending(noteId: String): Boolean =
        notes.trashChanged(noteId, NoteEntity.RESTORE_QUEUED, NoteEntity.RESTORE_SENDING) == 1

    /**
     * The move to Trash got no answer that says what Penmoss did (offline, a server error):
     * queued again (unless undone meanwhile), still tried, as it may have reached the server.
     */
    suspend fun trashNotSent(noteId: String) =
        notes.trashChanged(noteId, NoteEntity.TRASH_SENDING, NoteEntity.TRASH_QUEUED)

    /** The restore got no answer that says what Penmoss did: queued again, still tried. */
    suspend fun restoreNotSent(noteId: String) =
        notes.trashChanged(noteId, NoteEntity.RESTORE_SENDING, NoteEntity.RESTORE_QUEUED)

    /**
     * The server has it in Trash since [deletedAt] (its clock, shown only), made after index seq
     * [seq]: held so until a later row comes. Restored here while it was in flight: that
     * restore stays queued and goes next.
     */
    suspend fun trashSent(noteId: String, deletedAt: Long, seq: Long) {
        notes.trashConfirmed(noteId, NoteEntity.TRASH_SENDING, NoteEntity.TRASH_SENT, seq, deletedAt)
    }

    /**
     * Restored on another device since this phone last saw the note (409 `restored_since`): it
     * stays out of Trash, and the person is told ([observeTrashNotices]). The notice is kept in
     * the database, so one met by a background pass is said when the app is next open.
     */
    suspend fun trashRefused(noteId: String) {
        notes.trashRefused(noteId)
    }

    /** Notes whose move to Trash a restore elsewhere overruled, not said yet, oldest first. */
    fun observeTrashNotices(): Flow<List<TrashNotice>> = notes.observeTrashNotices()

    suspend fun trashNoticeShown(noteId: String) = notes.trashNoticeShown(noteId)

    /**
     * The server restored it ([restored]; false: it was not in Trash there), from [folderId]
     * (null: the top level), after index seq [seq]. It is filed back there by the next pass (a
     * folder gone since is the server's to place, never the top level of another notebook, A757), and listed there now,
     * or at the top level while this phone does not know that folder. Moved to Trash here while
     * the restore was in flight: it is still filed first, so that move records the folder.
     */
    suspend fun restoreSent(noteId: String, folderId: String?, restored: Boolean, seq: Long) = db.withTransaction {
        notes.trashConfirmed(noteId, NoteEntity.RESTORE_SENDING, NoteEntity.RESTORE_SENT, seq, now())
        val row = notes.note(noteId) ?: return@withTransaction
        // The server's restore is this phone's own: its view includes it, so a later move to
        // Trash is never refused over it (A431).
        if (seq + 1 > row.seq) notes.seenSeq(noteId, seq + 1)
        if (!restored) return@withTransaction
        notes.fileRestored(noteId, folderId, notebookOfFolder(folderId))
        if (!row.deleted) placeAtEnd(noteId, folderId?.takeIf { folderExists(it) })
    }

    /**
     * The server restored nothing (409 `restore_needs_folder`, T43 A757: fail closed): the folder
     * the note was deleted from is gone and its way up passes a deleted notebook ([notebookId],
     * [notebookName]; null when Trash forgot it). The note goes back to Trash here, and the
     * question is kept (in the database, so one a background pass met is asked when Trash is next
     * open): restore that notebook first, choose a folder, or leave it in Trash.
     */
    suspend fun restoreNeedsFolder(noteId: String, notebookId: String?, notebookName: String?, message: String) = db.withTransaction {
        if (notes.restoreRefused(noteId) == 0) return@withTransaction
        val title = notes.note(noteId)?.title.orEmpty()
        val asked = restoreQuestionsOf(settings.get(RESTORE_QUESTIONS)).filter { it.noteId != noteId } +
            RestoreQuestion(noteId, title, notebookId, notebookName.orEmpty(), message)
        settings.put(SettingEntity(RESTORE_QUESTIONS, PenmossJson.encodeToString(RESTORE_QUESTION_LIST, asked)))
    }

    /** Restores waiting for the person to say where the note goes (T43, A757), oldest first. */
    fun observeRestoreQuestions(): Flow<List<RestoreQuestion>> = settings.observe(RESTORE_QUESTIONS).map(::restoreQuestionsOf)

    /** The person answered (or cancelled) the question for [noteId]. */
    suspend fun restoreQuestionAnswered(noteId: String) = db.withTransaction {
        val kept = restoreQuestionsOf(settings.get(RESTORE_QUESTIONS)).filter { it.noteId != noteId }
        if (kept.isEmpty()) settings.delete(RESTORE_QUESTIONS)
        else settings.put(SettingEntity(RESTORE_QUESTIONS, PenmossJson.encodeToString(RESTORE_QUESTION_LIST, kept)))
    }

    private fun restoreQuestionsOf(json: String?): List<RestoreQuestion> =
        json?.let { runCatching { PenmossJson.decodeFromString(RESTORE_QUESTION_LIST, it) }.getOrNull() }.orEmpty()

    /**
     * The server restored the note into the folder the person chose (T43, A757: `{ folderId }`):
     * out of Trash here, and filed there by the next pass, as any restore is ([restoreSent]). The
     * question goes.
     */
    suspend fun restoredInto(noteId: String, folderId: String?, restored: Boolean, seq: Long) = db.withTransaction {
        restoreQuestionAnswered(noteId)
        val note = notes.note(noteId) ?: return@withTransaction
        if (note.gone) return@withTransaction
        if (note.deleted) notes.restoreHere(noteId, now())
        // Settled as this phone's own restore: in flight, then answered.
        val row = notes.note(noteId) ?: return@withTransaction
        notes.trashChanged(noteId, row.trashChange, NoteEntity.RESTORE_SENDING)
        restoreSent(noteId, folderId, restored, seq)
    }

    /**
     * A restore, or a move to Trash, of a note the server does not have (404 "No such note":
     * deleted for good, or never there): nothing to send, and this copy goes, its unsent edits
     * kept apart for their conflict copy (A310). Whatever was asked meanwhile goes with it.
     */
    suspend fun trashGone(noteId: String) = db.withTransaction {
        val note = notes.note(noteId) ?: return@withTransaction
        notes.trashChanged(noteId, note.trashChange, 0)
        dropPurged(noteId)
    }

    /**
     * Penmoss answered a move to Trash with a 404 that does not say the note is gone: most
     * likely its server is from before `POST /api/notes/:id/trash` (A431), which answers a plain
     * "404 Not Found". Moves to Trash wait, and Trash and Sync and storage
     * say why. Cleared by the first move it takes.
     */
    suspend fun setTrashRouteMissing(missing: Boolean) {
        if (missing) settings.put(SettingEntity(TRASH_ROUTE_MISSING, "1")) else settings.delete(TRASH_ROUTE_MISSING)
    }

    fun observeTrashRouteMissing(): Flow<Boolean> = settings.observe(TRASH_ROUTE_MISSING).map { it == "1" }

    /** Trash as the phone holds it, newest first (NT13). */
    fun observeTrash(): Flow<List<TrashRow>> = notes.observeTrash()

    suspend fun trashChangesWaiting(): Int = notes.trashChangesWaiting()

    /**
     * Deleted for good (NT15, or a tombstone from `/sync/changes`, T21): what the server had
     * goes, but never this phone's unsent edits nor the note they need; they are kept apart for
     * their conflict copy and the note leaves every list (A306, A310).
     */
    suspend fun purged(noteId: String) = db.withTransaction { dropPurged(noteId) }

    private suspend fun dropPurged(noteId: String) {
        // The cached version list goes with the note (T40 P3b fixup): one small row per note ever
        // read, never evicted otherwise.
        db.historyCache().delete(noteId)
        // And its toggles kept on this phone (T40 P8 review).
        db.folds().delete(noteId)
        // Its links and the backlinks read for it (T40 P7): a purged note links nowhere.
        db.noteLinks().clearFrom(noteId)
        // Links to it too: the server unresolves them without moving the sources (review N2).
        db.noteLinks().clearTo(noteId)
        db.backlinksCache().delete(noteId)
        // Out of the offline index, and its tags with it (T40 P6).
        search.deleteText(noteId)
        search.clearTags(noteId)
        if (updates.count(noteId, UpdateEntity.WITHHELD) > 0) {
            // A git notebook's copy withheld from the push (A886): all of it stays aside, its
            // pending edits too, and its row with its title, out of every list.
            updates.withholdRest(noteId)
            notes.markGone(noteId)
            return
        }
        if (updates.unsentCount(noteId) == 0) {
            updates.deleteSynced(noteId)
            notes.delete(noteId)
        } else {
            val epoch = notes.note(noteId)?.epoch
            updates.keepAsBase(noteId, epoch)
            updates.keepPendingApart(noteId, epoch)
            notes.markGone(noteId)
        }
    }

    /**
     * Where the lists show a note: where a move not filed yet takes it, else where the tree has it.
     */
    suspend fun folderOf(noteId: String): String? = notes.note(noteId)?.folderId

    /** Notes made or moved here that the server has, to file in the tree. */
    suspend fun readyToFile(): List<NoteEntity> = notes.readyToFile()

    /**
     * Filed in [fileIn] (the server put it in [landed]: the nearest folder above within its
     * notebook when that folder had gone, T43 A757), or that move dropped. A later move made meanwhile stays to file, checked against [landed].
     */
    suspend fun markFiled(noteId: String, fileIn: String?, landed: String? = fileIn) = db.withTransaction {
        notes.filed(noteId, fileIn)
        notes.nowIn(noteId, landed)
    }

    /** The server refused the move for good (the note is in Trash, or was moved since): dropped. */
    suspend fun dropMove(noteId: String, fileIn: String?) = notes.filed(noteId, fileIn)

    private suspend fun folderExists(folderId: String): Boolean = db.folders().exists(folderId)

    /**
     * The notebook [folderId] is in as this phone's tree has it (T43, A766): a notebook's folder id,
     * or `default` for the default notebook, the top level and a folder the phone does not know
     * (the server compares, and holds the note when they differ: fail closed).
     */
    suspend fun notebookOfFolder(folderId: String?): String =
        Notebooks.index(db.folders().all()).ofFolder(folderId) ?: Notebooks.DEFAULT

    /** The notebook a note is in as this phone shows it: where a move not filed yet takes it, else the tree's. */
    suspend fun notebookOfNote(noteId: String): String {
        val note = notes.note(noteId) ?: return Notebooks.DEFAULT
        return notebookOfFolder(if (note.toFile) note.fileIn else note.folderId)
    }

    /** Shows a note at the end of a folder (A17's order keys compare as strings; any longer key sorts after). */
    private suspend fun placeAtEnd(noteId: String, folderId: String?) {
        val last = notes.lastPosition(folderId).orEmpty()
        notes.place(noteId, folderId, last + END_KEY)
    }

    // --- tags (T38) ---

    /**
     * The workspace's tags and how many notes carry each, as `/api/tags` last said, for the
     * tag sheet's suggestions offline too. Tags themselves live in each note's document.
     */
    fun observeTagList(): Flow<List<TagCount>> = settings.observe(TAG_LIST).map(::tagsOf)

    suspend fun saveTagList(tags: List<TagCount>) = settings.put(SettingEntity(TAG_LIST, PenmossJson.encodeToString(TAG_LIST_JSON, tags)))

    /** A tag added on this phone is suggested at once, before the server has indexed it. */
    suspend fun rememberTag(tag: String) = db.withTransaction {
        val known = tagsOf(settings.get(TAG_LIST))
        if (known.none { it.name == tag }) saveTagList(known + TagCount(tag, 1))
    }

    private fun tagsOf(json: String?): List<TagCount> =
        json?.let { runCatching { PenmossJson.decodeFromString(TAG_LIST_JSON, it) }.getOrNull() }.orEmpty()

    // --- folders (T40 P4, NT2–NT7, A443) ---

    /** Folder changes made here and not sent yet, oldest first. */
    suspend fun folderOpsDue(): List<FolderOpEntity> = db.folderOps().all()

    /** Folder changes made here: signing out keeps them (A443). */
    suspend fun folderOpsWaiting(): Int = db.folderOps().count()

    /**
     * Makes a folder here (NT2): shown at once in its parent, queued to send, offline too.
     * Returns its id (this phone's ULID, which the server's idempotent create reuses).
     * Refused for a parent the phone does not know.
     */
    suspend fun createFolder(name: String, parentId: String?): String? = db.withTransaction {
        if (parentId != null && db.folders().get(parentId) == null) return@withTransaction null
        val id = Ulid.next()
        db.folders().put(FolderEntity(id, name, parentId, endFolderPosition(parentId), FolderTree.MANUAL))
        db.folderOps().insert(
            FolderOpEntity(folderId = id, kind = FolderOpEntity.CREATE, name = name, parentId = parentId, label = name),
        )
        id
    }

    /**
     * Renames a folder here (NT3): shown at once, queued with what was seen, so a rename made
     * elsewhere since wins (409, as moves do, A359). False for a folder the phone does not know.
     */
    suspend fun renameFolder(id: String, name: String): Boolean = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction false
        db.folders().rename(id, name)
        db.folderOps().insert(
            FolderOpEntity(
                folderId = id, kind = FolderOpEntity.RENAME, name = name,
                fromName = folder.name, checkName = true, label = name,
            ),
        )
        true
    }

    /** What [moveFolder] did; [NOTEBOOK_RULE]: a notebook into a folder, or Journal or the Inbox into a notebook (T43). */
    enum class FolderMove { MOVED, ALREADY_THERE, REFUSED, NOTEBOOK_RULE }

    /**
     * Moves a folder here (NT4, NT5): shown at once at its new parent's end, queued with the
     * parent seen, so a move made elsewhere since wins (409). Refused for an unknown folder or
     * parent, or moving into itself or a subfolder (the server refuses those too).
     */
    suspend fun moveFolder(id: String, parentId: String?): FolderMove = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction FolderMove.REFUSED
        if (parentId != null && db.folders().get(parentId) == null) return@withTransaction FolderMove.REFUSED
        if (parentId != null && isWithin(id, parentId)) return@withTransaction FolderMove.REFUSED
        if (folder.parentId == parentId) return@withTransaction FolderMove.ALREADY_THERE
        if (Notebooks.moveRefusal(db.folders().all(), id, parentId) != null) return@withTransaction FolderMove.NOTEBOOK_RULE
        // The notebook the phone sees it in before the move, sent with it (T43, A766).
        val fromNotebook = notebookOfFolder(id)
        db.folders().move(id, parentId, endFolderPosition(parentId, exclude = id))
        db.folderOps().insert(
            FolderOpEntity(
                folderId = id, kind = FolderOpEntity.MOVE, parentId = parentId,
                fromParentId = folder.parentId, checkParent = true, label = folder.name,
                fromNotebook = fromNotebook,
            ),
        )
        FolderMove.MOVED
    }

    /** Whether [folderId] sits inside [id] (or is it): a move there would be a cycle (NT5). */
    private suspend fun isWithin(id: String, folderId: String): Boolean {
        var current: String? = folderId
        val seen = HashSet<String>()
        while (current != null && seen.add(current)) {
            if (current == id) return true
            current = db.folders().get(current)?.parentId
        }
        return false
    }

    /**
     * What deleting a folder here asks about (NT4): how many notes and subfolders move up, and
     * to where. Null for a folder the phone does not know.
     */
    data class FolderDeleteSummary(
        val notes: Int,
        val subfolders: Int,
        val destination: String?,
        /** A notebook (T43, A755): its notes go to Trash with it, never up. */
        val notebook: Boolean = false,
    )

    suspend fun folderDeleteSummary(id: String): FolderDeleteSummary? = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction null
        val all = db.folders().all()
        val subtree = subtreeIds(all, id)
        val notes = db.notes().inFolders(subtree.toList()).size
        FolderDeleteSummary(
            notes = notes,
            subfolders = subtree.size - 1,
            destination = all.firstOrNull { it.id == folder.parentId }?.name,
            notebook = folder.notebook,
        )
    }

    /**
     * Deletes a folder and its subfolders here (NT4): their notes move up at once, offline too,
     * as the server deletes them. Changes queued for the subtree never reach the server: a create
     * and its delete cancel out silently — unless the create was tried with no answer (the
     * server may hold the folder), when the delete is queued instead (T40 P4 review B3; DELETE
     * is idempotent, so sending it when unsure is safe).
     */
    suspend fun deleteFolder(id: String): Boolean = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction false
        val all = db.folders().all()
        val subtree = subtreeIds(all, id)
        // A folder made here and deleted before anything was sent never reaches the server: its
        // queued changes go silently, and no delete is queued. Anything else queues one delete.
        val queued = db.folderOps().all()
        val createdHere = queued.any { it.folderId == id && it.kind == FolderOpEntity.CREATE }
        val tried = queued.any { it.folderId == id && it.kind == FolderOpEntity.CREATE && it.tried }
        for (fid in subtree) db.folderOps().deleteFor(fid)
        if (!createdHere || tried) {
            db.folderOps().insert(FolderOpEntity(folderId = id, kind = FolderOpEntity.DELETE, label = folder.name))
        }
        val notes = db.notes().inFolders(subtree.toList())
        if (folder.notebook) {
            // A notebook goes to Trash with its notes (T43, A755), as the server's delete does:
            // never up into the default notebook, whose mirror would publish them. Notes made here
            // and not filed yet are not the server's to trash: they are filed at the top level,
            // as for a folder gone (A352).
            db.notes().trashWithNotebook(notes.filter { !it.toFile }.map { it.id }, now())
            for (fid in subtree) db.folders().delete(fid)
            return@withTransaction true
        }
        // Their notes move up to the deleted folder's parent (null when it has gone), at its end.
        val destination = folder.parentId?.takeIf { pid -> all.any { it.id == pid } }
        var last = lastNotePosition(destination)
        for (note in notes.sortedWith { a, b -> FolderTree.compareOrder(a.position, a.id, b.position, b.id) }) {
            if (note.toFile) continue
            last += END_KEY
            db.notes().place(note.id, destination, last)
        }
        for (fid in subtree) db.folders().delete(fid)
        true
    }

    /**
     * Sets a folder's sort mode here (NT6), or the top level's when [id] is null: shown at once,
     * queued to send (last write wins). False for a folder the phone does not know.
     */
    suspend fun setSortMode(id: String?, mode: String): Boolean = db.withTransaction {
        if (mode != FolderTree.MANUAL && mode != FolderTree.ALPHA && mode != FolderTree.MODIFIED) {
            return@withTransaction false
        }
        if (id == null) {
            settings.put(SettingEntity(ROOT_SORT_MODE, mode))
            // Choosing again replaces the choice not sent yet: last write wins, one request.
            db.folderOps().deleteKind(null, FolderOpEntity.ROOT_SORT)
            db.folderOps().insert(FolderOpEntity(folderId = null, kind = FolderOpEntity.ROOT_SORT, sortMode = mode))
        } else {
            if (db.folders().get(id) == null) return@withTransaction false
            db.folders().setSortMode(id, mode)
            db.folderOps().deleteKind(id, FolderOpEntity.SORT)
            db.folderOps().insert(
                FolderOpEntity(folderId = id, kind = FolderOpEntity.SORT, sortMode = mode, label = db.folders().get(id)?.name),
            )
        }
        true
    }

    /**
     * Reorders a folder among its siblings here (NT7): shown at once at the anchor, queued as
     * `place`, which the server computes from its live document. A missing anchor means the end.
     * False for a folder the phone does not know.
     */
    suspend fun reorderFolder(id: String, before: String?, after: String?): Boolean = db.withTransaction {
        val folder = db.folders().get(id) ?: return@withTransaction false
        val siblings = db.folders().children(folder.parentId).map { FolderTree.ReorderSibling(it.id, it.position) }
        val key = FolderTree.reorderKey(siblings, id, before, after)
        db.folders().setPosition(id, key.position)
        db.folderOps().insert(
            FolderOpEntity(
                folderId = id, kind = FolderOpEntity.REORDER,
                placeBefore = key.before, placeAfter = key.after, label = folder.name,
            ),
        )
        true
    }

    /**
     * Reorders a note within its folder here (NT7): shown at once at the anchor, filed with
     * `place` (a same-folder move with a precondition, as T38 files moves). A missing anchor
     * means the end. False for a note the phone does not list, or one in Trash or gone.
     */
    suspend fun reorderNote(id: String, before: String?, after: String?): Boolean = db.withTransaction {
        val note = notes.note(id) ?: return@withTransaction false
        if (note.deleted || note.gone) return@withTransaction false
        // A note the tree does not place (the server's registry lacks it) and this phone did not
        // make: listed, never written into the tree here, as a reorder would file it (T43, A766).
        if (!note.toFile && note.folderId == null && note.position.isEmpty()) return@withTransaction false
        val folderId = if (note.toFile) note.fileIn else note.folderId
        val siblings = notes.inFolder(folderId).map { FolderTree.ReorderSibling(it.id, it.position) }
        val key = FolderTree.reorderKey(siblings, id, before, after)
        notes.place(id, folderId, key.position)
        if (!note.toFile) notes.fileLater(id, folderId, notebookOfFolder(folderId))
        notes.setPlace(id, key.before, key.after)
        true
    }

    /** Drops a sent folder change (T40 P4). */
    suspend fun dropFolderOp(rowId: Long) = db.folderOps().delete(rowId)

    /** A folder change went out and its answer never came: the server may hold it (T40 P4 review B3). */
    suspend fun markFolderOpTried(rowId: Long) = db.folderOps().markTried(rowId)

    /**
     * Drops one sent folder change the server refused for good, and says why once (T43, A757): a
     * move into a parent gone since with no safe place for it. The folder's other changes go on.
     */
    suspend fun dropFolderOp(rowId: Long, label: String?, reason: FolderDropReason) = db.withTransaction {
        db.folderOps().delete(rowId)
        noticeFolderChange(folderDropText(label, reason))
    }

    /**
     * A folder the server no longer has: its queued changes are dropped, and the person is told
     * once, naming it (T40 P4). [reason] says how it went: gone (404), or overtaken by a rename
     * or a move made elsewhere (409), which the notice names (T40 P4 review B2). A queued delete
     * is already the wanted end state: dropped silently.
     */
    suspend fun dropFolderOpsFor(
        folderId: String,
        label: String?,
        reason: FolderDropReason = FolderDropReason.DELETED,
        /** The notebook it went to Trash with ([FolderDropReason.IN_TRASH]), when the server named it. */
        notebook: String? = null,
    ) {
        val ops = db.folderOps().all().filter { it.folderId == folderId }
        if (ops.isEmpty()) return
        db.withTransaction {
            db.folderOps().deleteFor(folderId)
            if (ops.any { it.kind != FolderOpEntity.DELETE }) {
                noticeFolderChange(folderDropText(label, reason, notebook))
            }
        }
    }

    /**
     * The server refused a folder's change under the notebook rules (422 `notebook_rule`, T43):
     * its queued changes are dropped and [message], the server's, is said once.
     */
    suspend fun refuseFolderOpsFor(folderId: String, message: String) = db.withTransaction {
        db.folderOps().deleteFor(folderId)
        noticeFolderChange(message.trim().removeSuffix(".") + ".")
    }

    private fun folderDropText(label: String?, reason: FolderDropReason, notebook: String? = null): String {
        val named = "“${label ?: "Untitled folder"}”"
        return when (reason) {
            FolderDropReason.DELETED -> "$named was deleted on another device, so the change was dropped."
            FolderDropReason.RENAMED -> "$named was renamed on another device, so the change was dropped."
            FolderDropReason.MOVED -> "$named was moved on another device, so the change was dropped."
            FolderDropReason.PARENT_GONE ->
                "The folder $named was going into was deleted on another device, and nowhere else in its notebook is safe, so the change was dropped."
            FolderDropReason.IN_TRASH -> notebook?.trim()?.takeIf { it.isNotEmpty() }?.let { name ->
                "$named went to Trash with the notebook “$name”, which was deleted on another device. Restore “$name” from Trash to get it back."
            } ?: "$named went to Trash with its notebook, which was deleted on another device. Restore the notebook from Trash to get it back."
        }
    }

    /**
     * How a folder change was dropped: gone on another device, or overtaken by a rename or move
     * there; or (T43, A757) its parent gone with no safe place for it ([PARENT_GONE]), or made in
     * Trash with its notebook, deleted elsewhere ([IN_TRASH]). Never sent again at the top level.
     */
    enum class FolderDropReason { DELETED, RENAMED, MOVED, PARENT_GONE, IN_TRASH }

    /** Folder changes the server refused, not said yet, oldest first. */
    fun observeFolderNotices(): Flow<List<String>> = settings.observe(FOLDER_NOTICES).map(::folderNoticesOf)

    suspend fun dismissFolderNotice(text: String) = db.withTransaction {
        val kept = folderNoticesOf(settings.get(FOLDER_NOTICES)).filter { it != text }
        settings.put(SettingEntity(FOLDER_NOTICES, PenmossJson.encodeToString(FOLDER_NOTICE_LIST, kept)))
    }

    private suspend fun noticeFolderChange(text: String) {
        val kept = (folderNoticesOf(settings.get(FOLDER_NOTICES)) + text).takeLast(5)
        settings.put(SettingEntity(FOLDER_NOTICES, PenmossJson.encodeToString(FOLDER_NOTICE_LIST, kept)))
    }

    /**
     * Folder changes made here, laid over a tree just read (T40 P4, A443). Runs inside
     * [saveTree]'s transaction: creates reappear with their parent (listed at the top level on
     * this phone only while it has gone: the server places it, never there for a notebook's
     * folder, A757), renames, moves, sorts and reorders apply again, and
     * changes for folders the tree no longer has are dropped with a notice (deleted elsewhere).
     * The top level's sort, which lives in settings, is applied last.
     */
    private suspend fun reapplyFolderOps(treeIds: Set<String>) {
        val known = treeIds.toHashSet()
        for (op in db.folderOps().all()) {
            when (op.kind) {
                FolderOpEntity.CREATE -> {
                    val id = op.folderId ?: continue
                    if (db.folders().get(id) == null) {
                        val parent = op.parentId?.takeIf { it in known }
                        db.folders().put(
                            FolderEntity(
                                id, op.name ?: "Untitled folder", parent, endFolderPosition(parent), FolderTree.MANUAL,
                                notebook = op.notebook && parent == null,
                            ),
                        )
                    }
                    known += id
                }
                FolderOpEntity.RENAME -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else db.folders().rename(folder.id, op.name ?: folder.name)
                }
                FolderOpEntity.MOVE -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else db.folders().move(folder.id, op.parentId?.takeIf { it in known }, endFolderPosition(op.parentId?.takeIf { it in known }, exclude = folder.id))
                }
                FolderOpEntity.SORT -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else db.folders().setSortMode(folder.id, op.sortMode ?: FolderTree.MANUAL)
                }
                FolderOpEntity.REORDER -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else {
                        val siblings = db.folders().children(folder.parentId).map { FolderTree.ReorderSibling(it.id, it.position) }
                        val key = FolderTree.reorderKey(siblings, folder.id, op.placeBefore, op.placeAfter)
                        db.folders().setPosition(folder.id, key.position)
                    }
                }
                FolderOpEntity.DELETE -> {
                    // The tree still has it: the sender deletes it. Gone already: the wanted end state.
                    if (op.folderId != null && db.folders().get(op.folderId) == null) db.folderOps().delete(op.rowId)
                }
                FolderOpEntity.ROOT_SORT -> settings.put(SettingEntity(ROOT_SORT_MODE, op.sortMode ?: FolderTree.MANUAL))
                // T43 (A756): the flag as asked here; a folder gone elsewhere drops it with a notice.
                FolderOpEntity.NOTEBOOK -> {
                    val folder = op.folderId?.let { db.folders().get(it) }
                    if (folder == null) dropFolderOpsFor(op.folderId!!, op.label)
                    else db.folders().put(folder.copy(notebook = op.notebook))
                }
                FolderOpEntity.ROOT_NAME -> {
                    val name = op.name?.trim().orEmpty()
                    if (name.isEmpty()) settings.delete(DEFAULT_NOTEBOOK) else settings.put(SettingEntity(DEFAULT_NOTEBOOK, name))
                }
            }
        }
    }

    private fun folderNoticesOf(json: String?): List<String> =
        json?.let { runCatching { PenmossJson.decodeFromString(FOLDER_NOTICE_LIST, it) }.getOrNull() }.orEmpty()

    /** A folder and every folder below it, depth first (T40 P4, NT4). */
    private fun subtreeIds(all: List<FolderEntity>, id: String): Set<String> {
        val out = LinkedHashSet<String>()
        fun visit(folderId: String) {
            if (!out.add(folderId)) return
            for (child in all.filter { it.parentId == folderId }) visit(child.id)
        }
        visit(id)
        return out
    }

    /** Shows a folder at the end of its parent (T40 P4, NT2): the next key after the last sibling. */
    private suspend fun endFolderPosition(parentId: String?, exclude: String? = null): String {
        val siblings = db.folders().children(parentId).filter { it.id != exclude }.map { it.id to it.position }
        return FolderTree.reorderKey(siblings.map { FolderTree.ReorderSibling(it.first, it.second) }, exclude ?: "", null, null).position
    }

    /** The last position among a folder's notes, so a note moved up shows at its end (NT4). */
    private suspend fun lastNotePosition(folderId: String?): String = notes.lastPosition(folderId).orEmpty()

    // --- conflict copies (A306, A309) ---

    /** A conflict copy already made of edits of the same copy, which later ones may be merged into. */
    data class CopyTarget(val noteId: String, val updates: List<StoredUpdate>)

    /**
     * Edits kept apart from a note ([edits]), made on the copy of [epoch], and everything they
     * may build on ([base]): what the server had of that copy, and the edits of it a conflict copy
     * already holds. [into] is that conflict copy, when the phone has it.
     */
    data class ConflictSet(
        val noteId: String,
        val epoch: String?,
        val base: List<StoredUpdate>,
        val edits: List<StoredUpdate>,
        val into: CopyTarget? = null,
    )

    /** Notes holding edits kept apart, oldest first. */
    suspend fun notesWithConflicts(limit: Int = 20): List<String> = updates.notesWithConflicts(limit)

    fun observeConflictCount(): Flow<Int> = updates.observeConflictCount()

    /**
     * How many notes hold edits kept apart and waiting for a conflict copy: Home says so, since
     * a background pass can keep edits apart but only an open editor makes the copy (A323).
     */
    fun observeConflictNotes(): Flow<Int> = updates.observeConflictNotes()

    /** Edits no copy can be made of, kept on this phone (A309): shown on the Settings screen. */
    fun observeKeptCount(): Flow<Int> = updates.observeKeptCount()

    fun observeUnsentCount(noteId: String): Flow<Int> = updates.observeUnsentCount(noteId)

    /** Note titles and folder names: what feedback's Recent errors are scrubbed of (A427, A791). */
    suspend fun names(): List<String> = notes.titles() + db.folders().names()

    /**
     * The oldest group of a note's edits kept apart (those made on one copy) and what they may
     * build on: the base rows kept for its epoch, or what the phone holds when it is still the
     * server's copy (edits it refused for good), with the edits of that copy already copied. Null
     * when the note has none. Never made up: with no base for a replaced copy, the base is only
     * the copied edits, and the page refuses a copy whose edits lack what they build on.
     */
    suspend fun conflictSet(noteId: String): ConflictSet? = db.withTransaction {
        val conflicts = updates.updates(noteId, UpdateEntity.CONFLICT)
        if (conflicts.isEmpty()) return@withTransaction null
        // One copy at a time: the edits made on the same copy as the oldest one.
        val epoch = conflicts.first().epoch
        val edits = conflicts.filter { it.epoch == epoch }
        val copied = updates.updates(noteId, UpdateEntity.COPIED).filter { it.epoch == epoch }
        val bases = updates.updates(noteId, UpdateEntity.BASE).filter { it.epoch == epoch }
        val base = when {
            bases.isNotEmpty() -> bases
            // Still the server's copy (edits it refused for good): what the phone holds of it.
            epoch == null || notes.note(noteId)?.epoch == epoch -> updates.updates(noteId, UpdateEntity.SYNCED)
            else -> emptyList()
        } + copied
        val into = copied.lastOrNull { it.copiedTo != null }?.copiedTo
            ?.takeIf { notes.note(it) != null }
            ?.let { id -> CopyTarget(id, updates.stored(id).map { StoredUpdate(it.id, it.update) }) }
        ConflictSet(noteId, epoch, base.map { StoredUpdate(it.id, it.update) }, edits.map { StoredUpdate(it.id, it.update) }, into)
    }

    /**
     * Stores the conflict copy the editor made of a [ConflictSet] (A306, A309), in one
     * transaction: a new note to upload and file beside its original, in the original's folder
     * (T43, A757: never the top level by default, which is the default notebook and may publish
     * elsewhere than the original's notebook), or, when [merged], an edit of
     * the copy [ConflictSet.into] named. The edits it holds are marked as copied, never deleted:
     * a later edit of the same copy may build on them. Refused (false) when a replaced edit is no
     * longer kept apart, or the copy is not where it should be.
     */
    suspend fun saveConflictCopy(noteId: String, copy: PageNote, replaces: List<Long>, merged: Boolean = false): Boolean =
        db.withTransaction {
            val rows = keptApart(noteId, replaces) ?: return@withTransaction false
            val target = notes.note(copy.id)
            if (merged) {
                if (target == null) return@withTransaction false
                updates.insert(UpdateEntity(noteId = copy.id, state = UpdateEntity.PENDING, update = copy.update, epoch = target.epoch))
            } else {
                if (target != null) return@withTransaction false
                // Beside its original: where a move not filed yet takes it, else where the tree has it.
                val original = notes.note(noteId)
                val beside = original?.let { if (it.toFile) it.fileIn else it.folderId }
                notes.insert(NoteEntity(copy.id, title = copy.title, updatedAt = now(), toFile = true, fileIn = beside, moveNotebook = notebookOfFolder(beside)))
                updates.insert(UpdateEntity(noteId = copy.id, state = UpdateEntity.PENDING, update = copy.update))
                // Listed there at once, as a note made here is (T38).
                if (beside != null) placeAtEnd(copy.id, beside.takeIf { folderExists(it) })
            }
            updates.markCopied(rows.map { it.id }, copy.id)
            true
        }

    /** Why the editor made no copy of a group (A309). */
    enum class NoCopy {
        /** The edits build on something this phone does not have: kept, and counted. */
        INCOMPLETE,

        /** The edits cannot be read: kept, and counted. */
        UNREADABLE,

        /** The edits change nothing a copy would show: nothing to keep. */
        EMPTY,
    }

    /** Records that no copy was made of a group, so it is not asked for again. */
    suspend fun saveNoCopy(noteId: String, replaces: List<Long>, why: NoCopy): Boolean = db.withTransaction {
        val rows = keptApart(noteId, replaces) ?: return@withTransaction false
        if (why == NoCopy.EMPTY) updates.markCopied(rows.map { it.id }, null) else updates.markKept(rows.map { it.id })
        true
    }

    /** The rows named, if every one is an edit of this note still kept apart. */
    private suspend fun keptApart(noteId: String, ids: List<Long>): List<UpdateEntity>? {
        val distinct = ids.distinct()
        if (distinct.isEmpty()) return null
        val rows = updates.byIds(distinct)
        if (rows.size != distinct.size || rows.any { it.noteId != noteId || it.state != UpdateEntity.CONFLICT }) return null
        return rows
    }

    /**
     * Base and copied rows no edit can need any more: none of their note is pending or kept
     * apart on their copy, and no open editor still holds that copy ([held]), since it may yet
     * send its last edits of it.
     */
    suspend fun dropUnneededBases(held: (noteId: String, epoch: String?) -> Boolean = { _, _ -> false }): Int =
        db.withTransaction {
            val drop = updates.unneededBases().filterNot { held(it.noteId, it.epoch) }.map { it.id }
            if (drop.isNotEmpty()) updates.delete(drop)
            drop.size
        }

    private companion object {
        const val CHANGES_CLOCK = "changesClock"
        const val TRASH_ROUTE_MISSING = "trashRouteMissing"
        const val TREE_HASH = "treeHash"
        const val ROOT_SORT_MODE = "rootSortMode"

        /** The default notebook's name (T43, A751), from the tree or renamed here; absent: "Personal". */
        const val DEFAULT_NOTEBOOK = Notebooks.NAME_SETTING

        /** How long after a change the server's index may still lag, as the web's `INDEX_LAG_MS`. */
        const val INDEX_LAG_MS = 60_000L
        const val APPEARANCE = "appearance"
        const val CAPTURE_DESTINATION = "captureDestination"
        const val CAPTURE_TIME_ZONE = "captureTimeZone"
        const val TAG_LIST = "tagList"
        const val SYNCED_SETTINGS = "syncedSettings"
        const val SETTINGS_REFUSED = "settingsRefused"

        /** A git notebook's device map from its tree (A1014). */
        const val DEVICE_SETTINGS = "deviceSettings"
        /** Folder changes the server refused, to say once (T40 P4, A443). */
        const val FOLDER_NOTICES = "folderNotices"

        /** Restores the server could not place, waiting for the person's answer (T43, A757). */
        const val RESTORE_QUESTIONS = "restoreQuestions"
        val RESTORE_QUESTION_LIST = ListSerializer(RestoreQuestion.serializer())
        val TAG_LIST_JSON = ListSerializer(TagCount.serializer())
        val FOLDER_NOTICE_LIST = ListSerializer(String.serializer())

        /** Sorts after every key it is appended to: the highest UTF-16 code unit. */
        const val END_KEY = "\uFFFF"
    }
}

/**
 * The SHA-256 of a note's text and headings in lower-case hex, as the server hashes them (core's
 * `noteTextKey`: the text, a NUL, the headings; T40 P6, FD4). An unpaired surrogate encodes as
 * `?` here and U+FFFD in the browser's `TextEncoder`, so such a note never matches the server's
 * hash and its text comes again on each exchange that asks: harmless (review N5).
 */
internal fun textHash(text: String, headings: String = ""): String =
    java.security.MessageDigest.getInstance("SHA-256").digest("$text\u0000$headings".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

/** A `/sync` row's kind, as Room holds it: daily or weekly, else `note` (T40 P5). */

internal fun journalKind(kind: String?): String = if (kind == "daily" || kind == "weekly") kind else "note"

/**
 * A restore the server could not place (409 `restore_needs_folder`, T43 A757), asked of the
 * person in Trash: the note, the deleted notebook it was in when Trash still knows it, and the
 * server's words.
 */
@kotlinx.serialization.Serializable
data class RestoreQuestion(
    val noteId: String,
    val title: String = "",
    val notebookId: String? = null,
    val notebookName: String = "",
    val message: String = "",
)
