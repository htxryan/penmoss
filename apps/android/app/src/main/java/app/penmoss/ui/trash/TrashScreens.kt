package app.penmoss.ui.trash

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.SheetAction
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.ui.common.EmptyMessage
import app.penmoss.ui.common.FolderIcon
import app.penmoss.ui.common.PenmossSnackbar
import app.penmoss.ui.common.BackButton
import app.penmoss.ui.common.ConfirmDialog
import app.penmoss.ui.common.SheetTitle
import app.penmoss.ui.common.SectionTitle

/** One note in Trash as the screen shows it (NT13). */
data class TrashEntryUi(
    val id: String,
    val title: String,
    /** When it was deleted, and when it goes for good; or that its move is not sent yet. */
    val detail: String,
    val deletedAt: Long,
    /** Moved to Trash on this phone and not sent yet: Restore cancels it; it cannot be deleted for good yet. */
    val waiting: Boolean,
    /** [detail] as TalkBack says it: "(agent)" where the row shows ✦ (#137, A701). */
    val spoken: String = detail,
)

/** One deleted folder in Trash as the screen shows it (T40 P9, NT25); [spoken] as [TrashEntryUi.spoken]. */
data class TrashFolderUi(val id: String, val name: String, val detail: String, val spoken: String = detail)

/** Trash's folders: the server's list, a Restore under way, and what the last one said. */
data class TrashFoldersUi(
    val folders: List<TrashFolderUi> = emptyList(),
    val busy: Boolean = false,
    val message: String? = null,
)

data class TrashUi(
    val entries: List<TrashEntryUi> = emptyList(),
    val loading: Boolean = false,
    /** Offline, or the server's list could not be read: the phone's rows alone. */
    val problem: String? = null,
    val message: String? = null,
    /** The note a restore just brought back, for the message's Open. */
    val restored: String? = null,
    /** A delete for good under way. */
    val busy: Boolean = false,
)

/**
 * Trash (T40 P3a, NT13–NT15): notes deleted on any device in the last 30 days, newest first,
 * each with when it goes for good, **Restore**, and **Delete for good** (a confirm, then the
 * phone's own check). Deleted folders come first, as on the web (T40 P9, NT25, A560), each with
 * **Restore**, which brings back its subfolders and notes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(
    ui: TrashUi,
    onRestore: (TrashEntryUi) -> Unit,
    onDeleteForGood: (TrashEntryUi) -> Unit,
    onOpen: (String) -> Unit,
    onMessageShown: () -> Unit,
    onRefresh: () -> Unit,
    onBack: () -> Unit,
    folders: TrashFoldersUi = TrashFoldersUi(),
    onRestoreFolder: (TrashFolderUi) -> Unit = {},
    onFolderMessageShown: () -> Unit = {},
) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(folders.message) {
        val message = folders.message ?: return@LaunchedEffect
        snackbar.showSnackbar(message, duration = SnackbarDuration.Long)
        onFolderMessageShown()
    }
    var confirming by remember { mutableStateOf<TrashEntryUi?>(null) }
    LaunchedEffect(ui.message) {
        val message = ui.message ?: return@LaunchedEffect
        val restored = ui.restored
        // Cleared once it has been shown, not before: clearing it changes this effect's key,
        // which would cancel the message as it appears. A newer message replaces it.
        val shown = snackbar.showSnackbar(message, actionLabel = if (restored != null) "Open" else null, duration = SnackbarDuration.Long)
        onMessageShown()
        if (shown == SnackbarResult.ActionPerformed && restored != null) onOpen(restored)
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Trash") },
                navigationIcon = { BackButton(onBack) },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) { PenmossSnackbar(it) } },
    ) { padding ->
        PullToRefreshBox(isRefreshing = ui.loading, onRefresh = trackedClick("trash.pull-to-refresh", onRefresh), modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(Modifier.fillMaxSize().testTag("trashList"), contentPadding = PaddingValues(bottom = 24.dp)) {
                item {
                    Text(
                        "Notes and folders moved to Trash on any device stay here for 30 days, then go for good.",
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                ui.problem?.let { problem ->
                    item {
                        Text(
                            problem,
                            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("trashProblem"),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                if (ui.entries.isEmpty() && folders.folders.isEmpty() && !ui.loading) {
                    item { EmptyMessage("Trash is empty. Nothing has been deleted lately.", Modifier.testTag("trashEmpty")) }
                }
                if (folders.folders.isNotEmpty()) {
                    item { SectionTitle("Folders") }
                    items(folders.folders, key = { "folder-${it.id}" }) { folder ->
                        TrashFolderRow(folder, enabled = !folders.busy, onRestore = { onRestoreFolder(folder) })
                        HorizontalDivider()
                    }
                    if (ui.entries.isNotEmpty()) item { SectionTitle("Notes") }
                }
                items(ui.entries, key = { it.id }) { entry ->
                    TrashRowView(entry, enabled = !ui.busy, onRestore = { onRestore(entry) }, onDelete = { confirming = entry })
                    HorizontalDivider()
                }
            }
        }
    }
    confirming?.let { entry ->
        ConfirmDialog(
            title = "Delete “${entry.title}” for Good?",
            body = "It can’t be restored on this phone or any other device. You’ll be asked for your fingerprint, face or screen lock.",
            confirmLabel = "Delete for Good",
            confirmEvent = "trash.delete-for-good.confirm",
            cancelEvent = "trash.delete-for-good.cancel",
            onConfirm = {
                confirming = null
                onDeleteForGood(entry)
            },
            onDismiss = { confirming = null },
            destructive = true,
            confirmTag = "confirmDeleteForGood",
        )
    }
}

@Composable
private fun TrashFolderRow(folder: TrashFolderUi, enabled: Boolean, onRestore: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 4.dp).testTag("trashFolder-${folder.id}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(FolderIcon, contentDescription = null, Modifier.padding(end = 8.dp).size(20.dp), tint = MaterialTheme.colorScheme.primary)
            Text(folder.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(folder.detail, spokenAs(folder.detail, folder.spoken), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(
                onClick = trackedClick("trash.folder.restore", onRestore),
                enabled = enabled,
                // Said with the folder's name, as the web's button (several rows say Restore).
                modifier = Modifier.testTag("restoreFolder-${folder.id}").semantics { contentDescription = "Restore the folder ${folder.name}" },
            ) { Text("Restore") }
        }
    }
}

@Composable
private fun TrashRowView(entry: TrashEntryUi, enabled: Boolean, onRestore: () -> Unit, onDelete: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 4.dp).testTag("trash-${entry.id}")) {
        Text(entry.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(entry.detail, spokenAs(entry.detail, entry.spoken), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = trackedClick("trash.restore", onRestore), enabled = enabled, modifier = Modifier.testTag("restore-${entry.id}")) { Text("Restore") }
            TextButton(
                onClick = trackedClick("trash.delete-for-good", onDelete),
                enabled = enabled && !entry.waiting,
                modifier = Modifier.testTag("deleteForGood-${entry.id}"),
            ) { Text("Delete for Good") }
        }
    }
}

/**
 * What a long press on a note in a list offers (T40 P3a, NT10, NT12): Move to folder… first, as
 * the long press did before, then Rename, then Move to Trash.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteActionsSheet(
    title: String,
    onRename: () -> Unit,
    onMove: () -> Unit,
    onTrash: () -> Unit,
    onDismiss: () -> Unit,
    /** Copy Agent Reference (T52 item 4), after Rename; none offered when null. */
    onCopyAgentReference: (() -> Unit)? = null,
    /** A new note or folder beside the note, in its folder (T53 item 12), first; none when null. */
    onNewNoteHere: (() -> Unit)? = null,
    onNewFolderHere: (() -> Unit)? = null,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val tracked = rememberTrackedDialog("noteMenu")
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        SheetTitle(titleOf(title))
        Box(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Column(Modifier.fillMaxWidth()) {
                onNewNoteHere?.let { SheetAction("New Note Here", "noteAction-newNote", event = "tree.note-menu.new-note", tracked.done(it)) }
                onNewFolderHere?.let { SheetAction("New Folder Here", "noteAction-newFolder", event = "tree.note-menu.new-folder", tracked.done(it)) }
                SheetAction("Move to Folder…", "noteAction-move", event = "tree.note-menu.move", tracked.done(onMove))
                SheetAction("Rename", "noteAction-rename", event = "tree.note-menu.rename", tracked.done(onRename))
                onCopyAgentReference?.let { SheetAction("Copy Agent Reference", "noteAction-copyAgentReference", event = "tree.note-menu.copy-agent-reference", tracked.done(it)) }
                SheetAction("Move to Trash", "noteAction-trash", event = "tree.note-menu.trash", tracked.done(onTrash))
            }
        }
    }
}

/** A row's detail read out as [spoken] where it differs from what the row shows (A701). */
private fun spokenAs(shown: String, spoken: String): Modifier =
    if (spoken == shown) Modifier else Modifier.semantics { contentDescription = spoken }
