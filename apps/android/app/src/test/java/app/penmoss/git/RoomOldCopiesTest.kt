package app.penmoss.git

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.git.WithheldCopy
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Room's copies from before Android cleared a git notebook's store (A886, PR #167 delta check):
 * what waits for a sync and what was kept aside are both counted, so Remove and Settings say
 * what would be lost, and a kept copy is read from its own rows.
 */
@RunWith(AndroidJUnit4::class)
class RoomOldCopiesTest {
    private lateinit var db: PenmossDatabase
    private lateinit var copies: RoomOldCopies

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        copies = RoomOldCopies(db)
    }

    @After
    fun close() = db.close()

    private suspend fun note(id: String, epoch: String?, vararg rows: Pair<Int, String>) {
        db.notes().insert(NoteEntity(id, title = id, epoch = epoch))
        for ((state, data) in rows) db.updates().insert(UpdateEntity(noteId = id, state = state, update = data))
    }

    @Test
    fun waitingAndKeptCopiesAreBothCountedUntilEachIsDone() = runTest {
        note("A", "old", UpdateEntity.SYNCED to "a1", UpdateEntity.PENDING to "a2")
        note("B", "old", UpdateEntity.SYNCED to "b1")
        note("C", "new", UpdateEntity.SYNCED to "c1")
        note("D", "old", UpdateEntity.CONFLICT to "d1")
        assertEquals(listOf("new", "old"), copies.epochs().sorted())
        assertEquals(2 to 0, copies.counts("new"))
        val first = copies.before("new")
        assertEquals(listOf("A" to listOf("a1", "a2"), "B" to listOf("b1")), first.map { it.noteId to it.updates })
        // One could not be brought back: kept aside, still counted, read from its own rows.
        copies.keep(first.first { it.noteId == "A" })
        assertEquals(1 to 1, copies.counts("new"))
        val kept = copies.before("new").single { it.kept }
        assertEquals("A" to listOf("a1", "a2"), kept.noteId to kept.updates)
        // Done with each: nothing waits, nothing is kept.
        copies.done(copies.before("new").single { !it.kept })
        copies.done(kept)
        assertEquals(0 to 0, copies.counts("new"))
        assertEquals(emptyList<String>(), copies.before("new").map { it.noteId })
    }

    @Test
    fun aWithheldCopyKeepsEveryRowWhatIsTypedAfterTooAndIsNeverRetriedNorMadeAConflictCopy() = runTest {
        // A copy withheld from the push (A886): Room's rows of it, the page's whole copy, and an
        // edit typed after, which the page refuses (Gone) and whose tombstone follows.
        val store = NoteStore(db, now = { 1_000 })
        note("C", "new", UpdateEntity.SYNCED to "c1", UpdateEntity.PENDING to "c2")
        copies.withhold(listOf(WithheldCopy("C", "O", "Passwords NEWEDIT (recovered)", null, listOf("page"))))
        store.addPending("C", "c3", "new")
        val sent = store.content("C")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("C", error = "Gone")))
        // Never kept apart for a conflict copy, which would make a new note of it, even before the tombstone.
        assertEquals(0, db.updates().count("C", UpdateEntity.CONFLICT))
        store.saveChanges(ChangesPage(2, notes = listOf(ChangedNote("C", 2, purged = true))))
        val held = copies.withheld().single()
        assertEquals("C" to "O", held.noteId to held.origin)
        assertEquals("Passwords NEWEDIT (recovered)", held.title)
        assertEquals(setOf("c1", "c2", "page", "c3"), held.updates.toSet())
        // Nothing to send, nothing kept apart for a conflict copy, out of every list.
        assertEquals(0, store.unsentCount())
        assertEquals(0, db.updates().count("C", UpdateEntity.CONFLICT))
        assertTrue(store.note("C")!!.gone)
        // Never a recovery pass's: not waiting, not kept.
        assertEquals(emptyList<String>(), copies.before("new").map { it.noteId })
        assertEquals(0 to 0, copies.counts("new"))
        assertEquals(1, copies.withheldCount())
        // Deleted for good or kept and synced: gone from the phone's store.
        copies.drop("C")
        assertEquals(emptyList<WithheldCopy>(), copies.withheld())
        assertNull(store.note("C"))
    }
}
