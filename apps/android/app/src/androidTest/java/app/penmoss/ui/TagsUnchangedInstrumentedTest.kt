package app.penmoss.ui

import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.engine.notes.TagTree
import app.penmoss.proof.ProofShot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-68's Android proof: the Mac and web apps gain a Tags page where each tag is described, kept
 * in the notebook's WorkspaceDoc; Android has no new screen. Its Tags screen lists the tags as
 * before, nested under their parents with their counts, and shows no description field. That the
 * phone keeps the descriptions as it syncs is `GitCrossEngineTest`'s
 * `theMacsTagDescriptionsSurviveThePhonesSyncsAndItsOwnChanges` (engine-bridge, the engine page
 * the APK ships). Run with `task proof:android -- app.penmoss.ui.TagsUnchangedInstrumentedTest`.
 */
@RunWith(AndroidJUnit4::class)
class TagsUnchangedInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun theTagsScreenListsTagsAsBeforeWithNoDescriptionField() {
        val tree = TagTree.build(
            listOf(
                listOf("project/penmoss"),
                listOf("project/penmoss/android"),
                listOf("garden"),
                listOf("reading"),
            ),
        )
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        TagsScreen(tree, onBack = {}, onOpenTag = {}, onRename = {})
                    }
                }
            }
            assertNotNull(waitFor("#garden") { find("#garden, 1 note").firstOrNull() })
            assertNotNull(waitFor("#project") { find("#project, 2 notes").firstOrNull() })
            // Nested tags open under their parent, as before.
            for (tag in listOf("project", "project/penmoss")) {
                val twisty = waitFor("Expand #$tag") { find("Expand #$tag").firstOrNull() }
                assertTrue(clickable(twisty)?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true)
            }
            assertNotNull(waitFor("#project/penmoss/android") { find("#project/penmoss/android, 1 note").firstOrNull() })
            // No field to describe a tag on the phone: describing is the Mac's.
            assertEquals(0, editable().size)
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    private fun nodes(): List<AccessibilityNodeInfo> {
        instrumentation.waitForIdleSync()
        val root = instrumentation.uiAutomation.rootInActiveWindow ?: return emptyList()
        val found = mutableListOf<AccessibilityNodeInfo>()
        fun walk(node: AccessibilityNodeInfo) {
            found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let(::walk)
        }
        walk(root)
        return found
    }

    private fun find(text: String): List<AccessibilityNodeInfo> =
        nodes().filter { it.text?.toString() == text || it.contentDescription?.toString() == text }

    private fun editable(): List<AccessibilityNodeInfo> = nodes().filter { it.isEditable }

    /** [node] itself if it can be clicked, or its nearest ancestor that can. */
    private fun clickable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        var current = node
        while (current != null && !current.isClickable) current = current.parent
        return current
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
