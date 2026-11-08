package app.penmoss.ui

import app.penmoss.engine.settings.FontSettings
import app.penmoss.engine.settings.ResolvedTheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The theme chosen in Settings → Appearance (T28), as `/sync/tree` resolved it
 * for this user (T33, A305): the mode (light, dark or the system's) and the
 * theme's colours by token name. The native screens take a few colours from
 * it; the editor page gets [theme] as it came and shows it with the web's code.
 */
data class Appearance(
    val mode: String = "system",
    /** The resolved theme, for the editor page; null until the phone has synced once. */
    val theme: JsonObject? = null,
    val light: Map<String, String> = emptyMap(),
    val dark: Map<String, String> = emptyMap(),
    /** Settings → Appearance's Interface Font (T51, A944): the native screens' typography. */
    val interfaceFont: String = FontSettings.THEME,
) {
    /** Whether to show the dark variant, given the system's preference. */
    fun isDark(systemDark: Boolean): Boolean = when (mode) {
        "dark" -> true
        "light" -> false
        else -> systemDark
    }

    fun colours(dark: Boolean): Map<String, String> = if (dark) this.dark else light

    companion object {
        /**
         * The theme and mode the phone's settings resolve to (T40 P1, A412): what `/sync/tree` sent
         * with the changes made here laid over it, so a choice shows at once, offline too.
         */
        fun of(resolved: ResolvedTheme): Appearance =
            Appearance(resolved.mode, resolved.theme, colours(resolved.theme, "light"), colours(resolved.theme, "dark"))

        /** Reads what the store keeps; anything unreadable is Penmoss following the system. */
        fun parse(text: String?): Appearance {
            val value = text?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() }
                ?: return Appearance()
            val theme = value["theme"] as? JsonObject
            val mode = (value["mode"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?.takeIf { it == "light" || it == "dark" || it == "system" } ?: "system"
            return Appearance(mode, theme, colours(theme, "light"), colours(theme, "dark"))
        }

        private val HEX = Regex("^#[0-9a-fA-F]{6}$")

        private fun colours(theme: JsonObject?, variant: String): Map<String, String> {
            val colours = theme?.get(variant) as? JsonObject ?: return emptyMap()
            return colours.mapNotNull { (key, value) ->
                (value as? JsonPrimitive)?.takeIf { it.isString && HEX.matches(it.content) }?.let { key to it.content }
            }.toMap()
        }
    }
}
