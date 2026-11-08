package app.penmoss.feedback

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.penmoss.AppGraph
import app.penmoss.ui.settings.BackButton
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/** The feedback screens' routes (T49). */
object FeedbackRoutes {
    const val FORM = "feedback"
    const val ABOUT = "settings/about"

    /** Settings → About → GitHub Token (A1012). */
    const val GITHUB_TOKEN = "settings/about/github-token"

    /** What About's GitHub Token row says. */
    fun tokenSummary(saved: Boolean, login: String?): String = when {
        !saved -> "Not set: Send Feedback needs it to file the issue"
        login != null -> "Saved, for @$login"
        else -> "Saved"
    }
}

/** The Send feedback form over the screen it was opened from, captured as it opened (A801). */
@Composable
fun FeedbackRoute(graph: AppGraph, onClose: () -> Unit) {
    val service = graph.feedback
    val opening by service.opening.collectAsStateWithLifecycle()
    // Opened again by the system after the app was closed on it: the context as it is now.
    LaunchedEffect(Unit) { service.reopen(WhereFacts("/feedback", "feedback", null, "the form, reopened", null)) }
    val model = viewModel { FeedbackFormModel(service, graph.scope) }
    val draft by model.draft.collectAsStateWithLifecycle()
    val phase by model.phase.collectAsStateWithLifecycle()
    val showProblems by model.showProblems.collectAsStateWithLifecycle()
    val notice by model.notice.collectAsStateWithLifecycle()
    val captureFile by model.captureFile.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val close = {
        service.closed()
        onClose()
    }
    BackHandler { close() }
    LaunchedEffect(phase) { if (phase == FeedbackFormModel.Phase.Sent) close() }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(FeedbackLimits.SCREENSHOTS)) { uris ->
        scope.launch { for (uri in uris) model.addImage(context.contentResolver.getType(uri), sizeOf(context, uri)) { context.contentResolver.openInputStream(uri) } }
    }
    val current = opening
    FeedbackScreen(
        FeedbackUi(
            draft = draft,
            context = current?.context ?: FeedbackContextData(),
            phase = phase,
            showProblems = showProblems,
            notice = notice,
            capture = current?.capture,
            capturing = current?.capturing == true,
            captureFile = captureFile,
        ),
        FeedbackActions(
            close = close,
            send = { model.send(current?.context ?: FeedbackContextData()) },
            type = model::setType,
            priority = model::setPriority,
            title = model::setTitle,
            description = model::setDescription,
            pickImages = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            capture = { ticked -> scope.launch { model.setCapture(current?.capture, ticked) } },
            remove = model::remove,
            move = model::move,
            omit = model::setOmitted,
            discard = {
                model.discard()
                close()
            },
            dismissNotice = model::clearNotice,
            image = model::image,
        ),
    )
}

private fun sizeOf(context: Context, uri: Uri): Long? = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
    }
}.getOrNull()

/**
 * Settings → About (T49): the app's version and build, Send feedback, its GitHub token and the
 * feedback still on the phone ([outbox], A1046).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(
    version: String,
    onSendFeedback: () -> Unit,
    onBack: () -> Unit,
    /** What the GitHub Token row says (A1012), and where it goes; no row without it. */
    githubToken: String? = null,
    onGitHubToken: () -> Unit = {},
    /** The feedback outbox ([FeedbackOutboxRoute]): nothing while it is empty. */
    outbox: @Composable () -> Unit = {},
) {
    Scaffold(topBar = { TopAppBar(title = { Text("About") }, navigationIcon = { BackButton(onBack) }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
            ListItem(headlineContent = { Text("Penmoss for Android") }, supportingContent = { Text("Version $version", Modifier.testTag("aboutVersion")) })
            ListItem(
                headlineContent = { Text("Send Feedback") },
                supportingContent = {
                    Text("A bug report or a feature request, filed on the Penmoss board with where you are in the app and the note’s details, never its text.")
                },
                modifier = Modifier.clickable(role = Role.Button, onClick = onSendFeedback).testTag("aboutSendFeedback"),
            )
            if (githubToken != null) {
                ListItem(
                    headlineContent = { Text("GitHub Token") },
                    supportingContent = { Text(githubToken) },
                    modifier = Modifier.clickable(role = Role.Button, onClick = onGitHubToken).testTag("aboutGitHubToken"),
                )
            }
            outbox()
        }
    }
}

/** How a waiting or refused submission is described in Settings → About. */
internal fun outboxLine(row: FeedbackOutboxEntity, dateOf: (Long) -> String): String = when (row.state) {
    // The web's words (T39 pass 3, A892).
    FeedbackOutboxEntity.FAILED -> "Not sent: ${row.lastError.orEmpty().trimEnd('.').ifEmpty { "refused" }}${row.lastStatus?.let { " ($it)" }.orEmpty()}."
    // Waiting for a GitHub token (A1012): where to add it, not the network.
    else -> if (row.lastError == FeedbackOutbox.NO_TOKEN) "Queued ${dateOf(row.createdAt)}. ${FeedbackOutbox.NO_TOKEN}" else listOfNotNull(
        "Queued ${dateOf(row.createdAt)}, will send when you’re online",
        row.lastError?.let { "last try: ${it.trimEnd('.')}" },
    ).joinToString("; ") + "."
}

/**
 * Settings → About's feedback still on the phone (T49, A796; A1046): each with Retry and Discard, and
 * one refused with Edit too, which puts it back in the form (T49 review).
 */
@Composable
fun FeedbackOutboxList(
    rows: List<FeedbackOutboxEntity>,
    onRetry: (String) -> Unit,
    onDiscard: (String) -> Unit,
    dateOf: (Long) -> String,
    onEdit: (String) -> Unit = {},
    notice: String? = null,
) {
    if (rows.isEmpty()) return
    var discarding by rememberSaveable { mutableStateOf<String?>(null) }
    Text(
        "Feedback outbox",
        Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp).semantics { heading() },
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
    notice?.let {
        Text(
            it,
            Modifier.padding(horizontal = 16.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("feedbackOutboxNotice"),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )
    }
    for (row in rows) {
        Column(Modifier.fillMaxWidth().testTag("feedbackOutbox-${row.id}")) {
            ListItem(
                headlineContent = { Text(row.title.ifBlank { "Untitled feedback" }) },
                supportingContent = {
                    Text(
                        outboxLine(row, dateOf),
                        color = if (row.state == FeedbackOutboxEntity.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
            )
            Row(Modifier.padding(horizontal = 8.dp)) {
                // Retry once refused; Send now while it waits, as on the web.
                TextButton(onClick = { onRetry(row.id) }, modifier = Modifier.testTag("feedbackRetry")) {
                    Text(if (row.state == FeedbackOutboxEntity.FAILED) "Retry" else "Send Now")
                }
                if (row.state == FeedbackOutboxEntity.FAILED) {
                    TextButton(onClick = { onEdit(row.id) }, modifier = Modifier.testTag("feedbackEdit")) { Text("Edit") }
                }
                TextButton(onClick = { discarding = row.id }, modifier = Modifier.testTag("feedbackDiscardQueued")) { Text("Discard") }
            }
        }
    }
    discarding?.let { id ->
        AlertDialog(
            onDismissRequest = { discarding = null },
            title = { Text("Discard this feedback?") },
            text = { Text("It is deleted from this phone and never sent.") },
            confirmButton = {
                TextButton(onClick = {
                    discarding = null
                    onDiscard(id)
                }, modifier = Modifier.testTag("confirmDiscardQueued")) { Text("Discard", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { discarding = null }) { Text("Keep It") } },
        )
    }
}

/** [FeedbackOutboxList] from the app's outbox; Edit [openForm]s the report taken back. */
@Composable
fun FeedbackOutboxRoute(graph: AppGraph, openForm: () -> Unit = {}) {
    val rows by remember { graph.feedbackOutbox.observe() }.collectAsStateWithLifecycle(emptyList())
    val format = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    FeedbackOutboxList(
        rows,
        onRetry = { id -> graph.scope.launch { graph.feedbackOutbox.retry(id) } },
        onDiscard = { id -> graph.scope.launch { graph.feedbackOutbox.discard(id) } },
        dateOf = { format.format(Date(it)) },
        onEdit = { id ->
            notice = null
            graph.scope.launch {
                if (graph.feedback.edit(id, openForm) == FeedbackService.Edit.DRAFT_IN_THE_WAY) notice = DRAFT_IN_THE_WAY
            }
        },
        notice = notice,
    )
}

/** Why Edit did nothing: the form already holds another report. */
const val DRAFT_IN_THE_WAY = "You're writing another report. Send or discard it first, then edit this one."
