package app.penmoss.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.focusable
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import app.penmoss.ui.keys.KeyNames
import app.penmoss.ui.keys.LocalAppCommands
import app.penmoss.ui.keys.typesCharacter
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex

/**
 * What a long press on a folder row offers (T40 P4, NT3–NT5): make a folder inside it (New Folder
 * Here, T53 item 12), rename it, move it, or delete it (with what moves up). For a notebook (T43,
 * A750, A756): New Folder Here, Rename, Turn back into a folder and Delete notebook, never Move; a top-level folder that may
 * become one also offers Turn into notebook ([onTurnIntoNotebook]). New Note Here comes first
 * ([onNewNoteHere], T52 item 1), as the sidebar's right-click menu has it: a note made in this
 * folder (or at this notebook's top), opened at once.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderSheet(
    name: String,
    onRename: () -> Unit,
    onNewSubfolder: () -> Unit,
    onMove: () -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
    notebook: Boolean = false,
    onTurnIntoNotebook: (() -> Unit)? = null,
    onTurnBack: () -> Unit = {},
    /** A notebook: close it on this phone, as the web's Close on this device (T39 pass 3, A897). */
    onClose: (() -> Unit)? = null,
    /** Makes a note in this folder and opens it (T52 item 1); none offered when null. */
    onNewNoteHere: (() -> Unit)? = null,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Text(
            name.ifBlank { "Untitled folder" },
            Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
            style = MaterialTheme.typography.titleMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Box(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Column(Modifier.fillMaxWidth()) {
                onNewNoteHere?.let { FolderSheetAction("New Note Here", "folderAction-newNote", it) }
                // The web's name for it, beside New Note Here (T53 item 12).
                FolderSheetAction("New Folder Here", "folderAction-subfolder", onNewSubfolder)
                FolderSheetAction("Rename", "folderAction-rename", onRename)
                if (notebook) {
                    onClose?.let { FolderSheetAction("Close on This Phone", "folderAction-close", it) }
                    FolderSheetAction("Turn Back into a Folder…", "folderAction-turnBack", onTurnBack)
                    FolderSheetAction("Delete Notebook…", "folderAction-delete", onDelete)
                } else {
                    FolderSheetAction("Move to…", "folderAction-move", onMove)
                    onTurnIntoNotebook?.let { FolderSheetAction("Turn into Notebook", "folderAction-turnIntoNotebook", it) }
                    // The web's names, with "…" for what asks first (T39 pass 3, A891).
                    FolderSheetAction("Delete Folder…", "folderAction-delete", onDelete)
                }
            }
        }
    }
}

@Composable
private fun FolderSheetAction(text: String, tag: String, onClick: () -> Unit) {
    Text(
        text,
        Modifier
            .fillMaxWidth()
            .combinedClickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 16.dp)
            .testTag(tag),
        style = MaterialTheme.typography.bodyLarge,
    )
}

/**
 * The dialog that names a new folder, at the top level or in a folder: "New Folder" either way,
 * as the commands that open it say (New Folder, and New Folder Here since T53 item 12, A987).
 */
@Composable
fun NewFolderDialog(onConfirm: (String) -> Unit, onDismiss: () -> Unit) =
    FolderNameDialog(title = "New Folder", onConfirm = onConfirm, onDismiss = onDismiss)

/** Names a folder made or renamed here (T40 P4, NT2, NT3): Save stays off while it is blank. */
@Composable
fun FolderNameDialog(title: String, initial: String = "", onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                modifier = Modifier.fillMaxWidth().testTag("folderNameField"),
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (name.isNotBlank()) onConfirm(name.trim()) }),
            )
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(name.trim()) }, enabled = name.isNotBlank(), modifier = Modifier.testTag("folderNameSave")) {
                Text("Save")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * What deleting a folder does, in the web's words (`FolderTree`'s confirm, T42): it and its
 * subfolders go to Trash, its notes move up to [destination] (the parent's name, or null for the
 * top level), and it can be restored for 30 days (A560).
 */
internal fun folderDeleteText(notes: Int, subfolders: Int, destination: String?): String {
    val where = destination?.let { "“$it”" } ?: "the top level"
    val folders = when (subfolders) {
        0 -> ""
        1 -> "It and its subfolder will be deleted. "
        else -> "It and its $subfolders subfolders will be deleted. "
    }
    val moved = when (notes) {
        0 -> "It holds no notes."
        1 -> "Its note moves to $where; no notes are deleted."
        else -> "Its $notes notes move to $where; no notes are deleted."
    }
    return "$folders$moved You can restore it from Trash for 30 days."
}

/** Deletes a folder (T40 P4, NT4): says what goes, what moves up and that Trash keeps it. */
@Composable
fun FolderDeleteDialog(name: String, notes: Int, subfolders: Int, destination: String?, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete “${name.ifBlank { "Untitled folder" }}”?") },
        text = { Text(folderDeleteText(notes, subfolders, destination)) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("folderDeleteConfirm")) { Text("Delete Folder") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A folder's sort order (T40 P4, NT6): Manual, A–Z or Last modified, as the web sorts them. */
@Composable
fun SortMenu(expanded: Boolean, current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        SortChoice("manual", "Manual", current, onPick)
        SortChoice("alpha", "A–Z", current, onPick)
        SortChoice("modified", "Last Modified", current, onPick)
    }
}

@Composable
private fun SortChoice(mode: String, label: String, current: String, onPick: (String) -> Unit) {
    DropdownMenuItem(
        text = { Text(label) },
        leadingIcon = { RadioButton(selected = current == mode, onClick = null) },
        onClick = { onPick(mode) },
        // The order in use is said as chosen, as the web's menuitemradio is checked (T52 item 10).
        modifier = Modifier.testTag("sort-$mode").semantics {
            role = Role.RadioButton
            selected = current == mode
        },
    )
}

/**
 * The note's folder path (T40 P4, NT11): "Projects › Penmoss". A top-level note shows its
 * [notebook]'s name (T52, as the web's phone app bar: the default notebook's current name, or a git
 * notebook's), or "Top level" when none is known. A tap opens the note's folder; a long press
 * lists every level. Truncated from the start when it would not fit.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BreadcrumbBar(path: List<FolderItem>, onOpenFolder: (String?) -> Unit, modifier: Modifier = Modifier, notebook: String? = null) {
    var levels by remember { mutableStateOf(false) }
    val text = if (path.isEmpty() && !notebook.isNullOrBlank()) Items.pathText(listOf(notebook)) else Items.pathText(path.map { it.name })
    Box(modifier) {
        Text(
            text,
            Modifier
                .combinedClickable(
                    role = Role.Button,
                    onClickLabel = "Open Folder",
                    onClick = { onOpenFolder(path.lastOrNull()?.id) },
                    onLongClickLabel = if (path.isNotEmpty()) "Choose a Level" else null,
                    onLongClick = if (path.isNotEmpty()) {
                        { levels = true }
                    } else {
                        null
                    },
                )
                .testTag("breadcrumb"),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            // Truncated from the start (T40 P4, NT11): a deep path keeps the note's own folder.
            overflow = TextOverflow.StartEllipsis,
        )
        DropdownMenu(expanded = levels, onDismissRequest = { levels = false }) {
            for (level in path) {
                DropdownMenuItem(
                    text = { Text(level.name.ifBlank { "Untitled folder" }) },
                    onClick = {
                        levels = false
                        onOpenFolder(level.id)
                    },
                    modifier = Modifier.testTag("breadcrumbLevel-${level.id}"),
                )
            }
        }
    }
}

/**
 * A folder's folders and notes in manual order, ready to reorder (T40 P4, NT7, adapted): each
 * row has a drag handle (drag it to move the row, with a tick at each slot), "Move up" and
 * "Move down" actions for TalkBack, and Alt+↑/↓ for a hardware keyboard. A drop or an action
 * sends one intent at once ([onCommitFolder]/[onCommitNote] with the anchor); Done only leaves.
 */
@Composable
fun ReorderList(
    folders: List<FolderItem>,
    notes: List<NoteItem>,
    onCommitFolder: (id: String, before: String?, after: String?) -> Unit,
    onCommitNote: (id: String, before: String?, after: String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    var folderOrder by remember(folders) { mutableStateOf(folders.map { it.id }) }
    var noteOrder by remember(notes) { mutableStateOf(notes.map { it.id }) }
    var dragId by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    var slotPx by remember { mutableFloatStateOf(0f) }
    val heights = remember { mutableStateMapOf<String, Int>() }
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val defaultSlot = with(density) { 56.dp.toPx() }

    fun commit(id: String, order: List<String>, commit: (String, String?, String?) -> Unit) {
        val at = order.indexOf(id)
        if (at < 0) return
        val before = order.getOrNull(at + 1)
        commit(id, before, if (before == null) order.getOrNull(at - 1) else null)
    }

    fun moveUpDown(id: String, order: List<String>, set: (List<String>) -> Unit, delta: Int, send: (String, String?, String?) -> Unit) {
        val at = order.indexOf(id)
        val to = (at + delta).coerceIn(0, order.size - 1)
        if (at < 0 || at == to) return
        val moved = order.toMutableList().apply { add(to, removeAt(at)) }
        set(moved)
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        commit(id, moved, send)
    }

    val folderById = remember(folders) { folders.associateBy { it.id } }
    val noteById = remember(notes) { notes.associateBy { it.id } }
    LazyColumn(modifier.testTag("reorderList")) {
        items(folderOrder, key = { "folder:$it" }, contentType = { "folder" }) { id ->
            val folder = folderById[id] ?: return@items
            val position = folderOrder.indexOf(id) + 1
            ReorderRow(
                name = folder.name.ifBlank { "Untitled folder" },
                description = "Folder, $position of ${folderOrder.size}",
                dragged = id == dragId,
                dragOffset = if (id == dragId) dragOffset else 0f,
                onHeight = { heights[id] = it },
                onDragStart = {
                    dragId = id
                    dragOffset = 0f
                    slotPx = (heights[id] ?: 0).takeIf { it > 0 }?.toFloat() ?: defaultSlot
                },
                onDrag = { dy ->
                    dragOffset += dy
                    val slot = slotPx.takeIf { it > 0 } ?: defaultSlot
                    while (dragOffset > slot / 2 && folderOrder.indexOf(id) < folderOrder.size - 1) {
                        folderOrder = folderOrder.toMutableList().apply {
                            val at = indexOf(id)
                            add(at + 1, removeAt(at))
                        }
                        dragOffset -= slot
                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    }
                    while (dragOffset < -slot / 2 && folderOrder.indexOf(id) > 0) {
                        folderOrder = folderOrder.toMutableList().apply {
                            val at = indexOf(id)
                            add(at - 1, removeAt(at))
                        }
                        dragOffset += slot
                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    }
                },
                onDrop = {
                    dragId = null
                    commit(id, folderOrder, onCommitFolder)
                },
                onCancel = {
                    dragId = null
                    folderOrder = folders.map { it.id }
                },
                onMoveUp = { moveUpDown(id, folderOrder, { folderOrder = it }, -1, onCommitFolder) },
                onMoveDown = { moveUpDown(id, folderOrder, { folderOrder = it }, +1, onCommitFolder) },
            )
        }
        items(noteOrder, key = { "note:$it" }, contentType = { "note" }) { id ->
            val note = noteById[id] ?: return@items
            val position = noteOrder.indexOf(id) + 1
            ReorderRow(
                name = note.title.ifBlank { Items.UNTITLED },
                description = "Note, $position of ${noteOrder.size}",
                dragged = id == dragId,
                dragOffset = if (id == dragId) dragOffset else 0f,
                onHeight = { heights[id] = it },
                onDragStart = {
                    dragId = id
                    dragOffset = 0f
                    slotPx = (heights[id] ?: 0).takeIf { it > 0 }?.toFloat() ?: defaultSlot
                },
                onDrag = { dy ->
                    dragOffset += dy
                    val slot = slotPx.takeIf { it > 0 } ?: defaultSlot
                    while (dragOffset > slot / 2 && noteOrder.indexOf(id) < noteOrder.size - 1) {
                        noteOrder = noteOrder.toMutableList().apply {
                            val at = indexOf(id)
                            add(at + 1, removeAt(at))
                        }
                        dragOffset -= slot
                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    }
                    while (dragOffset < -slot / 2 && noteOrder.indexOf(id) > 0) {
                        noteOrder = noteOrder.toMutableList().apply {
                            val at = indexOf(id)
                            add(at - 1, removeAt(at))
                        }
                        dragOffset += slot
                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    }
                },
                onDrop = {
                    dragId = null
                    commit(id, noteOrder, onCommitNote)
                },
                onCancel = {
                    dragId = null
                    noteOrder = notes.map { it.id }
                },
                onMoveUp = { moveUpDown(id, noteOrder, { noteOrder = it }, -1, onCommitNote) },
                onMoveDown = { moveUpDown(id, noteOrder, { noteOrder = it }, +1, onCommitNote) },
            )
        }
    }
}

@Composable
private fun ReorderRow(
    name: String,
    description: String,
    dragged: Boolean,
    dragOffset: Float,
    onHeight: (Int) -> Unit,
    onDragStart: () -> Unit,
    onDrag: (Float) -> Unit,
    onDrop: () -> Unit,
    onCancel: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
) {
    val commands = LocalAppCommands.current
    val bindings by commands.bindings.collectAsStateWithLifecycle()
    Row(
        Modifier
            .fillMaxWidth()
            .onSizeChanged { onHeight(it.height) }
            .graphicsLayer { translationY = dragOffset }
            .zIndex(if (dragged) 1f else 0f)
            .focusable()
            // The tree's own commands, with the user's keys (Alt+↑ and Alt+↓ by default; T40 P9).
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                // A press the layout types with is typing, never a move (T40 P9 review B1).
                if (typesCharacter(event.nativeKeyEvent, commands.chars)) return@onPreviewKeyEvent false
                val combo = KeyNames.comboOf(event.nativeKeyEvent) ?: return@onPreviewKeyEvent false
                when (combo) {
                    in bindings.keysOf("folder.moveUp") -> {
                        onMoveUp()
                        true
                    }
                    in bindings.keysOf("folder.moveDown") -> {
                        onMoveDown()
                        true
                    }
                    else -> false
                }
            }
            .semantics {
                stateDescription = description
                customActions = listOf(
                    CustomAccessibilityAction("Move Up") { onMoveUp(); true },
                    CustomAccessibilityAction("Move Down") { onMoveDown(); true },
                )
            }
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .testTag("reorderRow"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier
                .size(48.dp)
                .pointerInput(Unit) {
                    detectVerticalDragGestures(
                        onDragStart = { onDragStart() },
                        onDragEnd = { onDrop() },
                        onDragCancel = { onCancel() },
                        onVerticalDrag = { change, dy ->
                            change.consume()
                            onDrag(dy)
                        },
                    )
                }
                .testTag("reorderHandle"),
            contentAlignment = Alignment.Center,
        ) {
            DragHandle()
        }
        Text(
            name,
            Modifier.weight(1f),
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Six dots, as a drag handle: the core icon set has none. */
@Composable
private fun DragHandle() {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Canvas(Modifier.size(18.dp, 18.dp)) {
        val radius = size.minDimension / 14
        val stepX = size.width / 2
        val stepY = size.height / 3
        for (column in 0..1) {
            for (row in 0..2) {
                drawCircle(color, radius, center = androidx.compose.ui.geometry.Offset(stepX * (column + 0.5f), stepY * (row + 0.5f)))
            }
        }
    }
}

