package app.penmoss.ui.home

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
 * The notebook Home's drawer (Ryan's Android feedback, 15 Nov 2026; A1604): Android's hamburger
 * menu with the Mac sidebar's areas. First the places its shortcuts and sections lead to (Home,
 * Search, Today, This Week, Journal for its Calendar, All Notes, Tags, Graph), then Notebooks (each
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
            Spacer(Modifier.height(12.dp))
            Text(
                ui.title,
                Modifier.padding(horizontal = 16.dp, vertical = 12.dp).semantics { heading() },
                style = MaterialTheme.roles.sectionHead,
            )
            Item("Home", "house", "drawerHome", selected = true, go {})
            Item("Search", "search", "drawerSearch", onClick = go(actions.onSearch))
            Item("Today", "calendar", "drawerToday", onClick = go(actions.onToday))
            Item("This Week", "calendar-range", "drawerThisWeek", onClick = go(actions.onThisWeek))
            Item("Journal", "book-open", "homeJournal", onClick = go(actions.onJournal))
            Item("All Notes", "files", "homeAllNotes", onClick = go(actions.onAllNotes))
            Item("Tags", "tag", "homeTags", onClick = go(actions.onTags))
            Item("Graph", "waypoints", "drawerGraph", onClick = go(actions.onGraph))
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
