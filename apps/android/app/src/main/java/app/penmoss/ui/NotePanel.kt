package app.penmoss.ui

import android.content.Context
import androidx.compose.ui.graphics.RectangleShape
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import app.penmoss.ui.square.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.VerticalDivider
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.ui.settings.SettingsIcons
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/*
 * The note panel (T51, A936; T53 item 9, A985): Metadata, Comments, Version History and Local
 * Graph as vertical tabs, the web's: open on one tab, or closed. Open, it covers the note, the
 * tab's name and Close at its top and the four tabs' icons down its right edge, the open one
 * marked; tapping it closes the panel, as on the web. The ⋮ menu's items and the bar's Info button
 * open their tab; the last tab shown is remembered on this phone. Over the note, so the editor
 * stays open: history flushes it, comments reach its page.
 */

/** The panel's tabs, in the web's order, each with its name (its tooltip and content description). */
enum class PanelTab(val label: String, val icon: ImageVector, val tag: String) {
    METADATA("Metadata", SettingsIcons.Info, "panelMetadata"),
    COMMENTS("Comments", SettingsIcons.Comment, "panelComments"),
    HISTORY("Version History", SettingsIcons.History, "panelHistory"),
    GRAPH("Local Graph", SettingsIcons.Graph, "panelGraph"),
}

/** The last tab shown, per device (A936), as the web keeps it in local storage. */
object PanelMemory {
    private const val FILE = "penmoss.ui"
    private const val KEY = "notePanel.tab"

    fun last(context: Context): PanelTab =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null)
            ?.let { name -> PanelTab.entries.firstOrNull { it.name == name } } ?: PanelTab.METADATA

    fun remember(context: Context, tab: PanelTab) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY, tab.name).apply()
    }
}

/**
 * The panel: the tab's name and Close over [content] for the tab shown, the tabs down its right
 * edge. Back closes it. [openComments] is the Comments tab's badge.
 */
@Composable
fun NotePanel(tab: PanelTab, onTab: (PanelTab) -> Unit, onClose: () -> Unit, openComments: Int = 0, content: @Composable (PanelTab) -> Unit) {
    BackHandler(onBack = onClose)
    // The panel covers the note, so it takes the focus from the note's page and puts the keyboard
    // away (T52 pass): otherwise the keyboard stays up, still the page's, and what is typed with
    // no field of the panel chosen goes into the hidden note. A field tapped raises it again.
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) {
        focus.requestFocus()
        keyboard?.hide()
    }
    Surface(Modifier.fillMaxSize().focusRequester(focus).focusTarget().testTag("notePanel")) {
        Row(Modifier.fillMaxSize().statusBarsPadding()) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        tab.label.uppercase(),
                        Modifier.weight(1f).semantics { heading() }.testTag("panelTitle"),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    TipIconButton(Icons.Default.Close, "Close Panel", onClick = onClose, modifier = Modifier.testTag("panelClose"))
                }
                Box(Modifier.weight(1f).fillMaxWidth()) { content(tab) }
            }
            VerticalDivider()
            PanelStrip(tab, openComments, onPick = { if (it == tab) onClose() else onTab(it) })
        }
    }
}

/** The tabs' icons, top to bottom, the open one shaded with the accent on its open side. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PanelStrip(tab: PanelTab, openComments: Int, onPick: (PanelTab) -> Unit) {
    val colours = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxHeight().padding(vertical = 8.dp).selectableGroup().testTag("panelStrip"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (each in PanelTab.entries) {
            val selected = each == tab
            TooltipBox(
                positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Start),
                tooltip = { PlainTooltip { Text(each.label) } },
                state = rememberTooltipState(),
            ) {
                Box(
                    Modifier
                        .size(48.dp)
                        .background(if (selected) colours.secondaryContainer else Color.Transparent)
                        .drawBehind {
                            if (selected) drawRect(colours.primary, size = Size(2.dp.toPx(), size.height))
                        }
                        .selectable(selected = selected, role = Role.Tab, onClick = { onPick(each) })
                        .testTag(each.tag)
                        .semantics {
                            contentDescription = if (each == PanelTab.COMMENTS && openComments > 0) "${each.label}, $openComments open" else each.label
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    val tint = if (selected) colours.onSecondaryContainer else colours.onSurfaceVariant
                    if (each == PanelTab.COMMENTS && openComments > 0) {
                        BadgedBox(badge = { Badge(Modifier.clearAndSetSemantics {}) { Text("$openComments") } }) {
                            Icon(each.icon, contentDescription = null, tint = tint)
                        }
                    } else {
                        Icon(each.icon, contentDescription = null, tint = tint)
                    }
                }
            }
        }
    }
}

/** A note next to the open one in its local graph: linked from it ([out]), to it ([into]), or both. */
@Immutable
data class Neighbour(val id: String, val title: String, val out: Boolean, val into: Boolean)

/** The notes one link from [noteId], by title, in the graph [model] (open notebooks only, A752). */
fun neighbours(model: GraphModel, noteId: String): List<Neighbour> {
    val notes = model.message.notes
    val out = notes.firstOrNull { it.id == noteId }?.links.orEmpty().toSet()
    val into = notes.filter { noteId in it.links }.map { it.id }.toSet()
    return (out + into).filter { it != noteId }.mapNotNull { id ->
        val title = model.titleOf(id) ?: return@mapNotNull null
        Neighbour(id, title, id in out, id in into)
    }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.title })
}

/** At most this many neighbours are drawn around the note; the list under the drawing has them all. */
private const val DRAWN = 12

/**
 * The Local Graph tab (A936): the note's neighbourhood, drawn natively, as the phone holds one
 * page's WebView at a time (A418) and the note's is open; the whole graph, on its own screen, is
 * one tap away. Each neighbour opens on a tap.
 */
@Composable
fun LocalGraphPanel(title: String, neighbours: List<Neighbour>?, onOpen: (String) -> Unit, onOpenGraph: () -> Unit) {
    LazyColumn(Modifier.fillMaxSize().testTag("panelLocalGraph")) {
        item {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when (neighbours?.size) {
                        null -> "Reading links…"
                        0 -> "No links to or from this note yet."
                        1 -> "1 linked note"
                        else -> "${neighbours.size} linked notes"
                    },
                    Modifier.weight(1f).semantics { heading() },
                    style = MaterialTheme.typography.titleSmall,
                )
                FilledTonalButton(onClick = onOpenGraph, modifier = Modifier.testTag("panelOpenGraph")) { Text("Open Full Graph") }
            }
        }
        if (!neighbours.isNullOrEmpty()) {
            item { Neighbourhood(title, neighbours.take(DRAWN), onOpen) }
            item { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            items(neighbours, key = { it.id }) { neighbour ->
                Text(
                    neighbour.title,
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .clickable(onClickLabel = "Open ${neighbour.title}") { onOpen(neighbour.id) }
                        .padding(horizontal = 16.dp, vertical = 12.dp)
                        .testTag("panelNeighbour-${neighbour.id}"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** The drawing: the note in the middle, its neighbours on a ring, a line to each. */
@Composable
private fun Neighbourhood(title: String, neighbours: List<Neighbour>, onOpen: (String) -> Unit) {
    val colours = MaterialTheme.colorScheme
    BoxWithConstraints(Modifier.fillMaxWidth().height(280.dp).padding(8.dp).clearAndSetSemantics {}) {
        val density = LocalDensity.current
        val width = constraints.maxWidth.toFloat()
        val height = constraints.maxHeight.toFloat()
        val centre = Offset(width / 2, height / 2)
        val radius = min(width, height) / 2 - with(density) { 28.dp.toPx() }
        val spots = neighbours.indices.map { index ->
            val angle = 2 * PI * index / neighbours.size - PI / 2
            Offset(centre.x + radius * cos(angle).toFloat(), centre.y + radius * sin(angle).toFloat())
        }
        Canvas(Modifier.fillMaxSize()) {
            for (spot in spots) drawLine(colours.outline, centre, spot, strokeWidth = 1.5.dp.toPx())
            for (spot in spots) drawCircle(colours.primary, radius = 5.dp.toPx(), center = spot)
            drawCircle(colours.primary, radius = 9.dp.toPx(), center = centre)
        }
        GraphLabel(title, centre, strong = true) {}
        neighbours.forEachIndexed { index, neighbour -> GraphLabel(neighbour.title, spots[index], strong = false) { onOpen(neighbour.id) } }
    }
}

@Composable
private fun GraphLabel(text: String, at: Offset, strong: Boolean, onClick: () -> Unit) {
    val density = LocalDensity.current
    val half = with(density) { 48.dp.toPx() }
    Text(
        text.ifBlank { Items.UNTITLED },
        Modifier
            .offset(x = with(density) { (at.x - half).toDp() }, y = with(density) { (at.y + 6.dp.toPx()).toDp() })
            .widthIn(max = 96.dp)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.85f), RectangleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp),
        style = if (strong) MaterialTheme.typography.labelLarge else MaterialTheme.typography.labelSmall,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/**
 * A sheet's content as a bottom sheet of its own, or ([embedded]) as a note panel tab (A936),
 * under the same test tag either way.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SheetOrPanel(
    embedded: Boolean,
    onDismiss: () -> Unit,
    sheet: SheetState,
    tag: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (embedded) {
        Column(Modifier.fillMaxSize().testTag(tag), content = content)
    } else {
        ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, modifier = Modifier.testTag(tag), content = content)
    }
}
