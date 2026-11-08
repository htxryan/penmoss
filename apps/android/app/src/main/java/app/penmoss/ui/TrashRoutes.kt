package app.penmoss.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import app.penmoss.AppGraph
import app.penmoss.data.NoteEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.RestoreQuestion
import app.penmoss.data.TrashRow
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.FolderDeleter
import app.penmoss.engine.api.PenmossPurgeApi
import app.penmoss.engine.api.PenmossApi
import app.penmoss.engine.api.RestoredFolder
import app.penmoss.engine.api.TrashListed
import app.penmoss.engine.api.TrashedFolderListed
import app.penmoss.engine.git.OwnerWords
import app.penmoss.git.GraphSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit

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
    /** The server is from before moves to Trash from the phone: those waiting say so (A430). */
    routeMissing: Boolean = false,
): List<TrashEntryUi> {
    // Notes that went to Trash with a notebook come back with it (T43, A755): the folder list
    // shows the notebook, so they are not listed here on their own.
    val withNotebook = remote.filter { it.withNotebook }.mapTo(HashSet()) { it.id } +
        local.filter { it.trashChange == NoteEntity.TRASH_WITH_NOTEBOOK }.map { it.id }
    val listed = remote.filterNot { it.id in withNotebook }.associateBy { it.id }
    val ours = local.filterNot { it.id in withNotebook }.map { row ->
        val waiting = row.trashChange == NoteEntity.TRASH_QUEUED || row.trashChange == NoteEntity.TRASH_SENDING
        val deletedAt = listed[row.id]?.deletedAt?.takeIf { it > 0 } ?: when {
            waiting || row.trashChange == NoteEntity.TRASH_SENT -> row.trashChangeAt
            else -> row.updatedAt
        }
        entry(row.id, row.title.ifBlank { listed[row.id]?.title.orEmpty() }, deletedAt, waiting, now, routeMissing, listed[row.id]?.deletedBy)
    }
    val known = local.mapTo(HashSet()) { it.id }
    val theirs = remote.filter { it.id !in known && it.id !in withNotebook }.map { entry(it.id, it.title, it.deletedAt, waiting = false, now, routeMissing, it.deletedBy) }
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

private fun entry(id: String, title: String, deletedAt: Long, waiting: Boolean, now: Long, routeMissing: Boolean, deletedBy: FolderDeleter? = null): TrashEntryUi {
    val left = deletedAt + TRASH_RETENTION_MS - now
    val days = ((left + TimeUnit.DAYS.toMillis(1) - 1) / TimeUnit.DAYS.toMillis(1)).coerceAtLeast(0)
    fun detail(by: String) = when {
        waiting && routeMissing -> "Moved to Trash on this phone · Penmoss can’t take it until its server is updated"
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

    val ui: StateFlow<TrashUi> = combine(store.observeTrash(), remote, state, store.observeTrashRouteMissing()) { local, listed, current, missing ->
        current.copy(entries = trashEntries(local, listed, now(), missing), routeMissing = missing)
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
            val said = if (ui.value.routeMissing) {
                "Penmoss can’t take moves to Trash until its server is updated, so “${entry.title}” can’t be deleted for good yet. Restore it to keep it on this phone."
            } else {
                requestSync()
                "Its move to Trash hasn’t reached Penmoss yet. Try again once the phone has synced."
            }
            state.update { it.copy(message = said) }
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

    // --- a restore the server could not place (T43, A757: fail closed) ---

    /** Deleted folders' ids in Trash, read when a question names a notebook; null: not read. */
    private val foldersInTrash = MutableStateFlow<Set<String>?>(null)
    private val answering = MutableStateFlow(false)

    /**
     * The first restore waiting for the person (409 `restore_needs_folder`): its notebook is
     * offered to restore first only while Penmoss lists it in Trash.
     */
    val asking: StateFlow<RestoreAskUi?> = combine(store.observeRestoreQuestions(), foldersInTrash, answering) { questions, trashed, busy ->
        questions.firstOrNull()?.let { restoreAsk(it, trashed, busy) }
    }.stateIn(work, SharingStarted.Eagerly, null)

    init {
        work.launch {
            store.observeRestoreQuestions().map { list -> list.firstOrNull()?.notebookId }.distinctUntilChanged().collect { notebook ->
                if (notebook != null) readFoldersInTrash()
            }
        }
    }

    private suspend fun readFoldersInTrash() {
        foldersInTrash.value = try {
            api.folderTrash().mapTo(HashSet()) { it.id }
        } catch (error: ApiException) {
            emptySet()
        } catch (error: IOException) {
            // Offline: the notebook is not offered; choosing a folder needs Penmoss too.
            emptySet()
        }
    }

    /**
     * (a) Restores the notebook the note was in (`POST /api/folders/:id/restore`), then the note
     * again: queued as any restore, so the next pass files it where it was deleted from.
     */
    fun restoreNotebookFirst(ask: RestoreAskUi) {
        val notebook = ask.notebook ?: return
        if (answering.value) return
        answering.value = true
        work.launch {
            val said = try {
                api.restoreFolder(notebook.id)
                store.restoreQuestionAnswered(ask.noteId)
                store.restoreFromTrash(ask.noteId, ask.title)
                requestSync()
                "Restored the notebook “${notebook.name}”. “${ask.title}” goes back where it was with the next sync."
            } catch (error: ApiException) {
                "Penmoss couldn’t restore the notebook “${notebook.name}”: ${error.message?.trimEnd('.')}."
            } catch (error: IOException) {
                "Offline: restoring the notebook “${notebook.name}” needs Penmoss. Try again once the phone is online."
            } finally {
                answering.value = false
            }
            state.update { it.copy(message = said) }
        }
    }

    /**
     * (b) Restores the note into the folder the person chose ([folderId]; null: the top level),
     * sent as `{ folderId }`: the server restores it there, and the next pass files it.
     */
    fun restoreInto(ask: RestoreAskUi, folderId: String?, folderName: String) {
        if (answering.value) return
        answering.value = true
        work.launch {
            val said = try {
                val restored = api.restoreNote(ask.noteId, app.penmoss.engine.api.InFolder(folderId))
                store.restoredInto(ask.noteId, restored.folderId, restored.restored, restored.seq)
                requestSync()
                remote.update { list -> list.filterNot { it.id == ask.noteId } }
                "Restored “${ask.title}” to $folderName."
            } catch (error: ApiException) {
                when {
                    error.noSuchNote -> {
                        store.restoreQuestionAnswered(ask.noteId)
                        store.trashGone(ask.noteId)
                        "“${ask.title}” is not in Trash any more."
                    }
                    else -> "Penmoss couldn’t restore “${ask.title}”: ${error.message?.trimEnd('.')}."
                }
            } catch (error: IOException) {
                "Offline: restoring “${ask.title}” needs Penmoss. Try again once the phone is online."
            } finally {
                answering.value = false
            }
            state.update { it.copy(message = said) }
        }
    }

    /** (c) Cancel: the note stays in Trash, and is not asked about again. */
    fun leaveInTrash(ask: RestoreAskUi) {
        work.launch {
            store.restoreQuestionAnswered(ask.noteId)
            state.update { it.copy(message = "“${ask.title}” stays in Trash.") }
        }
    }
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

/** A restore the server could not place, as Trash asks it (T43, A757). */
data class RestoreAskUi(
    val noteId: String,
    val title: String,
    /** Why, in the server's words. */
    val message: String,
    /** The deleted notebook to restore first, while Penmoss has it in Trash; else null. */
    val notebook: NotebookInTrash?,
    val busy: Boolean = false,
)

/** A deleted notebook a restore can bring back first (T43, A757). */
data class NotebookInTrash(val id: String, val name: String)

internal fun restoreAsk(question: RestoreQuestion, foldersInTrash: Set<String>?, busy: Boolean = false): RestoreAskUi = RestoreAskUi(
    noteId = question.noteId,
    title = titleOf(question.title),
    message = question.message.trim().ifEmpty { "The folder it was deleted from is gone" }.trimEnd('.') + ".",
    notebook = question.notebookId?.takeIf { foldersInTrash?.contains(it) == true }
        ?.let { NotebookInTrash(it, question.notebookName.ifBlank { "Untitled folder" }) },
    busy = busy,
)

/** What to say when a note was not deleted for good: the notebook's reason, or offline. */
internal fun purgeFailure(error: Exception): String = when (error) {
    is ApiException -> "Not done: ${error.message?.trim()?.removeSuffix(".") ?: "Penmoss refused it"}."
    is java.io.IOException -> "Not done: the notebook couldn’t be reached. Try again in a moment."
    else -> "Not done: ${error.message ?: error::class.simpleName}."
}

@Composable
internal fun TrashRoute(graph: AppGraph, onOpen: (String) -> Unit, onBack: () -> Unit) {
    val model = viewModel {
        TrashModel(
            graph.store,
            graph.api,
            graph.purge,
            requestSync = { graph.sync.requestSync() },
            git = graph.source is GraphSource.Git,
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
    val asking by model.asking.collectAsStateWithLifecycle()
    /** Choosing a folder for a restore Penmoss could not place (T43, A757). */
    var choosingFor by remember { mutableStateOf<RestoreAskUi?>(null) }
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
    val ask = asking
    if (ask != null && choosingFor == null) {
        RestoreNeedsFolderDialog(
            ask,
            onRestoreNotebook = { model.restoreNotebookFirst(ask) },
            onChooseFolder = { choosingFor = ask },
            onCancel = { model.leaveInTrash(ask) },
        )
    }
    choosingFor?.let { picking ->
        // The Move sheet's picker, over the phone's tree (T38).
        FolderPickerFor(
            graph,
            title = "Restore “${picking.title}” to…",
            current = null,
            onPick = { folder ->
                choosingFor = null
                graph.scope.launch {
                    val name = folder?.let { id -> graph.store.observeFolders().first().firstOrNull { it.id == id }?.name?.ifBlank { null } }
                        ?: if (folder == null) Items.TOP_LEVEL else "the folder"
                    model.restoreInto(picking, folder, name)
                }
            },
            onDismiss = { choosingFor = null },
        )
    }
    folderUi.asking?.let { folderAsk ->
        FolderRestoreAskDialog(
            folderAsk,
            busy = folderUi.busy,
            onRestoreNotebook = { folders.restoreNotebookFirst(folderAsk) },
            onCancel = { folders.leaveInTrash(folderAsk) },
        )
    }
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
        snackbar.showSnackbar(noneToTrash(1))
        return@launch
    }
    // A snackbar still showing (an earlier move's Undo) goes now, so this one gets its whole
    // time rather than waiting behind it; that earlier move simply stays in Trash.
    snackbar.currentSnackbarData?.dismiss()
    val undone = withTimeoutOrNull(undoFor) {
        snackbar.showSnackbar("Moved “$title” to Trash", actionLabel = "Undo", duration = SnackbarDuration.Indefinite)
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
    // A notebook went with its notes, which come back with it (T43, A755).
    return if (folder.notebook) "Notebook · $held" else held
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

/** A folder's restore the server refused for want of a safe place (T43, A757), as Trash asks it. */
data class FolderRestoreAsk(val folder: TrashFolderUi, val notebook: NotebookInTrash?, val text: String)

/** Why a folder's Restore waits (409 `restore_needs_folder`): its notebook is in Trash, or gone. */
internal fun folderRestoreAskText(name: String, notebook: String?): String =
    if (notebook != null) "“$name” was in the notebook “${notebook.ifBlank { "Untitled folder" }}”, which is in Trash. Restore the notebook first to bring “$name” back into it."
    else "The folder “$name” was in is gone, and so is the notebook it was in, so Penmoss won’t guess where it goes."

/**
 * What a folder's Restore says, in the web's words (`restoredMessage`). Its parent gone, it says
 * where it came back (T43, A757): [folderName] names that folder as this phone has it; the top
 * level; or, unknown here or unsaid by an older server, "the nearest folder above it".
 */
internal fun restoredFolderMessage(name: String, result: RestoredFolder, folderName: (String) -> String? = { null }): String {
    if (!result.restored) return "“$name” is not in Trash any more."
    // A notebook comes back with its notes (T43, A755), at the top level, where notebooks live.
    if (result.notebook) return "Restored the notebook “$name” and ${counted(result.notes, "note", "notes")}."
    val parts = mutableListOf("Restored “$name”.")
    // Its parent gone, it came back in the nearest folder above it within its notebook (A757).
    if (result.parentGone) {
        val where = when {
            !result.parentKnown -> null
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

    /**
     * Restores [folder] with its subfolders and the notes still where its delete left them. Its
     * parent gone and its way up through a deleted notebook (409 `restore_needs_folder`, T43
     * A757), nothing is restored: Trash asks to restore that notebook first, or to leave it.
     */
    fun restore(folder: TrashFolderUi) {
        if (state.value.busy) return
        state.update { it.copy(busy = true, message = null, asking = null) }
        work.launch {
            var asking: FolderRestoreAsk? = null
            val said = try {
                restoreAndSay(folder)
            } catch (error: ApiException) {
                if (error.code == "restore_needs_folder") {
                    val notebook = error.notebook?.takeIf { nb -> listed.value.any { it.id == nb.id } }
                    asking = FolderRestoreAsk(folder, notebook?.let { NotebookInTrash(it.id, it.name.ifBlank { "Untitled folder" }) }, folderRestoreAskText(folder.name, error.notebook?.name))
                    null
                } else {
                    "Penmoss couldn’t restore “${folder.name}”: ${error.message?.trimEnd('.')}."
                }
            } catch (error: IOException) {
                "Offline: restoring “${folder.name}” needs Penmoss. Try again once the phone is online."
            }
            state.update { it.copy(busy = false, message = said, asking = asking) }
        }
    }

    private suspend fun restoreAndSay(folder: TrashFolderUi): String {
        val result = api.restoreFolder(folder.id)
        listed.update { list -> list.filterNot { it.id == folder.id } }
        // The tree comes from the server: the folder and its notes show after this sync.
        requestSync()
        // Where it came back, named as this phone's tree has that folder (T43, A757).
        val names = store.observeFolders().first().associate { it.id to it.name }
        return restoredFolderMessage(folder.name, result) { id -> names[id] }
    }

    /** Restores the notebook a folder was in (T43, A757), then the folder again. */
    fun restoreNotebookFirst(ask: FolderRestoreAsk) {
        val notebook = ask.notebook ?: return
        if (state.value.busy) return
        state.update { it.copy(busy = true, message = null, asking = null) }
        work.launch {
            val said = try {
                api.restoreFolder(notebook.id)
                listed.update { list -> list.filterNot { it.id == notebook.id } }
                "Restored the notebook “${notebook.name}”. " + restoreAndSay(ask.folder)
            } catch (error: ApiException) {
                "Penmoss couldn’t restore “${notebook.name}”: ${error.message?.trimEnd('.')}."
            } catch (error: IOException) {
                "Offline: restoring “${notebook.name}” needs Penmoss. Try again once the phone is online."
            }
            state.update { it.copy(busy = false, message = said) }
        }
    }

    /** Cancel: the folder stays in Trash. */
    fun leaveInTrash(ask: FolderRestoreAsk) = state.update { it.copy(asking = null, message = "“${ask.folder.name}” stays in Trash.") }

    fun messageShown() = state.update { it.copy(message = null) }
}
