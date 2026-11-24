package app.penmoss.ui.trash

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.FolderDeleter
import app.penmoss.engine.api.RestoredFolder
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TrashedFolderListed
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit
import app.penmoss.ui.common.PenmossTheme

/**
 * Trash's folders on the phone (T40 P9, NT25, A560): the server's list, in the web's words, and
 * Restore, which brings back a folder's subfolders and notes; the tree follows with the next sync.
 */
@RunWith(AndroidJUnit4::class)
class TrashFoldersTest {
    @get:Rule
    val compose = createComposeRule()

    private val day = TimeUnit.DAYS.toMillis(1)
    private val now = 100 * day
    private val db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
    private val store = NoteStore(db, now = { now })
    private val api = FakeApi()
    private var syncs = 0

    @After
    fun close() = db.close()

    private val projects = TrashedFolderListed(
        "projects", "Projects", parentId = "home", deletedAt = now - 2 * day,
        deletedBy = FolderDeleter("Claude Code", "agent"), folders = 1, notes = 3,
    )
    private val loose = TrashedFolderListed("loose", "Loose ends", deletedAt = now - 29 * day - 1, deletedBy = FolderDeleter("Pixel 9", "device"), notes = 1)

    @Test
    fun eachFolderSaysWhatItHeldWhereFromByWhomAndItsDaysLeft() {
        val shown = trashFolders(listOf(loose, projects), mapOf("home" to "Home")::get, now)
        assertEquals(listOf("projects", "loose"), shown.map { it.id })
        assertTrue(shown[0].detail, shown[0].detail.startsWith("3 notes, 1 subfolder · Deleted "))
        assertTrue(shown[0].detail, shown[0].detail.endsWith(" from “Home” by Claude Code ✦ · 28 days left"))
        assertTrue(shown[1].detail, shown[1].detail.startsWith("1 note · Deleted "))
        assertTrue(shown[1].detail, shown[1].detail.endsWith(" from the top level by Pixel 9 · 1 day left"))
        // The notes' chip (A655): ✦ marks agents only, so a device named with it shows without it.
        val named = loose.copy(deletedBy = FolderDeleter("Mac ✦", "device"))
        assertTrue(trashFolders(listOf(named), { null }, now)[0].detail.contains(" by Mac · "))
        // A parent the phone does not have (deleted too) is said so, as on the web.
        assertTrue(trashFolders(listOf(projects), { null }, now)[0].detail.contains(" from a deleted folder by "))
    }

    /** #137 (review N5): TalkBack hears "(agent)" for the agent's ✦, and a folder's own name as it is. */
    @Test
    fun aFolderDeletedByAClockAheadNeverShowsMoreThanThirtyDays() {
        val ahead = trashFolders(listOf(loose.copy(deletedAt = now + 5 * day)), { null }, now).single()
        assertTrue(ahead.detail, ahead.detail.endsWith(" · 30 days left"))
    }

    @Test
    fun aFoldersDeleterIsSpokenAsTheNotesAre() {
        val shown = trashFolders(listOf(projects), mapOf("home" to "Home ✦")::get, now).single()
        assertTrue(shown.detail, shown.detail.endsWith(" from “Home ✦” by Claude Code ✦ · 28 days left"))
        assertTrue(shown.spoken, shown.spoken.endsWith(" from “Home ✦” by Claude Code (agent) · 28 days left"))
        val star = trashFolders(listOf(loose.copy(deletedBy = FolderDeleter("✦", "device"))), { null }, now).single()
        assertTrue(star.detail, star.detail.endsWith(" by a device · 1 day left"))
        assertEquals(star.detail, star.spoken)
    }

    @Test
    fun aRestoreSaysWhereItWentAndWhichNotesStay() {
        assertEquals("Restored “Projects”.", restoredFolderMessage("Projects", RestoredFolder("projects", restored = true, notes = 3)))
        assertEquals(
            "Restored “Projects”. The folder it was in is gone, so it is in the nearest folder above it. 2 notes were moved or deleted since, so they stay where they are.",
            restoredFolderMessage("Projects", RestoredFolder("projects", restored = true, parentGone = true, notes = 1, skipped = listOf("a", "b"), parentId = "elsewhere")),
        )
        assertEquals(
            "Restored “Projects”. 1 note was moved or deleted since, so it stays where it is.",
            restoredFolderMessage("Projects", RestoredFolder("projects", restored = true, skipped = listOf("a"))),
        )
        assertEquals("“Projects” is not in Trash any more.", restoredFolderMessage("Projects", RestoredFolder("projects")))
    }

    private fun withModel(block: suspend (TrashFoldersModel) -> Unit) = runBlocking {
        val job = SupervisorJob()
        val model = TrashFoldersModel(
            store, api, requestSync = { syncs++ },
            scope = CoroutineScope(coroutineContext + job), now = { now },
        )
        try {
            block(model)
        } finally {
            job.cancelAndJoin()
        }
    }

    private suspend fun TrashFoldersModel.until(what: (TrashFoldersUi) -> Boolean) = withTimeout(5_000) { ui.first(what) }

    @Test
    fun restoreBringsTheFolderBackAndSyncsTheTree() = withModel { model ->
        store.saveTree(SyncTree(hash = "h1", folders = listOf(TreeFolder("home", "Home", position = "a0"))))
        api.folderTrashList = { listOf(projects) }
        api.onRestoreFolder = { RestoredFolder(it, restored = true, notes = 3) }
        model.load()
        // The parent's name comes from Room, which the derived state reads as it arrives.
        val listed = model.until { ui -> ui.folders.firstOrNull()?.detail?.contains("from “Home”") == true }
        model.restore(listed.folders[0])
        val done = model.until { it.message != null }
        assertEquals("Restored “Projects”.", done.message)
        assertEquals(emptyList<TrashFolderUi>(), done.folders)
        assertEquals(listOf("projects"), api.restoredFolders.toList())
        assertEquals(1, syncs)
    }

    @Test
    fun offlineOrRefusedARestoreChangesNothingAndSaysWhy() = withModel { model ->
        api.folderTrashList = { listOf(projects) }
        model.load()
        val listed = model.until { it.folders.isNotEmpty() }
        api.onRestoreFolder = { throw java.io.IOException("offline") }
        model.restore(listed.folders[0])
        assertEquals(
            "Offline: restoring “Projects” needs Penmoss. Try again once the phone is online.",
            model.until { it.message != null }.message,
        )
        model.messageShown()
        // The state is derived: the cleared message shows before the next one is awaited.
        model.until { it.message == null }
        api.onRestoreFolder = { throw ApiException(401, "unauthorized", "Unauthorized") }
        model.restore(listed.folders[0])
        assertEquals("Penmoss couldn’t restore “Projects”: Unauthorized.", model.until { it.message != null }.message)
        assertEquals(1, model.ui.value.folders.size)
        assertEquals(0, syncs)
    }

    /**
     * A folder back with its parent gone says where it came back (A757): that folder's name
     * as this phone has it, the top level, or "the nearest folder above it" when unknown here.
     */
    @Test
    fun aRestoreWithItsParentGoneSaysWhereItCameBack() = withModel { model ->
        store.saveTree(SyncTree(hash = "h1", folders = listOf(TreeFolder("home", "Home", position = "a0"))))
        fun back(parent: String?) = RestoredFolder("projects", restored = true, parentGone = true, parentId = parent)
        val names = mapOf("home" to "Home")
        assertEquals("Restored “Projects”. The folder it was in is gone, so it is in “Home”.", restoredFolderMessage("Projects", back("home"), names::get))
        assertEquals("Restored “Projects”. The folder it was in is gone, so it is at the top level.", restoredFolderMessage("Projects", back(null), names::get))
        assertEquals("Restored “Projects”. The folder it was in is gone, so it is in the nearest folder above it.", restoredFolderMessage("Projects", back("elsewhere"), names::get))
        // Through the model, named from the phone's tree.
        api.folderTrashList = { listOf(projects) }
        api.onRestoreFolder = { back("home") }
        model.load()
        val listed = model.until { it.folders.isNotEmpty() }
        model.restore(listed.folders[0])
        assertEquals("Restored “Projects”. The folder it was in is gone, so it is in “Home”.", model.until { it.message != null }.message)
    }

    @Test
    fun offlineTheListIsEmptyAndTrashsNotesSayWhy() = withModel { model ->
        model.load()
        assertEquals(emptyList<TrashFolderUi>(), model.until { true }.folders)
    }

    @Test
    fun trashShowsFoldersAboveNotesAndRestoresOne() {
        val restored = mutableListOf<String>()
        val folder = TrashFolderUi("projects", "Projects", "3 notes · Deleted 3 Oct from the top level · 28 days left")
        compose.setContent {
            PenmossTheme {
                TrashScreen(
                    ui = TrashUi(entries = listOf(TrashEntryUi("old", "Old plan", "Deleted Mon · goes for good in 20 days", 10, waiting = false))),
                    onRestore = {},
                    onDeleteForGood = {},
                    onOpen = {},
                    onMessageShown = {},
                    onRefresh = {},
                    onBack = {},
                    folders = TrashFoldersUi(listOf(folder)),
                    onRestoreFolder = { restored += it.id },
                )
            }
        }
        compose.onNodeWithText("Folders").assertIsDisplayed()
        compose.onNodeWithText("Notes").assertIsDisplayed()
        compose.onNodeWithText("3 notes · Deleted 3 Oct from the top level · 28 days left").assertIsDisplayed()
        compose.onNodeWithContentDescription("Restore the folder Projects").performClick()
        assertEquals(listOf("projects"), restored)
        compose.onNodeWithTag("trashEmpty").assertDoesNotExist()
    }

    @Test
    fun aRestoreUnderWayHoldsTheOtherRestores() {
        compose.setContent {
            PenmossTheme {
                TrashScreen(
                    ui = TrashUi(), onRestore = {}, onDeleteForGood = {}, onOpen = {}, onMessageShown = {}, onRefresh = {}, onBack = {},
                    folders = TrashFoldersUi(listOf(TrashFolderUi("projects", "Projects", "1 note")), busy = true),
                )
            }
        }
        compose.onNodeWithTag("restoreFolder-projects").assertIsNotEnabled()
        // With only folders in Trash it is not empty, and there is no Notes heading.
        compose.onNodeWithTag("trashEmpty").assertDoesNotExist()
        compose.onNodeWithText("Notes").assertDoesNotExist()
    }
}
