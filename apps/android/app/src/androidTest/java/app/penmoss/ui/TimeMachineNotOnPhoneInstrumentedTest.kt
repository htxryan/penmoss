package app.penmoss.ui

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.proof.ProofShot
import app.penmoss.search.SearchActions
import app.penmoss.ui.keys.AndroidCommands
import app.penmoss.ui.keys.Coverage
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-21's Android proof: the Mac and web apps gain the Time Machine (a page, a command, a
 * notebook's button and History's Replay). Its first version is not on the phone, so Android is
 * unchanged: Search's actions for "time" are what they were, with no Time Machine among them, and
 * the command is listed as not on a phone. Run with
 * `task proof:android -- app.penmoss.ui.TimeMachineNotOnPhoneInstrumentedTest`.
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
            scenario.onActivity { activity -> shown = texts(activity.window.decorView) }
            for (action in actions) {
                assertTrue("Search's ${action.title} is not on screen", shown.contains(action.title))
            }
            assertTrue("a Time Machine on the phone's Search: $shown", shown.none { it == "Time Machine" })
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    private fun roots(view: View): List<ViewRootForTest> {
        val found = mutableListOf<ViewRootForTest>()
        fun walk(v: View) {
            if (v is ViewRootForTest) found += v
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return found
    }

    /** Every Compose text on screen under [view]. */
    private fun texts(view: View): List<String> = roots(view).flatMap { root ->
        root.semanticsOwner.getAllSemanticsNodes(mergingEnabled = false)
            .flatMap { node -> node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } }
    }

    /** Whether a text field under [view] reads [text]. */
    private fun editableShows(view: View, text: String): Boolean = roots(view).any { root ->
        root.semanticsOwner.getAllSemanticsNodes(mergingEnabled = false)
            .any { node -> node.config.getOrNull(SemanticsProperties.EditableText)?.text == text }
    }
}
