package app.penmoss.ui.folders

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.NotebookGraph
import app.penmoss.data.NoteStore
import app.penmoss.ui.common.FolderChoice
import app.penmoss.ui.common.Items
import app.penmoss.ui.common.Said
import app.penmoss.ui.common.SnackbarTone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.SerializationException
import java.io.IOException

/** The folder picker over the phone's tree (T38), offline too: the tree is in Room. */
@Composable
fun FolderPickerFor(graph: NotebookGraph, title: String, current: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val choices by remember {
        combine(graph.store.observeFolders(), graph.store.observeRootSortMode()) { folders, mode ->
            Items.folderChoices(mode, folders)
        }.flowOn(Dispatchers.Default)
    }.collectAsStateWithLifecycle(listOf(FolderChoice(null, Items.TOP_LEVEL, 0)))
    FolderPickerSheet(title, choices, current, onPick, onDismiss)
}

/** The folder picker for moving a folder: without the folder itself and its subfolders (T40 P4, NT5). */
@Composable
fun FolderPickerForMove(graph: NotebookGraph, title: String, current: String?, exclude: String, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val choices by remember(exclude) {
        combine(graph.store.observeFolders(), graph.store.observeRootSortMode()) { folders, mode ->
            Items.folderChoicesExcluding(mode, folders, exclude)
        }.flowOn(Dispatchers.Default)
    }.collectAsStateWithLifecycle(listOf(FolderChoice(null, Items.TOP_LEVEL, 0)))
    FolderPickerSheet(title, choices, current?.takeIf { id -> choices.any { it.id == id } }, onPick, onDismiss)
}

/**
 * Moves a note on this phone and has it filed on the server when it can be (T38): at once
 * online, after the next pass that reaches Penmoss offline. Returns what to tell the person.
 */
suspend fun moveNoteAndSay(graph: NotebookGraph, noteId: String, folderId: String?): Said {
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
internal fun oneMoveSaid(result: NoteStore.Move, name: String): Said = when (result) {
    NoteStore.Move.MOVED -> Said("Moved to $name.", SnackbarTone.Done)
    NoteStore.Move.ALREADY_THERE -> Said("Already in $name.", SnackbarTone.Info)
    NoteStore.Move.REFUSED -> Said("This note can't be moved.", SnackbarTone.Error)
    NoteStore.Move.NO_FOLDER -> Said(FOLDER_GONE, SnackbarTone.Error)
}

/** What a folder action says when the folder has gone from the phone meanwhile. */
private const val FOLDER_GONE = "That folder isn't on this phone any more."

/**
 * Folder actions on this phone (T40 P4, NT2–NT7): each shows at once and is queued to the
 * server, offline too; the pass is asked for now. Returns what to tell the person.
 */
suspend fun createFolderAndSay(graph: NotebookGraph, name: String, parentId: String?): Said {
    val id = graph.store.createFolder(name, parentId)
    if (id != null) graph.sync.requestSync()
    return if (id == null) Said("That folder isn't on this phone yet.", SnackbarTone.Error) else Said("Made the folder “$name”.", SnackbarTone.Done)
}

suspend fun renameFolderAndSay(graph: NotebookGraph, id: String, name: String): Said {
    val ok = graph.store.renameFolder(id, name)
    if (ok) graph.sync.requestSync()
    return if (ok) Said("Renamed to “$name”.", SnackbarTone.Done) else Said(FOLDER_GONE, SnackbarTone.Error)
}

suspend fun moveFolderAndSay(graph: NotebookGraph, id: String, parentId: String?): Said {
    val result = graph.store.moveFolder(id, parentId)
    if (result == NoteStore.FolderMove.MOVED) graph.sync.requestSync()
    val name = parentId?.let { pid -> graph.store.observeFolders().first().firstOrNull { it.id == pid }?.name?.ifBlank { null } }
        ?: if (parentId == null) Items.TOP_LEVEL else "the folder"
    return when (result) {
        NoteStore.FolderMove.MOVED -> Said("Moved to $name.", SnackbarTone.Done)
        NoteStore.FolderMove.ALREADY_THERE -> Said("Already in $name.", SnackbarTone.Info)
        NoteStore.FolderMove.REFUSED -> Said("That folder can't move there.", SnackbarTone.Error)
    }
}

/** What a delete says, in the web's words: the folder waits in Trash since T42 (A560). */
internal fun folderDeletedMessage(name: String?): String =
    "Moved ${name?.let { "“${it.ifBlank { "Untitled folder" }}”" } ?: "the folder"} to Trash. Its notes moved up."

suspend fun deleteFolderAndSay(graph: NotebookGraph, id: String, name: String? = null): Said {
    val ok = graph.store.deleteFolder(id)
    if (ok) graph.sync.requestSync()
    return if (!ok) Said(FOLDER_GONE, SnackbarTone.Error) else Said(folderDeletedMessage(name), SnackbarTone.Trash)
}

suspend fun sortFolderAndSay(graph: NotebookGraph, id: String?, mode: String): Said {
    val ok = graph.store.setSortMode(id, mode)
    if (ok) graph.sync.requestSync()
    if (!ok) return Said(FOLDER_GONE, SnackbarTone.Error)
    val sorted = when (mode) {
        "alpha" -> "Sorted A–Z."
        "modified" -> "Sorted by last modified."
        else -> "Sorted by hand."
    }
    return Said(sorted, SnackbarTone.Done)
}

suspend fun reorderFolderAndSay(graph: NotebookGraph, id: String, before: String?, after: String?) {
    if (graph.store.reorderFolder(id, before, after)) graph.sync.requestSync()
}

suspend fun reorderNoteAndSay(graph: NotebookGraph, id: String, before: String?, after: String?) {
    if (graph.store.reorderNote(id, before, after)) graph.sync.requestSync()
}

/**
 * Refreshes the tag suggestions from `/api/tags` (T38) when the tag sheet opens; offline, the
 * last list stays. A refused token is left for sync to notice.
 */
suspend fun refreshTagList(graph: NotebookGraph) {
    try {
        graph.store.saveTagList(graph.api.tags())
    } catch (offline: IOException) {
        // Offline, or the server said no: the cached list serves.
    } catch (unreadable: SerializationException) {
        // A reply this version cannot read: the cached list serves.
    }
}
