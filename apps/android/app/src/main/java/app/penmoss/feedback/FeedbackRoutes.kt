package app.penmoss.feedback

import app.penmoss.ui.settings.settingRow
import kotlinx.coroutines.Dispatchers
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
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
import app.penmoss.ui.common.TextButton
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
import app.penmoss.NotebookGraph
import app.penmoss.ui.settings.BackButton
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/** The feedback screens' routes (T49; PEN-146). */
object FeedbackRoutes {
    const val FORM = "feedback"

    /** Settings → About, which Settings → GitHub replaced (PEN-146): opens GitHub. */
    const val ABOUT = "settings/about"

    /** Settings → GitHub → Use a Token Instead… (A1012). */
    const val GITHUB_TOKEN = "settings/github/token"

    /** What Settings' GitHub row says (PEN-146): the accounts (A1616), or that there are none. */
    fun tokenSummary(logins: List<String?>): String = when {
        logins.isEmpty() -> "Not signed in"
        else -> logins.joinToString(", ") { it ?: "Signed in" }
    }
}

/** The Send feedback form over the screen it was opened from, captured as it opened (A801). */
@Composable
fun FeedbackRoute(graph: NotebookGraph, onClose: () -> Unit) {
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
 * Settings → GitHub (PEN-146; replaces About, A1012): the GitHub accounts this phone uses (several
 * since A1616: a work account beside a personal one), each with Sign Out and, beside the first,
 * Use for Send Feedback; Add Account (GitHub's device flow, [signIn], its code shown before GitHub's
 * page opens) or Use a Token Instead…; what the accounts are used for, Send Feedback opening the
 * form; and the feedback still on the phone ([outbox], A1046). The version is on What's New alone.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitHubScreen(
    /** The accounts, the primary (Send Feedback's) first. */
    accounts: List<GitHubAccount>,
    signIn: SignInState,
    canSignIn: Boolean,
    onSignIn: () -> Unit,
    onCancelSignIn: () -> Unit,
    onSignOut: (login: String?) -> Unit,
    onToken: () -> Unit,
    onBack: () -> Unit,
    repo: String = "htxryan/penmoss",
    /** Send Feedback's form, where it can open (a notebook's screens); null on the app's home. */
    onSendFeedback: (() -> Unit)? = null,
    /** The feedback outbox ([FeedbackOutboxRoute]): nothing while it is empty. */
    outbox: @Composable () -> Unit = {},
    /** Makes an account the primary one: Send Feedback files with it. */
    onMakePrimary: (login: String?) -> Unit = {},
    /** Copies the waiting code and opens GitHub's page for it. */
    onOpenGitHub: (code: String, uri: String) -> Unit = { _, _ -> },
) {
    var signingOut by rememberSaveable { mutableStateOf<String?>(null) }
    val named = { login: String? -> login?.let { "@$it" } ?: "Token (Account Not Named)" }
    Scaffold(topBar = { TopAppBar(title = { Text("GitHub") }, navigationIcon = { BackButton(onBack) }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
            if (accounts.isEmpty()) {
                ListItem(
                    modifier = Modifier.settingRow("github"),
                    headlineContent = { Text("Not signed in", Modifier.testTag("githubLogin")) },
                    supportingContent = { Text("Sign in so Send Feedback can file issues in $repo, and to pick repositories when adding a notebook.") },
                )
            }
            for ((at, account) in accounts.withIndex()) {
                var menu by remember { mutableStateOf(false) }
                val key = account.login.orEmpty()
                ListItem(
                    modifier = (if (at == 0) Modifier.settingRow("github") else Modifier).testTag("githubAccount-$key"),
                    headlineContent = { Text(account.login ?: "Signed in", Modifier.testTag(if (account.primary) "githubLogin" else "githubLogin-$key")) },
                    supportingContent = {
                        Text(if (account.primary) "Send Feedback uses it · kept on this phone, encrypted by the Android Keystore" else "Kept on this phone, encrypted by the Android Keystore")
                    },
                    trailingContent = {
                        Box {
                            app.penmoss.ui.common.TipIconButton(
                                androidx.compose.material.icons.Icons.Default.MoreVert,
                                "Options for ${named(account.login)}",
                                onClick = { menu = true },
                                modifier = Modifier.testTag("githubAccountMenu-$key"),
                            )
                            androidx.compose.material3.DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                if (!account.primary) {
                                    androidx.compose.material3.DropdownMenuItem(
                                        text = { Text("Use for Send Feedback") },
                                        onClick = { menu = false; onMakePrimary(account.login) },
                                        modifier = Modifier.testTag("githubMakePrimary"),
                                    )
                                }
                                androidx.compose.material3.DropdownMenuItem(
                                    text = { Text("Sign Out") },
                                    onClick = { menu = false; signingOut = key },
                                    modifier = Modifier.testTag("githubSignOut"),
                                )
                            }
                        }
                    },
                )
            }
            when (signIn) {
                is SignInState.Waiting -> Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("githubSignInWaiting")) {
                    Text("Enter this code on GitHub:", style = MaterialTheme.typography.bodyMedium)
                    Text(signIn.userCode, Modifier.testTag("githubUserCode"), style = MaterialTheme.typography.headlineSmall)
                    Text(
                        "at ${signIn.verificationUri}. Penmoss waits here until you approve it." +
                            if (accounts.isNotEmpty()) " To add another account, check the one GitHub’s page shows at the top right, and switch there if it isn’t it." else "",
                        Modifier.testTag("githubSignInHint"),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        // The code first, then GitHub's page (Ryan's Android feedback, 15 Nov 2026).
                        app.penmoss.ui.common.Button(onClick = { onOpenGitHub(signIn.userCode, signIn.verificationUri) }, Modifier.testTag("githubSignInOpen")) { Labelled("external-link", "Copy Code and Open GitHub") }
                        TextButton(onClick = onCancelSignIn, Modifier.testTag("githubSignInCancel")) { Labelled("x", "Cancel") }
                    }
                }
                else -> {
                    signInWords(signIn)?.let {
                        Text(
                            it,
                            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("githubSignInMessage"),
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (signIn is SignInState.Failed || signIn is SignInState.Denied) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                    Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (canSignIn) {
                            app.penmoss.ui.common.Button(onClick = onSignIn, Modifier.testTag("githubSignIn")) {
                                if (accounts.isEmpty()) Labelled("log-in", "Sign In with GitHub") else Labelled("user-plus", "Add Account")
                            }
                        }
                        app.penmoss.ui.common.OutlinedButton(onClick = onToken, Modifier.settingRow("github-token").testTag("githubUseToken")) { Labelled("key-round", if (accounts.isEmpty()) "Use a Token Instead…" else "Add with a Token…") }
                    }
                    if (accounts.isNotEmpty()) {
                        Text(
                            "Add Account signs in to another GitHub account, such as a work one, beside these. Signing in as one already here renews it.",
                            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("githubAddHelp"),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Text(
                "Used For",
                Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp).semantics { heading() },
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
            )
            ListItem(
                headlineContent = { Text("Add Notebook") },
                supportingContent = { Text("Lists each account’s repositories. A notebook keeps a copy of the token of the account it was added with, so it syncs as that account.") },
            )
            ListItem(
                headlineContent = { Text("Send Feedback") },
                supportingContent = {
                    Text(
                        "Opens issues in $repo with the first account: a bug report or a feature request, with where you are in the app and the note’s details, never its text." +
                            if (onSendFeedback == null) " Send it from a notebook’s ⋮ menu." else "",
                    )
                },
                trailingContent = if (onSendFeedback != null) ({ Text("›", style = MaterialTheme.typography.titleMedium) }) else null,
                modifier = (if (onSendFeedback != null) Modifier.clickable(role = Role.Button, onClick = onSendFeedback) else Modifier).settingRow("send-feedback").testTag("githubSendFeedback"),
            )
            Text(
                "A notebook’s own repository uses the token typed on its Git tab, or the account it was added with.",
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            outbox()
        }
    }
    signingOut?.let { key ->
        val account = accounts.firstOrNull { it.login.orEmpty() == key }
        AlertDialog(
            onDismissRequest = { signingOut = null },
            title = { Text("Sign Out of ${named(account?.login)}?") },
            text = {
                Text(
                    "This phone forgets the account; notebooks added with it keep their own copy and keep syncing." +
                        if (account?.primary == true) {
                            if (accounts.size > 1) " Send Feedback moves to ${named(accounts[1].login)}." else " Feedback waits on the phone until you sign in again."
                        } else "",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    signingOut = null
                    onSignOut(account?.login)
                }, Modifier.testTag("githubSignOutConfirm")) { Text("Sign Out") }
            },
            dismissButton = { TextButton(onClick = { signingOut = null }) { Text("Cancel") } },
        )
    }
}

/**
 * Settings → GitHub's accounts, wired to the phone (A1616): Settings' own screen, and the same page
 * opened from Add Notebook's Use a Different GitHub Account. GitHub's code shows before its page
 * opens; Copy Code and Open GitHub copies it and opens the page.
 */
@Composable
fun GitHubAccountsRoute(
    device: app.penmoss.DeviceGraph,
    onToken: () -> Unit,
    onBack: () -> Unit,
    onSendFeedback: (() -> Unit)? = null,
    outbox: @Composable () -> Unit = {},
) {
    val context = LocalContext.current
    val store = device.githubToken
    val signIn by device.githubSignIn.state.collectAsStateWithLifecycle()
    var accounts by remember { mutableStateOf(store.accounts()) }
    // Read again as a sign-in ends, and back from the token's screen.
    LaunchedEffect(signIn) { accounts = store.accounts() }
    val scope = rememberCoroutineScope()
    GitHubScreen(
        accounts = accounts,
        signIn = signIn,
        canSignIn = device.githubSignIn.available,
        onSignIn = { device.githubSignIn.start(device.scope) },
        onOpenGitHub = { code, uri ->
            context.getSystemService(android.content.ClipboardManager::class.java)
                ?.setPrimaryClip(android.content.ClipData.newPlainText("GitHub code", code))
            runCatching {
                context.startActivity(
                    android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        },
        onCancelSignIn = device.githubSignIn::cancel,
        onSignOut = { login ->
            store.remove(login)
            device.githubSignIn.reset()
            accounts = store.accounts()
        },
        onMakePrimary = { login ->
            store.makePrimary(login)
            accounts = store.accounts()
        },
        onToken = onToken,
        onBack = {
            scope.launch { device.githubSignIn.reset() }
            onBack()
        },
        repo = device.githubFeedback.repo,
        onSendFeedback = onSendFeedback,
        outbox = outbox,
    )
}

/** A button's icon and words on one line (every button has an icon, and never wraps). */
@Composable
internal fun Labelled(icon: String, words: String) {
    app.penmoss.git.firstrun.ButtonIcon(icon)
    Text(words, maxLines = 1, softWrap = false, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
}

/** What the screen says of a sign-in that has ended, in plain words; null with nothing to say. */
internal fun signInWords(state: SignInState): String? = when (state) {
    SignInState.Idle, is SignInState.Waiting -> null
    is SignInState.SignedIn -> state.message
    SignInState.Denied -> "GitHub says the sign-in was declined. Nothing was kept."
    SignInState.Expired -> "The code ran out before it was entered. Sign in again for a new one."
    SignInState.Cancelled -> "Stopped. Nothing was kept."
    is SignInState.Failed -> state.message
}

/** How a waiting or refused submission is described in Settings → GitHub. */
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
 * Settings → GitHub's feedback still on the phone (T49, A796; A1046): each with Retry and Discard, and
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
        "Feedback Outbox",
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
fun FeedbackOutboxRoute(graph: NotebookGraph, openForm: () -> Unit = {}) {
    val rows by remember { graph.feedbackOutbox.observe() }.collectAsStateWithLifecycle(emptyList())
    val format = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    FeedbackOutboxList(
        rows,
        // Each outlives the screen: a feedback send the person asked for, or its discard.
        onRetry = { id -> graph.launchReporting(Dispatchers.Main.immediate) { graph.feedbackOutbox.retry(id) } },
        onDiscard = { id -> graph.launchReporting(Dispatchers.Main.immediate) { graph.feedbackOutbox.discard(id) } },
        dateOf = { format.format(Date(it)) },
        onEdit = { id ->
            notice = null
            // Outlives the screen: the report moves from the outbox back into the form's draft.
            graph.launchReporting(Dispatchers.Main.immediate) {
                if (graph.feedback.edit(id, openForm) == FeedbackService.Edit.DRAFT_IN_THE_WAY) notice = DRAFT_IN_THE_WAY
            }
        },
        notice = notice,
    )
}

/** Why Edit did nothing: the form already holds another report. */
const val DRAFT_IN_THE_WAY = "You're writing another report. Send or discard it first, then edit this one."
