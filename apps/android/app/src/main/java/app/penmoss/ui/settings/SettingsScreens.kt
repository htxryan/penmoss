package app.penmoss.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.TrackScroll
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.typedLength
import app.penmoss.engine.settings.LocalSettings
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.SettingLimits
import app.penmoss.feedback.MarkdownPreviewView
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.rememberLucideIcons
import app.penmoss.ui.common.OutlinedTextField
import app.penmoss.ui.common.DotState
import app.penmoss.ui.common.DotMark
import app.penmoss.ui.common.FilledTonalButton
import app.penmoss.ui.common.IconButton
import app.penmoss.ui.common.SQUARE
import app.penmoss.ui.common.TextButton
import app.penmoss.ui.common.mark
import app.penmoss.ui.common.roles
import app.penmoss.ui.home.HomeShortcutRow
import kotlinx.coroutines.delay
import java.time.LocalDate
import app.penmoss.ui.common.BackButton
import app.penmoss.ui.common.Toggle

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

// --- Appearance (ST3, ST4, ST11; PEN-146 option C) ---

/** A theme as a card shows it: its name, what it is, and the colours of its miniature. */
data class ThemeCard(
    val id: String,
    val name: String,
    val description: String,
    val custom: Boolean,
    val light: Swatch,
    val dark: Swatch,
)

/** The colours a theme's miniature uses, as the web's cards do: sidebar, text, accent and code. */
data class Swatch(
    val bg: Color,
    val sidebar: Color,
    val fg: Color,
    val muted: Color,
    val border: Color,
    val accent: Color,
    val keyword: Color,
    val string: Color,
    val function: Color,
)

private val MODES = listOf("light" to "Light", "dark" to "Dark", "system" to "System")
private val MODE_ICONS = mapOf("light" to SettingsIcons.Sun, "dark" to SettingsIcons.Moon, "system" to SettingsIcons.Monitor)

/**
 * Appearance (ST3, ST4, ST11): two tabs (Ryan's pick, option 3, 18 Nov 2026; A1619). Settings
 * holds only the controls: Theme (the mode, the theme cards and Customize…) and Text (the fonts
 * and size); Note Width is on Settings → Note, as on the Mac (A1634). Preview holds the app as it
 * will look (Home's own shortcut row and the note's own editor page, inert, A1564) and the fonts
 * at their real size (A1582). A choice applies at once, to the native screens, the system bars,
 * the editor and every other device.
 */
@Composable
fun AppearanceScreen(
    mode: String,
    /** What System shows now: this phone's own mode. */
    systemDark: Boolean,
    themes: List<ThemeCard>,
    chosen: String,
    enabled: Boolean,
    onMode: (String) -> Unit,
    onTheme: (String) -> Unit,
    onBack: () -> Unit,
    /** The theme editor's way in for the theme chosen (T40 P1b): duplicate a built-in, or edit. */
    editor: ThemeEditorEntry? = null,
    /** Interface Font, Note Font and Note Font Size (T51, A944); none when null. */
    fonts: FontsUi? = null,
    /** The note in the preview: the editor page itself (ThemePreview, A418); none in tests. */
    notePreview: (@Composable (Modifier) -> Unit)? = null,
    /** Which of Home's shortcuts the preview's row shows, as Settings → Home leaves them. */
    homeShortcuts: HomeShortcuts = HomeShortcuts(),
    /** Dad Jokes (PEN-10, the Mac's A1598): a joke heads Home; none when null. */
    dadJokes: Boolean? = null,
    onDadJokes: (Boolean) -> Unit = {},
) {
    var previewing by rememberSaveable { mutableStateOf(false) }
    // The tabs hold still under the title and each tab's page scrolls under them, as option 3 draws it.
    SectionScreen("Appearance", onBack, notice = SETTINGS_WAIT.takeIf { !enabled }, fill = true) {
        SettingsPreviewTabs(previewing, "appearance") { previewing = it }
        val panel = rememberScrollState()
        // How far down the page is (PEN-175); the preview is no page of settings, so it records nothing.
        if (!previewing) TrackScroll("settings", panel, "appearance")
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(panel).padding(top = 12.dp, bottom = 24.dp).testTag(if (previewing) "appearancePreviewPanel" else "appearanceSettingsPanel")) {
        if (previewing) {
            val theme = themes.firstOrNull { it.id == chosen }?.name ?: "This theme"
            val dark = mode == "dark" || (mode == "system" && systemDark)
            Text(
                "$theme, ${if (dark) "dark" else "light"}, as the app draws it. Change it on Settings.",
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("appearancePreviewCaption"),
                style = MaterialTheme.roles.help,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            PreviewApp(
                homeShortcuts,
                notePreview,
                Modifier.padding(horizontal = 16.dp).testTag("appearancePreviewApp").fillMaxWidth(),
                // The whole sample note, uncut, as the design draws it: the tab scrolls, not the note.
                noteHeight = PREVIEW_NOTE_HEIGHT,
                noteArea = notePreview != null,
            )
            // The interface's text at its real size, under the preview and unframed (A1582).
            if (fonts != null) FontsAtSize(fonts, Modifier.padding(top = 12.dp), framed = false)
            return@Column
        }
        GroupTitle("Theme", Modifier.settingRow("theme"), deviceOnly = LocalSettings.isLocal(SettingKeys.THEME))
        Segments(MODES, mode, enabled, "themeMode", Modifier.settingRow("mode"), icons = MODE_ICONS, itemTag = { "mode-$it" }, event = "settings.appearance.mode", onChoose = onMode)
        Help(
            if (mode == "system") "System follows this phone’s setting: ${if (systemDark) "dark" else "light"} right now."
            else "Always $mode, whatever the phone’s setting.",
        )
        ThemeGrid(themes, chosen, enabled, onTheme)
        if (editor != null) {
            // One button for both (PEN-146): a built-in is duplicated first, your own opens as it is.
            FilledTonalButton(onClick = trackedClick("settings.appearance.customize-theme", editor.onOpen), enabled = enabled, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).settingRow("customize-theme").testTag("customizeTheme")) {
                Text("Customize ${editor.name}…")
            }
            Help(
                if (editor.builtIn) "Built-in themes can’t be changed: Customize makes your own copy of ${editor.name} to change its colours, fonts and note width. It syncs to your other devices."
                else "Change ${editor.name}’s colours, fonts and note width. Your changes sync to your other devices.",
            )
        }
        if (fonts != null || dadJokes != null) GroupTitle("Text", deviceOnly = LocalSettings.isLocal(SettingKeys.INTERFACE_FONT))
        if (fonts != null) FontsGroup(fonts, enabled)
        // Last in Text, as on the Mac (A1598); its help says where the phone shows it (A1676).
        if (dadJokes != null) {
            Toggle(
                "Dad Jokes",
                DAD_JOKES_HELP,
                dadJokes,
                enabled,
                "dadJokes",
                Modifier.settingRow("dad-jokes"),
                event = "settings.dad-jokes",
                onChange = onDadJokes,
            )
        }
        }
    }
}

/**
 * Settings and Preview, the two tabs of Appearance (A1619) and Home (A1633), as option 3 draws
 * them: full width under the title, each with its icon; the one shown on the page's own
 * background with the accent under it, the other darker. [tag] names them for tests:
 * `<tag>Tabs`, `<tag>SettingsTab` and `<tag>PreviewTab`. The Mac's Appearance, Sidebar and Note
 * have the same two (`PreviewTabs`).
 */
@Composable
internal fun SettingsPreviewTabs(previewing: Boolean, tag: String, onPreview: (Boolean) -> Unit) {
    val colours = MaterialTheme.colorScheme
    val icons = rememberLucideIcons()
    Row(
        Modifier.fillMaxWidth().height(48.dp).drawBehind {
            // A line above and below, edge to edge, as the design draws it.
            drawLine(colours.outlineVariant, androidx.compose.ui.geometry.Offset(0f, 0f), androidx.compose.ui.geometry.Offset(size.width, 0f), 1.dp.toPx())
            drawLine(colours.outlineVariant, androidx.compose.ui.geometry.Offset(0f, size.height), androidx.compose.ui.geometry.Offset(size.width, size.height), 1.dp.toPx())
        }.selectableGroup().testTag("${tag}Tabs"),
    ) {
        listOf(Triple("Settings", false, "sliders-horizontal"), Triple("Preview", true, "eye")).forEachIndexed { index, (label, preview, glyph) ->
            val on = previewing == preview
            if (index > 0) Box(Modifier.width(1.dp).fillMaxHeight().background(colours.outlineVariant))
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .background(if (on) colours.background else androidx.compose.ui.graphics.lerp(colours.background, androidx.compose.ui.graphics.Color.Black, if (colours.background.luminance() < 0.5f) 0.25f else 0.05f))
                    .selectable(on, role = Role.Tab, onClick = trackedClick(if (preview) "settings.tabs.preview" else "settings.tabs.settings") { onPreview(preview) })
                    .testTag(if (preview) "${tag}PreviewTab" else "${tag}SettingsTab"),
                contentAlignment = Alignment.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    icons?.icon(glyph)?.let { Icon(LucideAssets.vector(it), contentDescription = null, Modifier.size(18.dp), tint = if (on) colours.onSurface else colours.onSurfaceVariant) }
                    Text(label, style = MaterialTheme.roles.item, color = if (on) colours.onSurface else colours.onSurfaceVariant, maxLines = 1, softWrap = false)
                }
                if (on) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(2.dp).background(colours.primary))
            }
        }
    }
}

/** The Preview tab's note: tall enough for the whole sample note at the default sizes. */
private val PREVIEW_NOTE_HEIGHT = 548.dp

/**
 * Home's own shortcut row above the editor page, inert (A1564); the note [noteHeight] high, or the
 * rest. [noteArea] keeps the note's room while the dialog has the note (one editor page at a time).
 */
@Composable
private fun PreviewApp(shortcuts: HomeShortcuts, note: (@Composable (Modifier) -> Unit)?, modifier: Modifier, noteHeight: Dp?, noteArea: Boolean) {
    val colours = MaterialTheme.colorScheme
    InertPreview(modifier.then(if (noteHeight == null) Modifier.fillMaxHeight() else Modifier), "appearancePreviewShield") {
        Column(Modifier.fillMaxWidth().border(1.dp, colours.outlineVariant).background(colours.surface)) {
            HomeShortcutRow(shortcuts, onSearch = {}, onToday = {}, onThisWeek = {}, onGraph = {}, onCommands = {})
            if (noteArea) {
                HorizontalDivider(color = colours.outlineVariant)
                val area = if (noteHeight != null) Modifier.fillMaxWidth().height(noteHeight) else Modifier.fillMaxWidth().weight(1f)
                Box(area) { if (note != null) note(Modifier.fillMaxSize()) }
            }
        }
    }
}

/**
 * A Preview tab's app (A1564, A1633): [content] drawn as the app draws it and taking nothing. Its
 * semantics and focus are cleared ([inert]), and a shield ([shieldTag]) lies over it, so no touch
 * reaches it, yet a drag that starts on it still scrolls the page: the shield watches and
 * consumes nothing, and the page's scroll sees the drag.
 */
@Composable
internal fun InertPreview(modifier: Modifier, shieldTag: String, content: @Composable () -> Unit) {
    Box(modifier) {
        Box(Modifier.inert()) { content() }
        Box(Modifier.matchParentSize().pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }.testTag(shieldTag))
    }
}

/**
 * Shows what is inside and takes nothing (A1564): focus never enters it and its semantics are
 * cleared, as the web's `inert` does; [PreviewApp]'s shield keeps touches from it.
 */
internal fun Modifier.inert(): Modifier = this
    .clearAndSetSemantics {}
    .focusProperties { onEnter = { cancelFocusChange() } }
    .focusGroup()

/** The theme editor's way in from Appearance: the chosen theme's name, and what the button does. */
data class ThemeEditorEntry(val name: String, val builtIn: Boolean, val onOpen: () -> Unit)

/** Two cards to a row, the built-ins first and then the user's own, as the web lists them (ST4). */
@Composable
private fun ThemeGrid(themes: List<ThemeCard>, chosen: String, enabled: Boolean, onTheme: (String) -> Unit) {
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp).selectableGroup().testTag("themeGrid"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (row in themes.chunked(2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (theme in row) ThemeCardView(theme, theme.id == chosen, enabled, Modifier.weight(1f)) { onTheme(theme.id) }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun ThemeCardView(theme: ThemeCard, selected: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val colours = MaterialTheme.colorScheme
    Surface(
        modifier = modifier
            .testTag("theme-${theme.id}")
            .semantics { if (theme.custom) stateDescription = if (selected) "Selected, Custom Theme" else "Custom Theme" }
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = trackedClick("settings.appearance.theme", onClick)),
        shape = RectangleShape,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) colours.primary else colours.outlineVariant),
        color = colours.surfaceContainer,
    ) {
        Column {
            Row(Modifier.fillMaxWidth().aspectRatio(2.2f).padding(6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Miniature(theme.light, Modifier.weight(1f))
                Miniature(theme.dark, Modifier.weight(1f))
            }
            Row(Modifier.padding(start = 10.dp, end = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(theme.name, style = MaterialTheme.roles.rowLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        if (theme.custom) "Custom · ${theme.description}" else theme.description,
                        style = MaterialTheme.roles.meta,
                        color = colours.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (selected) Icon(Icons.Default.Check, contentDescription = null, Modifier.size(18.dp), tint = colours.primary)
            }
        }
    }
}

/** A theme variant in small: a sidebar, a title and two lines of text, a line of code, a button. */
@Composable
private fun Miniature(swatch: Swatch, modifier: Modifier) {
    Canvas(modifier.fillMaxSize()) {
        val corner = CornerRadius(4.dp.toPx())
        drawRoundRect(swatch.bg, cornerRadius = corner)
        drawRoundRect(swatch.border, cornerRadius = corner, style = androidx.compose.ui.graphics.drawscope.Stroke(1f))
        val side = size.width * 0.24f
        drawRoundRect(swatch.sidebar, size = Size(side, size.height), cornerRadius = corner)
        val left = side + size.width * 0.08f
        val line = size.height * 0.09f
        val width = size.width - left - size.width * 0.08f
        fun bar(colour: Color, y: Float, fraction: Float, x: Float = left) =
            drawRoundRect(colour, Offset(x, size.height * y), Size(width * fraction, line), CornerRadius(line / 2))
        bar(swatch.fg, 0.14f, 0.7f)
        bar(swatch.muted, 0.34f, 0.9f)
        bar(swatch.muted, 0.5f, 0.6f)
        bar(swatch.keyword, 0.66f, 0.25f)
        bar(swatch.string, 0.66f, 0.3f, left + width * 0.3f)
        bar(swatch.function, 0.66f, 0.2f, left + width * 0.65f)
        drawRoundRect(swatch.accent, Offset(left, size.height * 0.8f), Size(width * 0.35f, line * 1.3f), CornerRadius(line))
    }
}

// --- Daily Notes (ST6; PEN-146 option B) ---

/** The keys of the two templates (the web's `template.daily` and `template.weekly`). */
data class TemplateField(val key: String, val label: String, val saved: String, val custom: Boolean)

/** The placeholders a template can hold (core's `fillTemplate`), with what each writes. */
internal val PLACEHOLDERS = listOf(
    "{{date}}" to "2026-10-21",
    "{{longDate}}" to "Wednesday 21 October 2026",
    "{{weekday}}" to "Wednesday",
    "{{week}}" to "2026-W43",
    "{{year}}" to "2026",
    "{{month}}" to "10",
)

/** How long typing rests before a template saves itself (PEN-146): no Save button. */
internal const val TEMPLATE_SAVE_MS = 700L

private val WEEKDAY_NAMES = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

/**
 * A template with its placeholders filled in for [date], as core's `fillTemplate` fills them: a
 * weekly one for [date]'s ISO week, from its Monday. Unknown placeholders stay as typed.
 */
fun fillTemplate(template: String, weekly: Boolean, date: LocalDate): String {
    val fields = java.time.temporal.IsoFields.WEEK_OF_WEEK_BASED_YEAR
    val weekYear = date.get(java.time.temporal.IsoFields.WEEK_BASED_YEAR)
    val weekNumber = date.get(fields)
    val day = if (weekly) date.with(java.time.DayOfWeek.MONDAY) else date
    val values = mapOf(
        "date" to day.toString(),
        "longDate" to app.penmoss.ui.journal.journalLongDate(day),
        "weekday" to WEEKDAY_NAMES[day.dayOfWeek.value - 1],
        "week" to "%d-W%02d".format(weekYear, weekNumber),
        "year" to (if (weekly) weekYear else day.year).toString(),
        "month" to "%02d".format(day.monthValue),
    )
    return Regex("\\{\\{\\s*(\\w+)\\s*\\}\\}").replace(template) { match -> values[match.groupValues[1]] ?: match.value }
}

/**
 * Daily Notes (ST6; PEN-146 option B): the time zone that decides which day today is (with this
 * phone's own one tap away), then the daily and weekly templates as tabs over one editor that
 * saves as you type, with + Placeholder and a preview of today's note under it. They belong to the
 * primary notebook, which holds the journal (A827), and affect notes made afterwards (A78).
 */
@Composable
fun DailyNotesScreen(
    timeZone: String,
    today: LocalDate,
    templates: List<TemplateField>,
    enabled: Boolean,
    onTimeZone: () -> Unit,
    onSave: (key: String, value: String?) -> Unit,
    onBack: () -> Unit,
    /** This phone's own zone; Use This Phone's Zone shows when it differs. */
    phoneZone: String = timeZone,
    onUsePhoneZone: (String) -> Unit = {},
    /** The primary notebook's name, which these belong to. */
    notebook: String? = null,
    /** No notebook on the phone: nothing holds these yet. */
    noNotebook: Boolean = false,
) {
    // A search for the weekly template opens on its tab (PEN-148).
    val asked = LocalSettingMark.current.target
    var tab by rememberSaveable { mutableStateOf(templates.indexOfFirst { settingId(it.label) == asked }.coerceAtLeast(0)) }
    SectionScreen("Daily Notes", onBack, notice = settingsWait(noNotebook).takeIf { !enabled }, fill = templates.isNotEmpty()) {
        ListItem(
            headlineContent = { Text("Time Zone") },
            supportingContent = { Text("$timeZone · today is ${app.penmoss.ui.journal.journalLongDate(today).substringBeforeLast(' ')}") },
            trailingContent = { Text("›", style = MaterialTheme.roles.rowLabel) },
            modifier = Modifier.settingRow("time-zone").testTag("timeZone").clickable(enabled = enabled, role = Role.Button, onClick = trackedClick("settings.journal.time-zone", onTimeZone)),
        )
        if (phoneZone != timeZone) {
            TextButton(onClick = trackedClick("settings.journal.use-phone-zone") { onUsePhoneZone(phoneZone) }, enabled = enabled, modifier = Modifier.padding(horizontal = 8.dp).testTag("dailyUsePhoneZone")) {
                Text("Use This Phone’s Zone ($phoneZone)")
            }
        }
        if (templates.isNotEmpty()) {
            val shown = tab.coerceIn(0, templates.size - 1)
            PrimaryTabRow(selectedTabIndex = shown, modifier = Modifier.padding(top = 8.dp).testTag("templateTabs")) {
                templates.forEachIndexed { index, field ->
                    Tab(selected = index == shown, onClick = trackedClick("settings.journal.template-tab") { tab = index }, text = { Text(field.label) }, modifier = Modifier.settingRow(settingId(field.label)).testTag("tab-${field.key}"))
                }
            }
            val field = templates[shown]
            key(field.key) { TemplateEditor(field, enabled, today, onSave) }
        }
        // Out of the way while typing, so the editor keeps the height the keyboard leaves.
        @OptIn(ExperimentalLayoutApi::class)
        if (!WindowInsets.isImeVisible) {
            Help(
                (notebook?.let { "These belong to $it, your primary notebook. " } ?: "") +
                    "Changes apply to notes made afterwards and sync to your other devices.",
            )
        }
    }
}

/**
 * A template's editor (A1612): Write and Preview over one frame that takes the page's spare
 * height, as GitHub's comment box. Write is the template's markdown; Preview is today's note
 * (this week's for the weekly one) as the template makes it, drawn.
 */
@Composable
private fun ColumnScope.TemplateEditor(field: TemplateField, enabled: Boolean, today: LocalDate, onSave: (String, String?) -> Unit) {
    var draft by remember(field.key) { mutableStateOf(TextFieldValue(field.saved)) }
    // The saved text changed elsewhere (a sync, Use the Default) while nothing is being typed.
    var typed by remember(field.key) { mutableStateOf(false) }
    LaunchedEffect(field.saved) { if (!typed && field.saved != draft.text) draft = TextFieldValue(field.saved, TextRange(field.saved.length)) }
    var status by remember(field.key) { mutableStateOf<String?>(null) }
    var placing by remember { mutableStateOf(false) }
    val text = draft.text
    val tooLong = text.length > SettingLimits.TEMPLATE_MAX_CHARS
    val save by rememberUpdatedState {
        if (text != field.saved && !tooLong) {
            onSave(field.key, text)
            status = "Saved"
        }
        typed = false
    }
    // Saves once typing rests (PEN-146), and on leaving with a change not saved yet.
    LaunchedEffect(text) {
        if (!typed) return@LaunchedEffect
        delay(TEMPLATE_SAVE_MS)
        save()
    }
    DisposableEffect(field.key) { onDispose { if (typed) save() } }
    var previewing by rememberSaveable(field.key) { mutableStateOf(false) }
    val weekly = field.key == SettingKeys.WEEKLY_TEMPLATE
    val icons = rememberLucideIcons()
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp).testTag("templateMode")) {
        listOf(Triple("Write", false, "pencil"), Triple("Preview", true, "eye")).forEachIndexed { index, (label, preview, glyph) ->
            SegmentedButton(
                selected = previewing == preview,
                onClick = trackedClick(if (preview) "settings.journal.template-preview" else "settings.journal.template-write") { previewing = preview },
                shape = SegmentedButtonDefaults.itemShape(index, 2, SQUARE),
                icon = { icons?.icon(glyph)?.let { Icon(LucideAssets.vector(it), contentDescription = null, Modifier.size(18.dp)) } },
                modifier = Modifier.testTag(if (preview) "templatePreviewTab" else "templateWriteTab"),
            ) { Text(label, maxLines = 1, softWrap = false) }
        }
    }
    if (previewing) {
        // Today's note as the template makes it, drawn, in the frame the field has.
        Column(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant)
                .background(MaterialTheme.colorScheme.surfaceBright)
                .verticalScroll(rememberScrollState()).padding(16.dp)
                .testTag("templatePreview"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(if (weekly) "This Week’s Note" else "Today’s Note", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
            MarkdownPreviewView(fillTemplate(text, weekly, today), Modifier.fillMaxWidth().testTag("templatePreviewText"), framed = false)
        }
        return
    }
    OutlinedTextField(
        value = draft,
        onValueChange = {
            if (it.text != draft.text) {
                typed = true
                status = null
            }
            draft = it
        },
        modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("template-${field.key}"),
        enabled = enabled,
        label = { Text(field.label) },
        // The notebook's limit (A410), counted here so a template too long is never "Saved".
        isError = tooLong,
        supportingText = {
            Text(
                if (tooLong) "Too long: at most ${"%,d".format(SettingLimits.TEMPLATE_MAX_CHARS)} characters (${"%,d".format(text.length)} now)"
                else "${"%,d".format(text.length)} / ${"%,d".format(SettingLimits.TEMPLATE_MAX_CHARS)}",
                Modifier.testTag("count-${field.key}"),
            )
        },
        textStyle = MaterialTheme.roles.code,
    )
    Row(Modifier.padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box {
            TextButton(onClick = trackedClick("settings.journal.placeholder-menu") { placing = true }, enabled = enabled, modifier = Modifier.testTag("placeholder-${field.key}")) { Text("+ Placeholder") }
            DropdownMenu(expanded = placing, onDismissRequest = { placing = false }) {
                for ((placeholder, example) in PLACEHOLDERS) {
                    DropdownMenuItem(
                        text = { Text("$placeholder  $example") },
                        onClick = trackedClick("settings.journal.placeholder") {
                            placing = false
                            // At the cursor, or over the selection.
                            val at = draft.selection
                            val next = draft.text.replaceRange(at.min, at.max, placeholder)
                            draft = TextFieldValue(next, TextRange(at.min + placeholder.length))
                            typed = true
                            status = null
                        },
                        modifier = Modifier.testTag("insert-$placeholder"),
                    )
                }
            }
        }
        TextButton(
            onClick = trackedClick("settings.journal.template-reset") {
                typed = false
                onSave(field.key, null)
                status = "Back to the Default"
            },
            enabled = enabled && field.custom,
            modifier = Modifier.testTag("reset-${field.key}"),
        ) { Text("Use the Default") }
        Spacer(Modifier.weight(1f))
        status?.let {
            Text(
                if (it == "Saved") "✓ Saved" else it,
                Modifier.padding(end = 8.dp).testTag("templateStatus").semantics { liveRegion = LiveRegionMode.Polite; contentDescription = it },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.roles.body,
            )
        }
    }
}

/** The time zones offered: the region zones the web offers (`Intl`), and UTC. */
fun regionTimeZones(available: Set<String> = java.time.ZoneId.getAvailableZoneIds()): List<String> =
    (available.filter { REGION.matches(it) } + "UTC").distinct().sorted()

private val REGION = Regex("^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)/[A-Za-z0-9_+\\-/]+$")

/** What a search for a zone finds: every word typed, in any order, spaces matching underscores. */
fun matchingZones(zones: List<String>, query: String): List<String> {
    val words = query.trim().lowercase().replace('_', ' ').split(Regex("[\\s/]+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return zones
    return zones.filter { zone -> val name = zone.lowercase().replace('_', ' '); words.all { it in name } }
}

/**
 * The time-zone picker (ST6): a searchable list, the current zone first, and this phone's own
 * zone one tap away when it differs.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeZonePicker(current: String, phoneZone: String, zones: List<String>, onPick: (String) -> Unit, onBack: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val shown = remember(query, zones, current) { matchingZones(listOf(current) + (zones - current), query) }
    // The web's time-zone picker is a dialog; here it is a screen, counted by the same name.
    val tracked = rememberTrackedDialog("timeZone")
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { BackButton(onBack) },
                title = {
                    TextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("zoneSearch"),
                        placeholder = { Text("Search Time Zones") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        trailingIcon = {
                            if (query.isNotEmpty()) IconButton(onClick = trackedClick("settings.journal.time-zone.clear") { query = "" }) { Icon(Icons.Default.Close, contentDescription = "Clear") }
                        },
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            focusedIndicatorColor = MaterialTheme.colorScheme.primary,
                            unfocusedIndicatorColor = Color.Transparent,
                        ),
                    )
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            // A button above the list, not one of its choices: the list is the radio group.
            if (phoneZone != current && query.isBlank()) {
                ListItem(
                    headlineContent = { Text("Use This Phone’s Zone") },
                    supportingContent = { Text(phoneZone) },
                    modifier = Modifier.testTag("usePhoneZone").clickable(role = Role.Button, onClick = trackedClick("settings.journal.time-zone.use-phone-zone", tracked.done { onPick(phoneZone) })),
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                )
            }
            LazyColumn(Modifier.fillMaxSize().selectableGroup().testTag("zones")) {
                if (shown.isEmpty()) item(key = "none") { Help("No time zone matches.") }
                items(shown, key = { it }) { zone ->
                    ListItem(
                        headlineContent = { Text(zone.replace('_', ' ')) },
                        trailingContent = if (zone == current) ({ Icon(Icons.Default.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary) }) else null,
                        modifier = Modifier.testTag("zone-$zone").selectable(selected = zone == current, role = Role.RadioButton, onClick = trackedClick("settings.journal.time-zone.pick", tracked.done { onPick(zone) })),
                    )
                }
            }
        }
    }
}

// --- Quick Capture (ST7; PEN-146) ---

/**
 * Quick Capture (ST7; PEN-146): where the capture sheet, the tile, the widget and sharing start,
 * and the notebook they file in, the primary one (A1101), which All Notebooks changes.
 */
@Composable
fun QuickCaptureScreen(
    destination: String,
    enabled: Boolean,
    onChoose: (String) -> Unit,
    onBack: () -> Unit,
    /** The primary notebook's name, where captures go; null with no notebook yet. */
    notebook: String? = null,
    onNotebook: () -> Unit = {},
    /** No notebook on the phone: nothing holds these yet. */
    noNotebook: Boolean = false,
) {
    SectionScreen("Quick Capture", onBack, notice = settingsWait(noNotebook).takeIf { !enabled }) {
        GroupTitle("Saves To", Modifier.settingRow("saves-to"))
        Column(Modifier.selectableGroup()) {
            ChoiceRow("Today’s Note", "At the end of ## Captures, with the time", destination == "daily", enabled, "capture-daily", event = "settings.quick-capture.destination") { onChoose("daily") }
            ChoiceRow("New Note in Inbox", "Titled by its first line", destination == "inbox", enabled, "capture-inbox", event = "settings.quick-capture.destination") { onChoose("inbox") }
        }
        Help("The capture sheet starts on this, and lets you pick the other for one capture.")
        GroupTitle("Notebook")
        ListItem(
            headlineContent = { Text(notebook ?: "No Notebook Yet") },
            supportingContent = { Text(if (notebook != null) "Your primary notebook · change it on All Notebooks" else "Add one on All Notebooks") },
            trailingContent = { Text("›", style = MaterialTheme.roles.rowLabel) },
            modifier = Modifier.testTag("captureNotebook").clickable(role = Role.Button, onClick = trackedClick("settings.quick-capture.notebook-link", onNotebook)),
        )
    }
}
