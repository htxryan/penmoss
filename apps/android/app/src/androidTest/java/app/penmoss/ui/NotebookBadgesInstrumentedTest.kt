package app.penmoss.ui

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.engine.settings.NotebookBadges
import app.penmoss.git.GitNotebooksActions
import app.penmoss.git.GitNotebooksScreen
import app.penmoss.git.GitNotebooksUi
import app.penmoss.git.GitRow
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.PenmossTheme
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A1579's Android proof: the first screen lists the notebooks with their badges, as the Mac's
 * sidebar shows them: a letter on the notebook's default colour, a Lucide icon, an icon from
 * before Lucide drawn as its twin, and the letter for an icon this build lacks. Run with
 * `task proof:android -- app.penmoss.ui.NotebookBadgesInstrumentedTest`. Reads the screen through
 * Compose's semantics tree, as [NoteOpensWithoutTabsInstrumentedTest] does.
 */
@RunWith(AndroidJUnit4::class)
class NotebookBadgesInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun view(n: Int, name: String) = GitNotebookView(
        localId = "local-$n",
        notebookId = "01JD000000000000000000000$n",
        name = name,
        create = false,
        remote = "https://github.com/htxryan/$n",
        repository = "github.com/htxryan/notes-$n",
        host = "github.com",
        branch = "main",
        dir = "",
        pushDelayS = 60,
        pullEveryMin = 2,
        wifiOnly = false,
        hasToken = true,
    )

    private fun row(view: GitNotebookView, color: String? = null, kind: String? = null, value: String? = null): GitRow {
        val settings = buildMap {
            if (color != null) put(NotebookBadges.COLOR, JsonPrimitive(color))
            if (kind != null && value != null) put(NotebookBadges.GLYPH, JsonObject(mapOf("kind" to JsonPrimitive(kind), "value" to JsonPrimitive(value))))
        }
        return GitRow(view, null, badge = NotebookBadges.badgeOf(view.notebookId, view.name, settings))
    }

    @Test
    fun theFirstScreenShowsEachNotebooksBadge() {
        LucideAssets.icons(instrumentation.targetContext)
        val rows = listOf(
            row(view(1, "Personal")),
            row(view(2, "Work"), "teal", "icon", "lucide:rocket"),
            row(view(3, "Garden"), "#f5d76e", "icon", "branch"),
            row(view(4, "Reading"), "violet", "number", "42"),
        )
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme { GitNotebooksScreen(GitNotebooksUi(rows = rows, home = true), GitNotebooksActions(), onBack = {}) }
                }
            }
            waitFor("the notebooks' badges") { nodes(scenario).count { it.tag() == "notebook-badge" }.takeIf { it == 4 } }
            val all = nodes(scenario)
            assertTrue("no rocket on Work's badge", all.any { it.tag() == "notebook-badge-icon-rocket" })
            assertTrue("no git-branch on Garden's badge", all.any { it.tag() == "notebook-badge-icon-git-branch" })
            val letters = all.filter { it.tag() == "notebook-badge-text" }.flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty().map { text -> text.text } }
            assertEquals(listOf("P", "42"), letters)
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    private fun SemanticsNode.tag(): String? = config.getOrNull(SemanticsProperties.TestTag)

    /** Every laid-out Compose semantics node on screen now. */
    private fun nodes(scenario: ActivityScenario<ComponentActivity>): List<SemanticsNode> {
        instrumentation.waitForIdleSync()
        var found = emptyList<SemanticsNode>()
        scenario.onActivity { activity ->
            val roots = mutableListOf<ViewRootForTest>()
            fun walk(v: View) {
                if (v is ViewRootForTest) roots += v
                if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
            }
            walk(activity.window.decorView)
            found = roots.flatMap { root ->
                root.semanticsOwner.getAllSemanticsNodes(mergingEnabled = false).filter { it.boundsInWindow.width > 0f }
            }
        }
        return found
    }

    private fun <T : Any> waitFor(what: String, read: () -> T?): T {
        val deadline = SystemClock.uptimeMillis() + 30_000
        do {
            read()?.let { return it }
            SystemClock.sleep(250)
        } while (SystemClock.uptimeMillis() < deadline)
        throw AssertionError("no $what on screen")
    }
}
