package app.penmoss.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.penmoss.AppGraph
import app.penmoss.engine.api.AgentActivityEntry
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.PenmossApi
import app.penmoss.ui.settings.AgentActivityScreen
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

/*
 * Settings → Devices and agent tokens → Agent activity (T42, A561; T40 P9, AC11): what agent
 * tokens changed in folders, note places, settings and tags in the last 30 days, with Undo, as
 * the web's `AgentActivity`. Online only: the record is the server's. Undo is the person's own
 * change, so this phone's device token may make it (the server refuses agent tokens).
 */

internal object AgentActivityRoutes {
    const val ACTIVITY = "settings/devices/activity"
}

/** The filter's kinds of change, in the web's words (`KIND_GROUPS`). */
internal val ACTIVITY_GROUPS: List<Pair<String, String>> = listOf(
    "all" to "All changes",
    "folder" to "Folders",
    "note" to "Note moves",
    "settings" to "Settings",
    "tag" to "Tags",
)

/** Whether [entry] is of the kind [group] picks, as the web's `inGroup`: a top-level sort is a folder change. */
internal fun inActivityGroup(entry: AgentActivityEntry, group: String): Boolean =
    group == "all" || entry.kinds.any { kind -> if (group == "folder") kind.startsWith("folder.") || kind == "root.sort" else kind.startsWith(group) }

/** The agents the list names, by label, for the Agent filter: id to label. */
internal fun activityAgents(entries: List<AgentActivityEntry>): List<Pair<String, String>> =
    entries.associate { it.actor.id to it.actor.label }.toList().sortedBy { it.second.lowercase() }

/** One entry's second line, as the web's: "✦ Codex · 3 Oct, 4:12 PM · Undone by Pixel 9 4 Oct, 9:00 AM". */
internal fun activityDetail(entry: AgentActivityEntry, now: Long): String {
    val undone = entry.undoneAt?.let { " · Undone${entry.undoneBy?.let { by -> " by $by" }.orEmpty()} ${shortWhen(it, now)}" }.orEmpty()
    return "✦ ${entry.actor.label} · ${shortWhen(entry.at, now)}$undone"
}

/** What the screen shows (AC11). */
data class AgentActivityUi(
    /** Null until the server's list is read. */
    val entries: List<AgentActivityEntry>? = null,
    val loading: Boolean = false,
    /** Offline, or the list could not be read. */
    val problem: String? = null,
    /** The entry whose Undo is under way; the other Undos wait for it. */
    val busy: Long? = null,
    /** What the last Undo said. */
    val message: String? = null,
    val agent: String = "all",
    val group: String = "all",
) {
    val shown: List<AgentActivityEntry>
        get() = entries.orEmpty().filter { (agent == "all" || it.actor.id == agent) && inActivityGroup(it, group) }
}

class AgentActivityModel(
    private val api: PenmossApi,
    /** An Undo changed the tree, a setting or tags: the phone syncs to show it. */
    private val requestSync: () -> Unit,
    scope: CoroutineScope? = null,
) : ViewModel() {
    private val work = scope ?: viewModelScope
    private val _ui = MutableStateFlow(AgentActivityUi())
    val ui: StateFlow<AgentActivityUi> = _ui.asStateFlow()

    fun load() {
        work.launch {
            _ui.update { it.copy(loading = true) }
            val problem = try {
                val entries = api.agentActivity()
                _ui.update { it.copy(entries = entries) }
                null
            } catch (error: ApiException) {
                "Penmoss couldn’t list what agents changed: ${error.message?.trimEnd('.')}."
            } catch (error: IOException) {
                "Offline: what agents changed is kept by Penmoss. Try again once the phone is online."
            }
            _ui.update { it.copy(loading = false, problem = problem) }
        }
    }

    fun filter(agent: String = _ui.value.agent, group: String = _ui.value.group) = _ui.update { it.copy(agent = agent, group = group) }

    /**
     * Undoes [entry] as this person's change (A561): the server applies its inverse, or says what
     * changed since and changes nothing. Either way the list is read again.
     */
    fun undo(entry: AgentActivityEntry) {
        if (_ui.value.busy != null) return
        _ui.update { it.copy(busy = entry.id, message = null) }
        work.launch {
            val said = try {
                val reply = api.undoAgentActivity(entry.id)
                requestSync()
                when {
                    reply.alreadyUndone -> "That change was undone already."
                    else -> reply.notice ?: "Undone: ${entry.summary.trimEnd('.')}."
                }
            } catch (error: Exception) {
                when (error) {
                    is CancellationException -> throw error
                    is ApiException -> {
                        error.message?.takeIf { it.isNotBlank() } ?: "Could not undo it (${error.status})."
                    }
                    is IOException -> "Offline: Undo needs Penmoss. Try again once the phone is online."
                    else -> throw error
                }
            }
            _ui.update { it.copy(busy = null, message = said) }
            load()
        }
    }

    fun messageShown() = _ui.update { it.copy(message = null) }
}

@Composable
internal fun AgentActivityRoute(graph: AppGraph, onBack: () -> Unit) {
    val model = viewModel {
        AgentActivityModel(graph.api, requestSync = { graph.sync.requestSync() })
    }
    LaunchedEffect(Unit) { model.load() }
    val ui by model.ui.collectAsStateWithLifecycle()
    AgentActivityScreen(
        ui = ui,
        onBack = onBack,
        onRetry = model::load,
        onFilter = { agent, group -> model.filter(agent, group) },
        onUndo = model::undo,
        onMessageShown = model::messageShown,
        git = graph.isGit,
    )
}
