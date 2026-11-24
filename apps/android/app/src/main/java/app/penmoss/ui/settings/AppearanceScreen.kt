package app.penmoss.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.TrackScroll
import app.penmoss.analytics.trackedClick
import app.penmoss.engine.settings.LocalSettings
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.rememberLucideIcons
import app.penmoss.ui.common.FilledTonalButton
import app.penmoss.ui.common.roles
import app.penmoss.ui.home.HomeShortcutRow
import app.penmoss.ui.common.Toggle

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
