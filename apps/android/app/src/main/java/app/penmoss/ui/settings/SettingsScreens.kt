package app.penmoss.ui.settings

import androidx.compose.foundation.BorderStroke
import app.penmoss.ui.square.SQUARE
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import app.penmoss.ui.square.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.square.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
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
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.engine.settings.SettingLimits

/*
 * Settings on the phone (T40 P1, ST1–ST7, ST11): a list of sections, each its own screen, as
 * Android's own Settings is laid out, with the same choices as the web's Settings. Every change
 * shows at once and syncs through the settings channel (A410, A411), offline too.
 */

@Composable
internal fun BackButton(onBack: () -> Unit) {
    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
}

/** One row of the Settings home: a section and a line saying what it holds now. */
data class SettingsSection(val id: String, val title: String, val summary: String, val icon: ImageVector)

/** The Settings home (ST1): every section, with a summary under each, under a large top bar. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsHome(
    sections: List<SettingsSection>,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
    refusal: String? = null,
    onDismissRefusal: () -> Unit = {},
) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = { LargeTopAppBar(title = { Text("Settings") }, navigationIcon = { BackButton(onBack) }, scrollBehavior = scroll) },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).testTag("settingsSections")) {
            // A change the server would not take was dropped: said here, never silently (A411).
            if (refusal != null) {
                item(key = "refused") {
                    ListItem(
                        headlineContent = { Text(refusal) },
                        trailingContent = { TextButton(onClick = onDismissRefusal, Modifier.testTag("dismissRefused")) { Text("Dismiss") } },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.errorContainer),
                        modifier = Modifier.testTag("settingsRefused").semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
            items(sections, key = { it.id }) { section ->
                ListItem(
                    headlineContent = { Text(section.title) },
                    supportingContent = { Text(section.summary, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { Icon(section.icon, contentDescription = null) },
                    modifier = Modifier
                        .testTag("section-${section.id}")
                        .clickable(role = Role.Button, onClick = { onOpen(section.id) }),
                )
            }
        }
    }
}

/** A section's screen: its title in the top bar and its content scrolling below. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SectionScreen(title: String, onBack: () -> Unit, notice: String? = null, content: @Composable () -> Unit) {
    Scaffold(topBar = { TopAppBar(title = { Text(title) }, navigationIcon = { BackButton(onBack) }) }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
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

@Composable
internal fun GroupTitle(text: String) {
    Text(
        text,
        Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp).semantics { heading() },
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
internal fun Help(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Shown in a section while the server has not sent settings yet (an older server): nothing can change. */
const val SETTINGS_WAIT = "These settings can be changed here once Penmoss on the server is updated. " +
    "Until then the phone follows what you choose on the web."

/** A radio choice as a whole row, so the label is the target and TalkBack reads one control. */
@Composable
internal fun ChoiceRow(label: String, supporting: String?, selected: Boolean, enabled: Boolean, tag: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(label) },
        supportingContent = supporting?.let { { Text(it) } },
        leadingContent = { RadioButton(selected = selected, onClick = null, enabled = enabled) },
        modifier = Modifier.testTag(tag).selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick),
    )
}

// --- Appearance (ST3, ST4, ST11) ---

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

private val MODES = listOf(Triple("light", "Light", SettingsIcons.Sun), Triple("dark", "Dark", SettingsIcons.Moon), Triple("system", "System", SettingsIcons.Monitor))

/**
 * Appearance (ST3, ST4, ST11): the mode, the theme, and the note width. A choice applies at once,
 * to the native screens, the system bars, the editor, and (once sent) every other device.
 */
@Composable
fun AppearanceScreen(
    mode: String,
    /** What System shows now: this phone's own mode. */
    systemDark: Boolean,
    themes: List<ThemeCard>,
    chosen: String,
    fullWidth: Boolean,
    editorWidth: Int,
    enabled: Boolean,
    onMode: (String) -> Unit,
    onTheme: (String) -> Unit,
    onFullWidth: (Boolean) -> Unit,
    onBack: () -> Unit,
    /** The theme editor's way in for the theme chosen (T40 P1b): duplicate a built-in, or edit. */
    editor: ThemeEditorEntry? = null,
    /** Interface Font, Note Font and Note Font Size (T51, A944); none when null. */
    fonts: FontsUi? = null,
) {
    SectionScreen("Appearance", onBack, notice = SETTINGS_WAIT.takeIf { !enabled }) {
        Help("Your theme and mode sync to your other devices. Every theme has a light and a dark variant.")
        GroupTitle("Mode")
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("themeMode")) {
            MODES.forEachIndexed { index, (value, label, icon) ->
                SegmentedButton(
                    selected = mode == value,
                    onClick = { onMode(value) },
                    enabled = enabled,
                    shape = SegmentedButtonDefaults.itemShape(index, MODES.size, SQUARE),
                    icon = { Icon(icon, contentDescription = null, Modifier.size(18.dp)) },
                    modifier = Modifier.testTag("mode-$value"),
                ) { Text(label) }
            }
        }
        Help(
            if (mode == "system") "System follows this phone’s setting: ${if (systemDark) "dark" else "light"} right now."
            else "Always $mode, whatever the phone’s setting.",
        )
        GroupTitle("Theme")
        ThemeGrid(themes, chosen, enabled, onTheme)
        GroupTitle("Note width")
        Column(Modifier.selectableGroup()) {
            ChoiceRow("The theme’s ($editorWidth rem)", null, !fullWidth, enabled, "width-theme") { onFullWidth(false) }
            ChoiceRow("Full window width", null, fullWidth, enabled, "width-full") { onFullWidth(true) }
        }
        Help("A phone already uses its whole width; this shows on a tablet, an unfolded phone, and your other devices.")
        if (fonts != null) FontsGroup(fonts, enabled)
        if (editor != null) {
            GroupTitle("Theme editor")
            if (editor.builtIn) {
                Help("Built-in themes can’t be changed. Duplicate ${editor.name} to edit its colours, fonts and note width; your copy syncs to your other devices.")
                FilledTonalButton(onClick = editor.onOpen, enabled = enabled, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("duplicateTheme")) {
                    Text("Duplicate ${editor.name}")
                }
            } else {
                Help("Change ${editor.name}’s colours, fonts and note width. Your changes sync to your other devices.")
                FilledTonalButton(onClick = editor.onOpen, enabled = enabled, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("editTheme")) {
                    Text("Edit ${editor.name}")
                }
            }
        }
    }
}

/** The theme editor's way in from Appearance: the chosen theme's name, and what the button does. */
data class ThemeEditorEntry(val name: String, val builtIn: Boolean, val onOpen: () -> Unit)

/** Two cards to a row, the built-ins first and then the user's own, as the web lists them (ST4). */
@Composable
private fun ThemeGrid(themes: List<ThemeCard>, chosen: String, enabled: Boolean, onTheme: (String) -> Unit) {
    Column(Modifier.padding(horizontal = 12.dp).selectableGroup().testTag("themeGrid"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
            .semantics { if (theme.custom) stateDescription = if (selected) "Selected, custom theme" else "Custom theme" }
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick),
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
                    Text(theme.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        if (theme.custom) "Custom · ${theme.description}" else theme.description,
                        style = MaterialTheme.typography.bodySmall,
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

// --- Daily notes (ST6) ---

/** The keys of the two templates (the web's `template.daily` and `template.weekly`). */
data class TemplateField(val key: String, val label: String, val saved: String, val custom: Boolean)

/**
 * Daily notes (ST6): the time zone that decides which day today is, and the daily and weekly
 * templates. Each template is saved with Save, or put back with Reset to default, which removes
 * it, as the web's Use the default does. Changes affect notes made afterwards.
 */
@Composable
fun DailyNotesScreen(
    timeZone: String,
    today: String,
    templates: List<TemplateField>,
    enabled: Boolean,
    onTimeZone: () -> Unit,
    onSave: (key: String, value: String?) -> Unit,
    onBack: () -> Unit,
) {
    SectionScreen("Daily Notes", onBack, notice = SETTINGS_WAIT.takeIf { !enabled }) {
        Help("Today is $today in $timeZone. Changes sync to your other devices.")
        ListItem(
            headlineContent = { Text("Time Zone") },
            supportingContent = { Text(timeZone) },
            modifier = Modifier.testTag("timeZone").clickable(enabled = enabled, role = Role.Button, onClick = onTimeZone),
        )
        for (field in templates) TemplateEditor(field, enabled, onSave)
        Help(
            "Placeholders: {{date}} 2026-10-21, {{longDate}} Wednesday 21 October 2026, {{weekday}}, " +
                "{{week}} 2026-W43, {{year}}, {{month}}.",
        )
    }
}

@Composable
private fun TemplateEditor(field: TemplateField, enabled: Boolean, onSave: (String, String?) -> Unit) {
    var draft by rememberSaveable(field.key, field.saved) { mutableStateOf(field.saved) }
    var status by rememberSaveable(field.key) { mutableStateOf<String?>(null) }
    val tooLong = draft.length > SettingLimits.TEMPLATE_MAX_CHARS
    GroupTitle(field.label)
    OutlinedTextField(
        value = draft,
        onValueChange = {
            draft = it
            status = null
        },
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("template-${field.key}"),
        enabled = enabled,
        label = { Text(field.label) },
        // The server's limit (A410), counted here so a template too long is never "Saved".
        isError = tooLong,
        supportingText = {
            Text(
                if (tooLong) "Too long: at most ${"%,d".format(SettingLimits.TEMPLATE_MAX_CHARS)} characters (${"%,d".format(draft.length)} now)"
                else "${"%,d".format(draft.length)} / ${"%,d".format(SettingLimits.TEMPLATE_MAX_CHARS)}",
                Modifier.testTag("count-${field.key}"),
            )
        },
        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        minLines = 4,
        maxLines = 12,
    )
    Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        FilledTonalButton(
            onClick = {
                onSave(field.key, draft)
                status = "Saved"
            },
            enabled = enabled && draft != field.saved && !tooLong,
            modifier = Modifier.testTag("save-${field.key}"),
        ) { Text("Save") }
        OutlinedButton(
            onClick = {
                onSave(field.key, null)
                status = "Back to the default"
            },
            enabled = enabled && field.custom,
            modifier = Modifier.testTag("reset-${field.key}"),
        ) { Text("Reset to Default") }
        status?.let {
            Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { BackButton(onBack) },
                title = {
                    TextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("zoneSearch"),
                        placeholder = { Text("Search time zones") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        trailingIcon = {
                            if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Default.Close, contentDescription = "Clear") }
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
                    modifier = Modifier.testTag("usePhoneZone").clickable(role = Role.Button) { onPick(phoneZone) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                )
            }
            LazyColumn(Modifier.fillMaxSize().selectableGroup().testTag("zones")) {
                if (shown.isEmpty()) item(key = "none") { Help("No time zone matches.") }
                items(shown, key = { it }) { zone ->
                    ListItem(
                        headlineContent = { Text(zone.replace('_', ' ')) },
                        trailingContent = if (zone == current) ({ Icon(Icons.Default.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary) }) else null,
                        modifier = Modifier.testTag("zone-$zone").selectable(selected = zone == current, role = Role.RadioButton) { onPick(zone) },
                    )
                }
            }
        }
    }
}

// --- Quick capture (ST7) ---

/** Quick capture (ST7): where the capture sheet, the tile, the widget and sharing start, as on the web and Mac. */
@Composable
fun QuickCaptureScreen(destination: String, enabled: Boolean, onChoose: (String) -> Unit, onBack: () -> Unit) {
    SectionScreen("Quick Capture", onBack, notice = SETTINGS_WAIT.takeIf { !enabled }) {
        Help("Where a capture goes unless you pick the other in the capture sheet. The web and Mac apps start on the same choice.")
        Column(Modifier.selectableGroup()) {
            ChoiceRow("Today’s Note", "At the end of ## Captures, with the time", destination == "daily", enabled, "capture-daily") { onChoose("daily") }
            ChoiceRow("New Note in Inbox", "Titled by its first line", destination == "inbox", enabled, "capture-inbox") { onChoose("inbox") }
        }
    }
}

// --- Trash ---

/** Why moves to Trash wait on a server from before them, and the way out (A430). */
internal const val TRASH_BLOCKED =
    "Penmoss can’t take moves to Trash from this phone until its server is updated. They wait here; to keep one of these notes instead, restore it from Trash."
