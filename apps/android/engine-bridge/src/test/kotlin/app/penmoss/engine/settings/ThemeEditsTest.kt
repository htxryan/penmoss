package app.penmoss.engine.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.random.Random

/**
 * The theme editor's changes (T40 P1b, A417) are the web's: `settings-v1.json`'s `customTheme`
 * cases, written from `@penmoss/ui`'s `duplicateTheme` and `deletedTheme`.
 */
class ThemeEditsTest {
    private val custom: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("settings-v1.json") } ?: File("../contract/settings-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject.getValue("customTheme").jsonObject
    }
    private val catalogue = ThemeCatalogue.bundled

    @Test
    fun aDuplicateIsTheWebsCopy() {
        for (each in custom.getValue("duplicates").jsonArray.map { it.jsonObject }) {
            val made = ThemeEdits.duplicate(each.getValue("source").jsonObject, each.string("id")!!, each.string("name")!!, catalogue)
            assertEquals(each.getValue("theme").jsonObject, made)
        }
    }

    @Test
    fun aCopysNameIsTheFirstFreeOne() {
        for (each in custom.getValue("names").jsonArray.map { it.jsonObject }) {
            val existing = each.getValue("existing").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(each.string("name"), ThemeEdits.copyName(each.string("source")!!, existing))
        }
    }

    @Test
    fun anEditAndADeletionAreTheWebs() {
        val duplicate = custom.getValue("duplicates").jsonArray[0].jsonObject.getValue("theme").jsonObject
        var edited = ThemeEdits.withName(duplicate, "Nord ink")
        edited = ThemeEdits.withColour(edited, "light", "accent", "#204080")
        assertEquals(custom.getValue("edited").jsonObject, edited)
        assertEquals(custom.getValue("deletion").jsonObject, ThemeEdits.deletion(duplicate, catalogue))
        // Upper-case hex is stored as the web stores it; anything else is not a colour.
        assertEquals("#abcdef", ThemeEdits.colours(ThemeEdits.withColour(duplicate, "dark", "bg", "#ABCDEF"), "dark")["bg"])
        assertFalse(Colour.isHex("red"))
        assertEquals(60, ThemeEdits.withName(duplicate, "x".repeat(80)).string("name")!!.length)
        assertEquals(ThemeEdits.UNTITLED, ThemeEdits.cleanName("   "))
        assertEquals(44, ThemeEdits.width(ThemeEdits.withWidth(duplicate, 44)))
        assertEquals("Georgia, serif", ThemeEdits.font(ThemeEdits.withFont(duplicate, "body", "Georgia, serif"), "body"))
    }

    @Test
    fun aNewIdIsACustomOne() {
        val id = ThemeEdits.newId(Random(7))
        assertTrue(id, ThemeEdits.isCustomId(id))
        assertEquals(19, id.length)
        assertFalse(ThemeEdits.isCustomId("nord"))
    }

    @Test
    fun theCatalogueHasTheEditorsGroupsFontsAndWidth() {
        assertEquals(listOf("surfaces", "text", "states", "code", "callouts", "graph"), catalogue.groups.map { it.id })
        assertTrue(catalogue.fonts.isNotEmpty())
        assertEquals(32..72, catalogue.width)
        // Every token belongs to a group the editor shows.
        assertTrue(catalogue.tokens.all { token -> catalogue.groups.any { it.id == token.group } })
    }

    @Test
    fun theColourSheetsHueSaturationAndBrightnessGiveBackEveryBuiltInColour() {
        for (theme in catalogue.builtIns) {
            for (variant in listOf("light", "dark")) {
                for (hex in ThemeEdits.colours(theme, variant).values) {
                    val (h, sat, v) = Colour.hsv(hex)
                    assertEquals(hex, Colour.fromHsv(h, sat, v))
                }
            }
        }
        assertEquals("#ff0000", Colour.fromHsv(0f, 1f, 1f))
        assertEquals("#00ff00", Colour.fromHsv(120f, 1f, 1f))
        assertEquals("#808080", Colour.fromHsv(200f, 0f, 128f / 255f))
    }

    /**
     * A version sent without an answer may be what the server holds: a field put back to the base's
     * value since is sent with that version's value as its base, so the server writes it back (A416).
     */
    @Test
    fun aFieldPutBackAfterALostReplyIsSentAgainstTheValueSent() {
        val start = ThemeEdits.duplicate(catalogue.builtIn("nord")!!, "custom-abc", "Nord copy", catalogue)
        val lost = ThemeEdits.withName(ThemeEdits.withColour(ThemeEdits.withFont(start, "body", "Georgia, serif"), "light", "accent", "#d8b04a"), "Honey")
        // Since: the accent and the font put back, the name kept, the dark background changed.
        val now = ThemeEdits.withColour(ThemeEdits.withFont(ThemeEdits.withColour(lost, "light", "accent", ThemeEdits.colours(start, "light").getValue("accent")), "body", ThemeEdits.font(start, "body")), "dark", "bg", "#101418")
        val base = ThemeEdits.sendingBase(start, now, listOf(lost, now))
        assertEquals("#d8b04a", ThemeEdits.colours(base, "light")["accent"])
        assertEquals("Georgia, serif", ThemeEdits.font(base, "body"))
        // The rest is the true base: the name and the dark background differ from it anyway.
        assertEquals("Nord copy", base.string("name"))
        assertEquals(ThemeEdits.colours(start, "dark"), ThemeEdits.colours(base, "dark"))
        assertEquals(ThemeEdits.colours(start, "light") - "accent", ThemeEdits.colours(base, "light") - "accent")
        // Nothing sent without an answer: the base as it is.
        assertEquals(start, ThemeEdits.sendingBase(start, now, emptyList()))
    }
}
