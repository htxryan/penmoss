package app.penmoss.ui.common

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.ScreenTree
import app.penmoss.engine.settings.Settings
import app.penmoss.proof.ProofShot
import app.penmoss.ui.settings.DisplayScreen
import app.penmoss.ui.settings.HomeLayout
import app.penmoss.ui.settings.displayChoices
import app.penmoss.ui.settings.displaySummary
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-70's Android proof (A1247): the web and Mac apps' synced "Show Tooltips After"
 * (`tooltip.delay`) has no row on the phone, and a synced value, Never included, changes
 * nothing on Settings → Display. Phones have no hover, and Android times a long press itself
 * (A657). Run in the factory's proof with
 * `task proof:android -- app.penmoss.ui.common.TooltipDelayInstrumentedTest`.
 *
 * Reads the screen through Compose's semantics tree, not the Compose test rule: the rule's
 * Espresso link doesn't start on the API 37 emulator (InputManager.getInstance is gone).
 */
@RunWith(AndroidJUnit4::class)
class TooltipDelayInstrumentedTest {
    @Test
    fun displayHasNoTooltipRowAndIgnoresTheSyncedDelay() {
        for (value in listOf(JsonPrimitive(500), JsonPrimitive(2000), JsonPrimitive("never"))) {
            val synced = Settings().with("tooltip.delay", value)
            // The synced delay changes neither Display's choices nor Home's layout.
            assertEquals(displayChoices(Settings()), displayChoices(synced))
            assertEquals(HomeLayout.of(Settings()), HomeLayout.of(synced))
            assertEquals(displaySummary(Settings()), displaySummary(synced))
        }

        val synced = Settings().with("tooltip.delay", JsonPrimitive("never"))
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        DisplayScreen(displayChoices(synced), enabled = true, onChange = { _, _ -> }, onBack = {}, layout = HomeLayout.of(synced))
                    }
                }
            }
            // Wait for Display's first frame: on a loaded emulator, Compose can compose after the
            // main thread's first idle, so read the screen until its rows are there (up to 30 s).
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            var texts = emptyList<String>()
            val deadline = SystemClock.uptimeMillis() + 30_000
            do {
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity -> texts = ScreenTree.texts(activity.window.decorView) }
                if ("Today" in texts && "Show Notebook Names" in texts) break
                SystemClock.sleep(250)
            } while (SystemClock.uptimeMillis() < deadline)
            // The whole screen, scrolled-off rows included: Display's own rows are there...
            assertTrue(texts.toString(), "Today" in texts)
            assertTrue(texts.toString(), "Recent Notes" in texts)
            // PEN-146: Quick Access's own switch, under its section.
            assertTrue(texts.toString(), "Show Notebook Names" in texts)
            // ...and nothing names the web's tooltip field or its choices.
            assertTrue(texts.toString(), texts.none { it.contains("Tooltip", ignoreCase = true) })
            assertTrue(texts.toString(), texts.none { it == "Never" || it.endsWith("(Default)") || it.endsWith("Seconds") })
            // The proof's screenshot, while Display is on screen (A1255).
            ProofShot.take()
            // Held on screen a moment, so the proof's recording shows Display.
            SystemClock.sleep(2_000)
        }
    }
}
