package app.penmoss.ui.settings

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.analytics.OnScreen
import app.penmoss.analytics.texts
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A1679's Android proof in Settings → Symbols: Strikethrough is a symbol kind, last of the
 * defaults (symbol 7), its row showing ⊘ and what its key does ("⊘ strikes the line through"),
 * and the page has no subtitle under its title (A1674). The editor's side, a line's stack of
 * symbols and its struck text, is `SymbolStackInstrumentedTest`. Run with
 * `task proof:android -- app.penmoss.ui.settings.SymbolsStrikethroughInstrumentedTest`.
 */
@RunWith(AndroidJUnit4::class)
class SymbolsStrikethroughInstrumentedTest {
    @Test
    fun strikethroughIsTheLastDefaultSymbol() {
        val symbols = LineSymbols.DEFAULTS
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        SymbolsScreen(symbols, custom = false, enabled = true, onChange = { null }, onReset = {}, onShortcuts = {}, onBack = {})
                    }
                }
            }
            val screen = OnScreen(scenario)
            val last = symbols.lastIndex
            assertEquals(6, last)
            screen.reveal(screen.tagged("symbol-row-$last"), margin = 400f)
            assertEquals(listOf("⊘"), box(screen, last))
            assertEquals(listOf("Strikethrough"), screen.tagged("symbol-colour-label-$last").texts())
            assertEquals(listOf("Alt+Shift+7 · ⊘ strikes the line through"), screen.tagged("symbol-key-$last").texts())
            assertEquals(listOf("7 of ${LineSymbols.MAX}"), screen.tagged("symbol-count").texts())
            // No sentence under the page's title any more (A1674).
            assertFalse(screen.has("Type a symbol at the start of a line to mark it", partial = true))
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    /** The glyph's own text node under its box [index], however the box nests it. */
    private fun box(screen: OnScreen, index: Int): List<String> {
        val box = screen.tagged("symbol-glyph-$index")
        return screen.nodes().filter { node ->
            var at = node.parent
            while (at != null && at.id != box.id) at = at.parent
            at != null
        }.flatMap { it.texts() }
    }

    private fun OnScreen.has(text: String, partial: Boolean): Boolean =
        if (!partial) has(text) else texts().any { it.contains(text) }
}
