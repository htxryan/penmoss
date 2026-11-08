package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TreeNote
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.sync.Exchange
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
 * Daily and weekly notes on the phone (T40 P5): the editor page makes them with the
 * deterministic bytes, Room keeps their kind and period from `/sync/changes` and
 * `/sync/tree`, and files them through the daily intent once uploaded.
 */
@RunWith(AndroidJUnit4::class)
class JournalStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1_000 })
    }

    @After
    fun close() = db.close()

    @Test
    fun aPeriodsNoteMadeHereWaitsToBeFiledThroughTheDailyIntent() = runTest {
        assertTrue(store.addPeriodicNote(PageNote("d1", "2026-10-21", "U1"), "daily", "2026-10-21", "daily", "2026-10-21"))
        val note = store.note("d1")!!
        assertEquals("daily", note.kind)
        assertEquals("2026-10-21", note.period)
        assertTrue(note.toFile)
        assertEquals("daily", note.fileKind)
        assertEquals("2026-10-21", note.fileDate)
        // Filed once uploaded (the filer sends the content first, then the daily intent).
        uploaded("d1")
        assertEquals(1, store.readyToFile().size)
        // The tree shows it at the top level until it is filed (T40 P5).
        assertNull(note.folderId)
    }

    @Test
    fun todayTwiceOfflineMakesOneNote() = runTest {
        assertTrue(store.addPeriodicNote(PageNote("d1", "2026-10-21", "U1"), "daily", "2026-10-21", "daily", "2026-10-21"))
        // The page rebuilds the same bytes: the second make is just opened.
        assertFalse(store.addPeriodicNote(PageNote("d1", "2026-10-21", "U1"), "daily", "2026-10-21", "daily", "2026-10-21"))
        assertEquals(1, db.updates().updates("d1", UpdateEntity.PENDING).size)
        uploaded("d1")
        assertEquals(1, store.readyToFile().size)
    }

    /** The note's content reached the server, as the engine's exchange records it. */
    private suspend fun uploaded(id: String) {
        val sent = store.content(id)
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply(id, "e", "", "SV", null)))
    }

    @Test
    fun aHeldNoteGainsItsKindWhenThePageRebuildsIt() = runTest {
        store.addLocalNote(PageNote("d1", "2026-10-21", "U1"), null)
        assertEquals("note", store.note("d1")!!.kind)
        assertFalse(store.addPeriodicNote(PageNote("d1", "2026-10-21", "U1"), "daily", "2026-10-21", "daily", "2026-10-21"))
        assertEquals("daily", store.note("d1")!!.kind)
        assertEquals("2026-10-21", store.note("d1")!!.period)
    }

    @Test
    fun aPeriodsNoteInTrashIsStillFiledThroughTheDailyIntent() = runTest {
        store.addPeriodicNote(PageNote("d1", "2026-10-21", "U1"), "daily", "2026-10-21", "daily", "2026-10-21")
        store.moveToTrash("d1")
        // In Trash but asked here (not sent): the intent stays, and files once uploaded.
        assertTrue(store.note("d1")!!.toFile)
        assertEquals("daily", store.note("d1")!!.fileKind)
        val sent = store.content("d1")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("d1", "e", "", "SV", null)))
        // Filed through the daily intent, which restores it on the server (A144).
        assertEquals(1, store.readyToFile().size)
    }

    /** Today's note made here, uploaded and filed: held, with its content (T40 P5). */
    private suspend fun heldDaily() {
        store.addPeriodicNote(PageNote("d1", "2026-10-21", "U1"), "daily", "2026-10-21", "daily", "2026-10-21")
        // Uploaded, the server answering with what it holds: the phone holds the content.
        val sent = store.content("d1")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("d1", "e", "U1", "SV", null)))
        assertTrue(store.holds("d1"))
        store.markFiled("d1", null)
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("d1", 1, "2026-10-21", "", 10, seq = 1, kind = "daily", period = "2026-10-21"))))
        assertFalse(store.note("d1")!!.toFile)
    }

    private val today = PageNote("d1", "2026-10-21", "U1")

    /** Today on a note in Trash (review S3): out of Trash here at once, offline too, and filed under Journal. */
    private suspend fun assertRestoredAndFiled() {
        val note = store.note("d1")!!
        assertFalse(note.deleted)
        assertEquals("daily", note.fileKind)
        assertEquals("2026-10-21", note.fileDate)
        assertEquals(listOf("2026-10-21"), store.observeJournalMarks().first().map { it.period })
        assertEquals(listOf("d1"), store.readyToFile().map { it.id })
        // Nothing stored twice: the phone holds the note's content.
        assertTrue(db.updates().updates("d1", UpdateEntity.PENDING).isEmpty())
    }

    @Test
    fun todayOnANoteTrashedElsewhereRestoresItHereAndFilesIt() = runTest {
        heldDaily()
        // Moved to Trash on another device: no Trash change asked here.
        store.saveChanges(ChangesPage(2, notes = listOf(ChangedNote("d1", 2, "2026-10-21", "", 20, deleted = true, seq = 2, kind = "daily", period = "2026-10-21"))))
        assertTrue(store.note("d1")!!.deleted)
        assertFalse(store.addPeriodicNote(today, "daily", "2026-10-21", "daily", "2026-10-21"))
        assertRestoredAndFiled()
        // The server is asked to restore it too (A430); the daily intent restores it as well (A144).
        assertEquals(NoteEntity.RESTORE_QUEUED, store.note("d1")!!.trashChange)
    }

    @Test
    fun todayOnANoteTrashedHereAndNotSentCancelsTheMove() = runTest {
        heldDaily()
        store.moveToTrash("d1")
        assertEquals(NoteEntity.TRASH_QUEUED, store.note("d1")!!.trashChange)
        assertFalse(store.addPeriodicNote(today, "daily", "2026-10-21", "daily", "2026-10-21"))
        assertRestoredAndFiled()
        // Never tried, so cancelled: the server never hears of it.
        assertEquals(0, store.note("d1")!!.trashChange)
        assertTrue(store.trashesDue().isEmpty())
    }

    @Test
    fun todayOnANoteTheServerMovedToTrashForThisPhoneQueuesARestore() = runTest {
        heldDaily()
        store.moveToTrash("d1")
        assertTrue(store.trashSending("d1"))
        store.trashSent("d1", deletedAt = 30, seq = 3)
        assertEquals(NoteEntity.TRASH_SENT, store.note("d1")!!.trashChange)
        assertFalse(store.addPeriodicNote(today, "daily", "2026-10-21", "daily", "2026-10-21"))
        assertRestoredAndFiled()
        assertEquals(NoteEntity.RESTORE_QUEUED, store.note("d1")!!.trashChange)
        assertEquals(listOf("d1"), store.restoresDue().map { it.id })
    }

    @Test
    fun todayOnAListedNoteWithoutItsContentStoresNothing() = runTest {
        // Made on the web: the phone has its index row, not its content (not prefetched).
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("d1", 1, "2026-10-21", "", 10, seq = 1, kind = "daily", period = "2026-10-21"))))
        assertFalse(store.holds("d1"))
        // The page built bytes from this phone's template; the server's note may differ (review R1).
        assertFalse(store.addPeriodicNote(today, "daily", "2026-10-21", "daily", "2026-10-21"))
        // Nothing stored, nothing to send: the note's screen fetches it (offline: unavailable).
        assertFalse(store.holds("d1"))
        assertTrue(db.updates().updates("d1", UpdateEntity.PENDING).isEmpty())
        val note = store.note("d1")!!
        assertFalse(note.toFile)
        assertNull(note.fileKind)
    }

    @Test
    fun todayOnANoteMovedThenTrashedHereKeepsTheMove() = runTest {
        store.saveTree(SyncTree("h", folders = listOf(TreeFolder("f1", "F", position = "a0")), notes = emptyList()))
        heldDaily()
        // Moved, then trashed, before either was sent (A430: the move is filed first).
        store.moveNote("d1", "f1")
        store.moveToTrash("d1")
        assertFalse(store.addPeriodicNote(today, "daily", "2026-10-21", "daily", "2026-10-21"))
        val note = store.note("d1")!!
        // Out of Trash here, and the move made here still goes (review R-N1).
        assertFalse(note.deleted)
        assertTrue(note.toFile)
        assertEquals("f1", note.fileIn)
        assertNull(note.fileKind)
        assertEquals(0, note.trashChange)
    }

    @Test
    fun todayOnANoteDeletedForGoodMakesItAfreshAndKeepsTheEditsKeptApart() = runTest {
        heldDaily()
        store.addPending("d1", "U2", store.note("d1")!!.epoch)
        // Deleted for good elsewhere, with an edit not sent: kept apart for its conflict copy.
        store.purged("d1")
        assertTrue(store.note("d1")!!.gone)
        val keptApart = db.updates().updates("d1", UpdateEntity.CONFLICT)
        assertEquals(listOf("U2"), keptApart.map { it.update })
        val bases = db.updates().updates("d1", UpdateEntity.BASE).map { it.id }
        assertTrue(bases.isNotEmpty())
        // Today makes it afresh: listed, to upload with no epoch and file through the daily intent.
        assertTrue(store.addPeriodicNote(today, "daily", "2026-10-21", "daily", "2026-10-21"))
        val note = store.note("d1")!!
        assertFalse(note.gone)
        assertFalse(note.deleted)
        assertEquals("daily", note.kind)
        assertEquals("daily", note.fileKind)
        val pending = db.updates().updates("d1", UpdateEntity.PENDING)
        assertEquals(listOf("U1"), pending.map { it.update })
        assertNull(pending.single().epoch)
        // The edits kept apart and their base are untouched, so their conflict copy is still made.
        assertEquals(keptApart.map { it.id }, db.updates().updates("d1", UpdateEntity.CONFLICT).map { it.id })
        assertEquals(bases, db.updates().updates("d1", UpdateEntity.BASE).map { it.id })
        val copy = store.conflictSet("d1")!!
        assertEquals(listOf("U2"), copy.edits.map { it.update })
        assertTrue(copy.base.isNotEmpty())
    }

    @Test
    fun changesRowsCarryEachNotesKindAndPeriod() = runTest {
        store.saveChanges(
            ChangesPage(
                3,
                notes = listOf(
                    ChangedNote("d1", 1, "2026-10-21", "", 10, kind = "daily", period = "2026-10-21"),
                    ChangedNote("w1", 2, "2026-W43", "", 20, kind = "weekly", period = "2026-W43"),
                    ChangedNote("n1", 3, "Plain", "", 30),
                ),
            ),
        )
        assertEquals("daily", store.note("d1")!!.kind)
        assertEquals("2026-10-21", store.note("d1")!!.period)
        assertEquals("weekly", store.note("w1")!!.kind)
        assertEquals("note", store.note("n1")!!.kind)
        assertNull(store.note("n1")!!.period)
        // The calendar marks the journal notes.
        val marks = store.observeJournalMarks().first()
        assertEquals(2, marks.size)
    }

    @Test
    fun aChangesRowFromAnOlderServerKeepsTheKindRoomHolds() = runTest {
        store.addPeriodicNote(today, "daily", "2026-10-21", "daily", "2026-10-21")
        // A server from before T40 P5 sends no kind or period (review N2).
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("d1", 1, "2026-10-21", "", 10, seq = 1))))
        assertEquals("daily", store.note("d1")!!.kind)
        assertEquals("2026-10-21", store.note("d1")!!.period)
        assertEquals(listOf("2026-10-21"), store.observeJournalMarks().first().map { it.period })
    }

    @Test
    fun theTreeCarriesEveryJournalNotesKindAndPeriod() = runTest {
        store.saveTree(
            SyncTree(
                "h1",
                notes = listOf(
                    TreeNote("d1", null, "a0", kind = "daily", period = "2026-10-21"),
                    TreeNote("n1", null, "a1"),
                ),
            ),
        )
        assertEquals("daily", store.note("d1")!!.kind)
        assertEquals("2026-10-21", store.note("d1")!!.period)
        assertEquals("note", store.note("n1")!!.kind)
        // A tree from an older server sends neither: what Room holds stands.
        store.saveTree(SyncTree("h2", notes = listOf(TreeNote("d1", null, "a0"), TreeNote("n1", null, "a1"))))
        assertEquals("daily", store.note("d1")!!.kind)
    }

    @Test
    fun marksLeaveOutTrashAndDeletedForGood() = runTest {
        store.saveChanges(
            ChangesPage(
                2,
                notes = listOf(
                    ChangedNote("d1", 1, "2026-10-21", "", 10, kind = "daily", period = "2026-10-21"),
                    ChangedNote("d2", 2, "2026-10-22", "", 20, kind = "daily", period = "2026-10-22", deleted = true),
                ),
            ),
        )
        assertEquals(listOf("2026-10-21"), store.observeJournalMarks().first().map { it.period })
        store.purged("d1")
        assertTrue(store.observeJournalMarks().first().isEmpty())
    }

    @Test
    fun aMoveReplacesADailyIntentStillWaiting() = runTest {
        store.saveTree(SyncTree("h", folders = listOf(TreeFolder("f1", "F", position = "a0")), notes = emptyList()))
        store.addPeriodicNote(PageNote("d1", "2026-10-21", "U1"), "daily", "2026-10-21", "daily", "2026-10-21")
        store.moveNote("d1", "f1")
        val note = store.note("d1")!!
        // Filed as a move now (the user's explicit choice wins); no daily intent left.
        assertNull(note.fileKind)
        assertNull(note.fileDate)
        assertEquals("f1", note.fileIn)
    }
}
