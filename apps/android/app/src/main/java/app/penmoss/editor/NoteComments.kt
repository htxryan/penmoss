package app.penmoss.editor

import app.penmoss.engine.api.AgentSession
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.SessionSeen
import app.penmoss.engine.bridge.CommentDelivery
import app.penmoss.engine.bridge.CommentEntry
import app.penmoss.engine.bridge.CommentFromEditor
import app.penmoss.engine.bridge.CommentLimits
import app.penmoss.engine.bridge.CommentTarget
import app.penmoss.engine.bridge.CommentThread
import app.penmoss.engine.bridge.CommentToEditor
import app.penmoss.engine.bridge.DeliveryFailure
import app.penmoss.engine.bridge.DeliveryState
import app.penmoss.engine.bridge.DraftSource
import app.penmoss.engine.bridge.ThreadStatus
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/** The open note's threads as the page last listed them (T48); [known] false until it has. */
data class CommentsState(
    val threads: List<CommentThread> = emptyList(),
    val open: Int = 0,
    val active: String? = null,
    val known: Boolean = false,
) {
    val resolved: Int get() = threads.count { it.status == ThreadStatus.RESOLVED }

    /** The threads the sheet's filter shows, in document order (orphans last, as the page sent them). */
    fun shown(status: ThreadStatus): List<CommentThread> = threads.filter { it.status == status }
}

/** Where a new thread goes, as the page took it: its quote, on a passage, at a point, or on the whole [note] (T52 item 5). */
data class CommentDraft(val quote: String, val range: Boolean, val note: Boolean = false)

/** What asks the note screen to show the Comments sheet. */
sealed interface CommentsRequest {
    /** On a thread: a highlight was tapped. */
    data class Thread(val id: String) : CommentsRequest

    /** With the new thread's composer: the page took its place. */
    data object Compose : CommentsRequest
}

/**
 * Comment threads on the phone (T48, D40, A770–A784), for one open note: what the page lists,
 * and every change the Comments sheet asks for, sent to the page, which writes it in the note's
 * own document (Kotlin never reads Yjs, A11); the change then reaches [NoteEditorController] as
 * an ordinary edit to store and upload, offline included.
 */
class NoteComments(
    private val noteId: String,
    private val send: (String) -> Unit,
    /** Whether the page shows the note now: nothing is sent before. */
    private val showing: () -> Boolean,
    private val notify: (String) -> Unit,
    /**
     * The page sent a thread to its agent session just now (T60, A1078), its update posted
     * first: the note's editor stores it, then the notebook syncs at once.
     */
    private val onSent: (threadId: String) -> Unit = {},
) {
    private val _state = MutableStateFlow(CommentsState())

    /** The threads, open count and active thread, as the page last said. */
    val state: StateFlow<CommentsState> = _state.asStateFlow()

    private val _draft = MutableStateFlow<CommentDraft?>(null)

    /** The new thread being written, once the page has taken its place; null for none. */
    val draft: StateFlow<CommentDraft?> = _draft.asStateFlow()

    private val _requests = MutableSharedFlow<CommentsRequest>(extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** The sheet is to open: on a tapped thread, or with a new thread's composer. */
    val requests: SharedFlow<CommentsRequest> = _requests.asSharedFlow()

    fun onMessage(message: CommentFromEditor) {
        if (message.noteId != noteId) return
        when (message) {
            is CommentFromEditor.Threads -> _state.value = CommentsState(message.threads, message.open, message.active, known = true)
            is CommentFromEditor.Open -> _requests.tryEmit(CommentsRequest.Thread(message.threadId))
            is CommentFromEditor.Draft -> {
                _draft.value = CommentDraft(message.quote, message.range, message.note)
                _requests.tryEmit(CommentsRequest.Compose)
            }
            is CommentFromEditor.Sent -> onSent(message.threadId)
        }
    }

    /**
     * The sessions the notebook lists (T60, A1077), read as the note's comments are shown: the
     * page fails each delivery still waiting for a session gone a week (A1062). Only once a sync
     * has landed, which the caller checks; nothing is sent while the page does not show the note.
     */
    fun sessions(listed: List<AgentSession>) {
        if (!showing()) return
        val seen = listed
            .filter { CommentLimits.SESSION_KEY.matches(it.key) && it.lastSeen >= 0 }
            .take(CommentLimits.MAX_SESSIONS)
            .map { SessionSeen(it.key, it.lastSeen) }
        send(BridgeProtocol.encode(CommentToEditor.Sessions(noteId, seen)))
    }

    /** A new page (reloaded): it lists the threads again as it opens the note, and holds no draft. */
    fun pageReloaded() {
        _draft.value = null
    }

    /**
     * A new thread: on the selection the selection menu kept ([DraftSource.SELECTION]), or at the
     * editor's own selection (the caret). The page answers with its quote, and the sheet opens.
     */
    fun startDraft(from: DraftSource) {
        if (!showing()) return notify(OPENING)
        send(BridgeProtocol.encode(CommentToEditor.Draft(noteId, from)))
    }

    fun cancelDraft() {
        _draft.value = null
    }

    /** Writes the draft's thread with its first comment; false (nothing sent) when there is no draft or text. */
    fun create(body: String, target: CommentTarget?): Boolean {
        val text = usable(body) ?: return false
        if (_draft.value == null) return false
        if (!showing()) {
            notify(OPENING)
            return false
        }
        send(BridgeProtocol.encode(CommentToEditor.Create(noteId, text, target)))
        _draft.value = null
        return true
    }

    fun reply(threadId: String, body: String): Boolean {
        val text = usable(body) ?: return false
        return sent(CommentToEditor.Reply(noteId, threadId, text))
    }

    fun edit(threadId: String, commentId: String, body: String): Boolean {
        val text = usable(body) ?: return false
        return sent(CommentToEditor.Edit(noteId, threadId, commentId, text))
    }

    /**
     * Removes one comment (an agent's: its undo, A779). A thread's first comment is only marked
     * removed, its replies kept (A784); [deleteThread] deletes a thread.
     */
    fun delete(threadId: String, commentId: String) = sent(CommentToEditor.Delete(noteId, threadId, commentId))

    fun deleteThread(threadId: String) = sent(CommentToEditor.DeleteThread(noteId, threadId))

    fun setStatus(threadId: String, status: ThreadStatus) = sent(CommentToEditor.Status(noteId, threadId, status))

    /** Send to… an agent session, or (null) stop sending. */
    fun setTarget(threadId: String, target: CommentTarget?) = sent(CommentToEditor.Target(noteId, threadId, target))

    /** The thread the sheet has open, highlighted in the note ([reveal]: scrolled to as well). */
    fun setActive(threadId: String?, reveal: Boolean = false) {
        if (_state.value.active == threadId && !reveal) return
        if (showing()) send(BridgeProtocol.encode(CommentToEditor.Active(noteId, threadId, reveal)))
    }

    private fun sent(message: CommentToEditor): Boolean {
        if (!showing()) {
            notify(OPENING)
            return false
        }
        send(BridgeProtocol.encode(message))
        return true
    }

    companion object {
        private const val OPENING = "Still opening the note. Try again in a moment."

        /** A comment's text as sent: trimmed, or null when empty or too long. */
        fun usable(body: String): String? = body.trim().takeIf(CommentLimits::usable)

        /** Whether Ryan may change a comment's text: his own, from any of his devices, and not removed. */
        fun canEdit(comment: CommentEntry): Boolean = !comment.author.agent && !comment.removed

        /**
         * Whether the comment at [index] has its own Delete or Remove, as on the web (A784): a reply
         * always; the first comment only while replies follow it (alone, it is the thread, which the
         * thread's Delete deletes), and not once removed.
         */
        fun canRemove(thread: CommentThread, index: Int): Boolean {
            val comment = thread.comments.getOrNull(index) ?: return false
            return !comment.removed && (index > 0 || thread.comments.size > 1)
        }

        /**
         * What the sheet says about a thread sent to an agent session (A1061, A1062, A1079), in
         * the Mac's words; null when it is sent to none.
         */
        fun deliveryText(thread: CommentThread): String? {
            val label = thread.target?.label ?: return null
            return deliveryText(label, thread.delivery)
        }

        fun deliveryText(label: String, delivery: CommentDelivery?): String = when (delivery?.state) {
            null -> "Sending to $label…"
            DeliveryState.WAITING -> "Waiting for $label"
            DeliveryState.SENT -> "Sent to $label"
            DeliveryState.SEEN -> "Seen"
            DeliveryState.REPLIED -> "Replied"
            DeliveryState.FAILED -> when (delivery.reason) {
                DeliveryFailure.GONE -> "Not sent: the session is gone"
                // The server's reasons (A785), still read.
                DeliveryFailure.SCOPE -> "Not sent: $label can’t see this note"
                DeliveryFailure.REVOKED -> "Not sent: $label’s token was revoked"
                null -> "Not sent to $label"
            }
        }

        /** A delivery that will not go (the session is gone, A1062): the thread offers Send to again. */
        fun sendAgain(thread: CommentThread): Boolean =
            thread.target != null && thread.delivery?.state == DeliveryState.FAILED

        /** A comment's writer as the sheet names them: agents marked, as Agent activity marks them. */
        fun authorLabel(author: app.penmoss.engine.bridge.CommentAuthor): String =
            if (author.agent) "✦ ${author.label}" else author.label
    }
}
