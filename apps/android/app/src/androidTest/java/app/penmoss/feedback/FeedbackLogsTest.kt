package app.penmoss.feedback

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.ScreenTree
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Send Feedback on the phone (PEN-137, AC7): a bug report's form has its Description, its
 * "Captured Context" (Title Case), and Attach Anonymised Logs ticked, with how many lines and how
 * big, and the exact text attached. Run with
 * `task proof:android -- app.penmoss.feedback.FeedbackLogsTest`.
 */
@RunWith(AndroidJUnit4::class)
class FeedbackLogsTest {
    private val logs = listOf(
        "2026-11-19T11:54:16.525Z info Sync pass ok in 120 ms",
        "2026-11-19T11:54:17.001Z warn PenmossGit push to ‹repo-1› refused: ‹token›",
        "  java.io.IOException: timeout",
        "    at app.penmoss.git.GitNotebookHub.push(GitNotebookHub.kt:512)",
    )

    @Test
    fun aBugReportAttachesItsAnonymisedLogsTicked() {
        val ui = FeedbackUi(
            draft = FeedbackDraft("01JBXYZ0000000000000000001", type = "bug", priority = 2, title = "Sync stops", description = "It stopped after a push."),
            context = FeedbackContextData(listOf(fieldGroup(FeedbackGroupId.APP, listOf("Client" to "Android", "Version" to "0.40 (build 440)")))),
            logs = logs,
        )
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent { PenmossTheme { FeedbackScreen(ui, FeedbackActions()) } } }
            val size = FeedbackLogs.formatReportSize(FeedbackLogs.textBytes(logs))
            val summary = "Anonymised Logs · 4 lines · $size"
            var texts = emptyList<String>()
            val deadline = SystemClock.uptimeMillis() + 30_000
            do {
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity -> texts = ScreenTree.texts(activity.window.decorView) }
                if (summary in texts) break
                SystemClock.sleep(250)
            } while (SystemClock.uptimeMillis() < deadline)
            for (text in listOf("Description", "Captured Context", "Attach Anonymised Logs", summary)) assertTrue("$text is not on screen: $texts", text in texts)
            assertTrue("Captured context" !in texts)

            // Ticked for a bug (O6); the exact lines shown once opened, scrolled into view.
            scenario.onActivity { activity ->
                val nodes = ScreenTree.nodes(activity.window.decorView)
                val box = nodes.single { it.config.getOrNull(SemanticsProperties.TestTag) == "feedbackLogs" }
                assertEquals(ToggleableState.On, box.config.getOrNull(SemanticsProperties.ToggleableState))
                nodes.single { it.config.getOrNull(SemanticsProperties.TestTag) == "feedbackLogsToggle" }.config[SemanticsActions.OnClick].action?.invoke()
            }
            var shown: SemanticsNode? = null
            val opened = SystemClock.uptimeMillis() + 10_000
            do {
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    shown = ScreenTree.nodes(activity.window.decorView).firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == "feedbackLogsText" }
                    shown?.let { scrollIntoView(it) }
                }
                if (shown != null) break
                SystemClock.sleep(250)
            } while (SystemClock.uptimeMillis() < opened)
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                val text = ScreenTree.nodes(activity.window.decorView).single { it.config.getOrNull(SemanticsProperties.TestTag) == "feedbackLogsText" }
                assertEquals(logs.joinToString("\n"), text.config.getOrNull(SemanticsProperties.Text).orEmpty().joinToString("") { it.text })
            }
            // Held before the shot, the logs box on screen (A1255, A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    /** Scrolls the form so [node] sits in the upper part of the window. */
    private fun scrollIntoView(node: SemanticsNode) {
        var parent = node.parent
        while (parent != null && parent.config.getOrNull(SemanticsActions.ScrollBy) == null) parent = parent.parent
        val scroller = parent ?: return
        val by = node.boundsInWindow.top - scroller.boundsInWindow.top - scroller.boundsInWindow.height / 4
        if (by > 0) scroller.config[SemanticsActions.ScrollBy].action?.invoke(0f, by)
    }
}
