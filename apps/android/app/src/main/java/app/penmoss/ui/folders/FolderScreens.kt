package app.penmoss.ui.folders

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import app.penmoss.analytics.TreeEvents
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.typedLength
import app.penmoss.ui.common.roles
import app.penmoss.ui.keys.FolderCommands
import app.penmoss.ui.home.FolderScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
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
import app.penmoss.ui.common.SheetAction
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.Items
import app.penmoss.ui.common.NoteItem
import app.penmoss.ui.Choosing
import app.penmoss.ui.FolderNaming
import app.penmoss.ui.RootUi
import app.penmoss.ui.leave
import app.penmoss.ui.open
import app.penmoss.ui.common.ConfirmDialog
import app.penmoss.ui.common.SheetTitle

/**
 * What a long press on a folder row offers (T40 P4, NT3–NT5): make a folder inside it (New Folder
 * Here, T53 item 12), rename it, move it, or delete it (with what moves up). New Note Here comes
 * first ([onNewNoteHere], T52 item 1), as the sidebar's right-click menu has it: a note made in
 * this folder, opened at once.
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
    /** Makes a note in this folder and opens it (T52 item 1); none offered when null. */
    onNewNoteHere: (() -> Unit)? = null,
    /** AI Descriptions for this folder (PEN-161): its setting, and Describe Notes Now. */
    ai: FolderAi? = null,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val tracked = rememberTrackedDialog("folderMenu")
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        SheetTitle(name.ifBlank { "Untitled folder" })
        Box(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            // Scrolls: with AI Descriptions (PEN-161) it can be taller than a small phone's sheet.
            Column(Modifier.fillMaxWidth().verticalScroll(androidx.compose.foundation.rememberScrollState())) {
                onNewNoteHere?.let { SheetAction("New Note Here", "folderAction-newNote", event = "tree.folder-menu.new-note", tracked.done(it)) }
                // The web's name for it, beside New Note Here (T53 item 12).
                SheetAction("New Folder Here", "folderAction-subfolder", event = "tree.folder-menu.new-folder", tracked.done(onNewSubfolder))
                SheetAction("Rename", "folderAction-rename", event = "tree.folder-menu.rename", tracked.done(onRename))
                SheetAction("Move To…", "folderAction-move", event = "tree.folder-menu.move", tracked.done(onMove))
                // The web's names, with "…" for what asks first (T39 pass 3, A891).
                SheetAction("Delete Folder…", "folderAction-delete", event = "tree.folder-menu.delete", tracked.done(onDelete))
                ai?.let { FolderAiSection(it, tracked.done(it.onDescribeAll)) }
            }
        }
    }
}

/** A folder's AI Descriptions in its menu: [value] null while it is read. */
data class FolderAi(val value: String?, val onChoose: (String) -> Unit, val onDescribeAll: () -> Unit)

/** The Mac's flat group (A1656): AI Descriptions, Inherit, On and Off, then Describe Notes Now. */
@Composable
private fun FolderAiSection(ai: FolderAi, onDescribeAll: () -> Unit) {
    androidx.compose.material3.HorizontalDivider(Modifier.padding(vertical = 4.dp))
    Text(
        "AI Descriptions",
        Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
        style = MaterialTheme.roles.listHead,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    for ((value, label) in listOf("inherit" to "Inherit", "on" to "On", "off" to "Off")) {
        Row(
            Modifier
                .fillMaxWidth()
                .selectable(
                    selected = ai.value == value,
                    enabled = ai.value != null,
                    role = Role.RadioButton,
                    onClick = trackedClick("folder.ai.mode") { ai.onChoose(value) },
                )
                .padding(horizontal = 24.dp, vertical = 8.dp)
                .testTag("folderAi-$value"),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            RadioButton(selected = ai.value == value, onClick = null, enabled = ai.value != null)
            Text(label, Modifier.padding(start = 12.dp), style = MaterialTheme.roles.rowLabel)
        }
    }
    SheetAction("Describe Notes Now", "folderAction-describeAll", event = "folder.ai.describe-all", onDescribeAll)
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
    val tracked = rememberTrackedDialog("folderName")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                modifier = Modifier.fillMaxWidth().testTag("folderNameField").typedLength("folderName", "name", name),
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    if (name.isNotBlank()) {
                        tracked.done()
                        onConfirm(name.trim())
                    }
                }),
            )
        },
        confirmButton = {
            TextButton(onClick = trackedClick("tree.folder-name.save", tracked.done { onConfirm(name.trim()) }), enabled = name.isNotBlank(), modifier = Modifier.testTag("folderNameSave")) {
                Text("Save")
            }
        },
        dismissButton = { TextButton(onClick = trackedClick("tree.folder-name.cancel", onDismiss)) { Text("Cancel") } },
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
    ConfirmDialog(
        title = "Delete “${name.ifBlank { "Untitled folder" }}”?",
        body = folderDeleteText(notes, subfolders, destination),
        confirmLabel = "Delete Folder",
        confirmEvent = "tree.delete-folder.confirm",
        cancelEvent = "tree.delete-folder.cancel",
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        destructive = true,
        confirmTag = "folderDeleteConfirm",
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
        onClick = trackedClick("tree.sort-order.choose") { onPick(mode) },
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
                    onClick = trackedClick("note.breadcrumb") { onOpenFolder(path.lastOrNull()?.id) },
                    onLongClickLabel = if (path.isNotEmpty()) "Choose a Level" else null,
                    onLongClick = if (path.isNotEmpty()) {
                        { levels = true }
                    } else {
                        null
                    },
                )
                .testTag("breadcrumb"),
            style = MaterialTheme.roles.item,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            // Truncated from the start (T40 P4, NT11): a deep path keeps the note's own folder.
            overflow = TextOverflow.StartEllipsis,
        )
        DropdownMenu(expanded = levels, onDismissRequest = { levels = false }) {
            for (level in path) {
                DropdownMenuItem(
                    text = { Text(level.name.ifBlank { "Untitled folder" }) },
                    onClick = trackedClick("note.breadcrumb.level") {
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
            style = MaterialTheme.roles.rowLabel,
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

/** A folder's screen (T40 P4): its subfolders and notes, its sort, and its own actions. */
internal fun NavGraphBuilder.folderRoutes(root: RootUi) {
    val graph = root.graph
    val nav = root.nav
    composable("folder/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val folderId = entry.arguments?.getString("id")
        // A folder's own New note, New folder and sort, over the root's (T40 P9).
        FolderCommands(
            newNote = { root.newNote(folderId) },
            newFolder = { root.folderNaming = FolderNaming.Create(folderId) },
            sort = { if (folderId != null) root.sortFolder(folderId, it) },
        )
        val contents by remember(folderId) {
            combine(graph.store.observeList(), graph.store.observeFolders(), graph.store.observeRootSortMode()) { notes, folders, mode ->
                val folder = folders.firstOrNull { it.id == folderId }
                val name = folder?.name ?: "Folder"
                val (subfolders, filed) = Items.folder(folderId, mode, folders, notes, System.currentTimeMillis())
                val above = Items.folderPath(folders, folder?.parentId)
                FolderView(
                    name = name,
                    folders = subfolders,
                    notes = filed,
                    sortMode = folder?.sortMode ?: "manual",
                    subtitle = Items.pathText(above.map { it.name }).takeIf { above.isNotEmpty() },
                    depth = above.size,
                )
            }.distinctUntilChanged().flowOn(Dispatchers.Default)
        }.collectAsStateWithLifecycle(FolderView("", emptyList(), emptyList(), "manual", null, 0))
        // Left however it is (its Back, the system Back or a predictive back): `tree collapse`.
        val leaving = folderId?.let { rememberFolderLeaving(nav, entry, it, contents.depth) }
        FolderScreen(
            title = contents.name,
            folders = contents.folders,
            notes = contents.notes,
            // Where in the tree (PEN-177): this folder is at its depth, what it holds one deeper.
            onBack = {
                if (entry.lifecycle.currentState == Lifecycle.State.RESUMED && nav.currentBackStackEntry == entry) {
                    leaving?.byBar = true
                }
                nav.leave(entry)
            },
            onFolder = {
                TreeEvents.expand(it, contents.depth + 1)
                nav.open("folder/$it")
            },
            onOpen = {
                TreeEvents.open(it, folderId, contents.depth + 1)
                root.openNote(it)
            },
            onNewNote = { root.newNote(folderId) },
            onNewNoteIn = { root.choosing = Choosing.NewNote(folderId) },
            onNoteLongPress = root::startSelection,
            subtitle = contents.subtitle,
            sortMode = contents.sortMode,
            onSort = { if (folderId != null) root.sortFolder(folderId, it) },
            onNewFolder = { root.folderNaming = FolderNaming.Create(folderId) },
            onRenameFolder = { if (folderId != null) root.folderNaming = FolderNaming.Rename(folderId, contents.name) },
            onMoveFolderTo = { if (folderId != null) root.choosing = Choosing.MoveFolder(folderId, contents.name) },
            onDeleteFolder = { if (folderId != null) root.askDeleteFolder(folderId) },
            onFolderLongPress = { root.folderActing = it },
            reordering = root.folderReordering == folderId,
            onReorder = { root.folderReordering = if (it) folderId else null },
            onMoveFolder = root::reorderFolder,
            onMoveNote = root::reorderNote,
        )
    }
}

/** A folder's screen: its name, rows, sort order and path from the top (T40 P4). */
/** A folder page being watched for its leaving (PEN-177): where it is, and whether its own Back left it. */
private class FolderLeaving(val folderId: String, var depth: Int) {
    /** Its top bar's Back was tapped (`click`); otherwise the system Back left it (`key`). */
    var byBar = false
}

/** The folder pages watched, by their entry; an entry gone is let go with it. */
private val watchedFolders = java.util.WeakHashMap<NavBackStackEntry, FolderLeaving>()

/**
 * Records `tree collapse` for the folder page [entry] once it is left, however it is left
 * (PEN-177): its top bar's Back (`click`), or the system Back, its gesture or a predictive back
 * once it commits (`key`). The page is left when its entry is destroyed while no longer on the
 * back stack: a page opened over it keeps it there, and the activity going (a rotation) destroys
 * it while still on the stack, so neither is a collapse.
 */
@Composable
private fun rememberFolderLeaving(nav: NavController, entry: NavBackStackEntry, folderId: String, depth: Int): FolderLeaving {
    val leaving = remember(entry) {
        watchedFolders.getOrPut(entry) {
            val watch = FolderLeaving(folderId, depth)
            entry.lifecycle.addObserver(object : LifecycleEventObserver {
                override fun onStateChanged(source: LifecycleOwner, event: Lifecycle.Event) {
                    if (event != Lifecycle.Event.ON_DESTROY) return
                    source.lifecycle.removeObserver(this)
                    if (nav.currentBackStack.value.any { it.id == entry.id }) return
                    TreeEvents.collapse(watch.folderId, watch.depth, if (watch.byBar) "click" else "key")
                }
            })
            watch
        }
    }
    leaving.depth = depth
    return leaving
}

private data class FolderView(
    val name: String,
    val folders: List<FolderItem>,
    val notes: List<NoteItem>,
    val sortMode: String,
    val subtitle: String?,
    /** How deep the folder is: 0 at the notebook's top level (PEN-177). */
    val depth: Int,
)

