package app.penmoss.ui

import app.penmoss.engine.settings.ThemeCatalogue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The snackbar is the web's toast (PEN-63): the theme's raised surface, its text, its accent for
 * the action and a border that can be seen, in every built-in theme, light and dark, and in a
 * custom theme whose accent would not read on the raised surface (moved only as far as it must).
 */
class SnackbarColoursTest {
    private fun tokens(variant: JsonObject?) =
        variant.orEmpty().mapNotNull { (key, value) -> (value as? JsonPrimitive)?.takeIf { it.isString }?.let { key to it.content } }.toMap()

    private val variants: List<Pair<String, Pair<Map<String, String>, Boolean>>> =
        ThemeCatalogue.bundled.builtIns.flatMap { theme ->
            val name = (theme["id"] as JsonPrimitive).content
            listOf(false, true).map { dark -> "$name ${if (dark) "dark" else "light"}" to (tokens(theme[if (dark) "dark" else "light"] as? JsonObject) to dark) }
        } + listOf(
            "pale accent on white" to (mapOf("bg" to "#ffffff", "raised" to "#ffffff", "fg" to "#111111", "accent" to "#e0f0ff") to false),
            "deep accent on black" to (mapOf("bg" to "#101010", "raised" to "#181818", "fg" to "#f5f5f5", "accent" to "#203a20") to true),
        )

    @Test
    fun aSnackbarIsTheRaisedSurfaceWithReadableTextAndAction() {
        assertTrue(variants.size >= 16)
        for ((what, variant) in variants) {
            val (tokens, dark) = variant
            val scheme = penmossColours(tokens, dark)
            val colours = snackbarColours(scheme)
            // The raised surface, not the theme turned over.
            assertEquals(what, ReadableColours(tokens, dark).raised, colours.container)
            assertEquals(what, scheme.surfaceContainerHigh, colours.container)
            assertNotEquals(what, scheme.inverseSurface, colours.container)
            val text = contrast(colours.content, colours.container)
            assertTrue("text at $text:1 in $what", text >= READABLE)
            val action = contrast(colours.action, colours.container)
            assertTrue("action at $action:1 in $what", action >= READABLE)
            // The error glyph reads in the danger colour (3:1 for a glyph, as the web's).
            val danger = contrast(colours.danger, colours.container)
            assertTrue("danger glyph at $danger:1 in $what", danger >= 3f)
            // The border shows against the surface (the web's EDGE_MIN).
            val edge = contrast(colours.border, colours.container)
            assertTrue("border at $edge:1 in $what", edge >= 1.1f)
        }
    }

    @Test
    fun theActionIsTheAccentWhenItAlreadyReads() {
        val scheme = penmossColours(emptyMap(), dark = false)
        assertEquals(scheme.primary, snackbarColours(scheme).action)
        assertEquals(scheme.onSurface, snackbarColours(scheme).content)
        val dark = penmossColours(emptyMap(), dark = true)
        assertEquals(dark.primary, snackbarColours(dark).action)
        assertEquals(scheme.error, snackbarColours(scheme).danger)
    }
}
