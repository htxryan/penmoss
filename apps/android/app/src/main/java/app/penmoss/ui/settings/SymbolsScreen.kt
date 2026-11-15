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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import app.penmoss.ui.common.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
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
import app.penmoss.ui.common.LocalSymbolColours
import app.penmoss.ui.common.symbolColour

/** A slot's key as the phone shows it (A747): its binding, or Alt+Shift+N; null with none. */
fun symbolKeys(settings: kotlinx.serialization.json.JsonObject): List<String?> {
    val bindings = app.penmoss.engine.keys.Bindings.of(app.penmoss.engine.keys.ShortcutCatalogue.bundled, settings)
    return (1..LineSymbols.MAX).map { slot -> bindings.keysOf("editor.symbol$slot").firstOrNull()?.let(app.penmoss.engine.keys.Combos::format) }
}

/**
 * Settings → Symbols (T44, ST13, A747; T51, A939, A940; PEN-146 option A): the person's line
 * symbols in shortcut order, each row its drag handle, its glyph in its colour in a box of one
 * size, its colour's name and its keyboard key (rebound keys show as rebound), and Remove. A row
 * opens its glyph and colour to change; dragging moves it to another slot (and so another key).
 * Add with "N of 9" beside it, and Restore Defaults. Symbols go by their glyph: a new one stores
 * its glyph as its name, so older builds still read the list. Every change is the web's
 * rule-checked list, synced like the theme. Nothing changes before the settings are read.
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
    /** Each slot's key, from the bindings; Alt+Shift+N where none is given. */
    keys: List<String?> = (1..LineSymbols.MAX).map { "Alt+Shift+$it" },
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
        Help(modifier = Modifier.settingRow("symbols"), text = "Type a symbol at the start of a line to mark it, as plain text (★ Call the bank), so agents and the repository see it too. Up to ${LineSymbols.MAX}. Changes sync to your other devices.")
        ReorderableColumn(
            items = symbols.mapIndexed { index, symbol -> index to symbol },
            key = { (_, symbol) -> symbol.glyph },
            name = { (_, symbol) -> symbol.glyph },
            enabled = enabled,
            onMove = { from, to -> change(symbols.movedTo(from, to), "${symbols[from].glyph} is now symbol ${to + 1}.") },
            modifier = Modifier.testTag("symbolList"),
        ) { (index, symbol), _, handle ->
            ListItem(
                leadingContent = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        handle()
                        // One size for every glyph, so the column lines up (PEN-146).
                        Box(
                            Modifier.size(40.dp).border(1.dp, MaterialTheme.colorScheme.outlineVariant).testTag("symbol-glyph-$index"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(symbol.glyph, color = symbolColour(symbol.colour), style = MaterialTheme.typography.titleLarge, maxLines = 1)
                        }
                    }
                },
                headlineContent = { Text(LineSymbols.colourLabel(symbol.colour)) },
                supportingContent = { Text(keys.getOrNull(index) ?: "No key", Modifier.testTag("symbol-key-$index")) },
                trailingContent = {
                    IconButton(
                        onClick = { change(symbols.filterIndexed { at, _ -> at != index }, "Removed ${symbol.glyph}. Lines with ${symbol.glyph} show it as text.") },
                        enabled = enabled,
                        modifier = Modifier.testTag("symbol-delete-$index"),
                    ) { Icon(Icons.Default.Close, contentDescription = "Remove ${symbol.glyph}") }
                },
                modifier = Modifier
                    .testTag("symbol-row-$index")
                    .clickable(enabled = enabled, onClickLabel = "Edit ${symbol.glyph}") { editing = index },
            )
        }
        if (symbols.isEmpty()) Help("No symbols: add one, or restore the defaults.")
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = { editing = symbols.size },
                enabled = enabled && symbols.size < LineSymbols.MAX,
                modifier = Modifier.testTag("symbol-add"),
            ) { Text("+ Add a Symbol") }
            Text("${symbols.size} of ${LineSymbols.MAX}", Modifier.testTag("symbol-count"), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.padding(horizontal = 8.dp)) {
            // Quiet, since it replaces the list (PEN-146).
            TextButton(
                onClick = {
                    onReset()
                    said = "Restored " + LineSymbols.DEFAULTS.joinToString(" ") { it.glyph } + "."
                },
                enabled = enabled && custom,
                modifier = Modifier.settingRow("restore-default-symbols").testTag("symbol-reset"),
            ) { Text("Restore Defaults") }
            TextButton(onClick = onShortcuts, modifier = Modifier.testTag("symbol-shortcuts")) { Text("Change Their Keys…") }
        }
        Text(
            said ?: "A glyph is a symbol or emoji without letters, digits or markdown characters.",
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
