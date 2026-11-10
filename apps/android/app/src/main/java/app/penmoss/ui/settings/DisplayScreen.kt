package app.penmoss.ui.settings

import app.penmoss.ui.square.TextButton
import androidx.compose.foundation.layout.Row
import app.penmoss.ui.HomeLayout
import app.penmoss.engine.settings.SidebarLayout
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ListItem
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import app.penmoss.ui.DisplayChoice

/**
 * Settings → Display (T42, A576; T40 ST12, A650): a switch for each of Home's shortcuts, synced
 * with the web's sidebar. Search always shows. Nothing changes before the first sync has sent
 * the settings, as in Appearance.
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
) {
    SectionScreen("Display", onBack, notice = if (enabled) null else SETTINGS_WAIT) {
        GroupTitle("Shortcuts on Home")
        Help("Hide the ones you don’t use. They still open from Search and a keyboard, and the web and Mac apps hide them from the sidebar too. Search always shows.")
        for (choice in choices) {
            ListItem(
                headlineContent = { Text(choice.label) },
                supportingContent = { Text(choice.where) },
                trailingContent = { Switch(checked = choice.shown, onCheckedChange = null, enabled = enabled) },
                // The whole row is the switch, so TalkBack reads one control with its name.
                modifier = Modifier
                    .testTag("display-${choice.key}")
                    .toggleable(value = choice.shown, enabled = enabled, role = Role.Switch) { onChange(choice.key, it) },
            )
        }
        GroupTitle("Sections")
        Help("Which of the sidebar’s sections show, in its order: on Home, Quick Access, Notebooks and Recent Notes; on the web and the Mac, the Calendar and Tags too. A section title’s long press moves or hides it.")
        for (section in layout.order) {
            val shown = section !in layout.hidden
            ListItem(
                headlineContent = { Text(SidebarLayout.NAMES.getValue(section)) },
                supportingContent = if (section in HomeLayout.HOME_SECTIONS) null else ({ Text("In the sidebar on the web and the Mac") }),
                trailingContent = { Switch(checked = shown, onCheckedChange = null, enabled = enabled) },
                modifier = Modifier
                    .testTag("display-section-$section")
                    .toggleable(value = shown, enabled = enabled, role = Role.Switch) { onSectionHidden(section, !it) },
            )
        }
        ListItem(
            headlineContent = { Text("Notes in Recent Notes") },
            supportingContent = { Text("${layout.recentCount} notes") },
            trailingContent = {
                Row {
                    TextButton(
                        onClick = { onRecentCount(layout.recentCount - 1) },
                        enabled = enabled && layout.recentCount > SidebarLayout.RECENT_MIN,
                        // Named for TalkBack, which would read "minus" alone (T53 pass).
                        modifier = Modifier.testTag("recentFewer").semantics { contentDescription = "Fewer Notes in Recent Notes" },
                    ) { Text("−") }
                    TextButton(
                        onClick = { onRecentCount(layout.recentCount + 1) },
                        enabled = enabled && layout.recentCount < SidebarLayout.RECENT_MAX,
                        modifier = Modifier.testTag("recentMore").semantics { contentDescription = "More Notes in Recent Notes" },
                    ) { Text("+") }
                }
            },
            modifier = Modifier.testTag("display-recentCount"),
        )
        ListItem(
            headlineContent = { Text("Show Notebook Names in Quick Access") },
            trailingContent = { Switch(checked = layout.quickAccessNotebook, onCheckedChange = null, enabled = enabled) },
            modifier = Modifier
                .testTag("display-quickAccessNotebook")
                .toggleable(value = layout.quickAccessNotebook, enabled = enabled, role = Role.Switch) { onQuickAccessNotebook(it) },
        )
    }
}
