package app.penmoss.ui.common

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.font.FontFamily
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.settings.FontSettings
import app.penmoss.ui.settings.AppearanceScreen
import app.penmoss.ui.settings.FontsUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Interface Font, Note Font and Note Font Size (T51, A944): chosen in Settings → Appearance; the
 * interface font is the native screens' typography (the note font and size go to the editor page,
 * `EditorPageServicesTest`).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FontsTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun eachPresetIsThePhonesOwnFaceAndTheThemesIsMaterials() {
        assertNull(interfaceFontFamily(FontSettings.THEME))
        assertEquals(FontFamily.Serif, interfaceFontFamily("serif"))
        assertEquals(FontFamily.Monospace, interfaceFontFamily("mono"))
        for (sans in listOf("system", "rounded", "humanist")) assertEquals(FontFamily.SansSerif, interfaceFontFamily(sans))
        // An installed family by name, the sans without it; nothing unreadable.
        assertNotNull(interfaceFontFamily("custom:Avenir Next"))
        assertNull(interfaceFontFamily("custom:x;}body{"))
        assertEquals(androidx.compose.material3.Typography(), penmossTypography(null))
        assertEquals(FontFamily.Serif, penmossTypography(FontFamily.Serif).labelSmall.fontFamily)
    }

    @Test
    fun theScreensTakeTheInterfaceFont() {
        var family: FontFamily? = null
        var title: FontFamily? = null
        compose.setContent {
            PenmossTheme(Appearance(interfaceFont = "serif")) {
                family = MaterialTheme.typography.bodyLarge.fontFamily
                title = MaterialTheme.typography.titleLarge.fontFamily
            }
        }
        compose.waitForIdle()
        assertEquals(FontFamily.Serif, family)
        assertEquals(FontFamily.Serif, title)
    }

    @Test
    // A phone's height: Appearance's tabs hold still and the Settings tab scrolls under them (A1619).
    @org.robolectric.annotation.Config(qualifiers = "w411dp-h900dp")
    fun appearanceChoosesEachFontAndTheSize() {
        var fonts by mutableStateOf(FontsUi("theme", "theme", 16, {}, {}, {}))
        val stored = mutableListOf<Pair<String, Any>>()
        fun ui(interfaceFont: String, noteFont: String, size: Int): FontsUi = FontsUi(
            interfaceFont, noteFont, size,
            onInterfaceFont = { stored += "interface" to it; fonts = ui(it, fonts.noteFont, fonts.noteSize) },
            onNoteFont = { stored += "note" to it; fonts = ui(fonts.interfaceFont, it, fonts.noteSize) },
            onNoteSize = { stored += "size" to it; fonts = ui(fonts.interfaceFont, fonts.noteFont, it) },
        )
        fonts = ui("theme", "theme", FontSettings.PHONE_SIZE_DEFAULT)
        compose.setContent {
            PenmossTheme {
                AppearanceScreen(
                    "system", systemDark = false, themes = emptyList(), chosen = "penmoss", fullWidth = false, editorWidth = 52,
                    enabled = true, onMode = {}, onTheme = {}, onFullWidth = {}, onBack = {}, fonts = fonts,
                )
            }
        }
        compose.onNodeWithTag("font-interface").performScrollTo().performClick()
        compose.onNodeWithTag("font-preset-theme").assertIsSelected()
        compose.onNodeWithTag("font-preset-theme").assertTextContains("Theme Default")
        compose.onNodeWithTag("font-preset-serif").performScrollTo().performClick()
        assertEquals("interface" to "serif", stored.last())
        compose.onNodeWithTag("font-interface").assertTextContains("Serif")
        // A custom family, checked by the web's rules as it is typed.
        compose.onNodeWithTag("font-note").performScrollTo().performClick()
        compose.onNodeWithTag("font-preset-custom").performScrollTo().performClick()
        compose.onNodeWithTag("font-custom-name").performScrollTo().performTextReplacement("Bad'Quote")
        compose.onNodeWithTag("font-custom-use").assertIsNotEnabled()
        compose.onNodeWithTag("font-custom-name").performScrollTo().performTextReplacement("Charter")
        compose.onNodeWithTag("font-custom-use").performClick()
        assertEquals("note" to "custom:Charter", stored.last())
        compose.onNodeWithTag("font-note").assertTextContains("Charter")
        // 18 on the phone (A1628).
        compose.onNodeWithText("18 px (default)").performScrollTo().assertExists()
    }
}
