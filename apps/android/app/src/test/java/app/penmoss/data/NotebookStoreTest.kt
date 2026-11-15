package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TreeNote
import app.penmoss.engine.bridge.PageNote
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Notebooks in Room (T43, A750–A756): the tree's flags, which notebook each folder is in, Turn
 * back into a folder, a notebook's delete sending its notes to Trash (A755), and the moves the
 * rules refuse.
 */
@RunWith(AndroidJUnit4::class)
class NotebookStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1_000 })
    }

    @After
    fun close() = db.close()

    /** Work is a notebook with Clients inside; Projects is the default notebook's, and so is Journal. */
    private val tree = SyncTree(
        hash = "h1",
        rootSortMode = "manual",
        folders = listOf(
            TreeFolder("w", "Work", position = "a0", notebook = true),
            TreeFolder("c", "Clients", "w", position = "a0"),
            TreeFolder("p", "Projects", position = "a1"),
            TreeFolder(Notebooks.JOURNAL_FOLDER, "Journal", position = "a2"),
        ),
        notes = listOf(TreeNote("n1", "w", "a0"), TreeNote("n2", "c", "a0"), TreeNote("n3", "p", "a0"), TreeNote("n4", null, "a0")),
    )

    private suspend fun synced() {
        store.saveChanges(
            ChangesPage(
                4,
                notes = listOf(
                    ChangedNote("n1", 1, "Plan", "", 10, seq = 5, tags = listOf("work")),
                    ChangedNote("n2", 2, "Acme", "", 20, seq = 6, tags = listOf("work")),
                    ChangedNote("n3", 3, "Garden", "", 30, seq = 7, tags = listOf("home")),
                    ChangedNote("n4", 4, "Loose", "", 40, seq = 8),
                ),
            ),
        )
        store.saveTree(tree)
    }

    @Test
    fun theTreeStoresEachNotebooksFlag() = runTest {
        synced()
        val folders = store.observeFolders().first().associateBy { it.id }
        assertTrue(folders.getValue("w").notebook)
        assertFalse(folders.getValue("c").notebook)
        val index = Notebooks.index(folders.values.toList())
        assertEquals(listOf("w"), index.notebooks.map { it.id })
        assertEquals("w", index.ofFolder("c"))
        assertEquals("w", index.ofFolder("w"))
        assertNull(index.ofFolder("p"))
        assertNull(index.ofFolder(null))
        assertEquals("Work", store.notebookOf("n2")?.name)
        assertNull(store.notebookOf("n3"))
    }

    @Test
    fun deletingANotebookSendsItsNotesToTrashNotUp() = runTest {
        synced()
        val summary = store.folderDeleteSummary("w")!!
        assertTrue(summary.notebook)
        assertEquals(2, summary.notes)
        assertTrue(store.deleteFolder("w"))
        // Its notes leave every list at once, with nothing to send of their own.
        assertEquals(setOf("n3", "n4"), store.observeList().first().map { it.id }.toSet())
        for (id in listOf("n1", "n2")) {
            val note = store.note(id)!!
            assertTrue(note.deleted)
            assertEquals(NoteEntity.TRASH_WITH_NOTEBOOK, note.trashChange)
        }
        assertEquals(0, store.trashChangesWaiting())
        assertTrue(store.trashesDue().isEmpty())
        assertEquals(listOf(FolderOpEntity.DELETE), db.folderOps().all().map { it.kind })
        // An index row from before the delete does not bring them back; the server's trash does settle them.
        store.saveChanges(ChangesPage(5, notes = listOf(ChangedNote("n1", 1, "Plan", "", 10, seq = 5))))
        assertTrue(store.note("n1")!!.deleted)
        store.saveChanges(ChangesPage(6, notes = listOf(ChangedNote("n1", 9, "Plan", "", 10, deleted = true, seq = 12))))
        assertEquals(0, store.note("n1")!!.trashChange)
        assertTrue(store.note("n1")!!.deleted)

        // A plain folder's notes still move up.
        assertTrue(store.deleteFolder("p"))
        assertFalse(store.note("n3")!!.deleted)
        assertNull(store.note("n3")!!.folderId)
    }

    @Test
    fun turnIntoNotebookAndBackQueueOneChangeEachAndTheTreeKeepsThem() = runTest {
        synced()
        assertTrue(store.setNotebook("p", true).changed)
        assertTrue(db.folders().get("p")!!.notebook)
        val op = db.folderOps().all().single()
        assertEquals(FolderOpEntity.NOTEBOOK, op.kind)
        assertTrue(op.notebook)
        // A tree read before the change is sent still shows it.
        store.saveTree(tree.copy(hash = "h2"))
        assertTrue(db.folders().get("p")!!.notebook)
        // Undone before it was tried: the change is cancelled, nothing sent.
        assertTrue(store.setNotebook("p", false).changed)
        assertTrue(db.folderOps().all().isEmpty())
        assertFalse(db.folders().get("p")!!.notebook)

        // Turned back once the first went out: a second change, false.
        store.setNotebook("w", false)
        assertEquals(listOf(false), db.folderOps().all().map { it.notebook })
        assertFalse(db.folders().get("w")!!.notebook)

        // The rules, as the server's: only a top-level folder, never one holding Journal.
        assertEquals(Notebooks.ONLY_TOP_LEVEL, store.setNotebook("c", true).refusal)
        assertEquals(Notebooks.JOURNAL_STAYS, store.setNotebook(Notebooks.JOURNAL_FOLDER, true).refusal)
        assertFalse(db.folders().get(Notebooks.JOURNAL_FOLDER)!!.notebook)
    }

    @Test
    fun aNotebookStaysAtTheTopAndJournalStaysInTheDefaultNotebook() = runTest {
        synced()
        assertEquals(NoteStore.FolderMove.NOTEBOOK_RULE, store.moveFolder("w", "p"))
        assertEquals(NoteStore.FolderMove.NOTEBOOK_RULE, store.moveFolder(Notebooks.JOURNAL_FOLDER, "c"))
        assertEquals(NoteStore.FolderMove.NOTEBOOK_RULE, store.moveFolder(Notebooks.JOURNAL_FOLDER, "w"))
        assertTrue(db.folderOps().all().isEmpty())
        // A plain folder may go into a notebook, and a note across notebooks.
        assertEquals(NoteStore.FolderMove.MOVED, store.moveFolder("p", "w"))
        assertEquals(NoteStore.Move.MOVED, store.moveNote("n4", "c"))
        // A top-level folder named Inbox counts as the Inbox.
        val inbox = FolderEntity("i", " inbox ", null, "a9", "manual")
        assertTrue(Notebooks.isJournalOrInbox(inbox))
        assertEquals(Notebooks.JOURNAL_STAYS, Notebooks.moveRefusal(listOf(inbox, FolderEntity("w", "Work", null, "a0", "manual", notebook = true)), "i", "w"))
    }

    /** A folder inside Journal, at any depth, stays in the default notebook too (T43 review S4). */
    @Test
    fun aFolderInsideJournalNeverMovesIntoANotebook() = runTest {
        store.saveTree(tree.copy(folders = tree.folders + TreeFolder("y", "2026", Notebooks.JOURNAL_FOLDER, position = "a0")))
        assertEquals(NoteStore.FolderMove.NOTEBOOK_RULE, store.moveFolder("y", "w"))
        assertEquals(NoteStore.FolderMove.NOTEBOOK_RULE, store.moveFolder("y", "c"))
        assertTrue(db.folderOps().all().isEmpty())
        // Within the default notebook it may move.
        assertEquals(NoteStore.FolderMove.MOVED, store.moveFolder("y", "p"))
    }

    /**
     * Each move records the notebook the phone saw the note in (T43, A766, fix c), sent with it on
     * every try: a note made here gets its folder's, a note moved twice before it is filed keeps
     * the first one's, and a note the tree does not place is never written into the tree here.
     */
    @Test
    fun aMoveRecordsTheNotebookThePhoneSawAndAnUnplacedNoteIsNeverFiled() = runTest {
        synced()
        assertEquals("w", store.notebookOfFolder("c"))
        assertEquals(Notebooks.DEFAULT, store.notebookOfFolder("p"))
        assertEquals(Notebooks.DEFAULT, store.notebookOfFolder(null))
        // A folder the phone does not know: the default, and the server compares (fail closed).
        assertEquals(Notebooks.DEFAULT, store.notebookOfFolder("gone"))

        assertTrue(store.addLocalNote(PageNote("made", "", "WHOLE"), "c"))
        assertEquals("w", store.note("made")!!.moveNotebook)
        assertEquals("w", store.notebookOfNote("made"))

        assertEquals(NoteStore.Move.MOVED, store.moveNote("n3", "c"))
        assertEquals(Notebooks.DEFAULT, store.note("n3")!!.moveNotebook)
        // Where the move takes it, as the phone shows it.
        assertEquals("w", store.notebookOfNote("n3"))
        // Moved again before it is filed: the server still has it where the first move saw it.
        assertEquals(NoteStore.Move.MOVED, store.moveNote("n3", "w"))
        assertEquals(Notebooks.DEFAULT, store.note("n3")!!.moveNotebook)
        assertEquals(NoteStore.Move.MOVED, store.moveNote("n1", "p"))
        assertEquals("w", store.note("n1")!!.moveNotebook)

        // A reorder files the note where it is.
        assertTrue(store.reorderNote("n4", null, null))
        assertEquals(Notebooks.DEFAULT, store.note("n4")!!.moveNotebook)
        assertTrue(store.note("n4")!!.toFile)

        // A note the server's changes list and its tree does not place: listed, never filed here.
        store.saveChanges(ChangesPage(5, notes = listOf(ChangedNote("n5", 5, "Stray", "", 50, seq = 9))))
        assertFalse(store.reorderNote("n5", null, "n4"))
        assertFalse(store.note("n5")!!.toFile)
        assertNull(store.note("n5")!!.moveNotebook)
    }
}
