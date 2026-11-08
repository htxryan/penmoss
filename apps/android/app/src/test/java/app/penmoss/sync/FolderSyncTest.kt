package app.penmoss.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.FolderOpEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.Attachments
import app.penmoss.editor.OpenEditors
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.sync.SyncEngine
import app.penmoss.stopScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Folders managed offline, then synced (T40 P4, NT2–NT7): the app's real
 * coordinator, engine, Room store, folder sender, filer and HTTP client
 * against a small fake Penmoss server. A create, rename, move, sort and
 * reorder made in airplane mode reach the server in order on the first pass
 * that can, and a note filed into a folder made offline arrives after it.
 */
@RunWith(AndroidJUnit4::class)
class FolderSyncTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val penmoss = FakePenmoss()

    /** Airplane mode: every request fails before it leaves the phone. */
    @Volatile
    private var online = true

    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var sync: SyncCoordinator

    @Before
    fun setUp() {
        server.dispatcher = penmoss
        server.start()
        val http = OkHttpClient.Builder()
            .addInterceptor { chain -> if (!online) throw IOException("airplane mode") else chain.proceed(chain.request()) }
            .build()
        val api = HttpPenmossApi(server.url("/").toString(), http)
        db = PenmossDatabase.inMemory(context)
        store = NoteStore(db)
        val attachments = Attachments(db.attachments(), context.cacheDir, context.filesDir, api)
        val work = PassWork(
            store,
            attachments,
            NoteFiler(store, api),
            OpenEditors(),
            folders = FolderSender(store, api),
        )
        lateinit var engine: SyncEngine
        sync = SyncCoordinator(
            scope,
            engine = { engine },
            beforePass = work::beforePass,
            afterPass = work::afterPass,
            beforeNote = work::beforeNote,
        )
        engine = SyncEngine(api, store) { sync.publish(it) }
    }

    @After
    fun tearDown() {
        // Its work ends before the dispatcher and the database close (A690).
        stopScope(scope)
        thread.close()
        db.close()
        server.close()
    }

    /** One sync pass, as the app runs in front or WorkManager in the background. */
    private fun pass(): PassOutcome = runBlocking { sync.backgroundPass(prefetch = true, maxBatches = SyncEngine.MAX_BATCHES) }

    private fun foldersOnPhone(parentId: String? = null) =
        runBlocking { store.observeFolders().first().filter { it.parentId == parentId }.sortedBy { it.position }.map { it.id } }

    @Test
    fun changesMadeOfflineReachTheServerInOrder() {
        penmoss.folder("a", name = "A", position = "a0")
        penmoss.folder("b", name = "B", position = "a1")
        penmoss.edit("soup", "U09VUA==", "Soup")
        assertEquals(PassOutcome.SYNCED, pass())

        // Airplane mode: a create, a rename, a move and a sort.
        online = false
        val made = runBlocking {
            val id = store.createFolder("Projects", "a")!!
            store.renameFolder("b", "B2")
            store.moveFolder(id, null)
            store.setSortMode("a", "alpha")
            id
        }
        assertEquals(PassOutcome.FAILED, pass())
        assertTrue(penmoss.folderCalls.isEmpty())

        // Back online: one pass sends them in the order they were asked.
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("POST /api/folders", "PATCH b", "PATCH $made", "PATCH a"), penmoss.folderCalls.toList())
        runBlocking { assertTrue(store.folderOpsDue().isEmpty()) }
        // And the next pass's tree, the server's own, agrees.
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(made in foldersOnPhone(null))
        runBlocking { assertEquals("alpha", store.observeFolders().first().first { it.id == "a" }.sortMode) }
    }

    @Test
    fun aNoteFiledIntoAFolderMadeOfflineArrivesAfterTheFolder() {
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        runBlocking {
            val id = store.createFolder("Projects", null)!!
            store.addLocalNote(PageNote("new", "", "TkVX"), id)
        }
        assertEquals(PassOutcome.FAILED, pass())

        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // The folder first, then the note filed into it.
        assertEquals("POST /api/folders", penmoss.folderCalls.first())
        assertTrue(penmoss.moves.contains("new" to runBlocking { store.note("new")!!.folderId }))
        runBlocking { assertEquals(0, store.folderOpsWaiting()) }
    }

    @Test
    fun aRenameOvertakenOnTheWebIsDropped() {
        penmoss.folder("a", name = "A", position = "a0")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { store.renameFolder("a", "A2") }
        // The web renames it meanwhile.
        penmoss.renameFolderOnWeb("a", "A3")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            assertTrue(store.folderOpsDue().isEmpty())
            assertEquals("A3", store.observeFolders().first().first { it.id == "a" }.name)
            // The notice names the rename, not a deletion (T40 P4 review B2).
            val notices = store.observeFolderNotices().first()
            assertEquals(1, notices.size)
            assertTrue(notices[0].contains("renamed"))
        }
    }

    @Test
    fun aRetryOfAnAppliedRenameKeepsLaterChanges() {
        penmoss.folder("a", name = "A", position = "a0")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            store.renameFolder("a", "A2")
            store.setSortMode("a", "alpha")
        }
        // The rename reached the server but its answer was lost: the tree shows the rename's
        // own end state, as an applied retry would. The retry must answer 200 — not drop the
        // rename and the sort queued after it (T40 P4 review B1).
        penmoss.renameFolderOnWeb("a", "A2")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            assertTrue(store.folderOpsDue().isEmpty())
            assertEquals("alpha", store.observeFolders().first().first { it.id == "a" }.sortMode)
            assertTrue(store.observeFolderNotices().first().isEmpty())
            // Both changes were sent: the rename's retry answered 200, not 409.
            assertEquals(listOf("PATCH a", "PATCH a"), penmoss.folderCalls.toList())
        }
    }

    @Test
    fun aRetryOfAnAppliedMoveKeepsLaterChanges() {
        penmoss.folder("a", name = "A", position = "a0")
        penmoss.folder("b", name = "B", position = "a1")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            store.moveFolder("a", "b")
            store.setSortMode("a", "alpha")
        }
        // The move reached the server but its answer was lost: the tree shows the move's own
        // end state, as an applied retry would (T40 P4 review B1).
        penmoss.moveFolderOnWeb("a", "b")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            assertTrue(store.folderOpsDue().isEmpty())
            assertEquals("alpha", store.observeFolders().first().first { it.id == "a" }.sortMode)
            assertTrue(store.observeFolderNotices().first().isEmpty())
        }
    }

    @Test
    fun aCreateTriedWithNoAnswerIsDeletedRatherThanCancelled() {
        assertEquals(PassOutcome.SYNCED, pass())
        // The create is applied but its answer never comes back: the op stays queued, tried.
        penmoss.folderCreateAppliedThenFails = 500
        val made = runBlocking { store.createFolder("Temporary", null)!! }
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { assertEquals(1, store.folderOpsWaiting()) }
        // Deleted locally before the retry: the delete is queued instead of cancelling both,
        // so the folder the server holds does not reappear (T40 P4 review B3).
        runBlocking {
            assertTrue(store.deleteFolder(made))
            assertEquals(listOf(FolderOpEntity.DELETE), store.folderOpsDue().map { it.kind })
        }
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { assertTrue(store.folderOpsDue().isEmpty()) }
        // The next tree agrees: the server's copy is gone, not reappeared.
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { assertTrue(store.observeFolders().first().none { it.id == made }) }
    }

    @Test
    fun aFolderDeletedOnTheWebDropsItsChangesWithANotice() {
        penmoss.folder("a", name = "A", position = "a0")
        penmoss.folder("b", name = "B", position = "a1")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            store.renameFolder("a", "A2")
            store.setSortMode("b", "alpha")
        }
        penmoss.forgetFolder("a")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            // The rename went with its folder; the sort landed.
            assertTrue(store.folderOpsDue().isEmpty())
            val notices = store.observeFolderNotices().first()
            assertEquals(1, notices.size)
            assertTrue(notices[0].contains("A2"))
            // The folder is gone, not overtaken: the notice says deleted (T40 P4 review B2).
            assertTrue(notices[0].contains("deleted"))
        }
    }

    @Test
    fun aReorderSendsPlaceAndTakesTheServersOrder() {
        penmoss.folder("a", name = "A", position = "a0")
        penmoss.edit("n1", "U09VUA==", "One")
        penmoss.edit("n2", "V09VUA==", "Two")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            // Both start at the top level; file them, then reorder.
            store.moveNote("n1", "a")
            store.moveNote("n2", "a")
        }
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { store.reorderNote("n1", before = null, after = "n2") }
        assertEquals(PassOutcome.SYNCED, pass())
        // The two filings carried no reorder; the reorder sends its anchor (after n2).
        assertEquals(null to "n2", penmoss.places.last())
        // The next pass's tree, filed at the anchor, agrees.
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            val order = store.observeList().first().filter { it.folderId == "a" }.sortedBy { it.position }.map { it.id }
            assertEquals(listOf("n2", "n1"), order)
        }
    }

    @Test
    fun theTopLevelsSortModeIsSent() {
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { store.setSortMode(null, "alpha") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("ROOT"), penmoss.folderCalls.toList())
        assertEquals("alpha", penmoss.rootSortMode)
    }

    @Test
    fun aCreateUnderAParentDeletedMeanwhileFallsBackToTheTopLevel() {
        penmoss.folder("p", name = "P", position = "a0")
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        val made = runBlocking { store.createFolder("Projects", "p")!! }
        penmoss.forgetFolder("p")
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            assertTrue(store.folderOpsDue().isEmpty())
            assertTrue(made in foldersOnPhone(null))
        }
    }

    @Test
    fun folderChangesWaitForAnOlderServer() {
        penmoss.folder("a", name = "A", position = "a0")
        assertEquals(PassOutcome.SYNCED, pass())
        penmoss.foldersRouteMissing = true
        runBlocking {
            store.createFolder("Projects", null)
            store.renameFolder("a", "A2")
            store.setSortMode("a", "alpha")
            store.setSortMode(null, "modified")
        }
        assertEquals(PassOutcome.SYNCED, pass())
        // Nothing dropped, nothing said: the server simply has no such route yet (A449).
        runBlocking {
            assertEquals(4, store.folderOpsWaiting())
            assertTrue(store.observeFolderNotices().first().isEmpty())
        }
        penmoss.foldersRouteMissing = false
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { assertEquals(0, store.folderOpsWaiting()) }
    }

    @Test
    fun folderChangesCountAsUnsent() {
        penmoss.folder("a", name = "A", position = "a0")
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        runBlocking { store.renameFolder("a", "A2") }
        assertEquals(PassOutcome.FAILED, pass())
        runBlocking {
            assertTrue(store.unsentCount() > 0)
            assertTrue(store.folderOpsWaiting() > 0)
        }
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { assertEquals(0, store.folderOpsWaiting()) }
    }
}
