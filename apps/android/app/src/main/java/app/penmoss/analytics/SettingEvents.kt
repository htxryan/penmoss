package app.penmoss.analytics

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/**
 * A setting the person changed on the phone, recorded by name (PEN-137) from the settings' write
 * path, as the web records its store's writes: only a setting in the catalogue's allowlist, and
 * its value only when it is a boolean, a whole number or one of the words that setting may be
 * (`SETTING_VALUES`). Any other value (a template, a time zone, a list, a custom theme's or font's
 * name) is recorded as `changed: true`, so nothing typed or named ever is. A custom theme or font
 * is `custom`.
 */
object SettingEvents {
    /** Records [key] set to [value] (null: back to its default). */
    fun record(key: String, value: JsonElement?) {
        val (name, props) = eventOf(key, value) ?: return
        Analytics.record("setting", name, props)
    }

    /** Records a setting kept outside the synced settings (Load Pictures from the Web, a notebook's sync), by its catalogue name. */
    fun recordValue(name: String, value: Any) {
        val element = when (value) {
            is Boolean -> JsonPrimitive(value)
            is Int -> JsonPrimitive(value)
            is Long -> JsonPrimitive(value)
            is String -> JsonPrimitive(value)
            else -> null
        }
        record(name, element)
    }

    /** The event's name and props for [key] set to [value]; null when the setting is not recorded. */
    fun eventOf(key: String, value: JsonElement?, catalogue: AnalyticsCatalogue = AnalyticsCatalogue.bundled): Pair<String, Map<String, Any?>>? {
        // A shortcut's keys are `keys.<command>`: recorded as the shortcuts changing, never which.
        val name = if (key.startsWith(SHORTCUT_PREFIX)) SHORTCUTS else key
        if (!catalogue.has("setting", name)) return null
        val primitive = (value as? JsonPrimitive)?.takeUnless { it is JsonNull }
        val word: Any? = when {
            name == SHORTCUTS || primitive == null -> null
            primitive.isString -> when {
                catalogue.isWord(name, primitive.content) -> primitive.content
                catalogue.isWord(name, CUSTOM) -> CUSTOM
                else -> null
            }
            primitive.booleanOrNull != null -> primitive.booleanOrNull
            else -> primitive.takeUnless { it.content.contains('.') }?.longOrNull?.takeIf { it in 0..AnalyticsCatalogue.MAX_SETTING_NUMBER }
        }
        return name to if (word != null) mapOf("value" to word) else mapOf("changed" to true)
    }

    private const val SHORTCUT_PREFIX = "keys."
    private const val SHORTCUTS = "shortcuts.custom"
    private const val CUSTOM = "custom"
}
