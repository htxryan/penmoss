package app.penmoss.proof

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.HomeLayout
import app.penmoss.ui.PenmossTheme
import app.penmoss.ui.displayChoices
import app.penmoss.ui.settings.DisplayScreen
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-87's Android proof: Settings → Display's "Notes in Recent Notes" row says its count as
 * "10 notes", not a bare "10". The row is below the shortcuts and sections, so the test scrolls
 * Display until it is on screen and holds it there. Run with
 * `task proof:android -- app.penmoss.proof.RecentCountNotesProofTest`.
 *
 * Reads and scrolls the screen through Compose's semantics tree, not the Compose test rule,
 * whose Espresso link doesn't start on the API 37 emulator (as in TooltipDelayInstrumentedTest).
 */
@RunWith(AndroidJUnit4::class)
class RecentCountNotesProofTest {
    @Test
    fun displayShowsTheRecentCountAsNotes() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        DisplayScreen(
                            displayChoices(Settings()),
                            enabled = true,
                            onChange = { _, _ -> },
                            onBack = {},
                            layout = HomeLayout.of(Settings()).copy(recentCount = 10),
                        )
                    }
                }
            }
            // Wait for Display's first frame (up to 30 s on a loaded emulator).
            var line: SemanticsNode? = null
            waitUntil(instrumentation) {
                scenario.onActivity { activity -> line = textNode(activity.window.decorView, LINE) }
                line != null
            }
            assertNotNull("Display has no \"$LINE\"", line)

            // Scroll Display a third of a screen at a time until the row is laid out on screen (a
            // row not yet placed has empty bounds), then bring it to the middle of the screen.
            var visible = false
            var height = 0
            waitUntil(instrumentation) {
                scenario.onActivity { activity ->
                    val view = activity.window.decorView
                    height = view.height
                    line = textNode(view, LINE)
                    val bounds = line?.boundsInWindow
                    visible = bounds != null && bounds.top >= 0f && bounds.bottom <= height && bounds.height > 0f
                    if (!visible) scrollBy(view, height / 3f)
                }
                visible
            }
            scenario.onActivity { activity ->
                val view = activity.window.decorView
                val by = textNode(view, LINE)!!.boundsInWindow.center.y - view.height / 2f
                if (by > 0f) scrollBy(view, by)
            }
            waitUntil(instrumentation) {
                scenario.onActivity { activity ->
                    val view = activity.window.decorView
                    line = textNode(view, LINE)
                    val bounds = line?.boundsInWindow
                    visible = bounds != null && bounds.top >= 0f && bounds.bottom <= height && bounds.height > 0f
                }
                visible
            }
            assertTrue("\"$LINE\" isn't on screen: ${line?.boundsInWindow}, window height $height", visible)
            scenario.onActivity { activity ->
                assertNotNull(textNode(activity.window.decorView, "Notes in Recent Notes"))
            }
            // Held on screen, so the recording shows the line, then the PR's screenshot (A1255).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    private fun waitUntil(instrumentation: android.app.Instrumentation, done: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 30_000
        do {
            instrumentation.waitForIdleSync()
            if (done()) return
            SystemClock.sleep(250)
        } while (SystemClock.uptimeMillis() < deadline)
    }

    /** Scrolls Display's list down by [by] pixels. */
    private fun scrollBy(view: View, by: Float) {
        val scroller = nodes(view).first { SemanticsActions.ScrollBy in it.config }
        scroller.config[SemanticsActions.ScrollBy].action!!.invoke(0f, by)
    }

    private fun textNode(view: View, text: String): SemanticsNode? =
        nodes(view).firstOrNull { node -> node.config.getOrNull(SemanticsProperties.Text).orEmpty().any { it.text == text } }

    /** Every semantics node in the Compose roots under [view], unmerged. */
    private fun nodes(view: View): List<SemanticsNode> {
        val roots = mutableListOf<ViewRootForTest>()
        fun walk(v: View) {
            if (v is ViewRootForTest) roots += v
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return roots.flatMap { it.semanticsOwner.getAllSemanticsNodes(mergingEnabled = false) }
    }

    private companion object {
        const val LINE = "10 notes"
    }
}
