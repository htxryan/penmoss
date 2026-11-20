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
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
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
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.engine.settings.LucideIcon
import app.penmoss.engine.settings.NotebookBadges
import app.penmoss.ui.common.IconButton
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.rememberLucideIcons
import app.penmoss.ui.common.roles
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/** The icons picked last on this phone (A1579's Recently Used), as stored values, newest first. */
internal class RecentIcons(private val context: Context) {
    private val prefs get() = context.getSharedPreferences(RecentCharacters.PREFS, Context.MODE_PRIVATE)
    private val list = ListSerializer(String.serializer())

    fun read(): List<String> = runCatching {
        Json.decodeFromString(list, prefs.getString(KEY, null) ?: "[]").take(MAX)
    }.getOrDefault(emptyList())

    fun add(value: String) {
        val next = (listOf(value) + read().filter { it != value }).take(MAX)
        prefs.edit().putString(KEY, Json.encodeToString(list, next)).apply()
    }

    companion object {
        const val KEY = "recentIcons"
        const val MAX = 16
    }
}

/** A row of the grid: a section's heading, or an icon ([section] keeps Recently Used's apart). */
private sealed interface IconCell {
    val key: String

    data class Head(val label: String) : IconCell {
        override val key get() = "head:$label"
    }

    data class Entry(val icon: LucideIcon, val section: String) : IconCell {
        override val key get() = "$section:${icon.name}"
    }
}

/**
 * The icon picker (A1579), the web's Icons tab as a dialog: a search field focused as it opens,
 * filtering Lucide's icons by name and tag ([app.penmoss.engine.settings.GlyphSearch], to the web's
 * order), then Recently Used (this phone's) and every icon by name. [current] (a Lucide name) is
 * marked; a pick is stored as `lucide:<name>`.
 */
@Composable
fun IconPicker(current: String?, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val recents = remember(context) { RecentIcons(context) }
    val icons = rememberLucideIcons()
    var query by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val cells: List<IconCell> = remember(query, icons) {
        when {
            icons == null -> emptyList()
            query.isNotBlank() -> icons.find(query).map { IconCell.Entry(it, "found") }
            else -> {
                val recent = recents.read()
                    .mapNotNull { value -> NotebookBadges.lucideName(value)?.let(icons::icon) }
                    .map { IconCell.Entry(it, "recent") }
                if (recent.isEmpty()) {
                    icons.all.map { IconCell.Entry(it, "all") }
                } else {
                    listOf(IconCell.Head("Recently Used")) + recent + IconCell.Head("All Icons") + icons.all.map { IconCell.Entry(it, "all") }
                }
            }
        }
    }
    // The grid opens on the chosen icon: at the top when Recently Used has it, else at its row.
    val chosenAt = cells.indexOfFirst { it is IconCell.Entry && it.icon.name == current }
    val opensAt = if ((cells.getOrNull(chosenAt) as? IconCell.Entry)?.section == "recent") 0 else chosenAt.coerceAtLeast(0)
    val grid = rememberLazyGridState(initialFirstVisibleItemIndex = opensAt)
    LaunchedEffect(icons != null) { if (icons != null && opensAt > 0 && query.isBlank()) grid.scrollToItem(opensAt) }
    val tracked = rememberTrackedDialog("iconPicker")
    val pick = { icon: LucideIcon ->
        tracked.done()
        val value = NotebookBadges.LUCIDE_PREFIX + icon.name
        recents.add(value)
        onPick(value)
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        // In the dialog's own composition, so the field is there to take the focus.
        LaunchedEffect(Unit) { focus.requestFocus() }
        Surface(
            Modifier.fillMaxWidth().fillMaxHeight(0.85f).padding(horizontal = 12.dp).testTag("icon-picker"),
            shape = RectangleShape,
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Choose an Icon",
                        style = MaterialTheme.roles.dialogTitle,
                        modifier = Modifier.weight(1f).semantics { heading() },
                    )
                    IconButton(onClick = trackedClick("dialog.close", onDismiss)) { Icon(Icons.Default.Close, contentDescription = "Close") }
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it.take(64) },
                    label = { Text("Search Icons") },
                    placeholder = { Text("A name or a word") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("icon-search"),
                )
                val said = when {
                    icons == null -> "Loading icons…"
                    query.isNotBlank() && cells.isEmpty() -> "No icons match “${query.trim()}”."
                    else -> null
                }
                if (said != null) {
                    Text(
                        said,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("icon-said").semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(48.dp),
                    state = grid,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp).weight(1f).testTag("icon-grid"),
                ) {
                    items(
                        cells,
                        key = IconCell::key,
                        span = { cell -> if (cell is IconCell.Head) GridItemSpan(maxLineSpan) else GridItemSpan(1) },
                    ) { cell ->
                        when (cell) {
                            is IconCell.Head -> Text(
                                cell.label,
                                style = MaterialTheme.roles.listHead,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 12.dp, bottom = 4.dp).semantics { heading() },
                            )
                            is IconCell.Entry -> {
                                val chosen = cell.icon.name == current
                                val label = characterLabel(cell.icon.name)
                                Box(
                                    Modifier
                                        .size(48.dp)
                                        .background(if (chosen) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent, RectangleShape)
                                        .border(1.dp, if (chosen) MaterialTheme.colorScheme.primary else Color.Transparent, RectangleShape)
                                        .selectable(selected = chosen, role = Role.Button, onClick = trackedClick("icon-picker.icon") { pick(cell.icon) })
                                        .testTag("icon-${cell.icon.name}")
                                        .semantics { contentDescription = label },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        LucideAssets.vector(cell.icon),
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.onSurface,
                                        modifier = Modifier.size(24.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                if (icons != null) {
                    Text(
                        if (query.isBlank()) "${icons.all.size} icons from Lucide" else "${cells.size} found",
                        style = MaterialTheme.roles.meta,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("icon-count"),
                    )
                }
            }
        }
    }
}
