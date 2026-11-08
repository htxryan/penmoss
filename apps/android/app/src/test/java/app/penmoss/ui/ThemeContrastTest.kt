package app.penmoss.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import app.penmoss.engine.settings.ThemeCatalogue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The native screens' text reads in every theme (T40 P9, PL14, A498): WCAG AA (4.5:1) for each
 * text colour on every surface it is drawn on (the page, the sidebar's menus and sheets, raised
 * dialogs, the accent's soft containers; review S7), in the eight built-in themes and in custom
 * themes whose own colours fail, which are moved only as far as they must be. The note's page
 * gets the same colours.
 */
class ThemeContrastTest {
    private fun pairs(scheme: ColorScheme) = mapOf(
        "text on the page" to (scheme.onBackground to scheme.background),
        "text on the sidebar's menus" to (scheme.onSurface to scheme.surfaceContainer),
        "text on a dialog" to (scheme.onSurface to scheme.surfaceContainerHighest),
        "text on a soft container" to (scheme.onPrimaryContainer to scheme.primaryContainer),
        "the accent on the page" to (scheme.primary to scheme.background),
        "the accent on the sidebar" to (scheme.primary to scheme.surfaceContainer),
        "the accent on a dialog" to (scheme.primary to scheme.surfaceContainerHighest),
        "text on the accent" to (scheme.onPrimary to scheme.primary),
        "secondary text on the page" to (scheme.onSurfaceVariant to scheme.background),
        "secondary text on the sidebar" to (scheme.onSurfaceVariant to scheme.surfaceVariant),
        "secondary text on a dialog" to (scheme.onSurfaceVariant to scheme.surfaceContainerHighest),
        "an error on the page" to (scheme.error to scheme.background),
        "an error on a dialog" to (scheme.error to scheme.surfaceContainerHighest),
    )

    private fun assertReadable(scheme: ColorScheme, what: String) {
        for ((name, pair) in pairs(scheme)) {
            val ratio = contrast(pair.first, pair.second)
            assertTrue("$name is $ratio:1 in $what", ratio >= READABLE)
        }
    }

    private fun tokens(variant: JsonObject?) =
        variant.orEmpty().mapNotNull { (key, value) -> (value as? JsonPrimitive)?.takeIf { it.isString }?.let { key to it.content } }.toMap()

    private fun hex(colour: Color) = "#%06x".format(colour.toArgb() and 0xFFFFFF)

    private fun hue(colour: Color): Float {
        val (r, g, b) = Triple(colour.red, colour.green, colour.blue)
        val max = maxOf(r, g, b)
        val delta = max - minOf(r, g, b)
        if (delta == 0f) return 0f
        val sector = when (max) {
            r -> ((g - b) / delta).mod(6f)
            g -> (b - r) / delta + 2f
            else -> (r - g) / delta + 4f
        }
        return sector * 60f
    }

    private fun parse(hex: String) = Color(0xFF000000 or hex.removePrefix("#").toLong(16))

    @Test
    fun everyBuiltInThemeReadsAndIsLeftAlmostAsItIs() {
        val themes = ThemeCatalogue.bundled.builtIns
        assertEquals(8, themes.size)
        val moved = mutableListOf<String>()
        for (theme in themes) {
            for (dark in listOf(false, true)) {
                val colours = tokens(theme[if (dark) "dark" else "light"] as? JsonObject)
                val scheme = penmossColours(colours, dark)
                val what = "${theme["id"]?.jsonPrimitive?.content} ${if (dark) "dark" else "light"}"
                assertReadable(scheme, what)
                // The built-ins were tuned to pass on the page (T40 P1): their text never moves.
                assertEquals(what, colours["fg"], hex(scheme.onBackground))
                if (colours["accent"] != hex(scheme.primary)) moved += what
            }
        }
        // Two light accents fall just short on the sidebar (4.38 and 4.30:1) and move a little.
        assertEquals(listOf("nord light", "solarized light"), moved)
    }

    private val pale = mapOf(
        "bg" to "#ffffff",
        "sidebar" to "#f0f0f0",
        "raised" to "#f7f7f7",
        "fg" to "#9a9a9a",
        "muted" to "#c8c8c8",
        "accent" to "#8fd19e",
        "onAccent" to "#ffffff",
        "danger" to "#ff9a9a",
    )
    private val murky = mapOf(
        "bg" to "#101010",
        "sidebar" to "#1a1a1a",
        "raised" to "#242424",
        "fg" to "#555555",
        "muted" to "#333333",
        "accent" to "#203a70",
        "onAccent" to "#203a70",
        "danger" to "#5a1010",
    )

    @Test
    fun aCustomThemeThatFailsIsMadeReadableKeepingItsHue() {
        for ((tokens, dark) in listOf(pale to false, murky to true)) {
            val scheme = penmossColours(tokens, dark)
            assertReadable(scheme, tokens.toString())
            // Lightened or darkened, not replaced: the accent's hue stays (review N4).
            val before = hue(parse(tokens.getValue("accent")))
            assertEquals("hue of $tokens", before, hue(scheme.primary), 3f)
            // Only as far as it must: just past AA on its worst surface, not black or white.
            val worst = listOf(scheme.background, scheme.surfaceContainer, scheme.surfaceContainerHighest).minOf { contrast(scheme.primary, it) }
            assertTrue("accent at $worst:1", worst < READABLE + 1f)
        }
    }

    @Test
    fun theNotesPageGetsTheColoursTheScreensUse() {
        val theme = JsonObject(
            mapOf(
                "id" to JsonPrimitive("custom-pale"),
                "light" to JsonObject(pale.mapValues { JsonPrimitive(it.value) } + ("link" to JsonPrimitive("#aaccff"))),
                "dark" to JsonObject(mapOf("bg" to JsonPrimitive("#101010"), "fg" to JsonPrimitive("#eeeeee"))),
            ),
        )
        val sent = readableTheme(theme)
        val scheme = penmossColours(pale, dark = false)
        val light = sent.getValue("light").jsonObject
        assertEquals(hex(scheme.onBackground), light.getValue("fg").jsonPrimitive.content)
        assertEquals(hex(scheme.onSurfaceVariant), light.getValue("muted").jsonPrimitive.content)
        assertEquals(hex(scheme.primary), light.getValue("accent").jsonPrimitive.content)
        assertEquals(hex(scheme.error), light.getValue("danger").jsonPrimitive.content)
        // Everything else as it came: the surfaces, the link colour, the id, a variant that reads.
        assertEquals("#ffffff", light.getValue("bg").jsonPrimitive.content)
        assertEquals("#aaccff", light.getValue("link").jsonPrimitive.content)
        assertEquals(theme["id"], sent["id"])
        assertEquals(theme["dark"], sent["dark"])
        // A built-in that reads is sent unchanged.
        val penmoss = ThemeCatalogue.bundled.builtIns.first { it["id"]?.jsonPrimitive?.content == "penmoss" }
        assertEquals(penmoss, readableTheme(penmoss))
    }
}
