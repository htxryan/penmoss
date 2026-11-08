package app.penmoss.engine.settings

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlin.random.Random

/**
 * The theme editor's changes to a custom theme (T40 P1b, A417), as the web's `schema.ts` and
 * `actions.ts` make them, on the theme's JSON: Kotlin never reads more of a theme than it
 * edits, and keeps every field it does not know. What it sends is checked by the server with
 * `parseTheme`, which decides (A416). `settings-v1.json`'s `customTheme` cases check the
 * duplicates and names against the web's.
 */
object ThemeEdits {
    const val NAME_MAX = 60
    const val UNTITLED = "Untitled theme"
    private val CUSTOM_ID = Regex("^custom-[a-z0-9]{1,32}$")
    val FONT_KEYS = listOf("ui", "body", "mono")

    fun isCustomId(id: String?): Boolean = id != null && CUSTOM_ID.matches(id)

    /** `theme.custom.<id>`. */
    fun key(id: String): String = SettingKeys.CUSTOM_THEME_PREFIX + id

    /** A new custom theme id, as `newCustomThemeId`: `custom-` and twelve base-36 characters. */
    fun newId(random: Random = Random.Default): String = "custom-" + (1..12).joinToString("") { random.nextInt(36).toString(36) }

    /** "Nord copy", or "Nord copy 2" and so on when that name is taken, as `duplicateAndChoose`. */
    fun copyName(source: String, existing: Collection<String>): String {
        var name = "$source copy"
        var n = 2
        while (name in existing) name = "$source copy ${n++}"
        return name
    }

    /** A name as the web keeps it: trimmed, at most 60 characters, never empty. */
    fun cleanName(name: String): String = name.trim().take(NAME_MAX).ifEmpty { UNTITLED }

    /**
     * A copy of [source] to edit, as `duplicateTheme`: a built-in, or a custom theme (keeping
     * its base). Every other field is the source's.
     */
    fun duplicate(source: JsonObject, id: String, name: String, catalogue: ThemeCatalogue): JsonObject {
        val base = catalogue.builtIn(source.string("base")) ?: catalogue.builtIn(source.string("id")) ?: catalogue.builtIn(SettingDefaults.THEME)!!
        return JsonObject(
            source + mapOf(
                "id" to JsonPrimitive(id),
                "name" to JsonPrimitive(cleanName(name)),
                "description" to JsonPrimitive("Based on ${base.string("name")}"),
                "base" to JsonPrimitive(base.string("id")),
            ),
        )
    }

    /** What deleting [theme] leaves, as `deletedTheme`: its id and the built-in it was based on. */
    fun deletion(theme: JsonObject, catalogue: ThemeCatalogue): JsonObject = JsonObject(
        mapOf(
            "id" to JsonPrimitive(theme.string("id")),
            "base" to JsonPrimitive(catalogue.builtIn(theme.string("base"))?.string("id") ?: SettingDefaults.THEME),
            "deleted" to JsonPrimitive(true),
        ),
    )

    /** One variant's colours, token by token. */
    fun colours(theme: JsonObject, variant: String): Map<String, String> =
        (theme[variant] as? JsonObject).orEmpty().mapNotNull { (key, value) -> (value as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { key to it } }.toMap()

    fun withColour(theme: JsonObject, variant: String, key: String, hex: String): JsonObject {
        require(Colour.isHex(hex)) { "Not a #rrggbb colour: $hex" }
        val colours = (theme[variant] as? JsonObject).orEmpty()
        return theme.with(variant, JsonObject(colours + (key to JsonPrimitive(hex.lowercase()))))
    }

    fun withName(theme: JsonObject, name: String): JsonObject = theme.with("name", JsonPrimitive(name.take(NAME_MAX)))

    fun withFont(theme: JsonObject, key: String, stack: String): JsonObject {
        val fonts = (theme["fonts"] as? JsonObject).orEmpty()
        return theme.with("fonts", JsonObject(fonts + (key to JsonPrimitive(stack))))
    }

    fun withWidth(theme: JsonObject, rem: Int): JsonObject = theme.with("editorWidth", JsonPrimitive(rem))

    fun font(theme: JsonObject, key: String): String = (theme["fonts"] as? JsonObject)?.string(key).orEmpty()

    fun width(theme: JsonObject): Int = (theme["editorWidth"] as? JsonPrimitive)?.let { it.intOrNull ?: it.content.toDoubleOrNull()?.toInt() } ?: 52

    /**
     * The base to send with [value], an edit of a custom theme begun from [base], when versions of
     * it went out without an answer ([sent]). The server writes only the fields that differ from
     * the base sent (A416), so a field put back to the base's value would be skipped, though the
     * server may hold a sent value there whose reply was lost. For such a field the base sent is
     * that sent value, so the server writes it back. Every other field keeps the true base.
     */
    fun sendingBase(base: JsonObject, value: JsonObject, sent: List<JsonObject>): JsonObject {
        val out = base.toMutableMap()
        for ((key, was) in base) {
            if (key == "id") continue
            val now = value[key]
            if (was is JsonObject && now is JsonObject) {
                out[key] = sendingBase(was, now, sent.mapNotNull { it[key] as? JsonObject })
            } else if (now == was) {
                sent.firstNotNullOfOrNull { version -> version[key]?.takeIf { it != was && it !is JsonObject } }?.let { out[key] = it }
            }
        }
        return JsonObject(out)
    }

    private fun JsonObject.with(key: String, value: JsonElement) = JsonObject(this + (key to value))
}
