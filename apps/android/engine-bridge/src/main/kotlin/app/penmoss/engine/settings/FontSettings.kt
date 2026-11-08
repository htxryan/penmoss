package app.penmoss.engine.settings

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * Interface Font, Note Font and Note Font Size (T51, A944), by the web's rules (core `fonts.ts`),
 * so the phone offers only what the server stores: `theme` for the theme's own font, a preset, or
 * `custom:<family>`; the size a whole number of CSS pixels from 12 to 28. Checked against the
 * `font.*` values of `contract/settings-v1.json`.
 */
object FontSettings {
    const val THEME = "theme"
    const val CUSTOM_PREFIX = "custom:"
    const val MAX_FAMILY_CHARS = 64
    const val SIZE_MIN = 12
    const val SIZE_MAX = 28
    const val SIZE_DEFAULT = 16

    /** The presets in the order Settings offers them, with their names (core `FONT_PRESET_LABELS`). */
    val PRESETS: List<Pair<String, String>> = listOf(
        THEME to "Theme Default",
        "system" to "System",
        "serif" to "Serif",
        "rounded" to "Rounded",
        "humanist" to "Humanist",
        "mono" to "Monospace",
    )

    /**
     * The generic family Android maps each preset to (core `FONT_PRESET_ANDROID`): Compose's
     * `FontFamily` and the editor page's CSS both resolve these to the phone's own faces.
     */
    val ANDROID_FAMILY: Map<String, String> = mapOf(
        "system" to "sans-serif",
        "serif" to "serif",
        "rounded" to "sans-serif",
        "humanist" to "sans-serif",
        "mono" to "monospace",
    )

    private val PRESET_KEYS = PRESETS.map { it.first }.toSet()

    // Letters, digits, spaces, hyphens, underscores and dots, nothing CSS could read as more.
    private val FAMILY = Regex("^[\\p{L}\\p{N}][\\p{L}\\p{N} ._-]*$")

    /** Why [family] cannot be a custom font's family, as the web says it, or null when it can. */
    fun familyProblem(family: String): String? {
        val trimmed = family.trim()
        return when {
            trimmed.isEmpty() -> "Needs a font name"
            trimmed.length > MAX_FAMILY_CHARS -> "Font name is longer than $MAX_FAMILY_CHARS characters"
            !FAMILY.matches(trimmed) -> "Font name may hold only letters, digits, spaces, . _ and -"
            else -> null
        }
    }

    /** Why [value] cannot be stored as the font setting [key], or null when it can (JSON null removes it). */
    fun problem(key: String, value: JsonElement?): String? {
        if (value == null || value is JsonNull) return null
        val primitive = value as? JsonPrimitive ?: return "Not a font setting"
        if (key == SettingKeys.NOTE_FONT_SIZE) {
            val size = primitive.takeUnless { it.isString }?.intOrNull
            return if (size != null && primitive.content == size.toString() && size in SIZE_MIN..SIZE_MAX) null
            else "Must be a whole number from $SIZE_MIN to $SIZE_MAX"
        }
        if (!primitive.isString) return "Must be a font preset or a font name"
        return choiceProblem(primitive.content)
    }

    /** Why [choice] cannot be stored as a font: a preset, or `custom:` and a family with no spaces around it. */
    fun choiceProblem(choice: String): String? {
        if (choice in PRESET_KEYS) return null
        if (!choice.startsWith(CUSTOM_PREFIX)) return "Must be a font preset or a font name"
        val family = choice.removePrefix(CUSTOM_PREFIX)
        if (family != family.trim()) return "Font name cannot start or end with a space"
        return familyProblem(family)
    }

    /** A stored font choice, or `theme` while unset or unreadable (core `fontChoiceOf`). */
    fun choiceOf(value: JsonElement?): String {
        val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return THEME
        return text.takeIf { choiceProblem(it) == null } ?: THEME
    }

    /** The stored note size, or the default while unset or unreadable (core `noteFontSizeOf`). */
    fun sizeOf(value: JsonElement?): Int =
        if (value == null || value is JsonNull || problem(SettingKeys.NOTE_FONT_SIZE, value) != null) SIZE_DEFAULT
        else (value as JsonPrimitive).intOrNull ?: SIZE_DEFAULT

    /** A custom choice's family, or null for a preset. */
    fun customFamily(choice: String): String? = choice.takeIf { it.startsWith(CUSTOM_PREFIX) }?.removePrefix(CUSTOM_PREFIX)

    /** What Settings shows for a choice: the preset's name or the custom family. */
    fun label(choice: String): String = customFamily(choice) ?: PRESETS.firstOrNull { it.first == choice }?.second ?: choice
}

/**
 * Quick Access (T51, A946), by the web's rules (core `quick-access.ts`): note ids in pin order,
 * at most twenty, none twice. Checked against the `quickAccess.notes` values of the contract.
 */
object QuickAccess {
    const val MAX = 20

    private val NOTE_ID = Regex("^[0-9A-Za-z_-]{1,80}$")

    /** Why [value] cannot be stored as `quickAccess.notes`, or null when it can. */
    fun problem(value: JsonElement?): String? {
        if (value == null || value is JsonNull) return null
        val list = value as? JsonArray ?: return "Must be a list of note ids"
        if (list.size > MAX) return "At most $MAX notes"
        val seen = mutableSetOf<String>()
        for (item in list) {
            val id = (item as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (id == null || !NOTE_ID.matches(id)) return "Must hold note ids"
            if (!seen.add(id)) return "Repeats $id"
        }
        return null
    }

    /** The pinned ids, or none while unset or unreadable. */
    fun read(value: JsonElement?): List<String> {
        if (value == null || value is JsonNull || problem(value) != null) return emptyList()
        return (value as JsonArray).map { (it as JsonPrimitive).content }
    }

    /** The list with [id] pinned (at the end) or unpinned; null when it is full (core `toggledQuickAccess`). */
    fun toggled(list: List<String>, id: String): List<String>? = when {
        id in list -> list - id
        list.size >= MAX -> null
        else -> list + id
    }

    /** The list with [id] moved to [index] (T53 item 10, core `movedQuickAccess`); as it was when [id] is not pinned. */
    fun moved(list: List<String>, id: String, index: Int): List<String> {
        if (id !in list) return list
        val rest = list - id
        val at = index.coerceIn(0, rest.size)
        return rest.subList(0, at) + id + rest.subList(at, rest.size)
    }

    fun toJson(list: List<String>): JsonArray = JsonArray(list.map(::JsonPrimitive))
}
