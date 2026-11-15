package app.penmoss.git

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.penmoss.ui.common.Button
import app.penmoss.ui.common.FilledTonalButton
import app.penmoss.ui.common.TextButton
import app.penmoss.ui.settings.GroupTitle
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen

/** A notebook page's tabs (PEN-146), as its route names them. */
object NotebookTab {
    const val OVERVIEW = "overview"
    const val SYNC = "sync"
    const val GIT = "git"

    val ALL = listOf(OVERVIEW to "Overview", SYNC to "Sync", GIT to "Git")
}

/** The Notes row's words (PEN-148): how many, or that they are not read yet. */
internal fun noteCountWords(count: Int?): String = when (count) {
    null -> "Not read yet"
    1 -> "1 note"
    else -> String.format(java.util.Locale.US, "%,d notes", count)
}

/** The repository as a line: `github.com/me/notes · branch · dir/`. */
internal fun repositoryLine(view: app.penmoss.engine.git.GitNotebookView): String =
    view.repository + (if (view.branch != "main") " · ${view.branch}" else "") + (if (view.dir.isNotEmpty()) " · ${view.dir}/" else "")

/**
 * A notebook's page in Settings (PEN-146; replaces its long card, A883): opened from its own row,
 * under its name, with three tabs. **Overview**: its sync and Sync Now, Open Notebook, whether it
 * is the primary notebook, what waits for the person (notes brought back, copies withheld, deletes
 * for good to confirm) and Remove from This Phone…. **Sync**: what the last sync said, Wi-Fi Only
 * and the cadence. **Git**: its token, Sign Commits and its own commit name and email. Agents are
 * not a tab: Agent Activity is its own screen, across notebooks.
 */
@Composable
fun NotebookPage(
    row: GitRow,
    ui: GitNotebooksUi,
    actions: GitNotebooksActions,
    tab: String,
    onBack: () -> Unit,
    /** The notebook's own Room sync line, when Settings opened over its screens. */
    passText: String? = null,
    /** How many notes it has on this phone; null before they are read (PEN-148). */
    notes: Int? = null,
) {
    val id = row.view.localId
    var shown by rememberSaveable(id) { mutableStateOf(tab) }
    var removing by remember { mutableStateOf(false) }
    var pushingFirst by remember { mutableStateOf(false) }
    SectionScreen(
        row.view.name,
        onBack,
        // Its badge before its name, as the Mac's page heading has it (A1579).
        titleLead = { app.penmoss.ui.common.NotebookBadgeView(row.badge, row.view.name, size = 26.dp, decorative = true) },
    ) {
        if (ui.message != null) {
            Text(
                ui.message,
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("gitMessage").semantics { liveRegion = LiveRegionMode.Polite },
                color = MaterialTheme.colorScheme.error,
            )
            TextButton(onClick = actions.onDismissMessage, Modifier.padding(horizontal = 8.dp)) { Text("OK") }
        }
        val index = NotebookTab.ALL.indexOfFirst { it.first == shown }.coerceAtLeast(0)
        PrimaryTabRow(selectedTabIndex = index, modifier = Modifier.testTag("notebookTabs")) {
            NotebookTab.ALL.forEachIndexed { at, (key, label) ->
                Tab(selected = at == index, onClick = { shown = key }, text = { Text(label) }, modifier = Modifier.testTag("notebookTab-$key"))
            }
        }
        when (NotebookTab.ALL[index].first) {
            NotebookTab.SYNC -> SyncTab(row, ui, actions, passText)
            NotebookTab.GIT -> GitTab(row, ui, actions)
            else -> {
                if (pushingFirst) {
                    Text(
                        "Pushing first. Remove once it says Synced.",
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("gitPushFirstSaid").semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
                OverviewTab(row, ui, actions, notes, onRemove = { removing = true })
            }
        }
    }
    if (removing) {
        RemoveDialog(
            row,
            actions,
            onDismiss = { removing = false },
            onPushFirst = {
                removing = false
                pushingFirst = true
                actions.onSyncNow(id)
            },
            onRemove = {
                removing = false
                pushingFirst = false
                actions.onRemove(id)
            },
        )
    }
}

/** The status, and Sync Now beside it. */
@Composable
private fun StatusRow(row: GitRow, ui: GitNotebooksUi, actions: GitNotebooksActions) {
    val view = row.view
    val busy = ui.busy == view.localId
    ListItem(
        headlineContent = {
            Text(
                gitStatusLine(row.status, view.host),
                Modifier.testTag("gitStatus-${view.localId}").semantics { liveRegion = LiveRegionMode.Polite },
                color = if (row.status?.phase == "stopped") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            )
        },
        supportingContent = { Text(repositoryLine(view)) },
        trailingContent = {
            FilledTonalButton(onClick = { actions.onSyncNow(view.localId) }, enabled = !busy, modifier = Modifier.testTag("gitSync-${view.localId}")) {
                Text(if (busy) "Syncing…" else "Sync Now")
            }
        },
    )
}

@Composable
private fun OverviewTab(row: GitRow, ui: GitNotebooksUi, actions: GitNotebooksActions, notes: Int?, onRemove: () -> Unit) {
    val view = row.view
    val id = view.localId
    var copying by rememberSaveable(id) { mutableStateOf(false) }
    StatusRow(row, ui, actions)
    Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        Button(onClick = { actions.onOpen(id) }, Modifier.testTag("gitOpen-$id")) { Text("Open Notebook") }
    }
    ListItem(
        headlineContent = { Text("Name") },
        supportingContent = { Text(view.name) },
    )
    // Its badge, right after its name, as the Mac's Overview has it (A1504, A1579).
    app.penmoss.ui.settings.BadgeSettings(row.badge, view.notebookId, view.name) { key, value -> actions.onBadge(id, key, value) }
    val primary = ui.journal == id
    // Its notes and Copy Settings…, as the Mac's Overview has them (PEN-148).
    ListItem(
        headlineContent = { Text("Notes") },
        supportingContent = { Text(noteCountWords(notes), Modifier.testTag("gitNoteCount-$id")) },
    )
    if (ui.rows.size > 1) {
        ListItem(
            headlineContent = { Text("Settings") },
            supportingContent = { Text("Copy from or to other notebooks") },
            trailingContent = { TextButton(onClick = { copying = true }, Modifier.testTag("gitCopySettingsOpen-$id")) { Text("Copy Settings…") } },
        )
    }
    if (copying && ui.rows.size > 1) {
        // The primary's page copies to the others; another's copies the primary's into it, as the Mac's.
        val journal = ui.journal ?: ui.rows.first().view.localId
        CopySettingsDialog(
            ui.rows,
            from = if (primary) id else journal,
            to = if (primary) null else id,
            onCopy = actions.onCopySettings,
        ) { copying = false }
    }
    ListItem(
        headlineContent = { Text("Primary Notebook") },
        supportingContent = { Text(if (primary) "Journal and captures go here" else "Journal and captures go to another notebook") },
        trailingContent = {
            if (primary) PrimaryChip() else TextButton(onClick = { actions.onJournal(id) }, Modifier.testTag("gitMakePrimary-$id")) { Text("Make Primary") }
        },
    )
    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        row.recovered?.let { notice -> RecoveryNotice(notice, onSave = { actions.onSaveUnrecovered(id) }) { actions.onDismissRecovery(id) } }
        WithheldNotice(
            row.withheld,
            onSave = { actions.onSaveWithheld(id) },
            onDelete = { actions.onDropWithheld(id, it) },
            onKeep = { actions.onKeepWithheld(id, it) },
        )
        row.oldCopies?.takeIf { it.waiting > 0 }?.let { copies ->
            // Held, never silently (A886): a page that never syncs leaves them waiting here.
            Help(
                "${copies.words().replaceFirstChar { it.uppercase() }}. Android cleared this notebook’s storage on the phone; once a sync reaches the repository, what git lacks of them comes back as notes of their own.",
                Modifier.padding(0.dp).testTag("gitWaiting-$id"),
            )
            TextButton(onClick = { actions.onSaveUnrecovered(id) }, Modifier.testTag("gitWaitingSave-$id")) { Text("Save Their Text") }
        }
        if (row.storageKept == false) {
            Help(
                "Android may clear this notebook’s storage on the phone when space runs low. Changes not pushed yet then come back as notes of their own.",
                Modifier.padding(0.dp).testTag("gitStorage-$id"),
            )
        }
        if (row.status?.code == "purge_unconfirmed" || row.purges != null) Purges(row, actions)
    }
    HorizontalDivider(Modifier.padding(top = 8.dp))
    TextButton(onClick = onRemove, Modifier.padding(horizontal = 8.dp).testTag("gitRemove-$id")) {
        Text("Remove from This Phone…", color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun SyncTab(row: GitRow, ui: GitNotebooksUi, actions: GitNotebooksActions, passText: String?) {
    val view = row.view
    val id = view.localId
    val status = row.status
    StatusRow(row, ui, actions)
    status?.hostMessage?.let { Help("${view.host} said: $it") }
    if (status?.handEdits?.isNotEmpty() == true) Help(handEditsText(status.handEdits))
    if (status?.skipped?.isNotEmpty() == true) {
        Help("Left as they are, unreadable here: ${status.skipped.keys.take(5).joinToString(", ")}${if (status.skipped.size > 5) "…" else ""}")
    }
    if (passText != null) Help("Notes on this phone: ${passText.ifEmpty { "not read yet" }}")
    ListItem(
        headlineContent = { Text("Wi-Fi Only") },
        supportingContent = { Text("In the background, sync this notebook only on Wi-Fi.") },
        trailingContent = { Switch(checked = view.wifiOnly, onCheckedChange = null) },
        modifier = Modifier.testTag("gitWifi-$id").toggleable(value = view.wifiOnly, role = Role.Switch) { actions.onWifiOnly(id, it) },
    )
    var push by rememberSaveable(id) { mutableStateOf(view.pushDelayS.toString()) }
    var pull by rememberSaveable(id) { mutableStateOf(view.pullEveryMin.toString()) }
    GroupTitle("How Often")
    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            push,
            { push = it.filter(Char::isDigit).take(4) },
            Modifier.weight(1f).testTag("gitPush-$id"),
            label = { Text("Push After (Seconds)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        OutlinedTextField(
            pull,
            { pull = it.filter(Char::isDigit).take(4) },
            Modifier.weight(1f).testTag("gitPull-$id"),
            label = { Text("Pull Every (Minutes)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
    }
    val pushS = push.toIntOrNull()
    val pullMin = pull.toIntOrNull()
    if (pushS != view.pushDelayS || pullMin != view.pullEveryMin) {
        TextButton(
            onClick = { if (pushS != null && pullMin != null) actions.onCadence(id, pushS, pullMin) },
            enabled = pushS != null && pullMin != null,
            modifier = Modifier.padding(horizontal = 8.dp).testTag("gitCadenceSave-$id"),
        ) { Text("Save the Cadence") }
    }
    Help(
        "Pulls when you open the notebook and every ${view.pullEveryMin} min while it is open, pushes ${view.pushDelayS} s after edits settle, " +
            "and syncs about every 15 minutes in the background.",
    )
}

@Composable
private fun GitTab(row: GitRow, ui: GitNotebooksUi, actions: GitNotebooksActions) {
    val view = row.view
    val id = view.localId
    var token by rememberSaveable(id) { mutableStateOf("") }
    GroupTitle("Token")
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OutlinedTextField(
            token,
            { token = it.trim() },
            Modifier.fillMaxWidth().testTag("gitToken-$id"),
            label = { Text(if (view.hasToken) "Personal Access Token (Saved; Type a New One to Replace It)" else "Personal Access Token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { actions.onToken(id, token); token = "" }, enabled = token.isNotEmpty(), modifier = Modifier.testTag("gitTokenSave-$id")) { Text("Save Token") }
            if (view.hasToken) TextButton(onClick = { actions.onToken(id, null) }, Modifier.testTag("gitTokenForget-$id")) { Text("Forget Token") }
        }
    }
    GroupTitle("Commits")
    ListItem(
        headlineContent = { Text("Sign Commits") },
        supportingContent = {
            Text("Sign every commit from this phone with its signing key (SSH), as a branch that requires signed commits needs. If it cannot sign, the sync stops: never an unsigned commit.")
        },
        trailingContent = { Switch(checked = view.signCommits, onCheckedChange = null) },
        modifier = Modifier.testTag("gitSign-$id").toggleable(value = view.signCommits, role = Role.Switch) { actions.onSignCommits(id, it) },
    )
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SigningKey(ui, actions)
        // This notebook's own commit identity (#170 F6): a GitHub no-reply address keeps an email
        // private, and GitHub refuses pushes that would show one it keeps private (GH007).
        var authorName by rememberSaveable(id, view.author) { mutableStateOf(view.author?.name.orEmpty()) }
        var authorEmail by rememberSaveable(id, view.author) { mutableStateOf(view.author?.email.orEmpty()) }
        OutlinedTextField(
            authorName,
            { authorName = it },
            Modifier.fillMaxWidth().testTag("gitAuthorName-$id"),
            label = { Text("Commit Name for This Notebook") },
            singleLine = true,
        )
        OutlinedTextField(
            authorEmail,
            { authorEmail = it.trim() },
            Modifier.fillMaxWidth().testTag("gitAuthorEmail-$id"),
            label = { Text("Commit Email for This Notebook") },
            supportingText = { Text("Blank: Commits From This Phone, on All Notebooks. A GitHub no-reply address (…@users.noreply.github.com) keeps yours private.") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        )
        if (authorName != view.author?.name.orEmpty() || authorEmail != view.author?.email.orEmpty()) {
            TextButton(onClick = { actions.onAuthor(id, authorName, authorEmail) }, Modifier.testTag("gitAuthorSave-$id")) {
                Text("Save the Commit Name and Email")
            }
        }
    }
}

/**
 * Remove from This Phone… asks first (A913): what goes and what is lost, Room's unsent edits
 * counted with the engine's changes, and Push First while anything may not be pushed.
 */
@Composable
private fun RemoveDialog(row: GitRow, actions: GitNotebooksActions, onDismiss: () -> Unit, onPushFirst: () -> Unit, onRemove: () -> Unit) {
    var counted by remember(row.view.localId) { mutableStateOf<Int?>(null) }
    LaunchedEffect(row.view.localId) { counted = actions.unpushed(row.view.localId) }
    val pending = counted ?: row.status?.pending?.size?.takeIf { it > 0 }
    val old = row.oldCopies?.takeIf { it.total > 0 }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Remove ${row.view.name}?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Its clone and its notes on this phone go; the repository keeps them. " + when {
                        pending == null -> "Changes not pushed yet, if any, are lost."
                        pending == 0 && old == null -> "Everything here is pushed."
                        pending == 0 -> ""
                        pending == 1 -> "1 change not pushed yet is lost."
                        else -> "$pending changes not pushed yet are lost."
                    } + (old?.let { " Lost too: ${it.words()}." } ?: "") + " The phone asks for your fingerprint, face or screen lock first.",
                    Modifier.testTag("gitRemoveWords"),
                )
                if (old != null) {
                    TextButton(onClick = { actions.onSaveUnrecovered(row.view.localId) }, Modifier.testTag("gitRemoveSave")) { Text("Save Their Text First") }
                }
            }
        },
        confirmButton = {
            // Changes not pushed (or not known yet): Push First, as on the Mac (T39 pass 3 review, A913).
            val unpushed = pending != 0
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (unpushed) TextButton(onClick = onPushFirst, Modifier.testTag("gitRemovePushFirst")) { Text("Push First") }
                TextButton(onClick = onRemove, Modifier.testTag("gitRemoveConfirm")) { Text(if (unpushed) "Remove Anyway" else "Remove") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
