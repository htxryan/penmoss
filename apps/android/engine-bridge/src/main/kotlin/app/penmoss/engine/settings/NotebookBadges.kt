package app.penmoss.engine.settings

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Notebook badges on the phone (A1579; the web's `badge.ts`, A1504, A1568): a square of the
 * notebook's colour holding a letter, a number 0–99 or one of Lucide's icons, kept in the
 * notebook's own synced settings (`badge.color`, `badge.glyph`), so the phone shows and changes
 * the badge every Mac shows. A value that fails these checks reads as the default: a preset from
 * a hash of the notebook's id and the name's first letter or digit. Held to the web's by
 * `contract/badge-v1.json`.
 */
object NotebookBadges {
    const val COLOR = "badge.color"
    const val GLYPH = "badge.glyph"

    /** How a Lucide icon is stored: `lucide:` and its name. */
    const val LUCIDE_PREFIX = "lucide:"

    /** The icon a new Icon badge starts with. */
    const val FIRST_ICON = "lucide:notebook"

    const val INK_LIGHT = "#ffffff"
    const val INK_DARK = "#1b1d1f"

    /** The ten presets, in the picker's order (`NOTEBOOK_BADGE_COLOURS`). */
    val PRESETS: List<BadgePreset> = listOf(
        BadgePreset("moss", "Moss", "#3c7a4b"),
        BadgePreset("teal", "Teal", "#1f7a7a"),
        BadgePreset("blue", "Blue", "#2f5d8a"),
        BadgePreset("indigo", "Indigo", "#4a4fa3"),
        BadgePreset("violet", "Violet", "#7448a0"),
        BadgePreset("rose", "Rose", "#a8436b"),
        BadgePreset("red", "Red", "#b23a3a"),
        BadgePreset("orange", "Orange", "#a8541a"),
        BadgePreset("ochre", "Ochre", "#8a6d12"),
        BadgePreset("slate", "Slate", "#4f5966"),
    )

    /** The 24 icons from before Lucide, still read, each drawn as its Lucide twin (A1568). */
    val OLD_ICONS: Map<String, String> = linkedMapOf(
        "notebook" to "notebook",
        "journal" to "book-text",
        "calendar" to "calendar",
        "inbox" to "inbox",
        "folder" to "folder",
        "file" to "file",
        "star" to "star",
        "pin" to "pin",
        "globe" to "globe",
        "code" to "code",
        "terminal" to "terminal",
        "branch" to "git-branch",
        "brush" to "brush",
        "palette" to "palette",
        "pencil" to "pencil",
        "checklist" to "list-checks",
        "comment" to "message-square",
        "graph" to "waypoints",
        "key" to "key",
        "laptop" to "laptop",
        "phone" to "smartphone",
        "sun" to "sun",
        "moon" to "moon",
        "pulse" to "activity",
    )

    private val NAME = Regex("^[a-z0-9]+(?:-[a-z0-9]+)*$")
    private val HEX = Regex("^#[0-9a-f]{6}$")
    private val NUMBER = Regex("^(0|[1-9][0-9]?)$")

    /** A stable 32-bit hash of the notebook's id (FNV-1a over its UTF-16 units, as the web's). */
    fun idHash(id: String): Long {
        var hash = 0x811c9dc5L
        for (unit in id) {
            hash = hash xor unit.code.toLong()
            hash = (hash * 0x01000193L) and 0xffffffffL
        }
        return hash
    }

    fun defaultPreset(id: String): BadgePreset = PRESETS[(idHash(id) % PRESETS.size).toInt()]

    /** The first letter or digit of the name, upper-cased ("2026 Plans" is 2); `#` with neither. */
    fun defaultGlyph(name: String): BadgeGlyph {
        var at = 0
        while (at < name.length) {
            val point = name.codePointAt(at)
            at += Character.charCount(point)
            val type = Character.getType(point)
            val digit = type == Character.DECIMAL_DIGIT_NUMBER.toInt()
            val number = digit || type == Character.LETTER_NUMBER.toInt() || type == Character.OTHER_NUMBER.toInt()
            if (!Character.isLetter(point) && !number) continue
            val text = String(Character.toChars(point))
            return if (digit) BadgeGlyph(BadgeGlyph.NUMBER, text) else BadgeGlyph(BadgeGlyph.LETTER, text.uppercase())
        }
        return BadgeGlyph(BadgeGlyph.LETTER, "#")
    }

    fun defaultBadge(id: String, name: String): NotebookBadge {
        val preset = defaultPreset(id)
        return NotebookBadge(preset.hex, preset.id, defaultGlyph(name), custom = false)
    }

    /** A stored colour as its hex and preset (null for a custom one); null when it is not one. */
    fun parseColor(value: JsonElement?): Pair<String, String?>? {
        val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        PRESETS.firstOrNull { it.id == text }?.let { return it.hex to it.id }
        val hex = text.lowercase()
        if (!HEX.matches(hex)) return null
        // A custom colour that is a preset's is that preset.
        return hex to PRESETS.firstOrNull { it.hex == hex }?.id
    }

    /** The icon's name in a stored `lucide:` value, or null when it is not one. */
    fun lucideName(value: String): String? {
        if (!value.startsWith(LUCIDE_PREFIX)) return null
        val name = value.substring(LUCIDE_PREFIX.length)
        return name.takeIf { it.length <= 64 && NAME.matches(it) }
    }

    /** The Lucide icon an icon badge's value draws (`branch` is `git-branch`), or null for neither. */
    fun iconInLucide(value: String): String? = OLD_ICONS[value] ?: lucideName(value)

    /** One visible character: a letter, digit or symbol, never a space or a control. */
    private fun oneCharacter(value: String): Boolean {
        if (value.isEmpty() || value.codePointCount(0, value.length) != 1) return false
        val point = value.codePointAt(0)
        if (Character.isWhitespace(point) || Character.isSpaceChar(point)) return false
        val type = Character.getType(point)
        return type != Character.CONTROL.toInt() && type != Character.FORMAT.toInt() &&
            type != Character.PRIVATE_USE.toInt() && type != Character.SURROGATE.toInt() &&
            type != Character.UNASSIGNED.toInt()
    }

    /** A stored glyph, checked; null when it is not one (two letters, 100, an unknown icon). */
    fun parseGlyph(value: JsonElement?): BadgeGlyph? {
        val stored = value as? JsonObject ?: return null
        val kind = (stored["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val text = (stored["value"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val ok = when (kind) {
            BadgeGlyph.LETTER -> oneCharacter(text)
            BadgeGlyph.NUMBER -> NUMBER.matches(text)
            BadgeGlyph.ICON -> iconInLucide(text) != null
            else -> false
        }
        return if (ok) BadgeGlyph(kind, text) else null
    }

    /** The notebook's badge from its settings: each part chosen and valid, else its default. */
    fun badgeOf(id: String, name: String, settings: Map<String, JsonElement>): NotebookBadge {
        val fallback = defaultBadge(id, name)
        val color = parseColor(settings[COLOR])
        val glyph = parseGlyph(settings[GLYPH])
        return NotebookBadge(
            color = color?.first ?: fallback.color,
            preset = if (color != null) color.second else fallback.preset,
            glyph = glyph ?: fallback.glyph,
            custom = color != null || glyph != null,
        )
    }

    private fun luminance(hex: String): Double {
        fun channel(at: Int): Double {
            val c = hex.substring(at, at + 2).toInt(16) / 255.0
            return if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
    }

    /** The WCAG contrast ratio of two `#rrggbb` colours. */
    fun contrast(a: String, b: String): Double {
        val (light, dark) = listOf(luminance(a), luminance(b)).sortedDescending()
        return (light + 0.05) / (dark + 0.05)
    }

    /** The glyph's colour on [hex]: white when it reaches 4.5:1, else whichever is clearer. */
    fun ink(hex: String): String {
        val white = contrast(hex, INK_LIGHT)
        if (white >= 4.5) return INK_LIGHT
        return if (contrast(hex, INK_DARK) > white) INK_DARK else INK_LIGHT
    }

    /** What a chosen colour writes: a preset's id, or the hex; null (back to the default) when invalid. */
    fun colorValue(color: String): JsonElement? {
        val (hex, preset) = parseColor(JsonPrimitive(color)) ?: return null
        return JsonPrimitive(preset ?: hex)
    }

    /** What a chosen glyph writes, `{ kind, value }`; null when it is not one. */
    fun glyphValue(glyph: BadgeGlyph): JsonElement? {
        val value = JsonObject(mapOf("kind" to JsonPrimitive(glyph.kind), "value" to JsonPrimitive(glyph.value)))
        return value.takeIf { parseGlyph(it) != null }
    }
}

data class BadgePreset(
    /** Stored as the colour (`badge.color`). */
    val id: String,
    /** Its name in the chooser (Title Case). */
    val label: String,
    val hex: String,
)

/** A badge's glyph: [kind] is `letter`, `number` or `icon`; [value] one character, 0–99, or an icon. */
data class BadgeGlyph(val kind: String, val value: String) {
    companion object {
        const val LETTER = "letter"
        const val NUMBER = "number"
        const val ICON = "icon"
    }
}

data class NotebookBadge(
    /** `#rrggbb`. */
    val color: String,
    /** Its preset's id, or null for a custom colour. */
    val preset: String?,
    val glyph: BadgeGlyph,
    /** Something was chosen: Reset to Default has work to do. */
    val custom: Boolean,
) {
    /** The glyph's colour: white, or near-black on a light colour. */
    val ink: String get() = NotebookBadges.ink(color)

    /** The Lucide icon it draws, for an icon glyph. */
    val icon: String? get() = if (glyph.kind == BadgeGlyph.ICON) NotebookBadges.iconInLucide(glyph.value) else null
}
