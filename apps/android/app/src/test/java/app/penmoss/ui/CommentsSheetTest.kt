package app.penmoss.ui

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.editor.CommentDraft
import app.penmoss.editor.CommentsState
import app.penmoss.editor.NoteComments
import app.penmoss.engine.api.AgentSession
import app.penmoss.engine.api.AgentSessionList
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossCommentsApi
import app.penmoss.engine.bridge.CommentAuthor
import app.penmoss.engine.bridge.CommentDelivery
import app.penmoss.engine.bridge.CommentEntry
import app.penmoss.engine.bridge.CommentTarget
import app.penmoss.engine.bridge.CommentThread
import app.penmoss.engine.bridge.DeliveryFailure
import app.penmoss.engine.bridge.DeliveryState
import app.penmoss.engine.bridge.ThreadStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import androidx.compose.ui.test.assertTextEquals
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Comments sheet (T48): threads in the page's order with the Open and Resolved filter, their
 * writers (agents marked) and delivery, a reply, Ryan's own comments edited and an agent's
 * removed, Resolve and Reopen, the new thread's composer, and Send to… with the sessions the
 * notebook's WorkspaceDoc lists (T60, A1065, A1079).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// A Pixel's screen: the whole thread, with its buttons, shows at once.
@Config(qualifiers = "w411dp-h914dp")
class CommentsSheetTest {
    @get:Rule
    val compose = createComposeRule()

    private val you = CommentAuthor(agent = false, label = "Pixel 9")
    private val codex = CommentAuthor(agent = true, label = "Codex")
    private val target = CommentTarget("01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "0123456789abcdef01234567", "Codex · garden")
    private val open = CommentThread(
        "T1", ThreadStatus.OPEN, "Raised beds by the fence", false, true, 1, you,
        listOf(CommentEntry("C1", you, "Still the plan?", 1), CommentEntry("C2", codex, "Yes, in May.", 2)),
        target = target, delivery = CommentDelivery(DeliveryState.REPLIED, 2),
    )
    private val resolved = CommentThread(
        "T2", ThreadStatus.RESOLVED, "", true, false, 0, codex,
        listOf(CommentEntry("C3", codex, "Start here", 0)), resolvedAt = 5, resolvedBy = you,
    )

    private val calls = mutableListOf<String>()

    /** Sessions as the notebook lists them (T60, A1076): one running, one idle, one too old to offer. */
    private val now = 1_762_300_000_000L
    private val live = AgentSession("0123456789abcdef01234567", "01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "Claude Code · garden", lastSeen = now - 60_000, active = true, offered = true)
    private val idle = AgentSession("89abcdef0123456789abcdef", "01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "Claude Code · paths", lastSeen = now - 5 * 3_600_000, offered = true)
    private val old = AgentSession("fedcba9876543210fedcba98", "01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "Claude Code · old", lastSeen = now - 9 * 86_400_000L)
    private val listed = AgentSessionList(now, synced = true, sessions = listOf(live, idle, old))

    private fun show(
        state: CommentsState = CommentsState(listOf(open, resolved), open = 1, active = "T1", known = true),
        draft: CommentDraft? = null,
        editable: Boolean = true,
        sendTo: SendToUi = SendToUi(),
    ) {
        compose.setContent {
            PenmossTheme {
                CommentsSheet(
                    state = state,
                    draft = draft,
                    editable = editable,
                    sendTo = sendTo,
                    onLoadSendTo = { calls += "load" },
                    onNewComment = { calls += "new" },
                    onCancelDraft = { calls += "cancel" },
                    onCreate = { body, to -> calls += "create $body ${to?.label}"; true },
                    onSelect = { calls += "select $it" },
                    onReply = { id, body -> calls += "reply $id $body"; true },
                    onEdit = { id, comment, body -> calls += "edit $id $comment $body"; true },
                    onDelete = { id, comment -> calls += "delete $id $comment" },
                    onDeleteThread = { calls += "deleteThread $it" },
                    onStatus = { id, status -> calls += "status $id ${status.wire}" },
                    onTarget = { id, to -> calls += "target $id ${to?.writer}/${to?.session}/${to?.label}" },
                    onDismiss = { calls += "dismiss" },
                    now = now,
                    onNewNoteComment = { calls += "newNote" },
                )
            }
        }
    }

    /** T39 pass 3 (A909): Delete thread is named; Send to… is back in a git notebook (T60, A1065). */
    @Test
    fun aNoteOffersSendToAndDeleteThreadIsNamed() {
        show(draft = CommentDraft("Raised beds", range = true))
        compose.onNodeWithTag("commentComposer").assertExists()
        compose.onNodeWithTag("commentDraftSendTo").assertTextEquals("Send to…")
        compose.onNodeWithTag("commentSendTo-T1").assertTextEquals("Send to…")
        compose.onNodeWithTag("commentDeleteThread-T1").assertTextEquals("Delete Thread")
        assertEquals(emptyList<String>(), calls)
    }

    /**
     * A session with a long name picked on a phone (found on the emulator, 5 Nov 2026): Send to
     * takes its own line, so Comment keeps its label and its one-line height, never squeezed
     * into a narrow column (A1096).
     */
    @Test
    fun aLongSessionNameLeavesTheCommentButtonWhole() {
        val long = AgentSession("0123456789abcdef01234567", "01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "Claude Code · t60-check on Ryan’s Mac", lastSeen = now - 60_000, active = true, offered = true)
        show(draft = CommentDraft("scratch", range = true), sendTo = SendToUi(sessions = AgentSessionList(now, synced = true, sessions = listOf(long))))
        compose.onNodeWithTag("commentDraftSendTo").performClick()
        compose.onNodeWithTag("sendTo-${long.key}").performClick()
        compose.onNodeWithTag("commentDraftSendTo").assertTextContains("Send to Claude Code", substring = true)
        val button = compose.onNodeWithTag("commentCreate").getUnclippedBoundsInRoot()
        val cancel = compose.onNodeWithTag("commentCancel").getUnclippedBoundsInRoot()
        assertTrue("Comment is ${button.width} wide", button.width >= 80.dp)
        assertTrue("Comment is ${button.height} high", button.height <= 56.dp)
        assertTrue("Cancel is ${cancel.width} wide", cancel.width >= 64.dp)
        compose.onNodeWithTag("commentBody").performTextInput("Please change it.")
        compose.onNodeWithTag("commentCreate").performClick()
        assertEquals(listOf("load", "create Please change it. ${long.label}"), calls)
    }

    @Test
    fun writesANewThreadWithItsQuoteAndSendsItToTheSessionPicked() {
        show(draft = CommentDraft("beds", range = true), sendTo = SendToUi(sessions = listed))
        compose.onNodeWithTag("commentCreate").assertIsNotEnabled()
        compose.onNodeWithTag("commentDraftSendTo").performClick()
        // Nobody first; then running sessions, then idle ones with when they were last seen; none older.
        compose.onNodeWithTag("sendToNone").assertTextContains("Nobody")
        compose.onNodeWithTag("sendTo-${live.key}").assertTextContains("Claude Code · garden")
        compose.onNodeWithTag("sendTo-${idle.key}").assertTextContains("Claude Code · paths (last seen ${shortWhen(idle.lastSeen, now)})")
        compose.onNodeWithTag("sendTo-${old.key}").assertDoesNotExist()
        compose.onNodeWithTag("sendTo-${live.key}").performClick()
        compose.onNodeWithText("Send to Claude Code · garden").assertExists()
        // A new thread's first option is always Nobody, a session picked or not (A1074, A1079).
        compose.onNodeWithTag("commentDraftSendTo").performClick()
        compose.onNodeWithTag("sendToNone").assertTextContains("Nobody")
        compose.onNodeWithTag("sendTo-${live.key}").performClick()
        compose.onNodeWithTag("commentBody").performTextInput("Can you check?")
        compose.onNodeWithTag("commentCreate").performClick()
        assertEquals(listOf("load", "load", "create Can you check? Claude Code · garden"), calls)
    }

    @Test
    fun sendsAThreadToASessionAndStopsSendingIt() {
        show(sendTo = SendToUi(sessions = listed))
        compose.onNodeWithTag("commentSendTo-T1").performClick()
        // T1 is sent to garden already: its row is chosen, and the first option stops sending.
        compose.onNodeWithTag("sendToNone").assertTextContains("Stop sending")
        compose.onNodeWithTag("sendTo-${idle.key}").performClick()
        compose.onNodeWithTag("commentSendTo-T1").performClick()
        compose.onNodeWithTag("sendToNone").performClick()
        assertEquals(
            listOf(
                "load",
                "target T1 ${idle.writer}/${idle.key}/Claude Code · paths",
                "load",
                "target T1 null/null/null",
            ),
            calls,
        )
        assertEquals(CommentTarget(idle.writer, idle.key, "Claude Code · paths"), targetOf(idle))
    }

    @Test
    fun saysHowToStartASessionWhenThereIsNone() {
        show(sendTo = SendToUi(sessions = AgentSessionList(now, synced = true, sessions = listOf(old))))
        compose.onNodeWithTag("commentSendTo-T1").performClick()
        compose.onNodeWithTag("sendToEmpty")
            .assertTextEquals("No agent sessions yet: start one with penmoss mcp --notebook … --channel.")
    }

    @Test
    fun aDeliveryToASessionGoneSaysSoAndOffersSendToAgain() {
        val gone = open.copy(delivery = CommentDelivery(DeliveryState.FAILED, 3, DeliveryFailure.GONE))
        show(CommentsState(listOf(gone), open = 1, active = null, known = true), sendTo = SendToUi(sessions = listed))
        compose.onNodeWithTag("commentDelivery-T1", useUnmergedTree = true).assertTextEquals("Not sent: the session is gone")
        compose.onNodeWithTag("commentSendAgain-T1").assertTextEquals("Send to again").performClick()
        compose.onNodeWithTag("sendTo-${live.key}").performClick()
        assertEquals(listOf("load", "target T1 ${live.writer}/${live.key}/Claude Code · garden"), calls)
    }

    @Test
    fun theDeliveryTextFollowsTheStates() {
        val states = listOf(
            null to "Sending to Codex · garden…",
            CommentDelivery(DeliveryState.WAITING, 1) to "Waiting for Codex · garden",
            CommentDelivery(DeliveryState.SENT, 1) to "Sent to Codex · garden",
            CommentDelivery(DeliveryState.SEEN, 1) to "Seen",
        )
        val threads = states.mapIndexed { index, (delivery, _) ->
            open.copy(id = "S$index", comments = listOf(CommentEntry("D$index", you, "Look", 1)), delivery = delivery)
        }
        show(CommentsState(threads, open = threads.size, active = null, known = true))
        states.forEachIndexed { index, (_, words) ->
            compose.onNodeWithTag("commentDelivery-S$index", useUnmergedTree = true).assertTextEquals(words)
            compose.onNodeWithTag("commentSendAgain-S$index").assertDoesNotExist()
        }
    }

    @Test
    fun sendToReadsTheSessionsHandsThemOnAndSaysWhenItCannot() = runBlocking {
        var fail: Exception? = null
        val api = object : PenmossCommentsApi {
            override suspend fun agentSessions(): AgentSessionList {
                fail?.let { throw it }
                return listed
            }
        }
        val handed = mutableListOf<AgentSessionList>()
        val model = SendToModel(api, CoroutineScope(Dispatchers.Unconfined), onListed = { handed += it })
        model.load()
        withTimeout(5_000) { model.ui.first { !it.loading } }
        assertEquals(listed, model.ui.value.sessions)
        assertEquals(listOf(live, idle), model.ui.value.sessions!!.offered)
        assertNull(model.ui.value.problem)
        assertEquals(listOf(listed), handed)
        fail = IOException("the page is opening")
        model.load()
        withTimeout(5_000) { model.ui.first { !it.loading } }
        assertTrue(model.ui.value.problem!!.startsWith("Penmoss couldn’t read the notebook’s agent sessions"))
        fail = ApiException(503, "starting", "The notebook is opening")
        model.load()
        withTimeout(5_000) { model.ui.first { !it.loading } }
        assertEquals("Penmoss couldn’t list the agent sessions: The notebook is opening.", model.ui.value.problem)
        // Nothing handed on for a list that was not read.
        assertEquals(1, handed.size)
    }

    /** T52 item 5: a thread on the note as a whole, and Add Note Comment's composer. */
    @Test
    fun aNoteCommentReadsAsTheWholeNoteNeverAsDeletedText() {
        val onNote = CommentThread(
            "T9", ThreadStatus.OPEN, "", orphaned = false, range = false, created = 0, author = you,
            comments = listOf(CommentEntry("C9", you, "Still current?", 0)), note = true,
        )
        show(state = CommentsState(listOf(onNote, open), open = 2, active = null, known = true))
        compose.onNodeWithTag("commentQuote-T9").assertTextContains(NOTE_AS_A_WHOLE)
        compose.onNodeWithTag("commentOrphaned", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("At the start of the note").assertDoesNotExist()
        compose.onNodeWithTag("commentNewNote").assertTextEquals("Add Note Comment").performClick()
        assertEquals(listOf("newNote"), calls)
    }

    @Test
    fun aNoteCommentsComposerSaysItIsOnTheWholeNote() {
        show(draft = CommentDraft("", range = false, note = true))
        compose.onNode(hasText(NOTE_AS_A_WHOLE) and hasAnyAncestor(hasTestTag("commentComposer"))).assertExists()
        compose.onNodeWithTag("commentNewNote").assertDoesNotExist()
    }

    /**
     * With no open threads the tab names both of its buttons as they read (T52 pass): New Comment
     * in Title Case, and, as the web's empty list says, a comment on the whole note.
     */
    @Test
    fun theEmptyListNamesNewCommentAndAddNoteComment() {
        show(state = CommentsState(listOf(resolved), open = 0, active = null, known = true))
        compose.onNodeWithTag("commentsEmpty")
            .assertTextEquals("No open comments. Select text in the note, then Comment, or use New Comment or Add Note Comment.")
    }

    @Test
    fun listsTheOpenThreadsWithTheirWritersAndDelivery() {
        show()
        compose.onNodeWithText("Open 1").assertExists()
        compose.onNodeWithText("Resolved 1").assertExists()
        compose.onNodeWithText("Raised beds by the fence").assertExists()
        compose.onNodeWithText("✦ Codex").assertExists()
        compose.onNodeWithTag("commentDelivery-T1", useUnmergedTree = true).assertTextEquals("Replied")
        // The resolved thread waits behind its filter.
        compose.onNodeWithText("Start here").assertDoesNotExist()
        compose.onNodeWithTag("commentsResolved").performClick()
        compose.onNodeWithText("Start here").assertExists()
        compose.onNodeWithTag("commentOrphaned", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Resolved by Pixel 9", substring = true).assertExists()
    }

    @Test
    fun repliesEditsOwnCommentsRemovesAnAgentsAndResolves() {
        show()
        compose.onNodeWithTag("commentReply-T1").performTextInput("Thanks")
        compose.onNodeWithTag("commentSendReply-T1").performClick()
        // Ryan's own comment can be edited; an agent's only removed (its undo).
        compose.onNodeWithTag("commentEdit-C2").assertDoesNotExist()
        compose.onNodeWithTag("commentDelete-C2").performClick()
        compose.onNodeWithTag("commentEdit-C1").performClick()
        compose.onNodeWithTag("commentEditBody-C1").performTextInput(" Really?")
        compose.onNodeWithTag("commentSave-C1").performClick()
        compose.onNodeWithTag("commentResolve-T1").performClick()
        compose.onNodeWithTag("commentDeleteThread-T1").performClick()
        compose.onNodeWithTag("commentDeleteConfirm").performClick()
        assertEquals(
            listOf("reply T1 Thanks", "delete T1 C2", "edit T1 C1 Still the plan? Really?", "status T1 resolved", "deleteThread T1"),
            calls,
        )
    }

    @Test
    fun aRemovedFirstCommentSaysSoWithNoActionsAndTheThreadsDeleteStillAsks() {
        // A784: the thread and its reply stay.
        val removed = CommentThread(
            "T3", ThreadStatus.OPEN, "Water in the morning.", false, false, 3, you,
            listOf(CommentEntry("C4", you, "", 3, removed = true), CommentEntry("C5", codex, "Before nine.", 4)),
        )
        show(CommentsState(listOf(removed), open = 1, active = "T3", known = true))
        compose.onNodeWithTag("commentRemoved-C4", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Comment removed").assertExists()
        compose.onNodeWithTag("commentEdit-C4").assertDoesNotExist()
        compose.onNodeWithTag("commentDelete-C4").assertDoesNotExist()
        compose.onNodeWithText("Before nine.").assertExists()
        compose.onNodeWithTag("commentDelete-C5").assertExists()
        compose.onNodeWithTag("commentDeleteThread-T3").performClick()
        assertEquals(emptyList<String>(), calls)
        compose.onNodeWithText("Delete this thread?").assertExists()
        compose.onNodeWithTag("commentDeleteConfirm").performClick()
        assertEquals(listOf("deleteThread T3"), calls)
    }

    @Test
    fun aFirstCommentWithRepliesHasItsOwnDeleteWhichKeepsThem() {
        // T1's first comment has a reply: its Delete marks it removed (the page's commentDelete, A784).
        show()
        compose.onNodeWithTag("commentDelete-C1").performClick()
        assertEquals(listOf("delete T1 C1"), calls)
        assertTrue(NoteComments.canRemove(open, 0))
        assertTrue(NoteComments.canRemove(open, 1))
    }

    @Test
    fun aThreadOfOneCommentIsDeletedOnlyAsAThread() {
        val alone = CommentThread("T4", ThreadStatus.OPEN, "fence", false, true, 5, you, listOf(CommentEntry("C6", you, "Only one", 5)))
        show(CommentsState(listOf(alone), open = 1, active = "T4", known = true))
        compose.onNodeWithTag("commentEdit-C6").assertExists()
        compose.onNodeWithTag("commentDelete-C6").assertDoesNotExist()
        compose.onNodeWithTag("commentDeleteThread-T4").assertExists()
        assertFalse(NoteComments.canRemove(alone, 0))
        assertFalse(NoteComments.canRemove(alone, 1))
    }

    @Test
    fun aDeliveryThatFailedSaysWhy() {
        val failed = open.copy(delivery = CommentDelivery(DeliveryState.FAILED, 3, DeliveryFailure.SCOPE))
        show(CommentsState(listOf(failed), open = 1, active = "T1", known = true))
        compose.onNodeWithText("Not sent: Codex · garden can’t see this note").assertExists()
    }

    @Test
    fun aTapOnAThreadsQuoteOpensItInTheNote() {
        show(CommentsState(listOf(open), open = 1, active = null, known = true))
        // Not the active thread: no reply field until it is chosen.
        compose.onNodeWithTag("commentReply-T1").assertDoesNotExist()
        compose.onNodeWithTag("commentQuote-T1").performClick()
        assertEquals(listOf("select T1"), calls)
    }

    @Test
    fun writesANewThreadWithItsQuote() {
        show(draft = CommentDraft("beds", range = true))
        compose.onNodeWithTag("commentComposer").assertExists()
        compose.onNodeWithTag("commentCreate").assertIsNotEnabled()
        compose.onNodeWithTag("commentBody").performTextInput("Can you check?")
        compose.onNodeWithTag("commentCreate").performClick()
        assertEquals(listOf("create Can you check? null"), calls)
    }

    @Test
    fun aNoteThatCannotChangeShowsItsThreadsWithoutActions() {
        show(editable = false)
        compose.onNodeWithText("Still the plan?").assertExists()
        compose.onNodeWithTag("commentReply-T1").assertDoesNotExist()
        compose.onNodeWithTag("commentNew").assertIsNotEnabled()
    }
}
