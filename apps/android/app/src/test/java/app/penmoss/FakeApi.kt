package app.penmoss

import app.penmoss.engine.api.BatchEntry
import app.penmoss.engine.api.BatchReply
import app.penmoss.engine.api.CaptureReply
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.FolderPatch
import app.penmoss.engine.api.FolderRef
import app.penmoss.engine.api.InFolder
import app.penmoss.engine.api.NotePlace
import app.penmoss.engine.api.DailyNoteRef
import app.penmoss.engine.api.PenmossApi
import app.penmoss.engine.api.SearchReply
import app.penmoss.engine.api.SettingsChange
import app.penmoss.engine.api.SettingsReply
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TagCount
import app.penmoss.engine.api.HistoryAuthor
import app.penmoss.engine.api.NoteHistory
import app.penmoss.engine.api.NoteVersion
import app.penmoss.engine.api.RestoredNote
import app.penmoss.engine.api.RestoredVersion
import app.penmoss.engine.api.RevertedVersion
import app.penmoss.engine.api.TrashListed
import app.penmoss.engine.api.TrashedNote
import app.penmoss.engine.api.UnversionedChanges
import app.penmoss.engine.api.VersionDetail
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** The server as the T33 tests need it: moves and pictures, each answer set by the test. */
open class FakeApi : PenmossApi {
    val moves = CopyOnWriteArrayList<Pair<String, String?>>()
    val uploads = CopyOnWriteArrayList<Pair<String, String?>>()

    /** The `ext` each upload named: a file that is not a picture or a PDF (T40 P8, ED12). */
    val uploadExts = CopyOnWriteArrayList<Pair<String, String?>>()
    val fetched = CopyOnWriteArrayList<String>()
    var onMove: (String, String?) -> Unit = { _, _ -> }
    var onUpload: (String) -> Unit = {}
    var pictures: (String) -> ByteArray = { throw java.io.IOException("offline") }

    /** The workspace's tags (T38); offline unless the test says otherwise. */
    var tagList: () -> List<TagCount> = { throw java.io.IOException("offline") }

    /** Each move's precondition (A359), in order: null when none was sent. */
    val froms = CopyOnWriteArrayList<InFolder?>()

    /** Each move's reorder anchor (T40 P4, NT7), in order: null when none was sent. */
    val places = CopyOnWriteArrayList<NotePlace?>()

    /** Where the server files each move (T43, A757): where asked, unless the test says otherwise. */
    var filedIn: (String, String?) -> String? = { _, folderId -> folderId }

    /** Each move's `fromNotebook` (T43, A766), in order. */
    val fromNotebooks = CopyOnWriteArrayList<String?>()

    override suspend fun moveNote(noteId: String, folderId: String?, from: InFolder?, place: NotePlace?, fromNotebook: String?): app.penmoss.engine.api.FiledNote {
        moves += noteId to folderId
        froms += from
        fromNotebooks += fromNotebook
        places += place
        onMove(noteId, folderId)
        return app.penmoss.engine.api.FiledNote(filedIn(noteId, folderId))
    }

    override suspend fun putAttachment(sha256: String, file: File, noteId: String?, ext: String?) {
        uploads += sha256 to noteId
        uploadExts += sha256 to ext
        onUpload(sha256)
    }

    /** `HEAD` asks, by hash; [sizes] answers each (none known by default). */
    val sizeAsks = CopyOnWriteArrayList<String>()
    var sizes: (String) -> Long? = { null }

    override suspend fun attachmentSize(sha256: String): Long? {
        sizeAsks += sha256
        return sizes(sha256)
    }

    override suspend fun attachment(sha256: String): ByteArray {
        fetched += sha256
        return pictures(sha256)
    }

    /** Captures sent, in order; [onCapture] answers each (the note it landed in by default). */
    val captures = CopyOnWriteArrayList<CaptureRequest>()
    var onCapture: (CaptureRequest) -> CaptureReply = { CaptureReply(it.id, "note-${it.id}", it.destination, changed = true) }

    override suspend fun capture(request: CaptureRequest): CaptureReply {
        captures += request
        return onCapture(request)
    }

    /** Settings changes sent (T40 P1), in order; [onSettings] answers each (offline by default). */
    val settingsChanges = CopyOnWriteArrayList<SettingsChange>()
    var onSettings: (SettingsChange) -> SettingsReply = { throw java.io.IOException("offline") }

    override suspend fun putSettings(change: SettingsChange): SettingsReply {
        settingsChanges += change
        return onSettings(change)
    }

    /** Trash requests sent (T40 P3a), in order; [onTrash] answers each (offline by default). */
    val trashed = CopyOnWriteArrayList<Pair<String, Long>>()
    var onTrash: (String, Long) -> TrashedNote = { _, _ -> throw java.io.IOException("offline") }

    override suspend fun trashNote(noteId: String, knownSeq: Long): TrashedNote {
        trashed += noteId to knownSeq
        return onTrash(noteId, knownSeq)
    }

    /** Restores sent, in order; [onRestore] answers each (offline by default). */
    val restored = CopyOnWriteArrayList<String>()
    var onRestore: (String) -> RestoredNote = { throw java.io.IOException("offline") }

    /** The folder each restore named (T43, A757): null when it named none. */
    val restoredInto = CopyOnWriteArrayList<InFolder?>()

    override suspend fun restoreNote(noteId: String, into: InFolder?): RestoredNote {
        restored += noteId
        restoredInto += into
        return onRestore(noteId)
    }

    var trashList: () -> List<TrashListed> = { throw java.io.IOException("offline") }

    override suspend fun trash(): List<TrashListed> = trashList()

    /** Trash's folders (T40 P9, NT25): offline unless the test says otherwise. */
    var folderTrashList: () -> List<app.penmoss.engine.api.TrashedFolderListed> = { throw java.io.IOException("offline") }
    var onRestoreFolder: (String) -> app.penmoss.engine.api.RestoredFolder = { throw java.io.IOException("offline") }
    val restoredFolders = CopyOnWriteArrayList<String>()

    override suspend fun folderTrash(): List<app.penmoss.engine.api.TrashedFolderListed> = folderTrashList()

    override suspend fun restoreFolder(id: String): app.penmoss.engine.api.RestoredFolder {
        restoredFolders += id
        return onRestoreFolder(id)
    }

    /** Agent activity (T40 P9, AC11): offline unless the test says otherwise. */
    var activityList: () -> List<app.penmoss.engine.api.AgentActivityEntry> = { throw java.io.IOException("offline") }
    var onUndoActivity: (Long) -> app.penmoss.engine.api.ActivityUndone = { throw java.io.IOException("offline") }
    val undone = CopyOnWriteArrayList<Long>()

    override suspend fun agentActivity(): List<app.penmoss.engine.api.AgentActivityEntry> = activityList()

    override suspend fun undoAgentActivity(id: Long): app.penmoss.engine.api.ActivityUndone {
        undone += id
        return onUndoActivity(id)
    }

    /** Version history (T40 P3b): each answer set by the test (offline by default). */
    var historyList: (String) -> NoteHistory = { throw java.io.IOException("offline") }
    var historyDetail: (String, Long) -> VersionDetail = { _, _ -> throw java.io.IOException("offline") }
    val restoredVersions = CopyOnWriteArrayList<Pair<String, Long>>()
    var onRestoreVersion: (String, Long) -> RestoredVersion = { _, _ -> throw java.io.IOException("offline") }
    val revertedVersions = CopyOnWriteArrayList<Pair<String, Long>>()
    var onRevertVersion: (String, Long) -> RevertedVersion = { _, _ -> throw java.io.IOException("offline") }
    val savedVersions = CopyOnWriteArrayList<String>()
    var onSaveVersion: (String) -> Unit = { throw java.io.IOException("offline") }

    override suspend fun history(noteId: String): NoteHistory = historyList(noteId)

    override suspend fun versionDetail(noteId: String, version: Long): VersionDetail = historyDetail(noteId, version)

    /** Backlinks (T40 P7, LK5): each answer set by the test (offline by default), and the titles asked with. */
    var backlinksReply: (String, String) -> app.penmoss.engine.api.BacklinksReply = { _, _ -> throw java.io.IOException("offline") }
    val backlinksAsked = mutableListOf<Pair<String, String>>()

    override suspend fun backlinks(noteId: String, title: String): app.penmoss.engine.api.BacklinksReply {
        backlinksAsked += noteId to title
        return backlinksReply(noteId, title)
    }

    override suspend fun restoreVersion(noteId: String, version: Long): RestoredVersion {
        restoredVersions += noteId to version
        return onRestoreVersion(noteId, version)
    }

    override suspend fun revertVersion(noteId: String, version: Long): RevertedVersion {
        revertedVersions += noteId to version
        return onRevertVersion(noteId, version)
    }

    override suspend fun saveVersion(noteId: String) {
        savedVersions += noteId
        onSaveVersion(noteId)
    }

    /** Folder intent routes (T40 P4): each answer set by the test (offline by default). */
    val createdFolders = CopyOnWriteArrayList<Triple<String, String, String?>>()
    var onCreateFolder: (String, String, String?) -> FolderRef =
        { id, name, parentId -> FolderRef(id, name, parentId) }
    val patchedFolders = CopyOnWriteArrayList<Pair<String, FolderPatch>>()
    var onPatchFolder: (String, FolderPatch) -> FolderRef = { id, patch ->
        FolderRef(id, patch.name ?: "Folder", if (patch.changeParent) patch.parentId else null, patch.sortMode ?: "manual")
    }
    val rootSorts = CopyOnWriteArrayList<String>()
    val deletedFolders = CopyOnWriteArrayList<String>()
    var onDeleteFolder: (String) -> Boolean = { true }

    /** The notebooks made (T43): their ids. */
    val createdNotebooks = CopyOnWriteArrayList<String>()
    val notebookNames = CopyOnWriteArrayList<String>()

    override suspend fun createFolder(id: String, name: String, parentId: String?, notebook: Boolean): FolderRef {
        createdFolders += Triple(id, name, parentId)
        if (notebook) createdNotebooks += id
        return onCreateFolder(id, name, parentId)
    }

    override suspend fun patchFolder(id: String, patch: FolderPatch): FolderRef {
        patchedFolders += id to patch
        return onPatchFolder(id, patch)
    }

    override suspend fun setRootSortMode(sortMode: String) {
        rootSorts += sortMode
    }

    override suspend fun setDefaultNotebookName(name: String): String {
        notebookNames += name
        return name.ifEmpty { "Personal" }
    }

    override suspend fun deleteFolder(id: String): Boolean {
        deletedFolders += id
        return onDeleteFolder(id)
    }

    override suspend fun changes(since: Long): ChangesPage = error("not used")
    override suspend fun batch(notes: List<BatchEntry>): BatchReply = error("not used")
    override suspend fun tree(since: String?): SyncTree = error("not used")
    override suspend fun search(query: String, limit: Int, mode: app.penmoss.engine.api.SearchMode, filters: app.penmoss.engine.api.SearchFilters, partial: Boolean): SearchReply = error("not used")
    override suspend fun dailyNote(date: String?, period: String): DailyNoteRef {
        dailyCalls += date to period
        return onDaily(date, period)
    }

    /** Daily intents sent (T40 P5), in order; [onDaily] answers each (filed by default). */
    val dailyCalls = CopyOnWriteArrayList<Pair<String?, String>>()
    var onDaily: (String?, String) -> DailyNoteRef = { _, _ -> DailyNoteRef("daily-fake", created = true) }
    override suspend fun tags(): List<TagCount> = tagList()

    /** Tag renames asked (T40 P6, TG3), in order; [onRenameTag] answers each. */
    val tagRenames = CopyOnWriteArrayList<Triple<String, String, List<String>>>()
    var onRenameTag: (String, String, List<String>) -> app.penmoss.engine.api.TagRenameReply = { from, to, ids -> app.penmoss.engine.api.TagRenameReply(from, to, ids) }
    override suspend fun renameTag(from: String, to: String, noteIds: List<String>): app.penmoss.engine.api.TagRenameReply {
        tagRenames += Triple(from, to, noteIds)
        return onRenameTag(from, to, noteIds)
    }
}
