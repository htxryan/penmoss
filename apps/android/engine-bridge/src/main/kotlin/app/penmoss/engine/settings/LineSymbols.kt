package app.penmoss.engine.settings

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One line symbol (T44, D36, A743): its glyph, its name and its colour (a theme token name such
 * as `calloutWarning`, or any colour as `#rrggbb` or `#rrggbbaa`, T51 A939), as core's
 * `line-symbols.ts` has it. A symbol made since T51 has its glyph as its name (A940).
 */
data class LineSymbol(val glyph: String, val name: String, val colour: String) {
    fun toJson(): JsonObject = JsonObject(
        mapOf("glyph" to JsonPrimitive(glyph), "name" to JsonPrimitive(name), "colour" to JsonPrimitive(colour)),
    )
}

/**
 * The rules for `symbols.list` (T44, A743, A747), the web's own (core `line-symbols.ts`), so the
 * phone offers only a list the server stores: at most nine, one per shortcut slot, each glyph
 * distinct, without letters, digits, spaces or markdown characters. Checked against the
 * `symbols.list` values of `contract/settings-v1.json`.
 */
object LineSymbols {
    const val MAX = 9
    const val MAX_GLYPH_CHARS = 16
    const val MAX_NAME_CHARS = 40

    /** The theme colours a symbol may take, in the order Settings offers them, with their names. */
    val COLOURS: List<Pair<String, String>> = listOf(
        "accent" to "Accent",
        "link" to "Link",
        "danger" to "Red",
        "success" to "Green",
        "agent" to "Violet",
        "muted" to "Grey",
        "calloutNote" to "Blue",
        "calloutTip" to "Teal",
        "calloutQuestion" to "Yellow",
        "calloutWarning" to "Orange",
        "calloutFailure" to "Rose",
        "calloutExample" to "Purple",
    )

    private val COLOUR_KEYS = COLOURS.map { it.first }.toSet()

    /** A custom colour as stored (T51, A939): `#rrggbb` or `#rrggbbaa`, lower case (core `HEX_COLOUR`). */
    private val HEX_COLOUR = Regex("^#[0-9a-f]{6}(?:[0-9a-f]{2})?$")

    /** Whether [colour] is a custom `#rrggbb(aa)` colour rather than a theme colour. */
    fun isHexColour(colour: String): Boolean = HEX_COLOUR.matches(colour)

    /** Whether a symbol may take [colour]: a theme colour or a custom one. */
    fun isColour(colour: String): Boolean = colour in COLOUR_KEYS || isHexColour(colour)

    /** What Settings calls a colour: the theme colour's name, or its hex in capitals (core `symbolColourLabel`). */
    fun colourLabel(colour: String): String =
        if (isHexColour(colour)) colour.uppercase() else COLOURS.firstOrNull { it.first == colour }?.second ?: colour

    /**
     * The glyphs the picker offers (T51, A939): core's `SYMBOL_GLYPH_PRESETS`, in its order, as the
     * contract's `symbolGlyphPresets` holds them; any other glyph goes in the picker's own field.
     */
    val PRESET_GLYPHS = listOf(
        "★", "☆", "?", "!", "‼", "⁉", "→", "←", "↑", "↓", "⇒", "✓", "✔", "✗", "✘",
        "●", "○", "◆", "◇", "■", "□", "▲", "△", "♥", "⚑", "⚠", "✎", "§", "※", "❖",
        "💡", "⭐", "❓", "❗", "🔥", "📌", "📎", "💬", "⏰", "⏳", "🗓️", "🔒",
    )

    /** The list until a person changes it. */
    val DEFAULTS = listOf(
        LineSymbol("★", "Important", "calloutWarning"),
        LineSymbol("?", "Question", "calloutQuestion"),
        LineSymbol("!", "Follow-up", "danger"),
        LineSymbol("💡", "Idea", "calloutTip"),
        LineSymbol("→", "Next", "accent"),
    )

    /** Glyphs offered for a new symbol, the first one the list does not have yet (as the web's). */
    private val SUGGESTED = listOf("✓", "⚑", "◆", "⚠", "♥", "✎", "⌛", "☺", "❖", "§", "¶", "※")

    // JavaScript's `\s` with the `u` flag, and its control characters, exactly.
    private val SPACE = Regex("[\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]")
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]")
    private val LETTER_OR_DIGIT = Regex("[\\p{L}\\p{N}]")
    // Characters that show nothing or turn text around: a glyph of them would look like another.
    private val INVISIBLE = Regex("[\\u00ad\\u061c\\u180e\\u200b\\u200c\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069]")
    private val COMBINING_FIRST = Regex("^\\p{M}")
    private val MARKDOWN = Regex("[#\\-+*>=|`~\\[\\]\\\\<_$]")
    private val VARIATION_SELECTORS = Regex("[\\ufe0e\\ufe0f]")

    /** A glyph as it is compared: without variation selectors (`💡` and `💡️` are one symbol). */
    fun glyphKey(glyph: String): String = glyph.replace(VARIATION_SELECTORS, "")

    /** Why [glyph] cannot be a symbol's glyph, as the web says it, or null when it can. */
    fun glyphProblem(glyph: String): String? = when {
        glyph.isEmpty() -> "Needs a glyph"
        glyph.length > MAX_GLYPH_CHARS -> "Glyph is longer than $MAX_GLYPH_CHARS characters"
        SPACE.containsMatchIn(glyph) || CONTROL.containsMatchIn(glyph) -> "Glyph cannot hold a space"
        INVISIBLE.containsMatchIn(glyph) || glyph.startsWith("\u200d") || glyph.endsWith("\u200d") ->
            "Glyph cannot hold invisible or direction characters"
        COMBINING_FIRST.containsMatchIn(glyph) -> "Glyph cannot start with a combining mark"
        LETTER_OR_DIGIT.containsMatchIn(glyph) -> "Glyph cannot hold letters or digits"
        MARKDOWN.containsMatchIn(glyph) -> "Glyph cannot hold # - + * > = | ` ~ [ ] \\ < _ $"
        glyphKey(glyph).isEmpty() -> "Needs a glyph"
        else -> null
    }

    /** Why [name] cannot be a symbol's name, or null when it can. */
    fun nameProblem(name: String): String? = when {
        name.isBlank() -> "Needs a name"
        name.length > MAX_NAME_CHARS -> "Name is longer than $MAX_NAME_CHARS characters"
        CONTROL.containsMatchIn(name) -> "Name cannot hold control characters"
        else -> null
    }

    /** Why [symbols] cannot be stored, or null when they can. */
    fun listProblem(symbols: List<LineSymbol>): String? {
        if (symbols.size > MAX) return "At most $MAX symbols"
        val seen = mutableSetOf<String>()
        symbols.forEachIndexed { index, symbol ->
            val problem = glyphProblem(symbol.glyph) ?: nameProblem(symbol.name)
            if (problem != null) return "Symbol ${index + 1}: $problem"
            if (!isColour(symbol.colour)) return "Symbol ${index + 1}: no such colour"
            if (!seen.add(glyphKey(symbol.glyph))) return "${symbol.glyph} is in the list twice"
        }
        return null
    }

    /**
     * A stored list as the web reads it (`readSymbolList`): names trimmed and only the fields
     * this build knows, or null when it is not one the rules allow.
     */
    fun read(value: JsonElement?): List<LineSymbol>? {
        val items = value as? JsonArray ?: return null
        val symbols = items.map { item ->
            val entry = item as? JsonObject ?: return null
            fun text(key: String) = (entry[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            LineSymbol(text("glyph") ?: return null, text("name") ?: return null, text("colour") ?: return null)
        }
        if (listProblem(symbols) != null) return null
        return symbols.map { it.copy(name = it.name.trim()) }
    }

    /** The list as `PUT /api/settings` sends it. */
    fun toJson(symbols: List<LineSymbol>): JsonArray = JsonArray(symbols.map { it.copy(name = it.name.trim()).toJson() })

    /** A glyph for a new symbol: the first suggestion the list does not have. */
    fun nextGlyph(symbols: List<LineSymbol>): String {
        val taken = symbols.map { glyphKey(it.glyph) }.toSet()
        return SUGGESTED.firstOrNull { glyphKey(it) !in taken } ?: "•"
    }
}
