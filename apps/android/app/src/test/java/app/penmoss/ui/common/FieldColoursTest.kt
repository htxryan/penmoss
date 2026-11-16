package app.penmoss.ui.common

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextFieldColors
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * A field stands off its page (Android feedback 14): every outlined field is filled with the
 * theme's raised colour (white in the light themes), not Material's see-through fill on the
 * page's own colour, and no screen reaches past the app's field to Material's.
 */
@RunWith(AndroidJUnit4::class)
class FieldColoursTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun aFieldIsFilledWithTheRaisedColourNotThePages() {
        val seen = mutableMapOf<Boolean, Triple<TextFieldColors, Color, Color>>()
        compose.setContent {
            for (dark in listOf(false, true)) {
                PenmossTheme(dark = dark) {
                    seen[dark] = Triple(penmossFieldColors(), MaterialTheme.colorScheme.surfaceBright, MaterialTheme.colorScheme.background)
                }
            }
        }
        compose.waitForIdle()
        for ((dark, found) in seen) {
            val (fill, raised, page) = found
            assertEquals(raised, fill.unfocusedContainerColor)
            assertEquals(raised, fill.focusedContainerColor)
            assertEquals(raised, fill.errorContainerColor)
            assertNotEquals(page, fill.unfocusedContainerColor)
            if (!dark) assertEquals(Color.White, fill.unfocusedContainerColor)
        }
        assertEquals(2, seen.size)
    }

    @Test
    fun everyOutlinedFieldIsTheAppsField() {
        val sources = File("src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue(sources.size > 50)
        val direct = sources.filter { it.name != "Fields.kt" && it.readText().contains("import androidx.compose.material3.OutlinedTextField\n") }
        assertEquals(emptyList<String>(), direct.map { it.name })
    }
}
