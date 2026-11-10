package app.penmoss.ui

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.proof.ProofShot
import app.penmoss.ui.settings.SettingsHome
import app.penmoss.ui.settings.SettingsIcons
import app.penmoss.ui.settings.SettingsSection
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-64's Android proof: the web and Mac apps' Settings heading lost its left gutter in a wide
 * window (a stale CSS selector). The phone's Settings is its own Compose screen, so it is
 * unaffected: its "Settings" heading keeps the top bar's start padding, never flush with the
 * screen's left edge. Run with `task proof:android -- app.penmoss.ui.SettingsHeadingInstrumentedTest`.
 *
 * Reads the screen through Compose's semantics tree, not the Compose test rule (see
 * [TooltipDelayInstrumentedTest]).
 */
@RunWith(AndroidJUnit4::class)
class SettingsHeadingInstrumentedTest {
    @Test
    fun settingsHeadingKeepsItsPaddingAtPhoneWidth() {
        val sections = listOf(
            SettingsSection("appearance", "Appearance", "Theme and fonts", SettingsIcons.Gear),
            SettingsSection("display", "Display", "Home and lists", SettingsIcons.Gear),
        )
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme { SettingsHome(sections, onOpen = {}, onBack = {}) }
                }
            }
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val density = instrumentation.targetContext.resources.displayMetrics.density
            var headings = emptyList<Rect>()
            val deadline = SystemClock.uptimeMillis() + 30_000
            do {
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity -> headings = boundsOf(activity.window.decorView, "Settings") }
                if (headings.isNotEmpty()) break
                SystemClock.sleep(250)
            } while (SystemClock.uptimeMillis() < deadline)
            assertTrue("no Settings heading on screen", headings.isNotEmpty())
            // The top bar's title keeps at least its 16dp start padding, never flush left.
            for (heading in headings) {
                assertTrue("heading at x=${heading.left}px, under ${16 * density}px", heading.left >= 16 * density - 1)
            }
            // The proof's screenshot, while Settings is on screen (A1255).
            ProofShot.take()
            // Held on screen a moment, so the proof's recording shows the heading.
            SystemClock.sleep(2_000)
        }
    }

    /** The window bounds of every laid-out Compose text node under [view] that reads [text]. */
    private fun boundsOf(view: View, text: String): List<Rect> {
        val roots = mutableListOf<ViewRootForTest>()
        fun walk(v: View) {
            if (v is ViewRootForTest) roots += v
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return roots.flatMap { root ->
            root.semanticsOwner.getAllSemanticsNodes(mergingEnabled = false)
                .filter { node -> node.config.getOrNull(SemanticsProperties.Text).orEmpty().any { it.text == text } }
                .map { it.boundsInWindow }
                .filter { it.width > 0f }
        }
    }
}
