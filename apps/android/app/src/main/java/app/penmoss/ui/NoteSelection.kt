package app.penmoss.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import app.penmoss.data.NoteStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/*
 * Several notes at once on the phone (T42, A570; T40 NT26, A652): the web's tree selection and
 * context menu as Android's selection mode. A long press on a note in a list (Home, a folder, All
 * notes, a tag's notes) selects it and puts a contextual bar over the screen's own: the count,
 * Move (one folder picker for all of them) and Move to Trash (one Undo for all); Rename too while
 * one note is chosen. Taps then add or remove notes; folders wait. Back, the bar's ✕, or leaving
 * the screen ends it, and a chosen note the list stops showing is no longer chosen. Search's
 * results keep their one-note sheet: they change as the query does.
 */

/** A note chosen in a list's selection mode: its id, and its title for the messages. */
data class Picked(val id: String, val title: String)

/** The notes chosen, in the order they were chosen (moves keep that order, as the web's do). */
@Stable
class NoteSelection {
    var picked: List<Picked> by mutableStateOf(emptyList())
        private set

    val active: Boolean get() = picked.isNotEmpty()

    fun contains(id: String): Boolean = picked.any { it.id == id }

    /** Starts selection mode with [note] (a long press). */
    fun start(note: NoteItem) {
        picked = listOf(Picked(note.id, note.title))
    }

    /** Adds [note], or takes it out; the last one out ends selection mode. */
    fun toggle(note: NoteItem) {
        picked = if (contains(note.id)) picked.filterNot { it.id == note.id } else picked + Picked(note.id, note.title)
    }

    fun clear() {
        if (picked.isNotEmpty()) picked = emptyList()
    }

    /** Keeps only the notes in [shown]: the bar never acts on a note out of sight (review S2). */
    fun retain(shown: Set<String>) {
        if (picked.any { it.id !in shown }) picked = picked.filter { it.id in shown }
    }
}

/**
 * A list's notes as they are now: a chosen note a sync pass, a move elsewhere or Home's recent
 * notes rolling over takes off the list is no longer chosen, and selection mode ends when none is
 * left (review S2). Only the screen in front prunes, not one sliding out.
 */
@Composable
internal fun KeepSelectionShown(notes: List<NoteItem>) {
    val selection = LocalNoteSelection.current ?: return
    val state by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val front = state.isAtLeast(Lifecycle.State.RESUMED)
    val shown = remember(notes) { notes.mapTo(HashSet()) { it.id } }
    LaunchedEffect(shown, front, selection.active) {
        if (front && selection.active) selection.retain(shown)
    }
}

/**
 * A list screen's own top bar, which [SelectionBar] covers while notes are chosen: out of
 * TalkBack's reach then, so swiping cannot land on the Search or ⋮ underneath (review S4).
 */
@Composable
internal fun Modifier.underSelectionBar(): Modifier =
    if (LocalNoteSelection.current?.active == true) clearAndSetSemantics {} else this

/** The selection the lists' rows join while it is active; null where a list has none. */
val LocalNoteSelection = staticCompositionLocalOf<NoteSelection?> { null }

private fun pickedCount(count: Int) = if (count == 1) "1 note" else "$count notes"

/** What the bar and its actions call the notes chosen: the title of one, else how many. */
internal fun selectionName(picked: List<Picked>): String =
    picked.singleOrNull()?.let { "“${titleOf(it.title)}”" } ?: pickedCount(picked.size)

/** The folder picker's title for a Move of [picked]. */
internal fun moveTitle(picked: List<Picked>): String = "Move ${selectionName(picked)} to…"

/**
 * The contextual bar over the screen while notes are chosen: ✕, the count, Move, Move to Trash,
 * and, for one note, New Note Here and New Folder Here (beside it, in its folder: T53 item 12),
 * Rename and Copy Agent Reference (T52 item 4) in its ⋮ menu.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SelectionBar(
    picked: List<Picked>,
    onClose: () -> Unit,
    onMove: () -> Unit,
    onTrash: () -> Unit,
    onRename: () -> Unit,
    modifier: Modifier = Modifier,
    /** Copy Agent Reference for the one note chosen (T52 item 4); none offered when null. */
    onCopyAgentReference: (() -> Unit)? = null,
    /** A new note or folder beside the one note chosen, in its folder (T53 item 12); none when null. */
    onNewNoteHere: (() -> Unit)? = null,
    onNewFolderHere: (() -> Unit)? = null,
) {
    val name = selectionName(picked)
    TopAppBar(
        modifier = modifier.testTag("selectionBar"),
        navigationIcon = {
            IconButton(onClick = onClose, modifier = Modifier.testTag("selectionClose")) { Icon(Icons.Default.Close, contentDescription = "Cancel Selection") }
        },
        title = {
            // Read out as notes are added or taken out.
            Text("${picked.size} selected", Modifier.testTag("selectionCount").semantics { liveRegion = LiveRegionMode.Polite })
        },
        actions = {
            IconButton(onClick = onMove, modifier = Modifier.testTag("selectionMove")) { Icon(FolderIcon, contentDescription = "Move $name to a folder") }
            IconButton(onClick = onTrash, modifier = Modifier.testTag("selectionTrash")) { Icon(Icons.Default.Delete, contentDescription = "Move $name to Trash") }
            if (picked.size == 1) {
                var more by remember { mutableStateOf(false) }
                IconButton(onClick = { more = true }, modifier = Modifier.testTag("selectionMore")) { Icon(Icons.Default.MoreVert, contentDescription = "More Actions") }
                DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                    if (onNewNoteHere != null) {
                        DropdownMenuItem(
                            text = { Text("New Note Here") },
                            onClick = {
                                more = false
                                onNewNoteHere()
                            },
                            modifier = Modifier.testTag("selectionNewNote"),
                        )
                    }
                    if (onNewFolderHere != null) {
                        DropdownMenuItem(
                            text = { Text("New Folder Here") },
                            onClick = {
                                more = false
                                onNewFolderHere()
                            },
                            modifier = Modifier.testTag("selectionNewFolder"),
                        )
                    }
                    if (onNewNoteHere != null || onNewFolderHere != null) HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("Rename") },
                        onClick = {
                            more = false
                            onRename()
                        },
                        modifier = Modifier.testTag("selectionRename"),
                    )
                    if (onCopyAgentReference != null) {
                        DropdownMenuItem(
                            text = { Text("Copy Agent Reference") },
                            onClick = {
                                more = false
                                onCopyAgentReference()
                            },
                            modifier = Modifier.testTag("selectionCopyAgentReference"),
                        )
                    }
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
            titleContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
            navigationIconContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
            actionIconContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        ),
    )
}

/**
 * Moves every note in [ids] to [folderId] (null: the top level), each to the end in order (A570):
 * at once on the phone, each filed on the server with the next pass. A note that cannot move
 * stops none of the others. Returns what to tell the person, in the web's words (`moveSummary`):
 * notes already there count as neither moved nor refused (review N1), and a folder gone from the
 * phone is named as the reason, not the notes (#137, A658).
 */
internal suspend fun moveNotesAndSay(store: NoteStore, ids: List<String>, folderId: String?, folderName: String, requestSync: () -> Unit): String {
    val results = ids.map { store.moveNote(it, folderId) }
    if (NoteStore.Move.MOVED in results) requestSync()
    val moved = results.count { it == NoteStore.Move.MOVED }
    val gone = results.count { it == NoteStore.Move.REFUSED }
    val noFolder = results.count { it == NoteStore.Move.NO_FOLDER }
    val refused = gone + noFolder
    val already = ids.size - moved - refused
    val folderGone = "$folderName isn't on this phone any more"
    val notesGone = "${if (gone == 1) "it isn't" else "they aren't"} on this phone any more"
    // The folder can go part way through: then the notes after it could not move for that.
    val why = "$refused could not move: " + when {
        noFolder == 0 -> notesGone
        gone == 0 -> folderGone
        else -> "$folderGone, and $gone of them aren't either"
    }
    return when {
        noFolder == ids.size -> folderGone
        refused == 0 && moved == 0 -> "Already in $folderName"
        refused == 0 -> "Moved ${pickedCount(moved)} to $folderName"
        refused == ids.size -> if (ids.size == 1) "This note can't be moved" else "None of the ${ids.size} notes could move to $folderName"
        moved == 0 -> "$already already in $folderName; $why"
        else -> "Moved $moved of ${ids.size} notes to $folderName; $why"
    }
}

/** What Move to Trash of several notes said, and then what its Undo did. */
internal data class TrashOutcome(val said: String, val undone: String?)

/**
 * Move to Trash for several notes (A570, A524): each goes on its own, so one that fails stops none
 * of the others, and one snackbar offers Undo for all of them for [undoFor]. Undo brings each
 * back, and says which could not be. The pass that follows sends what is left to send.
 */
internal fun CoroutineScope.moveNotesToTrashWithUndo(
    store: NoteStore,
    requestSync: () -> Unit,
    snackbar: SnackbarHostState,
    ids: List<String>,
    undoFor: Long = UNDO_MS,
    sayFor: Long = UNDO_MS,
    onDone: (TrashOutcome) -> Unit = {},
) = launch {
    val moved = ids.filter { store.moveToTrash(it) }
    if (moved.isEmpty()) {
        // Said, not silent (#137, A658): each was gone from the phone already, so nothing to undo.
        requestSync()
        snackbar.currentSnackbarData?.dismiss()
        snackbar.showSnackbar(noneToTrash(ids.size))
        return@launch
    }
    val missed = ids.size - moved.size
    val said = if (missed == 0) "Moved ${pickedCount(moved.size)} to Trash" else "Moved ${moved.size} of ${ids.size} notes to Trash; $missed could not be: not on this phone any more"
    snackbar.currentSnackbarData?.dismiss()
    val undone = withTimeoutOrNull(undoFor) {
        snackbar.showSnackbar(said, actionLabel = "Undo", duration = SnackbarDuration.Indefinite)
    } == SnackbarResult.ActionPerformed
    var undoSaid: String? = null
    if (undone) {
        val failed = moved.count { store.restoreFromTrash(it) == NoteStore.Restore.NOT_IN_TRASH }
        undoSaid = if (failed == 0) {
            "Restored ${pickedCount(moved.size)}"
        } else {
            "Restored ${moved.size - failed} of ${moved.size} notes; $failed could not be: not in Trash any more"
        }
    }
    requestSync()
    onDone(TrashOutcome(said, undoSaid))
    // What Undo did, said for a while; never waited on past [sayFor], so the move always ends.
    if (undoSaid != null) withTimeoutOrNull(sayFor) { snackbar.showSnackbar(undoSaid) }
}

/** What Move to Trash says when none of [count] notes could go (#137, A658): each had gone already. */
internal fun noneToTrash(count: Int): String =
    if (count == 1) "This note can't be moved to Trash: it isn't on this phone any more" else "None of the $count notes could move to Trash: they aren't on this phone any more"
