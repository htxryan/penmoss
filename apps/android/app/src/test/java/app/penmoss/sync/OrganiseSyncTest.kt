package app.penmoss.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.Attachments
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * Organising notes offline, then syncing (T38): the app's real coordinator, engine, Room store,
 * filer and HTTP client against a small fake Penmoss server. A move, a tag edit and a new note
 * made in airplane mode reach the server on the first pass that can, and the web then sees them.
 */
@RunWith(AndroidJUnit4::class)
class OrganiseSyncTest {
    @get:Rule
    val folder = TemporaryFolder()

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
        val attachments = Attachments(db.attachments(), folder.newFolder("a"), folder.newFolder("c"), api)
        val work = PassWork(store, attachments, NoteFiler(store, api), OpenEditors())
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

    private fun folderOnPhone(id: String) = runBlocking { store.observeList().first().first { it.id == id }.folderId }

    @Test
    fun aMoveAndATagMadeOfflineReachTheServerOnTheFirstPassOnline() {
        penmoss.folder("garden")
        penmoss.edit("soup", "U09VUA==", "Soup")
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(null, folderOnPhone("soup"))

        // Airplane mode: Ryan moves the note and tags it. The tag is an edit the editor page made
        // to the note's document, which the phone stores as opaque bytes like any typing.
        online = false
        runBlocking {
            assertEquals(NoteStore.Move.MOVED, store.moveNote("soup", "garden"))
            store.addPending("soup", "VEFHR0VE", store.note("soup")!!.epoch)
        }
        assertEquals(PassOutcome.FAILED, pass())
        // Shown where it is going meanwhile, through passes that cannot reach Penmoss.
        assertEquals("garden", folderOnPhone("soup"))
        assertTrue(penmoss.moves.isEmpty())

        // Back online: one pass sends the tag edit as stored and files the move.
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("soup" to "garden"), penmoss.moves.toList())
        assertEquals("garden", penmoss.folderOf("soup"))
        assertTrue("VEFHR0VE" in penmoss.updates("soup"))
        runBlocking {
            assertFalse(store.note("soup")!!.toFile)
            assertEquals(0, store.pendingCount())
        }
        // The next pass's tree, the server's own, agrees; nothing more is sent.
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("garden", folderOnPhone("soup"))
        assertEquals(1, penmoss.moves.size)
    }

    @Test
    fun aNoteMadeOfflineInAFolderUploadsAndIsFiledThereInOnePass() {
        penmoss.folder("garden")
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        // What the editor page made for New note in Garden (the controller stores it so).
        runBlocking { assertTrue(store.addLocalNote(PageNote("new", "", "TkVX"), "garden")) }
        assertEquals(PassOutcome.FAILED, pass())
        assertEquals("garden", folderOnPhone("new"))
        assertFalse(penmoss.has("new"))

        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // The server has its content first, then it is filed where it was made. Its first upload
        // named the folder (T43, fix c); this server, an older one, ignored it.
        assertEquals(listOf("TkVX"), penmoss.updates("new"))
        assertEquals(listOf("new" to "garden"), penmoss.uploadFolders.toList())
        assertEquals(listOf("new" to "garden"), penmoss.moves.toList())
        assertEquals("garden", penmoss.folderOf("new"))
        runBlocking { assertFalse(store.note("new")!!.toFile) }
    }

    /**
     * A server that files a note on its first upload (T43, fix c): it is never in the default
     * notebook's top level, not even between the upload and the move, and no move follows.
     */
    @Test
    fun aNoteMadeOfflineIsFiledByItsFirstUploadAndNeverMovedAfter() {
        penmoss.filesOnUpload = true
        penmoss.folder("garden")
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        runBlocking {
            assertTrue(store.addLocalNote(PageNote("new", "", "TkVX"), "garden"))
            assertTrue(store.addLocalNote(PageNote("top", "", "VE9Q"), null))
        }
        assertEquals(PassOutcome.FAILED, pass())

        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(setOf("new" to "garden", "top" to null), penmoss.uploadFolders.toSet())
        assertEquals("garden", penmoss.folderOf("new"))
        assertEquals(null, penmoss.folderOf("top"))
        assertTrue(penmoss.moves.isEmpty())
        runBlocking {
            assertFalse(store.note("new")!!.toFile)
            assertFalse(store.note("top")!!.toFile)
        }
        // Later uploads name no folder.
        runBlocking { store.addPending("new", "TU9SRQ==", store.note("new")!!.epoch) }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(2, penmoss.uploadFolders.size)
        assertEquals("garden", folderOnPhone("new"))
        assertTrue(penmoss.moves.isEmpty())
    }

    @Test
    fun aMoveToAFolderDeletedOnTheWebMeanwhileEndsAtTheTopLevel() {
        penmoss.folder("garden")
        penmoss.edit("soup", "U09VUA==", "Soup")
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        runBlocking { store.moveNote("soup", "garden") }
        // The web deletes the folder before the phone is back.
        penmoss.forgetFolder("garden")
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // Asked once: the server files it in the nearest folder above, here the top level, as the
        // whole way up was the default notebook's (T43, A757). The phone never asks for the top level.
        assertEquals(listOf("soup" to "garden"), penmoss.moves.toList())
        assertEquals(null, penmoss.folderOf("soup"))
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(null, folderOnPhone("soup"))
    }

    /** Runs a pass whose `/sync/batch` waits until [during] has run, as if it took a while. */
    private fun passWhile(during: () -> Unit): PassOutcome {
        val gate = CountDownLatch(1)
        penmoss.batchGate = gate
        val before = penmoss.batches.get()
        val outcome = AtomicReference<PassOutcome>()
        val running = thread { outcome.set(pass()) }
        val until = System.currentTimeMillis() + 10_000
        while (penmoss.batches.get() == before) {
            check(System.currentTimeMillis() < until) { "the pass never sent its batch" }
            Thread.sleep(5)
        }
        during()
        gate.countDown()
        running.join(10_000)
        return outcome.get()
    }

    @Test
    fun aNoteTrashedOnTheMacWhileThePassRunsIsNeverFiledBackInTheTree() {
        penmoss.folder("garden")
        penmoss.edit("soup", "U09VUA==", "Soup")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            store.moveNote("soup", "garden")
            store.addPending("soup", "RURJVA==", store.note("soup")!!.epoch)
        }
        // The pass has read /sync/changes (not deleted yet) when the Mac trashes the note.
        assertEquals(PassOutcome.SYNCED, passWhile { penmoss.trash("soup") })
        // The move was asked for and refused (A358): the note stays in Trash, out of the tree.
        assertEquals(listOf("soup" to "garden"), penmoss.moves.toList())
        assertFalse(penmoss.inTree("soup"))
        runBlocking { assertFalse(store.note("soup")!!.toFile) }
        // The next pass says it is in Trash; nothing is asked again.
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { assertTrue(store.note("soup")!!.deleted) }
        assertEquals(1, penmoss.moves.size)
        assertFalse(penmoss.inTree("soup"))
    }

    @Test
    fun aMoveMadeOfflineDoesNotUndoANewerMoveMadeOnTheMac() {
        penmoss.folder("recipes")
        penmoss.folder("cooking")
        penmoss.edit("soup", "U09VUA==", "Soup")
        assertEquals(PassOutcome.SYNCED, pass())
        // On the subway, Ryan files Soup in Recipes on the phone...
        online = false
        runBlocking { store.moveNote("soup", "recipes") }
        assertEquals(PassOutcome.FAILED, pass())
        // ...then in Cooking on the Mac. The phone comes back online hours later.
        penmoss.moveOnWeb("soup", "cooking")
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // The newer move stands everywhere: the phone's is dropped without being sent (A359).
        assertTrue(penmoss.moves.isEmpty())
        assertEquals("cooking", penmoss.folderOf("soup"))
        assertEquals("cooking", folderOnPhone("soup"))
        runBlocking { assertFalse(store.note("soup")!!.toFile) }
    }

    @Test
    fun aMoveTheMacMakesWhileThePhonesIsOnItsWayWins() {
        penmoss.folder("recipes")
        penmoss.folder("cooking")
        penmoss.edit("soup", "U09VUA==", "Soup")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking {
            store.moveNote("soup", "recipes")
            store.addPending("soup", "RURJVA==", store.note("soup")!!.epoch)
        }
        // The pass has read the tree (Soup at the top level) when the Mac files it in Cooking.
        assertEquals(PassOutcome.SYNCED, passWhile { penmoss.moveOnWeb("soup", "cooking") })
        // Asked only if Soup was still at the top level: it was not, so the server left it.
        assertEquals(listOf("soup" to "recipes"), penmoss.moves.toList())
        assertEquals(listOf<String?>(""), penmoss.froms.toList())
        assertEquals("cooking", penmoss.folderOf("soup"))
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("cooking", folderOnPhone("soup"))
        assertEquals(1, penmoss.moves.size)
    }
}
