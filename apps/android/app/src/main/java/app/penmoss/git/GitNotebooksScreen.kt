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
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.semantics.Role
import app.penmoss.ui.common.DotState
import app.penmoss.ui.common.roles
import app.penmoss.ui.settings.DotMarkOf
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.engine.git.GitEngineStatus
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.engine.git.PendingPurge
import app.penmoss.ui.settings.ChoiceRow
import app.penmoss.ui.settings.DeviceOnlyHeadline
import app.penmoss.ui.settings.GroupTitle
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen
import app.penmoss.ui.settings.settingRow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import app.penmoss.ui.common.Toggle
import app.penmoss.ui.common.rememberNow
import app.penmoss.ui.common.timeAgo

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
 * A notebook's sync as its row says it (A859): synced and how long ago ("Synced 2 min ago", as the
 * Mac's row says it, [timeAgo]), waiting for the host once a sync
 * has run a while (never "Syncing…" for ever), offline and when it tries again, or why it stopped.
 */
fun gitStatusLine(status: GitEngineStatus?, host: String, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    if (status == null) return "Opens when you open the notebook, or at the next background run."
    val pending = status.pending.size
    val waiting = if (pending == 0) "" else " · ${if (pending == 1) "1 change" else "$pending changes"} not pushed"
    return when (status.phase) {
        "synced" -> (status.lastSyncAt?.let { "Synced ${timeAgo(it, now, zone)}" } ?: "Synced") + waiting
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
 * Between Notebooks (the Primary Notebook first), Commit Identity and the background runs. It is
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
        // The app's home is not a Settings screen: no (i) there, and its scrolling is no Settings page's.
        info = !ui.home,
        scrollArea = if (ui.home) null else "settings",
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
                style = MaterialTheme.roles.body,
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
        CommitIdentity(ui, actions)
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
        Toggle(
            "Keep Settings in Step",
            "A change to ${primary.view.name}’s settings goes to the other notebooks",
            ui.inStep,
            enabled = true,
            "gitSettingsInStep",
            Modifier.settingRow("keep-settings-in-step"),
            event = "settings.git-notebooks.in-step",
            headline = { DeviceOnlyHeadline(it) },
            onChange = actions.onInStep,
        )
    }
    if (ui.copyTags != null) {
        Toggle(
            "Copy Tags When Copying Notes",
            "Copy to Notebook on the Mac starts with this; it syncs from here.",
            ui.copyTags,
            enabled = true,
            "gitCopyTags",
            Modifier.settingRow("copy-tags-when-copying-notes"),
            event = "settings.git-notebooks.copy-tags",
            onChange = actions.onCopyTags,
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
                    style = MaterialTheme.roles.body,
                )
                done?.let {
                    Text(it, Modifier.testTag("gitCopySettingsDone").semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.roles.body)
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
                view.repository + " · " + gitStatusLine(row.status, view.host, rememberNow()),
                Modifier.testTag("gitStatus-${view.localId}").semantics { if (row.status?.phase != "synced") liveRegion = LiveRegionMode.Polite },
                color = if (row.status?.phase == "stopped") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        trailingContent = { Text("›", style = MaterialTheme.roles.rowLabel) },
        modifier = modifier.testTag("gitNotebook-${view.localId}").clickable(role = Role.Button, onClick = trackedClick(event, onClick)),
    )
}

/** The Primary chip (A1101), on the notebook's row and its page. */
@Composable
internal fun PrimaryChip() {
    Text(
        "Primary",
        Modifier.background(MaterialTheme.colorScheme.primaryContainer).padding(horizontal = 6.dp, vertical = 1.dp).testTag("primaryChip"),
        style = MaterialTheme.roles.badge,
        color = MaterialTheme.colorScheme.onPrimaryContainer,
    )
}

/** What the first run says, with no git notebook on the phone (A1040). */
internal const val FIRST_RUN =
    "Penmoss keeps your notes in git notebooks. Add one from a private GitHub repository, or create one: point Add at an empty private repository and give the new notebook a name."

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
