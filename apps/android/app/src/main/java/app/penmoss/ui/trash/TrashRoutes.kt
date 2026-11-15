package app.penmoss.ui.trash

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import app.penmoss.NotebookGraph
import app.penmoss.data.NoteEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.TrashRow
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.FolderDeleter
import app.penmoss.engine.api.PenmossPurgeApi
import app.penmoss.engine.api.PenmossApi
import app.penmoss.engine.api.RestoredFolder
import app.penmoss.engine.api.TrashListed
import app.penmoss.engine.api.TrashedFolderListed
import app.penmoss.engine.git.OwnerWords
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit
import app.penmoss.ui.common.SnackbarTone
import app.penmoss.ui.common.noneToTrash
import app.penmoss.ui.common.say
import app.penmoss.ui.common.shortWhen
import app.penmoss.ui.RootUi
import app.penmoss.ui.leave

/*
 * Trash on the phone (T40 P3a, NT12–NT15, A430–A433): Move to Trash with Undo, the Trash
 * screen, Restore, and Delete for good after a confirm and the phone's own check.
 */

internal object TrashRoutes {
    const val TRASH = "trash"
}

/** How long the server keeps a note in Trash before deleting it for good (T21's 30 days). */
internal val TRASH_RETENTION_MS = TimeUnit.DAYS.toMillis(30)

/** How long Undo is offered after Move to Trash (NT12). */
internal const val UNDO_MS = 5_000L

internal fun titleOf(title: String) = title.ifBlank { "Untitled" }

/** Said when a restore on another device overruled this phone's move to Trash (A430). */
internal fun trashRefusedMessage(title: String) =
    "“${titleOf(title)}” was restored on another device, so it was left out of Trash."

/**
 * One row of Trash: the phone's own rows ([local], with what waits to be sent) and those only
 * the server lists ([remote]: deleted on a device whose copy this phone never had), merged by id.
 * The server's deletion time wins; until it is known, what the phone knows.
 */
internal fun trashEntries(
    local: List<TrashRow>,
    remote: List<TrashListed>,
    now: Long,
): List<TrashEntryUi> {
    val listed = remote.associateBy { it.id }
    val ours = local.map { row ->
        val waiting = row.trashChange == NoteEntity.TRASH_QUEUED || row.trashChange == NoteEntity.TRASH_SENDING
        val deletedAt = listed[row.id]?.deletedAt?.takeIf { it > 0 } ?: when {
            waiting || row.trashChange == NoteEntity.TRASH_SENT -> row.trashChangeAt
            else -> row.updatedAt
        }
        entry(row.id, row.title.ifBlank { listed[row.id]?.title.orEmpty() }, deletedAt, waiting, now, listed[row.id]?.deletedBy)
    }
    val known = local.mapTo(HashSet()) { it.id }
    val theirs = remote.filter { it.id !in known }.map { entry(it.id, it.title, it.deletedAt, waiting = false, now, it.deletedBy) }
    return (ours + theirs).sortedWith(compareByDescending<TrashEntryUi> { it.deletedAt }.thenBy { it.id })
}

/**
 * Who moved a note or folder to Trash, as Trash names them (T42, A574; T40 NT30, A655): an agent's
 * name with ✦, as in History, a device's plain. ✦ marks agents only, so it is taken out of any
 * name first: a device called "Claude ✦" cannot pass for an agent (review N8), and a name that is
 * only ✦ is "a device" or "an agent" (#137, A701), never a lone ✦ that reads as one. Null for no
 * one, or for what an older or odd server sent, as the web's `parseDeletedBy`.
 */
internal fun deletedByText(by: FolderDeleter?): String? = deleter(by)?.let { if (it.agent) "${it.name} ✦" else it.name }

/**
 * [deletedByText] as TalkBack says it (#137, A701): "(agent)" where the screen shows ✦, not the
 * star's name; an agent with no name of its own is "an agent", said once.
 */
internal fun deletedBySpoken(by: FolderDeleter?): String? = deleter(by)?.let { if (it.agent && it.named) "${it.name} (agent)" else it.name }

private class Deleter(val name: String, val agent: Boolean, val named: Boolean)

private fun deleter(by: FolderDeleter?): Deleter? {
    by?.label?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    if (by.kind != "agent" && by.kind != "device") return null
    val agent = by.kind == "agent"
    val plain = by.label.replace("\u2726", "").replace(Regex("\\s+"), " ").trim()
    return if (plain.isEmpty()) Deleter(if (agent) "an agent" else "a device", agent, named = false) else Deleter(plain, agent, named = true)
}

private fun entry(id: String, title: String, deletedAt: Long, waiting: Boolean, now: Long, deletedBy: FolderDeleter? = null): TrashEntryUi {
    val left = deletedAt + TRASH_RETENTION_MS - now
    val days = ((left + TimeUnit.DAYS.toMillis(1) - 1) / TimeUnit.DAYS.toMillis(1)).coerceAtLeast(0)
    fun detail(by: String) = when {
        waiting -> "Moved to Trash on this phone · not sent yet"
        deletedAt <= 0 -> "In Trash$by"
        days == 0L -> "Deleted ${shortWhen(deletedAt, now)}$by · goes for good today"
        else -> "Deleted ${shortWhen(deletedAt, now)}$by · goes for good in $days day${if (days == 1L) "" else "s"}"
    }
    val shown = detail(deletedByText(deletedBy)?.let { " by $it" }.orEmpty())
    val spoken = detail(deletedBySpoken(deletedBy)?.let { " by $it" }.orEmpty())
    return TrashEntryUi(id, titleOf(title), shown, deletedAt, waiting, spoken = spoken)
}

/**
 * Trash's state (NT13): the phone's rows from Room, with the server's list when it can be read.
 * Restore (NT14) works offline; Delete for good (NT15) needs the server and the phone's check.
 */
class TrashModel(
    private val store: NoteStore,
    private val api: PenmossApi,
    private val purge: PenmossPurgeApi,
    private val requestSync: () -> Unit,
    scope: CoroutineScope? = null,
    private val now: () -> Long = System::currentTimeMillis,
    /** A git notebook's Trash: Delete for good says its git history still keeps the note (#170 F13). */
    private val git: Boolean = false,
) : ViewModel() {
    private val work = scope ?: viewModelScope
    private val remote = MutableStateFlow<List<TrashListed>>(emptyList())
    private val state = MutableStateFlow(TrashUi())

    val ui: StateFlow<TrashUi> = combine(store.observeTrash(), remote, state) { local, listed, current ->
        current.copy(entries = trashEntries(local, listed, now()))
    }.stateIn(work, SharingStarted.Eagerly, TrashUi())

    /** Reads the server's Trash; offline, the phone's rows alone, and it says so. */
    fun load() {
        work.launch {
            state.update { it.copy(loading = true) }
            val problem = try {
                remote.value = api.trash()
                null
            } catch (error: ApiException) {
                "Penmoss couldn’t list its Trash: ${error.message?.trimEnd('.')}. These are the notes this phone holds in Trash."
            } catch (error: IOException) {
                "Offline: these are the notes this phone holds in Trash."
            }
            state.update { it.copy(loading = false, problem = problem) }
        }
    }

    /** Takes a note out of Trash (NT14): at once on the phone, sent with the next pass. */
    fun restore(entry: TrashEntryUi) {
        work.launch {
            val said = when (store.restoreFromTrash(entry.id, entry.title)) {
                NoteStore.Restore.CANCELLED -> "Restored “${entry.title}”."
                NoteStore.Restore.QUEUED -> {
                    requestSync()
                    "Restored “${entry.title}”. It goes back where it was with the next sync."
                }
                NoteStore.Restore.NOT_IN_TRASH -> "“${entry.title}” is not in Trash any more."
            }
            remote.update { list -> list.filterNot { it.id == entry.id } }
            state.update { it.copy(message = said, restored = entry.id) }
        }
    }

    /**
     * Deletes a note for good (NT15), after the confirm the screen asks: the notebook drops it,
     * and the phone drops its copy. No owner check since T59 (A1040): a git notebook's notes are
     * the phone's to manage.
     */
    fun deleteForGood(entry: TrashEntryUi) {
        if (state.value.busy) return
        if (entry.waiting) {
            requestSync()
            state.update { it.copy(message = "Its move to Trash hasn’t reached Penmoss yet. Try again once the phone has synced.") }
            return
        }
        state.update { it.copy(busy = true, message = null) }
        work.launch {
            val said = try {
                purge.purgeNote(entry.id)
                gone(entry)
            } catch (error: Exception) {
                when {
                    error is CancellationException -> throw error
                    // The server never had it, or has dropped it already: only this copy goes.
                    // Only when it says so: another 404 (a proxy's page) leaves the copy.
                    error is ApiException && error.noSuchNote -> gone(entry)
                    error is ApiException && error.status == 409 ->
                        "Penmoss doesn’t have “${entry.title}” in Trash yet. Try again in a moment."
                    else -> purgeFailure(error)
                }
            }
            state.update { it.copy(busy = false, message = said) }
        }
    }

    private suspend fun gone(entry: TrashEntryUi): String {
        store.purged(entry.id)
        remote.update { list -> list.filterNot { it.id == entry.id } }
        return deletedForGoodMessage(entry.title, git)
    }

    fun messageShown() = state.update { it.copy(message = null, restored = null) }
}

/**
 * What Trash says once a note is deleted for good (#170 F13). In a git notebook, that the
 * repository's git history still keeps it, as the phone's check says, in the Mac's words
 * (`deletedForGoodText`), the title cleaned and isolated as the check names it ([OwnerWords]).
 */
internal fun deletedForGoodMessage(title: String, git: Boolean): String {
    if (!git) return "Deleted “$title” for good."
    val shown = OwnerWords.title(title)?.let { "“$it”" } ?: "an untitled note"
    return "Deleted $shown for good. The repository’s git history still keeps it."
}

/** What to say when a note was not deleted for good: the notebook's reason, or offline. */
internal fun purgeFailure(error: Exception): String = when (error) {
    is ApiException -> "Not done: ${error.message?.trim()?.removeSuffix(".") ?: "Penmoss refused it"}."
    is java.io.IOException -> "Not done: the notebook couldn’t be reached. Try again in a moment."
    else -> "Not done: ${error.message ?: error::class.simpleName}."
}

@Composable
internal fun TrashRoute(graph: NotebookGraph, onOpen: (String) -> Unit, onBack: () -> Unit) {
    val model = viewModel {
        TrashModel(
            graph.store,
            graph.api,
            graph.purge,
            requestSync = { graph.sync.requestSync() },
            git = true,
        )
    }
    val folders = viewModel {
        TrashFoldersModel(graph.store, graph.api, requestSync = { graph.sync.requestSync() })
    }
    LaunchedEffect(Unit) {
        model.load()
        folders.load()
    }
    val ui by model.ui.collectAsStateWithLifecycle()
    val folderUi by folders.ui.collectAsStateWithLifecycle()
    TrashScreen(
        ui = ui,
        folders = folderUi,
        onRestoreFolder = folders::restore,
        onFolderMessageShown = folders::messageShown,
        onRestore = model::restore,
        onDeleteForGood = model::deleteForGood,
        onOpen = onOpen,
        onMessageShown = model::messageShown,
        onRefresh = {
            model.load()
            folders.load()
        },
        onBack = onBack,
    )
}

/**
 * Move to Trash from an open note (A432): the note is closed first ([close], which waits for
 * the page's last edits to be stored), then moved ([onTrash]). Launched on [this], the app's
 * scope, never the screen's: Back while the note closes leaves the screen, and the move to
 * Trash still happens (second review of #94).
 */
internal fun CoroutineScope.trashAfterClosing(close: suspend () -> Unit, onTrash: () -> Unit) = launch {
    close()
    onTrash()
}

/**
 * Move to Trash, from a note's menu or a list's long press (NT12): the note leaves every list
 * at once, and Undo is offered for [UNDO_MS]. Undo before it is sent cancels it; after, it is a
 * restore. Either way the pass that follows sends what is left to send.
 */
internal fun CoroutineScope.moveToTrashWithUndo(
    store: NoteStore,
    requestSync: () -> Unit,
    snackbar: SnackbarHostState,
    noteId: String,
    undoFor: Long = UNDO_MS,
) = launch {
    val title = titleOf(store.noteTitle(noteId).orEmpty())
    if (!store.moveToTrash(noteId)) {
        // Said, not silent (#137, A658).
        snackbar.currentSnackbarData?.dismiss()
        snackbar.say(noneToTrash(1), SnackbarTone.Error)
        return@launch
    }
    // A snackbar still showing (an earlier move's Undo) goes now, so this one gets its whole
    // time rather than waiting behind it; that earlier move simply stays in Trash.
    snackbar.currentSnackbarData?.dismiss()
    val undone = withTimeoutOrNull(undoFor) {
        snackbar.say("Moved “$title” to Trash", SnackbarTone.Trash, actionLabel = "Undo", duration = SnackbarDuration.Indefinite)
    } == SnackbarResult.ActionPerformed
    if (undone) store.restoreFromTrash(noteId)
    requestSync()
}

/** How long the server keeps a deleted folder in Trash (A560, the notes' 30 days). */
internal val FOLDER_TRASH_RETENTION_MS = TimeUnit.DAYS.toMillis(30)

private fun counted(count: Int, one: String, many: String) = "$count ${if (count == 1) one else many}"

/** What a deleted folder held, in the web's words (`folderContents`): "3 notes, 1 subfolder". */
internal fun folderContents(folder: TrashedFolderListed): String {
    val held = listOfNotNull(counted(folder.notes, "note", "notes"), folder.folders.takeIf { it > 0 }?.let { counted(it, "subfolder", "subfolders") })
        .joinToString(", ")
    return held
}

/**
 * Trash's folders as the screen shows them (T40 P9, NT25, A560), as the web's `DeletedFolderList`:
 * what each held, when and where from it was deleted, by whom (an agent with ✦), and its days left.
 * [folderName] names the folder it was in as this phone has it; null is the top level.
 */
internal fun trashFolders(listed: List<TrashedFolderListed>, folderName: (String) -> String?, now: Long): List<TrashFolderUi> =
    listed.sortedByDescending { it.deletedAt }.map { folder ->
        val left = ((folder.deletedAt + FOLDER_TRASH_RETENTION_MS - now + TimeUnit.DAYS.toMillis(1) - 1) / TimeUnit.DAYS.toMillis(1)).coerceAtLeast(0)
        val from = folder.parentId?.let { id -> folderName(id)?.let { "“$it”" } ?: "a deleted folder" } ?: "the top level"
        // The notes' chip (A574, A655): ✦ for an agent only, "(agent)" to TalkBack (A701).
        fun detail(by: String?) = "${folderContents(folder)} · Deleted ${shortWhen(folder.deletedAt, now)} from $from${by?.let { " by $it" }.orEmpty()} · $left ${if (left == 1L) "day" else "days"} left"
        TrashFolderUi(
            id = folder.id,
            name = folder.name,
            detail = detail(deletedByText(folder.deletedBy)),
            spoken = detail(deletedBySpoken(folder.deletedBy)),
        )
    }

/**
 * What a folder's Restore says, in the web's words (`restoredMessage`). Its parent gone, it says
 * where it came back (A757): [folderName] names that folder as this phone has it; the top
 * level; or, unknown here, "the nearest folder above it".
 */
internal fun restoredFolderMessage(name: String, result: RestoredFolder, folderName: (String) -> String? = { null }): String {
    if (!result.restored) return "“$name” is not in Trash any more."
    val parts = mutableListOf("Restored “$name”.")
    // Its parent gone, it came back in the nearest folder above it (A757).
    if (result.parentGone) {
        val where = when {
            result.parentId == null -> "at the top level"
            else -> folderName(result.parentId!!)?.ifBlank { "Untitled folder" }?.let { "in “$it”" }
        }
        parts += "The folder it was in is gone, so it is ${where ?: "in the nearest folder above it"}."
    }
    val skipped = result.skipped.size
    if (skipped > 0) {
        val one = skipped == 1
        parts += "${counted(skipped, "note was", "notes were")} moved or deleted since, so ${if (one) "it stays" else "they stay"} where ${if (one) "it is" else "they are"}."
    }
    return parts.joinToString(" ")
}

/**
 * Trash's folders (T40 P9, NT25, A560): the server's list, since the phone never reads the
 * workspace document, and Restore, which needs the server too. Offline, or against a server
 * from before the route, the list is empty and Trash's notes say why.
 */
class TrashFoldersModel(
    private val store: NoteStore,
    private val api: PenmossApi,
    private val requestSync: () -> Unit,
    scope: CoroutineScope? = null,
    private val now: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val work = scope ?: viewModelScope
    private val listed = MutableStateFlow<List<TrashedFolderListed>>(emptyList())
    private val state = MutableStateFlow(TrashFoldersUi())

    val ui: StateFlow<TrashFoldersUi> = combine(listed, store.observeFolders(), state) { folders, here, current ->
        val names = here.associate { it.id to it.name }
        current.copy(folders = trashFolders(folders, names::get, now()))
    }.stateIn(work, SharingStarted.Eagerly, TrashFoldersUi())

    fun load() {
        work.launch {
            try {
                listed.value = api.folderTrash()
            } catch (error: ApiException) {
            } catch (error: IOException) {
                // Offline: Trash's notes say so; there is nothing here to restore without Penmoss.
            }
        }
    }

    /** Restores [folder] with its subfolders and the notes still where its delete left them. */
    fun restore(folder: TrashFolderUi) {
        if (state.value.busy) return
        state.update { it.copy(busy = true, message = null) }
        work.launch {
            val said = try {
                restoreAndSay(folder)
            } catch (error: ApiException) {
                "Penmoss couldn’t restore “${folder.name}”: ${error.message?.trimEnd('.')}."
            } catch (error: IOException) {
                "Offline: restoring “${folder.name}” needs Penmoss. Try again once the phone is online."
            }
            state.update { it.copy(busy = false, message = said) }
        }
    }

    private suspend fun restoreAndSay(folder: TrashFolderUi): String {
        val result = api.restoreFolder(folder.id)
        listed.update { list -> list.filterNot { it.id == folder.id } }
        // The tree comes from the server: the folder and its notes show after this sync.
        requestSync()
        // Where it came back, named as this phone's tree has that folder (A757).
        val names = store.observeFolders().first().associate { it.id to it.name }
        return restoredFolderMessage(folder.name, result) { id -> names[id] }
    }

    fun messageShown() = state.update { it.copy(message = null) }
}

/** Trash (T40 P3a, NT13). */
internal fun NavGraphBuilder.trashRoutes(root: RootUi) {
    composable(TrashRoutes.TRASH) { entry ->
        TrashRoute(root.graph, onOpen = root::openNote, onBack = { root.nav.leave(entry) })
    }
}
