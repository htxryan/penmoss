package app.penmoss.ui.note

import android.webkit.WebView
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import app.penmoss.ui.common.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.PopupProperties
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.typedLength
import app.penmoss.editor.BlockChoices
import app.penmoss.editor.FormatState
import app.penmoss.editor.NoteCounts
import app.penmoss.engine.bridge.BlockAction
import app.penmoss.engine.bridge.BlockEntry
import app.penmoss.engine.bridge.BlockPurpose
import app.penmoss.ui.common.SheetTitle
import app.penmoss.ui.common.roles
import app.penmoss.ui.open

/*
 * The note screen's editor tools (T40 P8): the ⋮ menu's copies, Markdown source, Find in note
 * and Word count; the find bar; the + sheet and Turn into; and the format bar's Block menu.
 */

/** The note's counts (NT24), as the web's status bar reads them, and the selection's. */
@Composable
internal fun WordCountDialog(counts: NoteCounts?, onDismiss: () -> Unit) {
    rememberTrackedDialog("wordCount")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Word Count") },
        text = {
            Column(Modifier.testTag("wordCount"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (counts == null) {
                    Text("Counting…")
                } else {
                    Text(NoteCounts.wordsLabel(counts.words))
                    Text(NoteCounts.charactersLabel(counts.characters))
                    NoteCounts.readingLabel(counts.minutes)?.let { Text(it) }
                    counts.selectionLabel?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
                }
            }
        },
        confirmButton = { TextButton(onClick = trackedClick("dialog.close", onDismiss)) { Text("OK") } },
    )
}

/** What the find bar searches (ED18): the editor's WebView, or a fake in tests. */
interface FindTarget {
    fun find(query: String)

    fun next(forward: Boolean)

    fun clear()

    /** The matches as they are counted: the active one (from 0), how many, and whether counting is done. */
    fun listen(listener: ((active: Int, count: Int, done: Boolean) -> Unit)?)
}

/** The WebView's own find-in-page, which the editor page leaves to it (A90). */
class WebViewFind(private val view: () -> WebView?) : FindTarget {
    override fun find(query: String) {
        val web = view() ?: return
        if (query.isEmpty()) web.clearMatches() else web.findAllAsync(query)
    }

    override fun next(forward: Boolean) {
        view()?.findNext(forward)
    }

    override fun clear() {
        view()?.clearMatches()
    }

    override fun listen(listener: ((active: Int, count: Int, done: Boolean) -> Unit)?) {
        view()?.setFindListener(listener?.let { report -> WebView.FindListener { active, count, done -> report(active, count, done) } })
    }
}

/** "3 of 12", "No matches", or nothing while the query is empty. */
internal fun findLabel(query: String, active: Int, count: Int): String = when {
    query.isEmpty() -> ""
    count == 0 -> "No matches"
    else -> "${active + 1} of $count"
}

/**
 * Find in note (ED18): a bar under the top bar with the query, "3 of 12", previous and next,
 * and Close. Enter goes to the next match; closing clears the highlights.
 */
@Composable
internal fun FindBar(
    target: FindTarget,
    onClose: () -> Unit,
    /** Changes as the note does (its counts): the matches are found again, so the count holds. */
    refresh: Any? = null,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var active by remember { mutableIntStateOf(0) }
    var count by remember { mutableIntStateOf(0) }
    val focus = remember { FocusRequester() }
    DisposableEffect(target) {
        target.listen { at, total, _ ->
            active = at
            count = total
        }
        onDispose {
            target.listen(null)
            target.clear()
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(query, refresh) {
        if (query.isEmpty()) count = 0
        target.find(query)
    }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().testTag("findBar")) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Search, contentDescription = null, modifier = Modifier.padding(start = 8.dp))
            TextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Find in note") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { if (count > 0) target.next(true) }),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                ),
                modifier = Modifier.weight(1f).focusRequester(focus).testTag("findQuery")
                    // Named once text is typed too, when the placeholder is gone (review nit).
                    .semantics { contentDescription = "Find in note" },
            )
            Text(
                findLabel(query, active, count),
                style = MaterialTheme.roles.meta,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .padding(horizontal = 4.dp)
                    .testTag("findCount")
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
            IconButton(onClick = trackedClick("editor.find.previous") { target.next(false) }, enabled = count > 0, modifier = Modifier.testTag("findPrevious")) {
                Icon(Icons.Default.KeyboardArrowUp, contentDescription = "Previous Match")
            }
            IconButton(onClick = trackedClick("editor.find.next") { target.next(true) }, enabled = count > 0, modifier = Modifier.testTag("findNext")) {
                Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Next Match")
            }
            IconButton(onClick = trackedClick("editor.find.close", onClose), modifier = Modifier.testTag("findClose")) {
                Icon(Icons.Default.Close, contentDescription = "Close Find")
            }
        }
    }
}

/**
 * The + sheet (ED4) and Turn into (ED5): the slash menu's catalogue as a bottom sheet, with
 * search. The page filters and ranks as the slash menu does: each search asks it again
 * ([onQuery]), and [choices] is its latest answer for this [purpose].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BlockSheet(
    purpose: BlockPurpose,
    choices: BlockChoices?,
    onQuery: (String) -> Unit,
    onPick: (BlockEntry) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by rememberSaveable(purpose) { mutableStateOf("") }
    LaunchedEffect(purpose, query) { onQuery(query) }
    val items = choices?.takeIf { it.purpose == purpose && it.query == query }?.items
    val tracked = rememberTrackedDialog("blockPicker")
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("blockSheet")) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            SheetTitle(if (purpose == BlockPurpose.INSERT) "Insert" else "Turn Into", Modifier.padding(bottom = 8.dp), padded = false)
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text(if (purpose == BlockPurpose.INSERT) "Search blocks" else "Search kinds") },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    items?.firstOrNull()?.let { first ->
                        tracked.done()
                        onPick(first)
                    }
                }),
                modifier = Modifier.fillMaxWidth().testTag("blockSearch").typedLength("blockPicker", "query", query),
            )
            when {
                items == null -> Unit
                items.isEmpty() -> Text(
                    if (purpose == BlockPurpose.INSERT && query.isEmpty()) "Nothing can be inserted here." else if (query.isEmpty()) "This can't be turned into another kind here." else "No blocks match.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 16.dp).testTag("blockNone"),
                )
                else -> LazyColumn(Modifier.heightIn(max = 480.dp).padding(vertical = 8.dp)) {
                    items(items, key = { it.id }) { entry -> BlockRow(entry, tracked.done { onPick(entry) }) }
                }
            }
        }
    }
}

@Composable
private fun BlockRow(entry: BlockEntry, onClick: () -> Unit) {
    val active = entry.active == true
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = trackedClick("editor.block-sheet.pick", onClick))
            .semantics(mergeDescendants = true) { selected = active }
            .testTag("block-${entry.id}")
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // The slash menu's glyph, in a tile as the web's menu shows it.
        Surface(
            shape = RectangleShape,
            color = if (active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
            // The glyph ("H1", "{}") says nothing the label does not (review nit).
            modifier = Modifier.size(36.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    entry.icon,
                    style = MaterialTheme.roles.item,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    modifier = Modifier.semantics { hideFromAccessibility() },
                )
            }
        }
        Text(entry.label, style = MaterialTheme.roles.rowLabel, modifier = Modifier.weight(1f))
        entry.hint?.let {
            Text(
                it,
                style = MaterialTheme.roles.meta,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                // Markdown punctuation read aloud is noise: the hint is for the eye.
                modifier = Modifier.widthIn(max = 120.dp).semantics { hideFromAccessibility() },
                maxLines = 1,
            )
        }
    }
}

/**
 * The format bar's Block button (ED5, _adapted_ from the drag handle): Move up, Move down,
 * Turn into…, Duplicate block and Delete block, in a menu that leaves the keyboard open.
 */
@Composable
internal fun BlockMenuButton(state: FormatState, onAction: (BlockAction) -> Unit, onTurnInto: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        BarTool("Block Actions", EditorIcons.Block, tag = "blockMenu", event = "editor.format.block") { open = true }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            properties = PopupProperties(focusable = false),
        ) {
            val close = { open = false }
            BlockMenuItem("Move Up", "blockMoveUp", state.canMoveUp, close, event = "editor.block.move-up") { onAction(BlockAction.MOVE_UP) }
            BlockMenuItem("Move Down", "blockMoveDown", state.canMoveDown, close, event = "editor.block.move-down") { onAction(BlockAction.MOVE_DOWN) }
            BlockMenuItem("Turn Into…", "blockTurnInto", state.canTurnInto, close, event = "editor.block.turn-into", action = onTurnInto)
            BlockMenuItem("Duplicate Block", "blockDuplicate", true, close, event = "editor.block.duplicate") { onAction(BlockAction.DUPLICATE) }
            BlockMenuItem("Delete Block", "blockDelete", true, close, event = "editor.block.delete") { onAction(BlockAction.DELETE) }
        }
    }
}

/** One item of the Block menu: it closes the menu, then does [action], counted as [event]; it never takes the focus. */
@Composable
private fun BlockMenuItem(label: String, tag: String, enabled: Boolean, close: () -> Unit, event: String, action: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label) },
        enabled = enabled,
        onClick = trackedClick(event) {
            close()
            action()
        },
        modifier = Modifier.focusProperties { canFocus = false }.testTag(tag),
    )
}

/** A bar button for the tools (the bar's own style: 44 dp, never taking the focus). */
@Composable
internal fun BarTool(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tag: String,
    enabled: Boolean = true,
    /** The button's tracked id (PEN-137). */
    event: String,
    onClick: () -> Unit,
) {
    val colours = MaterialTheme.colorScheme
    Surface(
        onClick = trackedClick(event, onClick),
        enabled = enabled,
        shape = RectangleShape,
        color = colours.surfaceContainer,
        contentColor = if (enabled) colours.onSurface else colours.onSurface.copy(alpha = 0.38f),
        modifier = Modifier
            .focusProperties { canFocus = false }
            .size(44.dp)
            .testTag(tag)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
    ) {
        Box(contentAlignment = Alignment.Center) { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)) }
    }
}
