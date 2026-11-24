package app.penmoss.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.penmoss.engine.api.AgentActivityEntry
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossApi
import app.penmoss.ui.common.shortWhen
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/*
 * Settings → Agent Activity (T42, A561; #172, A920; PEN-146): what agents (a CLI or MCP clone
 * added with --agent) changed in folders, note places and settings in the last 30 days, across
 * every notebook on this phone, each read from its notebook's branch, with Undo. Undo is the
 * person's own change, pushed with the notebook's next sync. Its own screen in the Agents group,
 * no longer a button on a notebook's sync.
 */

internal object AgentActivityRoutes {
    const val ACTIVITY = "settings/agent-activity"
}

/** The filter's kinds of change, in the web's words (`KIND_GROUPS`), in Title Case (PEN-146). */
internal val ACTIVITY_GROUPS: List<Pair<String, String>> = listOf(
    "all" to "All Changes",
    "folder" to "Folders",
    "note" to "Note Moves",
    "settings" to "Settings",
    "tag" to "Tags",
)

/** Whether [entry] is of the kind [group] picks, as the web's `inGroup`: a top-level sort is a folder change. */
internal fun inActivityGroup(entry: AgentActivityEntry, group: String): Boolean =
    group == "all" || entry.kinds.any { kind -> if (group == "folder") kind.startsWith("folder.") || kind == "root.sort" else kind.startsWith(group) }

/** The agents the list names, by label, for the Agent filter: id to label. */
internal fun activityAgents(entries: List<AgentActivityEntry>): List<Pair<String, String>> =
    entries.associate { it.actor.id to it.actor.label }.toList().sortedBy { it.second.lowercase() }

/** One entry's second line: "✦ Codex · Personal · 3 Oct, 4:12 PM · Undone by Pixel 9 4 Oct, 9:00 AM". */
internal fun activityDetail(entry: AgentActivityEntry, now: Long, notebook: String? = null): String {
    val undone = entry.undoneAt?.let { " · Undone${entry.undoneBy?.let { by -> " by $by" }.orEmpty()} ${shortWhen(it, now)}" }.orEmpty()
    return "✦ ${entry.actor.label}${notebook?.let { " · $it" }.orEmpty()} · ${shortWhen(entry.at, now)}$undone"
}

/** A notebook whose agents' changes the list reads: its branch, through its own notes server. */
class ActivitySource(val id: String, val name: String, val api: () -> PenmossApi, val requestSync: () -> Unit = {})

/** One change, and the notebook it was made in. */
data class ActivityItem(val notebook: String, val notebookName: String, val entry: AgentActivityEntry) {
    val key: String get() = "$notebook-${entry.id}"
}

/** What the screen shows (AC11; PEN-146). */
data class AgentActivityUi(
    /** Null until the notebooks' lists are read; newest first, across notebooks. */
    val items: List<ActivityItem>? = null,
    val loading: Boolean = false,
    /** A notebook whose list could not be read, said with its name. */
    val problem: String? = null,
    /** The change whose Undo is under way ([ActivityItem.key]); the other Undos wait for it. */
    val busy: String? = null,
    /** What the last Undo said. */
    val message: String? = null,
    val notebook: String = "all",
    val agent: String = "all",
    val group: String = "all",
) {
    val shown: List<ActivityItem>
        get() = items.orEmpty().filter {
            (notebook == "all" || it.notebook == notebook) && (agent == "all" || it.entry.actor.id == agent) && inActivityGroup(it.entry, group)
        }

    /** The notebooks the filter offers: id to name. */
    val notebooks: List<Pair<String, String>> get() = items.orEmpty().associate { it.notebook to it.notebookName }.toList().sortedBy { it.second.lowercase() }
}

class AgentActivityModel(
    private val sources: () -> List<ActivitySource>,
    scope: CoroutineScope? = null,
) : ViewModel() {
    private val work = scope ?: viewModelScope
    private val _ui = MutableStateFlow(AgentActivityUi())
    val ui: StateFlow<AgentActivityUi> = _ui.asStateFlow()

    fun load() {
        work.launch {
            _ui.update { it.copy(loading = true) }
            val items = ArrayList<ActivityItem>()
            val problems = ArrayList<String>()
            for (source in sources()) {
                try {
                    source.api().agentActivity().mapTo(items) { ActivityItem(source.id, source.name, it) }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    problems += "Penmoss couldn’t read what agents changed in ${source.name}: ${error.message?.trimEnd('.') ?: "it did not work"}."
                }
            }
            _ui.update {
                it.copy(items = items.sortedByDescending { item -> item.entry.at }, loading = false, problem = problems.joinToString(" ").ifEmpty { null })
            }
        }
    }

    fun filter(notebook: String = _ui.value.notebook, agent: String = _ui.value.agent, group: String = _ui.value.group) =
        _ui.update { it.copy(notebook = notebook, agent = agent, group = group) }

    /**
     * Undoes [item] as this person's change (A561, A920): its notebook applies the inverse, or
     * says what changed since and changes nothing. Either way the lists are read again.
     */
    fun undo(item: ActivityItem) {
        if (_ui.value.busy != null) return
        val source = sources().firstOrNull { it.id == item.notebook } ?: return
        _ui.update { it.copy(busy = item.key, message = null) }
        work.launch {
            val said = try {
                val reply = source.api().undoAgentActivity(item.entry.id)
                source.requestSync()
                when {
                    reply.alreadyUndone -> "That change was undone already."
                    else -> reply.notice ?: "Undone: ${item.entry.summary.trimEnd('.')}."
                }
            } catch (error: Exception) {
                when (error) {
                    is CancellationException -> throw error
                    is ApiException -> error.message?.takeIf { it.isNotBlank() } ?: "Could not undo it (${error.status})."
                    else -> "Couldn’t undo it just now: ${error.message?.trimEnd('.') ?: "try again in a moment"}."
                }
            }
            _ui.update { it.copy(busy = null, message = said) }
            load()
        }
    }

    fun messageShown() = _ui.update { it.copy(message = null) }
}

/** Every notebook on this phone, as the list reads them. */
internal fun activitySources(hub: app.penmoss.git.GitNotebookHub): List<ActivitySource> = hub.list.value.map { view ->
    ActivitySource(view.localId, view.name, api = { hub.graph(view.localId).api }, requestSync = { runCatching { hub.graph(view.localId).sync.requestSync() } })
}

@Composable
internal fun AgentActivityRoute(device: app.penmoss.DeviceGraph, onBack: () -> Unit, notebook: String? = null) {
    val model = viewModel { AgentActivityModel({ activitySources(device.git) }) }
    LaunchedEffect(Unit) {
        if (notebook != null) model.filter(notebook = notebook)
        model.load()
    }
    val ui by model.ui.collectAsStateWithLifecycle()
    AgentActivityScreen(
        ui = ui,
        onBack = onBack,
        onRetry = model::load,
        onFilter = { notebookId, agent, group -> model.filter(notebookId, agent, group) },
        onUndo = model::undo,
        onMessageShown = model::messageShown,
    )
}
