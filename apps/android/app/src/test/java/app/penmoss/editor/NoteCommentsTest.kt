package app.penmoss.editor

import app.penmoss.engine.api.AgentSession
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.SessionSeen
import app.penmoss.engine.bridge.CommentAuthor
import app.penmoss.engine.bridge.CommentDelivery
import app.penmoss.engine.bridge.CommentEntry
import app.penmoss.engine.bridge.CommentFromEditor
import app.penmoss.engine.bridge.CommentTarget
import app.penmoss.engine.bridge.CommentThread
import app.penmoss.engine.bridge.CommentToEditor
import app.penmoss.engine.bridge.DeliveryFailure
import app.penmoss.engine.bridge.DeliveryState
import app.penmoss.engine.bridge.DraftSource
import app.penmoss.engine.bridge.ThreadStatus
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Comment threads on the phone (T48): the app keeps what the page lists and sends the page every
 * change the Comments sheet asks for; the page writes it in the note (Kotlin never reads Yjs).
 */
class NoteCommentsTest {
    private val sent = mutableListOf<String>()
    private val notices = mutableListOf<String>()
    private var showing = true
    private val comments = NoteComments("n1", { sent += it }, showing = { showing }, notify = { notices += it })
    private val target = CommentTarget("01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "0123456789abcdef01234567", "Codex · garden")

    private fun messages() = sent.map { BridgeProtocol.decodeToEditor(it) }

    private fun thread(id: String, status: ThreadStatus = ThreadStatus.OPEN, target: CommentTarget? = null, delivery: CommentDelivery? = null) =
        CommentThread(id, status, "quote", false, true, 1, CommentAuthor(false, "You"), listOf(CommentEntry("c-$id", CommentAuthor(false, "You"), "Hi", 1)), target, delivery)

    @Test
    fun keepsWhatThePageListsAndOpensTheSheetWhenAskedTo() {
        assertFalse(comments.state.value.known)
        comments.onMessage(CommentFromEditor.Threads("n1", 1, "T1", listOf(thread("T1"), thread("T2", ThreadStatus.RESOLVED))))
        val state = comments.state.value
        assertTrue(state.known)
        assertEquals(1, state.open)
        assertEquals(1, state.resolved)
        assertEquals(listOf("T2"), state.shown(ThreadStatus.RESOLVED).map { it.id })
        // Another note's list is not this one's.
        comments.onMessage(CommentFromEditor.Threads("n2", 0, null, emptyList()))
        assertEquals(state, comments.state.value)

        val requests = mutableListOf<CommentsRequest>()
        val collected = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined).launchCollect(comments, requests)
        comments.onMessage(CommentFromEditor.Open("n1", "T2"))
        comments.onMessage(CommentFromEditor.Draft("n1", "beds", range = true))
        assertEquals(listOf(CommentsRequest.Thread("T2"), CommentsRequest.Compose), requests)
        assertEquals(CommentDraft("beds", range = true), comments.draft.value)
        collected.cancel()
    }

    @Test
    fun sendsEachChangeToThePage() {
        comments.startDraft(DraftSource.SELECTION)
        // No draft yet: nothing to create.
        assertFalse(comments.create("Hi", null))
        comments.onMessage(CommentFromEditor.Draft("n1", "beds", range = true))
        assertTrue(comments.create("  Still the plan?  ", target))
        assertNull(comments.draft.value)
        assertTrue(comments.reply("T1", "Yes"))
        assertTrue(comments.edit("T1", "C1", "Yes, May"))
        comments.delete("T1", "C2")
        comments.deleteThread("T2")
        comments.setStatus("T1", ThreadStatus.RESOLVED)
        comments.setTarget("T1", null)
        comments.setActive("T1", reveal = true)
        assertEquals(
            listOf(
                CommentToEditor.Draft("n1", DraftSource.SELECTION),
                CommentToEditor.Create("n1", "Still the plan?", target),
                CommentToEditor.Reply("n1", "T1", "Yes"),
                CommentToEditor.Edit("n1", "T1", "C1", "Yes, May"),
                CommentToEditor.Delete("n1", "T1", "C2"),
                CommentToEditor.DeleteThread("n1", "T2"),
                CommentToEditor.Status("n1", "T1", ThreadStatus.RESOLVED),
                CommentToEditor.Target("n1", "T1", null),
                CommentToEditor.Active("n1", "T1", reveal = true),
            ),
            messages(),
        )
    }

    @Test
    fun sendsNoEmptyOrTooLongCommentAndNothingBeforeTheNoteShows() {
        assertFalse(comments.reply("T1", "   "))
        assertFalse(comments.reply("T1", "x".repeat(20_001)))
        assertEquals(emptyList<String>(), sent)
        showing = false
        assertFalse(comments.reply("T1", "Hi"))
        comments.startDraft(DraftSource.CARET)
        assertEquals(emptyList<String>(), sent)
        assertEquals(2, notices.size)
    }

    @Test
    fun saysWhereDeliveryStandsInTheMacsWords() {
        assertNull(NoteComments.deliveryText(thread("T1")))
        assertEquals("Sending to Codex · garden…", NoteComments.deliveryText(thread("T1", target = target)))
        val words = DeliveryState.entries.map { NoteComments.deliveryText(thread("T1", target = target, delivery = CommentDelivery(it, 1))) }
        assertEquals(
            listOf(
                "Waiting for Codex · garden",
                "Sent to Codex · garden",
                "Seen",
                "Replied",
                "Not sent to Codex · garden",
            ),
            words,
        )
        // The session is gone (T60, A1062): Send to again.
        val gone = thread("T1", target = target, delivery = CommentDelivery(DeliveryState.FAILED, 1, DeliveryFailure.GONE))
        assertEquals("Not sent: the session is gone", NoteComments.deliveryText(gone))
        assertTrue(NoteComments.sendAgain(gone))
        assertFalse(NoteComments.sendAgain(thread("T1", target = target, delivery = CommentDelivery(DeliveryState.WAITING, 1))))
        assertFalse(NoteComments.sendAgain(thread("T1")))
        // Why it failed, as the server said (still read).
        assertEquals(
            "Not sent: Codex · garden can’t see this note",
            NoteComments.deliveryText(thread("T1", target = target, delivery = CommentDelivery(DeliveryState.FAILED, 1, DeliveryFailure.SCOPE))),
        )
        assertEquals(
            "Not sent: Codex · garden’s token was revoked",
            NoteComments.deliveryText(thread("T1", target = target, delivery = CommentDelivery(DeliveryState.FAILED, 1, DeliveryFailure.REVOKED))),
        )
        // Agents are marked; only a person's comments can be edited.
        assertEquals("✦ Codex", NoteComments.authorLabel(CommentAuthor(agent = true, label = "Codex")))
        assertEquals("Pixel 9", NoteComments.authorLabel(CommentAuthor(agent = false, label = "Pixel 9")))
        assertFalse(NoteComments.canEdit(CommentEntry("c", CommentAuthor(true, "Codex"), "x", 1)))
        assertTrue(NoteComments.canEdit(CommentEntry("c", CommentAuthor(false, "MacBook"), "x", 1)))
    }

    @Test
    fun handsThePageTheNotebooksSessionsAndSaysWhenAThreadWasSent() {
        val said = mutableListOf<String>()
        val withSent = NoteComments("n1", { sent += it }, showing = { showing }, notify = { notices += it }, onSent = { said += it })
        val live = AgentSession("0123456789abcdef01234567", "01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "Claude Code · garden", lastSeen = 90, active = true, offered = true)
        val bad = live.copy(key = "not-a-key")
        withSent.sessions(listOf(live, bad))
        assertEquals(listOf(CommentToEditor.Sessions("n1", listOf(SessionSeen(live.key, 90)))), messages())
        // Nothing while the page does not show the note.
        showing = false
        withSent.sessions(listOf(live))
        assertEquals(1, sent.size)
        assertTrue(notices.isEmpty())
        withSent.onMessage(CommentFromEditor.Sent("n1", "T1"))
        withSent.onMessage(CommentFromEditor.Sent("n2", "T9"))
        assertEquals(listOf("T1"), said)
    }

    private fun kotlinx.coroutines.CoroutineScope.launchCollect(comments: NoteComments, into: MutableList<CommentsRequest>) =
        launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { comments.requests.collect { into += it } }
}
