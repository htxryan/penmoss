package app.penmoss.git

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import app.penmoss.ui.common.Button
import androidx.compose.material3.Card
import app.penmoss.ui.common.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedButton
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
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
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
import app.penmoss.ui.common.DotState
import app.penmoss.ui.settings.DotMarkOf
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.trackedToggle
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.GitEngineStatus
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.engine.git.GitRefusal
import app.penmoss.engine.git.OwnerWords
import app.penmoss.engine.git.PendingPurge
import app.penmoss.ui.settings.ChoiceRow
import app.penmoss.ui.settings.DeviceOnlyHeadline
import app.penmoss.ui.settings.GroupTitle
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen
import app.penmoss.ui.settings.settingRow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale


/** What the All Notebooks row says (T50 G7; PEN-146): what it holds, or how to start. */
fun gitSummary(count: Int): String = when (count) {
    0 -> "Add a notebook from a private GitHub repository"
    else -> "Add, Primary Notebook, Between Notebooks"
}

/** Copy Tags When Copying Notes (A1353): core's `COPY_TAGS_SETTING`, a synced device setting. */
const val COPY_TAGS_SETTING = "copyToNotebook.tags"

/** A notebook's sync as its dot shows it (A1035): the engine's phase. */
fun dotOf(status: GitEngineStatus?): DotState = when (status?.phase) {
    "synced" -> DotState.SYNCED
    "syncing" -> DotState.SYNCING
    "offline" -> DotState.OFFLINE
    "stopped" -> DotState.STOPPED
    else -> DotState.IDLE
}

private val TIME = DateTimeFormatter.ofPattern("h:mm a", Locale.US)

internal fun clock(at: Long, zone: ZoneId = ZoneId.systemDefault()) = TIME.format(Instant.ofEpochMilli(at).atZone(zone))

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
        "stopped" -> status.detail ?: "Sync Stopped"
        else -> "Not Synced Yet$waiting"
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
    /** Its badge (A1579): the default until its settings are read. */
    val badge: app.penmoss.engine.settings.NotebookBadge = app.penmoss.engine.settings.NotebookBadges.defaultBadge(view.notebookId, view.name),
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
    /** Copy Tags When Copying Notes (A1353), synced; null where it is not offered (the app's home). */
    val copyTags: Boolean? = null,
    /** Keep Settings in Step (A1137; PEN-148): this phone's choice. */
    val inStep: Boolean = false,
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
    /** The notebook's AI Descriptions (PEN-161): read, set (the value now, or null when it failed). */
    val aiSetting: suspend (String) -> String? = { null },
    val onAiSetting: suspend (String, String) -> String? = { _, _ -> null },
    /** Describe Notes Now for the whole notebook: how many go, or null when it could not start. */
    val onDescribeAll: suspend (String) -> Int? = { null },
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
    /** Copy Tags When Copying Notes (A1353): the Mac's Copy to Notebook starts with it. */
    val onCopyTags: (Boolean) -> Unit = {},
    /** Opens a notebook's own page in Settings (PEN-146). */
    val onPage: (String) -> Unit = {},
    /** Keep Settings in Step (A1137; PEN-148), this phone's choice. */
    val onInStep: (Boolean) -> Unit = {},
    /** Changes a notebook's badge (A1579): `badge.color` or `badge.glyph`, null back to its default. */
    val onBadge: (String, String, kotlinx.serialization.json.JsonElement?) -> Unit = { _, _, _ -> },
    /**
     * Copy Settings… (A1137; PEN-148): one notebook's settings into another's, or every other's
     * when the second is null, once. Answers what to say of it.
     */
    val onCopySettings: suspend (from: String, to: String?) -> String = { _, _ -> "" },
)

/**
 * Settings → All Notebooks (T50 G7, G8; A856, A825, A855; PEN-146): the notebooks on this phone, one
 * row each with its sync dot (a tap opens its page), Add Notebook (its form shows only after Add),
 * Between Notebooks (the Primary Notebook first), Commits from This Phone and the background runs. It is
 * also the app's home (A828, A1040), titled Penmoss with Settings in its bar, where a row opens the
 * notebook: with no notebook yet, the first run asks to add or create one.
 */
@Composable
fun GitNotebooksScreen(
    ui: GitNotebooksUi,
    actions: GitNotebooksActions,
    onBack: () -> Unit,
    onSettings: (() -> Unit)? = null,
    /** Add Notebook's flow, the first run's own screens (A1562); null: the form here. */
    onAddNotebook: (() -> Unit)? = null,
) {
    var adding by rememberSaveable { mutableStateOf(false) }
    var picking by rememberSaveable { mutableStateOf(false) }
    // A notebook added: the form closes.
    var count by remember { mutableStateOf(ui.rows.size) }
    LaunchedEffect(ui.rows.size) {
        if (ui.rows.size > count) adding = false
        count = ui.rows.size
    }
    SectionScreen(
        if (ui.home) "Penmoss" else "All Notebooks",
        onBack,
        notice = null,
        // The app's home is not a Settings screen: no (i) there.
        info = !ui.home,
        actions = {
            if (onSettings != null) {
                app.penmoss.ui.common.IconButton(onClick = trackedClick("home.settings", onSettings), modifier = Modifier.testTag("homeSettingsGear")) {
                    androidx.compose.material3.Icon(app.penmoss.ui.settings.SettingsIcons.Gear, contentDescription = "Settings")
                }
            }
        },
    ) {
        if (ui.message != null) {
            Text(
                ui.message,
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("gitMessage").semantics { liveRegion = LiveRegionMode.Polite },
                color = MaterialTheme.colorScheme.error,
            )
            TextButton(onClick = trackedClick("settings.git-notebooks.message.dismiss", actions.onDismissMessage), Modifier.padding(horizontal = 8.dp)) { Text("OK") }
        }
        if (ui.rows.isEmpty() && onAddNotebook == null) {
            // The first run (A1040): nothing to open yet, so the screen says how to start.
            Text(
                FIRST_RUN,
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("gitFirstRun"),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        for ((at, row) in ui.rows.withIndex()) NotebookRow(row, primary = ui.journal == row.view.localId, if (at == 0) Modifier.settingRow("all-notebooks") else Modifier, event = if (ui.home) "home.notebook" else "settings.git-notebooks.row.open") {
            if (ui.home) actions.onOpen(row.view.localId) else actions.onPage(row.view.localId)
        }
        if (onAddNotebook == null && (adding || ui.rows.isEmpty())) {
            AddForm(ui, actions, onCancel = if (ui.rows.isEmpty()) null else ({ adding = false }))
        } else {
            Button(
                onClick = trackedClick("settings.git-notebooks.add") { if (onAddNotebook != null) onAddNotebook() else adding = true },
                Modifier.settingRow("add-notebook").padding(horizontal = 16.dp, vertical = 8.dp).testTag("gitAddOpen"),
            ) { Text("+ Add Notebook") }
        }
        if (ui.home) return@SectionScreen
        BetweenNotebooks(ui, actions, onPickPrimary = { picking = true })
        CommitsFromThisPhone(ui, actions)
        if (ui.rows.isNotEmpty()) {
            GroupTitle("Background Sync", Modifier.settingRow("background-sync"))
            Help(
                "Notebooks sync about every 15 minutes while the app is closed (Android's least; it may wait longer in Doze or battery saver), " +
                    "and soon after you leave the app with changes not pushed." +
                    (ui.lastRun?.let { " Last run at ${clock(it)}." } ?: "") +
                    (ui.nextRun?.let { " Next at about ${clock(it)}." } ?: ""),
                Modifier.testTag("gitBackground"),
            )
        }
    }
    if (picking) {
        val tracked = rememberTrackedDialog("primaryNotebook")
        AlertDialog(
            onDismissRequest = { picking = false },
            title = { Text("Primary Notebook") },
            text = {
                Column(Modifier.selectableGroup()) {
                    Help("Where Today, This Week and captures from the share sheet, the tile and the widget go on this phone.", Modifier.padding(0.dp))
                    for (row in ui.rows) {
                        ChoiceRow(row.view.name, row.view.repository, ui.journal == row.view.localId, true, "gitJournal-${row.view.localId}", event = "settings.git-notebooks.journal") {
                            tracked.done()
                            picking = false
                            actions.onJournal(row.view.localId)
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = trackedClick("settings.git-notebooks.journal.cancel") { picking = false }) { Text("Cancel") } },
        )
    }
}

/**
 * Between Notebooks (A1137, A1353, A1550; PEN-148), as the Mac's: the Primary Notebook first
 * (A1558; this phone's choice, [onPickPrimary] opens its picker), then Keep Settings in Step (this
 * phone's choice: each change to the primary notebook's settings goes to the others), Copy Tags
 * When Copying Notes (synced) and Copy Settings… (from one notebook to another, once). Keep
 * Settings in Step and Copy Settings… show only with two notebooks or more.
 */
@Composable
private fun BetweenNotebooks(ui: GitNotebooksUi, actions: GitNotebooksActions, onPickPrimary: () -> Unit) {
    if (ui.rows.isEmpty()) return
    val several = ui.rows.size > 1
    var copying by rememberSaveable { mutableStateOf(false) }
    GroupTitle("Between Notebooks")
    val chosen = ui.rows.firstOrNull { it.view.localId == ui.journal }
    ListItem(
        headlineContent = { DeviceOnlyHeadline("Primary Notebook") },
        supportingContent = { Text("Holds your journal, Inbox and these settings") },
        trailingContent = { Text("${chosen?.view?.name ?: "None"} ›", color = MaterialTheme.colorScheme.onSurfaceVariant) },
        modifier = Modifier.settingRow("primary-notebook").testTag("gitPrimary").clickable(role = Role.Button, onClick = trackedClick("settings.git-notebooks.journal.open", onPickPrimary)),
    )
    if (several) {
        val primary = ui.rows.firstOrNull { it.view.localId == ui.journal } ?: ui.rows.first()
        ListItem(
            headlineContent = { DeviceOnlyHeadline("Keep Settings in Step") },
            supportingContent = { Text("A change to ${primary.view.name}’s settings goes to the other notebooks") },
            trailingContent = { Switch(checked = ui.inStep, onCheckedChange = null) },
            modifier = Modifier.settingRow("keep-settings-in-step").testTag("gitSettingsInStep")
                .toggleable(value = ui.inStep, role = Role.Switch, onValueChange = trackedToggle("settings.git-notebooks.in-step", actions.onInStep)),
        )
    }
    if (ui.copyTags != null) {
        ListItem(
            headlineContent = { Text("Copy Tags When Copying Notes") },
            supportingContent = { Text("Copy to Notebook on the Mac starts with this; it syncs from here.") },
            trailingContent = { Switch(checked = ui.copyTags, onCheckedChange = null) },
            modifier = Modifier.settingRow("copy-tags-when-copying-notes").testTag("gitCopyTags")
                .toggleable(value = ui.copyTags, role = Role.Switch, onValueChange = trackedToggle("settings.git-notebooks.copy-tags", actions.onCopyTags)),
        )
    }
    if (several) {
        ListItem(
            headlineContent = { Text("Copy Settings…") },
            supportingContent = { Text("From one notebook to another, once") },
            modifier = Modifier.settingRow("copy-settings").testTag("gitCopySettingsOpen").clickable(role = Role.Button, onClick = trackedClick("settings.git-notebooks.copy-settings.open") { copying = true }),
        )
    }
    if (several && copying) {
        CopySettingsDialog(ui.rows, from = ui.journal ?: ui.rows.first().view.localId, to = null, onCopy = actions.onCopySettings) { copying = false }
    }
}

/**
 * Copy Settings… (A1137; PEN-148), as the Mac's panel: From and To (Every Other Notebook too, with
 * three or more), what it replaces, and Copy Settings, which replaces the other notebook's settings
 * with the first's, once. Quick Access stays as it is. [to] null starts on every other notebook.
 */
@Composable
internal fun CopySettingsDialog(rows: List<GitRow>, from: String, to: String?, onCopy: suspend (String, String?) -> String, onDismiss: () -> Unit) {
    var source by rememberSaveable { mutableStateOf(from) }
    var chosen by rememberSaveable { mutableStateOf(to) }
    var done by remember { mutableStateOf<String?>(null) }
    var copying by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val sourceRow = rows.firstOrNull { it.view.localId == source } ?: rows.first()
    val others = rows.filter { it.view.localId != sourceRow.view.localId }
    // Every other notebook, or one: the only other one when there is one, the first when the one
    // chosen became From.
    val target = if (chosen == null) others.singleOrNull() else others.firstOrNull { it.view.localId == chosen } ?: others.firstOrNull()
    val tracked = rememberTrackedDialog("copySettings")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Copy Settings") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Picker("From", sourceRow.view.name, rows.map { it.view.localId to it.view.name }, "gitCopyFrom", event = "settings.git-notebooks.copy-settings.from") {
                    source = it ?: source
                    done = null
                }
                val every = if (others.size > 1) listOf(null to "Every Other Notebook") else emptyList()
                Picker("To", target?.view?.name ?: "Every Other Notebook", every + others.map { it.view.localId to it.view.name }, "gitCopyTo", event = "settings.git-notebooks.copy-settings.to") {
                    chosen = it
                    done = null
                }
                Text(
                    "Replaces ${target?.let { "${it.view.name}’s" } ?: "their"} settings with ${sourceRow.view.name}’s: the theme, Home, shortcuts and the rest. Quick Access stays as it is.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                done?.let {
                    Text(it, Modifier.testTag("gitCopySettingsDone").semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = trackedClick("settings.git-notebooks.copy-settings.copy") {
                    tracked.done()
                    copying = true
                    scope.launch {
                        try {
                            done = onCopy(sourceRow.view.localId, target?.view?.localId)
                        } finally {
                            copying = false
                        }
                    }
                },
                enabled = others.isNotEmpty() && !copying,
                modifier = Modifier.testTag("gitCopySettings"),
            ) { Text(if (copying) "Copying…" else "Copy Settings") }
        },
        dismissButton = { TextButton(onClick = trackedClick("settings.git-notebooks.copy-settings.cancel", onDismiss), Modifier.testTag("gitCopySettingsClose")) { Text(if (done != null) "Done" else "Cancel") } },
    )
}

/** A choice in a dialog: its label, what is chosen, and a menu of the [options] (an id, null for every other, and a name). */
@Composable
private fun Picker(label: String, shown: String, options: List<Pair<String?, String>>, tag: String, event: String, onPick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        ListItem(
            headlineContent = { Text(label) },
            trailingContent = { Text("$shown ›", Modifier.testTag("$tag-shown"), color = MaterialTheme.colorScheme.onSurfaceVariant) },
            modifier = Modifier.testTag(tag).clickable(role = Role.Button, onClick = trackedClick(event) { open = true }),
        )
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((id, name) in options) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(name) },
                    onClick = trackedClick("settings.git-notebooks.copy-settings.pick") {
                        open = false
                        onPick(id)
                    },
                    modifier = Modifier.testTag("$tag-${id ?: "every"}"),
                )
            }
        }
    }
}

/** A notebook's row (PEN-146): its dot, its badge and name (Primary when it is), its repository and sync. */
@Composable
private fun NotebookRow(row: GitRow, primary: Boolean, modifier: Modifier = Modifier, event: String, onClick: () -> Unit) {
    val view = row.view
    ListItem(
        leadingContent = { Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { DotMarkOf(dotOf(row.status)) } },
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // Its badge before its name (A1579), as the Mac's sidebar and Settings show it.
                app.penmoss.ui.common.NotebookBadgeView(row.badge, view.name, decorative = true)
                Text(view.name)
                if (primary) PrimaryChip()
            }
        },
        supportingContent = {
            Text(
                view.repository + " · " + gitStatusLine(row.status, view.host),
                Modifier.testTag("gitStatus-${view.localId}").semantics { liveRegion = LiveRegionMode.Polite },
                color = if (row.status?.phase == "stopped") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        trailingContent = { Text("›", style = MaterialTheme.typography.titleMedium) },
        modifier = modifier.testTag("gitNotebook-${view.localId}").clickable(role = Role.Button, onClick = trackedClick(event, onClick)),
    )
}

/** The Primary chip (A1101), on the notebook's row and its page. */
@Composable
internal fun PrimaryChip() {
    Text(
        "Primary",
        Modifier.background(MaterialTheme.colorScheme.primaryContainer).padding(horizontal = 6.dp, vertical = 1.dp).testTag("primaryChip"),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onPrimaryContainer,
    )
}


/** What the first run says, with no git notebook on the phone (A1040). */
internal const val FIRST_RUN =
    "Penmoss keeps your notes in git notebooks. Add one from a private GitHub repository, or create one: point Add at an empty private repository and give the new notebook a name."

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
                if (notice.titles.isEmpty()) "Notes Not Brought Back" else "Notes Brought Back",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(notice.words(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
            Row {
                if (notice.unrecovered.isNotEmpty()) {
                    TextButton(onClick = trackedClick("settings.git-notebooks.recovered.save", onSave), Modifier.testTag("gitRecoveredSave")) { Text("Save Their Text") }
                }
                TextButton(onClick = trackedClick("settings.git-notebooks.recovered.dismiss", onDismiss), Modifier.testTag("gitRecoveredDismiss")) { Text("Got It") }
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
                    TextButton(onClick = trackedClick("settings.git-notebooks.withheld.keep") { onKeep(copy.noteId) }, Modifier.testTag("gitWithheldKeep-${copy.noteId}")) { Text("Keep and Sync") }
                    TextButton(onClick = trackedClick("settings.git-notebooks.withheld.delete") { onDelete(copy.noteId) }, Modifier.testTag("gitWithheldDelete-${copy.noteId}")) { Text("Delete for Good") }
                }
            }
            TextButton(onClick = trackedClick("settings.git-notebooks.withheld.save", onSave), Modifier.testTag("gitWithheldSave")) { Text("Save Their Text") }
        }
    }
}

/** Deletes for good waiting (A855): confirmed again only where this phone confirmed them once; Keep note for the rest. */
@Composable
internal fun Purges(row: GitRow, actions: GitNotebooksActions) {
    val id = row.view.localId
    val purges = row.purges
    LaunchedEffect(id, purges == null) { if (purges == null) actions.onShowPurges(id) }
    Text("Delete for Good, Waiting", style = MaterialTheme.typography.titleSmall)
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
                    TextButton(onClick = trackedClick("settings.git-notebooks.reconfirm.keep-note") { actions.onKeep(id, purge.id) }, Modifier.testTag("gitKeep-${purge.id}")) { Text("Keep Note") }
                    // Never confirmed here: Delete for good, behind the phone's own check, as on the Mac (A913).
                    if (!purge.confirmedBefore) {
                        TextButton(onClick = trackedClick("settings.git-notebooks.reconfirm.purge-note") { actions.onConfirmPurge(id, purge.id) }, Modifier.testTag("gitPurgeNote-${purge.id}")) { Text("Delete for Good") }
                    }
                }
            },
            modifier = Modifier.testTag("gitPurge-${purge.id}"),
        )
    }
    val again = purges.filter { it.confirmedBefore }.map { it.id }
    if (again.isNotEmpty()) {
        OutlinedButton(onClick = trackedClick("settings.git-notebooks.reconfirm.confirm") { actions.onConfirmPurges(id, again) }, Modifier.testTag("gitConfirmPurges-$id")) {
            // The button the refusal names ("Confirm Delete for good again in Settings → Git notebooks"), as on the Mac (A894).
            Text(if (again.size == 1) "Confirm Delete for Good Again" else "Confirm Delete for Good Again: ${again.size} notes")
        }
    }
}

/** Notes kept with Keep note while Settings is open (A913): each says so, with Undo. */
@Composable
internal fun Kept(row: GitRow, actions: GitNotebooksActions) {
    for (note in row.kept) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Kept ${OwnerWords.title(note.title) ?: "an untitled note"}.",
                Modifier.weight(1f).testTag("gitKept-${note.id}"),
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(onClick = trackedClick("settings.git-notebooks.reconfirm.undo-keep") { actions.onUndoKeep(row.view.localId, note.id) }, Modifier.testTag("gitKeepUndo-${note.id}")) { Text("Undo") }
        }
    }
}

@Composable
private fun AddForm(ui: GitNotebooksUi, actions: GitNotebooksActions, onCancel: (() -> Unit)?) {
    var remote by rememberSaveable { mutableStateOf("") }
    var branch by rememberSaveable { mutableStateOf("main") }
    var dir by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }
    val form = AddForm(remote.trim(), branch.trim(), dir.trim(), name.trim(), token.trim())
    GroupTitle("Add Notebook")
    Column(Modifier.padding(horizontal = 16.dp).testTag("gitAddForm"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Help(
            "A notebook keeps its notes in a private repository: Penmoss commits to it from this phone over HTTPS with a personal access token, " +
                "kept with the Android Keystore. Nothing of it leaves the phone but through git.",
            Modifier.padding(0.dp),
        )
        OutlinedTextField(remote, { remote = it }, Modifier.fillMaxWidth().testTag("gitAddRemote"), label = { Text("Repository (https://github.com/owner/repo)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(branch, { branch = it }, Modifier.weight(1f), label = { Text("Branch") }, singleLine = true)
            OutlinedTextField(dir, { dir = it }, Modifier.weight(1f), label = { Text("Directory (Optional)") }, singleLine = true)
        }
        OutlinedTextField(
            token,
            { token = it },
            Modifier.fillMaxWidth().testTag("gitAddToken"),
            label = { Text("Personal Access Token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        if (ui.needsName) {
            Help("This repository holds no notebook yet: give the new one a name.", Modifier.padding(0.dp))
            OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().testTag("gitAddName"), label = { Text("Notebook Name") }, singleLine = true)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = trackedClick("settings.git-notebooks.add.submit") { actions.onAdd(form) }, enabled = remote.isNotBlank() && ui.busy != "add", modifier = Modifier.testTag("gitAdd")) {
                Text(if (ui.busy == "add") "Checking…" else "Add")
            }
            if (onCancel != null) TextButton(onClick = trackedClick("settings.git-notebooks.add.cancel", onCancel), Modifier.testTag("gitAddCancel")) { Text("Cancel") }
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
internal fun NewSigningKey(
    type: app.penmoss.engine.git.CommitKeyType?,
    ui: GitNotebooksUi,
    onDismiss: () -> Unit,
    onConfirm: (app.penmoss.engine.git.CommitKeyType) -> Unit,
) {
    if (type == null) return
    val ed25519 = type == app.penmoss.engine.git.CommitKeyType.ED25519
    val kind = if (ed25519) "an Ed25519" else "a new P-256"
    val signing = ui.rows.filter { it.view.signCommits }.map { it.view.name }
    val who = when (signing.size) {
        0 -> "No notebook signs commits now; any you turn Sign commits on for uses it."
        1 -> "${signing.single()} signs with it from its next commit."
        else -> "${signing.dropLast(1).joinToString(", ")} and ${signing.last()} sign with it from their next commits."
    }
    val tracked = rememberTrackedDialog("confirm")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Make ${if (ed25519) "an Ed25519" else "a New P-256"} Signing Key?") },
        text = {
            Text(
                "This deletes this phone's signing key and makes $kind key in its place, for every git notebook on this phone. $who " +
                    "Its commits show Unverified on GitHub until you add its public key to GitHub as a signing key (Settings → SSH and GPG keys); remove the old key there afterwards. Nothing in the repositories changes.",
                Modifier.testTag("gitSigningKeyWords"),
            )
        },
        confirmButton = {
            TextButton(onClick = trackedClick("settings.git-notebooks.signing-key.new.confirm", tracked.done { onConfirm(type) }), Modifier.testTag("gitSigningKeyConfirm")) { Text("Make the Key") }
        },
        dismissButton = {
            TextButton(onClick = trackedClick("settings.git-notebooks.signing-key.new.cancel", onDismiss), Modifier.testTag("gitSigningKeyCancel")) { Text("Cancel") }
        },
    )
}

/**
 * Commits from This Phone (PEN-146): the name and email this phone commits as, and its signing key,
 * one row that opens in place. A notebook's own name and email are on its Git tab.
 */
@Composable
private fun CommitsFromThisPhone(ui: GitNotebooksUi, actions: GitNotebooksActions) {
    var open by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable(ui.identityName) { mutableStateOf(ui.identityName) }
    var email by rememberSaveable(ui.identityEmail) { mutableStateOf(ui.identityEmail) }
    GroupTitle("Commits from This Phone", Modifier.settingRow("commits-from-this-phone"))
    ListItem(
        headlineContent = { Text(ui.identityName.ifBlank { "No Name Set" }) },
        supportingContent = {
            Text(listOfNotNull(ui.identityEmail.ifBlank { null }, if (ui.signingKey != null) "signing key on this phone" else null).joinToString(" · ").ifEmpty { "Name and email for your commits" })
        },
        trailingContent = { Text(if (open) "⌃" else "›", style = MaterialTheme.typography.titleMedium) },
        modifier = Modifier.testTag("gitCommits").clickable(role = Role.Button, onClick = trackedClick("settings.git-notebooks.commits.toggle") { open = !open }),
    )
    if (!open) return
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().testTag("gitIdentityName"), label = { Text("Name") }, singleLine = true)
        OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth().testTag("gitIdentityEmail"), label = { Text("Email") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        if (name != ui.identityName || email != ui.identityEmail) {
            TextButton(onClick = trackedClick("settings.git-notebooks.identity.save") { actions.onIdentity(name, email) }, Modifier.testTag("gitIdentitySave")) { Text("Save") }
        }
        SigningKey(ui, actions)
    }
}

/** This phone's signing key (#172, A921), with Copy and Make a New Key; nothing until one is made. */
@Composable
internal fun SigningKey(ui: GitNotebooksUi, actions: GitNotebooksActions) {
    val key = ui.signingKey ?: return
    /** The kind of key a tap on Make… asks to make, while its confirmation shows. */
    var making by remember { mutableStateOf<app.penmoss.engine.git.CommitKeyType?>(null) }
    NewSigningKey(making, ui, onDismiss = { making = null }) { type ->
        making = null
        actions.onNewSigningKey(type)
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Signing Key", style = MaterialTheme.typography.titleSmall)
        Text(
            "Made in this phone's Keystore; it never leaves the phone. Add it to GitHub as a signing key (Settings → SSH and GPG keys → New SSH key, Key type: Signing Key), with your commit email verified on your account, so its commits show Verified.",
            style = MaterialTheme.typography.bodySmall,
        )
        Text(key, Modifier.fillMaxWidth().testTag("gitSigningKey"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = trackedClick("settings.git-notebooks.signing-key.copy") { actions.onCopySigningKey(key) }, Modifier.testTag("gitSigningKeyCopy")) { Text("Copy") }
            TextButton(onClick = trackedClick("settings.git-notebooks.signing-key.new") { making = app.penmoss.engine.git.CommitKeyType.P256 }, Modifier.testTag("gitSigningKeyNew")) { Text("Make a New Key") }
            TextButton(onClick = trackedClick("settings.git-notebooks.signing-key.new-ed25519") { making = app.penmoss.engine.git.CommitKeyType.ED25519 }, Modifier.testTag("gitSigningKeyNewEd25519")) { Text("Make an Ed25519 Key") }
        }
        Text(
            "Make a New Key is P-256, which every phone's Keystore has; Ed25519 works where this phone's Keystore has it, and your key stays as it is where it does not.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}


/**
 * The notebooks' state and actions over the hub (T50 G7; PEN-146), shared by All Notebooks, the
 * app's home and a notebook's page. [onOpen] opens a notebook's screens.
 */
@Composable
internal fun rememberGitNotebooks(
    hub: GitNotebookHub,
    onOpen: (String) -> Unit,
    home: Boolean = false,
    onPage: (String) -> Unit = {},
    copyTags: Boolean? = null,
    onCopyTags: (Boolean) -> Unit = {},
): Pair<GitNotebooksUi, GitNotebooksActions> {
    val views by hub.list.collectAsStateWithLifecycle()
    val inStep by hub.settingsInStep.collectAsStateWithLifecycle()
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
    val badges by hub.badges.collectAsStateWithLifecycle(emptyMap())
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
        rows = views.map { view ->
            val row = GitRow(view, shownStatuses[view.localId], purges[view.localId], recoveries[view.localId], kept[view.localId], oldCopies[view.localId], withheld[view.localId].orEmpty(), keptNotes[view.localId].orEmpty())
            badges[view.localId]?.let { row.copy(badge = it) } ?: row
        },
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
        copyTags = copyTags,
        inStep = inStep,
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
        onShowPurges = { id -> scope.launch { purges[id] = app.penmoss.engine.attempt { hub.purgesToConfirm(id) }.getOrDefault(emptyList()) } },
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
        aiSetting = { id -> runCatching { hub.graph(id).api.aiSetting(null) }.getOrNull() },
        onAiSetting = { id, value -> runCatching { hub.graph(id).api.setAiSetting(null, value) }.getOrNull() },
        onDescribeAll = { id -> runCatching { hub.graph(id).api.describeAll(null) }.getOrNull() },
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
        onCopyTags = onCopyTags,
        onPage = onPage,
        onInStep = hub::setSettingsInStep,
        onBadge = { id, key, value -> runCatching { hub.setBadge(id, key, value) }.onFailure { message = it.message } },
        onCopySettings = { from, to ->
            fun name(id: String) = views.firstOrNull { it.localId == id }?.name ?: "the notebook"
            try {
                copiedWords(name(from), to?.let(::name), hub.copySettings(from, to))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                error.message ?: "Penmoss could not copy the settings."
            }
        },
    )
    return ui to actions
}

/**
 * Settings → All Notebooks, over the hub (T50 G7; PEN-146), and the app's home ([home], A1040)
 * with Settings in its bar ([onSettings]). A row opens the notebook's page ([onPage]), or on the
 * home the notebook itself ([onOpen]).
 */
@Composable
fun GitNotebooksRoute(
    hub: GitNotebookHub,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
    /** The app's home (A1040), not Settings. */
    home: Boolean = false,
    onSettings: (() -> Unit)? = null,
    onPage: (String) -> Unit = {},
    copyTags: Boolean? = null,
    onCopyTags: (Boolean) -> Unit = {},
    onAddNotebook: (() -> Unit)? = null,
) {
    val (ui, actions) = rememberGitNotebooks(hub, onOpen, home, onPage, copyTags, onCopyTags)
    GitNotebooksScreen(ui, actions, onBack, onSettings, onAddNotebook)
}

/** A notebook's page in Settings (PEN-146), over the hub: [tab] is overview, sync or git. */
@Composable
fun NotebookPageRoute(
    hub: GitNotebookHub,
    localId: String,
    tab: String?,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
    /** The notebook's own Room sync, when its screens are the ones Settings opened over. */
    passText: String? = null,
) {
    val (ui, actions) = rememberGitNotebooks(hub, onOpen)
    // Its settings read and a change sent at once while the page shows (its badge, A1579), as the
    // primary's are (rememberPrimary); its own screens, when open, sync it already.
    androidx.compose.runtime.DisposableEffect(localId) {
        val release = runCatching { hub.graph(localId).sync.watch() }.getOrNull()
        onDispose { release?.invoke() }
    }
    // Removed: nothing to show, so the page goes.
    val row = ui.rows.firstOrNull { it.view.localId == localId }
    LaunchedEffect(row == null, ui.rows.isEmpty()) { if (row == null && hub.list.value.none { it.localId == localId }) onBack() }
    // Its notes on this phone (PEN-148), counted again every few seconds while shown.
    var notes by remember(localId) { mutableStateOf<Int?>(null) }
    LaunchedEffect(localId) {
        while (true) {
            notes = hub.noteCount(localId)
            delay(5_000)
        }
    }
    if (row == null) return
    NotebookPage(row, ui, actions, tab ?: NotebookTab.OVERVIEW, onBack, passText = passText, notes = notes)
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
