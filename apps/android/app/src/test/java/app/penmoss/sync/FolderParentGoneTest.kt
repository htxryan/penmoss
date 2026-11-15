package app.penmoss.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.data.FolderOpEntity
import app.penmoss.data.NoteStore
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
 * A folder change whose parent went since (A352, A757): the notes server places it in the nearest
 * folder above, or answers 422 `folder_not_found` when there is no safe place, and the change is
 * dropped with a notice, never sent again at the top level. And the changes an older version could
 * queue for notebooks inside a notebook (T43), which a git notebook has none of (A912), are dropped
 * unsent.
 */
@RunWith(AndroidJUnit4::class)
class FolderParentGoneTest {
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
                folders = listOf(TreeFolder("w", "Work", position = "a0"), TreeFolder("p", "Projects", position = "a1")),
            ),
        )
    }

    @After
    fun close() = db.close()

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
    fun aMoveIntoAParentGoneWithNoSafePlaceIsDroppedAndTheFoldersOtherChangesGoOn() = runTest {
        store.saveTree(
            SyncTree(
                "h2",
                folders = listOf(
                    TreeFolder("w", "Work", position = "a0"),
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
            SyncTree("h2", folders = listOf(TreeFolder("w", "Work", position = "a0"), TreeFolder("p", "Projects", position = "a1"), TreeFolder("a", "Archive", position = "a2"))),
        )
        store.moveFolder("p", "a")
        api.onPatchFolder = { id, _ -> app.penmoss.engine.api.FolderRef(id, "Projects", null) }
        FolderSender(store, api).sendDue()
        assertEquals(1, api.patchedFolders.size)
        assertTrue(store.folderOpsDue().isEmpty())
        assertTrue(store.observeFolderNotices().first().isEmpty())
    }

    /**
     * A rename of the default notebook, or a notebook flag, an older version queued is dropped
     * unsent (A912): a git notebook has neither. A change queued after them still goes.
     */
    @Test
    fun aDefaultNotebookRenameOrNotebookFlagLeftQueuedIsDroppedUnsent() = runTest {
        db.folderOps().insert(FolderOpEntity(folderId = null, kind = FolderOpEntity.ROOT_NAME, name = "Home"))
        db.folderOps().insert(FolderOpEntity(folderId = "w", kind = FolderOpEntity.NOTEBOOK, label = "Work"))
        store.renameFolder("p", "Plans")
        FolderSender(store, api).sendDue()
        assertEquals(listOf("p" to "Plans"), api.patchedFolders.map { it.first to it.second.name })
        assertTrue(store.folderOpsDue().isEmpty())
        assertTrue(store.observeFolderNotices().first().isEmpty())
    }
}
