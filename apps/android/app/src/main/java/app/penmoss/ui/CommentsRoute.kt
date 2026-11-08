package app.penmoss.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.editor.NoteComments
import app.penmoss.engine.bridge.DraftSource
import app.penmoss.engine.bridge.ThreadStatus

/**
 * The note's Comments sheet, wired to its page ([comments]) and to Send to…'s sessions, which the
 * notebook's WorkspaceDoc lists (T60, A1076). A change to the comments alone moves the note's sync
 * clock (A783), so the open note's own poll brings an agent's reply and its delivery state.
 */
@Composable
internal fun NoteCommentsSheet(
    graph: AppGraph,
    noteId: String,
    comments: NoteComments,
    editable: Boolean,
    onDismiss: () -> Unit,
    /** The note panel's Comments tab (T51, A936). */
    embedded: Boolean = false,
) {
    val state by comments.state.collectAsStateWithLifecycle()
    val draft by comments.draft.collectAsStateWithLifecycle()
    val sendTo = remember(noteId) {
        // Once a sync has landed, the list says which sessions are gone (A1062, A1077).
        SendToModel(graph.comments, graph.scope, onListed = { listed -> if (listed.synced) comments.sessions(listed.sessions) })
    }
    val sendToUi by sendTo.ui.collectAsStateWithLifecycle()
    // The note's comments are shown: read the sessions, which fails deliveries to one gone.
    LaunchedEffect(noteId) { sendTo.load() }
    // Opened on a resolved thread (the sheet chose it), the filter starts on Resolved.
    val initialFilter = remember(noteId) {
        state.threads.firstOrNull { it.id == state.active }?.status ?: ThreadStatus.OPEN
    }
    CommentsSheet(
        state = state,
        draft = draft,
        editable = editable,
        sendTo = sendToUi,
        onLoadSendTo = sendTo::load,
        onNewComment = { comments.startDraft(DraftSource.CARET) },
        // A thread on the note as a whole, with no passage (T52 item 5).
        onNewNoteComment = { comments.startDraft(DraftSource.NOTE) },
        onCancelDraft = comments::cancelDraft,
        onCreate = comments::create,
        onSelect = { comments.setActive(it, reveal = true) },
        onReply = comments::reply,
        onEdit = comments::edit,
        onDelete = { thread, comment -> comments.delete(thread, comment) },
        onDeleteThread = { comments.deleteThread(it) },
        onStatus = { thread, status -> comments.setStatus(thread, status) },
        onTarget = { thread, target -> comments.setTarget(thread, target) },
        onDismiss = {
            comments.cancelDraft()
            comments.setActive(null)
            onDismiss()
        },
        initialFilter = initialFilter,
        embedded = embedded,
    )
}
