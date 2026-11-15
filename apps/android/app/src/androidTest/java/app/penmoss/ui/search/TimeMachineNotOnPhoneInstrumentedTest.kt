package app.penmoss.ui.search

import android.os.SystemClock
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.ScreenTree
import app.penmoss.proof.ProofShot
import app.penmoss.search.SearchActions
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.common.TooltipDelayInstrumentedTest
import app.penmoss.ui.keys.AndroidCommands
import app.penmoss.ui.keys.Coverage
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-21's Android proof: the Mac and web apps gain the Time Machine (a page, a command and
 * a notebook's button). Its first version is not on the phone, so Android is
 * unchanged: Search's actions for "time" are what they were, with no Time Machine among them, and
 * the command is listed as not on a phone. Run with
 * `task proof:android -- app.penmoss.ui.search.TimeMachineNotOnPhoneInstrumentedTest`.
 *
 * Reads the screen through Compose's semantics tree, not the Compose test rule (see
 * [TooltipDelayInstrumentedTest]).
 */
@RunWith(AndroidJUnit4::class)
class TimeMachineNotOnPhoneInstrumentedTest {
    @Test
    fun searchListsNoTimeMachineAction() {
        val query = "time"
        // What Search shows while typing: the best few (SHOWN), all on screen at once.
        val actions = SearchActions.matching(query).take(SearchActions.SHOWN)
        assertTrue("Search would offer the Time Machine", SearchActions.ALL.none { it.id == "app.timeMachine" })
        assertTrue(
            "the Time Machine is not listed as not on a phone",
            AndroidCommands.coverage("app.timeMachine", "global") is Coverage.NotHere,
        )
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        SearchScreen(
                            query,
                            {},
                            SearchView(),
                            onBack = {},
                            onOpen = {},
                            actions = actions,
                        )
                    }
                }
            }
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            var field = false
            val deadline = SystemClock.uptimeMillis() + 30_000
            do {
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity -> field = editableShows(activity.window.decorView, query) }
                if (field) break
                SystemClock.sleep(250)
            } while (SystemClock.uptimeMillis() < deadline)
            assertTrue("no Search field reading \"$query\"", field)
            var shown = emptyList<String>()
            scenario.onActivity { activity -> shown = ScreenTree.texts(activity.window.decorView) }
            for (action in actions) {
                assertTrue("Search's ${action.title} is not on screen", shown.contains(action.title))
            }
            assertTrue("a Time Machine on the phone's Search: $shown", shown.none { it == "Time Machine" })
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    /** Whether a text field under [view] reads [text]. */
    private fun editableShows(view: View, text: String): Boolean =
        ScreenTree.nodes(view).any { node -> node.config.getOrNull(SemanticsProperties.EditableText)?.text == text }
}
