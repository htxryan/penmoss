package app.penmoss.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.PopupProperties
import app.penmoss.editor.FormatState
import app.penmoss.engine.bridge.FormatCommand
import app.penmoss.engine.settings.LineSymbol

/** One button of the bar: what it does, its name and icon, and whether it shows as on. */
private data class BarButton(val command: FormatCommand, val label: String, val icon: ImageVector)

private val MARKS = listOf(
    BarButton(FormatCommand.BOLD, "Bold", EditorIcons.Bold),
    BarButton(FormatCommand.ITALIC, "Italic", EditorIcons.Italic),
    BarButton(FormatCommand.CODE, "Inline Code", EditorIcons.Code),
)

private val LISTS = listOf(
    BarButton(FormatCommand.BULLET_LIST, "Bulleted List", EditorIcons.List),
    BarButton(FormatCommand.ORDERED_LIST, "Numbered List", EditorIcons.NumberedList),
    BarButton(FormatCommand.TASK_LIST, "Checklist", EditorIcons.Checklist),
)

/** The text styles the heading button offers (the web's "Turn into"). */
private val STYLES = listOf(
    FormatCommand.PARAGRAPH to "Text",
    FormatCommand.HEADING1 to "Heading 1",
    FormatCommand.HEADING2 to "Heading 2",
    FormatCommand.HEADING3 to "Heading 3",
    // Headings 4–6 as on the web (T40 P8, ED4).
    FormatCommand.HEADING4 to "Heading 4",
    FormatCommand.HEADING5 to "Heading 5",
    FormatCommand.HEADING6 to "Heading 6",
    FormatCommand.BLOCKQUOTE to "Quote",
    FormatCommand.CODE_BLOCK to "Code Block",
    FormatCommand.STRIKE to "Strikethrough",
    FormatCommand.HIGHLIGHT to "Highlight",
)

/** The table's buttons, shown while the caret is in a table (T40 P8, ED6): the soft keyboard has no Tab. */
private val TABLE = listOf(
    BarButton(FormatCommand.PREVIOUS_CELL, "Previous Cell", EditorIcons.PreviousCell),
    BarButton(FormatCommand.NEXT_CELL, "Next Cell", EditorIcons.NextCell),
    BarButton(FormatCommand.ADD_ROW, "Add Row", EditorIcons.AddRow),
    BarButton(FormatCommand.ADD_COLUMN, "Add Column", EditorIcons.AddColumn),
)

/**
 * The formatting bar above the keyboard (T33, A301), after the T2 spike's: it
 * sits below the editor and moves up with the keyboard, scrolls sideways when
 * the phone is narrow, and none of its buttons takes the focus, so the note
 * keeps the keyboard and its selection (A307). Each button runs the shared
 * editor command the web's shortcuts run; formatting on at the selection
 * shows pressed.
 *
 * T40 P8 adds **+** (the slash catalogue as a sheet, ED4), the **Block** menu (ED5), the table
 * buttons while the caret is in a table (ED6), and Indent and Outdent in code (ED7). T44 adds
 * **Symbol** (A747): the person's line symbols, ticked on the lines that have them.
 */
@Composable
fun FormatBar(
    state: FormatState,
    onCommand: (FormatCommand) -> Unit,
    onLink: () -> Unit,
    onPicture: () -> Unit,
    modifier: Modifier = Modifier,
    /** The + sheet: insert a block without typing `/` (T40 P8, ED4). */
    onInsert: (() -> Unit)? = null,
    /** The Block menu's actions and its Turn into… (T40 P8, ED5). */
    onBlock: ((app.penmoss.engine.bridge.BlockAction) -> Unit)? = null,
    onTurnInto: () -> Unit = {},
    /** Attach a file: the document picker (T40 P8, ED12). */
    onAttach: (() -> Unit)? = null,
    /** The person's line symbols, for the Symbol menu (T44, A747). */
    symbols: List<LineSymbol> = emptyList(),
    /** Toggle a symbol, by slot, on the selected lines; null: no Symbol button. */
    onSymbol: ((Int) -> Unit)? = null,
    /** The Symbol menu's Edit symbols…: Settings → Symbols. */
    onEditSymbols: () -> Unit = {},
) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = modifier.fillMaxWidth().testTag("format-bar")) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 4.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (onInsert != null) BarTool("Insert a Block", EditorIcons.Plus, tag = "insertBlock", onClick = onInsert)
                for (button in MARKS) {
                    BarIcon(button.label, button.icon, active = button.command in state.active) { onCommand(button.command) }
                }
                BarIcon("Link", EditorIcons.Link, active = FormatCommand.LINK in state.active, onClick = onLink)
                StyleButton(state, onCommand)
                if (onBlock != null) BlockMenuButton(state, onBlock, onTurnInto)
                for (button in LISTS) {
                    BarIcon(button.label, button.icon, active = button.command in state.active) { onCommand(button.command) }
                }
                if (onSymbol != null) SymbolButton(state, symbols, onSymbol, onEditSymbols)
                BarIcon("Outdent", EditorIcons.Outdent, enabled = state.canOutdent) { onCommand(FormatCommand.OUTDENT) }
                BarIcon("Indent", EditorIcons.Indent, enabled = state.canIndent) { onCommand(FormatCommand.INDENT) }
                if (state.inTable) {
                    for (button in TABLE) BarIcon(button.label, button.icon) { onCommand(button.command) }
                }
                BarIcon("Add a Picture", EditorIcons.Picture, onClick = onPicture)
                if (onAttach != null) BarIcon("Attach a File", EditorIcons.Attach, onClick = onAttach)
                BarIcon("Undo", EditorIcons.Undo, enabled = state.canUndo) { onCommand(FormatCommand.UNDO) }
                BarIcon("Redo", EditorIcons.Redo, enabled = state.canRedo) { onCommand(FormatCommand.REDO) }
            }
        }
    }
}

/** Headings, quote, code block and the rarer marks: a menu that leaves the keyboard open. */
@Composable
private fun StyleButton(state: FormatState, onCommand: (FormatCommand) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val styled = STYLES.any { (command, _) -> command != FormatCommand.PARAGRAPH && command in state.active }
    Box {
        BarIcon("Text Style", EditorIcons.Heading, active = styled) { open = true }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            // Not focusable: the keyboard and the note's selection stay as they are.
            properties = PopupProperties(focusable = false),
        ) {
            for ((command, label) in STYLES) {
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        open = false
                        onCommand(command)
                    },
                    modifier = Modifier.noFocus().semantics { selected = command in state.active },
                )
            }
        }
    }
}

/**
 * Line symbols (T44, A747): a menu of the person's symbols, each with its glyph in its colour and
 * a tick when every selected line has it; a pick toggles it, as ⌃1–9 do on the web. Like the
 * style menu it leaves the keyboard open. Edit symbols… opens Settings → Symbols.
 */
@Composable
private fun SymbolButton(state: FormatState, symbols: List<LineSymbol>, onSymbol: (Int) -> Unit, onEditSymbols: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        BarIcon("Symbol", EditorIcons.Star, active = state.symbols.isNotEmpty(), enabled = state.canSymbol) { open = true }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            properties = PopupProperties(focusable = false),
            modifier = Modifier.testTag("symbol-menu"),
        ) {
            symbols.forEachIndexed { index, symbol ->
                val on = index in state.symbols
                // Symbols go by their glyph, not a name (T51, A940): the row is the glyph in its colour.
                DropdownMenuItem(
                    text = {
                        Text(
                            symbol.glyph,
                            color = symbolColour(symbol.colour),
                            style = MaterialTheme.typography.titleMedium,
                        )
                    },
                    trailingIcon = if (on) {
                        { Icon(EditorIcons.Tick, contentDescription = null, modifier = Modifier.size(20.dp)) }
                    } else {
                        null
                    },
                    onClick = {
                        open = false
                        onSymbol(index)
                    },
                    modifier = Modifier
                        .noFocus()
                        .testTag("symbol-$index")
                        .semantics {
                            role = Role.Checkbox
                            selected = on
                        },
                )
            }
            if (symbols.isEmpty()) {
                DropdownMenuItem(text = { Text("No symbols yet") }, onClick = {}, enabled = false)
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text("Edit Symbols…") },
                onClick = {
                    open = false
                    onEditSymbols()
                },
                modifier = Modifier.noFocus().testTag("symbol-edit"),
            )
        }
    }
}

@Composable
private fun BarIcon(
    label: String,
    icon: ImageVector,
    active: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colours = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RectangleShape,
        color = if (active) colours.primaryContainer else colours.surfaceContainer,
        contentColor = if (enabled) colours.onSurface else colours.onSurface.copy(alpha = 0.38f),
        modifier = Modifier
            .noFocus()
            .size(44.dp)
            .semantics {
                contentDescription = label
                role = Role.Button
                selected = active
            },
    ) {
        Box(contentAlignment = Alignment.Center) { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)) }
    }
}

/** The bar's buttons never take the focus from the note (the T2 spike's first IME finding). */
private fun Modifier.noFocus(): Modifier = focusProperties { canFocus = false }

/**
 * Links the selection, or the link the caret is in, to an address; or, with nothing
 * selected, adds the address as its own link. An empty address removes a link.
 */
@Composable
fun LinkDialog(current: String?, onApply: (String) -> Unit, onDismiss: () -> Unit) {
    var address by rememberSaveable { mutableStateOf(current.orEmpty()) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (current == null) "Add a link" else "Edit the link") },
        text = {
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                label = { Text("Address") },
                placeholder = { Text("penmoss.app") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (address.isNotBlank()) onApply(address) }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("link-address"),
            )
        },
        confirmButton = {
            TextButton(onClick = { onApply(address) }, enabled = address.isNotBlank()) { Text("Link") }
        },
        dismissButton = {
            Row {
                if (current != null) TextButton(onClick = { onApply("") }) { Text("Remove Link") }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}
