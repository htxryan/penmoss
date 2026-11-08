package app.penmoss.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import app.penmoss.ui.square.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import app.penmoss.editor.CommentDraft
import app.penmoss.editor.CommentsState
import app.penmoss.editor.NoteComments
import app.penmoss.engine.api.AgentSession
import app.penmoss.engine.api.AgentSessionList
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossCommentsApi
import app.penmoss.engine.bridge.CommentEntry
import app.penmoss.engine.bridge.CommentLimits
import app.penmoss.engine.bridge.CommentTarget
import app.penmoss.engine.bridge.CommentThread
import app.penmoss.engine.bridge.DeliveryState
import app.penmoss.engine.bridge.ThreadStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

/*
 * The Comments sheet (T48, D40, A770–A784): the note's threads in document order, orphans last,
 * with the web panel's Open and Resolved filter; each thread's quote, its comments with their
 * writers (agents marked ✦), where its delivery to an agent session stands, a reply field,
 * Resolve or Reopen, Send to…, and Delete, which asks first. Send to… lists the Claude Code
 * sessions the notebook's WorkspaceDoc holds (T60, D50, A1065, A1079), as the Mac's does. Ryan
 * edits his own comments and removes any (an agent's removed is its undo, A779); a thread's first
 * comment removed leaves the thread and its replies, saying "Comment removed" (A784). Reached
 * from the note's ⋮ menu, a tapped highlight, or the selection menu's Comment, which opens it
 * with a new thread's composer.
 */

/** What Send to… shows: the sessions the notebook lists (A1060, A1076). */
data class SendToUi(
    /** Null until read. */
    val sessions: AgentSessionList? = null,
    val loading: Boolean = false,
    /** The list could not be read. */
    val problem: String? = null,
)

/** The target Send to… writes for a session (A1060): its writer, its key, its label. */
internal fun targetOf(session: AgentSession): CommentTarget =
    CommentTarget(session.writer, session.key, sessionLabel(session))

internal fun sessionLabel(session: AgentSession): String =
    session.label.ifBlank { session.name.ifBlank { session.key } }.take(CommentLimits.MAX_TARGET_LABEL)

/** A session's row, in the Mac's words: its label, and when it was last seen if not running. */
internal fun sessionRow(session: AgentSession, now: Long): String =
    if (session.active) sessionLabel(session) else "${sessionLabel(session)} (last seen ${shortWhen(session.lastSeen, now)})"

/**
 * What Send to… says with no session to offer: how to start one, in the Mac's words. `--notebook`
 * takes the name the notebook was added under on the agent's machine, which the phone cannot know.
 */
internal const val NO_SESSIONS_HINT = "No agent sessions yet: start one with penmoss mcp --notebook … --channel."

/**
 * Send to…'s list, read from the notebook's notes server (A1076). [onListed] has every list read:
 * the sheet hands the sessions to the page for the gone check (A1077).
 */
class SendToModel(
    private val api: PenmossCommentsApi,
    private val scope: CoroutineScope,
    private val onListed: (AgentSessionList) -> Unit = {},
) {
    private val _ui = MutableStateFlow(SendToUi())
    val ui: StateFlow<SendToUi> = _ui.asStateFlow()

    fun load() {
        _ui.update { it.copy(loading = true, problem = null) }
        scope.launch {
            val problem = try {
                val listed = api.agentSessions()
                _ui.update { it.copy(sessions = listed) }
                onListed(listed)
                null
            } catch (error: CancellationException) {
                throw error
            } catch (error: ApiException) {
                "Penmoss couldn’t list the agent sessions: ${error.message?.trimEnd('.')}."
            } catch (error: IOException) {
                "Penmoss couldn’t read the notebook’s agent sessions yet. Try again in a moment."
            }
            _ui.update { it.copy(loading = false, problem = problem) }
        }
    }
}

/** The Comments sheet over the note. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CommentsSheet(
    state: CommentsState,
    draft: CommentDraft?,
    /** The note can take comments now (loaded, and not read-only). */
    editable: Boolean,
    sendTo: SendToUi,
    onLoadSendTo: () -> Unit,
    onNewComment: () -> Unit,
    onCancelDraft: () -> Unit,
    onCreate: (body: String, target: CommentTarget?) -> Boolean,
    onSelect: (threadId: String) -> Unit,
    onReply: (threadId: String, body: String) -> Boolean,
    onEdit: (threadId: String, commentId: String, body: String) -> Boolean,
    onDelete: (threadId: String, commentId: String) -> Unit,
    onDeleteThread: (threadId: String) -> Unit,
    onStatus: (threadId: String, status: ThreadStatus) -> Unit,
    onTarget: (threadId: String, target: CommentTarget?) -> Unit,
    onDismiss: () -> Unit,
    now: Long = System.currentTimeMillis(),
    /** The filter first shown: Resolved when the thread asked for is resolved. */
    initialFilter: ThreadStatus = ThreadStatus.OPEN,
    /** The note panel's Comments tab (T51, A936), not a sheet of its own. */
    embedded: Boolean = false,
    /** Add Note Comment (T52 item 5): a thread on the note as a whole, with no passage. */
    onNewNoteComment: () -> Unit = {},
) {
    // Full height at once: the sheet is for writing, with the keyboard up.
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var filter by rememberSaveable { mutableStateOf(initialFilter) }
    /** Send to… for the draft (`""`) or a thread (its id), or null when closed. */
    var picking by remember { mutableStateOf<String?>(null) }
    var draftTarget by remember { mutableStateOf<CommentTarget?>(null) }
    val pick = { forThread: String ->
        picking = forThread
        onLoadSendTo()
    }
    /** A thread to delete, waiting for the confirm. */
    var deleting by remember { mutableStateOf<String?>(null) }
    SheetOrPanel(embedded, onDismiss, sheet, "commentsSheet") {
        LazyColumn(
            Modifier.fillMaxWidth().navigationBarsPadding().testTag("commentsList"),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            item {
                Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Comments",
                        Modifier.weight(1f).padding(vertical = 8.dp).semantics { heading() },
                        style = MaterialTheme.typography.titleLarge,
                    )
                    if (draft == null) {
                        TextButton(onClick = onNewComment, enabled = editable, modifier = Modifier.testTag("commentNew")) {
                            Text("New Comment")
                        }
                    }
                }
            }
            // On the note as a whole (T52 item 5), as the web's Comments tab offers it.
            if (draft == null) {
                item {
                    TextButton(
                        onClick = onNewNoteComment,
                        enabled = editable,
                        modifier = Modifier.padding(start = 12.dp).testTag("commentNewNote"),
                    ) { Text("Add Note Comment") }
                }
            }
            if (draft != null) {
                item {
                    Composer(
                        draft = draft,
                        target = draftTarget,
                        onSendTo = { pick("") },
                        onCancel = {
                            draftTarget = null
                            onCancelDraft()
                        },
                        onCreate = { body ->
                            val sent = onCreate(body, draftTarget)
                            if (sent) {
                                draftTarget = null
                                filter = ThreadStatus.OPEN
                            }
                            sent
                        },
                    )
                }
            }
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = filter == ThreadStatus.OPEN,
                        onClick = { filter = ThreadStatus.OPEN },
                        label = { Text("Open ${state.open}") },
                        modifier = Modifier.testTag("commentsOpen"),
                    )
                    FilterChip(
                        selected = filter == ThreadStatus.RESOLVED,
                        onClick = { filter = ThreadStatus.RESOLVED },
                        label = { Text("Resolved ${state.resolved}") },
                        modifier = Modifier.testTag("commentsResolved"),
                    )
                }
            }
            val shown = state.shown(filter)
            if (shown.isEmpty()) {
                item {
                    Text(
                        when {
                            !state.known -> "Opening the note…"
                            filter == ThreadStatus.OPEN -> "No open comments. Select text in the note, then Comment, or use New Comment or Add Note Comment."
                            else -> "No resolved comments."
                        },
                        Modifier.padding(horizontal = 24.dp, vertical = 12.dp).testTag("commentsEmpty"),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(shown, key = { it.id }) { thread ->
                ThreadCard(
                    thread = thread,
                    active = thread.id == state.active,
                    editable = editable,
                    now = now,
                    onSelect = { onSelect(thread.id) },
                    onReply = { onReply(thread.id, it) },
                    onEdit = { commentId, body -> onEdit(thread.id, commentId, body) },
                    onDelete = { onDelete(thread.id, it) },
                    onDeleteThread = { deleting = thread.id },
                    onStatus = { onStatus(thread.id, it) },
                    onSendTo = { pick(thread.id) },
                )
            }
            item { Spacer(Modifier.height(16.dp)) }
        }
    }
    picking?.let { forThread ->
        val current = if (forThread.isEmpty()) draftTarget else state.threads.firstOrNull { it.id == forThread }?.target
        SendToDialog(
            ui = sendTo,
            current = current,
            // A new thread's first option always says Nobody; only a thread already sent stops.
            sent = forThread.isNotEmpty() && current != null,
            now = now,
            onRetry = onLoadSendTo,
            onPick = { target ->
                picking = null
                if (forThread.isEmpty()) draftTarget = target else onTarget(forThread, target)
            },
            onDismiss = { picking = null },
        )
    }
    deleting?.let { threadId ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete this thread?") },
            text = { Text("Its comments are deleted on every device. To keep them, resolve it instead.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    onDeleteThread(threadId)
                }, modifier = Modifier.testTag("commentDeleteConfirm")) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

/** What a thread on the note as a whole shows for its quote, in the web's words. */
internal const val NOTE_AS_A_WHOLE = "The note as a whole"

/** A thread's quote, marked at its left as the web's panel shows it; a [note] thread has none (T52 item 5). */
@Composable
private fun Quote(text: String, orphaned: Boolean, range: Boolean, note: Boolean = false) {
    Column(Modifier.fillMaxWidth()) {
        if (orphaned && !note) {
            Text(
                "Its text was deleted",
                Modifier.testTag("commentOrphaned"),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
        val shown = when {
            note -> NOTE_AS_A_WHOLE
            text.isNotBlank() -> text
            range -> "(no text)"
            else -> "At the start of the note"
        }
        Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
            Text(
                if (!range && !note && text.isNotBlank()) "At: $shown" else shown,
                Modifier.padding(start = 8.dp),
                style = MaterialTheme.typography.bodyMedium,
                fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 4,
            )
        }
    }
}

/** The new thread's composer: its quote, the comment, and where it is sent. */
@Composable
private fun Composer(
    draft: CommentDraft,
    target: CommentTarget?,
    onSendTo: () -> Unit,
    onCancel: () -> Unit,
    onCreate: (String) -> Boolean,
) {
    var body by rememberSaveable(draft) { mutableStateOf("") }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp).testTag("commentComposer"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Quote(draft.quote, orphaned = false, range = draft.range, note = draft.note)
        OutlinedTextField(
            value = body,
            onValueChange = { body = it },
            label = { Text("Comment") },
            modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).testTag("commentBody"),
        )
        // Send to has its own line: a session's name can be long, and on a phone it squeezed
        // Comment into a narrow column with no label (A1096).
        TextButton(onClick = onSendTo, modifier = Modifier.testTag("commentDraftSendTo")) {
            Text(
                target?.let { "Send to ${it.label}" } ?: "Send to…",
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCancel, modifier = Modifier.testTag("commentCancel")) { Text("Cancel") }
            Button(
                onClick = { if (onCreate(body)) body = "" },
                enabled = NoteComments.usable(body) != null,
                modifier = Modifier.testTag("commentCreate"),
            ) { Text("Comment") }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ThreadCard(
    thread: CommentThread,
    active: Boolean,
    editable: Boolean,
    now: Long,
    onSelect: () -> Unit,
    onReply: (String) -> Boolean,
    onEdit: (commentId: String, body: String) -> Boolean,
    onDelete: (commentId: String) -> Unit,
    onDeleteThread: () -> Unit,
    onStatus: (ThreadStatus) -> Unit,
    onSendTo: () -> Unit,
) {
    var editing by remember(thread.id) { mutableStateOf<String?>(null) }
    var reply by rememberSaveable(thread.id) { mutableStateOf("") }
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .background(if (active) colors.secondaryContainer else colors.surfaceContainerLow, MaterialTheme.shapes.medium)
            .padding(12.dp)
            .testTag("commentThread-${thread.id}"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // A tap on its quote opens the thread: highlighted in the note, and scrolled to.
        Column(
            Modifier
                .fillMaxWidth()
                .selectable(selected = active, onClick = onSelect, role = Role.Button)
                .testTag("commentQuote-${thread.id}"),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Quote(thread.quote, thread.orphaned, thread.range, thread.note)
            NoteComments.deliveryText(thread)?.let {
                // Not sent: in the error colour.
                val failed = thread.delivery?.state == DeliveryState.FAILED
                Text(
                    it,
                    Modifier.testTag("commentDelivery-${thread.id}"),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (failed) colors.error else colors.primary,
                )
            }
        }
        // Not sent (the session is gone, A1062): pick another, as the Mac offers.
        if (editable && NoteComments.sendAgain(thread)) {
            TextButton(onClick = onSendTo, modifier = Modifier.testTag("commentSendAgain-${thread.id}")) { Text("Send to again") }
        }
        thread.comments.forEachIndexed { index, comment ->
            if (index > 0) HorizontalDivider()
            CommentItem(
                comment = comment,
                editing = editing == comment.id,
                actions = active && editable,
                // Alone, the first comment is the thread: the thread's Delete (A784).
                canDelete = NoteComments.canRemove(thread, index),
                now = now,
                onStartEdit = { editing = comment.id },
                onEdit = { body ->
                    val done = onEdit(comment.id, body)
                    if (done) editing = null
                    done
                },
                onCancelEdit = { editing = null },
                onDelete = { onDelete(comment.id) },
            )
        }
        if (thread.status == ThreadStatus.RESOLVED) {
            Text(
                "Resolved${thread.resolvedBy?.let { " by ${NoteComments.authorLabel(it)}" }.orEmpty()}${thread.resolvedAt?.let { " · ${shortWhen(it, now)}" }.orEmpty()}",
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant,
            )
        }
        if (active && editable) {
            if (thread.status == ThreadStatus.OPEN) {
                OutlinedTextField(
                    value = reply,
                    onValueChange = { reply = it },
                    label = { Text("Reply") },
                    modifier = Modifier.fillMaxWidth().testTag("commentReply-${thread.id}"),
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (thread.status == ThreadStatus.OPEN) {
                    TextButton(
                        onClick = { if (onReply(reply)) reply = "" },
                        enabled = NoteComments.usable(reply) != null,
                        modifier = Modifier.testTag("commentSendReply-${thread.id}"),
                    ) { Text("Reply") }
                    TextButton(onClick = { onStatus(ThreadStatus.RESOLVED) }, modifier = Modifier.testTag("commentResolve-${thread.id}")) { Text("Resolve") }
                } else {
                    TextButton(onClick = { onStatus(ThreadStatus.OPEN) }, modifier = Modifier.testTag("commentReopen-${thread.id}")) { Text("Reopen") }
                }
                TextButton(onClick = onSendTo, modifier = Modifier.testTag("commentSendTo-${thread.id}")) { Text("Send to…") }
                // The web's name for it (T39 pass 3, A909).
                TextButton(onClick = onDeleteThread, modifier = Modifier.testTag("commentDeleteThread-${thread.id}")) { Text("Delete Thread") }
            }
        }
    }
}

@Composable
private fun CommentItem(
    comment: CommentEntry,
    editing: Boolean,
    actions: Boolean,
    canDelete: Boolean,
    now: Long,
    onStartEdit: () -> Unit,
    onEdit: (String) -> Boolean,
    onCancelEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().testTag("comment-${comment.id}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                NoteComments.authorLabel(comment.author),
                Modifier.semantics { if (comment.author.agent) contentDescription = "Agent ${comment.author.label}" },
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Medium,
            )
            Text(
                " · ${shortWhen(comment.at, now)}${if (comment.edited != null) " · edited" else ""}",
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant,
            )
        }
        if (editing) {
            // The caret at the end of the text, to add to it.
            var body by rememberSaveable(comment.id, stateSaver = TextFieldValue.Saver) {
                mutableStateOf(TextFieldValue(comment.body, TextRange(comment.body.length)))
            }
            OutlinedTextField(
                value = body,
                onValueChange = { body = it },
                modifier = Modifier.fillMaxWidth().testTag("commentEditBody-${comment.id}"),
            )
            Row {
                TextButton(onClick = onCancelEdit) { Text("Cancel") }
                TextButton(
                    onClick = { onEdit(body.text) },
                    enabled = NoteComments.usable(body.text) != null,
                    modifier = Modifier.testTag("commentSave-${comment.id}"),
                ) { Text("Save") }
            }
        } else if (comment.removed) {
            // A thread's first comment removed (A784): no text, and nothing to do with it.
            Text(
                "Comment removed",
                Modifier.testTag("commentRemoved-${comment.id}"),
                style = MaterialTheme.typography.bodyMedium,
                fontStyle = FontStyle.Italic,
                color = colors.onSurfaceVariant,
            )
        } else {
            Text(comment.body, style = MaterialTheme.typography.bodyMedium)
            if (actions) {
                Row {
                    if (NoteComments.canEdit(comment)) {
                        TextButton(onClick = onStartEdit, modifier = Modifier.testTag("commentEdit-${comment.id}")) { Text("Edit") }
                    }
                    if (canDelete) {
                        // An agent's comment removed is its undo (A779).
                        TextButton(onClick = onDelete, modifier = Modifier.testTag("commentDelete-${comment.id}")) {
                            Text(if (comment.author.agent) "Remove" else "Delete")
                        }
                    }
                }
            }
        }
    }
}

/**
 * Send to… (A1065, A1079), as the Mac's picker: Nobody (Stop sending once the thread is sent),
 * then the sessions seen this week, running ones first; one not running says when it was last
 * seen, greyed.
 */
@Composable
internal fun SendToDialog(
    ui: SendToUi,
    current: CommentTarget?,
    /** A thread already sent: its first option is Stop sending (a new thread's is always Nobody). */
    sent: Boolean,
    now: Long,
    onRetry: () -> Unit,
    onPick: (CommentTarget?) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Send to…") },
        text = {
            LazyColumn(Modifier.fillMaxWidth().testTag("sendToList")) {
                if (ui.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                ui.problem?.let { problem ->
                    item {
                        Column {
                            Text(problem, style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = onRetry) { Text("Try Again") }
                        }
                    }
                }
                item(key = "none") {
                    TargetRow(
                        if (sent) "Stop sending" else "Nobody",
                        selected = current == null,
                        dimmed = false,
                        tag = "sendToNone",
                    ) { onPick(null) }
                }
                val offered = ui.sessions?.offered
                if (offered != null && offered.isEmpty()) {
                    item {
                        Text(
                            NO_SESSIONS_HINT,
                            Modifier.padding(top = 8.dp).testTag("sendToEmpty"),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                items(offered.orEmpty(), key = { "session-${it.key}" }) { session ->
                    val selected = current?.writer == session.writer && current.session == session.key
                    TargetRow(sessionRow(session, now), selected, dimmed = !session.active, tag = "sendTo-${session.key}") {
                        onPick(targetOf(session))
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun TargetRow(title: String, selected: Boolean, dimmed: Boolean, tag: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = onClick).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(
            title,
            Modifier.padding(start = 8.dp),
            style = MaterialTheme.typography.bodyLarge,
            color = if (dimmed) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        )
    }
}

