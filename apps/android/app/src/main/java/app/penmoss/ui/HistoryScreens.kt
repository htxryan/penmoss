package app.penmoss.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScaffoldDefaults
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.engine.api.HistoryAuthor
import app.penmoss.engine.api.NoteVersion
import app.penmoss.ui.settings.SettingsIcons

/**
 * Version history (T40 P3b, NT16–NT20): the note's versions with time, author chip and summary;
 * one version's diff, restore with confirm, revert of an agent's change, and save-a-version.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(
    ui: HistoryUi,
    onSelect: (Long) -> Unit,
    onToggleWhole: (Boolean) -> Unit,
    onAskRestore: (Long) -> Unit,
    onDismissConfirm: () -> Unit,
    onRestore: (Long) -> Unit,
    onRevert: (Long) -> Unit,
    onSaveNow: () -> Unit,
    onMessageShown: () -> Unit,
    onConflictsDismissed: () -> Unit,
    onRefresh: () -> Unit,
    onBack: () -> Unit,
    /** In the note panel's Version History tab (T51, A936): the panel's tabs stand for the top bar. */
    embedded: Boolean = false,
) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(ui.message) {
        val message = ui.message ?: return@LaunchedEffect
        snackbar.showSnackbar(message)
        onMessageShown()
    }
    val version = ui.history?.versions?.firstOrNull { it.id == ui.selected }
    Scaffold(
        topBar = {
            if (!embedded) {
                TopAppBar(
                    title = { Text("Version History") },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                )
            }
        },
        snackbarHost = { SnackbarHost(snackbar) { PenmossSnackbar(it) } },
        contentWindowInsets = if (embedded) WindowInsets(0) else ScaffoldDefaults.contentWindowInsets,
    ) { padding ->
        PullToRefreshBox(isRefreshing = ui.loading, onRefresh = onRefresh, modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(Modifier.fillMaxSize().testTag("historyList"), contentPadding = PaddingValues(bottom = 24.dp)) {
                // How versions are kept, under the title; saving one by hand is the quiet extra (A574, A654).
                item(key = "explained") {
                    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 4.dp)) {
                        Text(
                            VERSIONS_EXPLAINED,
                            Modifier.testTag("historyExplained"),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(
                            onClick = onSaveNow,
                            enabled = !ui.busy && ui.history != null,
                            modifier = Modifier.testTag("saveVersion"),
                        ) {
                            Text("Save a Version Now")
                        }
                    }
                    HorizontalDivider()
                }
                ui.problem?.let { problem ->
                    item {
                        Text(
                            problem,
                            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("historyProblem"),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                val history = ui.history
                if (history == null && !ui.loading) {
                    item { EmptyMessage("No versions yet.", Modifier.testTag("historyEmpty")) }
                }
                history?.unversioned?.let { unversioned ->
                    item {
                        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp)) {
                            Text("Now", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                            AuthorChips(unversioned.authors)
                            Text(
                                "Not saved as a version yet",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        HorizontalDivider()
                    }
                }
                history?.versions?.forEach { entry ->
                    item(key = "v${entry.id}") {
                        VersionRow(
                            entry = entry,
                            selected = entry.id == ui.selected,
                            onSelect = { onSelect(entry.id) },
                        )
                        HorizontalDivider()
                    }
                }
                if (history != null && history.versions.isEmpty() && history.unversioned == null && !ui.loading) {
                    item { EmptyMessage("No versions yet.", Modifier.testTag("historyEmpty")) }
                }
                if (version != null) {
                    item(key = "detail") {
                        HistoryDetail(
                            ui = ui,
                            version = version,
                            onToggleWhole = onToggleWhole,
                            onAskRestore = { onAskRestore(version.id) },
                            onRevert = { onRevert(version.id) },
                        )
                    }
                } else if (ui.message != null) {
                    item {
                        Text(
                            ui.message,
                            Modifier.padding(16.dp).testTag("historyStatus"),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }
    ui.confirming?.let { confirming ->
        val whenOf = ui.history?.versions?.firstOrNull { it.id == confirming }?.createdAt?.takeIf { it > 0 }
        AlertDialog(
            onDismissRequest = onDismissConfirm,
            title = { Text("Restore this version?") },
            text = { Text("The note goes back to how it was ${shortWhen(whenOf)}, as a new change. Edits made since stay in a version of their own.") },
            confirmButton = {
                TextButton(onClick = { onRestore(confirming) }, modifier = Modifier.testTag("confirmRestore")) { Text("Restore") }
            },
            dismissButton = { TextButton(onClick = onDismissConfirm) { Text("Cancel") } },
        )
    }
    if (ui.conflicts.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = onConflictsDismissed,
            title = { Text("Some changes overlapped") },
            text = {
                Column {
                    Text("Reverted what did not overlap later edits. What changed again since is kept:")
                    ui.conflicts.forEach { conflict ->
                        Text(
                            (if (conflict.part == "title") "Title now: " else "Text now: ") + (conflict.ours.joinToString("\n").ifBlank { "(empty)" }),
                            Modifier.padding(top = 8.dp).testTag("historyConflicts"),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text(
                            "Before the edit: " + (conflict.theirs.joinToString("\n").ifBlank { "(empty)" }),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            confirmButton = { TextButton(onClick = onConflictsDismissed) { Text("OK") } },
        )
    }
}

@Composable
private fun VersionRow(entry: NoteVersion, selected: Boolean, onSelect: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onSelect)
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface)
            .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp).testTag("history-${entry.id}"),
    ) {
        Text(
            shortWhen(entry.createdAt.takeIf { it > 0 }),
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        AuthorChips(entry.authors)
        val line = versionLine(entry)
        if (line.isNotBlank()) {
            Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AuthorChips(authors: List<HistoryAuthor>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        authors.forEach { author ->
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(
                    if (author.kind == "agent") SettingsIcons.Spark else SettingsIcons.Monitor,
                    contentDescription = if (author.kind == "agent") "Agent" else "Device",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    author.label.ifBlank { if (author.kind == "agent") "Agent" else "Device" },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun HistoryDetail(
    ui: HistoryUi,
    version: NoteVersion,
    onToggleWhole: (Boolean) -> Unit,
    onAskRestore: () -> Unit,
    onRevert: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(16.dp).testTag("historyDetail")) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onAskRestore, enabled = !ui.busy, modifier = Modifier.testTag("restoreVersion")) {
                Text("Restore This Version")
            }
            // Not on an agent's move to Trash or its restore: Trash undoes those (N7, A654).
            if (revertible(version)) {
                TextButton(onClick = onRevert, enabled = !ui.busy, modifier = Modifier.testTag("revertVersion")) {
                    // The web's name, as its messages say (Reverted…) (T39 pass 3, A896).
                    Text("Revert This Edit")
                }
            }
        }
        ui.message?.let { message ->
            Text(message, Modifier.testTag("historyStatus"), style = MaterialTheme.typography.bodyMedium)
        }
        ui.detailError?.let { error ->
            Text(error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }
        if (ui.detailLoading) {
            Text("Loading version…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val detail = ui.detail?.takeIf { it.id == version.id }
        if (detail != null) {
            TextButton(
                onClick = { onToggleWhole(!ui.showWhole) },
                modifier = Modifier.testTag("historyToggleWhole"),
            ) {
                Text(if (ui.showWhole) "Show Changes" else "Show Whole Version")
            }
            if (ui.showWhole) {
                Text(
                    detail.markdown.ifBlank { "(empty)" },
                    Modifier.testTag("historyWhole"),
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                )
            } else {
                Column(Modifier.testTag("historyDiff")) {
                    Text(
                        if (detail.previousId == null) "The first version" else "Changes since the version before",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    diffRows(detail.diff).forEach { row ->
                        when (row) {
                            is DiffRow.Fold -> Text(
                                "⋯ ${row.count} unchanged ${if (row.count == 1) "line" else "lines"}",
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            is DiffRow.Line -> DiffLine(row)
                        }
                    }
                }
            }
        }
    }
}

/**
 * One diff line in monospace, wrapping long lines; added and removed lines tinted by theme
 * tokens (NT17).
 */
@Composable
private fun DiffLine(row: DiffRow.Line) {
    val (container, content) = when (row.op) {
        "add" -> MaterialTheme.colorScheme.tertiaryContainer to MaterialTheme.colorScheme.onTertiaryContainer
        "del" -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        else -> MaterialTheme.colorScheme.surface to MaterialTheme.colorScheme.onSurface
    }
    val sign = when (row.op) {
        "add" -> "+"
        "del" -> "−"
        else -> " "
    }
    Text(
        sign + row.line,
        Modifier.fillMaxWidth().background(container).padding(horizontal = 4.dp, vertical = 1.dp),
        color = content,
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
    )
}
