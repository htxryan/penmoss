package app.penmoss.data

import app.penmoss.engine.api.TagCount
import app.penmoss.engine.bridge.Compacted
import app.penmoss.engine.bridge.DirectoryEntry
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.settings.SettingLimits
import app.penmoss.engine.sync.StoredUpdate
import app.penmoss.engine.sync.SyncStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The app's store over Room (A5): it builds one part per concern, all on the same database and
 * each write one `db.withTransaction` as before, and is the entry point the rest of the app uses.
 * It is the sync engine's [SyncStore] ([sync]), and each other method hands on to its part, so a
 * caller never needs to know which part holds it.
 */
class NoteStore private constructor(
    db: PenmossDatabase,
    now: () -> Long,
    /** Where the lists show each note. */
    val placement: NotePlacement = NotePlacement(db),
    /** Folders and the folder-op queue. */
    val folders: FolderOps = FolderOps(db),
    /** The offline index's text and tags, the tag list, and links. */
    val index: NoteIndex = NoteIndex(db, now, folders),
    /** Synced settings, quick capture's destination and a git notebook's device map. */
    val settings: SettingsStore = SettingsStore(db),
    /** Trash, restores and notes deleted for good. */
    val trash: TrashOps = TrashOps(db, now, placement),
    /** The editor's content and edits, and the note lists. */
    val editor: EditorStore = EditorStore(db, now, settings),
    /** Wikilinks' new notes and daily and weekly notes. */
    val periodic: PeriodicNotes = PeriodicNotes(db, now, placement),
    /** Edits kept apart, and the conflict copies made of them. */
    val conflicts: ConflictCopies = ConflictCopies(db, now, placement),
    /** The Room side of sync, which the sync engine drives. */
    val sync: RoomSyncStore = RoomSyncStore(db, index, placement, folders, settings, trash),
) : SyncStore by sync {
    constructor(
        db: PenmossDatabase,
        /** Also forgets what lives outside the database (pictures' files) when the cache is cleared. */
        now: () -> Long = System::currentTimeMillis,
    ) : this(db, now, NotePlacement(db))

    // The parts' own types, by the names callers already use.
    typealias EditorContent = EditorStore.EditorContent
    typealias Move = NotePlacement.Move
    typealias FolderMove = FolderOps.FolderMove
    typealias FolderDeleteSummary = FolderOps.FolderDeleteSummary
    typealias FolderDropReason = FolderOps.FolderDropReason
    typealias Restore = TrashOps.Restore
    typealias SettingsState = SettingsStore.SettingsState
    typealias SettingsRefusal = SettingsStore.SettingsRefusal
    typealias CopyTarget = ConflictCopies.CopyTarget
    typealias ConflictSet = ConflictCopies.ConflictSet
    typealias NoCopy = ConflictCopies.NoCopy

    // EditorStore
    suspend fun editorContent(noteId: String): EditorContent = editor.editorContent(noteId)
    suspend fun pending(noteId: String): List<StoredUpdate> = editor.pending(noteId)
    suspend fun pendingCount(noteId: String): Int = editor.pendingCount(noteId)
    suspend fun holds(noteId: String): Boolean = editor.holds(noteId)
    suspend fun addPending(noteId: String, update: String, epoch: String?): Long = editor.addPending(noteId, update, epoch)
    suspend fun compact(noteId: String, compacted: Compacted, state: Int): Boolean = editor.compact(noteId, compacted, state)
    suspend fun setLocalTitle(noteId: String, title: String) = editor.setLocalTitle(noteId, title)
    suspend fun note(noteId: String): NoteEntity? = editor.note(noteId)
    suspend fun idsEndingWith(end: String): List<String> = editor.idsEndingWith(end)
    fun observeNote(noteId: String): Flow<NoteEntity?> = editor.observeNote(noteId)
    suspend fun noteTitle(noteId: String): String? = editor.noteTitle(noteId)
    fun observeList(): Flow<List<NoteListRow>> = editor.observeList()
    fun observeQuickAccess(pins: Flow<List<String>> = settings.observeSettings().map { it.settings.quickAccess }): Flow<List<NoteListRow>> = editor.observeQuickAccess(pins)
    suspend fun unsentCount(): Int = editor.unsentCount()

    /** How many live notes the notebook has on this phone, Trash left out (PEN-148). */
    suspend fun noteCount(): Int = editor.noteCount()
    suspend fun unsentFeedbackCount(): Int = editor.unsentFeedbackCount()
    suspend fun pendingCount(): Int = editor.pendingCount()
    suspend fun markOpened(noteId: String) = editor.markOpened(noteId)
    fun observeRecent(limit: Int): Flow<List<NoteListRow>> = editor.observeRecent(limit)
    fun observeUnsentCount(noteId: String): Flow<Int> = editor.observeUnsentCount(noteId)
    suspend fun names(): List<String> = editor.names()
    fun observeContentStamp(noteId: String): Flow<String> = editor.observeContentStamp(noteId)
    suspend fun cachedHistory(noteId: String): HistoryCacheEntity? = editor.cachedHistory(noteId)
    suspend fun cacheHistory(noteId: String, json: String) = editor.cacheHistory(noteId, json)

    // NoteIndex
    suspend fun savePageText(noteId: String, text: String, headings: String = "", tags: List<String> = emptyList()) = index.savePageText(noteId, text, headings, tags)
    suspend fun renameTagLocally(from: String, to: String, noteIds: List<String>) = index.renameTagLocally(from, to, noteIds)
    fun observeTagCounts(): Flow<List<TagCountRow>> = index.observeTagCounts()
    fun observeTagsOf(noteId: String): Flow<List<String>> = index.observeTagsOf(noteId)
    fun observeNoteTags(): Flow<List<List<String>>> = index.observeNoteTags()
    fun observeTagged(tag: String): Flow<List<NoteListRow>> = index.observeTagged(tag)
    suspend fun taggedIds(tag: String): List<String> = index.taggedIds(tag)
    fun observeUnsent(): Flow<Int> = index.observeUnsent()
    suspend fun setOwnLinks(noteId: String, targets: List<String>) = index.setOwnLinks(noteId, targets)
    fun observeRecentLinkers(): Flow<Set<String>> = index.observeRecentLinkers()
    suspend fun linksOf(noteId: String): List<String> = index.linksOf(noteId)
    fun observeGraph(): Flow<GraphSource> = index.observeGraph()
    fun observeBacklinkSources(noteId: String): Flow<List<BacklinkSource>> = index.observeBacklinkSources(noteId)
    suspend fun cachedBacklinks(noteId: String): BacklinksCacheEntity? = index.cachedBacklinks(noteId)
    suspend fun cacheBacklinks(noteId: String, json: String) = index.cacheBacklinks(noteId, json)
    fun observeTagList(): Flow<List<TagCount>> = index.observeTagList()
    suspend fun saveTagList(tags: List<TagCount>) = index.saveTagList(tags)
    suspend fun rememberTag(tag: String) = index.rememberTag(tag)

    // NotePlacement
    suspend fun moveNote(noteId: String, folderId: String?): Move = placement.moveNote(noteId, folderId)
    suspend fun folderOf(noteId: String): String? = placement.folderOf(noteId)
    suspend fun readyToFile(): List<NoteEntity> = placement.readyToFile()
    suspend fun markFiled(noteId: String, fileIn: String?, landed: String? = fileIn) = placement.markFiled(noteId, fileIn, landed)
    suspend fun dropMove(noteId: String, fileIn: String?) = placement.dropMove(noteId, fileIn)
    suspend fun reorderNote(id: String, before: String?, after: String?): Boolean = placement.reorderNote(id, before, after)

    // FolderOps
    fun observeFolders(): Flow<List<FolderEntity>> = folders.observeFolders()
    fun observeRootSortMode(): Flow<String> = folders.observeRootSortMode()
    suspend fun folderOpsDue(): List<FolderOpEntity> = folders.folderOpsDue()
    suspend fun folderOpsWaiting(): Int = folders.folderOpsWaiting()
    suspend fun createFolder(name: String, parentId: String?): String? = folders.createFolder(name, parentId)
    suspend fun renameFolder(id: String, name: String): Boolean = folders.renameFolder(id, name)
    suspend fun moveFolder(id: String, parentId: String?): FolderMove = folders.moveFolder(id, parentId)
    suspend fun folderDeleteSummary(id: String): FolderDeleteSummary? = folders.folderDeleteSummary(id)
    suspend fun deleteFolder(id: String): Boolean = folders.deleteFolder(id)
    suspend fun setSortMode(id: String?, mode: String): Boolean = folders.setSortMode(id, mode)
    suspend fun reorderFolder(id: String, before: String?, after: String?): Boolean = folders.reorderFolder(id, before, after)
    suspend fun dropFolderOp(rowId: Long) = folders.dropFolderOp(rowId)
    suspend fun markFolderOpTried(rowId: Long) = folders.markFolderOpTried(rowId)
    suspend fun dropFolderOp(rowId: Long, label: String?, reason: FolderDropReason) = folders.dropFolderOp(rowId, label, reason)
    suspend fun dropFolderOpsFor(folderId: String, label: String?, reason: FolderDropReason = FolderDropReason.DELETED) = folders.dropFolderOpsFor(folderId, label, reason)
    fun observeFolderNotices(): Flow<List<String>> = folders.observeFolderNotices()
    suspend fun dismissFolderNotice(text: String) = folders.dismissFolderNotice(text)

    // TrashOps
    suspend fun moveToTrash(noteId: String): Boolean = trash.moveToTrash(noteId)
    suspend fun restoreFromTrash(noteId: String, title: String = ""): Restore = trash.restoreFromTrash(noteId, title)
    suspend fun trashesDue(): List<NoteEntity> = trash.trashesDue()
    suspend fun restoresDue(): List<NoteEntity> = trash.restoresDue()
    suspend fun requeueTrashInFlight() = trash.requeueTrashInFlight()
    suspend fun trashSending(noteId: String): Boolean = trash.trashSending(noteId)
    suspend fun restoreSending(noteId: String): Boolean = trash.restoreSending(noteId)
    suspend fun trashNotSent(noteId: String) = trash.trashNotSent(noteId)
    suspend fun restoreNotSent(noteId: String) = trash.restoreNotSent(noteId)
    suspend fun trashSent(noteId: String, deletedAt: Long, seq: Long) = trash.trashSent(noteId, deletedAt, seq)
    suspend fun trashRefused(noteId: String) = trash.trashRefused(noteId)
    fun observeTrashNotices(): Flow<List<TrashNotice>> = trash.observeTrashNotices()
    suspend fun trashNoticeShown(noteId: String) = trash.trashNoticeShown(noteId)
    suspend fun restoreSent(noteId: String, folderId: String?, restored: Boolean, seq: Long) = trash.restoreSent(noteId, folderId, restored, seq)
    suspend fun trashGone(noteId: String) = trash.trashGone(noteId)
    fun observeTrash(): Flow<List<TrashRow>> = trash.observeTrash()
    suspend fun trashChangesWaiting(): Int = trash.trashChangesWaiting()
    suspend fun purged(noteId: String) = trash.purged(noteId)

    // SettingsStore
    suspend fun captureDestination(): String = settings.captureDestination()
    suspend fun captureTimeZone(): String? = settings.captureTimeZone()
    fun observeSettings(): Flow<SettingsState> = settings.observeSettings()
    suspend fun settingsNow(): SettingsState = settings.settingsNow()
    fun observeTagDescriptions(): Flow<Map<String, String>> = settings.observeTagDescriptions()
    suspend fun setTagDescriptionLocally(tag: String, description: String?) = settings.setTagDescriptionLocally(tag, description)
    fun observeDeviceMap(): Flow<JsonObject?> = settings.observeDeviceMap()
    suspend fun deviceMapNow(): JsonObject? = settings.deviceMapNow()
    suspend fun putDeviceMap(map: JsonObject) = settings.putDeviceMap(map)
    fun observeSyncedSettings(): Flow<JsonObject?> = settings.observeSyncedSettings()
    suspend fun syncedSettingsNow(): JsonObject? = settings.syncedSettingsNow()
    suspend fun useDeviceSettings(map: JsonObject) = settings.useDeviceSettings(map)
    suspend fun showSettingChanges(changes: Map<String, JsonElement?>) = settings.showSettingChanges(changes)
    suspend fun changeSetting(key: String, value: JsonElement?): Boolean = settings.changeSetting(key, value)
    suspend fun settingsToSend(limit: Int = SettingLimits.PER_REQUEST): List<PendingSettingEntity> = settings.settingsToSend(limit)
    fun baseToSend(row: PendingSettingEntity): JsonElement = settings.baseToSend(row)
    suspend fun pendingSettings(): List<PendingSettingEntity> = settings.pendingSettings()
    @androidx.annotation.VisibleForTesting
    suspend fun pendingSettingsCount(): Int = settings.pendingSettingsCount()
    suspend fun settingsSent(sent: List<PendingSettingEntity>, now: JsonObject) = settings.settingsSent(sent, now)
    suspend fun settingsOvertaken(keys: Collection<String>, server: JsonObject?): Int = settings.settingsOvertaken(keys, server)
    suspend fun settingsRefused(keys: Collection<String>, message: String) = settings.settingsRefused(keys, message)
    suspend fun dismissSettingsRefusal() = settings.dismissSettingsRefusal()
    @androidx.annotation.VisibleForTesting
    suspend fun dropSettings(keys: Collection<String>) = settings.dropSettings(keys)

    // PeriodicNotes
    fun observeDirectory(): Flow<List<DirectoryEntry>> = periodic.observeDirectory()
    suspend fun addPeriodicNote(note: PageNote, kind: String, period: String, fileKind: String, fileDate: String): Boolean = periodic.addPeriodicNote(note, kind, period, fileKind, fileDate)
    fun observeJournalMarks(): Flow<List<JournalMark>> = periodic.observeJournalMarks()
    suspend fun addLocalNote(note: PageNote, fileIn: String?): Boolean = periodic.addLocalNote(note, fileIn)

    // ConflictCopies
    suspend fun notesWithConflicts(limit: Int = 20): List<String> = conflicts.notesWithConflicts(limit)
    fun observeConflictCount(): Flow<Int> = conflicts.observeConflictCount()
    fun observeConflictNotes(): Flow<Int> = conflicts.observeConflictNotes()
    fun observeKeptCount(): Flow<Int> = conflicts.observeKeptCount()
    suspend fun conflictSet(noteId: String): ConflictSet? = conflicts.conflictSet(noteId)
    suspend fun saveConflictCopy(noteId: String, copy: PageNote, replaces: List<Long>, merged: Boolean = false): Boolean = conflicts.saveConflictCopy(noteId, copy, replaces, merged)
    suspend fun saveNoCopy(noteId: String, replaces: List<Long>, why: NoCopy): Boolean = conflicts.saveNoCopy(noteId, replaces, why)
    suspend fun dropUnneededBases(held: (noteId: String, epoch: String?) -> Boolean = { _, _ -> false }): Int = conflicts.dropUnneededBases(held)
}
