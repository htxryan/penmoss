package app.penmoss.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.penmoss.AppGraph
import app.penmoss.data.NoteStore
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.DiffOp
import app.penmoss.engine.api.NoteHistory
import app.penmoss.engine.api.NoteVersion
import app.penmoss.engine.api.PenmossApi
import app.penmoss.engine.api.PenmossJson
import app.penmoss.engine.api.RevertConflict
import app.penmoss.engine.sync.ExchangeResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

/*
 * Version history on the phone (T40 P3b, NT16–NT20, A435–A438): the note's versions with time,
 * author (device or agent) and summary; one version's diff; restore, revert and save.
 * Read scope lists and details (a folder-scoped token gets 404 outside its folder, as on every
 * `/api/notes/:id/` route); the writes need the write scope. No new server route.
 */

/** How the web names a version's reason (HistoryPanel): auto, restore and revert say nothing more. */
private val REASONS = mapOf(
    "auto" to "",
    "manual" to "Saved by hand",
    "restore" to "",
    "revert" to "",
    "edit" to "",
)

/** A version's reason and summary as one line, as the web shows it. */
fun versionLine(version: NoteVersion): String =
    listOf(REASONS[version.reason] ?: version.reason, version.summary).filter { it.isNotBlank() }.joinToString(" · ")

/** Whether the version has an agent among its authors: it offers Revert this edit (NT19). */
fun isAgentVersion(version: NoteVersion): Boolean = version.authors.any { it.kind == "agent" }

/** The versions an agent's move to Trash or its restore cut (#113): no edit of the text to take back. */
private val TRASH_MOVES = setOf("Moved to Trash", "Restored from Trash")

/**
 * Whether the version offers Revert this edit (T42, A574, N7; T40 NT30, A654), as the web's
 * `revertible`: an agent's edit, but never an agent's "Moved to Trash" or "Restored from Trash",
 * which Trash and its Restore undo. Restore this version stays on every version.
 */
fun revertible(version: NoteVersion): Boolean = version.summary.trim() !in TRASH_MOVES && isAgentVersion(version)

/** What History says under its title (A574, A79): versions are automatic. */
const val VERSIONS_EXPLAINED =
    "Versions are saved automatically: after 5 minutes without changes, every 30 minutes while you keep editing, and after every agent edit."

/** Unchanged lines kept around each change in the diff, as the web's CONTEXT. */
private const val DIFF_CONTEXT = 2

/** One row of a version's diff as shown: a line, or folded unchanged lines. */
sealed interface DiffRow {
    data class Line(val op: String, val line: String) : DiffRow

    data class Fold(val count: Int) : DiffRow
}

/** The diff with long unchanged runs folded, as the web's `diffRows`. */
fun diffRows(diff: List<DiffOp>): List<DiffRow> {
    val rows = mutableListOf<DiffRow>()
    val changed = diff.map { it.op != "same" }
    fun near(i: Int): Boolean {
        for (j in maxOf(0, i - DIFF_CONTEXT)..minOf(diff.size - 1, i + DIFF_CONTEXT)) {
            if (changed[j]) return true
        }
        return false
    }
    var folded = 0
    diff.forEachIndexed { i, op ->
        if (op.op == "same" && !near(i)) {
            folded++
            return@forEachIndexed
        }
        if (folded > 0) rows += DiffRow.Fold(folded)
        folded = 0
        rows += DiffRow.Line(op.op, op.line)
    }
    if (folded > 0) rows += DiffRow.Fold(folded)
    return rows
}

data class HistoryUi(
    val loading: Boolean = false,
    /** Offline, or the server's answer could not be read: the cached list below, or nothing. */
    val problem: String? = null,
    val history: NoteHistory? = null,
    val selected: Long? = null,
    val detail: app.penmoss.engine.api.VersionDetail? = null,
    val detailLoading: Boolean = false,
    /** The selected version's whole markdown instead of its diff (NT17). */
    val showWhole: Boolean = false,
    /** The detail could not be read. */
    val detailError: String? = null,
    val message: String? = null,
    /** What a revert could not undo (NT19); the dialog shows them until dismissed. */
    val conflicts: List<RevertConflict> = emptyList(),
    /** A restore waiting for its confirm (NT18). */
    val confirming: Long? = null,
    val busy: Boolean = false,
)

/**
 * A note's version history (NT16–NT20).
 *
 * [flushEditor] stores the open editor's last edits (the controller's `flushAndWait`); every
 * change calls it first, so it includes the phone's last edits. [exchangeNow] exchanges the
 * note at once after a restore or revert, so the content shows without waiting for the next
 * pass, and before saving, so the version includes what the exchange brought up; null when the
 * exchange did not go through (offline, or Penmoss did not answer), which save treats as not
 * saved and restore/revert say outright.
 */
class HistoryModel(
    private val noteId: String,
    private val store: NoteStore,
    private val api: PenmossApi,
    private val flushEditor: suspend () -> Unit,
    private val exchangeNow: suspend () -> ExchangeResult?,
    /** The token is no longer valid (401): the phone is signed out, unless it has another token since. */
    scope: CoroutineScope? = null,
    private val now: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val work = scope ?: viewModelScope
    private val state = MutableStateFlow(HistoryUi())

    val ui: StateFlow<HistoryUi> = state

    /** Reads the versions; offline, the last list read, and it says so (NT16). */
    fun load() {
        work.launch {
            state.update { it.copy(loading = true) }
            val cached = runCatching { store.cachedHistory(noteId)?.let { decode(it.json) to it.fetchedAt } }.getOrNull()
            try {
                val history = api.history(noteId)
                runCatching { store.cacheHistory(noteId, PenmossJson.encodeToString(NoteHistory.serializer(), history)) }
                state.update {
                    it.copy(
                        loading = false,
                        problem = null,
                        history = history,
                        selected = kept(it.selected, history) ?: history.versions.firstOrNull()?.id,
                        detail = null,
                        detailError = null,
                        showWhole = false,
                    )
                }
                state.value.selected?.let { select(it) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: ApiException) {
                run {
                    state.update {
                        it.copy(
                            loading = false,
                            problem = "The server could not load the history (error ${error.status}). Try again in a moment.",
                            history = cached?.first ?: it.history,
                        )
                    }
                }
            } catch (error: IOException) {
                state.update {
                    val (history, at) = cached ?: (null to null)
                    it.copy(
                        loading = false,
                        problem = if (history != null) {
                            "Offline: showing versions from ${shortWhen(at, now())}."
                        } else {
                            "Version history needs a connection to the server."
                        },
                        history = history,
                        selected = if (history != null) kept(it.selected, history) ?: history.versions.firstOrNull()?.id else it.selected,
                    )
                }
                state.value.selected?.let { selected -> if (state.value.detail?.id != selected) select(selected) }
            }
        }
    }

    private fun kept(selected: Long?, history: NoteHistory): Long? =
        selected?.takeIf { id -> history.versions.any { it.id == id } }

    private fun decode(json: String): NoteHistory? = runCatching {
        PenmossJson.decodeFromString(NoteHistory.serializer(), json)
    }.getOrNull()

    /**
     * Reads one version's diff (NT17). The detail already read stays until the new one arrives:
     * choosing a version offline, or one that will not load, keeps showing what was read before.
     */
    fun select(version: Long) {
        work.launch {
            state.update { it.copy(selected = version, detailError = null, detailLoading = true, showWhole = false) }
            try {
                val detail = api.versionDetail(noteId, version)
                state.update { if (it.selected == version) it.copy(detail = detail, detailLoading = false) else it.copy(detailLoading = false) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: ApiException) {
                state.update { it.copy(detailLoading = false, detailError = "That version could not be loaded (error ${error.status}).") }
            } catch (error: IOException) {
                state.update { it.copy(detailLoading = false, detailError = "That version needs a connection to load.") }
            }
        }
    }

    fun toggleWhole(shown: Boolean) {
        state.update { it.copy(showWhole = shown) }
    }

    /** Asks for the confirm before restoring (NT18). */
    fun askRestore(version: Long) {
        state.update { it.copy(confirming = version) }
    }

    fun dismissConfirm() {
        state.update { it.copy(confirming = null) }
    }

    /**
     * Restores a version as a new change (NT18): the open editor flushes first, then the restore
     * goes, then the note is exchanged at once. The epoch stays, so pending edits merge as usual
     * and no conflict copy is made. When the exchange did not go through, the restore still went:
     * the message says the content is still coming.
     */
    fun restore(version: Long) {
        if (state.value.busy) return
        state.update { it.copy(busy = true, confirming = null, message = null, conflicts = emptyList()) }
        work.launch {
            var exchanged = true
            val said = try {
                flushEditor()
                val result = api.restoreVersion(noteId, version)
                exchanged = exchangeNow() != null
                val whenOf = state.value.history?.versions?.firstOrNull { it.id == version }?.createdAt
                if (result.changed) "Restored the version of ${shortWhen(whenOf?.takeIf { it > 0 }, now())} as a new change." else "The note already matches this version."
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                historyFailure(error)
            }
            val message = if (!exchanged && said?.startsWith("Restored") == true) {
                "$said The new content is still coming: check the connection and sync."
            } else {
                said
            }
            state.update { it.copy(busy = false, message = message) }
            load()
        }
    }

    /**
     * Undoes an agent's change (NT19): the open editor flushes first, then the revert goes, then
     * the note is exchanged at once. What overlapped later edits is listed, as the web lists it.
     * When the exchange did not go through, the revert still went: the message says the content
     * is still coming.
     */
    fun revert(version: Long) {
        if (state.value.busy) return
        state.update { it.copy(busy = true, message = null, conflicts = emptyList()) }
        work.launch {
            var conflicts: List<RevertConflict> = emptyList()
            var exchanged = true
            val said = try {
                flushEditor()
                val result = api.revertVersion(noteId, version)
                exchanged = exchangeNow() != null
                conflicts = result.conflicts
                val n = conflicts.size
                when {
                    n > 0 -> "Reverted what did not overlap later edits. $n ${if (n == 1) "part was" else "parts were"} changed again since, and kept."
                    result.changed -> "Reverted the agent’s edit; later edits are kept."
                    else -> "Nothing to revert: the note no longer has this edit."
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                historyFailure(error)
            }
            val message = if (!exchanged && said?.startsWith("Reverted") == true) {
                "$said The new content is still coming: check the connection and sync."
            } else {
                said
            }
            state.update { it.copy(busy = false, message = message, conflicts = conflicts) }
            load()
        }
    }

    /**
     * Saves a version now (NT20): the open editor flushes first, then the note is exchanged, so
     * the version includes the phone's last edits, then it is saved. When the exchange did not go
     * through, nothing is saved: a version then would miss the phone's last edits.
     */
    fun saveNow() {
        if (state.value.busy) return
        state.update { it.copy(busy = true, message = null, conflicts = emptyList()) }
        work.launch {
            val said = try {
                flushEditor()
                if (exchangeNow() == null) {
                    "The version was not saved: the note could not be exchanged. Check the connection and try again."
                } else {
                    api.saveVersion(noteId)
                    "Saved a version of the note as it is now."
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                historyFailure(error)
            }
            state.update { it.copy(busy = false, message = said) }
            load()
        }
    }

    fun messageShown() = state.update { it.copy(message = null) }

    fun conflictsDismissed() = state.update { it.copy(conflicts = emptyList()) }
}

internal fun historyFailure(error: Exception): String {
    if (error is ApiException) return "The server could not do that (error ${error.status}). Try again in a moment."
    return "That did not work. Check the connection and try again."
}

@Composable
internal fun HistoryRoute(
    graph: AppGraph,
    noteId: String,
    flushEditor: suspend () -> Unit,
    exchangeNow: suspend () -> ExchangeResult?,
    onBack: () -> Unit,
    /** In the note panel (T51, A936). */
    embedded: Boolean = false,
) {
    val model = viewModel {
        HistoryModel(
            noteId,
            graph.store,
            graph.api,
            flushEditor = flushEditor,
            exchangeNow = exchangeNow,
        )
    }
    LaunchedEffect(noteId) { model.load() }
    val ui by model.ui.collectAsStateWithLifecycle()
    HistoryScreen(
        ui = ui,
        onSelect = model::select,
        onToggleWhole = model::toggleWhole,
        onAskRestore = model::askRestore,
        onDismissConfirm = model::dismissConfirm,
        onRestore = model::restore,
        onRevert = model::revert,
        onSaveNow = model::saveNow,
        onMessageShown = model::messageShown,
        onConflictsDismissed = model::conflictsDismissed,
        onRefresh = model::load,
        onBack = onBack,
        embedded = embedded,
    )
}
