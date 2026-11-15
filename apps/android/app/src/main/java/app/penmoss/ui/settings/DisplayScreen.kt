package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.penmoss.engine.settings.SidebarLayout
import app.penmoss.ui.common.TextButton

/**
 * Settings → Home (T42, A576; T40 ST12, A650; PEN-146): the Mac's Sidebar page, with only what Home
 * has. A switch for each of Home's shortcuts (Tags is new, A1438); Home's sections, dragged into
 * their order and each shown or hidden; Quick Access's notebook names; and how many notes Recent
 * Notes lists. Search always shows. Nothing changes before the settings are read.
 */
@Composable
fun DisplayScreen(
    choices: List<DisplayChoice>,
    enabled: Boolean,
    onChange: (key: String, shown: Boolean) -> Unit,
    onBack: () -> Unit,
    /** The sidebar's sections, Recent Notes' length and Quick Access's notebook names (T53, A983). */
    layout: HomeLayout = HomeLayout(),
    onSectionHidden: (section: String, hide: Boolean) -> Unit = { _, _ -> },
    onRecentCount: (Int) -> Unit = {},
    onQuickAccessNotebook: (Boolean) -> Unit = {},
    /** Home's sections in their new order (PEN-146). */
    onSectionOrder: (List<String>) -> Unit = {},
) {
    SectionScreen("Home", onBack, notice = if (enabled) null else SETTINGS_WAIT) {
        Help("A hidden shortcut still works from Search and a keyboard. Search always shows.")
        GroupTitle("Shortcuts on Home")
        for (choice in choices) Toggle(choice.label, null, choice.shown, enabled, "display-${choice.key}") { onChange(choice.key, it) }
        GroupTitle("Sections")
        Help("Drag a section by its handle to move it.")
        val home = layout.order.filter { it in HomeLayout.HOME_SECTIONS }
        ReorderableColumn(
            items = home,
            key = { it },
            name = { SidebarLayout.NAMES.getValue(it) },
            enabled = enabled,
            onMove = { from, to -> onSectionOrder(home.movedTo(from, to)) },
            modifier = Modifier.testTag("homeSections"),
        ) { section, _, handle ->
            val shown = section !in layout.hidden
            // One column per section: the row's Box would draw Quick Access's own switch over it.
            Column {
                ListItem(
                    leadingContent = handle,
                    headlineContent = { Text(SidebarLayout.NAMES.getValue(section)) },
                    supportingContent = when (section) {
                        SidebarLayout.RECENT -> ({ Text("Shows ${layout.recentCount}") })
                        else -> null
                    },
                    trailingContent = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (section == SidebarLayout.RECENT) RecentStepper(layout.recentCount, enabled, onRecentCount)
                            // Its own switch, not the row's: the row holds the drag handle and the stepper too.
                            Switch(
                                checked = shown,
                                onCheckedChange = { onSectionHidden(section, !it) },
                                enabled = enabled,
                                modifier = Modifier.testTag("display-section-$section").semantics { contentDescription = "Show ${SidebarLayout.NAMES.getValue(section)}" },
                            )
                        }
                    },
                )
                if (section == SidebarLayout.QUICK_ACCESS) {
                    Toggle("Show Notebook Names", "Under each note in Quick Access", layout.quickAccessNotebook, enabled, "display-quickAccessNotebook", Modifier.padding(start = 40.dp)) {
                        onQuickAccessNotebook(it)
                    }
                }
            }
        }
    }
}

/** A switch as a whole row, so TalkBack reads one control with its name. */
@Composable
private fun Toggle(label: String, supporting: String?, on: Boolean, enabled: Boolean, tag: String, modifier: Modifier = Modifier, onChange: (Boolean) -> Unit) {
    ListItem(
        headlineContent = { Text(label) },
        supportingContent = supporting?.let { { Text(it, style = MaterialTheme.typography.bodySmall) } },
        trailingContent = { Switch(checked = on, onCheckedChange = null, enabled = enabled) },
        modifier = modifier.testTag(tag).toggleable(value = on, enabled = enabled, role = Role.Switch, onValueChange = onChange),
    )
}

/** Recent Notes' − and + (1 to 50), each named for TalkBack, which would read "minus" alone (T53 pass). */
@Composable
private fun RecentStepper(count: Int, enabled: Boolean, onRecentCount: (Int) -> Unit) {
    TextButton(
        onClick = { onRecentCount(count - 1) },
        enabled = enabled && count > SidebarLayout.RECENT_MIN,
        modifier = Modifier.testTag("recentFewer").semantics { contentDescription = "Fewer Notes in Recent Notes" },
    ) { Text("−") }
    Text("$count", Modifier.testTag("display-recentCount"))
    TextButton(
        onClick = { onRecentCount(count + 1) },
        enabled = enabled && count < SidebarLayout.RECENT_MAX,
        modifier = Modifier.testTag("recentMore").semantics { contentDescription = "More Notes in Recent Notes" },
    ) { Text("+") }
}
