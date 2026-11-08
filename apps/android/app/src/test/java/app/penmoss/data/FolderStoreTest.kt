package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TreeNote
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Folders made, renamed, moved, sorted and reordered on the phone (T40 P4,
 * NT2–NT7): the lists show the change at once, offline too, and it waits in
 * Room's folder queue until the server can be asked (A443, as moves do, A359).
 */
@RunWith(AndroidJUnit4::class)
class FolderStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1_000 })
    }

    @After
    fun close() = db.close()

    private val tree = SyncTree(
        hash = "h1",
        rootSortMode = "manual",
        folders = listOf(
            TreeFolder("a", "A", position = "a0"),
            TreeFolder("b", "B", position = "a1"),
            TreeFolder("c", "C", position = "a2"),
        ),
        notes = listOf(TreeNote("n1", "a", "a0"), TreeNote("n2", "a", "a1"), TreeNote("n3", null, "a0")),
    )

    private suspend fun synced() {
        store.saveChanges(
            ChangesPage(
                3,
                notes = listOf(
                    ChangedNote("n1", 1, "One", "", 10),
                    ChangedNote("n2", 2, "Two", "", 20),
                    ChangedNote("n3", 3, "Three", "", 30),
                ),
            ),
        )
        store.saveTree(tree)
    }

    private suspend fun folderIds(parentId: String? = null): List<String> =
        store.observeFolders().first().filter { it.parentId == parentId }.sortedBy { it.position }.map { it.id }

    @Test
    fun aFolderMadeHereShowsAtOnceAndWaitsToBeSent() = runTest {
        synced()
        val id = store.createFolder("Projects", null)!!
        assertEquals(listOf("a", "b", "c", id), folderIds(null))
        val ops = store.folderOpsDue()
        assertEquals(1, ops.size)
        assertEquals(FolderOpEntity.CREATE, ops[0].kind)
        assertEquals(id, ops[0].folderId)
        assertEquals("Projects", ops[0].name)
        assertNull(ops[0].parentId)
        assertEquals(1, store.folderOpsWaiting())
        assertTrue(store.unsentCount() > 0)
    }

    @Test
    fun aFolderIsNotMadeUnderAnUnknownParent() = runTest {
        synced()
        assertNull(store.createFolder("Orphan", "missing"))
        assertTrue(store.folderOpsDue().isEmpty())
    }

    @Test
    fun aRenameShowsAtOnceWithWhatItSaw() = runTest {
        synced()
        assertTrue(store.renameFolder("a", "Alpha"))
        assertEquals("Alpha", db.folders().get("a")!!.name)
        val ops = store.folderOpsDue()
        assertEquals(1, ops.size)
        assertEquals(FolderOpEntity.RENAME, ops[0].kind)
        assertEquals("Alpha", ops[0].name)
        assertEquals("A", ops[0].fromName)
        assertTrue(ops[0].checkName)
        assertFalse(store.renameFolder("missing", "Nope"))
    }

    @Test
    fun aMoveShowsAtOnceWithWhatItSaw() = runTest {
        synced()
        assertEquals(NoteStore.FolderMove.MOVED, store.moveFolder("c", "a"))
        assertEquals("a", db.folders().get("c")!!.parentId)
        val ops = store.folderOpsDue()
        assertEquals(1, ops.size)
        assertEquals(FolderOpEntity.MOVE, ops[0].kind)
        assertEquals("a", ops[0].parentId)
        assertNull(ops[0].fromParentId)
        assertTrue(ops[0].checkParent)
        assertEquals(NoteStore.FolderMove.ALREADY_THERE, store.moveFolder("c", "a"))
        assertEquals(NoteStore.FolderMove.REFUSED, store.moveFolder("missing", null))
        assertEquals(NoteStore.FolderMove.REFUSED, store.moveFolder("a", "missing"))
    }

    @Test
    fun aFolderIsNotMovedIntoItselfOrASubfolder() = runTest {
        synced()
        assertEquals(NoteStore.FolderMove.MOVED, store.moveFolder("b", "a"))
        assertEquals(NoteStore.FolderMove.REFUSED, store.moveFolder("a", "b"))
        assertEquals(NoteStore.FolderMove.REFUSED, store.moveFolder("a", "a"))
        assertEquals("a", db.folders().get("b")!!.parentId)
    }

    @Test
    fun deleteMovesNotesUpAndQueuesOneDelete() = runTest {
        synced()
        val summary = store.folderDeleteSummary("a")!!
        assertEquals(2, summary.notes)
        assertEquals(0, summary.subfolders)
        assertNull(summary.destination)
        assertTrue(store.deleteFolder("a"))
        assertNull(db.folders().get("a"))
        // Its notes moved up to the top level, at its end (after n3).
        assertEquals(listOf("n3", "n1", "n2"), store.observeList().first().filter { it.folderId == null }.sortedBy { it.position }.map { it.id })
        val ops = store.folderOpsDue()
        assertEquals(listOf(FolderOpEntity.DELETE), ops.map { it.kind })
        assertFalse(store.deleteFolder("missing"))
    }

    @Test
    fun aFolderMadeAndDeletedBeforeItIsSentNeverReachesTheServer() = runTest {
        synced()
        val id = store.createFolder("Temporary", "a")!!
        store.renameFolder(id, "Renamed")
        assertTrue(store.deleteFolder(id))
        assertTrue(store.folderOpsDue().isEmpty())
        assertNull(db.folders().get(id))
    }

    @Test
    fun aDeleteAfterATriedCreateQueuesADelete() = runTest {
        synced()
        val id = store.createFolder("Temporary", null)!!
        // The create went out and its answer never came: the server may hold the folder
        // (T40 P4 review B3).
        store.markFolderOpTried(store.folderOpsDue().single().rowId)
        assertTrue(store.deleteFolder(id))
        // Not cancelled: the delete is queued, so the server's copy does not reappear.
        val ops = store.folderOpsDue()
        assertEquals(listOf(FolderOpEntity.DELETE), ops.map { it.kind })
        assertEquals(id, ops[0].folderId)
        assertNull(db.folders().get(id))
    }

    @Test
    fun anOvertakenChangeSaysRenamedOrMoved() = runTest {
        synced()
        store.renameFolder("a", "Alpha")
        store.dropFolderOpsFor("a", "Alpha", NoteStore.FolderDropReason.RENAMED)
        store.moveFolder("b", "a")
        store.dropFolderOpsFor("b", "B", NoteStore.FolderDropReason.MOVED)
        val notices = store.observeFolderNotices().first()
        assertEquals(2, notices.size)
        assertTrue(notices[0].contains("renamed"))
        assertTrue(notices[1].contains("moved"))
    }

    @Test
    fun sortModesShowAtOnceAndCoalesce() = runTest {
        synced()
        assertTrue(store.setSortMode("a", "alpha"))
        assertEquals("alpha", db.folders().get("a")!!.sortMode)
        assertTrue(store.setSortMode("a", "modified"))
        // Choosing again replaces the choice not sent yet: one op, last write wins.
        assertEquals(listOf(FolderOpEntity.SORT), store.folderOpsDue().map { it.kind })
        assertTrue(store.setSortMode(null, "alpha"))
        assertEquals("alpha", store.observeRootSortMode().first())
        assertEquals(2, store.folderOpsDue().size)
        assertFalse(store.setSortMode("missing", "alpha"))
        assertFalse(store.setSortMode("a", "random"))
    }

    @Test
    fun aFolderReorderShowsAtOnceWithAnchors() = runTest {
        synced()
        assertTrue(store.reorderFolder("c", before = "a", after = null))
        assertEquals(listOf("c", "a", "b"), folderIds(null))
        val ops = store.folderOpsDue()
        assertEquals(listOf(FolderOpEntity.REORDER), ops.map { it.kind })
        assertEquals("a", ops[0].placeBefore)
        assertNull(ops[0].placeAfter)
        // A missing anchor means the end.
        assertTrue(store.reorderFolder("c", before = "missing", after = null))
        assertEquals(listOf("a", "b", "c"), folderIds(null))
        assertFalse(store.reorderFolder("missing", before = "a", after = null))
    }

    @Test
    fun aNoteReorderShowsAtOnceAndWaitsToBeFiled() = runTest {
        synced()
        assertTrue(store.reorderNote("n1", before = null, after = "n2"))
        val notes = store.observeList().first().filter { it.folderId == "a" }.sortedBy { it.position }.map { it.id }
        assertEquals(listOf("n2", "n1"), notes)
        val row = db.notes().note("n1")!!
        assertTrue(row.toFile)
        assertEquals("a", row.fileIn)
        assertEquals("n2", row.filePlaceAfter)
        assertNull(row.filePlaceBefore)
        assertFalse(store.reorderNote("missing", before = "n1", after = null))
    }

    @Test
    fun anOldTreeKeepsWaitingChanges() = runTest {
        synced()
        val id = store.createFolder("Projects", null)!!
        store.renameFolder("a", "Alpha")
        store.setSortMode(null, "modified")
        store.reorderNote("n1", before = null, after = "n2")
        // The next tree still shows where everything was: the changes stand.
        store.saveTree(tree)
        assertNotNull(db.folders().get(id))
        assertEquals("Alpha", db.folders().get("a")!!.name)
        assertEquals("modified", store.observeRootSortMode().first())
        val notes = store.observeList().first().filter { it.folderId == "a" }.sortedBy { it.position }.map { it.id }
        assertEquals(listOf("n2", "n1"), notes)
        // The note's reorder waits as a filing, not a folder change: three folder ops.
        assertEquals(3, store.folderOpsDue().size)
    }

    @Test
    fun changesForAFolderDeletedElsewhereAreDroppedWithANotice() = runTest {
        synced()
        store.renameFolder("a", "Alpha")
        store.setSortMode("b", "alpha")
        // The web deleted A: the next tree no longer has it.
        val without = tree.copy(folders = tree.folders.filter { it.id != "a" })
        store.saveTree(without)
        assertEquals(1, store.folderOpsDue().size)
        assertEquals("b", store.folderOpsDue()[0].folderId)
        val notices = store.observeFolderNotices().first()
        assertEquals(1, notices.size)
        assertTrue(notices[0].contains("Alpha"))
        // The folder is gone, not overtaken: the notice says deleted (T40 P4 review B2).
        assertTrue(notices[0].contains("deleted"))
        store.dismissFolderNotice(notices[0])
        assertTrue(store.observeFolderNotices().first().isEmpty())
    }

    @Test
    fun aDeleteOpForAFolderGoneElsewhereGoesSilently() = runTest {
        synced()
        assertTrue(store.deleteFolder("a"))
        val without = tree.copy(folders = tree.folders.filter { it.id != "a" })
        store.saveTree(without)
        assertTrue(store.folderOpsDue().isEmpty())
        assertTrue(store.observeFolderNotices().first().isEmpty())
    }
}
