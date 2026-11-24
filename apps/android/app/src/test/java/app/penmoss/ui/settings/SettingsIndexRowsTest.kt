package app.penmoss.ui.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ai.AiKeyState
import app.penmoss.ai.AiKeys
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Every row is in both search indexes (docs/ux-conventions.md, PEN-10): each entry of Android's
 * Search Settings on a screen names a row that screen really draws (it takes the mark), and the
 * rows the Mac's `settings-index.ts` has on Symbols and AI Descriptions are in Android's with the
 * Mac's words.
 */
@RunWith(AndroidJUnit4::class)
class SettingsIndexRowsTest {
    @get:Rule
    val compose = createComposeRule()

    private val marked = SemanticsMatcher.expectValue(SettingMarked, true)

    /**
     * The ids of [route]'s entries whose row [screen] does not draw. Each is asked for as a result
     * asks for it: the mark first, then the screen opens, afresh for each.
     */
    private fun missingRows(route: String, screen: @Composable () -> Unit): List<String> {
        var asked by mutableStateOf<SettingMark?>(null)
        compose.mainClock.autoAdvance = false
        compose.setContent {
            PenmossTheme {
                asked?.let { mark -> key(mark) { CompositionLocalProvider(LocalSettingMark provides mark) { screen() } } }
            }
        }
        val ids = SETTINGS_INDEX.filter { it.route == route }.map { it.id }
        assertTrue("no entries for $route", ids.isNotEmpty())
        return ids.filter { id ->
            // On a clock that stands still: the first screen can take longer than the mark waits to draw here.
            val mark = SettingMark { 0L }.apply { request(id) }
            compose.runOnIdle { asked = mark }
            repeat(4) {
                compose.mainClock.advanceTimeBy(50)
                compose.waitForIdle()
            }
            compose.onAllNodes(marked, useUnmergedTree = true).fetchSemanticsNodes().isEmpty()
        }
    }

    @Test
    fun everySymbolsEntryIsARowOnSymbols() {
        val missing = missingRows(SettingsRoutes.SYMBOLS) {
            SymbolsScreen(
                symbols = LineSymbols.DEFAULTS,
                custom = false,
                enabled = true,
                onChange = { null },
                onReset = {},
                onShortcuts = {},
                onBack = {},
            )
        }
        assertEquals("Indexed but not drawn on Symbols", emptyList<String>(), missing)
    }

    @Test
    fun everyAiDescriptionsEntryIsARowOnAiDescriptions() {
        val missing = missingRows(SettingsRoutes.AI) {
            AiDescriptionsScreen(
                enabled = true,
                global = true,
                whenToDescribe = "pause",
                pauseS = AiKeys.DEFAULT_PAUSE,
                // With a provider, so Model shows, as it does on the Mac once one is chosen.
                provider = AiKeys.ANTHROPIC,
                key = AiKeyState(saved = true, refused = false),
                model = AiKeys.MODELS.first().first,
                prompt = null,
                tagPrompt = null,
                onGlobal = {},
                onWhen = {},
                onPause = {},
                onProvider = {},
                onModel = {},
                onPrompt = {},
                onTagPrompt = {},
                onSaveKey = { _, _ -> },
                onTestKey = {},
                onRemoveKey = {},
                onDescribeAll = { null },
                onBack = {},
            )
        }
        assertEquals("Indexed but not drawn on AI Descriptions", emptyList<String>(), missing)
    }

    /** The Mac's entries (`apps/web/src/pages/settings-index.ts`), with its words, help and aliases. */
    @Test
    fun theMacsSymbolsAndModelRowsAreIndexedWithTheMacsWords() {
        fun found(id: String) = SETTINGS_INDEX.single { it.id == id }
        found("add-a-symbol-or-list-item").let {
            assertEquals("Add a Symbol or List Item", it.label)
            assertEquals(SettingsRoutes.SYMBOLS, it.route)
            assertEquals("Up to nine: a symbol, Checkbox, Bulleted or Numbered List Item", it.help)
        }
        found("change-their-shortcuts").let {
            assertEquals("Change Their Shortcuts", it.label)
            assertEquals(SettingsRoutes.SYMBOLS, it.route)
            assertEquals(listOf("symbol keys", "keys"), it.aliases)
        }
        found("model").let {
            assertEquals("Model", it.label)
            assertEquals(SettingsRoutes.AI, it.route)
            assertEquals(listOf("ai", "claude", "haiku", "sonnet"), it.aliases)
        }
        found("commit-identity").let {
            assertEquals("Commit Identity", it.label)
            assertEquals("The name and email commits are made with", it.help)
        }
        assertTrue(searchSettings(SETTINGS_INDEX, "sonnet").any { it.id == "model" })
        assertTrue(searchSettings(SETTINGS_INDEX, "symbol keys").any { it.id == "change-their-shortcuts" })
        assertTrue(searchSettings(SETTINGS_INDEX, "list item").any { it.id == "add-a-symbol-or-list-item" })
        assertTrue(searchSettings(SETTINGS_INDEX, "commits from this phone").any { it.id == "commit-identity" })
    }
}
