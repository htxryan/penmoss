package app.penmoss.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.data.NoteStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.SerializationException
import java.io.IOException

/** The folder picker over the phone's tree (T38), offline too: the tree is in Room. */
@Composable
fun FolderPickerFor(graph: AppGraph, title: String, current: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val choices by remember {
        combine(graph.store.observeFolders(), graph.store.observeRootSortMode(), graph.store.observeDefaultNotebookName()) { folders, mode, name ->
            Items.folderChoices(mode, folders, name)
        }.flowOn(Dispatchers.Default)
    }.collectAsStateWithLifecycle(listOf(FolderChoice(null, Items.TOP_LEVEL, 0)))
    FolderPickerSheet(title, choices, current, onPick, onDismiss)
}

/** The folder picker for moving a folder: without the folder itself and its subfolders (T40 P4, NT5). */
@Composable
fun FolderPickerForMove(graph: AppGraph, title: String, current: String?, exclude: String, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val choices by remember(exclude) {
        combine(graph.store.observeFolders(), graph.store.observeRootSortMode(), graph.store.observeDefaultNotebookName()) { folders, mode, name ->
            Items.folderChoicesExcluding(mode, folders, exclude, name)
        }.flowOn(Dispatchers.Default)
    }.collectAsStateWithLifecycle(listOf(FolderChoice(null, Items.TOP_LEVEL, 0)))
    FolderPickerSheet(title, choices, current?.takeIf { id -> choices.any { it.id == id } }, onPick, onDismiss)
}

/**
 * Moves a note on this phone and has it filed on the server when it can be (T38): at once
 * online, after the next pass that reaches Penmoss offline. Returns what to tell the person.
 */
suspend fun moveNoteAndSay(graph: AppGraph, noteId: String, folderId: String?): String {
    val result = graph.store.moveNote(noteId, folderId)
    if (result == NoteStore.Move.MOVED) graph.sync.requestSync()
    val name = folderId?.let { id -> graph.store.observeFolders().first().firstOrNull { it.id == id }?.name?.ifBlank { null } }
        ?: if (folderId == null) Items.TOP_LEVEL else "the folder"
    return oneMoveSaid(result, name)
}

/**
 * What one note's move says (T38), with [name] for where it went. A folder gone from the phone is
 * said as that (#137, A658); its name went with it.
 */
internal fun oneMoveSaid(result: NoteStore.Move, name: String): String = when (result) {
    NoteStore.Move.MOVED -> "Moved to $name"
    NoteStore.Move.ALREADY_THERE -> "Already in $name"
    NoteStore.Move.REFUSED -> "This note can't be moved"
    NoteStore.Move.NO_FOLDER -> "That folder isn't on this phone any more"
}

/**
 * Folder actions on this phone (T40 P4, NT2–NT7): each shows at once and is queued to the
 * server, offline too; the pass is asked for now. Returns what to tell the person.
 */
suspend fun createFolderAndSay(graph: AppGraph, name: String, parentId: String?): String {
    val id = graph.store.createFolder(name, parentId)
    if (id != null) graph.sync.requestSync()
    return if (id == null) "That folder isn't on this phone yet" else "Made “$name”"
}

suspend fun renameFolderAndSay(graph: AppGraph, id: String, name: String): String {
    val ok = graph.store.renameFolder(id, name)
    if (ok) graph.sync.requestSync()
    return if (ok) "Renamed to “$name”" else "That folder isn't on this phone anymore"
}

suspend fun moveFolderAndSay(graph: AppGraph, id: String, parentId: String?): String {
    val result = graph.store.moveFolder(id, parentId)
    if (result == NoteStore.FolderMove.MOVED) graph.sync.requestSync()
    val name = parentId?.let { pid -> graph.store.observeFolders().first().firstOrNull { it.id == pid }?.name?.ifBlank { null } }
        ?: if (parentId == null) Items.TOP_LEVEL else "the folder"
    return when (result) {
        NoteStore.FolderMove.MOVED -> "Moved to $name"
        NoteStore.FolderMove.ALREADY_THERE -> "Already in $name"
        NoteStore.FolderMove.REFUSED -> "That folder can't move there"
        NoteStore.FolderMove.NOTEBOOK_RULE -> graph.store.observeFolders().first().firstOrNull { it.id == id }
            ?.let { if (it.notebook) app.penmoss.data.Notebooks.STAYS_AT_TOP else app.penmoss.data.Notebooks.JOURNAL_STAYS } ?: "That folder can't move there"
    }
}

/** What a delete says, in the web's words: the folder waits in Trash since T42 (A560). */
internal fun folderDeletedMessage(name: String?): String =
    "Moved ${name?.let { "“${it.ifBlank { "Untitled folder" }}”" } ?: "the folder"} to Trash. Its notes moved up."

/** What a notebook's delete says (T43, A755): its notes went to Trash with it. */
internal fun notebookDeletedMessage(name: String?): String =
    "Moved the notebook ${name?.let { "“${it.ifBlank { "Untitled folder" }}”" } ?: ""} and its notes to Trash.".replace("  ", " ")

suspend fun deleteFolderAndSay(graph: AppGraph, id: String, name: String? = null, notebook: Boolean = false): String {
    val ok = graph.store.deleteFolder(id)
    if (ok) graph.sync.requestSync()
    return if (!ok) "That folder isn't on this phone anymore" else if (notebook) notebookDeletedMessage(name) else folderDeletedMessage(name)
}

suspend fun sortFolderAndSay(graph: AppGraph, id: String?, mode: String): String {
    val ok = graph.store.setSortMode(id, mode)
    if (ok) graph.sync.requestSync()
    if (!ok) return "That folder isn't on this phone anymore"
    return when (mode) {
        "alpha" -> "Sorted A–Z"
        "modified" -> "Sorted by last modified"
        else -> "Sorted by hand"
    }
}

suspend fun reorderFolderAndSay(graph: AppGraph, id: String, before: String?, after: String?) {
    if (graph.store.reorderFolder(id, before, after)) graph.sync.requestSync()
}

suspend fun reorderNoteAndSay(graph: AppGraph, id: String, before: String?, after: String?) {
    if (graph.store.reorderNote(id, before, after)) graph.sync.requestSync()
}

/**
 * Refreshes the tag suggestions from `/api/tags` (T38) when the tag sheet opens; offline, the
 * last list stays. A refused token is left for sync to notice.
 */
suspend fun refreshTagList(graph: AppGraph) {
    try {
        graph.store.saveTagList(graph.api.tags())
    } catch (offline: IOException) {
        // Offline, or the server said no: the cached list serves.
    } catch (unreadable: SerializationException) {
        // A reply this version cannot read: the cached list serves.
    }
}
