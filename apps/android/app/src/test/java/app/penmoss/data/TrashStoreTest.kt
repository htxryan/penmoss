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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The store's side of Trash (T40 P3a, A430): a move to Trash or a restore asked here holds
 * through index pages read before the server had it, and gives way once the index agrees or
 * says something newer.
 */
@RunWith(AndroidJUnit4::class)
class TrashStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private var clock = 1_000L

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { clock })
    }

    @After
    fun close() = db.close()

    private suspend fun page(clock: Long, vararg notes: ChangedNote) = store.saveChanges(ChangesPage(clock, notes = notes.toList()))

    private suspend fun listed(id: String) = store.observeList().first().any { it.id == id }

    private suspend fun soupInGarden() {
        page(1, ChangedNote("soup", 1, "Soup", "", 100))
        store.saveTree(SyncTree(hash = "h1", folders = listOf(TreeFolder("garden", "Garden")), notes = listOf(TreeNote("soup", "garden", "a0"))))
    }

    /** Sends the queued move to Trash as `TrashSender` does: in flight, then the server's answer. */
    private suspend fun trashAnswered(id: String, deletedAt: Long, seq: Long) {
        assertTrue(store.trashSending(id))
        store.trashSent(id, deletedAt, seq)
    }

    private suspend fun restoreAnswered(id: String, folderId: String?, seq: Long) {
        assertTrue(store.restoreSending(id))
        store.restoreSent(id, folderId, restored = true, seq = seq)
    }

    @Test
    fun aMoveToTrashHoldsThroughAStalePageAndSettlesWhenTheIndexAgrees() = runTest {
        soupInGarden()
        assertTrue(store.moveToTrash("soup"))
        // Pages read before it was sent: still not deleted there, and the note stays in Trash.
        page(2, ChangedNote("soup", 2, "Soup", "", 200, seq = 1))
        assertFalse(listed("soup"))
        trashAnswered("soup", deletedAt = 5_000, seq = 3)
        // A row from before the server made the change (seq 3 or less), whatever its time says.
        page(3, ChangedNote("soup", 3, "Soup", "", 9_999_999, seq = 3))
        assertFalse(listed("soup"))
        assertEquals(NoteEntity.TRASH_SENT, store.note("soup")!!.trashChange)
        // The index has it: settled.
        page(4, ChangedNote("soup", 4, "Soup", "", 1, deleted = true, seq = 4))
        assertEquals(0, store.note("soup")!!.trashChange)
        assertFalse(listed("soup"))
        // From now on the server has the last word: restored on the web.
        page(5, ChangedNote("soup", 5, "Soup", "", 2, seq = 5))
        assertTrue(listed("soup"))
    }

    @Test
    fun aSentMoveToTrashGivesWayToARowFromAfterIt() = runTest {
        soupInGarden()
        store.moveToTrash("soup")
        trashAnswered("soup", deletedAt = 5_000, seq = 3)
        // Restored on the Mac after the server took this phone's move: a later row, so it wins,
        // even with a time older than the server's answer (another clock).
        page(2, ChangedNote("soup", 2, "Soup", "", 10, seq = 4))
        assertTrue(listed("soup"))
        assertEquals(0, store.note("soup")!!.trashChange)
    }

    @Test
    fun aRestoreHoldsThroughAStalePageAndIsListedInItsFolderMeanwhile() = runTest {
        soupInGarden()
        store.moveToTrash("soup")
        trashAnswered("soup", deletedAt = 500, seq = 1)
        page(2, ChangedNote("soup", 2, "Soup", "", 500, deleted = true, seq = 2))
        store.saveTree(SyncTree(hash = "h2", folders = listOf(TreeFolder("garden", "Garden"))))
        // The phone's clock is far behind the server's: it never matters.
        clock = -1_000_000
        assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup"))
        restoreAnswered("soup", "garden", seq = 2)
        // A page and a tree read before the restore was indexed: still deleted, not in the tree.
        page(3, ChangedNote("soup", 3, "Soup", "", 9_999_999, deleted = true, seq = 2))
        store.saveTree(SyncTree(hash = "h3", folders = listOf(TreeFolder("garden", "Garden"))))
        val row = store.observeList().first().single { it.id == "soup" }
        assertEquals("garden", row.folderId)
        assertTrue(store.note("soup")!!.toFile)
        assertEquals(NoteEntity.RESTORE_SENT, store.note("soup")!!.trashChange)
        page(4, ChangedNote("soup", 4, "Soup", "", 1, seq = 3))
        assertEquals(0, store.note("soup")!!.trashChange)
        assertTrue(listed("soup"))
        assertTrue(store.note("soup")!!.toFile)
    }

    @Test
    fun aRestoreFromAFolderGoneSinceIsListedAtTheTopLevel() = runTest {
        soupInGarden()
        store.moveToTrash("soup")
        trashAnswered("soup", deletedAt = 500, seq = 1)
        store.saveTree(SyncTree(hash = "h2"))
        store.restoreFromTrash("soup")
        restoreAnswered("soup", "garden", seq = 2)
        assertNull(store.observeList().first().single { it.id == "soup" }.folderId)
        // Filing it asks for that folder all the same: the server answers where it landed (A352).
        assertEquals("garden", store.note("soup")!!.fileIn)
    }

    @Test
    fun undoWhileTheMoveIsInFlightQueuesARestoreRatherThanCancelling() = runTest {
        soupInGarden()
        store.moveToTrash("soup")
        assertTrue(store.trashSending("soup"))
        // Undo while the request travels: the server may already have it, so a restore is queued.
        assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup"))
        assertTrue(listed("soup"))
        store.trashSent("soup", deletedAt = 5_000, seq = 3)
        assertEquals(NoteEntity.RESTORE_QUEUED, store.note("soup")!!.trashChange)
        assertEquals(listOf("soup"), store.restoresDue().map { it.id })
        assertEquals(1, store.trashChangesWaiting())
        // A page showing the server's trash does not hide the note meanwhile.
        page(2, ChangedNote("soup", 2, "Soup", "", 5_000, deleted = true, seq = 4))
        assertTrue(listed("soup"))
    }

    @Test
    fun aMoveToTrashWhileTheRestoreIsInFlightQueuesAMoveAndFilesFirst() = runTest {
        soupInGarden()
        store.moveToTrash("soup")
        trashAnswered("soup", deletedAt = 500, seq = 1)
        store.restoreFromTrash("soup")
        assertTrue(store.restoreSending("soup"))
        assertTrue(store.moveToTrash("soup"))
        store.restoreSent("soup", "garden", restored = true, seq = 2)
        val row = store.note("soup")!!
        assertEquals(NoteEntity.TRASH_QUEUED, row.trashChange)
        assertTrue(row.deleted)
        // Filed in its folder before the move goes, so the server records that folder.
        assertTrue(row.toFile)
        assertEquals("garden", row.fileIn)
        assertEquals(listOf("soup"), store.readyToFile().map { it.id })
        assertTrue(store.trashesDue().isEmpty())
        // The phone's own restore is part of what it has seen.
        assertEquals(3, row.seq)
    }

    @Test
    fun aMoveToTrashSendsWhatThePhoneHadSeenWhenItWasAsked() = runTest {
        page(1, ChangedNote("soup", 1, "Soup", "", 100, seq = 2))
        store.moveToTrash("soup")
        // A row read after the move was asked (a restore elsewhere, say) does not change it.
        page(2, ChangedNote("soup", 2, "Soup", "", 200, seq = 7))
        assertEquals(7, store.note("soup")!!.seq)
        assertEquals(2, store.trashesDue().single().trashSeq)
    }

    @Test
    fun aRequestLeftInFlightByAStoppedPassIsQueuedAgain() = runTest {
        soupInGarden()
        store.moveToTrash("soup")
        assertTrue(store.trashSending("soup"))
        store.requeueTrashInFlight()
        assertEquals(NoteEntity.TRASH_QUEUED, store.note("soup")!!.trashChange)
        // Failed: queued again too.
        assertTrue(store.trashSending("soup"))
        store.trashNotSent("soup")
        assertEquals(listOf("soup"), store.trashesDue().map { it.id })
    }

    // --- Second review of #94: a request tried with no answer may have reached the server ---

    @Test
    fun onlyARequestNeverTriedIsCancelled() = runTest {
        soupInGarden()
        // Never tried: Restore cancels the move to Trash.
        store.moveToTrash("soup")
        assertEquals(NoteStore.Restore.CANCELLED, store.restoreFromTrash("soup"))
        assertEquals(0, store.note("soup")!!.trashChange)
        // Tried with no answer (offline mid-request, a server error): Restore queues a restore.
        store.moveToTrash("soup")
        assertTrue(store.trashSending("soup"))
        store.trashNotSent("soup")
        assertTrue(store.note("soup")!!.trashTried)
        assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup"))
        assertEquals(NoteEntity.RESTORE_QUEUED, store.note("soup")!!.trashChange)
        // Then Move to Trash queues a move, never a cancel: the first may not have arrived.
        assertTrue(store.moveToTrash("soup"))
        assertEquals(NoteEntity.TRASH_QUEUED, store.note("soup")!!.trashChange)
        // Answered: what the server has is known again, and a restore never tried is cancelled.
        assertTrue(store.trashSending("soup"))
        store.trashSent("soup", deletedAt = 5, seq = 3)
        assertFalse(store.note("soup")!!.trashTried)
        assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup"))
        assertTrue(store.moveToTrash("soup"))
        assertEquals(0, store.note("soup")!!.trashChange)
        assertFalse(listed("soup"))
    }

    @Test
    fun aRequestLeftInFlightByAStoppedPassIsNeverCancelledLater() = runTest {
        soupInGarden()
        // A move to Trash in flight when the app stopped, queued again by the next pass.
        store.moveToTrash("soup")
        assertTrue(store.trashSending("soup"))
        store.requeueTrashInFlight()
        assertEquals(NoteStore.Restore.QUEUED, store.restoreFromTrash("soup"))
        assertEquals(NoteEntity.RESTORE_QUEUED, store.note("soup")!!.trashChange)
        // A restore in flight when the app stopped, after a move the server confirmed.
        assertTrue(store.moveToTrash("soup"))
        trashAnswered("soup", deletedAt = 5, seq = 3)
        store.restoreFromTrash("soup")
        assertTrue(store.restoreSending("soup"))
        store.requeueTrashInFlight()
        assertEquals(NoteEntity.RESTORE_QUEUED, store.note("soup")!!.trashChange)
        assertTrue(store.moveToTrash("soup"))
        assertEquals(NoteEntity.TRASH_QUEUED, store.note("soup")!!.trashChange)
    }

    @Test
    fun aRefusedMoveToTrashIsKeptToSayEvenAfterTheAppStopped() = runTest {
        soupInGarden()
        store.moveToTrash("soup")
        assertTrue(store.trashSending("soup"))
        store.trashRefused("soup")
        assertTrue(listed("soup"))
        // The app started again (a new store on the same database): the notice is still there.
        val again = NoteStore(db, now = { clock })
        assertEquals(listOf(TrashNotice("soup", "Soup")), again.observeTrashNotices().first())
        again.trashNoticeShown("soup")
        assertEquals(emptyList<TrashNotice>(), again.observeTrashNotices().first())
        assertFalse(again.note("soup")!!.trashTried)
    }

    @Test
    fun aMoveMadeHereIsFiledBeforeTheMoveToTrashGoes() = runTest {
        soupInGarden()
        store.saveTree(SyncTree(hash = "h2", folders = listOf(TreeFolder("garden", "Garden"), TreeFolder("kitchen", "Kitchen")), notes = listOf(TreeNote("soup", "garden", "a0"))))
        assertEquals(NoteStore.Move.MOVED, store.moveNote("soup", "kitchen"))
        store.moveToTrash("soup")
        // A later page keeps the move to file: the deletion is this phone's own, not sent yet.
        page(2, ChangedNote("soup", 2, "Soup", "", 200, seq = 2))
        assertEquals(listOf("soup"), store.readyToFile().map { it.id })
        assertTrue(store.trashesDue().isEmpty())
        store.markFiled("soup", "kitchen")
        assertEquals(listOf("soup"), store.trashesDue().map { it.id })
    }

    @Test
    fun movingANoteToTrashTwiceOrRestoringOneNotInTrashDoesNothing() = runTest {
        soupInGarden()
        assertEquals(NoteStore.Restore.NOT_IN_TRASH, store.restoreFromTrash("soup"))
        assertTrue(store.moveToTrash("soup"))
        assertFalse(store.moveToTrash("soup"))
        assertFalse(store.moveToTrash("unknown"))
        assertEquals(1, store.trashChangesWaiting())
    }

    @Test
    fun aMoveToTrashWaitsForTheNotesOwnEdits() = runTest {
        soupInGarden()
        store.addPending("soup", "RURJVA==", null)
        store.moveToTrash("soup")
        assertTrue(store.trashesDue().isEmpty())
        assertEquals(2, store.unsentCount())
        // The edit has gone (an exchange stores it synced); then the move is due.
        db.updates().delete(db.updates().ids("soup", UpdateEntity.PENDING))
        assertEquals(listOf("soup"), store.trashesDue().map { it.id })
    }

    @Test
    fun trashListsTheNotesInTrashNewestFirst() = runTest {
        page(1, ChangedNote("old", 1, "Old", "", 100, deleted = true), ChangedNote("soup", 2, "Soup", "", 200))
        clock = 3_000
        store.moveToTrash("soup")
        val rows = store.observeTrash().first()
        assertEquals(listOf("soup", "old"), rows.map { it.id })
        assertEquals(NoteEntity.TRASH_QUEUED, rows.first().trashChange)
        assertEquals(3_000, rows.first().trashChangeAt)
    }
}
