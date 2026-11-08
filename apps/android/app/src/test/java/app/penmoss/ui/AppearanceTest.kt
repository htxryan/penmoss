package app.penmoss.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The theme chosen in Settings → Appearance, as the phone reads what `/sync/tree` sent (T33, A305). */
class AppearanceTest {
    private val nord = """
        {"mode":"dark","theme":{"id":"nord","name":"Nord",
          "light":{"bg":"#eceff4","fg":"#2e3440","accent":"#5e81ac"},
          "dark":{"bg":"#2e3440","fg":"#eceff4","accent":"#88c0d0","border":"url(x)"}}}
    """.trimIndent()

    @Test
    fun readsTheModeAndEachVariantsColours() {
        val appearance = Appearance.parse(nord)
        assertEquals("dark", appearance.mode)
        assertEquals("nord", appearance.theme!!["id"].toString().trim('"'))
        assertEquals("#2e3440", appearance.colours(dark = true)["bg"])
        assertEquals("#eceff4", appearance.colours(dark = false)["bg"])
        // Only colours: anything else a theme holds is never used.
        assertNull(appearance.colours(dark = true)["border"])
    }

    @Test
    fun theModeDecidesUnlessItIsTheSystems() {
        assertTrue(Appearance(mode = "dark").isDark(systemDark = false))
        assertFalse(Appearance(mode = "light").isDark(systemDark = true))
        assertTrue(Appearance(mode = "system").isDark(systemDark = true))
        assertFalse(Appearance(mode = "system").isDark(systemDark = false))
    }

    @Test
    fun anythingUnreadableIsPenmossFollowingTheSystem() {
        for (text in listOf(null, "", "not json", "[]", """{"mode":"sepia"}""", """{"mode":3,"theme":"nord"}""")) {
            val appearance = Appearance.parse(text)
            assertEquals(text, "system", appearance.mode)
            assertNull(text, appearance.theme)
            assertEquals(text, emptyMap<String, String>(), appearance.colours(dark = false))
        }
    }

    @Test
    fun theNativeScreensTakeTheThemesColoursAndPenmossForTheRest() {
        val appearance = Appearance.parse(nord)
        val dark = penmossColours(appearance.colours(dark = true), dark = true)
        assertEquals(Color(0xFF2E3440), dark.background)
        assertEquals(Color(0xFFECEFF4), dark.onSurface)
        assertEquals(Color(0xFF88C0D0), dark.primary)
        // Not in the theme (or not a colour): Penmoss's own dark border.
        assertEquals(Color(0xFF2C332E), dark.outline)
        val fallback = penmossColours(emptyMap(), dark = false)
        assertEquals(Color(0xFFFBFAF7), fallback.background)
        assertEquals(Color(0xFF3C7A4B), fallback.primary)
    }

    /**
     * Every colour role a Material component paints with comes from the theme (T39): the Today
     * button, a selected chip, the progress bar's track, a sheet's tonal tint and a snackbar's
     * action were Material's own lavender before.
     */
    @Test
    fun noColourRoleIsLeftAtMaterialsBaselinePurple() {
        val roles: List<Pair<String, (ColorScheme) -> Color>> = listOf(
            "primaryContainer" to { it.primaryContainer },
            "secondaryContainer" to { it.secondaryContainer },
            "onSecondaryContainer" to { it.onSecondaryContainer },
            "tertiary" to { it.tertiary },
            "onTertiary" to { it.onTertiary },
            "tertiaryContainer" to { it.tertiaryContainer },
            "onTertiaryContainer" to { it.onTertiaryContainer },
            "surfaceTint" to { it.surfaceTint },
            "inversePrimary" to { it.inversePrimary },
            "inverseSurface" to { it.inverseSurface },
            "inverseOnSurface" to { it.inverseOnSurface },
            "surfaceBright" to { it.surfaceBright },
            "surfaceDim" to { it.surfaceDim },
        )
        for (dark in listOf(false, true)) {
            val baseline = if (dark) darkColorScheme() else lightColorScheme()
            for (tokens in listOf(emptyMap(), Appearance.parse(nord).colours(dark))) {
                val scheme = penmossColours(tokens, dark)
                for ((name, role) in roles) {
                    assertTrue("$name (dark=$dark) is still Material's", role(scheme) != role(baseline))
                }
            }
        }
    }

    /**
     * A snackbar is the theme turned over (T39 review): its surface is the text colour, its text
     * the background, and its action the accent at 4.5:1 or more on it, light and dark. Material's
     * own were a lavender snackbar in dark mode, with its action at 3.68:1.
     */
    @Test
    fun aSnackbarIsTheThemeTurnedOverWithAReadableAction() {
        val themes = listOf(
            emptyMap(),
            Appearance.parse(nord).colours(dark = false),
            Appearance.parse(nord).colours(dark = true),
            // A pale accent on a light theme and a deep one on a dark theme: the hard cases.
            mapOf("bg" to "#ffffff", "fg" to "#111111", "accent" to "#e0f0ff"),
            mapOf("bg" to "#101010", "fg" to "#f5f5f5", "accent" to "#203a20"),
        )
        for (dark in listOf(false, true)) {
            for (tokens in themes) {
                val scheme = penmossColours(tokens, dark)
                assertEquals(scheme.onSurface, scheme.inverseSurface)
                assertEquals(scheme.background, scheme.inverseOnSurface)
                val action = contrast(scheme.inversePrimary, scheme.inverseSurface)
                assertTrue("action at $action:1 (dark=$dark, $tokens)", action >= READABLE)
                val text = contrast(scheme.inverseOnSurface, scheme.inverseSurface)
                assertTrue("text at $text:1 (dark=$dark, $tokens)", text >= READABLE)
            }
        }
    }
}
