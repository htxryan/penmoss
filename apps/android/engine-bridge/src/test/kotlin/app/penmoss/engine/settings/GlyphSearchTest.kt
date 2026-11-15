package app.penmoss.engine.settings

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Characters and their search on the phone (A1569): the web's file, shipped as a resource,
 * every glyph valid by [LineSymbols]' rules, and [GlyphSearch] finding what core's `findGlyphs`
 * finds, in its order (`contract/glyph-search-v1.json`, written from core by the editor page's
 * vitest).
 */
class GlyphSearchTest {
    private val contract: JsonObject = Json.parseToJsonElement(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("glyph-search-v1.json") }
            ?: File("../contract/glyph-search-v1.json")).readText(),
    ).jsonObject

    @Test
    fun theCharactersAreTheWebsEachAValidGlyphTheOldPresetsFirst() {
        val all = Characters.all
        assertEquals(contract.getValue("characters").jsonPrimitive.int, all.size)
        for (each in all) {
            assertNull(each.glyph, LineSymbols.glyphProblem(each.glyph))
            assertTrue(each.glyph, each.name.isNotBlank())
        }
        assertEquals(all.size, all.map { LineSymbols.glyphKey(it.glyph) }.toSet().size)
        assertEquals(LineSymbols.PRESET_GLYPHS, all.take(LineSymbols.PRESET_GLYPHS.size).map { it.glyph })
    }

    @Test
    fun findsWhatCoreFindsInItsOrder() {
        val cases = contract.getValue("cases").jsonArray
        assertTrue(cases.size > 10)
        for (case in cases) {
            val query = case.jsonObject.getValue("query").jsonPrimitive.content
            val found = GlyphSearch.find(Characters.all, query)
            assertEquals("count for \"$query\"", case.jsonObject.getValue("count").jsonPrimitive.int, found.size)
            val first = case.jsonObject.getValue("first").jsonArray.map { it.jsonPrimitive.content }
            assertEquals("order for \"$query\"", first, found.take(first.size).map { it.glyph })
        }
    }

    @Test
    fun normalisesAQuery() {
        assertEquals("light bulb idea", GlyphSearch.normalise("  Light-Bulb__idea "))
    }

    @Test
    fun shipsTheNoticeItsDataAsksFor() {
        val notice = GlyphSearch::class.java.getResourceAsStream("/characters-NOTICE.txt")!!
            .bufferedReader().use { it.readText() }
        assertTrue(notice.contains("emojibase-data"))
        assertTrue(notice.contains("UNICODE LICENSE V3"))
    }
}
