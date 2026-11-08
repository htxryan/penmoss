package app.penmoss.engine.sync

import app.penmoss.engine.api.BatchNoteReply
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExchangeTest {
    private val held = NoteContent(
        noteId = "n",
        cursor = "CURSOR",
        epoch = "e1",
        syncedIds = listOf(1, 2),
        pending = listOf(StoredUpdate(3, "P1"), StoredUpdate(4, "P2")),
        clock = 9,
    )

    private fun decide(reply: BatchNoteReply, content: NoteContent = held) =
        Exchange.decide(content, Exchange.entry(content), reply)

    @Test
    fun sendsTheCursorItWasGivenAndEveryUnconfirmedEdit() {
        val entry = Exchange.entry(held)
        assertEquals("CURSOR", entry.stateVector)
        assertEquals(listOf("P1", "P2"), entry.update)
        assertEquals("e1", entry.epoch)
        // Never fetched: no cursor, so the server sends the whole note.
        assertNull(Exchange.entry(held.copy(cursor = null, pending = emptyList())).stateVector)
        assertNull(Exchange.entry(held.copy(pending = emptyList())).update)
    }

    @Test
    fun asksForTheWholeNoteOnceTooManyUpdatesAreStored() {
        val many = held.copy(syncedIds = (1L..65L).toList())
        assertNull(Exchange.entry(many).stateVector)
        val result = decide(BatchNoteReply("n", "e1", "WHOLE", "SV2", null), many)
        assertTrue(result.replaceAllSynced)
        assertEquals("WHOLE", result.append)
    }

    @Test
    fun aMergeConfirmsTheEditsAndMovesTheCursor() {
        val result = decide(BatchNoteReply("n", "e1", "DIFF", "SV2", null))
        assertEquals(ExchangeResult.Kind.APPLIED, result.kind)
        assertEquals("DIFF", result.append)
        assertEquals(listOf(3L, 4L), result.confirmPending)
        assertEquals("SV2", result.cursor)
        assertEquals(9L, result.contentClock)
        assertEquals(false, result.replaceAllSynced)
    }

    @Test
    fun anEpochMismatchReplacesTheCopyAndKeepsTheEditsApart() {
        val result = decide(BatchNoteReply("n", "e2", "WHOLE", "SV9", "Epoch mismatch"))
        assertEquals(ExchangeResult.Kind.RESET, result.kind)
        assertTrue(result.replaceAllSynced)
        assertEquals(listOf(3L, 4L), result.conflictPending)
        assertEquals(emptyList<Long>(), result.confirmPending)
        assertEquals("e2", result.epoch)
    }

    @Test
    fun aGoneNoteKeepsItsEditsApart() {
        val result = decide(BatchNoteReply("n", null, "", null, "Gone"))
        assertEquals(ExchangeResult.Kind.GONE, result.kind)
        assertTrue(result.gone && result.clearCursor && result.replaceAllSynced)
        assertEquals(listOf(3L, 4L), result.conflictPending)
    }

    @Test
    fun deferredAndFailedNotesAreRetriedWithNothingStored() {
        assertEquals(ExchangeResult.Kind.RETRY, decide(BatchNoteReply("n", "e1", "", null, null, deferred = true)).kind)
        assertEquals(ExchangeResult.Kind.RETRY, decide(BatchNoteReply("n", null, "", null, "Unavailable")).kind)
    }

    @Test
    fun anUploadRefusedForGoodStopsBeingSentByAServerThatDoesNotSayHowFarItGot() {
        val result = decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Malformed update"))
        assertEquals("DIFF", result.append)
        assertEquals(listOf(3L, 4L), result.conflictPending)
        assertEquals(emptyList<Long>(), result.confirmPending)
    }

    private val four = held.copy(
        pending = listOf(StoredUpdate(3, "A"), StoredUpdate(4, "B"), StoredUpdate(5, "C"), StoredUpdate(6, "D")),
    )

    @Test
    fun aRefusalMidListConfirmsWhatWasAppliedAndKeepsTheUntriedEditsPending() {
        // The server applied A, refused B for good, never tried C and D (A289).
        val result = decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Malformed update", applied = 1), four)
        assertEquals(ExchangeResult.Kind.APPLIED, result.kind)
        assertEquals(listOf(3L), result.confirmPending)
        assertEquals(listOf(4L), result.conflictPending)
        assertEquals("SV2", result.cursor)
    }

    @Test
    fun aPassingFailureMidListConfirmsWhatWasAppliedAndKeepsTheRest() {
        // Could not store: nothing is refused for good; C and D and B wait for the next exchange.
        val result = decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Could not store update", applied = 1), four)
        assertEquals(listOf(3L), result.confirmPending)
        assertEquals(emptyList<Long>(), result.conflictPending)
    }

    @Test
    fun sendsAtMostTwoHundredEditsAndConfirmsOnlyThose() {
        val many = held.copy(pending = (1L..250L).map { StoredUpdate(it, "E$it") })
        val entry = Exchange.entry(many)
        assertEquals(Exchange.MAX_UPDATES, entry.update!!.size)
        assertEquals("E1", entry.update.first())
        assertEquals("E200", entry.update.last())
        val result = Exchange.decide(many, entry, BatchNoteReply("n", "e1", "DIFF", "SV2", null, applied = 200))
        assertEquals((1L..200L).toList(), result.confirmPending)
        assertEquals(emptyList<Long>(), result.conflictPending)
        // Fewer when the request has to be smaller (after a 413).
        assertEquals(25, Exchange.entry(many, maxUpdates = 25).update!!.size)
    }

    @Test
    fun keepsOneRequestsUploadsUnderItsSizeButAlwaysSendsOne() {
        val big = "x".repeat(Exchange.MAX_UPLOAD_CHARS / 3 + 1)
        val content = held.copy(pending = (1L..5L).map { StoredUpdate(it, big) })
        assertEquals(2, Exchange.entry(content).update!!.size)
        val huge = held.copy(pending = listOf(StoredUpdate(1, "y".repeat(Exchange.MAX_UPLOAD_CHARS + 1))))
        assertEquals(1, Exchange.entry(huge).update!!.size)
    }

    @Test
    fun anEditMadeBeforeARestoreIsNeverSentAndIsKeptApart() {
        // P1 was typed on the copy of epoch e0; the note has since been reset to e1 (A291).
        val content = held.copy(pending = listOf(StoredUpdate(3, "OLD", epoch = "e0"), StoredUpdate(4, "NEW", epoch = "e1")))
        val entry = Exchange.entry(content)
        assertEquals(listOf("NEW"), entry.update)
        val result = Exchange.decide(content, entry, BatchNoteReply("n", "e1", "DIFF", "SV2", null, applied = 1))
        assertEquals(listOf(4L), result.confirmPending)
        assertEquals(listOf(3L), result.conflictPending)
        // An edit made before the note ever synced has no epoch and goes as usual.
        assertEquals(listOf("P"), Exchange.entry(held.copy(pending = listOf(StoredUpdate(9, "P", epoch = null)))).update)
    }

    @Test
    fun aResetKeepsApartEveryEditIncludingThoseNotSentYet() {
        val many = held.copy(pending = (1L..250L).map { StoredUpdate(it, "E$it") })
        val result = Exchange.decide(many, Exchange.entry(many), BatchNoteReply("n", "e2", "WHOLE", "SV9", "Epoch mismatch"))
        assertEquals(ExchangeResult.Kind.RESET, result.kind)
        assertEquals((1L..250L).toList(), result.conflictPending)
    }

    @Test
    fun aReadOnlyRefusalKeepsTheEditsDue() {
        val result = decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Read-only"))
        assertEquals(emptyList<Long>(), result.conflictPending)
        assertEquals(emptyList<Long>(), result.confirmPending)
        assertEquals("SV2", result.cursor)
    }

    /**
     * T42 on Android (AC12, A651): a refusal no retry clears names the note and the server's
     * words, as the web's catch-up does (A582), so Home can say sync stopped. A failure a retry
     * clears ("Unavailable"), edits kept apart for good (another actor's client id, A290) and a
     * reply that refused nothing are not stops.
     */
    @Test
    fun saysWhenTheServerRefusedEditsThatStayWaiting() {
        assertEquals("Read-only", decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Read-only")).refused)
        assertEquals("Invalid base64", decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Invalid base64")).refused)
        // One of two applied, the next refused: the second still waits.
        assertEquals("Read-only", decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Read-only", applied = 1)).refused)
        assertNull(decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Unavailable")).refused)
        assertNull(decide(BatchNoteReply("n", null, "", null, "Unavailable")).refused)
        assertNull(decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Client id belongs to another actor")).refused)
        assertNull(decide(BatchNoteReply("n", "e1", "DIFF", "SV2", null)).refused)
        // Nothing was sent, so nothing was refused.
        assertNull(decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Read-only"), held.copy(pending = emptyList())).refused)
        // Both applied before the error: nothing waits.
        assertNull(decide(BatchNoteReply("n", "e1", "DIFF", "SV2", "Read-only", applied = 2)).refused)
    }

    @Test
    fun aNoteTheServerDoesNotHaveIsNotFetchedAgainUntilItChanges() {
        val result = decide(BatchNoteReply("n", null, "", null, null), held.copy(pending = emptyList(), cursor = null))
        assertEquals(ExchangeResult.Kind.APPLIED, result.kind)
        assertNull(result.append)
        assertEquals(9L, result.contentClock)
    }

    @Test
    fun asksForTextOnlyWhenTheEngineDoesAndNamesTheCopyItHolds() {
        val plain = Exchange.entry(held.copy(textHash = "H1"))
        assertNull(plain.text)
        assertNull(plain.textHash)
        val asked = Exchange.entry(held.copy(textHash = "H1"), withText = true)
        assertEquals(true, asked.text)
        assertEquals("H1", asked.textHash)
        // No text held yet: asked with no hash, so the server sends it whatever it is.
        assertNull(Exchange.entry(held, withText = true).textHash)
    }

    @Test
    fun keepsTheServersTextOnlyWhenItWasAskedAndTheReplyCarriesTheNote() {
        val asked = Exchange.entry(held, withText = true)
        val result = Exchange.decide(held, asked, BatchNoteReply("n", "e1", "DIFF", "SV2", null, text = "body", textHash = "H2"))
        assertTrue(result.textAsked)
        assertEquals("body", result.text)
        assertEquals("H2", result.textHash)
        // Unchanged: the hash alone.
        val same = Exchange.decide(held, asked, BatchNoteReply("n", "e1", "DIFF", "SV2", null, textHash = "H2"))
        assertNull(same.text)
        assertEquals("H2", same.textHash)
        // Not asked: whatever the reply says is ignored.
        val notAsked = decide(BatchNoteReply("n", "e1", "DIFF", "SV2", null, text = "body", textHash = "H2"))
        assertEquals(false, notAsked.textAsked)
        assertNull(notAsked.text)
        // Deferred or gone: no text to keep.
        val deferred = Exchange.decide(held, asked, BatchNoteReply("n", "e1", "", null, null, deferred = true, text = "x"))
        assertNull(deferred.text)
        val gone = Exchange.decide(held, asked, BatchNoteReply("n", null, "", null, Exchange.GONE, text = "x"))
        assertNull(gone.text)
        // A restore's whole note carries its text too.
        val reset = Exchange.decide(held, asked, BatchNoteReply("n", "e2", "WHOLE", "SV9", Exchange.EPOCH_MISMATCH, text = "restored", textHash = "H9"))
        assertEquals("restored", reset.text)
    }

    /** A note made here, never uploaded nor filed (T43, fix c): its first upload names its folder. */
    private val made = NoteContent(
        noteId = "m",
        cursor = null,
        epoch = null,
        syncedIds = emptyList(),
        pending = listOf(StoredUpdate(5, "WHOLE")),
        clock = 0,
        fileOnUpload = app.penmoss.engine.api.InFolder("plans"),
    )

    @Test
    fun aFirstUploadNamesItsFolderAndAReplyThatFiledItSaysWhere() {
        val entry = Exchange.entry(made)
        assertEquals(kotlinx.serialization.json.JsonPrimitive("plans"), entry.folderId)
        // The top level is sent as JSON null, not left out.
        assertEquals(kotlinx.serialization.json.JsonNull, Exchange.entry(made.copy(fileOnUpload = app.penmoss.engine.api.InFolder(null))).folderId)
        // Nothing to upload, nothing to file; nor a note that is not asking.
        assertNull(Exchange.entry(made.copy(pending = emptyList())).folderId)
        assertNull(Exchange.entry(held).folderId)

        val filed = Exchange.decide(made, entry, BatchNoteReply("m", "e1", "", "SV1", null, applied = 1, filed = app.penmoss.engine.api.BatchFiled("work")))
        assertEquals(ExchangeResult.Filed(asked = "plans", landed = "work"), filed.filed)
        // An older server, or one that filed nothing: the filer's to do.
        assertNull(Exchange.decide(made, entry, BatchNoteReply("m", "e1", "", "SV1", null, applied = 1)).filed)
        // A reply that says filed for a request that did not ask is not believed.
        assertNull(Exchange.decide(held, Exchange.entry(held), BatchNoteReply("n", "e1", "DIFF", "SV2", null, filed = app.penmoss.engine.api.BatchFiled("x"))).filed)
    }
}
