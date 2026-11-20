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

            // Ticked for a bug (O6). The proof holds on the box and its summary first.
            scenario.onActivity { activity ->
                val nodes = ScreenTree.nodes(activity.window.decorView)
                val box = nodes.single { it.config.getOrNull(SemanticsProperties.TestTag) == "feedbackLogs" }
                assertEquals(ToggleableState.On, box.config.getOrNull(SemanticsProperties.ToggleableState))
                scrollIntoView(box)
            }
            instrumentation.waitForIdleSync()
            SystemClock.sleep(1_500)

            // Then opens the preview: the exact lines, in the monospace block.
            scenario.onActivity { activity ->
                ScreenTree.nodes(activity.window.decorView).single { it.config.getOrNull(SemanticsProperties.TestTag) == "feedbackLogsToggle" }
                    .config[SemanticsActions.OnClick].action?.invoke()
            }
            val opened = SystemClock.uptimeMillis() + 10_000
            var inSight = false
            var seen = "no block"
            do {
                instrumentation.waitForIdleSync()
                SystemClock.sleep(250)
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    val block = ScreenTree.nodes(activity.window.decorView).firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == "feedbackLogsText" }
                    if (block != null) {
                        // Laid out at its full height: bring the whole block into the form's view.
                        val view = scroller(block)?.boundsInWindow
                        // Its unclipped place: boundsInWindow is Rect.Zero while it is below the fold.
                        val top = block.positionInWindow.y
                        val bottom = top + block.size.height
                        inSight = view != null && top >= view.top && bottom <= view.bottom
                        seen = "block $top..$bottom in $view"
                        if (!inSight) scrollIntoView(block)
                    }
                }
            } while (!inSight && SystemClock.uptimeMillis() < opened)
            assertTrue("the logs' block is not in sight: $seen", inSight)
            scenario.onActivity { activity ->
                val text = ScreenTree.nodes(activity.window.decorView).single { it.config.getOrNull(SemanticsProperties.TestTag) == "feedbackLogsText" }
                assertEquals(logs.joinToString("\n"), text.config.getOrNull(SemanticsProperties.Text).orEmpty().joinToString("") { it.text })
                // The lines themselves are shown in the monospace face.
                val layout = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
                text.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layout)
                assertEquals(androidx.compose.ui.text.font.FontFamily.Monospace, layout.single().layoutInput.style.fontFamily)
            }
            // Held on the opened lines before the shot (A1255, A1279).
            SystemClock.sleep(2_500)
            ProofShot.take()
        }
    }

    /** The scrolling container [node] sits in. */
    private fun scroller(node: SemanticsNode): SemanticsNode? {
        var parent = node.parent
        while (parent != null && parent.config.getOrNull(SemanticsActions.ScrollBy) == null) parent = parent.parent
        return parent
    }

    /**
     * Scrolls the form so [node] sits in the upper part of the window. It reads the node's unclipped
     * position, since its boundsInWindow is clipped to the window, and Rect.Zero when out of sight.
     */
    private fun scrollIntoView(node: SemanticsNode) {
        val scroller = scroller(node) ?: return
        val by = node.positionInWindow.y - scroller.boundsInWindow.top - scroller.boundsInWindow.height / 4
        if (by > 0) scroller.config[SemanticsActions.ScrollBy].action?.invoke(0f, by)
    }
}
