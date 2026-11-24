package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import app.penmoss.analytics.TrackScroll
import app.penmoss.ui.common.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.PenmossSnackbar
import app.penmoss.ui.common.BackButton
import app.penmoss.ui.common.roles

/** The words for an empty list (#172, A920): read from each notebook's branch, so no tags. */
internal const val NO_AGENT_ACTIVITY = "No agent has moved notes or changed folders or settings in your notebooks in the last 30 days."

/**
 * Agent Activity (T42, A561; #172, A920; PEN-146): what agents changed in the last 30 days across
 * every notebook on this phone, newest first, filtered by notebook, agent and kind of change, each
 * with **Undo**, which puts it back as your own change unless it was changed again since; then who
 * undid it and when.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentActivityScreen(
    ui: AgentActivityUi,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onFilter: (notebook: String, agent: String, group: String) -> Unit,
    onUndo: (ActivityItem) -> Unit,
    onMessageShown: () -> Unit,
    now: Long = System.currentTimeMillis(),
) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(ui.message) {
        val message = ui.message ?: return@LaunchedEffect
        snackbar.showSnackbar(message, duration = SnackbarDuration.Long)
        onMessageShown()
    }
    Scaffold(
        topBar = { TopAppBar(title = { Text("Agent Activity") }, navigationIcon = { BackButton(onBack) }) },
        snackbarHost = { SnackbarHost(snackbar) { PenmossSnackbar(it) } },
    ) { padding ->
        val list = rememberLazyListState()
        // How far down the page is (PEN-175): a Settings page.
        TrackScroll("settings", list, "agent-activity")
        LazyColumn(Modifier.fillMaxSize().padding(padding).testTag("agentActivity"), state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                if (ui.loading || ui.busy != null) LinearProgressIndicator(Modifier.fillMaxWidth().testTag("activityLoading"))
                Help(
                    modifier = Modifier.settingRow("agent-activity"),
                    text = "What agents (a CLI or MCP clone added with --agent) changed in your notebooks in the last 30 days: folders, where notes are and settings, " +
                        "read from each notebook’s branch. Undo puts it back as your own change, pushed with the next sync, unless it was changed again since. " +
                        "An agent’s edits to a note and its tags are in the note’s History, and the notes and folders it deleted are in Trash.",
                )
            }
            ui.problem?.let { problem ->
                item {
                    Help(problem, Modifier.testTag("activityProblem"))
                    Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) { OutlinedButton(onClick = trackedClick("settings.agent-activity.retry", onRetry)) { Text("Try Again") } }
                }
            }
            val items = ui.items
            if (items != null) {
                item { Filters(ui, items, onFilter) }
                if (ui.shown.isEmpty()) item { Help(NO_AGENT_ACTIVITY, Modifier.padding(vertical = 8.dp).testTag("noActivity")) }
                items(ui.shown, key = { it.key }) { item ->
                    ActivityRow(item, now, enabled = ui.busy == null, onUndo = { onUndo(item) })
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun FilterMenu(
    tag: String,
    what: String,
    selected: Boolean,
    label: String,
    options: List<Pair<String, String>>,
    event: String,
    onPick: (String) -> Unit,
) {
    var open by rememberSaveable { mutableStateOf(false) }
    Box {
        FilterChip(
            selected = selected,
            onClick = trackedClick("settings.agent-activity.filter.open") { open = true },
            label = { Text(label) },
            trailingIcon = { Icon(Icons.Default.ArrowDropDown, contentDescription = null) },
            modifier = Modifier.testTag(tag).semantics { contentDescription = "$what: $label" },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((id, name) in options) {
                DropdownMenuItem(text = { Text(name) }, onClick = trackedClick(event) {
                    open = false
                    onPick(id)
                }, modifier = Modifier.testTag("$tag-$id"))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Filters(ui: AgentActivityUi, items: List<ActivityItem>, onFilter: (String, String, String) -> Unit) {
    val notebooks = listOf("all" to "All Notebooks") + ui.notebooks
    val agents = listOf("all" to "All Agents") + activityAgents(items.map { it.entry })
    FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterMenu("activityNotebook", "Notebook", ui.notebook != "all", notebooks.firstOrNull { it.first == ui.notebook }?.second ?: "All Notebooks", notebooks, event = "settings.agent-activity.filter.notebook") {
            onFilter(it, ui.agent, ui.group)
        }
        FilterMenu("activityAgent", "Agent", ui.agent != "all", agents.firstOrNull { it.first == ui.agent }?.second ?: "All Agents", agents, event = "settings.agent-activity.filter.agent") {
            onFilter(ui.notebook, it, ui.group)
        }
        FilterMenu("activityGroup", "Changes", ui.group != "all", ACTIVITY_GROUPS.firstOrNull { it.first == ui.group }?.second ?: "All Changes", ACTIVITY_GROUPS, event = "settings.agent-activity.filter.changes") {
            onFilter(ui.notebook, ui.agent, it)
        }
    }
}

@Composable
private fun ActivityRow(item: ActivityItem, now: Long, enabled: Boolean, onUndo: () -> Unit) {
    val entry = item.entry
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 10.dp).testTag("activity-${item.key}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(entry.summary, style = MaterialTheme.roles.rowLabel, fontWeight = FontWeight.SemiBold)
            Text(activityDetail(entry, now, item.notebookName), style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (entry.undoneAt == null) {
            TextButton(
                onClick = trackedClick("settings.agent-activity.undo", onUndo),
                enabled = enabled,
                // Said with what it undoes, as the web's button (aria-describedby).
                modifier = Modifier.testTag("undo-${item.key}").semantics { contentDescription = "Undo: ${entry.summary}" },
            ) { Text("Undo") }
        }
    }
}
