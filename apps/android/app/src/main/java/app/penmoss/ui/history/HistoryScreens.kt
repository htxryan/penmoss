package app.penmoss.ui.history

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScaffoldDefaults
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.engine.api.HistoryAuthor
import app.penmoss.engine.api.NoteVersion
import app.penmoss.engine.api.VersionDetail
import app.penmoss.ui.common.Button
import app.penmoss.ui.common.EmptyMessage
import app.penmoss.ui.common.IconButton
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.OutlinedButton
import app.penmoss.ui.common.PenmossSnackbar
import app.penmoss.ui.common.TextButton
import app.penmoss.ui.common.rememberLucideIcons
import app.penmoss.ui.common.roles
import app.penmoss.ui.common.shortWhen
import app.penmoss.ui.settings.SettingsIcons
import kotlinx.coroutines.launch

/**
 * Version history (T40 P3b, NT16–NT20), laid out as the Mac's (Ryan's Android feedback, 15 Nov
 * 2026, item 9; A1606), master → detail for the phone: the list is the Mac's "List over a Docked
 * Preview" without the preview. A Now row with Save Version and ⓘ (how versions are made), then
 * the versions by day as one-line rows (who, when, what, +/− lines). Tapping one opens its own
 * screen: when and who, the numbered diff (or the whole version), and Restore, Revert and Copy
 * in one row at the foot. Back returns to the list.
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
    val scope = rememberCoroutineScope()
    LaunchedEffect(ui.message) {
        val message = ui.message ?: return@LaunchedEffect
        snackbar.showSnackbar(message)
        onMessageShown()
    }
    /** The version's own screen is open (the detail of master → detail). */
    var open by rememberSaveable { mutableStateOf(false) }
    val version = ui.history?.versions?.firstOrNull { it.id == ui.selected }
    val detailShown = open && version != null
    BackHandler(enabled = detailShown) { open = false }
    val clipboard = LocalClipboardManager.current
    Scaffold(
        topBar = {
            if (!embedded) {
                TopAppBar(
                    title = { Text("Version History") },
                    navigationIcon = {
                        IconButton(onClick = trackedClick("nav.back") { if (detailShown) open = false else onBack() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    },
                )
            }
        },
        snackbarHost = { SnackbarHost(snackbar) { PenmossSnackbar(it) } },
        contentWindowInsets = if (embedded) WindowInsets(0) else ScaffoldDefaults.contentWindowInsets,
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (detailShown && version != null) {
                VersionScreen(
                    ui = ui,
                    version = version,
                    onBack = { open = false },
                    onToggleWhole = onToggleWhole,
                    onAskRestore = { onAskRestore(version.id) },
                    onRevert = { onRevert(version.id) },
                    onCopy = { detail ->
                        clipboard.setText(AnnotatedString(bodyOf(detail.markdown)))
                        scope.launch { snackbar.showSnackbar("Copied the text of this version.") }
                    },
                )
            } else {
                VersionList(
                    ui = ui,
                    onOpen = { id ->
                        if (id != ui.selected || ui.detail?.id != id) onSelect(id)
                        open = true
                    },
                    onSaveNow = onSaveNow,
                    onRefresh = onRefresh,
                )
            }
        }
    }
    ui.confirming?.let { confirming ->
        val whenOf = ui.history?.versions?.firstOrNull { it.id == confirming }?.createdAt?.takeIf { it > 0 }
        val tracked = rememberTrackedDialog("confirm")
        AlertDialog(
            onDismissRequest = onDismissConfirm,
            title = { Text("Restore This Version?") },
            text = { Text("The note goes back to how it was ${shortWhen(whenOf)}, as a new change. Edits made since stay in a version of their own.") },
            confirmButton = {
                TextButton(onClick = trackedClick("history.restore.confirm", tracked.done { onRestore(confirming) }), modifier = Modifier.testTag("confirmRestore")) { Text("Restore") }
            },
            dismissButton = { TextButton(onClick = trackedClick("history.restore.cancel", onDismissConfirm)) { Text("Cancel") } },
        )
    }
    if (ui.conflicts.isNotEmpty()) {
        val tracked = rememberTrackedDialog("revertConflicts")
        AlertDialog(
            onDismissRequest = onConflictsDismissed,
            title = { Text("Some Changes Overlapped") },
            text = {
                Column {
                    Text("Reverted what did not overlap later edits. What changed again since is kept:")
                    ui.conflicts.forEach { conflict ->
                        Text(
                            (if (conflict.part == "title") "Title now: " else "Text now: ") + (conflict.ours.joinToString("\n").ifBlank { "(empty)" }),
                            Modifier.padding(top = 8.dp).testTag("historyConflicts"),
                            style = MaterialTheme.roles.help,
                        )
                        Text(
                            "Before the edit: " + (conflict.theirs.joinToString("\n").ifBlank { "(empty)" }),
                            style = MaterialTheme.roles.help,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            confirmButton = { TextButton(onClick = trackedClick("history.conflicts.ok", tracked.done(onConflictsDismissed))) { Text("OK") } },
        )
    }
}

/** The master: the Now row, then the versions by day, one line each. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VersionList(ui: HistoryUi, onOpen: (Long) -> Unit, onSaveNow: () -> Unit, onRefresh: () -> Unit) {
    var about by rememberSaveable { mutableStateOf(false) }
    val history = ui.history
    val days = remember(history) { versionDays(history?.versions.orEmpty()) }
    PullToRefreshBox(isRefreshing = ui.loading, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().testTag("historyList"), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
            item(key = "now") {
                HorizontalDivider()
                NowRow(ui, about = about, onAbout = { about = !about }, onSaveNow = onSaveNow)
                // How versions are made: the Mac's ⓘ, opened under the Now row (A79, A574).
                if (about) {
                    Text(
                        VERSIONS_EXPLAINED,
                        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp).testTag("historyExplained"),
                        style = MaterialTheme.roles.help,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                HorizontalDivider()
            }
            ui.problem?.let { problem ->
                item(key = "problem") {
                    Text(
                        problem,
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("historyProblem"),
                        style = MaterialTheme.roles.help,
                    )
                }
            }
            for (day in days) {
                item(key = "day-${day.key}") {
                    Text(
                        day.label.uppercase(),
                        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp).semantics { heading() },
                        style = MaterialTheme.roles.listHead,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                items(day.versions, key = { "v${it.id}" }) { entry ->
                    VersionRow(entry, selected = entry.id == ui.selected, onOpen = { onOpen(entry.id) })
                }
            }
            if ((history == null || history.versions.isEmpty()) && !ui.loading) {
                item(key = "empty") { EmptyMessage("No versions yet.", Modifier.testTag("historyEmpty")) }
            }
        }
    }
}

/** Now: whether the note has changes not in a version yet, Save Version, and ⓘ (finding 13). */
@Composable
private fun NowRow(ui: HistoryUi, about: Boolean, onAbout: () -> Unit, onSaveNow: () -> Unit) {
    val pending = ui.history?.unversioned
    Row(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).padding(start = 16.dp, end = 4.dp).testTag("historyNow"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        WhoMark(pending?.authors.orEmpty())
        Text("Now", style = MaterialTheme.roles.rowLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            if (pending != null) "Not saved as a version yet" else "Synced",
            Modifier.weight(1f),
            style = MaterialTheme.roles.body,
            color = if (pending != null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        TextButton(
            onClick = trackedClick("history.save-version", onSaveNow),
            enabled = !ui.busy && ui.history != null,
            modifier = Modifier.testTag("saveVersion"),
            contentPadding = PaddingValues(horizontal = 8.dp),
        ) {
            Glyph("save", null, 18)
            Spacer(Modifier.width(6.dp))
            Text("Save Version", maxLines = 1, softWrap = false)
        }
        IconButton(onClick = trackedClick("history.about", onAbout), modifier = Modifier.testTag("historyAbout").semantics { selected = about }) {
            Glyph("info", "About Versions", 20)
        }
    }
}

/** One version, one line: who, when, what, and the lines it added and removed. */
@Composable
private fun VersionRow(entry: NoteVersion, selected: Boolean, onOpen: () -> Unit) {
    val counts = lineCounts(entry.summary)
    val words = rowWords(entry)
    Row(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp)
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
            .clickable(role = Role.Button, onClick = trackedClick("history.version", onOpen))
            .padding(start = 16.dp, end = 16.dp)
            .testTag("history-${entry.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        WhoMark(entry.authors)
        Text(
            clock(entry.createdAt),
            Modifier.widthIn(min = 64.dp),
            style = MaterialTheme.roles.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
        Text(
            words.ifBlank { entry.authors.joinToString(", ", transform = ::authorName) },
            Modifier.weight(1f),
            style = MaterialTheme.roles.body,
            color = if (entry.summary.trim() == "No text changes") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (counts != null) LineCounts(counts)
    }
}

/** `+12 −3`: added in the accent, removed in the danger colour; a lone −0 is left out, as the Mac's. */
@Composable
private fun LineCounts(counts: Pair<Int, Int>) {
    val (added, removed) = counts
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (added > 0 || removed == 0) Text("+$added", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.primary)
        if (removed > 0) Text("−$removed", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.error)
    }
}

/**
 * Who made a version, as the Mac's rows show it: the first writer's icon (✦ for an agent, a
 * phone for an Android, else a laptop), every writer's name for screen readers.
 */
@Composable
private fun WhoMark(authors: List<HistoryAuthor>) {
    val first = authors.firstOrNull()
    val names = authors.joinToString(", ", transform = ::authorName)
    Box(Modifier.size(18.dp).clearAndSetSemantics { if (names.isNotEmpty()) contentDescription = names }, contentAlignment = Alignment.Center) {
        when {
            first == null -> Unit
            first.kind == "agent" -> Icon(SettingsIcons.Spark, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
            Regex("android|phone|pixel", RegexOption.IGNORE_CASE).containsMatchIn(first.label) ->
                Glyph("smartphone", null, 16, MaterialTheme.colorScheme.onSurfaceVariant)
            else -> Glyph("laptop", null, 16, MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The detail: one version's own screen. */
@Composable
private fun VersionScreen(
    ui: HistoryUi,
    version: NoteVersion,
    onBack: () -> Unit,
    onToggleWhole: (Boolean) -> Unit,
    onAskRestore: () -> Unit,
    onRevert: () -> Unit,
    onCopy: (VersionDetail) -> Unit,
) {
    val detail = ui.detail?.takeIf { it.id == version.id }
    Column(Modifier.fillMaxSize().testTag("historyDetail")) {
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().padding(end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = trackedClick("history.view.back", onBack), modifier = Modifier.testTag("historyBack"), contentPadding = PaddingValues(start = 8.dp, end = 12.dp)) {
                Glyph("chevron-left", null, 20)
                Spacer(Modifier.width(4.dp))
                Text("Versions", maxLines = 1, softWrap = false)
            }
            Spacer(Modifier.weight(1f))
            if (detail != null) {
                IconButton(
                    onClick = trackedClick("history.view.mode") { onToggleWhole(!ui.showWhole) },
                    modifier = Modifier.testTag("historyToggleWhole"),
                ) {
                    if (ui.showWhole) Glyph("file-diff", "Show Changes", 20) else Glyph("file-text", "Show Whole Version", 20)
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 10.dp)) {
            Text(
                shortWhen(version.createdAt.takeIf { it > 0 }),
                Modifier.semantics { heading() },
                style = MaterialTheme.roles.rowLabel,
                fontWeight = FontWeight.SemiBold,
            )
            val meta = listOfNotNull(
                version.authors.joinToString(", ", transform = ::authorName).ifBlank { null },
                rowWords(version).ifBlank { null },
                if (detail?.previousId == null && detail != null) "The first version" else null,
            ).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Box(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp)
                .background(MaterialTheme.colorScheme.surfaceContainerLowest),
        ) {
            when {
                detail != null && ui.showWhole -> LazyColumn(Modifier.fillMaxSize().testTag("historyWhole")) {
                    item {
                        Text(
                            bodyOf(detail.markdown).ifBlank { "(empty)" },
                            Modifier.padding(10.dp),
                            style = MaterialTheme.roles.body.copy(fontFamily = FontFamily.Monospace),
                        )
                    }
                }
                detail != null -> NumberedDiff(detail)
                ui.detailError != null -> Text(
                    ui.detailError,
                    Modifier.padding(10.dp),
                    style = MaterialTheme.roles.help,
                    color = MaterialTheme.colorScheme.error,
                )
                else -> Text(
                    "Reading the changes…",
                    Modifier.padding(10.dp),
                    style = MaterialTheme.roles.help,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        HorizontalDivider(Modifier.padding(top = 10.dp))
        // One row, never two (R2-12): Restore first, as the Mac's; each a word and an icon.
        Row(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = trackedClick("history.view.restore", onAskRestore),
                enabled = !ui.busy,
                modifier = Modifier.weight(1f).testTag("restoreVersion").semantics { contentDescription = "Restore This Version" },
                contentPadding = PaddingValues(horizontal = 8.dp),
            ) { Action("history", "Restore") }
            // Not on a move to Trash or its restore: Trash undoes those (N7, A654, A1575).
            if (revertible(version)) {
                OutlinedButton(
                    onClick = trackedClick("history.view.revert", onRevert),
                    enabled = !ui.busy,
                    modifier = Modifier.weight(1f).testTag("revertVersion").semantics { contentDescription = "Revert This Edit" },
                    contentPadding = PaddingValues(horizontal = 8.dp),
                ) { Action("undo-2", "Revert") }
            }
            OutlinedButton(
                onClick = trackedClick("history.view.copy") { detail?.let(onCopy) },
                enabled = detail != null,
                modifier = Modifier.weight(1f).testTag("copyVersion").semantics { contentDescription = "Copy Text" },
                contentPadding = PaddingValues(horizontal = 8.dp),
            ) { Action("copy", "Copy") }
        }
    }
}

@Composable
private fun Action(icon: String, words: String) {
    Glyph(icon, null, 18)
    Spacer(Modifier.width(6.dp))
    Text(words, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
}

/**
 * The diff as the Mac's docked preview draws it (R2-13): a gutter of line numbers, `+` and `−`
 * marks, added lines tinted with the accent and removed ones with the danger colour and struck
 * through, long unchanged runs folded and named by the lines they hold.
 */
@Composable
private fun NumberedDiff(detail: VersionDetail) {
    val rows = remember(detail) { diffRows(detail.diff) }
    val digits = maxOf(2, detail.diff.size.toString().length)
    val mono = MaterialTheme.roles.help.copy(fontFamily = FontFamily.Monospace)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val added = MaterialTheme.colorScheme.primary
    val removed = MaterialTheme.colorScheme.error
    LazyColumn(Modifier.fillMaxSize().testTag("historyDiff")) {
        items(rows.size) { i ->
            when (val row = rows[i]) {
                is DiffRow.Fold -> Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text(
                        "⋯ ${row.count} unchanged ${if (row.count == 1) "line" else "lines"}",
                        Modifier.weight(1f).padding(start = 10.dp),
                        style = mono.copy(fontStyle = FontStyle.Italic),
                        color = muted,
                    )
                    Text(
                        if (row.from == row.to) "${row.from}" else "${row.from}–${row.to}",
                        Modifier.padding(end = 10.dp).clearAndSetSemantics {},
                        style = mono,
                        color = muted,
                    )
                }
                is DiffRow.Line -> {
                    val tint = when (row.op) {
                        "add" -> added.copy(alpha = 0.16f)
                        "del" -> removed.copy(alpha = 0.14f)
                        else -> Color.Transparent
                    }
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).background(tint)) {
                        // The gutter runs down a wrapped line; its number is on the first row only.
                        Box(Modifier.fillMaxHeight().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f))) {
                            Text(
                                row.n.toString().padStart(digits),
                                Modifier.padding(horizontal = 6.dp).clearAndSetSemantics {},
                                style = mono,
                                color = muted.copy(alpha = if (row.op == "del") 0.55f else 1f),
                                textAlign = TextAlign.End,
                            )
                        }
                        VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Text(
                            buildAnnotatedString {
                                withStyle(SpanStyle(color = muted)) {
                                    append(
                                        when (row.op) {
                                            "add" -> "+"
                                            "del" -> "−"
                                            else -> " "
                                        },
                                    )
                                }
                                append(" ")
                                if (row.op == "del") {
                                    withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(row.line) }
                                } else {
                                    append(row.line)
                                }
                            },
                            Modifier.weight(1f).padding(start = 6.dp, end = 8.dp),
                            style = mono,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Glyph(name: String, contentDescription: String?, size: Int, tint: Color = androidx.compose.material3.LocalContentColor.current) {
    val icon = rememberLucideIcons()?.icon(name)
    if (icon != null) {
        Icon(LucideAssets.vector(icon), contentDescription, Modifier.size(size.dp), tint = tint)
    } else {
        Spacer(Modifier.size(size.dp))
    }
}
