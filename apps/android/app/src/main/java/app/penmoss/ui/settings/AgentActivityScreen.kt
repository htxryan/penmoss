package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import app.penmoss.ui.square.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.penmoss.engine.api.AgentActivityEntry
import app.penmoss.ui.ACTIVITY_GROUPS
import app.penmoss.ui.PenmossSnackbar
import app.penmoss.ui.AgentActivityUi
import app.penmoss.ui.activityAgents
import app.penmoss.ui.activityDetail

/** The web's words for an empty list (`ActivityList`). */
internal const val NO_AGENT_ACTIVITY = "No agent has moved notes or changed folders, settings or tags in the last 30 days."

/** A git notebook's (#172, A920): the web's `GitAgentActivity` words. */
internal const val NO_GIT_AGENT_ACTIVITY = "No agent has moved notes or changed folders or settings here in the last 30 days."

/**
 * Agent activity (T42, A561; T40 P9, AC11), as the web's: what agent tokens changed in the last
 * 30 days, newest first, filtered by agent and kind of change, each with **Undo**, which puts it
 * back as your own change unless it was changed again since; then who undid it and when.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentActivityScreen(
    ui: AgentActivityUi,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onFilter: (agent: String, group: String) -> Unit,
    onUndo: (AgentActivityEntry) -> Unit,
    onMessageShown: () -> Unit,
    now: Long = System.currentTimeMillis(),
    /** A git notebook's (#172, A920): read from its branch, its agents being `--agent` clones. */
    git: Boolean = false,
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
        LazyColumn(Modifier.fillMaxSize().padding(padding).testTag("agentActivity"), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                if (ui.loading || ui.busy != null) LinearProgressIndicator(Modifier.fillMaxWidth().testTag("activityLoading"))
                Help(
                    if (git) {
                        "What agents (a CLI or MCP clone added with --agent) changed in this notebook in the last 30 days: folders, where notes are and settings, read from its branch. Undo puts it back as your own change, pushed with the next sync, unless it was changed again since. An agent’s edits to a note and its tags are in the note’s History, and the notes and folders it deleted are in Trash."
                    } else {
                        "What agent tokens changed in the last 30 days: folders, where notes are, settings and tags. Undo puts it back as your own change, unless it was changed again since. An agent’s edits to a note are in the note’s History, and the notes and folders it deleted are in Trash."
                    },
                )
            }
            ui.problem?.let { problem ->
                item {
                    Help(problem, Modifier.testTag("activityProblem"))
                    Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) { OutlinedButton(onClick = onRetry) { Text("Try Again") } }
                }
            }
            val entries = ui.entries
            if (entries != null) {
                item { Filters(ui, entries, onFilter) }
                if (ui.shown.isEmpty()) item { Help(if (git) NO_GIT_AGENT_ACTIVITY else NO_AGENT_ACTIVITY, Modifier.padding(vertical = 8.dp).testTag("noActivity")) }
                items(ui.shown, key = { it.id }) { entry ->
                    ActivityRow(entry, now, enabled = ui.busy == null, onUndo = { onUndo(entry) })
                    HorizontalDivider()
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Filters(ui: AgentActivityUi, entries: List<AgentActivityEntry>, onFilter: (String, String) -> Unit) {
    var picking by rememberSaveable { mutableStateOf<String?>(null) }
    val agents = activityAgents(entries)
    val agentName = agents.firstOrNull { it.first == ui.agent }?.second ?: "Every agent"
    val groupName = ACTIVITY_GROUPS.firstOrNull { it.first == ui.group }?.second ?: "All changes"
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box {
            FilterChip(
                selected = ui.agent != "all",
                onClick = { picking = "agent" },
                label = { Text(agentName) },
                trailingIcon = { Icon(Icons.Default.ArrowDropDown, contentDescription = null) },
                modifier = Modifier.testTag("activityAgent").semantics { contentDescription = "Agent: $agentName" },
            )
            DropdownMenu(expanded = picking == "agent", onDismissRequest = { picking = null }) {
                for ((id, label) in listOf("all" to "Every agent") + agents) {
                    DropdownMenuItem(text = { Text(label) }, onClick = {
                        picking = null
                        onFilter(id, ui.group)
                    }, modifier = Modifier.testTag("activityAgent-$id"))
                }
            }
        }
        Box {
            FilterChip(
                selected = ui.group != "all",
                onClick = { picking = "group" },
                label = { Text(groupName) },
                trailingIcon = { Icon(Icons.Default.ArrowDropDown, contentDescription = null) },
                modifier = Modifier.testTag("activityGroup").semantics { contentDescription = "Changes: $groupName" },
            )
            DropdownMenu(expanded = picking == "group", onDismissRequest = { picking = null }) {
                for ((id, label) in ACTIVITY_GROUPS) {
                    DropdownMenuItem(text = { Text(label) }, onClick = {
                        picking = null
                        onFilter(ui.agent, id)
                    }, modifier = Modifier.testTag("activityGroup-$id"))
                }
            }
        }
    }
}

@Composable
private fun ActivityRow(entry: AgentActivityEntry, now: Long, enabled: Boolean, onUndo: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 4.dp).testTag("activity-${entry.id}")) {
        Text(entry.summary, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
        Text(activityDetail(entry, now), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (entry.undoneAt == null) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(
                    onClick = onUndo,
                    enabled = enabled,
                    // Said with what it undoes, as the web's button (aria-describedby).
                    modifier = Modifier.testTag("undo-${entry.id}").semantics { contentDescription = "Undo: ${entry.summary}" },
                ) { Text("Undo") }
            }
        }
    }
}
