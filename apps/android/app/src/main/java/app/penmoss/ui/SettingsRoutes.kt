package app.penmoss.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.BuildConfig
import app.penmoss.data.NoteStore
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.SettingLabels
import app.penmoss.engine.settings.Settings
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.engine.settings.string
import app.penmoss.ui.settings.AppearanceScreen
import app.penmoss.ui.settings.FontsUi
import app.penmoss.ui.settings.DailyNotesScreen
import app.penmoss.ui.settings.QuickCaptureScreen
import app.penmoss.ui.settings.SettingsHome
import app.penmoss.ui.settings.SettingsIcons
import app.penmoss.ui.settings.SettingsSection
import app.penmoss.ui.settings.Swatch
import app.penmoss.ui.settings.TemplateField
import app.penmoss.ui.settings.ThemeCard
import app.penmoss.ui.settings.ThemeEditorEntry
import app.penmoss.ui.settings.ThemeEditorScreen
import app.penmoss.ui.settings.TimeZonePicker
import app.penmoss.ui.settings.regionTimeZones
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.launch
import java.time.ZoneId

/*
 * The Settings screens' data (T40 P1): each reads the settings as the phone shows them
 * (`AppGraph.settings`, the last tree's with unsent changes laid over) and changes them through
 * `AppGraph.changeSetting`: the device's go to the Journal notebook's device map (A1014), a
 * notebook's own with its next pass (A411).
 */

/** The sections of the Settings home, in the order the web's Settings lists the ones it shares. */
internal object SettingsRoutes {
    const val HOME = "settings"
    const val APPEARANCE = "settings/appearance"
    const val DISPLAY = "settings/display"
    const val SYMBOLS = "settings/symbols"
    const val DAILY = "settings/daily"
    const val ZONE = "settings/daily/zone"
    const val CAPTURE = "settings/capture"
    const val SYNC = "settings/sync"

    /** The theme editor for one custom theme (T40 P1b). */
    const val THEME = "settings/appearance/theme/{id}"

    fun theme(id: String) = "settings/appearance/theme/$id"
}

internal fun modeLabel(mode: String) = when (mode) {
    "light" -> "Light"
    "dark" -> "Dark"
    else -> "System"
}

internal fun destinationLabel(destination: String) = if (destination == "inbox") "New Note in Inbox" else "Today’s Note"

/**
 * The Settings home's rows, each with a one-line summary of what it holds now (ST1): a git
 * notebook's Settings (A880), the device's sections and the notebook's Daily notes and Sync. The
 * Penmoss account's (Git mirror, Status, Devices, This phone) went with the server (T59).
 */
internal fun settingsSections(
    settings: Settings,
    themeName: String,
    status: String,
    unsent: Int,
    /** The app's version and build, which About shows (T49). */
    version: String = app.penmoss.feedback.FeedbackService.version(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
    /** What the Git notebooks row says (T50 G7): how many are on this phone. */
    git: String = app.penmoss.git.gitSummary(0),
): List<SettingsSection> = listOf(
    SettingsSection("appearance", "Appearance", "$themeName · ${modeLabel(settings.mode)}", SettingsIcons.Palette),
    // Right after Appearance, as on the web (T42, A576, A650).
    SettingsSection("display", "Display", displaySummary(settings), SettingsIcons.PanelLeft),
    // Then Symbols, as on the web (T44, A747).
    SettingsSection("symbols", "Symbols", symbolsSummary(settings), SettingsIcons.Star),
    // As on the Mac (T50 G7, A856), with the Mac's icon (T39 pass 3, A902).
    SettingsSection("git", "Git Notebooks", git, SettingsIcons.Terminal),
    SettingsSection("daily", "Daily Notes", settings.timeZone, SettingsIcons.Journal),
    SettingsSection("capture", "Quick Capture", destinationLabel(settings.captureDestination), SettingsIcons.Inbox),
    // A hardware keyboard's shortcuts (T40 P9, ST8): how many the person changed.
    SettingsSection("shortcuts", "Keyboard Shortcuts", shortcutsSummary(settings), SettingsIcons.Keyboard),
    SettingsSection(
        "sync",
        "Sync and Storage",
        listOfNotNull(status.ifEmpty { null }, if (unsent > 0) "$unsent ${if (unsent == 1) "setting" else "settings"} to send" else null)
            .joinToString(" · ").ifEmpty { "Not synced yet" },
        SettingsIcons.Refresh,
    ),
    // Last (T49): the version, and Send Feedback (Title Case as the action is named, A938).
    SettingsSection("about", "About", "Version $version · Send Feedback", Icons.Outlined.Info),
)

/** What the Keyboard shortcuts row says: how many commands' keys the person changed. */
internal fun shortcutsSummary(settings: Settings): String {
    // The ones this phone uses: not a Mac-only binding, nor one it cannot read (review N1).
    val changed = app.penmoss.engine.keys.Bindings.of(app.penmoss.engine.keys.ShortcutCatalogue.bundled, settings.values).usable.size
    return if (changed == 0) "For a hardware keyboard" else "$changed changed"
}

@Composable
internal fun SettingsHomeRoute(graph: AppGraph, status: String, onOpen: (String) -> Unit, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    val themeName = appearance.theme?.get("name")?.jsonPrimitive?.content ?: "Penmoss"
    val gitCount by remember(graph) { graph.gitIfAny?.list ?: kotlinx.coroutines.flow.MutableStateFlow(emptyList()) }.collectAsStateWithLifecycle()
    // A git notebook's Appearance, Display and Symbols are the device's (A827): the app's settings.
    val device by graph.device.settings.collectAsStateWithLifecycle()
    val git = app.penmoss.git.gitSummary(gitCount.size)
    val own = settingsSections(state.settings, themeName, status, state.unsent.size, git = git)
    // Daily notes and Sync are the notebook's own; the rest the device's.
    val shown = settingsSections(device.settings, themeName, status, 0, git = git)
        .map { section -> if (section.id == "daily" || section.id == "sync") own.first { it.id == section.id } else section }
    SettingsHome(
        shown,
        onOpen = { onOpen("settings/$it") },
        onBack = onBack,
        refusal = state.refused?.let(::refusalText),
        onDismissRefusal = { graph.dismissSettingsRefusal() },
    )
}

/** What Settings says of changes the server would not take: which, and its reason (A411). */
internal fun refusalText(refusal: NoteStore.SettingsRefusal): String {
    val names = refusal.keys.map(SettingLabels::of).joinToString(", ").ifEmpty { "settings" }
    val reason = refusal.message.trim().removeSuffix(".").ifEmpty { "it was refused" }
    return "Penmoss didn’t take your change to $names, so it was undone: $reason."
}

private fun hex(value: Any?, fallback: Color): Color {
    val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return fallback
    if (!Regex("^#[0-9a-fA-F]{6}$").matches(text)) return fallback
    return Color(0xFF000000 or text.removePrefix("#").toLong(16))
}

/** A theme's card: its name and description, and its miniature's colours from its tokens. */
internal fun themeCard(theme: JsonObject, custom: Boolean): ThemeCard {
    fun swatch(variant: String): Swatch {
        val colours = theme[variant] as? JsonObject ?: JsonObject(emptyMap())
        val fallback = if (variant == "dark") Color.Black else Color.White
        val text = if (variant == "dark") Color.White else Color.Black
        return Swatch(
            bg = hex(colours["bg"], fallback),
            sidebar = hex(colours["sidebar"], fallback),
            fg = hex(colours["fg"], text),
            muted = hex(colours["muted"], text),
            border = hex(colours["border"], text),
            accent = hex(colours["accent"], text),
            keyword = hex(colours["codeKeyword"], text),
            string = hex(colours["codeString"], text),
            function = hex(colours["codeFunction"], text),
        )
    }
    fun text(key: String) = (theme[key] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
    return ThemeCard(text("id"), text("name"), text("description"), custom, swatch("light"), swatch("dark"))
}

@Composable
internal fun AppearanceRoute(graph: AppGraph, onEditTheme: (String) -> Unit, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    val catalogue = ThemeCatalogue.bundled
    val settings = state.settings
    val resolved = catalogue.resolve(settings)
    val scope = rememberCoroutineScope()
    val cards = remember(settings) {
        catalogue.builtIns.map { themeCard(it, custom = false) } + settings.customThemes.map { themeCard(it, custom = true) }
    }
    val width = (resolved.theme["editorWidth"] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toInt() ?: 52
    AppearanceScreen(
        mode = settings.mode,
        systemDark = isSystemInDarkTheme(),
        themes = cards,
        chosen = resolved.id,
        fullWidth = settings.fullWidth,
        editorWidth = width,
        enabled = state.known,
        onMode = { graph.changeSetting(SettingKeys.MODE, JsonPrimitive(it)) },
        onTheme = { graph.changeSetting(SettingKeys.THEME, JsonPrimitive(it)) },
        // Off is stored too, as the web stores it, so another device's copy never wins (A501).
        onFullWidth = { graph.changeSetting(SettingKeys.FULL_WIDTH, JsonPrimitive(it)) },
        onBack = onBack,
        // Interface Font, Note Font and Note Font Size (T51, A944), each stored as chosen.
        fonts = FontsUi(
            interfaceFont = settings.interfaceFont,
            noteFont = settings.noteFont,
            noteSize = settings.noteFontSize,
            onInterfaceFont = { graph.changeSetting(SettingKeys.INTERFACE_FONT, JsonPrimitive(it)) },
            onNoteFont = { graph.changeSetting(SettingKeys.NOTE_FONT, JsonPrimitive(it)) },
            onNoteSize = { graph.changeSetting(SettingKeys.NOTE_FONT_SIZE, JsonPrimitive(it)) },
        ),
        editor = ThemeEditorEntry(
            name = resolved.theme.string("name") ?: "this theme",
            builtIn = catalogue.builtIn(resolved.id) != null,
            onOpen = {
                if (catalogue.builtIn(resolved.id) == null) {
                    onEditTheme(resolved.id)
                } else {
                    scope.launch { graph.duplicateTheme(resolved.theme)?.let(onEditTheme) }
                }
            },
        ),
    )
}

/** The theme editor's screen for the custom theme [id] (T40 P1b, ST5, A417). */
@Composable
internal fun ThemeEditorRoute(graph: AppGraph, id: String, onEditTheme: (String) -> Unit, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    val catalogue = ThemeCatalogue.bundled
    val scope = rememberCoroutineScope()
    val custom = state.settings.customThemes
    val theme = custom.firstOrNull { it.string("id") == id }
    ThemeEditorScreen(
        saved = theme,
        catalogue = catalogue,
        otherNames = catalogue.all(state.settings).filter { it.string("id") != id }.mapNotNull { it.string("name") },
        shownVariant = if (appearance.isDark(isSystemInDarkTheme())) "dark" else "light",
        enabled = state.known,
        loaded = state.known,
        onSave = graph::saveTheme,
        onDuplicate = { source -> scope.launch { graph.duplicateTheme(source)?.let(onEditTheme) } },
        onDelete = { deleted ->
            graph.deleteTheme(deleted)
            onBack()
        },
        onBack = onBack,
        preview = { shown, variant, modifier -> ThemePreview(shown, variant, modifier) },
    )
}

/** Today's date in [zone], as the web's Daily notes says it; the default zone when it is unknown here. */
internal fun todayIn(zone: String): String = journalToday(zone).toString()

@Composable
internal fun DailyNotesRoute(graph: AppGraph, onTimeZone: () -> Unit, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    val settings = state.settings
    DailyNotesScreen(
        timeZone = settings.timeZone,
        today = todayIn(settings.timeZone),
        templates = listOf(
            TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily template", settings.templateOrDefault(SettingKeys.DAILY_TEMPLATE), settings.template(SettingKeys.DAILY_TEMPLATE) != null),
            TemplateField(SettingKeys.WEEKLY_TEMPLATE, "Weekly template", settings.templateOrDefault(SettingKeys.WEEKLY_TEMPLATE), settings.template(SettingKeys.WEEKLY_TEMPLATE) != null),
        ),
        enabled = state.known,
        onTimeZone = onTimeZone,
        onSave = { key, value -> graph.changeSetting(key, value?.let(::JsonPrimitive)) },
        onBack = onBack,
    )
}

@Composable
internal fun TimeZoneRoute(graph: AppGraph, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    val zones = remember { regionTimeZones() }
    TimeZonePicker(
        current = state.settings.timeZone,
        phoneZone = ZoneId.systemDefault().id,
        zones = zones,
        onPick = { zone ->
            graph.changeSetting(SettingKeys.TIME_ZONE, JsonPrimitive(zone))
            onBack()
        },
        onBack = onBack,
    )
}

@Composable
internal fun QuickCaptureRoute(graph: AppGraph, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    QuickCaptureScreen(
        destination = state.settings.captureDestination,
        enabled = state.known,
        onChoose = { graph.changeSetting(SettingKeys.CAPTURE, JsonPrimitive(it)) },
        onBack = onBack,
    )
}

/** The app's version, for This phone. */
internal val APP_VERSION: String get() = appVersion(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)

/** "0.4.0 (build 17)" (AC1): the build is Play's versionCode, so a report names the exact upload. */
internal fun appVersion(name: String, code: Int) = "$name (build $code)"
