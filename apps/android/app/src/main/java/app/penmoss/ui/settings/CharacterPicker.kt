package app.penmoss.ui.settings

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.penmoss.engine.settings.CharacterEntry
import app.penmoss.engine.settings.Characters
import app.penmoss.engine.settings.GlyphSearch
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.ui.common.IconButton
import app.penmoss.ui.common.roles
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/** A character's name in Title Case: "light bulb" is "Light Bulb", "flag: wales" "Flag: Wales". */
internal fun characterLabel(name: String): String =
    name.replace('-', ' ').split(' ').joinToString(" ") { word -> word.replaceFirstChar { it.uppercase() } }

/** The characters picked last on this phone (A1568's Recently Used), newest first. */
internal class RecentCharacters(private val context: Context) {
    private val prefs get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val list = ListSerializer(String.serializer())

    fun read(): List<String> = runCatching {
        Json.decodeFromString(list, prefs.getString(KEY, null) ?: "[]").take(MAX)
    }.getOrDefault(emptyList())

    fun add(glyph: String) {
        val key = LineSymbols.glyphKey(glyph)
        val next = (listOf(glyph) + read().filter { LineSymbols.glyphKey(it) != key }).take(MAX)
        prefs.edit().putString(KEY, Json.encodeToString(list, next)).apply()
    }

    companion object {
        const val PREFS = "penmoss.picker"
        const val KEY = "recentCharacters"
        const val MAX = 16
    }
}

/** A row of the grid: a section's heading, or a character (its own pasted one: not in the list). */
private sealed interface PickerCell {
    val key: String

    data class Head(val label: String) : PickerCell {
        override val key get() = "head:$label"
    }

    /** [section] keeps a character in Recently Used apart from the same one in its group. */
    data class Glyph(val glyph: String, val label: String, val section: String) : PickerCell {
        override val key get() = "$section:$glyph"
    }
}

/**
 * The symbol picker (A1569), the web's Characters tab as a dialog: a search field focused as it
 * opens, filtering by name and keyword ([GlyphSearch], to the web's order), then Recently Used and
 * every character by group. [refusal] says why a character cannot be picked (another symbol has it,
 * or the glyph rules refuse it): such a one is faded and refused, its reason in its description. A
 * pasted character that is not in the list is offered as itself; one the rules refuse says why.
 */
@Composable
fun CharacterPicker(
    current: String,
    refusal: (String) -> String?,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val recents = remember(context) { RecentCharacters(context) }
    var query by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val all = remember { Characters.all }
    val byKey = remember(all) { all.associateBy { LineSymbols.glyphKey(it.glyph) } }
    val pasted = query.trim()
    val found = remember(query) { if (pasted.isEmpty()) all else GlyphSearch.find(all, query) }
    val listed = pasted.isNotEmpty() && found.any { LineSymbols.glyphKey(it.glyph) == LineSymbols.glyphKey(pasted) }
    // A word is a search, never a glyph: the rules are only said for what has no letters.
    val pastedProblem = if (pasted.isNotEmpty() && !listed && pasted.none { it.isLetterOrDigit() }) refusal(pasted) else null
    val cells: List<PickerCell> = remember(query, all) {
        if (pasted.isNotEmpty()) {
            val own = if (!listed && pasted.none { it.isLetterOrDigit() } && refusal(pasted) == null) {
                listOf(PickerCell.Glyph(pasted, "Use $pasted", "own"))
            } else emptyList()
            own + found.map { PickerCell.Glyph(it.glyph, characterLabel(it.name), "found") }
        } else {
            val recent = recents.read().map { glyph ->
                PickerCell.Glyph(glyph, byKey[LineSymbols.glyphKey(glyph)]?.let { characterLabel(it.name) } ?: glyph, "recent")
            }
            val groups = all.groupBy(CharacterEntry::group)
            (if (recent.isEmpty()) emptyList() else listOf(PickerCell.Head("Recently Used")) + recent) +
                groups.flatMap { (group, entries) ->
                    listOf(PickerCell.Head(group)) + entries.map { PickerCell.Glyph(it.glyph, characterLabel(it.name), group) }
                }
        }
    }
    val pick = { glyph: String ->
        if (refusal(glyph) == null) {
            recents.add(glyph)
            onPick(glyph)
        }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        // In the dialog's own composition, so the field is there to take the focus.
        LaunchedEffect(Unit) { focus.requestFocus() }
        Surface(
            Modifier.fillMaxWidth().fillMaxHeight(0.85f).padding(horizontal = 12.dp).testTag("character-picker"),
            shape = RectangleShape,
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Choose a Symbol",
                        style = MaterialTheme.roles.dialogTitle,
                        modifier = Modifier.weight(1f).semantics { heading() },
                    )
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "Close") }
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it.take(64) },
                    label = { Text("Search Symbols and Emoji") },
                    placeholder = { Text("A name, a word, or paste one") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("character-search"),
                )
                val said = pastedProblem
                    ?: if (pasted.isNotEmpty() && cells.isEmpty()) "No characters match “$pasted”." else null
                if (said != null) {
                    Text(
                        said,
                        color = if (pastedProblem != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("character-said").semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(48.dp),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp).weight(1f).testTag("character-grid"),
                ) {
                    items(
                        cells,
                        key = PickerCell::key,
                        span = { cell -> if (cell is PickerCell.Head) GridItemSpan(maxLineSpan) else GridItemSpan(1) },
                    ) { cell ->
                        when (cell) {
                            is PickerCell.Head -> Text(
                                cell.label,
                                style = MaterialTheme.roles.listHead,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 12.dp, bottom = 4.dp).semantics { heading() },
                            )
                            is PickerCell.Glyph -> {
                                val chosen = LineSymbols.glyphKey(cell.glyph) == LineSymbols.glyphKey(current)
                                val refused = if (chosen) null else refusal(cell.glyph)
                                Box(
                                    Modifier
                                        .size(48.dp)
                                        .background(if (chosen) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent, RectangleShape)
                                        .border(1.dp, if (chosen) MaterialTheme.colorScheme.primary else Color.Transparent, RectangleShape)
                                        .selectable(selected = chosen, enabled = refused == null, role = Role.Button) { pick(cell.glyph) }
                                        .testTag("character-${cell.glyph}")
                                        .semantics { contentDescription = if (refused != null) "${cell.label}, $refused" else cell.label },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        cell.glyph,
                                        style = MaterialTheme.typography.titleLarge,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (refused != null) 0.38f else 1f),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
