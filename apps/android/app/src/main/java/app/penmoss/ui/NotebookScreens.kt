package app.penmoss.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.square.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.data.FolderEntity
import app.penmoss.data.Notebooks
import app.penmoss.ui.settings.GroupTitle
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen
import app.penmoss.ui.settings.SettingsIcons
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/*
 * Notebooks on the phone (T43, A750–A756): the dialogs that turn a folder into a notebook and
 * back or delete one, and Settings → Notebooks, where each is opened or closed on this phone
 * (A752) and the default notebook is named (A751).
 */

/** A notebook's icon, apart from a folder's (T43, A750): the web's bound book. */
val NotebookIcon: ImageVector get() = SettingsIcons.Notebook

internal object NotebookRoutes {
    const val SETTINGS = "settings/notebooks"
}

/** What Settings' Notebooks row says (T43): the default notebook's name, and how many are open. */
internal fun notebooksSummary(defaultName: String, notebooks: Int, closed: Int): String = when {
    notebooks == 0 -> "$defaultName · no other notebooks"
    closed == 0 -> "$defaultName and ${if (notebooks == 1) "1 notebook" else "$notebooks notebooks"}"
    else -> "$defaultName and ${notebooks - closed} of $notebooks notebooks open on this phone"
}

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

/** One notebook's row in Settings → Notebooks. */
@Immutable
data class NotebookRowUi(val id: String, val name: String, val open: Boolean)

/** Settings → Notebooks' rows: the default first (always open), then each notebook in order. */
internal fun notebookRows(folders: List<FolderEntity>, closed: Set<String>, defaultName: String): List<NotebookRowUi> =
    listOf(NotebookRowUi(Notebooks.DEFAULT, defaultName, open = true)) +
        Notebooks.index(folders).notebooks.map { NotebookRowUi(it.id, it.name.ifBlank { "Untitled folder" }, it.id !in closed) }

/**
 * Settings → Notebooks (T43, A751, A752): a switch per notebook, "Open on this phone", which
 * Recent, the switcher, search, tags and the graph follow; the default notebook's is always on.
 * The default notebook's name is changed here for every device.
 */
@Composable
fun NotebooksScreen(
    rows: List<NotebookRowUi>,
    defaultName: String,
    onOpen: (id: String, open: Boolean) -> Unit,
    onRenameDefault: (String) -> Unit,
    onBack: () -> Unit,
    /** New notebook, as the web's Settings → Notebooks has it (T39 pass 3, A897); null: none here. */
    onNewNotebook: ((String) -> Unit)? = null,
) {
    var naming by rememberSaveable { mutableStateOf(false) }
    var making by rememberSaveable { mutableStateOf(false) }
    SectionScreen("Notebooks", onBack) {
        Help(
            "A notebook keeps its own notes apart, and can be mirrored to its own repository. Close one on this phone and " +
                "Recent, search, tags and the graph leave it out; a link into it still opens the note.",
        )
        GroupTitle("Open on this phone")
        for (row in rows) {
            val fixed = row.id == Notebooks.DEFAULT
            ListItem(
                headlineContent = { Text(row.name) },
                supportingContent = { Text(if (fixed) "The default notebook: always open" else if (row.open) "Open on this phone" else "Closed on this phone") },
                leadingContent = { androidx.compose.material3.Icon(NotebookIcon, contentDescription = null, tint = MaterialTheme.colorScheme.primary) },
                trailingContent = { Switch(checked = row.open, onCheckedChange = null, enabled = !fixed) },
                modifier = Modifier
                    .testTag("notebookOpen-${row.id}")
                    .toggleable(value = row.open, enabled = !fixed, role = Role.Switch) { onOpen(row.id, it) },
            )
        }
        if (onNewNotebook != null) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                OutlinedButton(onClick = { making = true }, modifier = Modifier.testTag("settingsNewNotebook")) { Text("New Notebook") }
            }
        }
        GroupTitle("Default notebook")
        Help("Notes and folders outside any notebook, the Journal and the Inbox are in it. Its name shows on every device.")
        ListItem(
            headlineContent = { Text("Name") },
            supportingContent = { Text(defaultName, Modifier.testTag("defaultNotebookName")) },
        )
        Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            OutlinedButton(onClick = { naming = true }, modifier = Modifier.testTag("renameDefaultNotebook")) { Text("Rename") }
        }
    }
    if (making && onNewNotebook != null) {
        FolderNameDialog(
            title = "New Notebook",
            onConfirm = { name ->
                making = false
                onNewNotebook(name)
            },
            onDismiss = { making = false },
        )
    }
    if (naming) {
        DefaultNotebookNameDialog(
            initial = defaultName,
            onConfirm = {
                naming = false
                onRenameDefault(it)
            },
            onDismiss = { naming = false },
        )
    }
}

/** Names the default notebook (A751): blank gives back "Personal". */
@Composable
private fun DefaultNotebookNameDialog(initial: String, onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename the default notebook") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                modifier = Modifier.fillMaxWidth().testTag("defaultNotebookField"),
                singleLine = true,
                supportingText = { Text("Leave it empty for “${Notebooks.DEFAULT_NAME}”.") },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onConfirm(name.trim()) }),
            )
        },
        confirmButton = { TextButton(onClick = { onConfirm(name.trim()) }, modifier = Modifier.testTag("defaultNotebookSave")) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
internal fun NotebooksRoute(graph: AppGraph, onBack: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val rows by remember(graph) {
        combine(graph.store.observeFolders(), graph.closedNotebooks.closed, graph.store.observeDefaultNotebookName(), ::notebookRows)
    }.collectAsStateWithLifecycle(emptyList())
    val defaultName by remember(graph) { graph.store.observeDefaultNotebookName() }.collectAsStateWithLifecycle(Notebooks.DEFAULT_NAME)
    NotebooksScreen(
        rows = rows,
        defaultName = defaultName,
        onOpen = { id, open -> graph.closedNotebooks.setOpen(id, open) },
        onRenameDefault = { name ->
            graph.scope.launch {
                graph.store.renameDefaultNotebook(name)
                graph.sync.requestSync()
            }
        },
        onBack = onBack,
        onNewNotebook = { name: String ->
            graph.scope.launch {
                val said = createNotebookAndSay(graph, name)
                android.widget.Toast.makeText(context, said, android.widget.Toast.LENGTH_SHORT).show()
            }
            Unit
        }.takeUnless { graph.isGit },
    )
}

/**
 * What a folder's sheet and screen offer for notebooks (T43, A897, A912). A git notebook is one
 * notebook, a repository: there is no Settings → Notebooks in it to open a closed one again, and
 * nothing there to mirror or close apart, so neither Turn into notebook nor Close is offered in it.
 */
internal data class NotebookOffers(val turnInto: Boolean, val close: Boolean)

internal fun notebookOffers(folder: FolderItem, git: Boolean): NotebookOffers =
    NotebookOffers(turnInto = folder.canBeNotebook && !git, close = folder.notebook && !git)

/** What closing a notebook from its sheet says (A752), in the web's words (T39 pass 3, A897). */
internal fun notebookClosedMessage(name: String): String =
    "Closed “${name.ifBlank { "Untitled folder" }}” on this phone. Open it again in Settings → Notebooks."

/** Makes a notebook (A750), shown at once and sent with the next pass. */
suspend fun createNotebookAndSay(graph: AppGraph, name: String): String {
    graph.store.createNotebook(name)
    graph.sync.requestSync()
    return "Made the notebook “$name”."
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
