package app.penmoss.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.TrackScroll
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.typedLength
import app.penmoss.ui.common.OutlinedTextField
import app.penmoss.ui.common.DotState
import app.penmoss.ui.common.DotMark
import app.penmoss.ui.common.IconButton
import app.penmoss.ui.common.SQUARE
import app.penmoss.ui.common.TextButton
import app.penmoss.ui.common.mark
import app.penmoss.ui.common.roles
import app.penmoss.ui.common.BackButton

/*
 * Settings on the phone (T40 P1; PEN-146): one list in five groups (Look and Feel, Writing,
 * Notebooks, Agents, This Phone) under a Search Settings field, each row a screen of its own as
 * Android's own Settings is laid out, with the same choices as the Mac's. Every change shows at
 * once and syncs through the primary notebook (A1014), offline too.
 */

/**
 * One row of the Settings list (A415): a screen, a line saying what it holds now, and the route
 * it opens. A notebook's row leads with its sync dot ([dot]) instead of an icon.
 */
data class SettingsSection(
    val id: String,
    val title: String,
    val summary: String,
    val icon: ImageVector? = null,
    val route: String = "settings/$id",
    val dot: DotState? = null,
    /** A notebook's badge (A1579), before its name. */
    val badge: app.penmoss.engine.settings.NotebookBadge? = null,
)

/** A captioned group of rows (PEN-146): Look and Feel, Writing, Notebooks, Agents, This Phone. */
data class SettingsGroup(val title: String, val sections: List<SettingsSection>)

/**
 * The Settings list (PEN-146): a Search Settings field, then the groups, each row with its summary
 * under a large top bar. Typing in the field lists the settings it finds instead (their label,
 * help or another word for them), each opening its screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsHome(
    groups: List<SettingsGroup>,
    onOpen: (route: String) -> Unit,
    onBack: () -> Unit,
    refusal: String? = null,
    onDismissRefusal: () -> Unit = {},
    index: List<SettingEntry> = SETTINGS_INDEX,
) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    var query by rememberSaveable { mutableStateOf("") }
    val found = remember(query, index) { searchSettings(index, query) }
    val mark = LocalSettingMark.current
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = { Text("Settings") },
                navigationIcon = { BackButton(onBack) },
                actions = { SettingsInfoButton() },
                scrollBehavior = scroll,
            )
        },
    ) { padding ->
        val list = rememberLazyListState()
        // How far down Settings' list of pages is (PEN-175); its search's results start again.
        TrackScroll("settings.nav", list, query.isNotBlank())
        LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding().testTag("settingsSections"), state = list) {
            item(key = "search") {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("settingsSearch").typedLength("settingsSearch", "query", query),
                    placeholder = { Text("Search Settings") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    trailingIcon = {
                        if (query.isNotEmpty()) IconButton(onClick = trackedClick("settings.search.clear") { query = "" }) { Icon(Icons.Default.Close, contentDescription = "Clear the Search") }
                    },
                )
            }
            // A change the notebook would not take was dropped: said here, never silently (A411).
            if (refusal != null) {
                item(key = "refused") {
                    ListItem(
                        headlineContent = { Text(refusal) },
                        trailingContent = { TextButton(onClick = trackedClick("settings.refused.dismiss", onDismissRefusal), Modifier.testTag("dismissRefused")) { Text("Dismiss") } },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.errorContainer),
                        modifier = Modifier.testTag("settingsRefused").semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
            if (query.isNotBlank()) {
                if (found.isEmpty()) {
                    item(key = "none") { Help("No setting matches “${query.trim()}”.", Modifier.testTag("settingsSearchNone")) }
                }
                items(found, key = { "found-${it.id}" }) { entry ->
                    ListItem(
                        headlineContent = { Text(entry.label) },
                        supportingContent = { Text(listOfNotNull(entry.section, entry.help).joinToString(" · "), maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        modifier = Modifier
                            .testTag("found-${entry.id}")
                            .clickable(role = Role.Button, onClick = trackedClick("settings.search.result") {
                                // Its screen scrolls to the row and marks it a moment (PEN-148).
                                mark.request(entry.id)
                                onOpen(entry.route)
                            }),
                    )
                }
                return@LazyColumn
            }
            for (group in groups) {
                item(key = "group-${group.title}") { GroupTitle(group.title) }
                items(group.sections, key = { it.id }) { section ->
                    ListItem(
                        headlineContent = {
                            val badge = section.badge
                            if (badge == null) {
                                Text(section.title)
                            } else {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    app.penmoss.ui.common.NotebookBadgeView(badge, section.title, decorative = true)
                                    Text(section.title)
                                }
                            }
                        },
                        supportingContent = { Text(section.summary, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        leadingContent = {
                            when {
                                section.dot != null -> Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { DotMarkOf(section.dot) }
                                section.icon != null -> Icon(section.icon, contentDescription = null)
                            }
                        },
                        modifier = Modifier
                            .testTag("section-${section.id}")
                            .clickable(role = Role.Button, onClick = trackedClick("settings.nav.section") { onOpen(section.route) }),
                    )
                }
            }
        }
    }
}

/** A notebook's sync dot as a row draws it, the same marks as Home's (A933), not a button of its own. */
@Composable
internal fun DotMarkOf(state: DotState, modifier: Modifier = Modifier) {
    val colours = MaterialTheme.colorScheme
    val colour = when (state) {
        DotState.SYNCED, DotState.SYNCING -> colours.primary
        DotState.OFFLINE, DotState.IDLE -> colours.onSurfaceVariant
        DotState.STOPPED -> colours.error
    }
    val shape = modifier.size(10.dp).testTag("rowDot-${state.name.lowercase()}")
    when (state.mark()) {
        DotMark.SOLID -> Box(shape.background(colour, CircleShape))
        DotMark.RING -> Box(shape.border(1.5.dp, colour, CircleShape))
        DotMark.BULLSEYE -> Box(shape.border(1.5.dp, colour, CircleShape).padding(3.dp)) { Box(Modifier.fillMaxSize().background(colour, CircleShape)) }
    }
}

/**
 * A section's screen (A1560): its title large in a collapsing top app bar, which shrinks into the
 * bar's own row as the content scrolls; Settings' (i) and [actions] at its end; the content
 * scrolling below. [info] false leaves the (i) out, on a screen that is not Settings' (the app's
 * home).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SectionScreen(
    title: String,
    onBack: (() -> Unit)?,
    notice: String? = null,
    info: Boolean = true,
    actions: @Composable RowScope.() -> Unit = {},
    /** Before the title: a notebook's page has its badge there (A1579). */
    titleLead: (@Composable () -> Unit)? = null,
    /**
     * The page holds still and its content fills it: a child with `weight` takes the height
     * the rest leave, as Daily Notes' editor does (A1612). Otherwise the page scrolls.
     */
    fill: Boolean = false,
    /**
     * Where its scrolling is recorded (PEN-175): `settings` for a Settings page, null for a
     * screen that is not one (the launcher's home). Each page ([title]) starts from the top.
     */
    scrollArea: String? = "settings",
    content: @Composable ColumnScope.() -> Unit,
) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    val page = rememberScrollState()
    // A filling page holds still: its own scroller (a panel under its tabs) records instead.
    if (scrollArea != null && !fill) TrackScroll(scrollArea, page, title)
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = {
                    val text = @Composable { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    if (titleLead == null) {
                        text()
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            titleLead()
                            text()
                        }
                    }
                },
                navigationIcon = { if (onBack != null) BackButton(onBack) },
                actions = {
                    if (info) SettingsInfoButton()
                    actions()
                },
                scrollBehavior = scroll,
                modifier = Modifier.testTag("sectionTopBar"),
            )
        },
    ) { padding ->
        // Filling, the page is at least FILL_MIN tall: on a phone it is the screen and holds
        // still; on a short screen, or over the keyboard, it scrolls rather than crush the editor.
        BoxWithConstraints(Modifier.fillMaxSize().padding(padding).imePadding()) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(page).testTag("sectionPage")
                    .then(if (fill) Modifier.heightIn(min = maxOf(maxHeight, FILL_MIN)) else Modifier)
                    .padding(vertical = 8.dp),
            ) {
                if (notice != null) {
                    Text(
                        notice,
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("settingsNotice"),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                content()
            }
        }
    }
}

/** The least height a filling [SectionScreen] gives its content before it scrolls (A1612). */
private val FILL_MIN = 560.dp

/** A group's title; the full width, so Search Settings' mark (settingRow) spans the row as it does a ListItem's. */
@Composable
internal fun GroupTitle(
    text: String,
    modifier: Modifier = Modifier,
    /** The group's settings are kept on this phone alone (A1626): the laptop mark follows. */
    deviceOnly: Boolean = false,
) {
    val padded = modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp)
    // At least the size of the rows under it (A1561): titleSmall was smaller than their names.
    val title = @Composable { m: Modifier ->
        Text(text, m.semantics { heading() }, style = MaterialTheme.roles.groupHead, color = MaterialTheme.colorScheme.primary)
    }
    if (!deviceOnly) {
        title(padded)
        return
    }
    // The mark beside the title, not in it, so the heading stays its name (as A1559's laptop).
    Row(padded, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        title(Modifier)
        DeviceOnlyMark(many = true)
    }
}

@Composable
internal fun Help(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        style = MaterialTheme.roles.help,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Shown on a screen while its settings are not read yet from the primary notebook, where they live (A1014). */
const val SETTINGS_WAIT = "These settings can be changed once Penmoss has read them from your primary notebook."

/** Shown instead while there is no notebook on the phone, so nothing holds them yet (PEN-146). */
const val SETTINGS_NO_NOTEBOOK = "These settings are kept in your primary notebook. Add a notebook to change them."

/**
 * Dad Jokes' help (A1676): where the phone shows the joke. The Mac's says "in place of the
 * heading when no note is open"; the phone's joke heads Home's notes list instead.
 */
const val DAD_JOKES_HELP = "A joke at the top of Home’s notes list."

/** What a screen whose settings cannot be changed yet says: no notebook, or not read yet. */
internal fun settingsWait(noNotebook: Boolean) = if (noNotebook) SETTINGS_NO_NOTEBOOK else SETTINGS_WAIT

/** A radio choice as a whole row, so the label is the target and TalkBack reads one control. */
@Composable
internal fun ChoiceRow(label: String, supporting: String?, selected: Boolean, enabled: Boolean, tag: String, event: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(label) },
        supportingContent = supporting?.let { { Text(it) } },
        leadingContent = { RadioButton(selected = selected, onClick = null, enabled = enabled) },
        modifier = Modifier.testTag(tag).selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = trackedClick(event, onClick)),
    )
}

/** A segmented choice of a few options (Mode, Note Width, Load Pictures From the Web), each tagged `<tag>-<value>`. */
@Composable
internal fun Segments(
    options: List<Pair<String, String>>,
    selected: String,
    enabled: Boolean,
    tag: String,
    modifier: Modifier = Modifier,
    icons: Map<String, ImageVector> = emptyMap(),
    itemTag: (String) -> String = { "$tag-$it" },
    event: String,
    onChoose: (String) -> Unit,
) {
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag(tag)) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = selected == value,
                onClick = trackedClick(event) { onChoose(value) },
                enabled = enabled,
                shape = SegmentedButtonDefaults.itemShape(index, options.size, SQUARE),
                icon = { icons[value]?.let { Icon(it, contentDescription = null, Modifier.size(18.dp)) } ?: SegmentedButtonDefaults.Icon(selected == value) },
                modifier = Modifier.testTag(itemTag(value)),
            ) { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}
