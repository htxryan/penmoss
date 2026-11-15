package app.penmoss.engine.settings

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Glyphs that come in their own colours on the phone (A1588): [ColourLock] says what core's
 * `isColourLocked` says (`contract/colour-lock-v1.json`, written from core by the editor page's
 * vitest), its emoji ranges the same, of every Character and of typed glyphs.
 */
class ColourLockTest {
    private val contract: JsonObject = Json.parseToJsonElement(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("colour-lock-v1.json") }
            ?: File("../contract/colour-lock-v1.json")).readText(),
    ).jsonObject

    private fun glyphs(key: String) = contract.getValue(key).jsonArray.map { it.jsonPrimitive.content }

    @Test
    fun itsEmojiRangesAreCores() {
        val ranges = contract.getValue("emojiPresentation").jsonArray.flatMap { pair ->
            pair.jsonArray.map { it.jsonPrimitive.int }
        }
        assertEquals(ranges, ColourLock.EMOJI_PRESENTATION.toList())
    }

    @Test
    fun itLocksWhatCoreLocksAndNothingElse() {
        val locked = glyphs("locked")
        val unlocked = glyphs("unlocked")
        assertTrue(locked.size > 1000)
        for (glyph in locked) assertTrue(glyph, ColourLock.isLocked(glyph))
        for (glyph in unlocked) assertFalse(glyph, ColourLock.isLocked(glyph))
    }

    @Test
    fun theDefaultSymbolsOnlyTheIdeaIsAnEmoji() {
        assertTrue(ColourLock.isLocked("💡"))
        for (glyph in listOf("★", "?", "!", "→", "A", "7", "❤")) assertFalse(glyph, ColourLock.isLocked(glyph))
        assertTrue(ColourLock.isLocked("❤\uFE0F"))
        assertFalse(ColourLock.isLocked("\u231A\uFE0E"))
    }
}
