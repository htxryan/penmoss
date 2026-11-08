package app.penmoss.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.data.NoteStore
import app.penmoss.data.Notebooks
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Notebook changes made on the phone reach the server through the folder routes (T43, A750,
 * A751, A755, A756): a notebook's create with `notebook: true`, Turn into notebook and back as
 * `PATCH { notebook }`, the default notebook's name on the root, and a notebook's delete. A change
 * the notebook rules refuse (422 `notebook_rule`) is dropped and the server's words said.
 */
@RunWith(AndroidJUnit4::class)
class NotebookSenderTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private val api = FakeApi()

    @Before
    fun open() = runTest {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1_000 })
        store.saveTree(
            SyncTree(
                "h1",
                folders = listOf(TreeFolder("w", "Work", position = "a0", notebook = true), TreeFolder("p", "Projects", position = "a1")),
            ),
        )
    }

    @After
    fun close() = db.close()

    @Test
    fun eachNotebookChangeIsSentInOrder() = runTest {
        val id = store.createNotebook("Ideas")
        store.setNotebook("p", true)
        store.setNotebook("w", false)
        store.renameDefaultNotebook("Home")
        FolderSender(store, api).sendDue()

        assertEquals(listOf(id), api.createdNotebooks)
        assertEquals(listOf(null), api.createdFolders.map { it.third })
        assertEquals(listOf("p" to true, "w" to false), api.patchedFolders.map { it.first to it.second.notebook })
        assertEquals(listOf("Home"), api.notebookNames)
        assertTrue(store.folderOpsDue().isEmpty())
    }

    @Test
    fun aNotebooksDeleteIsSent() = runTest {
        store.deleteFolder("w")
        FolderSender(store, api).sendDue()
        assertEquals(listOf("w"), api.deletedFolders)
        assertTrue(store.folderOpsDue().isEmpty())
    }

    @Test
    fun aChangeTheNotebookRulesRefuseIsDroppedAndTheServersWordsSaid() = runTest {
        store.setNotebook("p", true)
        api.onPatchFolder = { _, _ -> throw ApiException(422, "notebook_rule", "Journal and the Inbox stay in the default notebook") }
        FolderSender(store, api).sendDue()
        assertTrue(store.folderOpsDue().isEmpty())
        assertEquals(listOf("Journal and the Inbox stay in the default notebook."), store.observeFolderNotices().first())
    }

    // --- a parent gone since (T43, A757: fail closed; the server places it, never the top level) ---

    @Test
    fun aCreateUnderAParentGoneWithNoSafePlaceIsDroppedNeverRetriedAtTheTopLevel() = runTest {
        val id = store.createFolder("Drafts", "p")!!
        store.renameFolder(id, "Drafts 2")
        api.onCreateFolder = { _, _, _ -> throw ApiException(422, "folder_not_found", "No such folder") }
        FolderSender(store, api).sendDue()
        // Asked once, under its parent; never again at the top level, nor its rename sent.
        assertEquals(listOf(Triple(id, "Drafts", "p")), api.createdFolders.toList())
        assertTrue(api.patchedFolders.isEmpty())
        assertTrue(store.folderOpsDue().isEmpty())
        assertEquals(1, store.observeFolderNotices().first().size)
        assertTrue(store.observeFolderNotices().first().single().contains("was going into was deleted on another device"))
    }

    @Test
    fun aCreateTheServerPlacedElsewhereIsDoneAsAnswered() = runTest {
        val id = store.createFolder("Drafts", "p")!!
        // The server made it in the nearest live folder above (201 with its real parent).
        api.onCreateFolder = { folder, name, _ -> app.penmoss.engine.api.FolderRef(folder, name, "w") }
        FolderSender(store, api).sendDue()
        assertEquals(listOf<String?>("p"), api.createdFolders.map { it.third })
        assertTrue(store.folderOpsDue().isEmpty())
        assertTrue(store.observeFolderNotices().first().isEmpty())
        assertEquals(id, api.createdFolders.single().first)
    }

    @Test
    fun aCreateMadeInTrashWithItsDeletedNotebookDropsTheRestAndSaysWhere() = runTest {
        val id = store.createFolder("Drafts", "p")!!
        store.renameFolder(id, "Drafts 2")
        api.onCreateFolder = { folder, name, parent -> app.penmoss.engine.api.FolderRef(folder, name, parent, inTrash = true) }
        FolderSender(store, api).sendDue()
        assertEquals(1, api.createdFolders.size)
        assertTrue(api.patchedFolders.isEmpty())
        assertTrue(store.folderOpsDue().isEmpty())
        assertEquals(
            listOf("“Drafts” went to Trash with its notebook, which was deleted on another device. Restore the notebook from Trash to get it back."),
            store.observeFolderNotices().first(),
        )
    }

    @Test
    fun aCreateMadeInTrashNamesTheNotebookItWentWith() = runTest {
        store.createFolder("Drafts", "p")!!
        api.onCreateFolder = { folder, name, parent ->
            app.penmoss.engine.api.FolderRef(folder, name, parent, inTrash = true, notebook = app.penmoss.engine.api.FolderNotebook("w", "Work"))
        }
        FolderSender(store, api).sendDue()
        assertEquals(
            listOf("“Drafts” went to Trash with the notebook “Work”, which was deleted on another device. Restore “Work” from Trash to get it back."),
            store.observeFolderNotices().first(),
        )
    }

    @Test
    fun aMoveIntoAParentGoneWithNoSafePlaceIsDroppedAndTheFoldersOtherChangesGoOn() = runTest {
        store.saveTree(
            SyncTree(
                "h2",
                folders = listOf(
                    TreeFolder("w", "Work", position = "a0", notebook = true),
                    TreeFolder("p", "Projects", position = "a1"),
                    TreeFolder("a", "Archive", position = "a2"),
                ),
            ),
        )
        store.moveFolder("p", "a")
        store.renameFolder("p", "Old projects")
        api.onPatchFolder = { id, patch ->
            if (patch.changeParent) throw ApiException(422, "folder_not_found", "No such folder")
            app.penmoss.engine.api.FolderRef(id, patch.name ?: "Projects")
        }
        FolderSender(store, api).sendDue()
        // The move once, never again with `parentId: null`; the rename still sent.
        assertEquals(listOf(true, false), api.patchedFolders.map { it.second.changeParent })
        assertEquals(listOf("a", null), api.patchedFolders.map { it.second.parentId })
        assertEquals("Old projects", api.patchedFolders[1].second.name)
        assertTrue(store.folderOpsDue().isEmpty())
        assertEquals(1, store.observeFolderNotices().first().size)
    }

    @Test
    fun aMoveTheServerPlacedInTheNearestFolderAboveIsDone() = runTest {
        store.saveTree(
            SyncTree("h2", folders = listOf(TreeFolder("w", "Work", position = "a0", notebook = true), TreeFolder("p", "Projects", position = "a1"), TreeFolder("a", "Archive", position = "a2"))),
        )
        store.moveFolder("p", "a")
        api.onPatchFolder = { id, _ -> app.penmoss.engine.api.FolderRef(id, "Projects", null) }
        FolderSender(store, api).sendDue()
        assertEquals(1, api.patchedFolders.size)
        assertTrue(store.folderOpsDue().isEmpty())
        assertTrue(store.observeFolderNotices().first().isEmpty())
    }

    /**
     * A folder's move names the notebook the phone saw it in (T43, A766, fix c), so the server can
     * hold its notes when another device moved it since; a move queued before schema 19 is named
     * from the parent it left. A rename names none.
     */
    @Test
    fun aFolderMoveNamesTheNotebookThePhoneSawItIn() = runTest {
        store.saveTree(
            SyncTree(
                "h2",
                folders = listOf(
                    TreeFolder("w", "Work", position = "a0", notebook = true),
                    TreeFolder("c", "Clients", "w", position = "a0"),
                    TreeFolder("x", "Old", "w", position = "a1"),
                    TreeFolder("p", "Projects", position = "a1"),
                ),
            ),
        )
        store.moveFolder("c", "x")
        store.moveFolder("p", "w")
        store.renameFolder("p", "Plans")
        assertEquals(listOf("w", Notebooks.DEFAULT, null), db.folderOps().all().map { it.fromNotebook })
        db.openHelper.writableDatabase.execSQL("UPDATE folder_ops SET fromNotebook = NULL WHERE folderId = 'c'")
        FolderSender(store, api).sendDue()
        assertEquals(
            setOf(Triple("c", true, "w"), Triple("p", true, Notebooks.DEFAULT), Triple("p", false, null)),
            api.patchedFolders.map { Triple(it.first, it.second.changeParent, it.second.fromNotebook) }.toSet(),
        )
        assertTrue(store.folderOpsDue().isEmpty())
    }

    @Test
    fun theDefaultNotebooksNameWaitsForAServerBeforeNotebooks() = runTest {
        store.renameDefaultNotebook("Home")
        val old = object : FakeApi() {
            override suspend fun setDefaultNotebookName(name: String): String = throw ApiException(404, null, "Not Found")
        }
        FolderSender(store, old).sendDue()
        assertEquals(1, store.folderOpsDue().size)
    }
}
