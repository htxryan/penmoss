package app.penmoss.ui

import kotlinx.coroutines.CoroutineScope
import androidx.compose.runtime.rememberCoroutineScope
import android.content.Context
import android.net.Uri
import android.view.Window
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import app.penmoss.NotebookGraph
import app.penmoss.data.NoteStore
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.feedback.FeedbackRoutes
import app.penmoss.feedback.FeedbackWhere
import app.penmoss.feedback.NoteExtras
import app.penmoss.feedback.WhereFacts
import app.penmoss.feedback.feedbackActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * What a git notebook's screens share (A6): the navigation, the snackbar over every screen, the
 * lists' selection, and the app-wide dialogs (the folder picker, a note's and a folder's actions,
 * naming, deleting and turning back a folder). The routes ([homeRoutes], [folderRoutes] and the
 * rest) take it instead of a lambda for each of these; [RootDialogs] draws the dialogs it holds.
 */
@Stable
internal class RootUi(
    val graph: NotebookGraph,
    val nav: NavHostController,
    val context: Context,
    /** The lists' selection mode (T42 on Android, NT26, A652), which their rows join. */
    val selection: NoteSelection,
    /** The window feedback captures (A801). */
    private val window: Window?,
    /**
     * The screens' own scope (A6): work they start only to show something (a folder looked up for
     * the picker, a copy, feedback's context) ends with them. Work the person asked for that must
     * finish if they leave meanwhile goes on the notebook's process scope ([keep]).
     */
    private val screenScope: CoroutineScope,
) {
    /** Says what happened to a note over every screen, with Undo (Move to Trash, NT12). */
    val snackbar = SnackbarHostState()

    /** The folder picker over every screen: for a new note, or to move a note. */
    var choosing by mutableStateOf<Choosing?>(null)

    /** A long press on a search result (T40 P3a, NT10): Move to folder…, Rename, Move to Trash. */
    var acting by mutableStateOf<NoteItem?>(null)

    /** A long press on a folder (T40 P4, NT3–NT5): rename it, make a subfolder, move or delete it. */
    var folderActing by mutableStateOf<FolderItem?>(null)

    /** Naming a folder made or renamed here (T40 P4, NT2, NT3). */
    var folderNaming by mutableStateOf<FolderNaming?>(null)

    /** Deleting a folder (T40 P4, NT4): counts what moves up. */
    var folderDeleting by mutableStateOf<FolderItem?>(null)

    /** Turning a notebook back into a folder (T43, A756): asked first. */
    var notebookTurningBack by mutableStateOf<FolderItem?>(null)

    /** Reordering the top level's folders (T40 P4, NT7). */
    var homeReordering by mutableStateOf(false)

    /** Reordering inside a folder (T40 P4, NT7): the folder, or null when not. */
    var folderReordering by mutableStateOf<String?>(null)

    /**
     * A write the person asked for, which finishes even if they leave the screen meanwhile: on
     * the notebook's process scope with its failure reported (A1467), on the main thread as
     * before, so its Toast shows.
     */
    private fun keep(block: suspend CoroutineScope.() -> Unit) = graph.launchReporting(Dispatchers.Main.immediate, block)

    fun openNote(id: String) = nav.open("note/$id")

    /** A link followed to a heading (T40 P7, LK3): the note opens there. */
    fun openNoteAt(id: String, heading: String?) = nav.open(noteRouteAt(id, heading))

    /** New note (T38): named here, made by the editor as its screen opens, offline too. */
    fun newNote(folder: String?) = nav.startNewNote(folder)

    /** Opens Today, a calendar day or a week's note: made by the editor page, offline too (T40 P5). */
    fun openPeriodic(kind: ToEditor.PeriodKind, day: String?) {
        // Today and This week go to the Journal notebook (T50 G7, A827): a git one opens there.
        nav.open(periodicNoteRoute(kind.wire, day))
    }

    /** A tag's notes (T40 P6, TG2): from Tags, and from a `#tag` tapped in a note (TG5). */
    fun openTag(tag: String) = nav.open("tag/${Uri.encode(tag)}")

    /** The breadcrumb's folder (T40 P4, NT11): back to Home for the top level, else the folder, leaving the note behind as the web navigates. */
    fun openFolderFromNote(folder: String?) {
        if (folder == null) nav.popBackStack("home", false)
        else nav.navigate("folder/$folder") { popUpTo("home") }
    }

    /** A long press on a note in a list starts selection mode (T42 on Android, NT26, A652). */
    fun startSelection(note: NoteItem) = selection.start(note)

    /** Opens the folder picker on the folder [note] is in. */
    fun moveFromList(note: NoteItem) {
        screenScope.launch { choosing = Choosing.Move(note.id, note.title, graph.store.folderOf(note.id)) }
    }

    /** Opens the folder picker for the notes chosen, marking the folder they share. */
    fun moveSelected(picked: List<Picked>) {
        screenScope.launch {
            val folders = picked.map { graph.store.folderOf(it.id) }.distinct()
            choosing = Choosing.MoveMany(picked, folders.toSet())
        }
    }

    // Outlives the screen: the move to Trash the person asked for, and its Undo, over every screen.
    fun trashNote(id: String) = graph.scope.moveToTrashWithUndo(graph.store, { graph.sync.requestSync() }, snackbar, id)

    // Outlives the screen, as one note's move to Trash does.
    fun trashNotes(ids: List<String>) = graph.scope.moveNotesToTrashWithUndo(graph.store, { graph.sync.requestSync() }, snackbar, ids)

    /** Copy Agent Reference from a list (T52 item 4): read from Room, said over every screen. */
    fun copyAgentReference(id: String) {
        screenScope.launch {
            val said = agentReferenceIn(graph, id)?.let { AgentReference.copy(context, it) }
                ?: "This note isn't on this phone any more"
            snackbar.currentSnackbarData?.dismiss()
            snackbar.say(said, if (said == AgentReference.COPIED) SnackbarTone.Done else SnackbarTone.Error)
        }
    }

    /** A new note beside [noteId], in its folder (T53 item 12). */
    fun newNoteBeside(noteId: String) {
        screenScope.launch { newNote(graph.store.folderOf(noteId)) }
    }

    /** A new folder beside [noteId], in its folder (T53 item 12). */
    fun newFolderBeside(noteId: String) {
        screenScope.launch { folderNaming = FolderNaming.Create(graph.store.folderOf(noteId)) }
    }

    /** Says what a folder action did, over every screen. */
    fun toast(message: String) = Toast.makeText(context, message, Toast.LENGTH_SHORT).show()

    fun turnBack(folder: FolderItem) {
        // Outlives the screen: a folder write the person asked for.
        keep { toast(setNotebookAndSay(graph, folder.id, folder.name, on = false)) }
    }

    fun createFolder(name: String, parent: String?) {
        // Outlives the screen: a folder write the person asked for.
        keep { toast(createFolderAndSay(graph, name, parent)) }
    }

    fun renameFolder(id: String, name: String) {
        // Outlives the screen: a folder write the person asked for.
        keep { toast(renameFolderAndSay(graph, id, name)) }
    }

    fun moveFolder(id: String, parent: String?) {
        // Outlives the screen: a folder write the person asked for.
        keep { toast(moveFolderAndSay(graph, id, parent)) }
    }

    fun sortFolder(id: String?, mode: String) {
        // Outlives the screen: a folder's sort order, written for the person.
        keep { toast(sortFolderAndSay(graph, id, mode)) }
    }

    fun reorderFolder(id: String, before: String?, after: String?) {
        // Outlives the screen: the order dragged, written for the person.
        keep { reorderFolderAndSay(graph, id, before, after) }
    }

    fun reorderNote(id: String, before: String?, after: String?) {
        // Outlives the screen: the order dragged, written for the person.
        keep { reorderNoteAndSay(graph, id, before, after) }
    }

    /** Deletes [folder] once the person has confirmed it (T40 P4, NT4): a notebook goes to Trash with its notes (T43, A755). */
    fun deleteFolder(folder: FolderItem, notebook: Boolean) {
        // Outlives the screen: a delete the person confirmed.
        keep { toast(if (notebook) deleteFolderAndSay(graph, folder.id, folder.name, notebook = true) else deleteFolderAndSay(graph, folder.id, folder.name)) }
    }

    /** Moves one note to [folder] (null: the top level), and says so. */
    fun moveNote(noteId: String, folder: String?) {
        // Outlives the screen: a move the person asked for.
        keep { toast(moveNoteAndSay(graph, noteId, folder)) }
    }

    /** Moves the notes chosen to [folder] (null: the top level) in one pick (A652), and says so. */
    fun moveNotes(picked: List<Picked>, folder: String?) {
        // Outlives the screen: a move the person asked for.
        keep {
            val name = folder?.let { id -> graph.store.observeFolders().first().firstOrNull { it.id == id }?.name?.ifBlank { null } }
                ?: if (folder == null) Items.TOP_LEVEL else "the folder"
            toast(moveNotesAndSay(graph.store, picked.map { it.id }, folder, name) { graph.sync.requestSync() })
        }
    }

    /** Asks before deleting [folderId] (T40 P4, NT4), as Room has it now. */
    fun askDeleteFolder(folderId: String) {
        screenScope.launch {
            folderDeleting = graph.store.observeFolders().first()
                .firstOrNull { it.id == folderId }
                ?.let { FolderItem(it.id, it.name, notebook = it.notebook) }
        }
    }

    /**
     * Send feedback (T49, D41): the screen in front and its context are captured first, then
     * the form opens over it (A801). [settle] waits for a screen closing to go first. On the
     * screens' scope: the form opens over them, so with them gone there is nothing to open.
     */
    fun openFeedback(from: String, noteId: String?, extras: NoteExtras?, panel: String?, settle: Long) {
        screenScope.launch {
            if (settle > 0) kotlinx.coroutines.delay(settle)
            val entry = nav.currentBackStackEntry
            val pattern = entry?.destination?.route
            val args = entry?.arguments
            val folderId = if (pattern?.startsWith("folder/") == true) args?.getString("id") else noteId?.let { graph.store.folderOf(it) }
            val where = WhereFacts(
                route = FeedbackWhere.route(pattern) { args?.getString(it) },
                screen = FeedbackWhere.screen(pattern),
                panel = panel,
                openedFrom = from,
                folderPath = graph.feedback.collector.folderPath(folderId),
                notebook = graph.feedback.collector.notebookName(folderId),
            )
            graph.feedback.open(where, noteId, extras, window) { nav.open(FeedbackRoutes.FORM) }
        }
    }
}

/** The screens' shared state (A6), for as long as [nav] shows [graph]'s screens. */
@Composable
internal fun rememberRootUi(graph: NotebookGraph, nav: NavHostController): RootUi {
    val context = LocalContext.current
    val selection = LocalNoteSelection.current ?: remember { NoteSelection() }
    val screenScope = rememberCoroutineScope()
    return remember(graph, nav, context, selection) { RootUi(graph, nav, context, selection, context.feedbackActivity()?.window, screenScope) }
}

/** What the folder picker over the screens is choosing (T38). */
internal sealed interface Choosing {
    /** A folder for a new note, starting from [current] (null: the top level). */
    data class NewNote(val current: String?) : Choosing

    /** Where to move a note, starting from where it is ([current]). */
    data class Move(val noteId: String, val title: String, val current: String?) : Choosing

    /** A parent for a folder: without the folder itself and its subfolders (T40 P4, NT5). */
    data class MoveFolder(val folderId: String, val title: String) : Choosing

    /**
     * Where to move the notes chosen in selection mode (A652), all in one pick; [shared] holds
     * the folders they are in (one: that folder is marked).
     */
    data class MoveMany(val picked: List<Picked>, val shared: Set<String?>) : Choosing
}

/** Marks no folder in the picker: the notes chosen are in several. */
private const val MIXED_FOLDERS = "\u0000several"

/** Naming a folder made or renamed here (T40 P4, NT2, NT3). */
internal sealed interface FolderNaming {
    /** A folder under [parentId] (null: the top level). */
    data class Create(val parentId: String?) : FolderNaming

    /** A new name for [id], starting from [current]; [notebook]: a notebook's (T43). */
    data class Rename(val id: String, val current: String, val notebook: Boolean = false) : FolderNaming
}

/**
 * What the screens hear over every screen (A6): a move to Trash or a folder change a restore or
 * the server overruled, the version having changed, and feedback once sent.
 */
@Composable
internal fun RootNotices(root: RootUi) {
    val graph = root.graph
    val context = root.context
    // A move to Trash a restore elsewhere overruled (409 `restored_since`, A430): said once,
    // also when a background pass met it while the app was closed (kept in the database).
    LaunchedEffect(graph.store) {
        graph.store.observeTrashNotices().collect { notices ->
            val notice = notices.firstOrNull() ?: return@collect
            graph.store.trashNoticeShown(notice.id)
            root.snackbar.say(trashRefusedMessage(notice.title), SnackbarTone.Error, duration = SnackbarDuration.Long)
        }
    }
    // After the version changed (PEN-109): once, when this version has notes for Android, a
    // snackbar says so, with What's New. A fresh install records its version and says nothing.
    LaunchedEffect(Unit) {
        val store = app.penmoss.updates.ReleaseNotesStore.get(context)
        val version = app.penmoss.BuildConfig.VERSION_NAME
        val from = store.updatedFrom(version) ?: return@LaunchedEffect
        store.load()
        store.refresh(version)
        val label = app.penmoss.updates.updatedNotice(store.notes.value, version, from) ?: return@LaunchedEffect
        val result = root.snackbar.showSnackbar("Updated to $label", actionLabel = "What’s New", duration = SnackbarDuration.Long)
        store.acknowledge(version)
        if (result == SnackbarResult.ActionPerformed) root.nav.open(SettingsRoutes.WHATS_NEW)
    }
    // A folder change the server refused because the folder is gone there (dropped, A443): said
    // once, also when a background pass met it while the app was closed (kept in the database).
    LaunchedEffect(graph.store) {
        graph.store.observeFolderNotices().collect { notices ->
            val notice = notices.firstOrNull() ?: return@collect
            graph.store.dismissFolderNotice(notice)
            root.snackbar.say(notice, SnackbarTone.Error, duration = SnackbarDuration.Long)
        }
    }
    // Once sent, wherever the app is: "Sent as #123" with a link to the issue (A796).
    LaunchedEffect(graph.feedbackOutbox) {
        graph.feedbackOutbox.sent.collect { filed ->
            val result = root.snackbar.showSnackbar("Sent as #${filed.number}", actionLabel = "Open", withDismissAction = true, duration = SnackbarDuration.Long)
            if (result == SnackbarResult.ActionPerformed) {
                runCatching { androidx.browser.customtabs.CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(filed.url)) }
            }
        }
    }
}

/** Over the screen's own top bar while notes are chosen (A652); Back ends it first. */
@Composable
internal fun RootSelectionBar(root: RootUi, modifier: Modifier = Modifier) {
    val selection = root.selection
    if (!selection.active) return
    BackHandler { selection.clear() }
    SelectionBar(
        picked = selection.picked,
        onClose = selection::clear,
        onMove = { root.moveSelected(selection.picked) },
        onTrash = {
            val picked = selection.picked
            selection.clear()
            if (picked.size == 1) root.trashNote(picked.single().id)
            else root.trashNotes(picked.map { it.id })
        },
        onRename = {
            val note = selection.picked.single()
            selection.clear()
            root.nav.open("note/${note.id}?focusTitle=true")
        },
        modifier = modifier,
        // Beside the one note chosen, in its folder (T53 item 12).
        onNewNoteHere = {
            val note = selection.picked.single()
            selection.clear()
            root.newNoteBeside(note.id)
        },
        onNewFolderHere = {
            val note = selection.picked.single()
            selection.clear()
            root.newFolderBeside(note.id)
        },
        onCopyAgentReference = {
            val note = selection.picked.single()
            selection.clear()
            root.copyAgentReference(note.id)
        },
    )
}

/** The dialogs over every screen (A6): a note's and a folder's actions, naming, deleting and the folder picker. */
@Composable
internal fun RootDialogs(root: RootUi) {
    val graph = root.graph
    root.acting?.let { note ->
        NoteActionsSheet(
            note.title,
            onRename = {
                root.acting = null
                root.nav.open("note/${note.id}?focusTitle=true")
            },
            onMove = {
                root.acting = null
                root.moveFromList(note)
            },
            onTrash = {
                root.acting = null
                root.trashNote(note.id)
            },
            onDismiss = { root.acting = null },
            onCopyAgentReference = {
                root.acting = null
                root.copyAgentReference(note.id)
            },
            // Beside the note, in its folder (T53 item 12).
            onNewNoteHere = {
                root.acting = null
                root.newNoteBeside(note.id)
            },
            onNewFolderHere = {
                root.acting = null
                root.newFolderBeside(note.id)
            },
        )
    }

    root.folderActing?.let { folder ->
        FolderSheet(
            name = folder.name,
            onRename = {
                root.folderNaming = FolderNaming.Rename(folder.id, folder.name, folder.notebook)
                root.folderActing = null
            },
            onNewSubfolder = {
                root.folderNaming = FolderNaming.Create(folder.id)
                root.folderActing = null
            },
            onMove = {
                root.choosing = Choosing.MoveFolder(folder.id, folder.name)
                root.folderActing = null
            },
            onDelete = {
                root.folderDeleting = folder
                root.folderActing = null
            },
            onDismiss = { root.folderActing = null },
            // New Note Here (T52 item 1): made in this folder and opened, as the sidebar's menu does.
            onNewNoteHere = {
                root.folderActing = null
                root.newNote(folder.id)
            },
            notebook = folder.notebook,
            onTurnBack = {
                root.notebookTurningBack = folder
                root.folderActing = null
            },
        )
    }

    root.notebookTurningBack?.let { folder ->
        NotebookTurnBackDialog(
            name = folder.name,
            defaultName = app.penmoss.data.Notebooks.DEFAULT_NAME,
            onConfirm = {
                root.turnBack(folder)
                root.notebookTurningBack = null
            },
            onDismiss = { root.notebookTurningBack = null },
        )
    }

    root.folderNaming?.let { naming ->
        when (naming) {
            is FolderNaming.Create -> NewFolderDialog(
                onConfirm = { name ->
                    root.createFolder(name, naming.parentId)
                    root.folderNaming = null
                },
                onDismiss = { root.folderNaming = null },
            )
            is FolderNaming.Rename -> FolderNameDialog(
                title = if (naming.notebook) "Rename Notebook" else "Rename Folder",
                initial = naming.current,
                onConfirm = { name ->
                    root.renameFolder(naming.id, name)
                    root.folderNaming = null
                },
                onDismiss = { root.folderNaming = null },
            )
        }
    }

    root.folderDeleting?.let { folder ->
        FolderDeleteHost(root, folder) { root.folderDeleting = null }
    }

    when (val choice = root.choosing) {
        null -> Unit
        is Choosing.NewNote -> FolderPickerFor(
            graph,
            title = "New Note in…",
            current = choice.current,
            onPick = { folder ->
                root.choosing = null
                root.newNote(folder)
            },
            onDismiss = { root.choosing = null },
        )
        is Choosing.Move -> FolderPickerFor(
            graph,
            title = "Move “${choice.title}” to…",
            current = choice.current,
            onPick = { folder ->
                root.choosing = null
                root.moveNote(choice.noteId, folder)
            },
            onDismiss = { root.choosing = null },
        )
        is Choosing.MoveMany -> FolderPickerFor(
            graph,
            title = moveTitle(choice.picked),
            // The folder they share is marked; notes from several folders mark none.
            current = if (choice.shared.size == 1) choice.shared.single() else MIXED_FOLDERS,
            onPick = { folder ->
                root.choosing = null
                root.selection.clear()
                root.moveNotes(choice.picked, folder)
            },
            onDismiss = { root.choosing = null },
        )
        is Choosing.MoveFolder -> {
            // The mark starts where the folder is (null: the top level).
            val parents by remember { graph.store.observeFolders() }.collectAsStateWithLifecycle(emptyList())
            val current = remember(parents) { parents.firstOrNull { it.id == choice.folderId }?.parentId }
            FolderPickerForMove(
                graph,
                title = "Move “${choice.title}” to…",
                current = current,
                exclude = choice.folderId,
                onPick = { folder ->
                    root.choosing = null
                    root.moveFolder(choice.folderId, folder)
                },
                onDismiss = { root.choosing = null },
            )
        }
    }
}

/** Deletes a folder after saying what moves up (T40 P4, NT4); gone meanwhile: nothing to ask. */
@Composable
private fun FolderDeleteHost(root: RootUi, folder: FolderItem, onDone: () -> Unit) {
    val summary by produceState<NoteStore.FolderDeleteSummary?>(initialValue = null, folder.id) {
        value = root.graph.store.folderDeleteSummary(folder.id)
    }
    val counted = summary ?: return
    if (counted.notebook) {
        // A notebook goes to Trash with its notes (T43, A755).
        NotebookDeleteDialog(
            name = folder.name,
            notes = counted.notes,
            onConfirm = {
                root.deleteFolder(folder, notebook = true)
                onDone()
            },
            onDismiss = onDone,
        )
        return
    }
    FolderDeleteDialog(
        name = folder.name,
        notes = counted.notes,
        subfolders = counted.subfolders,
        destination = counted.destination,
        onConfirm = {
            root.deleteFolder(folder, notebook = false)
            onDone()
        },
        onDismiss = onDone,
    )
}
