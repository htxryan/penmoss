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
 * A git notebook has no notebooks inside it (A912), so Room's T43 columns are kept for schema 19
 * but never read or written: a folder an older row flags is a plain folder, and no move or note
 * made here records a notebook. A note the tree does not place is still never written into it.
 */
@RunWith(AndroidJUnit4::class)
class NoNotebooksInsideTest {
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
            TreeFolder("w", "Work", position = "a0"),
            TreeFolder("c", "Clients", "w", position = "a0"),
            TreeFolder("p", "Projects", position = "a1"),
        ),
        notes = listOf(TreeNote("n1", "w", "a0"), TreeNote("n2", "c", "a0"), TreeNote("n3", "p", "a0"), TreeNote("n4", null, "a0")),
    )

    private suspend fun synced() {
        store.saveChanges(
            ChangesPage(
                4,
                notes = listOf(
                    ChangedNote("n1", 1, "Plan", "", 10, seq = 5),
                    ChangedNote("n2", 2, "Acme", "", 20, seq = 6),
                    ChangedNote("n3", 3, "Garden", "", 30, seq = 7),
                    ChangedNote("n4", 4, "Loose", "", 40, seq = 8),
                ),
            ),
        )
        store.saveTree(tree)
    }

    /** A folder an older row flags a notebook is deleted as any folder is: its notes move up, none to Trash. */
    @Test
    fun aFolderFlaggedByAnOlderRowIsAPlainFolder() = runTest {
        synced()
        db.openHelper.writableDatabase.execSQL("UPDATE folders SET notebook = 1 WHERE id = 'w'")
        // Moved like any folder: into another, with no notebook rule.
        assertEquals(NoteStore.FolderMove.MOVED, store.moveFolder("w", "p"))
        assertTrue(store.deleteFolder("w"))
        for (id in listOf("n1", "n2")) {
            val note = store.note(id)!!
            assertFalse(note.deleted)
            assertEquals(0, note.trashChange)
        }
        // Up into the folder it was in.
        assertEquals("p", store.note("n1")!!.folderId)
        // The delete replaces the move still queued for it, as for any folder.
        assertEquals(listOf(FolderOpEntity.DELETE), db.folderOps().all().map { it.kind })
        assertTrue(db.folderOps().all().all { it.fromNotebook == null && !it.notebook })
    }

    /** No move, reorder or note made here records a notebook; a note the tree does not place is never filed here. */
    @Test
    fun noMoveRecordsANotebookAndAnUnplacedNoteIsNeverFiled() = runTest {
        synced()
        assertTrue(store.addLocalNote(PageNote("made", "", "WHOLE"), "c"))
        assertEquals(NoteStore.Move.MOVED, store.moveNote("n3", "c"))
        assertEquals(NoteStore.Move.MOVED, store.moveNote("n1", "p"))
        // A reorder files the note where it is.
        assertTrue(store.reorderNote("n4", null, null))
        assertTrue(store.note("n4")!!.toFile)
        for (id in listOf("made", "n3", "n1", "n4")) assertNull(id, store.note(id)!!.moveNotebook)

        // A note the server's changes list and its tree does not place: listed, never filed here.
        store.saveChanges(ChangesPage(5, notes = listOf(ChangedNote("n5", 5, "Stray", "", 50, seq = 9))))
        assertFalse(store.reorderNote("n5", null, "n4"))
        assertFalse(store.note("n5")!!.toFile)
        assertEquals(setOf("n1", "n2", "n3", "n4", "n5", "made"), store.observeList().first().map { it.id }.toSet())
    }
}
