package app.penmoss.git

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import app.penmoss.ui.square.Button
import androidx.compose.material3.Card
import app.penmoss.ui.square.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.square.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.Alignment
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.GitEngineStatus
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.engine.git.GitRefusal
import app.penmoss.engine.git.OwnerWords
import app.penmoss.engine.git.PendingPurge
import app.penmoss.ui.settings.ChoiceRow
import app.penmoss.ui.settings.GroupTitle
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** What the Settings row says (T50 G7): how many git notebooks are on this phone. */
fun gitSummary(count: Int): String = when (count) {
    0 -> "Notes in a private GitHub repository"
    1 -> "1 notebook on this phone"
    else -> "$count notebooks on this phone"
}

private val TIME = DateTimeFormatter.ofPattern("h:mm a", Locale.US)

private fun clock(at: Long, zone: ZoneId = ZoneId.systemDefault()) = TIME.format(Instant.ofEpochMilli(at).atZone(zone))

/**
 * A notebook's sync as its row says it (A859): synced and when, waiting for the host once a sync
 * has run a while (never "Syncing…" for ever), offline and when it tries again, or why it stopped.
 */
fun gitStatusLine(status: GitEngineStatus?, host: String, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    if (status == null) return "Opens when you open the notebook, or at the next background run."
    val pending = status.pending.size
    val waiting = if (pending == 0) "" else " · ${if (pending == 1) "1 change" else "$pending changes"} not pushed"
    return when (status.phase) {
        "synced" -> (status.lastSyncAt?.let { "Synced at ${clock(it, zone)}" } ?: "Synced") + waiting
        "syncing" -> status.since.let { since -> if (since != null && now - since > WAITING_AFTER_MS) "Waiting for $host…$waiting" else "Syncing…$waiting" }
        "offline" -> "Offline: changes stay on this phone" + (status.nextRetryAt?.let { ". Tries again at ${clock(it, zone)}" } ?: "") + waiting
        "stopped" -> status.detail ?: "Sync stopped."
        else -> "Not synced yet$waiting"
    }
}

/** After this long, a sync running says it waits for the host (A859). */
const val WAITING_AFTER_MS = 15_000L

/** One notebook as the screen shows it. */
data class GitRow(
    val view: GitNotebookView,
    val status: GitEngineStatus?,
    /** Deletes for good waiting for a confirmation (A855), once asked for. */
    val purges: List<PendingPurge>? = null,
    /** Notes brought back after Android cleared the notebook's store (A886), until dismissed. */
    val recovered: GitRecoveryNotice? = null,
    /** Whether the store is kept under low storage; false: Android may clear it (A886). */
    val storageKept: Boolean? = null,
    /** Room's copies from before Android cleared the store, not brought back yet (A886). */
    val oldCopies: GitOldCopies? = null,
    /** Copies withheld from the push, kept on this phone only (A886). */
    val withheld: List<WithheldView> = emptyList(),
    /** Notes taken back with Keep note while this screen is open, each with its Undo (A913). */
    val kept: List<PendingPurge> = emptyList(),
)

/** A copy withheld from the push (A886), as Settings and Sync name it: its title as this phone keeps it. */
data class WithheldView(val noteId: String, val title: String)

/**
 * Room's copies from before Android cleared a notebook's store (A886): [waiting] for a sync to be
 * compared, and [kept] after they could not be brought back. Remove loses both.
 */
data class GitOldCopies(val waiting: Int, val kept: Int, val withheld: Int = 0) {
    val total: Int get() = waiting + kept + withheld

    fun words(): String = buildList {
        if (waiting > 0) add(if (waiting == 1) "1 note from before the store was cleared is waiting for a sync" else "$waiting notes from before the store was cleared are waiting for a sync")
        if (kept > 0) add(if (kept == 1) "1 copy couldn't be recovered" else "$kept copies couldn't be recovered")
        if (withheld > 0) add(if (withheld == 1) "1 recovered copy is kept on this phone only" else "$withheld recovered copies are kept on this phone only")
    }.joinToString("; ")
}

data class GitNotebooksUi(
    val rows: List<GitRow> = emptyList(),
    val identityName: String = "",
    val identityEmail: String = "",
    /** The Journal notebook's local id; null with none on the phone. */
    val journal: String? = null,
    /** The app's home (A1040): the first screen, which opens on the notebooks; else Settings → Git notebooks. */
    val home: Boolean = false,
    val lastRun: Long? = null,
    val nextRun: Long? = null,
    /** What is running now: `add`, or a notebook's local id. */
    val busy: String? = null,
    val message: String? = null,
    /** Add asked: the target holds no notebook yet, so it needs a name. */
    val needsName: Boolean = false,
    /** This phone's commit-signing key, as GitHub takes it; null until one is made (#172, A921). */
    val signingKey: String? = null,
)

data class AddForm(val remote: String, val branch: String, val dir: String, val name: String, val token: String)

class GitNotebooksActions(
    val onOpen: (String) -> Unit = {},
    val onAdd: (AddForm) -> Unit = {},
    val onSyncNow: (String) -> Unit = {},
    val onRemove: (String) -> Unit = {},
    val onToken: (String, String?) -> Unit = { _, _ -> },
    val onWifiOnly: (String, Boolean) -> Unit = { _, _ -> },
    /** Sign commits, per notebook (#172, A921): on makes this phone's key first if it has none. */
    val onSignCommits: (String, Boolean) -> Unit = { _, _ -> },
    val onCopySigningKey: (String) -> Unit = {},
    /** Makes a new signing key of a kind, replacing this phone's (add the new one to GitHub). */
    val onNewSigningKey: (app.penmoss.engine.git.CommitKeyType) -> Unit = {},
    val onCadence: (String, Int, Int) -> Unit = { _, _, _ -> },
    /** This notebook's own commit name and email (#170 F6); blank both for this phone's. */
    val onAuthor: (String, String, String) -> Unit = { _, _, _ -> },
    val onShowPurges: (String) -> Unit = {},
    val onConfirmPurges: (String, List<String>) -> Unit = { _, _ -> },
    val onKeep: (String, String) -> Unit = { _, _ -> },
    /** Delete for good of a note never confirmed on this phone: the phone's own check (A913). */
    val onConfirmPurge: (String, String) -> Unit = { _, _ -> },
    /** Undo of a Keep note: the note is marked deleted for good again, as it was (A913). */
    val onUndoKeep: (String, String) -> Unit = { _, _ -> },
    /** What Remove would lose: the engine's changes and Room's unsent edits; null while unknown. */
    val unpushed: suspend (String) -> Int? = { null },
    val onIdentity: (String, String) -> Unit = { _, _ -> },
    val onJournal: (String) -> Unit = {},
    val onDismissMessage: () -> Unit = {},
    val onDismissRecovery: (String) -> Unit = {},
    /** Save the text of copies that could not be brought back (A886): a file the person picks. */
    val onSaveUnrecovered: (String) -> Unit = {},
    /** Copies withheld from the push (A886): Save their text, Delete for good, Keep and sync. */
    val onSaveWithheld: (String) -> Unit = {},
    val onDropWithheld: (String, String) -> Unit = { _, _ -> },
    val onKeepWithheld: (String, String) -> Unit = { _, _ -> },
)

/**
 * Settings → Git notebooks (T50 G7, G8; A856, A825, A855): the notebooks on this phone, each
 * with its repository, sync and what only the person can do (Delete for good
 * again, Keep note, Remove, behind the phone's own check), Add, this phone's git
 * identity, the Journal notebook and the background runs. It is also the app's home (A828, A1040):
 * with no notebook yet, the first run asks to add or create one.
 */
@Composable
fun GitNotebooksScreen(ui: GitNotebooksUi, actions: GitNotebooksActions, onBack: () -> Unit) {
    var removing by remember { mutableStateOf<GitRow?>(null) }
    var pushingFirst by remember { mutableStateOf(false) }
    SectionScreen(if (ui.home) "Penmoss" else "Notebooks", onBack, notice = null) {
        if (ui.message != null) {
            Text(
                ui.message,
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("gitMessage").semantics { liveRegion = LiveRegionMode.Polite },
                color = MaterialTheme.colorScheme.error,
            )
            TextButton(onClick = actions.onDismissMessage, Modifier.padding(horizontal = 8.dp)) { Text("OK") }
        }
        if (ui.rows.isEmpty()) {
            // The first run (A1040): nothing to open yet, so the screen says how to start.
            Text(
                FIRST_RUN,
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("gitFirstRun"),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        Help(
            "A git notebook keeps its notes in a private repository: Penmoss commits to it from this phone over HTTPS with a personal access token, " +
                "kept with the Android Keystore. Nothing of it leaves the phone but through git.",
        )
        if (pushingFirst) {
            Text(
                "Pushing first. Remove once it says Synced.",
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("gitPushFirstSaid").semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        for (row in ui.rows) NotebookCard(row, ui, actions, onRemove = { removing = row })
        AddCard(ui, actions)
        ThisPhone(ui, actions)
    }
    removing?.let { row ->
        // Room's unsent edits count as well as the engine's changes (T39 pass 3 delta review, A913):
        // until both are known, changes may be lost, and Push first is offered.
        var counted by remember(row.view.localId) { mutableStateOf<Int?>(null) }
        LaunchedEffect(row.view.localId) { counted = actions.unpushed(row.view.localId) }
        val pending = counted ?: row.status?.pending?.size?.takeIf { it > 0 }
        val old = row.oldCopies?.takeIf { it.total > 0 }
        AlertDialog(
            onDismissRequest = { removing = null },
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
                // Changes not pushed (or not known yet): Push first, as on the Mac (T39 pass 3 review, A913).
                val unpushed = pending != 0
                Row {
                    if (unpushed) {
                        TextButton(onClick = {
                            removing = null
                            pushingFirst = true
                            actions.onSyncNow(row.view.localId)
                        }, Modifier.testTag("gitRemovePushFirst")) { Text("Push First") }
                    }
                    TextButton(onClick = { removing = null; pushingFirst = false; actions.onRemove(row.view.localId) }, Modifier.testTag("gitRemoveConfirm")) {
                        Text(if (unpushed) "Remove Anyway" else "Remove")
                    }
                }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

/** What the first run says, with no git notebook on the phone (A1040). */
internal const val FIRST_RUN =
    "Penmoss keeps your notes in git notebooks. Add one from a private GitHub repository, or create one: point Add at an empty private repository and give the new notebook a name."

@Composable
private fun NotebookCard(row: GitRow, ui: GitNotebooksUi, actions: GitNotebooksActions, onRemove: () -> Unit) {
    val view = row.view
    val id = view.localId
    val busy = ui.busy == id
    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("gitNotebook-$id")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(view.name, style = MaterialTheme.typography.titleMedium)
            Text(
                view.repository + (if (view.branch != "main") " · ${view.branch}" else "") + (if (view.dir.isNotEmpty()) " · ${view.dir}/" else ""),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                gitStatusLine(row.status, view.host),
                Modifier.testTag("gitStatus-$id").semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodySmall,
                color = if (row.status?.phase == "stopped") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { actions.onOpen(id) }, Modifier.testTag("gitOpen-$id")) { Text("Open") }
                FilledTonalButton(onClick = { actions.onSyncNow(id) }, enabled = !busy, modifier = Modifier.testTag("gitSync-$id")) {
                    Text(if (busy) "Syncing…" else "Sync Now")
                }
            }
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
            Settings(row, actions)
            HorizontalDivider()
            TextButton(onClick = onRemove, Modifier.testTag("gitRemove-$id")) { Text("Remove from This Phone", color = MaterialTheme.colorScheme.error) }
        }
    }
}

/**
 * What came of Android clearing the store (A886): notes brought back, and copies that could not
 * be, with Save their text; said plainly, until dismissed.
 */
@Composable
fun RecoveryNotice(notice: GitRecoveryNotice, onSave: () -> Unit = {}, onDismiss: () -> Unit) {
    if (!notice.shown) return
    Card(
        Modifier.fillMaxWidth().testTag("gitRecovered").semantics { liveRegion = LiveRegionMode.Polite },
        colors = androidx.compose.material3.CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (notice.titles.isEmpty()) "Notes not brought back" else "Notes brought back",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(notice.words(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
            Row {
                if (notice.unrecovered.isNotEmpty()) {
                    TextButton(onClick = onSave, Modifier.testTag("gitRecoveredSave")) { Text("Save Their Text") }
                }
                TextButton(onClick = onDismiss, Modifier.testTag("gitRecoveredDismiss")) { Text("Got It") }
            }
        }
    }
}

/**
 * Copies withheld from the push (A886): brought back after Android cleared the store, their
 * original then deleted for good on another device. Said plainly while any is kept, each with
 * Delete for good and Keep and sync (both behind the phone's own check), and Save their text.
 */
@Composable
fun WithheldNotice(copies: List<WithheldView>, onSave: () -> Unit, onDelete: (String) -> Unit, onKeep: (String) -> Unit) {
    if (copies.isEmpty()) return
    Card(
        Modifier.fillMaxWidth().testTag("gitWithheld").semantics { liveRegion = LiveRegionMode.Polite },
        colors = androidx.compose.material3.CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (copies.size == 1) {
                    "A recovered copy of a note deleted for good on another device was kept on this device only."
                } else {
                    "${copies.size} recovered copies of notes deleted for good on another device were kept on this device only."
                },
                Modifier.testTag("gitWithheldWords"),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                "Nothing of ${if (copies.size == 1) "it" else "them"} was pushed. Keep and Sync pushes a copy as a new note; Delete for Good removes it from this phone. The phone asks for your fingerprint, face or screen lock first.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            for (copy in copies) {
                Text(
                    OwnerWords.title(copy.title) ?: "An untitled note",
                    Modifier.testTag("gitWithheldTitle-${copy.noteId}"),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
                Row {
                    TextButton(onClick = { onKeep(copy.noteId) }, Modifier.testTag("gitWithheldKeep-${copy.noteId}")) { Text("Keep and Sync") }
                    TextButton(onClick = { onDelete(copy.noteId) }, Modifier.testTag("gitWithheldDelete-${copy.noteId}")) { Text("Delete for Good") }
                }
            }
            TextButton(onClick = onSave, Modifier.testTag("gitWithheldSave")) { Text("Save Their Text") }
        }
    }
}

/** Deletes for good waiting (A855): confirmed again only where this phone confirmed them once; Keep note for the rest. */
@Composable
private fun Purges(row: GitRow, actions: GitNotebooksActions) {
    val id = row.view.localId
    val purges = row.purges
    LaunchedEffect(id, purges == null) { if (purges == null) actions.onShowPurges(id) }
    Text("Delete for good, waiting", style = MaterialTheme.typography.titleSmall)
    if (purges == null) {
        Text("Reading the notes from the branch…", style = MaterialTheme.typography.bodySmall)
        return
    }
    Kept(row, actions)
    if (purges.isEmpty()) {
        Text("Nothing waits: the next sync goes on.", style = MaterialTheme.typography.bodySmall)
        return
    }
    Help(
        "A sync stopped because it would delete these for good without a confirmation from the last 10 minutes. " +
            "Each is named as the branch has it. Keep note puts it back where it was and deletes nothing; " +
            "Delete for Good asks for your fingerprint, face or screen lock first.",
        Modifier.padding(0.dp),
    )
    for (purge in purges) {
        ListItem(
            // Named from the branch, cleaned and isolated as the owner check names it (OwnerWords).
            headlineContent = { Text(OwnerWords.title(purge.title) ?: "An untitled note", Modifier.testTag("gitPurgeTitle-${purge.id}")) },
            supportingContent = { Text(if (purge.confirmedBefore) "You confirmed this on this phone; it ran out" else "Never confirmed on this phone") },
            trailingContent = {
                Column(horizontalAlignment = Alignment.End) {
                    TextButton(onClick = { actions.onKeep(id, purge.id) }, Modifier.testTag("gitKeep-${purge.id}")) { Text("Keep Note") }
                    // Never confirmed here: Delete for good, behind the phone's own check, as on the Mac (A913).
                    if (!purge.confirmedBefore) {
                        TextButton(onClick = { actions.onConfirmPurge(id, purge.id) }, Modifier.testTag("gitPurgeNote-${purge.id}")) { Text("Delete for Good") }
                    }
                }
            },
            modifier = Modifier.testTag("gitPurge-${purge.id}"),
        )
    }
    val again = purges.filter { it.confirmedBefore }.map { it.id }
    if (again.isNotEmpty()) {
        OutlinedButton(onClick = { actions.onConfirmPurges(id, again) }, Modifier.testTag("gitConfirmPurges-$id")) {
            // The button the refusal names ("Confirm Delete for good again in Settings → Git notebooks"), as on the Mac (A894).
            Text(if (again.size == 1) "Confirm Delete for Good Again" else "Confirm Delete for Good Again: ${again.size} notes")
        }
    }
}

/** Notes kept with Keep note while Settings is open (A913): each says so, with Undo. */
@Composable
private fun Kept(row: GitRow, actions: GitNotebooksActions) {
    for (note in row.kept) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Kept ${OwnerWords.title(note.title) ?: "an untitled note"}.",
                Modifier.weight(1f).testTag("gitKept-${note.id}"),
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(onClick = { actions.onUndoKeep(row.view.localId, note.id) }, Modifier.testTag("gitKeepUndo-${note.id}")) { Text("Undo") }
        }
    }
}

@Composable
private fun Settings(row: GitRow, actions: GitNotebooksActions) {
    val view = row.view
    val id = view.localId
    var token by rememberSaveable(id) { mutableStateOf("") }
    var push by rememberSaveable(id) { mutableStateOf(view.pushDelayS.toString()) }
    var pull by rememberSaveable(id) { mutableStateOf(view.pullEveryMin.toString()) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Column(Modifier.weight(1f)) {
            Text("Wi-Fi only")
            Text("In the background, sync this notebook only on Wi-Fi.", style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = view.wifiOnly, onCheckedChange = { actions.onWifiOnly(id, it) }, modifier = Modifier.testTag("gitWifi-$id"))
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Column(Modifier.weight(1f)) {
            Text("Sign commits")
            Text(
                "Sign every commit from this phone with its signing key (SSH), as a branch that requires signed commits needs. If it cannot sign, the sync stops: never an unsigned commit.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Switch(checked = view.signCommits, onCheckedChange = { actions.onSignCommits(id, it) }, modifier = Modifier.testTag("gitSign-$id"))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            push,
            { push = it.filter(Char::isDigit).take(4) },
            Modifier.weight(1f).testTag("gitPush-$id"),
            label = { Text("Push after (seconds)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        OutlinedTextField(
            pull,
            { pull = it.filter(Char::isDigit).take(4) },
            Modifier.weight(1f).testTag("gitPull-$id"),
            label = { Text("Pull every (minutes)") },
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
        ) { Text("Save the Cadence") }
    }
    OutlinedTextField(
        token,
        { token = it.trim() },
        Modifier.fillMaxWidth().testTag("gitToken-$id"),
        label = { Text(if (view.hasToken) "Personal access token (saved; type a new one to replace it)" else "Personal access token") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { actions.onToken(id, token); token = "" }, enabled = token.isNotEmpty()) { Text("Save Token") }
        if (view.hasToken) TextButton(onClick = { actions.onToken(id, null) }) { Text("Forget Token") }
    }
    // This notebook's own commit identity (#170 F6): a GitHub no-reply address keeps an email
    // private, and GitHub refuses pushes that would show one it keeps private (GH007).
    var authorName by rememberSaveable(id, view.author) { mutableStateOf(view.author?.name.orEmpty()) }
    var authorEmail by rememberSaveable(id, view.author) { mutableStateOf(view.author?.email.orEmpty()) }
    OutlinedTextField(
        authorName,
        { authorName = it },
        Modifier.fillMaxWidth().testTag("gitAuthorName-$id"),
        label = { Text("Commit name for this notebook") },
        singleLine = true,
    )
    OutlinedTextField(
        authorEmail,
        { authorEmail = it.trim() },
        Modifier.fillMaxWidth().testTag("gitAuthorEmail-$id"),
        label = { Text("Commit email for this notebook") },
        supportingText = { Text("Blank: Commits from this phone. A GitHub no-reply address (…@users.noreply.github.com) keeps yours private.") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
    )
    if (authorName != view.author?.name.orEmpty() || authorEmail != view.author?.email.orEmpty()) {
        TextButton(onClick = { actions.onAuthor(id, authorName, authorEmail) }, Modifier.testTag("gitAuthorSave-$id")) {
            Text("Save the Commit Name and Email")
        }
    }
}

@Composable
private fun AddCard(ui: GitNotebooksUi, actions: GitNotebooksActions) {
    var remote by rememberSaveable { mutableStateOf("") }
    var branch by rememberSaveable { mutableStateOf("main") }
    var dir by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }
    val form = AddForm(remote.trim(), branch.trim(), dir.trim(), name.trim(), token.trim())
    GroupTitle("Add a git notebook")
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(remote, { remote = it }, Modifier.fillMaxWidth().testTag("gitAddRemote"), label = { Text("Repository (https://github.com/owner/repo)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(branch, { branch = it }, Modifier.weight(1f), label = { Text("Branch") }, singleLine = true)
            OutlinedTextField(dir, { dir = it }, Modifier.weight(1f), label = { Text("Directory (optional)") }, singleLine = true)
        }
        OutlinedTextField(
            token,
            { token = it },
            Modifier.fillMaxWidth().testTag("gitAddToken"),
            label = { Text("Personal access token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        if (ui.needsName) {
            Help("This repository holds no notebook yet: give the new one a name.", Modifier.padding(0.dp))
            OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().testTag("gitAddName"), label = { Text("Notebook name") }, singleLine = true)
        }
        Button(onClick = { actions.onAdd(form) }, enabled = remote.isNotBlank() && ui.busy != "add", modifier = Modifier.testTag("gitAdd")) {
            Text(if (ui.busy == "add") "Checking…" else "Add")
        }
        Help("GitHub: a fine-grained token with Contents read and write and Metadata read on that repository only. SSH is not supported on Android.", Modifier.padding(0.dp))
    }
}

/**
 * Asks before a new signing key replaces this phone's (#174 delta review): it is one key for every
 * notebook here, and the old one is deleted from the Keystore. Nothing in a repository changes,
 * so no fingerprint is asked; the words name the notebooks that sign and say to add the new
 * public key to GitHub.
 */
@Composable
private fun NewSigningKey(
    type: app.penmoss.engine.git.CommitKeyType?,
    ui: GitNotebooksUi,
    onDismiss: () -> Unit,
    onConfirm: (app.penmoss.engine.git.CommitKeyType) -> Unit,
) {
    if (type == null) return
    val kind = if (type == app.penmoss.engine.git.CommitKeyType.ED25519) "an Ed25519" else "a new P-256"
    val signing = ui.rows.filter { it.view.signCommits }.map { it.view.name }
    val who = when (signing.size) {
        0 -> "No notebook signs commits now; any you turn Sign commits on for uses it."
        1 -> "${signing.single()} signs with it from its next commit."
        else -> "${signing.dropLast(1).joinToString(", ")} and ${signing.last()} sign with it from their next commits."
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Make $kind signing key?") },
        text = {
            Text(
                "This deletes this phone's signing key and makes $kind key in its place, for every git notebook on this phone. $who " +
                    "Its commits show Unverified on GitHub until you add its public key to GitHub as a signing key (Settings → SSH and GPG keys); remove the old key there afterwards. Nothing in the repositories changes.",
                Modifier.testTag("gitSigningKeyWords"),
            )
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(type) }, Modifier.testTag("gitSigningKeyConfirm")) { Text("Make the Key") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, Modifier.testTag("gitSigningKeyCancel")) { Text("Cancel") }
        },
    )
}

@Composable
private fun ThisPhone(ui: GitNotebooksUi, actions: GitNotebooksActions) {
    var name by rememberSaveable(ui.identityName) { mutableStateOf(ui.identityName) }
    var email by rememberSaveable(ui.identityEmail) { mutableStateOf(ui.identityEmail) }
    /** The kind of key a tap on Make… asks to make, while its confirmation shows. */
    var making by remember { mutableStateOf<app.penmoss.engine.git.CommitKeyType?>(null) }
    GroupTitle("On this phone")
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Commits from this phone", style = MaterialTheme.typography.titleSmall)
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().testTag("gitIdentityName"), label = { Text("Name") }, singleLine = true)
        OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth().testTag("gitIdentityEmail"), label = { Text("Email") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        if (name != ui.identityName || email != ui.identityEmail) {
            TextButton(onClick = { actions.onIdentity(name, email) }) { Text("Save") }
        }
        ui.signingKey?.let { key ->
            NewSigningKey(making, ui, onDismiss = { making = null }) { type ->
                making = null
                actions.onNewSigningKey(type)
            }
            Text("Signing key", style = MaterialTheme.typography.titleSmall)
            Text(
                "Made in this phone's Keystore; it never leaves the phone. Add it to GitHub as a signing key (Settings → SSH and GPG keys → New SSH key, Key type: Signing Key), with the email above verified on your account, so its commits show Verified.",
                style = MaterialTheme.typography.bodySmall,
            )
            Text(key, Modifier.fillMaxWidth().testTag("gitSigningKey"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { actions.onCopySigningKey(key) }, Modifier.testTag("gitSigningKeyCopy")) { Text("Copy") }
                TextButton(onClick = { making = app.penmoss.engine.git.CommitKeyType.P256 }, Modifier.testTag("gitSigningKeyNew")) { Text("Make a New Key") }
                TextButton(onClick = { making = app.penmoss.engine.git.CommitKeyType.ED25519 }, Modifier.testTag("gitSigningKeyNewEd25519")) { Text("Make an Ed25519 Key") }
            }
            Text(
                "Make a new key is P-256, which every phone's Keystore has; Ed25519 works where this phone's Keystore has it, and your key stays as it is where it does not.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
    if (ui.rows.isNotEmpty()) {
        GroupTitle("Journal notebook")
        Help("Where Today, This week and captures from the share sheet, the tile and the widget go on this phone.")
        Column(Modifier.selectableGroup()) {
            for (row in ui.rows) {
                ChoiceRow(row.view.name, row.view.repository, ui.journal == row.view.localId, true, "gitJournal-${row.view.localId}") { actions.onJournal(row.view.localId) }
            }
        }
        GroupTitle("In the background")
        Help(
            "Git notebooks sync about every 15 minutes while the app is closed (Android's least; it may wait longer in Doze or battery saver), " +
                "and soon after you leave the app with changes not pushed." +
                (ui.lastRun?.let { " Last run at ${clock(it)}." } ?: "") +
                (ui.nextRun?.let { " Next at about ${clock(it)}." } ?: ""),
            Modifier.testTag("gitBackground"),
        )
    }
}

/** Settings → Git notebooks, over the hub (T50 G7). [onOpen] opens a notebook's screens. */
@Composable
fun GitNotebooksRoute(
    hub: GitNotebookHub,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
    /** The app's home (A1040), not Settings. */
    home: Boolean = false,
) {
    val views by hub.list.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var needsName by remember { mutableStateOf(false) }
    val purges = remember { mutableStateMapOf<String, List<PendingPurge>>() }
    val keptNotes = remember { mutableStateMapOf<String, List<PendingPurge>>() }
    var tick by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        // The statuses and background times, read again every few seconds while shown.
        while (true) {
            delay(3_000)
            tick++
        }
    }
    val shownStatuses by hub.statuses.collectAsStateWithLifecycle()
    val recoveries by hub.recoveries.collectAsStateWithLifecycle()
    val kept by hub.storageKept.collectAsStateWithLifecycle()
    val oldCopies by hub.oldCopies.collectAsStateWithLifecycle()
    val withheld by hub.withheld.collectAsStateWithLifecycle()
    val saveUnrecovered = rememberSaveUnrecovered(hub) { message = it }
    val saveWithheld = rememberSaveUnrecovered(hub, withheld = true) { message = it }
    val (name, email) = remember(tick) { hub.identitySet() }
    val runs = remember(tick) { hub.lastBackgroundRun() to null as Long? }
    var next by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(tick / 10) { next = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { hub.nextRun() } }
    fun run(what: String, block: suspend () -> Unit) {
        busy = what
        scope.launch {
            try {
                block()
            } catch (error: GitRefusal) {
                message = error.message
            } catch (error: IllegalArgumentException) {
                message = error.message
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                message = error.message ?: "That did not work."
            } finally {
                busy = null
            }
        }
    }
    val ui = GitNotebooksUi(
        rows = views.map { GitRow(it, shownStatuses[it.localId], purges[it.localId], recoveries[it.localId], kept[it.localId], oldCopies[it.localId], withheld[it.localId].orEmpty(), keptNotes[it.localId].orEmpty()) },
        identityName = name,
        identityEmail = email,
        journal = hub.journal(),
        home = home,
        lastRun = runs.first,
        nextRun = next,
        busy = busy,
        message = message,
        needsName = needsName,
        signingKey = remember(tick, views) { runCatching { hub.signingKey() }.getOrNull() },
    )
    val clipboard = androidx.compose.ui.platform.LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)
    val actions = GitNotebooksActions(
        onOpen = onOpen,
        onAdd = { form ->
            run("add") {
                when (hub.add(form.remote, form.branch, form.dir, form.name.ifBlank { null }, form.token.ifBlank { null })) {
                    is AddResult.Added -> needsName = false
                    AddResult.NeedsName -> needsName = true
                }
            }
        },
        onSyncNow = { id -> run(id) { hub.syncNow(id) } },
        onRemove = { id -> run(id) { hub.remove(id) } },
        onToken = { id, token -> run(id) { hub.notebooks.setToken(id, token) } },
        onWifiOnly = { id, on -> run(id) { hub.update(id, wifiOnly = on) } },
        onSignCommits = { id, on ->
            run(id) {
                hub.setSignCommits(id, on)
                message = if (on) "Commits from this phone are signed. Add its signing key to GitHub as a signing key." else "Commits from this phone are not signed."
                tick++
            }
        },
        onAuthor = { id, name, email ->
            run(id) {
                val view = hub.setAuthor(id, name.ifBlank { null }, email.ifBlank { null })
                message = view.author?.let { "This notebook commits as ${it.name} <${it.email}> from the next commit." }
                    ?: "This notebook commits as Commits from this phone says, from the next commit."
            }
        },
        onCopySigningKey = { key ->
            clipboard?.setPrimaryClip(android.content.ClipData.newPlainText("Penmoss signing key", key))
            message = "Copied the signing key."
        },
        onNewSigningKey = { type ->
            run("key") {
                hub.newSigningKey(type)
                message = "A new signing key: add it to GitHub as a signing key. Commits are signed with it from now on."
                tick++
            }
        },
        onCadence = { id, push, pull -> run(id) { hub.update(id, pushDelayS = push, pullEveryMin = pull) } },
        onShowPurges = { id -> scope.launch { purges[id] = runCatching { hub.purgesToConfirm(id) }.getOrDefault(emptyList()) } },
        onConfirmPurges = { id, ids -> run(id) { hub.confirmPurgesAgain(id, ids); purges.remove(id) } },
        onDismissRecovery = hub::dismissRecovery,
        onSaveUnrecovered = saveUnrecovered,
        onSaveWithheld = saveWithheld,
        onDropWithheld = { id, note -> run(id) { hub.dropWithheld(id, note) } },
        onKeepWithheld = { id, note -> run(id) { hub.keepWithheld(id, note) } },
        onKeep = { id, note ->
            run(id) {
                val refused = hub.keepNote(id, note)
                if (refused != null) {
                    message = refused
                } else {
                    purges[id]?.firstOrNull { it.id == note }?.let { keptNotes[id] = keptNotes[id].orEmpty() + it }
                }
                purges[id] = hub.purgesToConfirm(id)
            }
        },
        onUndoKeep = { id, note ->
            run(id) {
                hub.keepNote(id, note, keep = false)
                keptNotes[id] = keptNotes[id].orEmpty().filterNot { it.id == note }
                purges[id] = hub.purgesToConfirm(id)
            }
        },
        unpushed = { id -> hub.unpushed(id) },
        onConfirmPurge = { id, note ->
            run(id) {
                hub.confirmPurge(id, note)
                message = "Confirmed: Delete for Good goes at this sync."
                purges[id] = hub.purgesToConfirm(id)
            }
        },
        onIdentity = { n, e -> run("identity") { hub.setIdentity(n, e); tick++ } },
        onJournal = { id -> hub.setJournal(id); tick++ },
        onDismissMessage = { message = null },
    )
    GitNotebooksScreen(ui, actions, onBack)
}

/**
 * Save their text (A886): the person picks a file, and what can be read of each copy that could
 * not be brought back goes into it, as markdown. [said] hears how it went.
 */
@Composable
fun rememberSaveUnrecovered(hub: GitNotebookHub, withheld: Boolean = false, said: (String) -> Unit): (String) -> Unit {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var target by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf<String?>(null) }
    val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("text/markdown"),
    ) { uri ->
        val localId = target
        target = null
        if (uri == null || localId == null) return@rememberLauncherForActivityResult
        scope.launch {
            said(
                try {
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        val out = context.contentResolver.openOutputStream(uri) ?: throw java.io.IOException("the file could not be opened")
                        out.use { if (withheld) hub.saveWithheld(localId, it) else hub.saveUnrecovered(localId, it) }
                    }
                    "Saved what can be read of them."
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    "Penmoss could not save them: ${error.message ?: "that did not work"}."
                },
            )
        }
    }
    return { localId ->
        target = localId
        launcher.launch(if (withheld) "Penmoss notes kept on this phone.md" else "Penmoss notes not brought back.md")
    }
}
