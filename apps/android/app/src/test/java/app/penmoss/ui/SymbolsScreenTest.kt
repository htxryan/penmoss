package app.penmoss.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.v2.createComposeRule
import app.penmoss.ui.settings.ColourPicker
import app.penmoss.ui.settings.ColourWheel
import androidx.compose.ui.test.click
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.settings.LineSymbol
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.settings.HexColours
import app.penmoss.ui.settings.Hsva
import app.penmoss.ui.settings.SETTINGS_WAIT
import app.penmoss.ui.settings.SymbolsScreen
import kotlinx.serialization.json.JsonObject
import android.graphics.Color as AColor
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Settings → Symbols on the phone (T44, ST13, A747): the web's synced list, changed by the web's
 * rules. Each change stores the whole list; Restore defaults clears it.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SymbolsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val stored = mutableListOf<List<LineSymbol>>()
    private var resets = 0
    private var shortcuts = 0

    private fun screen(start: List<LineSymbol> = LineSymbols.DEFAULTS, enabled: Boolean = true) {
        var symbols by mutableStateOf(start)
        compose.setContent {
            PenmossTheme {
                SymbolsScreen(
                    symbols = symbols,
                    custom = symbols != LineSymbols.DEFAULTS,
                    enabled = enabled,
                    onChange = { next ->
                        symbolsChange(next) ?: run {
                            stored += next
                            symbols = next
                            null
                        }
                    },
                    onReset = {
                        resets++
                        symbols = LineSymbols.DEFAULTS
                    },
                    onShortcuts = { shortcuts++ },
                    onBack = {},
                )
            }
        }
    }

    @Test
    fun movesASymbolToAnotherSlot() {
        screen()
        compose.onNodeWithTag("symbol-up-0").assertIsNotEnabled()
        compose.onNodeWithTag("symbol-down-0").performClick()
        assertEquals(listOf("?", "★", "!", "💡", "→"), stored.last().map { it.glyph })
        compose.onNodeWithTag("symbols-notice").assertTextContains("★ is now symbol 2.")
        // Moved: Restore defaults has something to do now.
        compose.onNodeWithTag("symbol-reset").performScrollTo().assertIsEnabled().performClick()
        assertEquals(1, resets)
    }

    @Test
    fun editsAGlyphAndColourByTheWebsRules() {
        screen()
        compose.onNodeWithTag("symbol-row-1").performClick()
        // Settings neither shows nor asks for a name (T51, A940).
        compose.onNodeWithTag("symbol-name").assertDoesNotExist()
        compose.onNodeWithTag("symbol-glyph").performTextReplacement("A")
        compose.onNodeWithText("Glyph cannot hold letters or digits").assertIsDisplayed()
        compose.onNodeWithTag("symbol-save").assertIsNotEnabled()
        // Another symbol's glyph, with or without its emoji selector, is taken.
        compose.onNodeWithTag("symbol-glyph").performTextReplacement("💡️")
        compose.onNodeWithText("💡️ is already in the list").assertIsDisplayed()
        compose.onNodeWithTag("symbol-glyph").performTextReplacement("⁇")
        compose.onNodeWithTag("symbol-colour-calloutNote").performScrollTo().performClick()
        compose.onNodeWithTag("symbol-save").performClick()
        // A new glyph is the symbol's name too, so older builds still read the list.
        assertEquals(LineSymbol("⁇", "⁇", "calloutNote"), stored.last()[1])
        assertEquals(5, stored.last().size)
        compose.onNodeWithTag("symbols-notice").assertTextContains("Saved ⁇.")
    }

    /** The glyph picker (T51, A939): the web's presets, one already in the list not offered again. */
    @Test
    fun picksAPresetGlyph() {
        screen()
        compose.onNodeWithTag("symbol-row-0").performClick()
        // ★ is this symbol's own; ? is symbol 2's and cannot be chosen.
        val question = LineSymbols.PRESET_GLYPHS.indexOf("?")
        compose.onNodeWithTag("symbol-preset-$question").performScrollTo().assertIsNotEnabled()
        val heart = LineSymbols.PRESET_GLYPHS.indexOf("♥")
        compose.onNodeWithTag("symbol-preset-$heart").performScrollTo().assertIsEnabled().performClick()
        compose.onNodeWithTag("symbol-glyph").assertTextContains("♥")
        compose.onNodeWithTag("symbol-save").performClick()
        assertEquals(LineSymbol("♥", "♥", "calloutWarning"), stored.last()[0])
    }

    /** Any colour (T51, A939): a hex typed in any accepted form is stored lower case, opaque without alpha. */
    @Test
    fun picksAnyColourByHex() {
        screen()
        compose.onNodeWithTag("symbol-row-2").performClick()
        compose.onNodeWithTag("symbol-colour-custom").performScrollTo().performClick()
        compose.onNodeWithTag("symbol-colour-wheel").assertExists()
        compose.onNodeWithTag("symbol-hex").performScrollTo().performTextReplacement("#2E7D32FF")
        compose.onNodeWithTag("symbol-save").performClick()
        assertEquals(LineSymbol("!", "Follow-up", "#2e7d32"), stored.last()[2])
        compose.onNodeWithTag("symbol-row-2").performClick()
        compose.onNodeWithTag("symbol-hex").performScrollTo().performTextReplacement("ff000088")
        compose.onNodeWithTag("symbol-save").performClick()
        assertEquals("#ff000088", stored.last()[2].colour)
        // The row names the colour by its hex.
        compose.onNodeWithText("#FF000088").assertExists()
    }

    /**
     * A hex typed quickly is kept (T51 manual pass): a short prefix that is a colour (#C21) came
     * back a frame later, when the field held more (#C218), and replaced what was being typed.
     */
    @Test
    fun aHexTypedQuicklyIsNotUndoneByItsOwnPrefix() {
        screen()
        compose.onNodeWithTag("symbol-row-2").performClick()
        compose.onNodeWithTag("symbol-colour-custom").performScrollTo().performClick()
        val field = compose.onNodeWithTag("symbol-hex").performScrollTo()
        field.performTextReplacement("#C21")
        compose.mainClock.autoAdvance = false
        field.performTextInput("8")
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.autoAdvance = true
        field.performTextInput("5B")
        field.assertTextContains("#C2185B")
        compose.onNodeWithTag("symbol-save").performClick()
        assertEquals("#c2185b", stored.last()[2].colour)
    }

    /**
     * The colour wheel (T51, A939), as the web's: red at the top and the hues clockwise, then
     * Brightness from black to the colour at full brightness. Its sliders' Material tracks are
     * clear, so the colours show (T51 manual pass: they once drew over the hue's spectrum).
     */
    @Test
    fun theWheelShowsTheHuesAroundItAndBrightnessItsRamp() {
        // The picker alone, pure blue: inside the symbol dialog, the dialog's frame sometimes still
        // covered the wheel's top when captured (CI read the dialog's grey there).
        compose.setContent { PenmossTheme { ColourPicker(hex = "#0000ff", onChange = {}) } }
        val wheel = compose.onNodeWithTag("symbol-colour-wheel").captureToImage().asAndroidBitmap()
        val r = wheel.width / 2f * 0.85f
        fun at(dx: Float, dy: Float) = wheel.getPixel((wheel.width / 2f + dx).toInt(), (wheel.height / 2f + dy).toInt())
        fun rgb(pixel: Int) = Integer.toHexString(pixel)
        val top = at(0f, -r)
        val right = at(r, 0f)
        val bottom = at(0f, r)
        val left = at(-r, 0f)
        assertTrue("red at the top, not ${rgb(top)}", AColor.red(top) > 150 && AColor.green(top) < 90 && AColor.blue(top) < 90)
        assertTrue("yellow-green at the right, not ${rgb(right)}", AColor.green(right) > 150 && AColor.blue(right) < 90)
        assertTrue("cyan at the bottom, not ${rgb(bottom)}", AColor.red(bottom) < 90 && AColor.green(bottom) > 150 && AColor.blue(bottom) > 150)
        assertTrue("violet at the left, not ${rgb(left)}", AColor.blue(left) > 150 && AColor.green(left) < 90)
        val value = compose.onNodeWithTag("symbol-colour-value").captureToImage().asAndroidBitmap()
        val dark = value.getPixel((value.width * 0.04f).toInt(), value.height / 2)
        // Short of the end, where the thumb sits at full brightness.
        val bright = value.getPixel((value.width * 0.8f).toInt(), value.height / 2)
        assertTrue("black at Brightness's start, not ${rgb(dark)}", AColor.red(dark) < 60 && AColor.green(dark) < 60 && AColor.blue(dark) < 60)
        assertTrue("the colour bright towards its end, not ${rgb(bright)}", AColor.blue(bright) > 150 && AColor.red(bright) < 60)
    }

    /** A tap on the wheel picks the hue and saturation there; brightness and opacity stay. */
    @Test
    fun aTapOnTheWheelPicksItsHueAndSaturation() {
        screen()
        compose.onNodeWithTag("symbol-row-2").performClick()
        compose.onNodeWithTag("symbol-colour-custom").performScrollTo().performClick()
        compose.onNodeWithTag("symbol-colour-wheel").performScrollTo().performTouchInput { click(Offset(width - 2f, height / 2f)) }
        compose.onNodeWithTag("symbol-save").performClick()
        val picked = HexColours.hsva(stored.last()[2].colour)
        assertEquals(90f, picked.hue, 3f)
        assertTrue("saturation near the edge: ${picked.saturation}", picked.saturation > 0.95f)
        assertEquals(HexColours.hsva("#3a7bd5").value, picked.value, 0.01f)
    }

    /** The wheel's maths are the web's (`colour.test.ts`, "the colour wheel"). */
    @Test
    fun theWheelsMathsAreTheWebs() {
        assertEquals(0f to 1f, ColourWheel.point(0f, -50f, 50f))
        assertEquals(90f to 0.5f, ColourWheel.point(25f, 0f, 50f))
        assertEquals(180f, ColourWheel.point(0f, 50f, 50f).first, 0.001f)
        assertEquals(270f to 0.2f, ColourWheel.point(-10f, 0f, 50f))
        assertEquals(1f, ColourWheel.point(0f, -80f, 50f).second)
        assertEquals(0f to 0f, ColourWheel.point(0f, 0f, 50f))
        for ((h, s) in listOf(0f to 1f, 45f to 0.3f, 200f to 0.75f, 359f to 0.5f)) {
            val at = ColourWheel.position(h, s, 50f)
            val (hue, saturation) = ColourWheel.point(at.x, at.y, 50f)
            assertEquals(h, hue, 0.01f)
            assertEquals(s, saturation, 0.0001f)
        }
    }

    @Test
    fun hexColoursConvertBothWays() {
        assertEquals("#aabbcc", HexColours.parse("#ABC"))
        assertEquals("#aabbcc", HexColours.parse("aabbcc"))
        assertEquals("#aabbcc80", HexColours.parse("#AABBCC80"))
        assertEquals("#aabbcc", HexColours.parse("#aabbccff"))
        assertEquals(null, HexColours.parse("#abcd"))
        assertEquals(null, HexColours.parse("red"))
        for (hex in listOf("#ff0000", "#2e7d32", "#000000", "#ffffff", "#3a7bd580", "#7f7f7f")) {
            assertEquals(hex, HexColours.of(HexColours.hsva(hex)))
        }
        assertEquals("#ff0000", HexColours.of(Hsva(0f, 1f, 1f)))
        assertEquals("#00ff0080", HexColours.of(Hsva(120f, 1f, 1f, 128 / 255f)))
    }

    @Test
    fun addsUpToNineAndRemovesOne() {
        screen()
        compose.onNodeWithTag("symbol-add").performScrollTo().performClick()
        // A glyph the list does not have yet, as the web suggests one.
        compose.onNodeWithTag("symbol-glyph").assertTextContains("✓")
        compose.onNodeWithTag("symbol-save").performClick()
        assertEquals(LineSymbol("✓", "✓", "accent"), stored.last().last())
        compose.onNodeWithTag("symbol-row-5").performScrollTo().performClick()
        compose.onNodeWithTag("symbol-remove").performClick()
        assertEquals(LineSymbols.DEFAULTS, stored.last())
        compose.onNodeWithTag("symbols-notice").assertTextContains("Removed ✓. Lines with ✓ show it as text.")
    }

    @Test
    fun aFullListOffersNoMoreAndTheShortcutsAreOneTapAway() {
        screen((1..9).map { LineSymbol("!".repeat(it), "Slot $it", "accent") })
        compose.onNodeWithTag("symbol-add").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("symbol-shortcuts").performScrollTo().performClick()
        assertEquals(1, shortcuts)
    }

    @Test
    fun waitsForTheFirstSyncBeforeAnyChange() {
        screen(enabled = false)
        compose.onNodeWithText(SETTINGS_WAIT).assertIsDisplayed()
        compose.onNodeWithTag("symbol-down-0").assertIsNotEnabled()
        compose.onNodeWithTag("symbol-add").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun theSettingsHomeListsTheGlyphs() {
        assertEquals("★ ? ! 💡 →", symbolsSummary(Settings()))
        val none = Settings(JsonObject(mapOf(SettingKeys.SYMBOLS to LineSymbols.toJson(emptyList()))))
        assertEquals("None", symbolsSummary(none))
        assertEquals(emptyList<LineSymbol>(), none.symbols)
    }
}
