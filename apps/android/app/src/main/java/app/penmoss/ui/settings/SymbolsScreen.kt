package app.penmoss.ui.settings

import androidx.compose.foundation.background
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.square.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import app.penmoss.engine.settings.LineSymbol
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.ui.LocalSymbolColours
import app.penmoss.ui.symbolColour

/**
 * Settings → Symbols (T44, ST13, A747; T51, A939, A940): the person's line symbols, in shortcut
 * order, each its glyph in its colour. A row opens its glyph and colour to change; its arrows
 * move it to another slot; Add, Restore defaults and the keyboard shortcuts are below. Symbols go
 * by their glyph: Settings neither shows nor asks for a name, and a new one stores its glyph as
 * its name, so older builds still read the list. Every change is the web's rule-checked list,
 * synced like the theme. Nothing changes before the first sync has sent the settings.
 */
@Composable
fun SymbolsScreen(
    symbols: List<LineSymbol>,
    custom: Boolean,
    enabled: Boolean,
    /** Stores a list; returns why it cannot be stored, or null. */
    onChange: (List<LineSymbol>) -> String?,
    onReset: () -> Unit,
    onShortcuts: () -> Unit,
    onBack: () -> Unit,
) {
    // The slot being edited (a new one is `symbols.size`), or null.
    var editing by rememberSaveable { mutableStateOf<Int?>(null) }
    var said by remember { mutableStateOf<String?>(null) }
    fun change(next: List<LineSymbol>, success: String): String? {
        val problem = onChange(next)
        said = problem ?: success
        return problem
    }
    SectionScreen("Symbols", onBack, notice = if (enabled) null else SETTINGS_WAIT) {
        Help(
            "Mark a line as important, a question, a follow-up, an idea or next with a symbol before it. " +
                "Each is plain text at the start of the line (★ Call the bank), so the git mirror and agents see it too. " +
                "Changes sync to your other devices.",
        )
        GroupTitle("Your symbols")
        symbols.forEachIndexed { index, symbol ->
            ListItem(
                leadingContent = {
                    Text(
                        symbol.glyph,
                        color = symbolColour(symbol.colour),
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.width(36.dp).testTag("symbol-glyph-$index"),
                    )
                },
                headlineContent = { Text(LineSymbols.colourLabel(symbol.colour)) },
                supportingContent = { Text("Symbol ${index + 1}") },
                trailingContent = {
                    Row {
                        IconButton(
                            onClick = { change(symbols.moved(index, -1), "${symbol.glyph} is now symbol $index.") },
                            enabled = enabled && index > 0,
                            modifier = Modifier.testTag("symbol-up-$index"),
                        ) { Icon(Icons.Default.KeyboardArrowUp, contentDescription = "Move ${symbol.glyph} Up") }
                        IconButton(
                            onClick = { change(symbols.moved(index, 1), "${symbol.glyph} is now symbol ${index + 2}.") },
                            enabled = enabled && index < symbols.size - 1,
                            modifier = Modifier.testTag("symbol-down-$index"),
                        ) { Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Move ${symbol.glyph} Down") }
                    }
                },
                modifier = Modifier
                    .testTag("symbol-row-$index")
                    .clickable(enabled = enabled, onClickLabel = "Edit ${symbol.glyph}") { editing = index },
            )
        }
        if (symbols.isEmpty()) Help("No symbols: add one, or restore the defaults.")
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedButton(
                onClick = { editing = symbols.size },
                enabled = enabled && symbols.size < LineSymbols.MAX,
                modifier = Modifier.testTag("symbol-add"),
            ) { Text("Add a Symbol") }
            OutlinedButton(
                onClick = {
                    onReset()
                    said = "Restored " + LineSymbols.DEFAULTS.joinToString(" ") { it.glyph } + "."
                },
                enabled = enabled && custom,
                modifier = Modifier.testTag("symbol-reset"),
            ) { Text("Restore Defaults") }
        }
        ListItem(
            headlineContent = { Text("Keyboard Shortcuts") },
            supportingContent = { Text("With a hardware keyboard, Alt+Shift+1 to 9 toggle them; change their keys here") },
            modifier = Modifier.testTag("symbol-shortcuts").clickable(onClick = onShortcuts),
        )
        Text(
            said ?: "Up to ${LineSymbols.MAX}. A glyph is a symbol or emoji without letters, digits or markdown characters.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .testTag("symbols-notice")
                .semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
    editing?.let { slot ->
        val existing = symbols.getOrNull(slot)
        val glyph = LineSymbols.nextGlyph(symbols)
        SymbolDialog(
            initial = existing ?: LineSymbol(glyph, glyph, "accent"),
            isNew = existing == null,
            others = symbols.filterIndexed { at, _ -> at != slot },
            onSave = { symbol ->
                val next = if (existing == null) symbols + symbol else symbols.mapIndexed { at, each -> if (at == slot) symbol else each }
                val problem = change(next, if (existing == null) "Added ${symbol.glyph} as symbol ${slot + 1}." else "Saved ${symbol.glyph}.")
                if (problem == null) editing = null
                problem
            },
            onRemove = existing?.let {
                {
                    change(symbols.filterIndexed { at, _ -> at != slot }, "Removed ${it.glyph}. Lines with ${it.glyph} show it as text.")
                    editing = null
                }
            },
            onDismiss = { editing = null },
        )
    }
}

private fun List<LineSymbol>.moved(index: Int, by: Int): List<LineSymbol> =
    toMutableList().also { list -> list.add(index + by, list.removeAt(index)) }

/** The colour chips' value for "any colour", until one is picked. */
private const val CUSTOM = "custom"

/** A custom colour's start: the accent's hue, as the picker first shows it. */
private const val CUSTOM_START = "#3a7bd5"

/**
 * One symbol's glyph and colour (T51, A939), checked by the web's rules as they are chosen: a
 * grid of preset glyphs or a glyph of one's own, and a theme colour or any colour. A symbol
 * keeps its name while its glyph stays; a new glyph is its name too (A940).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SymbolDialog(
    initial: LineSymbol,
    isNew: Boolean,
    others: List<LineSymbol>,
    onSave: (LineSymbol) -> String?,
    onRemove: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var glyph by rememberSaveable { mutableStateOf(initial.glyph) }
    var colour by rememberSaveable { mutableStateOf(initial.colour) }
    // The last custom colour, kept while a theme colour is tried.
    var customColour by rememberSaveable { mutableStateOf(initial.colour.takeIf(LineSymbols::isHexColour) ?: CUSTOM_START) }
    var refused by remember { mutableStateOf<String?>(null) }
    val colours = LocalSymbolColours.current
    val taken = others.map { LineSymbols.glyphKey(it.glyph) }.toSet()
    val glyphProblem = LineSymbols.glyphProblem(glyph)
        ?: if (LineSymbols.glyphKey(glyph) in taken) "$glyph is already in the list" else null
    AlertDialog(
        onDismissRequest = onDismiss,
        // Clear of the keyboard (T51 manual pass): the dialog shrinks above it and its body
        // scrolls, so Remove, Cancel and Save stay in reach while the glyph or hex is typed.
        modifier = Modifier.windowInsetsPadding(WindowInsets.safeDrawing),
        properties = DialogProperties(decorFitsSystemWindows = false),
        title = { Text(if (isNew) "Add a Symbol" else "Edit ${initial.glyph}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Glyph", style = MaterialTheme.typography.labelLarge)
                FlowRow(
                    Modifier.testTag("symbol-presets"),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    LineSymbols.PRESET_GLYPHS.forEachIndexed { index, preset ->
                        val chosen = LineSymbols.glyphKey(preset) == LineSymbols.glyphKey(glyph)
                        val inList = LineSymbols.glyphKey(preset) in taken
                        Box(
                            Modifier
                                .size(40.dp)
                                .background(
                                    if (chosen) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent,
                                    RectangleShape,
                                )
                                .border(
                                    1.dp,
                                    if (chosen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                                    RectangleShape,
                                )
                                .selectable(selected = chosen, enabled = !inList, role = Role.RadioButton) { glyph = preset }
                                .testTag("symbol-preset-$index")
                                .semantics {
                                    contentDescription = preset
                                    if (inList) stateDescription = "Already in the list"
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                preset,
                                style = MaterialTheme.typography.titleMedium,
                                color = if (inList) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f) else symbolColour(colour),
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = glyph,
                    onValueChange = { glyph = it.take(LineSymbols.MAX_GLYPH_CHARS) },
                    label = { Text("Custom Glyph") },
                    singleLine = true,
                    isError = glyphProblem != null,
                    supportingText = { Text(glyphProblem ?: "Or paste any symbol or emoji") },
                    modifier = Modifier.fillMaxWidth().testTag("symbol-glyph").semantics { glyphProblem?.let { error(it) } },
                )
                Text("Colour", style = MaterialTheme.typography.labelLarge)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((key, label) in LineSymbols.COLOURS) {
                        FilterChip(
                            selected = key == colour,
                            onClick = { colour = key },
                            label = { Text(label) },
                            leadingIcon = {
                                Text(glyph.ifEmpty { "●" }, color = colours[key] ?: Color.Unspecified, modifier = Modifier.clearAndSetSemantics {})
                            },
                            modifier = Modifier.testTag("symbol-colour-$key"),
                        )
                    }
                    val custom = LineSymbols.isHexColour(colour)
                    FilterChip(
                        selected = custom,
                        onClick = { colour = customColour },
                        label = { Text(if (custom) "Custom: ${LineSymbols.colourLabel(colour)}" else "Custom Colour") },
                        leadingIcon = {
                            Text(glyph.ifEmpty { "●" }, color = HexColours.color(customColour), modifier = Modifier.clearAndSetSemantics {})
                        },
                        modifier = Modifier.testTag("symbol-colour-$CUSTOM"),
                    )
                }
                if (LineSymbols.isHexColour(colour)) {
                    ColourPicker(
                        hex = colour,
                        onChange = {
                            colour = it
                            customColour = it
                        },
                    )
                    Help("A custom colour is the same in light and dark; theme colours adapt.")
                }
                refused?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    // A symbol goes by its glyph (A940): a changed glyph is its name too.
                    val name = if (LineSymbols.glyphKey(glyph) == LineSymbols.glyphKey(initial.glyph) && !isNew) initial.name else glyph
                    refused = onSave(LineSymbol(glyph, name, colour))
                },
                enabled = glyphProblem == null,
                modifier = Modifier.testTag("symbol-save"),
            ) { Text(if (isNew) "Add" else "Save") }
        },
        dismissButton = {
            Row {
                if (onRemove != null) {
                    TextButton(onClick = onRemove, modifier = Modifier.testTag("symbol-remove")) {
                        Icon(Icons.Default.Delete, contentDescription = null)
                        Text("Remove")
                    }
                }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}
