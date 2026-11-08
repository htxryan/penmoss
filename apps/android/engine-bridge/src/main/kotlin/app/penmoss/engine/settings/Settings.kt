package app.penmoss.engine.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.text.Collator
import java.util.Locale

/**
 * The synced settings the phone shows and changes (T40 P1, A410), by the web's names. The
 * server checks every value with the web's rules; the phone only offers valid ones and shows
 * what it is sent. Checked against `apps/android/contract/settings-v1.json`.
 */
object SettingKeys {
    const val THEME = "theme.id"
    const val MODE = "theme.mode"
    const val TIME_ZONE = "timeZone"
    const val DAILY_TEMPLATE = "template.daily"
    const val WEEKLY_TEMPLATE = "template.weekly"
    const val CAPTURE = "capture.destination"
    const val FULL_WIDTH = "note.fullWidth"

    /** The person's line symbols (T44, A743): a list, checked with [LineSymbols]. */
    const val SYMBOLS = "symbols.list"

    /** The interface's and the note text's fonts, and the note text's size (T51, A944): checked with [FontSettings]. */
    const val INTERFACE_FONT = "font.interface"
    const val NOTE_FONT = "font.note"
    const val NOTE_FONT_SIZE = "font.noteSize"

    /** The notes pinned to Quick Access (T51, A946): checked with [QuickAccess]. */
    const val QUICK_ACCESS = "quickAccess.notes"

    /** The sidebar's sections and Quick Access's notebook names (T53, A983): checked with [SidebarLayout]. */
    const val SECTION_ORDER = "sidebar.sectionOrder"
    const val HIDDEN_SECTIONS = "sidebar.hiddenSections"
    const val RECENT_COUNT = "sidebar.recentCount"
    const val QUICK_ACCESS_NOTEBOOK = "quickAccess.showNotebook"

    /** A custom theme, validated by the server, is sent under this prefix and its id. */
    const val CUSTOM_THEME_PREFIX = "theme.custom."

    /** Every setting the phone may change, in the contract's order. */
    val ALL = listOf(
        THEME, MODE, TIME_ZONE, DAILY_TEMPLATE, WEEKLY_TEMPLATE, CAPTURE, FULL_WIDTH, SYMBOLS,
        INTERFACE_FONT, NOTE_FONT, NOTE_FONT_SIZE, QUICK_ACCESS,
        SECTION_ORDER, HIDDEN_SECTIONS, RECENT_COUNT, QUICK_ACCESS_NOTEBOOK,
    )
}

/**
 * Settings → Display (T42, A576; T40 ST12, A650): the shortcuts Home may hide, by the web's names
 * (core's `display.ts`), in the sidebar's order. Search has none and always shows. Checked
 * against the `display` block of `contract/settings-v1.json`.
 */
object DisplayKeys {
    const val TODAY = "sidebar.today"
    const val THIS_WEEK = "sidebar.thisWeek"
    const val GRAPH = "sidebar.graph"
    const val COMMANDS = "sidebar.commands"

    val ALL = listOf(TODAY, THIS_WEEK, GRAPH, COMMANDS)
}

/** What each setting is when it is not set, as the web reads it. */
object SettingDefaults {
    const val THEME = "penmoss"
    const val MODE = "system"
    const val TIME_ZONE = "America/Chicago"
    const val DAILY_TEMPLATE = "## Plan\n\n## Notes\n"
    const val WEEKLY_TEMPLATE = "## Goals\n\n## Review\n"
    const val CAPTURE = "daily"
    const val FULL_WIDTH = false

    val ALL: Map<String, JsonElement> = mapOf(
        SettingKeys.THEME to JsonPrimitive(THEME),
        SettingKeys.MODE to JsonPrimitive(MODE),
        SettingKeys.TIME_ZONE to JsonPrimitive(TIME_ZONE),
        SettingKeys.DAILY_TEMPLATE to JsonPrimitive(DAILY_TEMPLATE),
        SettingKeys.WEEKLY_TEMPLATE to JsonPrimitive(WEEKLY_TEMPLATE),
        SettingKeys.CAPTURE to JsonPrimitive(CAPTURE),
        SettingKeys.FULL_WIDTH to JsonPrimitive(FULL_WIDTH),
        SettingKeys.SYMBOLS to LineSymbols.toJson(LineSymbols.DEFAULTS),
        SettingKeys.INTERFACE_FONT to JsonPrimitive(FontSettings.THEME),
        SettingKeys.NOTE_FONT to JsonPrimitive(FontSettings.THEME),
        SettingKeys.NOTE_FONT_SIZE to JsonPrimitive(FontSettings.SIZE_DEFAULT),
        SettingKeys.QUICK_ACCESS to JsonArray(emptyList()),
        SettingKeys.SECTION_ORDER to SidebarLayout.toJson(SidebarLayout.SECTIONS),
        SettingKeys.HIDDEN_SECTIONS to JsonArray(emptyList()),
        SettingKeys.RECENT_COUNT to JsonPrimitive(SidebarLayout.RECENT_DEFAULT),
        SettingKeys.QUICK_ACCESS_NOTEBOOK to JsonPrimitive(false),
    )
}

/** The server's limits on what it takes (A410), as `contract/settings-v1.json` gives them. */
object SettingLimits {
    /** A template longer than this is refused by the server; the phone does not offer to save one. */
    const val TEMPLATE_MAX_CHARS = 10_000

    /** At most this many settings in one `PUT /api/settings`; more go in the next request. */
    const val PER_REQUEST = 20

    /** The server makes no custom theme past this many (A416). */
    const val CUSTOM_THEMES_MAX = 50
}

/** Each setting's name, as Settings says it (a refusal names the settings it dropped). */
object SettingLabels {
    fun of(key: String): String = when (key) {
        SettingKeys.THEME -> "Theme"
        SettingKeys.MODE -> "Mode"
        SettingKeys.TIME_ZONE -> "Time zone"
        SettingKeys.DAILY_TEMPLATE -> "Daily template"
        SettingKeys.WEEKLY_TEMPLATE -> "Weekly template"
        SettingKeys.CAPTURE -> "Quick capture"
        SettingKeys.FULL_WIDTH -> "Note width"
        SettingKeys.SYMBOLS -> "Symbols"
        SettingKeys.INTERFACE_FONT -> "Interface Font"
        SettingKeys.NOTE_FONT -> "Note Font"
        SettingKeys.NOTE_FONT_SIZE -> "Note Font Size"
        SettingKeys.QUICK_ACCESS -> "Quick Access"
        SettingKeys.SECTION_ORDER -> "Section order"
        SettingKeys.HIDDEN_SECTIONS -> "Hidden sections"
        SettingKeys.RECENT_COUNT -> "Recent Notes"
        SettingKeys.QUICK_ACCESS_NOTEBOOK -> "Show Notebook Names in Quick Access"
        DisplayKeys.TODAY -> "Today"
        DisplayKeys.THIS_WEEK -> "This week"
        DisplayKeys.GRAPH -> "Graph"
        DisplayKeys.COMMANDS -> "Commands"
        else -> key
    }
}

/** The choices the phone offers for the settings that have a fixed set. */
object SettingChoices {
    val MODES = listOf("light", "dark", "system")
    val DESTINATIONS = listOf("daily", "inbox")
}

/**
 * The user's settings as the phone shows them: what the last `/sync/tree` sent, with the
 * changes made here and not sent yet laid over them. A value the phone cannot use reads as
 * the default, as on the web.
 */
data class Settings(val values: JsonObject = JsonObject(emptyMap())) {
    private fun text(key: String): String? = (values[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** The theme chosen (it may be one deleted since, which shows as its base). */
    val themeId: String get() = text(SettingKeys.THEME) ?: SettingDefaults.THEME

    val mode: String get() = text(SettingKeys.MODE)?.takeIf { it in SettingChoices.MODES } ?: SettingDefaults.MODE

    val timeZone: String get() = text(SettingKeys.TIME_ZONE) ?: SettingDefaults.TIME_ZONE

    /** A template set by the person, or null for the default. */
    fun template(key: String): String? = text(key)

    fun templateOrDefault(key: String): String =
        template(key) ?: if (key == SettingKeys.WEEKLY_TEMPLATE) SettingDefaults.WEEKLY_TEMPLATE else SettingDefaults.DAILY_TEMPLATE

    val captureDestination: String
        get() = text(SettingKeys.CAPTURE)?.takeIf { it in SettingChoices.DESTINATIONS } ?: SettingDefaults.CAPTURE

    val fullWidth: Boolean get() = (values[SettingKeys.FULL_WIDTH] as? JsonPrimitive)?.booleanOrNull ?: SettingDefaults.FULL_WIDTH

    /**
     * The person's line symbols (T44, A743): the stored list, or the defaults while it is unset or
     * one this build cannot read, as core's `symbolsOf`.
     */
    val symbols: List<LineSymbol> get() = LineSymbols.read(values[SettingKeys.SYMBOLS]) ?: LineSymbols.DEFAULTS

    /** Whether the person has a list of their own (Restore defaults has something to do). */
    val customSymbols: Boolean get() = LineSymbols.read(values[SettingKeys.SYMBOLS]).let { it != null && it != LineSymbols.DEFAULTS }

    /** The interface's font (T51, A944): a preset, `custom:<family>`, or `theme` while unset or unreadable. */
    val interfaceFont: String get() = FontSettings.choiceOf(values[SettingKeys.INTERFACE_FONT])

    /** The note text's font (T51, A944), as [interfaceFont]. */
    val noteFont: String get() = FontSettings.choiceOf(values[SettingKeys.NOTE_FONT])

    /** The note text's size in CSS pixels (T51, A944), or the default while unset or unreadable. */
    val noteFontSize: Int get() = FontSettings.sizeOf(values[SettingKeys.NOTE_FONT_SIZE])

    /** The notes pinned to Quick Access (T51, A946), in pin order; none while unset or unreadable. */
    val quickAccess: List<String> get() = QuickAccess.read(values[SettingKeys.QUICK_ACCESS])

    /** Every sidebar section in the order shown, hidden ones included (T53, A983). */
    val sectionOrder: List<String> get() = SidebarLayout.order(values[SettingKeys.SECTION_ORDER])

    /** The sidebar sections hidden (T53, A983). */
    val hiddenSections: Set<String> get() = SidebarLayout.hidden(values[SettingKeys.HIDDEN_SECTIONS])

    /** How many notes Recent Notes shows (T53, A983). */
    val recentCount: Int get() = SidebarLayout.recentCount(values[SettingKeys.RECENT_COUNT])

    /** Whether Quick Access names each note's notebook under its title (T53 item 10). */
    val quickAccessShowsNotebook: Boolean
        get() = (values[SettingKeys.QUICK_ACCESS_NOTEBOOK] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

    /** Whether the Display shortcut [key] shows (A576): only `false` hides one, as core's `sidebarShows`. */
    fun shows(key: String): Boolean {
        val value = values[key] as? JsonPrimitive ?: return true
        return value.isString || value.booleanOrNull != false
    }

    /** The user's own themes, by name as the web lists them (deleted ones left out). */
    val customThemes: List<JsonObject>
        get() = values.entries.mapNotNull { (key, value) ->
            val theme = value as? JsonObject ?: return@mapNotNull null
            val id = key.removePrefix(SettingKeys.CUSTOM_THEME_PREFIX)
            theme.takeIf { key.startsWith(SettingKeys.CUSTOM_THEME_PREFIX) && it.string("id") == id && it["deleted"] == null }
        }.sortedWith(compareBy(NAMES) { it: JsonObject -> it.string("name").orEmpty() }.thenBy { it.string("id").orEmpty() })

    /** What a deleted custom theme left: the built-in it was based on. */
    fun deletedBase(id: String): String? {
        val mark = values[SettingKeys.CUSTOM_THEME_PREFIX + id] as? JsonObject ?: return null
        return mark.string("base").takeIf { (mark["deleted"] as? JsonPrimitive)?.booleanOrNull == true }
    }

    /** These settings with [key] set to [value] (null removes it, back to its default). */
    fun with(key: String, value: JsonElement?): Settings =
        Settings(JsonObject(if (value == null || value is JsonNull) values - key else values + (key to value)))

    private companion object {
        val NAMES: Collator = Collator.getInstance(Locale.ROOT)
    }
}

/** A string field of a theme or setting, or null. */
fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** The theme to show and the mode to show it in, as the web resolves them. */
data class ResolvedTheme(val theme: JsonObject, val mode: String) {
    val id: String get() = theme.string("id") ?: SettingDefaults.THEME
}

/**
 * The eight built-in themes and the colour tokens (T40 P1, A412): `contract/themes-v1.json`,
 * made from `@penmoss/ui` and bundled with the app, so the theme grid shows every built-in
 * offline in the web's colours and Kotlin never makes a colour up. The user's own themes come
 * validated from the server ([Settings.customThemes]).
 */
class ThemeCatalogue(
    val builtIns: List<JsonObject>,
    val tokens: List<Token>,
    /** The token groups, in the web editor's order (T40 P1b). */
    val groups: List<Group> = emptyList(),
    /** The fonts the web editor offers, by name. */
    val fonts: List<Font> = emptyList(),
    /** The note width's range in rem, and its default (A500). */
    val width: IntRange = 32..72,
) {
    data class Token(val key: String, val label: String, val group: String)

    data class Group(val id: String, val label: String)

    data class Font(val label: String, val stack: String)

    fun builtIn(id: String?): JsonObject? = builtIns.firstOrNull { it.string("id") == id }

    private val penmoss: JsonObject get() = builtIn(SettingDefaults.THEME) ?: builtIns.first()

    /**
     * The theme in effect, as the web's `resolveThemeSettings` decides: the chosen built-in or
     * custom theme; for a custom theme deleted since, the built-in it was based on; for anything
     * else, Penmoss. Checked against the contract's `resolve` cases.
     */
    fun resolve(settings: Settings): ResolvedTheme {
        val chosen = settings.themeId
        val theme = builtIn(chosen)
            ?: settings.customThemes.firstOrNull { it.string("id") == chosen }
            ?: settings.deletedBase(chosen)?.let { builtIn(it) ?: penmoss }
            ?: penmoss
        return ResolvedTheme(theme, settings.mode)
    }

    /** Every theme to choose from: the built-ins, then the user's own. */
    fun all(settings: Settings): List<JsonObject> = builtIns + settings.customThemes

    companion object {
        /** The catalogue the app was built with (a resource of this module). */
        val bundled: ThemeCatalogue by lazy {
            val text = ThemeCatalogue::class.java.getResourceAsStream("/themes-v1.json")?.use { it.readBytes().decodeToString() }
                ?: error("themes-v1.json is missing from the build")
            parse(text)
        }

        fun parse(text: String): ThemeCatalogue {
            val root = Json.parseToJsonElement(text) as JsonObject
            val themes = (root["themes"] as JsonArray).map { it as JsonObject }
            val tokens = (root["tokens"] as JsonArray).map {
                val token = it as JsonObject
                Token(token.string("key")!!, token.string("label")!!, token.string("group")!!)
            }
            val groups = (root["groups"] as? JsonArray).orEmpty().map {
                val group = it as JsonObject
                Group(group.string("id")!!, group.string("label")!!)
            }
            val fonts = (root["fonts"] as? JsonArray).orEmpty().map {
                val font = it as JsonObject
                Font(font.string("label")!!, font.string("stack")!!)
            }
            val width = root["editorWidth"] as? JsonObject
            fun bound(key: String, default: Int) = (width?.get(key) as? JsonPrimitive)?.content?.toDoubleOrNull()?.toInt() ?: default
            return ThemeCatalogue(themes, tokens, groups, fonts, bound("min", 32)..bound("max", 72))
        }
    }
}
