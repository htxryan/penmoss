package app.penmoss.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import app.penmoss.AppGraph
import app.penmoss.data.FolderEntity
import app.penmoss.data.Notebooks
import app.penmoss.ui.settings.SettingsIcons

/*
 * Notebooks on the phone (T43, A750–A756): the dialogs that turn a notebook back into a folder or
 * delete one. A git notebook offers no New notebook, Close or Turn into notebook (A912), so only a
 * folder already flagged a notebook has these.
 */

/** A notebook's icon, apart from a folder's (T43, A750): the web's bound book. */
val NotebookIcon: ImageVector get() = SettingsIcons.Notebook

/** What deleting a notebook says (A755): its notes go to Trash with it, never up. */
internal fun notebookDeleteText(notes: Int): String {
    val those = when (notes) {
        0 -> "It holds no notes."
        1 -> "Its note goes to Trash with it."
        else -> "Its $notes notes go to Trash with it."
    }
    // The web's words (T39 pass 3, A891).
    return "$those You can restore the notebook, notes and all, from Trash for 30 days."
}

/**
 * What Turn back into a folder says (A756, T43 review S6): its notes join the default notebook and
 * publish with its mirror; its own repository keeps its files, its mirroring paused, never deleted.
 */
internal fun notebookTurnBackText(defaultName: String): String =
    "It becomes a folder in $defaultName. Its notes join $defaultName and show wherever $defaultName is open. Nothing is deleted."

/** What a notebook change says, once done or refused. */
internal fun notebookFlagSaid(name: String, on: Boolean, flag: app.penmoss.data.NoteStore.NotebookFlag): String = when {
    flag.refusal != null -> flag.refusal
    !flag.changed -> if (on) "“$name” is a notebook already" else "“$name” is a folder already"
    on -> "“$name” is now a notebook"
    else -> "“$name” is a folder again"
}

/** Deletes a notebook (A755): says that its notes go to Trash with it. */
@Composable
fun NotebookDeleteDialog(name: String, notes: Int, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete the notebook “${name.ifBlank { "Untitled folder" }}”?") },
        text = { Text(notebookDeleteText(notes)) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("notebookDeleteConfirm")) { Text("Delete Notebook", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Turns a notebook back into a folder (A756), after saying where its notes then publish. */
@Composable
fun NotebookTurnBackDialog(name: String, defaultName: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Turn “${name.ifBlank { "Untitled folder" }}” back into a folder?") },
        text = { Text(notebookTurnBackText(defaultName)) },
        confirmButton = { TextButton(onClick = onConfirm, modifier = Modifier.testTag("notebookTurnBackConfirm")) { Text("Turn into a Folder") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Turns a folder into a notebook or back (A756). */
suspend fun setNotebookAndSay(graph: AppGraph, id: String, name: String, on: Boolean): String {
    val flag = graph.store.setNotebook(id, on)
    if (flag.changed) graph.sync.requestSync()
    return notebookFlagSaid(name, on, flag)
}

/** The notebook a note filed in [folderId] is in, by name; null for the default notebook (T43). */
internal fun noteNotebookName(folders: List<FolderEntity>, folderId: String?): String? {
    val id = Notebooks.index(folders).ofFolder(folderId) ?: return null
    return folders.firstOrNull { it.id == id }?.name?.ifBlank { "Untitled folder" }
}

/** Under a note's folder path: the notebook it is in, when not the default (T43, A752). */
@Composable
internal fun NoteNotebookLine(name: String) {
    Text(
        "Notebook: $name",
        Modifier.testTag("noteNotebook"),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
    )
}
