package app.penmoss.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.trackedToggle
import app.penmoss.engine.settings.SidebarLayout
import app.penmoss.ui.common.TextButton
import app.penmoss.ui.home.HomeActions
import app.penmoss.ui.home.HomeDrawerSheet
import app.penmoss.ui.home.HomeShortcutRow
import app.penmoss.ui.home.HomeUi
import app.penmoss.ui.common.roles

/**
 * Settings → Home (T42, A576; T40 ST12, A650; PEN-146): the Mac's Sidebar page, with only what Home
 * has. A switch for each of Home's shortcuts (Tags is new, A1438); Home's sections, dragged into
 * their order and each shown or hidden; Quick Access's notebook names; and how many notes Recent
 * Notes lists. Search always shows. Nothing changes before the settings are read. Two tabs, as
 * Appearance's (A1633): Settings holds the switches; Preview holds Home as the app draws it, its
 * row of shortcuts and its menu's sidebar ([preview]), inert.
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
    /** Quick Access's notes in the drawer, each one tap away, in place of its page (A1622). */
    onQuickAccessInDrawer: (Boolean) -> Unit = {},
    /** Home's sections in their new order (PEN-146). */
    onSectionOrder: (List<String>) -> Unit = {},
    /** What the Preview tab draws: Home's notebooks and Quick Access notes; the rest is above. */
    preview: HomeUi = HomeUi(),
) {
    var previewing by rememberSaveable { mutableStateOf(false) }
    // The tabs hold still under the title and each tab's page scrolls under them, as Appearance's.
    SectionScreen("Home", onBack, notice = if (enabled) null else SETTINGS_WAIT, fill = true) {
        SettingsPreviewTabs(previewing, "home") { previewing = it }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 12.dp, bottom = 24.dp).testTag(if (previewing) "homePreviewPanel" else "homeSettingsPanel")) {
        if (previewing) {
            HomePreview(preview.copy(shortcuts = HomeShortcuts.of(choices), layout = layout))
            return@Column
        }
        Help("A hidden shortcut still works from Search and a keyboard. Search always shows.")
        GroupTitle("Shortcuts on Home", Modifier.settingRow("shortcuts-on-home"), deviceOnly = true)
        for (choice in choices) Toggle(choice.label, null, choice.shown, enabled, "display-${choice.key}", event = "settings.sidebar.item") { onChange(choice.key, it) }
        GroupTitle("Sections", Modifier.settingRow("sections"), deviceOnly = true)
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
                    modifier = if (section == SidebarLayout.RECENT) Modifier.settingRow("recent-notes") else Modifier,
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
                                onCheckedChange = trackedToggle("settings.sidebar.section.show") { onSectionHidden(section, !it) },
                                enabled = enabled,
                                modifier = Modifier.testTag("display-section-$section").semantics { contentDescription = "Show ${SidebarLayout.NAMES.getValue(section)}" },
                            )
                        }
                    },
                )
                if (section == SidebarLayout.QUICK_ACCESS) {
                    Toggle("Show Notebook Names", "Under each note in Quick Access", layout.quickAccessNotebook, enabled, "display-quickAccessNotebook", Modifier.settingRow("show-notebook-names").padding(start = 40.dp), event = "settings.sidebar.show-notebook-names") {
                        onQuickAccessNotebook(it)
                    }
                    Toggle(
                        "Notes in the Sidebar",
                        "Each Quick Access note opens from the sidebar in one tap, in place of a Quick Access page",
                        layout.quickAccessInDrawer,
                        enabled,
                        "display-quickAccessInDrawer",
                        Modifier.settingRow("quick-access-in-sidebar").padding(start = 40.dp),
                        event = "settings.sidebar.notes-in-sidebar",
                    ) { onQuickAccessInDrawer(it) }
                }
            }
        }
        }
    }
}

/** The Preview tab's sidebar: tall enough for Quick Access, Recent Notes and a few notebooks. */
private val PREVIEW_DRAWER_HEIGHT = 480.dp

/**
 * Home as the app draws it (A1633), inert (A1564): its row of shortcuts, then the sidebar its
 * menu opens, at their real size. A shortcut switched off leaves the row, and Notes in the
 * Sidebar lists Quick Access's notes there.
 */
@Composable
private fun HomePreview(ui: HomeUi) {
    val colours = MaterialTheme.colorScheme
    Text(
        "Home as the app draws it: its shortcuts, then the sidebar its menu opens. Change it on Settings.",
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("homePreviewCaption"),
        style = MaterialTheme.roles.help,
        color = colours.onSurfaceVariant,
    )
    InertPreview(Modifier.padding(horizontal = 16.dp).fillMaxWidth().testTag("homePreviewApp"), "homePreviewShield") {
        Column(Modifier.fillMaxWidth().border(1.dp, colours.outlineVariant).background(colours.surface)) {
            HomeShortcutRow(ui.shortcuts, onSearch = {}, onToday = {}, onThisWeek = {}, onGraph = {}, onCommands = {})
            HorizontalDivider(color = colours.outlineVariant)
            Box(Modifier.fillMaxWidth().height(PREVIEW_DRAWER_HEIGHT)) { HomeDrawerSheet(ui, HomeActions(), close = {}) }
        }
    }
}

/** A switch as a whole row, so TalkBack reads one control with its name. */
@Composable
internal fun Toggle(label: String, supporting: String?, on: Boolean, enabled: Boolean, tag: String, modifier: Modifier = Modifier, event: String, onChange: (Boolean) -> Unit) {
    ListItem(
        headlineContent = { Text(label) },
        supportingContent = supporting?.let { { Text(it, style = MaterialTheme.typography.bodySmall) } },
        trailingContent = { Switch(checked = on, onCheckedChange = null, enabled = enabled) },
        modifier = modifier.testTag(tag).toggleable(value = on, enabled = enabled, role = Role.Switch, onValueChange = trackedToggle(event, onChange)),
    )
}

/** Recent Notes' − and + (1 to 50), each named for TalkBack, which would read "minus" alone (T53 pass). */
@Composable
private fun RecentStepper(count: Int, enabled: Boolean, onRecentCount: (Int) -> Unit) {
    TextButton(
        onClick = trackedClick("settings.sidebar.recent-count.fewer") { onRecentCount(count - 1) },
        enabled = enabled && count > SidebarLayout.RECENT_MIN,
        modifier = Modifier.testTag("recentFewer").semantics { contentDescription = "Fewer Notes in Recent Notes" },
    ) { Text("−") }
    Text("$count", Modifier.testTag("display-recentCount"))
    TextButton(
        onClick = trackedClick("settings.sidebar.recent-count.more") { onRecentCount(count + 1) },
        enabled = enabled && count < SidebarLayout.RECENT_MAX,
        modifier = Modifier.testTag("recentMore").semantics { contentDescription = "More Notes in Recent Notes" },
    ) { Text("+") }
}
