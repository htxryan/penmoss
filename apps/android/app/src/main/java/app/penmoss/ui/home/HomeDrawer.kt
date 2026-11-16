package app.penmoss.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.NotebookBadgeView
import app.penmoss.ui.common.rememberLucideIcons
import app.penmoss.ui.common.roles

/** A notebook on this phone, as the drawer lists it. */
data class DrawerNotebook(val localId: String, val name: String, val badge: app.penmoss.engine.settings.NotebookBadge? = null)

/**
 * The notebook Home's drawer (Ryan's Android feedback, 15 Nov 2026; A1604, A1607): Android's
 * hamburger menu with the Mac sidebar's areas. First the places its shortcuts and sections lead to
 * as a 4×2 grid of tiles (Home, Search, Today, This Week; Journal for its Calendar, All Notes, Tags,
 * Graph), then Notebooks (each
 * on this phone, this one marked, and All Notebooks), then Quick Capture, Trash, Settings and Send
 * Feedback. A pick closes the drawer, then goes.
 */
@Composable
internal fun HomeDrawerSheet(ui: HomeUi, actions: HomeActions, close: () -> Unit) {
    fun go(action: () -> Unit): () -> Unit = {
        close()
        action()
    }
    ModalDrawerSheet(Modifier.testTag("homeDrawer"), drawerShape = RectangleShape) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
            Spacer(Modifier.height(16.dp))
            // The places, as a grid of tiles (item 10, A1607): the notebook's name is the
            // selected row under Notebooks, so the drawer has no title of its own.
            val places = listOf(
                Place("Home", "house", "drawerHome", selected = true) {},
                Place("Search", "search", "drawerSearch", onClick = actions.onSearch),
                Place("Today", "calendar", "drawerToday", onClick = actions.onToday),
                Place("This Week", "calendar-range", "drawerThisWeek", onClick = actions.onThisWeek),
                Place("Journal", "book-open", "homeJournal", onClick = actions.onJournal),
                Place("All Notes", "files", "homeAllNotes", onClick = actions.onAllNotes),
                Place("Tags", "tag", "homeTags", onClick = actions.onTags),
                Place("Graph", "waypoints", "drawerGraph", onClick = actions.onGraph),
            )
            for (row in places.chunked(4)) {
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    for (place in row) Tile(place, Modifier.weight(1f), go(place.onClick))
                }
            }
            Spacer(Modifier.height(6.dp))
            if (ui.notebooks.isNotEmpty()) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                Text(
                    "Notebooks",
                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() },
                    style = MaterialTheme.roles.listHead,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                for (notebook in ui.notebooks) {
                    val here = notebook.localId == ui.notebookId
                    NavigationDrawerItem(
                        label = { Text(notebook.name, maxLines = 1) },
                        selected = here,
                        onClick = go { if (!here) actions.onNotebook(notebook.localId) },
                        icon = notebook.badge?.let { badge -> { NotebookBadgeView(badge, notebook.name) } },
                        modifier = Modifier.testTag("drawerNotebook-${notebook.localId}"),
                        // Square, as the app's controls are (SquareControls.kt).
                        shape = RectangleShape,
                    )
                }
                Item("All Notebooks", "library", "drawerAllNotebooks", onClick = go(actions.onAllNotebooks))
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Item("Quick Capture", "zap", "homeCapture", onClick = go(actions.onCapture))
            Item("Trash", "trash", "openTrash", onClick = go(actions.onTrash))
            Item("Settings", "settings", "drawerSettings", onClick = go(actions.onSettings))
            actions.onFeedback?.let { Item("Send Feedback", "message-square", "homeFeedback", onClick = go(it)) }
            Spacer(Modifier.height(12.dp))
        }
    }
}

/** One of the drawer's places: a tile in its grid. */
private class Place(val label: String, val icon: String, val tag: String, val selected: Boolean = false, val onClick: () -> Unit)

/**
 * A place's tile, as a navigation bar's item draws one: the icon in a 56×32 indicator, shaded
 * when it is where you are, and its name under it on one line.
 */
@Composable
private fun Tile(place: Place, modifier: Modifier, onClick: () -> Unit) {
    val glyph = rememberLucideIcons()?.icon(place.icon)
    val colours = MaterialTheme.colorScheme
    Column(
        modifier
            .selectable(selected = place.selected, role = Role.Button, onClick = onClick)
            .padding(vertical = 6.dp)
            .testTag(place.tag),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            Modifier.size(width = 56.dp, height = 32.dp).background(if (place.selected) colours.secondaryContainer else Color.Transparent),
            contentAlignment = Alignment.Center,
        ) {
            val tint = if (place.selected) colours.onSecondaryContainer else colours.onSurfaceVariant
            if (glyph != null) Icon(LucideAssets.vector(glyph), contentDescription = null, Modifier.size(22.dp), tint = tint)
        }
        Text(
            place.label,
            style = MaterialTheme.roles.meta,
            color = colours.onSurface,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun Item(label: String, icon: String, tag: String, selected: Boolean = false, onClick: () -> Unit) {
    val glyph = rememberLucideIcons()?.icon(icon)
    NavigationDrawerItem(
        label = { Text(label, maxLines = 1) },
        selected = selected,
        onClick = onClick,
        icon = { if (glyph != null) Icon(LucideAssets.vector(glyph), contentDescription = null, Modifier.size(22.dp)) else Spacer(Modifier.size(22.dp)) },
        modifier = Modifier.testTag(tag),
        shape = RectangleShape,
    )
}
