package app.penmoss.engine.settings

import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Notebook badges on the phone (A1579), held to the web's by `contract/badge-v1.json` (written
 * by the web's `android-badge-contract.test.ts`): the presets, defaults, stored values, inks and
 * which icon a value draws, and the Lucide icons the app ships (`assets/lucide/icons.txt`, from
 * `scripts/lucide-android.mjs`): the same names and aliases, the same shapes, the same search.
 */
class NotebookBadgesTest {
    private val folder: File = System.getProperty("penmoss.contract")?.let { File(it).parentFile } ?: File("../contract")
    private val contract: JsonObject = Json.parseToJsonElement(folder.resolve("badge-v1.json").readText()).jsonObject
    private val icons: LucideIcons by lazy {
        val file = folder.resolve("../app/src/main/assets/lucide/icons.txt")
        assertTrue("$file is missing: run `task android:editor`", file.exists())
        LucideIcons.parse(file.readText())
    }

    private fun JsonElement.text() = jsonPrimitive.content
    private fun JsonObject.text(key: String) = getValue(key).text()

    private fun glyphOf(json: JsonElement) = json.jsonObject.let { BadgeGlyph(it.text("kind"), it.text("value")) }

    private fun badgeOf(json: JsonElement) = json.jsonObject.let {
        NotebookBadge(
            color = it.text("color"),
            preset = (it["preset"] as? JsonPrimitive)?.takeUnless { p -> p is JsonNull }?.content,
            glyph = glyphOf(it.getValue("glyph")),
            custom = it.getValue("custom").jsonPrimitive.boolean,
        )
    }

    @Test
    fun theKeysPresetsInksAndOldIconsAreTheWebs() {
        val keys = contract.getValue("keys").jsonObject
        assertEquals(keys.text("color"), NotebookBadges.COLOR)
        assertEquals(keys.text("glyph"), NotebookBadges.GLYPH)
        assertEquals(contract.text("lucidePrefix"), NotebookBadges.LUCIDE_PREFIX)
        assertEquals(contract.text("firstIcon"), NotebookBadges.FIRST_ICON)
        val ink = contract.getValue("ink").jsonObject
        assertEquals(ink.text("light"), NotebookBadges.INK_LIGHT)
        assertEquals(ink.text("dark"), NotebookBadges.INK_DARK)
        val presets = contract.getValue("presets").jsonArray.map { it.jsonObject.let { p -> BadgePreset(p.text("id"), p.text("label"), p.text("hex")) } }
        assertEquals(presets, NotebookBadges.PRESETS)
        val old = contract.getValue("oldIcons").jsonObject.mapValues { it.value.text() }
        assertEquals(old, NotebookBadges.OLD_ICONS)
    }

    @Test
    fun aNotebookWithNothingChosenHasTheWebsDefault() {
        for (case in contract.getValue("defaults").jsonArray.map { it.jsonObject }) {
            val id = case.text("id")
            val name = case.text("name")
            assertEquals("$id $name", badgeOf(case), NotebookBadges.defaultBadge(id, name))
        }
    }

    @Test
    fun storedValuesReadAsTheWebReadsThemABadOneAsTheDefault() {
        val stored = contract.getValue("stored").jsonObject
        val id = stored.text("id")
        val name = stored.text("name")
        for (case in stored.getValue("cases").jsonArray.map { it.jsonObject }) {
            val settings = case.getValue("settings").jsonObject
            assertEquals(settings.toString(), badgeOf(case.getValue("badge")), NotebookBadges.badgeOf(id, name, settings))
        }
    }

    @Test
    fun theInkIsTheWebsOnEveryPresetAndSomeCustomColours() {
        for (case in contract.getValue("inks").jsonArray.map { it.jsonObject }) {
            assertEquals(case.text("hex"), case.text("ink"), NotebookBadges.ink(case.text("hex")))
        }
    }

    @Test
    fun aStoredIconDrawsTheWebsIconOrNoneSoTheBadgeShowsItsLetter() {
        for (case in contract.getValue("draws").jsonArray.map { it.jsonObject }) {
            val value = case.text("value")
            val glyph = NotebookBadges.parseGlyph(JsonObject(mapOf("kind" to JsonPrimitive("icon"), "value" to JsonPrimitive(value))))
            assertEquals(value, case.getValue("valid").jsonPrimitive.boolean, glyph != null)
            val drawn = glyph?.let { NotebookBadges.iconInLucide(it.value) }?.let(icons::icon)?.name
            assertEquals(value, (case["icon"] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content, drawn)
        }
    }

    @Test
    fun theAppShipsTheWebsLucideItsNamesAliasesAndShapes() {
        val lucide = contract.getValue("lucide").jsonObject
        assertEquals(lucide.getValue("icons").jsonPrimitive.int, icons.all.size)
        val names = icons.all.joinToString("\n") { it.name }
        val sha = MessageDigest.getInstance("SHA-256").digest(names.toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(lucide.text("namesSha256"), sha)
        assertEquals(lucide.getValue("aliases").jsonObject.mapValues { it.value.text() }, icons.aliases)
        for ((name, shapes) in lucide.getValue("shapes").jsonObject) {
            val expected = shapes.jsonArray.map { shape ->
                val (element, attributes) = shape.jsonArray
                val all = attributes.jsonObject.mapValues { it.value.text() }
                LucideShape(element.text(), all - "fill", filled = all["fill"] == "currentColor")
            }
            val icon = icons.icon(name)
            assertNotNull(name, icon)
            assertEquals(name, expected, icon!!.shapes)
        }
        assertNull(icons.icon("from-a-later-lucide"))
    }

    @Test
    fun thePickersSearchFindsWhatTheWebsFinds() {
        for (case in contract.getValue("search").jsonArray.map { it.jsonObject }) {
            val query = case.text("query")
            val found = icons.find(query)
            assertEquals(query, case.getValue("count").jsonPrimitive.int, found.size)
            assertEquals(query, case.getValue("first").jsonArray.map { it.text() }, found.take(8).map { it.name })
        }
    }

    @Test
    fun eachShapeBecomesPathDataAndroidDraws() {
        val circle = LucideShape("circle", mapOf("cx" to "12", "cy" to "13", "r" to "8"), filled = false)
        assertEquals("M4 13A8 8 0 1 0 20 13A8 8 0 1 0 4 13Z", circle.pathData())
        val rect = LucideShape("rect", mapOf("x" to "3", "y" to "3", "width" to "18", "height" to "18", "rx" to "2"), filled = false)
        assertEquals("M5 3H19A2 2 0 0 1 21 5V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3Z", rect.pathData())
        val square = LucideShape("rect", mapOf("x" to "2", "y" to "2", "width" to "4", "height" to "4"), filled = false)
        assertEquals("M2 2H6V6H2Z", square.pathData())
        assertEquals("M2 3L4.5 6", LucideShape("line", mapOf("x1" to "2", "y1" to "3", "x2" to "4.5", "y2" to "6"), false).pathData())
        assertEquals("M3 11L22 2L13 21Z", LucideShape("polygon", mapOf("points" to "3 11 22 2 13 21"), false).pathData())
        assertEquals("M22 12L18 12", LucideShape("polyline", mapOf("points" to "22,12 18,12"), false).pathData())
        // Every shape the app ships becomes path data.
        for (icon in icons.all) for (shape in icon.shapes) assertTrue("${icon.name} ${shape.element}", shape.pathData().startsWith("M") || shape.pathData().startsWith("m"))
    }

    @Test
    fun whatTheChooserWritesReadsBack() {
        assertEquals(JsonPrimitive("teal"), NotebookBadges.colorValue("#1f7a7a"))
        assertEquals(JsonPrimitive("#123456"), NotebookBadges.colorValue("#123456"))
        assertNull(NotebookBadges.colorValue("plum"))
        val icon = BadgeGlyph(BadgeGlyph.ICON, "lucide:rocket")
        assertEquals(icon, NotebookBadges.parseGlyph(NotebookBadges.glyphValue(icon)))
        assertNull(NotebookBadges.glyphValue(BadgeGlyph(BadgeGlyph.NUMBER, "100")))
    }
}
