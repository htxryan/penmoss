package app.penmoss.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.Attachments
import app.penmoss.data.NoteEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.TrashNotice
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Trash on the phone, then syncing (T40 P3a, NT12, NT14, A430): the app's real coordinator,
 * engine, Room store, filer and Trash sender against the fake Penmoss server. A move to Trash
 * made offline reaches the server after the note's own edits; Undo before it is sent cancels
 * it; a restore files the note back where it was; a restore made elsewhere since wins.
 */
@RunWith(AndroidJUnit4::class)
class TrashSyncTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val penmoss = FakePenmoss()

    @Volatile
    private var online = true

    /**
     * Runs as a request leaves the phone, with its path; true: the connection drops before the
     * server sees it.
     */
    @Volatile
    private var onTheWay: ((String) -> Boolean)? = null

    /** Runs once the server answered, with the path; true: the answer is lost (a reset). */
    @Volatile
    private var answerLost: ((String) -> Boolean)? = null

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
            .addInterceptor { chain ->
                if (!online) throw IOException("airplane mode")
                val path = chain.request().url.encodedPath
                if (onTheWay?.invoke(path) == true) throw IOException("connection lost")
                val response = chain.proceed(chain.request())
                if (answerLost?.invoke(path) == true) {
                    response.close()
                    throw IOException("connection reset")
                }
                response
            }
            .build()
        val api = HttpPenmossApi(server.url("/").toString(), http)
        db = PenmossDatabase.inMemory(context)
        store = NoteStore(db)
        val attachments = Attachments(db.attachments(), folder.newFolder("a"), folder.newFolder("c"), api)
        val work = PassWork(store, attachments, NoteFiler(store, api), OpenEditors(), trash = TrashSender(store, api))
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

    private fun pass(): PassOutcome = runBlocking { sync.backgroundPass(prefetch = true, maxBatches = SyncEngine.MAX_BATCHES) }

    private fun listed(id: String) = runBlocking { store.observeList().first().any { it.id == id } }

    private fun inTrashHere(id: String) = runBlocking { store.observeTrash().first().any { it.id == id } }

    private fun folderOnPhone(id: String) = runBlocking { store.observeList().first().first { it.id == id }.folderId }

    private fun soupInGarden() {
        penmoss.folder("garden")
        penmoss.edit("soup", "U09VUA==", "Soup")
        penmoss.moveOnWeb("soup", "garden")
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("garden", folderOnPhone("soup"))
    }

    @Test
    fun aMoveToTrashMadeOfflineGoesAfterTheNotesEditsOnTheFirstPassOnline() {
        soupInGarden()
        online = false
        runBlocking {
            store.addPending("soup", "TEFTVA==", store.note("soup")!!.epoch)
            assertTrue(store.moveToTrash("soup"))
            // Waiting: signing out keeps it, and Settings counts it.
            assertEquals(2, store.unsentCount())
        }
        // Out of every list at once, and in Trash here, offline.
        assertFalse(listed("soup"))
        assertTrue(inTrashHere("soup"))
        assertEquals(PassOutcome.FAILED, pass())
        assertTrue(penmoss.trashCalls.isEmpty())

        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup"), penmoss.trashCalls.toList())
        // The last edit was there before the note went to Trash: it is in Trash with it.
        assertEquals(2, penmoss.updatesWhenTrashed["soup"])
        assertTrue(penmoss.inTrash("soup"))
        assertFalse(penmoss.inTree("soup"))
        runBlocking {
            assertEquals(0, store.unsentCount())
            assertEquals(NoteEntity.TRASH_SENT, store.note("soup")!!.trashChange)
        }
        // The next pass's index agrees, and settles it; nothing more is sent.
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(1, penmoss.trashCalls.size)
        assertTrue(inTrashHere("soup"))
        runBlocking { assertEquals(0, store.note("soup")!!.trashChange) }
    }

    @Test
    fun undoBeforeTheMoveIsSentCancelsItAndTheServerNeverKnows() {
        soupInGarden()
        online = false
        runBlocking {
            assertTrue(store.moveToTrash("soup"))
            assertEquals(NoteStore.Restore.CANCELLED, store.restoreFromTrash("soup"))
            assertEquals(0, store.unsentCount())
        }
        assertTrue(listed("soup"))
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(penmoss.trashCalls.isEmpty())
        assertEquals("garden", folderOnPhone("soup"))
        assertTrue(penmoss.inTree("soup"))
    }

    @Test
    fun aRestoreAfterTheMoveWasSentFilesTheNoteBackInItsFolder() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(penmoss.inTrash("soup"))

        online = false
        runBlocking { assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup")) }
        assertTrue(listed("soup"))
        assertFalse(inTrashHere("soup"))
        runBlocking { assertEquals(1, store.unsentCount()) }
        assertEquals(PassOutcome.FAILED, pass())

        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup", "restore:soup"), penmoss.trashCalls.toList())
        assertFalse(penmoss.inTrash("soup"))
        assertEquals("garden", penmoss.folderOf("soup"))
        assertEquals("garden", folderOnPhone("soup"))
        runBlocking { assertEquals(0, store.unsentCount()) }
        // Settled by the next pass, and still where it was.
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("garden", folderOnPhone("soup"))
        assertTrue(penmoss.inTree("soup"))
        runBlocking { assertEquals(0, store.note("soup")!!.trashChange) }
    }

    @Test
    fun aRestoreWhoseFolderWasDeletedMeanwhileEndsAtTheTopLevel() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        penmoss.forgetFolder("garden")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { store.restoreFromTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertNull(folderOnPhone("soup"))
        assertNull(penmoss.folderOf("soup"))
        assertTrue(penmoss.inTree("soup"))
    }

    /**
     * A restore with no safe place (T43, A757: fail closed; Trash forgot the folder the note was
     * deleted from): the server restores nothing, the note goes back to Trash here, Trash asks
     * where it goes, and nothing is sent again by itself.
     */
    @Test
    fun aRestoreWithNoSafePlaceRestoresNothingAndAsksWhereItGoes() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        penmoss.forgetFolder("garden")
        penmoss.purgeFolderRecord("garden")
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { store.restoreFromTrash("soup") }
        assertTrue(listed("soup"))
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(penmoss.inTrash("soup"))
        assertFalse(listed("soup"))
        assertTrue(inTrashHere("soup"))
        val asked = runBlocking { store.observeRestoreQuestions().first() }
        assertEquals(listOf("soup"), asked.map { it.noteId })
        assertEquals("Soup", asked[0].title)
        assertEquals("The folder the note was deleted from is gone", asked[0].message)
        assertNull(asked[0].notebookId)
        runBlocking {
            assertEquals(NoteEntity.TRASH_SENT, store.note("soup")!!.trashChange)
            assertEquals(0, store.trashChangesWaiting())
        }
        // Never sent again by a later pass, nor filed anywhere.
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup", "restore:soup"), penmoss.trashCalls.toList())
        assertTrue(penmoss.inTrash("soup"))
    }

    @Test
    fun aRestoreMadeElsewhereAfterThisPhonesMoveToTrashWins() {
        soupInGarden()
        online = false
        runBlocking { store.moveToTrash("soup") }
        // The Mac trashes it and restores it while the phone is offline.
        penmoss.trash("soup")
        penmoss.restoreFromTrash("soup")
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup"), penmoss.trashCalls.toList())
        assertFalse(penmoss.inTrash("soup"))
        // The phone's request was dropped: the note is back in its lists, and the phone says why.
        assertTrue(listed("soup"))
        assertEquals(listOf(TrashNotice("soup", "Soup")), runBlocking { store.observeTrashNotices().first() })
        runBlocking {
            assertEquals(0, store.unsentCount())
            assertEquals(0, store.note("soup")!!.trashChange)
        }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(1, penmoss.trashCalls.size)
    }

    @Test
    fun aNoteTrashedHereStaysInTrashWhileTheMacKeepsEditingIt() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        penmoss.edit("soup", "TUFD", "Soup from the Mac")
        assertEquals(PassOutcome.SYNCED, pass())
        assertFalse(listed("soup"))
        assertTrue(inTrashHere("soup"))
    }

    @Test
    fun aRestoreOfANoteDeletedForGoodMeanwhileDropsItsCopy() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        penmoss.forget("soup")
        runBlocking { store.restoreFromTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup", "restore:soup"), penmoss.trashCalls.toList())
        assertFalse(listed("soup"))
        runBlocking {
            assertNull(store.note("soup"))
            assertEquals(0, store.unsentCount())
        }
    }

    @Test
    fun aNoteOnlyInTheServersTrashIsRestoredAndFetched() {
        penmoss.folder("garden")
        penmoss.edit("soup", "U09VUA==", "Soup")
        penmoss.moveOnWeb("soup", "garden")
        penmoss.trash("soup")
        // A phone that never had it (signed in after it went to Trash, say) restores it from the list.
        runBlocking { assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup", "Soup")) }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("garden", folderOnPhone("soup"))
        assertEquals(listOf("U09VUA=="), penmoss.updates("soup"))
        runBlocking { assertTrue(store.note("soup")!!.cursor != null) }
    }

    @Test
    fun aServerWithoutTheTrashRouteLeavesTheMoveWaitingAndTheNoteKept() {
        soupInGarden()
        penmoss.trashRouteMissing = true
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup"), penmoss.trashCalls.toList())
        // Nothing is dropped: the note is still in Trash here, its move still waits, and the
        // phone knows why.
        assertTrue(inTrashHere("soup"))
        assertTrue(runBlocking { store.observeTrashRouteMissing().first() })
        runBlocking {
            assertEquals(NoteEntity.TRASH_QUEUED, store.note("soup")!!.trashChange)
            assertEquals(1, store.unsentCount())
        }
        // Once the server has the route, the next pass sends it.
        penmoss.trashRouteMissing = false
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(penmoss.inTrash("soup"))
        assertFalse(runBlocking { store.observeTrashRouteMissing().first() })
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    // --- Review of #94 ---

    @Test
    fun undoWhileTheMoveToTrashIsInFlightEndsWithTheNoteRestoredOnTheServer() {
        soupInGarden()
        // The person taps Undo while the request is on its way: the server has applied it.
        penmoss.onTrashAnswered = { id -> runBlocking { assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash(id)) } }
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        penmoss.onTrashAnswered = null
        assertTrue(listed("soup"))
        runBlocking { assertEquals(NoteEntity.RESTORE_QUEUED, store.note("soup")!!.trashChange) }
        // The next pass sends the restore: the server has the note back, in its folder.
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup", "restore:soup"), penmoss.trashCalls.toList())
        assertFalse(penmoss.inTrash("soup"))
        assertEquals("garden", penmoss.folderOf("soup"))
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(listed("soup"))
        assertEquals("garden", folderOnPhone("soup"))
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    @Test
    fun aMoveToTrashWhileTheRestoreIsInFlightEndsWithTheNoteInTrashFromItsFolder() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        // Restored, then moved to Trash again while the restore is on its way.
        penmoss.onRestoreAnswered = { id -> runBlocking { assertTrue(store.moveToTrash(id)) } }
        runBlocking { store.restoreFromTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        penmoss.onRestoreAnswered = null
        assertEquals(PassOutcome.SYNCED, pass())
        // The server restored it, the phone filed it back, then moved it to Trash: never refused
        // over its own restore, and recorded in Garden, so a restore later puts it back there.
        assertEquals(listOf("trash:soup", "restore:soup", "trash:soup"), penmoss.trashCalls.toList())
        assertTrue(penmoss.inTrash("soup"))
        assertEquals("garden", penmoss.deletedFrom("soup"))
        assertFalse(listed("soup"))
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    /**
     * Trash, Undo after it was sent, Trash again: never refused over the phone's own restore.
     * (No clock is compared any more, so the clock-skew runs of the first review are gone.)
     */
    @Test
    fun trashUndoTrashIsNeverRefusedOverThePhonesOwnRestore() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { store.restoreFromTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(penmoss.inTrash("soup"))
        assertFalse(listed("soup"))
        assertEquals(PassOutcome.SYNCED, pass())
        assertFalse(listed("soup"))
        runBlocking { assertEquals(0, store.unsentCount()) }
        assertEquals(emptyList<TrashNotice>(), runBlocking { store.observeTrashNotices().first() })
    }

    @Test
    fun aNoteMovedHereThenTrashedIsRecordedInItsNewFolder() {
        penmoss.folder("kitchen")
        soupInGarden()
        online = false
        runBlocking {
            assertEquals(NoteStore.Move.MOVED, store.moveNote("soup", "kitchen"))
            store.moveToTrash("soup")
        }
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        // Filed first, then trashed: the server records Kitchen, as the web would.
        assertEquals(listOf("soup" to "kitchen"), penmoss.moves.toList())
        assertEquals("kitchen", penmoss.deletedFrom("soup"))
        runBlocking { store.restoreFromTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("kitchen", penmoss.folderOf("soup"))
        assertEquals("kitchen", folderOnPhone("soup"))
    }

    @Test
    fun aNoteMadeOfflineInAFolderAndTrashedIsRecordedInThatFolder() {
        penmoss.folder("kitchen")
        assertEquals(PassOutcome.SYNCED, pass())
        online = false
        runBlocking {
            assertTrue(store.addLocalNote(PageNote("new", "", "TkVX"), "kitchen"))
            assertTrue(store.moveToTrash("new"))
        }
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("TkVX"), penmoss.updates("new"))
        assertTrue(penmoss.inTrash("new"))
        assertEquals("kitchen", penmoss.deletedFrom("new"))
        runBlocking { store.restoreFromTrash("new") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals("kitchen", penmoss.folderOf("new"))
    }

    @Test
    fun aMoveToTrashOfANoteTheServerDoesNotHaveDropsTheCopy() {
        soupInGarden()
        penmoss.forget("soup")
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup"), penmoss.trashCalls.toList())
        runBlocking {
            assertNull(store.note("soup"))
            assertEquals(0, store.unsentCount())
            assertFalse(store.observeTrashRouteMissing().first())
        }
    }

    // --- Second review of #94: a request with no answer may have reached the server ---

    /** The move to Trash reaches the server and its answer is lost ([lose]); then Restore offline. */
    private fun restoreAfterAMoveWithNoAnswer(lose: () -> Unit) {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        lose()
        pass()
        answerLost = null
        // The server has it in Trash; the phone was never told, and queued the move again.
        assertTrue(penmoss.inTrash("soup"))
        runBlocking { assertEquals(NoteEntity.TRASH_QUEUED, store.note("soup")!!.trashChange) }
        online = false
        // Restore: queued, never a cancel, as the server may have the move.
        runBlocking { assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup")) }
        assertTrue(listed("soup"))
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup", "restore:soup"), penmoss.trashCalls.toList())
        assertFalse(penmoss.inTrash("soup"))
        assertEquals("garden", penmoss.folderOf("soup"))
        assertTrue(listed("soup"))
        assertEquals("garden", folderOnPhone("soup"))
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    @Test
    fun aMoveToTrashWhoseAnswerWasLostThenRestoredEndsRestoredOnTheServer() =
        restoreAfterAMoveWithNoAnswer { answerLost = { it.endsWith("/trash") } }

    @Test
    fun aMoveToTrashAnsweredWithAServerErrorThenRestoredEndsRestoredOnTheServer() =
        restoreAfterAMoveWithNoAnswer { penmoss.failAfterApplying = 500 }

    @Test
    fun aMoveToTrashInFlightWhenTheAppStoppedThenRestoredEndsRestoredOnTheServer() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        // A pass marked it in flight and sent it, the server applied it, and the app stopped
        // before the answer came.
        runBlocking { assertTrue(store.trashSending("soup")) }
        penmoss.trash("soup")
        // The next pass, offline, queues it again.
        online = false
        pass()
        runBlocking { assertEquals(NoteEntity.TRASH_QUEUED, store.note("soup")!!.trashChange) }
        runBlocking { assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup")) }
        online = true
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("restore:soup"), penmoss.trashCalls.toList())
        assertFalse(penmoss.inTrash("soup"))
        assertTrue(listed("soup"))
        assertEquals("garden", folderOnPhone("soup"))
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    @Test
    fun aRestoreThatNeverArrivedWithTrashAndUndoMeanwhileIsSentAgain() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(penmoss.inTrash("soup"))
        runBlocking { store.restoreFromTrash("soup") }
        // While the restore is on its way, Move to Trash and then Undo; then the connection
        // drops before the server sees the restore.
        var undone: NoteStore.Restore? = null
        onTheWay = { path ->
            path.endsWith("/restore") && runBlocking {
                store.moveToTrash("soup")
                undone = store.restoreFromTrash("soup")
                true
            }
        }
        pass()
        onTheWay = null
        assertEquals(NoteStore.Restore.QUEUED, undone)
        assertTrue(penmoss.inTrash("soup"))
        assertTrue(listed("soup"))
        runBlocking { assertEquals(NoteEntity.RESTORE_QUEUED, store.note("soup")!!.trashChange) }
        // The restore goes again: the server ends as the phone shows it.
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertFalse(penmoss.inTrash("soup"))
        assertTrue(listed("soup"))
        assertEquals("garden", folderOnPhone("soup"))
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    @Test
    fun aMoveToTrashThatNeverArrivedWithUndoAndTrashMeanwhileIsSentAgain() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        // While the move is on its way, Undo and then Move to Trash; then the connection drops.
        var trashedAgain = false
        onTheWay = { path ->
            path.endsWith("/trash") && runBlocking {
                store.restoreFromTrash("soup")
                trashedAgain = store.moveToTrash("soup")
                true
            }
        }
        pass()
        onTheWay = null
        assertTrue(trashedAgain)
        assertFalse(penmoss.inTrash("soup"))
        assertFalse(listed("soup"))
        runBlocking { assertEquals(NoteEntity.TRASH_QUEUED, store.note("soup")!!.trashChange) }
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertTrue(penmoss.inTrash("soup"))
        assertEquals("garden", penmoss.deletedFrom("soup"))
        assertFalse(listed("soup"))
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    @Test
    fun aNotFoundPageThatIsNotJsonLeavesTheMoveToTrashWaitingAndTheNoteKept() {
        soupInGarden()
        penmoss.proxyNotFound = true
        runBlocking { store.moveToTrash("soup") }
        pass()
        // Not "No such note": nothing is dropped, and the move waits for the next pass, said
        // as a server that cannot take it yet (what an older server's 404 looks like too).
        runBlocking { assertEquals(NoteEntity.TRASH_QUEUED, store.note("soup")!!.trashChange) }
        assertTrue(inTrashHere("soup"))
        assertTrue(runBlocking { store.observeTrashRouteMissing().first() })
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup (proxy 404)", "trash:soup"), penmoss.trashCalls.toList())
        assertTrue(penmoss.inTrash("soup"))
        assertFalse(runBlocking { store.observeTrashRouteMissing().first() })
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    @Test
    fun aNotFoundPageThatIsNotJsonLeavesTheRestoreWaitingAndTheNoteKept() {
        soupInGarden()
        runBlocking { store.moveToTrash("soup") }
        assertEquals(PassOutcome.SYNCED, pass())
        penmoss.proxyNotFound = true
        runBlocking { store.restoreFromTrash("soup") }
        pass()
        runBlocking { assertEquals(NoteEntity.RESTORE_QUEUED, store.note("soup")!!.trashChange) }
        assertTrue(listed("soup"))
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(PassOutcome.SYNCED, pass())
        assertEquals(listOf("trash:soup", "restore:soup (proxy 404)", "restore:soup"), penmoss.trashCalls.toList())
        assertFalse(penmoss.inTrash("soup"))
        assertTrue(listed("soup"))
        assertEquals("garden", folderOnPhone("soup"))
    }
}
