package app.penmoss.analytics

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * A setting changed on the phone is recorded by name (PEN-137): only an allowlisted setting, with
 * its value only when it is a word that setting may be, a boolean or a whole number; anything
 * else says only that it changed, so a template, a time zone or a custom theme's name never
 * reaches the record.
 */
class SettingEventsTest {
    private val catalogue = AnalyticsCatalogue.parse(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("analytics-v1.json") } ?: File("../contract/analytics-v1.json")).readText(),
    )

    private fun event(key: String, value: kotlinx.serialization.json.JsonElement?) = SettingEvents.eventOf(key, value, catalogue)

    @Test
    fun aWordANumberOrABooleanIsItsValue() {
        assertEquals("theme.mode" to mapOf("value" to "dark"), event("theme.mode", JsonPrimitive("dark")))
        assertEquals("theme.id" to mapOf("value" to "nord"), event("theme.id", JsonPrimitive("nord")))
        assertEquals("note.fullWidth" to mapOf("value" to true), event("note.fullWidth", JsonPrimitive(true)))
        assertEquals("font.noteSize" to mapOf("value" to 18L), event("font.noteSize", JsonPrimitive(18)))
        assertEquals("pictures.fromWeb" to mapOf("value" to "wifi"), event("pictures.fromWeb", JsonPrimitive("wifi")))
        assertEquals("capture.destination" to mapOf("value" to "inbox"), event("capture.destination", JsonPrimitive("inbox")))
    }

    @Test
    fun aCustomThemeOrFontIsCustom() {
        assertEquals("theme.id" to mapOf("value" to "custom"), event("theme.id", JsonPrimitive("u-1f3a-Zebracanary")))
        assertEquals("font.note" to mapOf("value" to "custom"), event("font.note", JsonPrimitive("custom:Okapicanary Sans")))
    }

    @Test
    fun textAndListsSayOnlyThatTheyChanged() {
        assertEquals("template.daily" to mapOf("changed" to true), event("template.daily", JsonPrimitive("# pangolincanary")))
        assertEquals("timeZone" to mapOf("changed" to true), event("timeZone", JsonPrimitive("Europe/London")))
        assertEquals("symbols.list" to mapOf("changed" to true), event("symbols.list", JsonArray(listOf(JsonPrimitive("→")))))
        assertEquals("theme.mode" to mapOf("changed" to true), event("theme.mode", null))
        assertEquals("theme.mode" to mapOf("changed" to true), event("theme.mode", JsonNull))
        assertEquals("font.noteSize" to mapOf("changed" to true), event("font.noteSize", JsonPrimitive(1.5)))
        // A shortcut's keys: the shortcuts changed, never which command or keys.
        assertEquals("shortcuts.custom" to mapOf("changed" to true), event("keys.app.search", JsonArray(listOf(JsonPrimitive("Mod+K")))))
    }

    @Test
    fun aSettingNotInTheAllowlistIsNotRecorded() {
        assertNull(event("theme.custom.u-1f3a", JsonObject(emptyMap())))
        assertNull(event("quickAccess.notes", JsonArray(emptyList())))
        assertNull(event("badge.color", JsonPrimitive("#ff0000")))
    }
}
