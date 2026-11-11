package app.penmoss.ui

import android.accessibilityservice.AccessibilityServiceInfo
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.proof.ProofShot
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-71's Android proof (AC7): the web and Mac search dialog's Folder list now groups every
 * notebook's folders under All Notebooks. Android's search has no Notebook filter, and its Folder
 * sheet already lists every folder it has, so it is unchanged: the Folder chip opens "Search in"
 * with "All folders" and the folders. Run with
 * `task proof:android -- app.penmoss.ui.SearchFolderFilterInstrumentedTest`.
 *
 * The sheet is a window of its own, so this reads the screen through the accessibility tree
 * (UiAutomation), not the Compose test rule (see [TooltipDelayInstrumentedTest]).
 */
@RunWith(AndroidJUnit4::class)
class SearchFolderFilterInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun theFolderFilterListsAllFoldersAndTheFolders() {
        val choices = listOf(
            FolderChoice(null, "Top level", 0),
            FolderChoice("p", "Projects", 0),
            FolderChoice("pm", "Parser", 1, "Projects"),
            FolderChoice("a", "Archive", 0),
        )
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        SearchScreen(
                            "moss",
                            {},
                            SearchView(),
                            onBack = {},
                            onOpen = {},
                            folderChoices = choices,
                            tags = tagOptions(listOf("alpha")),
                        )
                    }
                }
            }
            // The Folder chip reads "All folders" until a folder is picked.
            val chip = waitFor("the Folder chip") { find("All folders").firstOrNull() }
            assertTrue("the Folder chip could not be clicked", clickable(chip)?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true)

            // The sheet: "Search in", then "All folders" and every folder.
            waitFor("the Search in sheet") { find("Search in").firstOrNull() }
            for (name in listOf("All folders", "Projects", "Parser", "Archive")) {
                assertNotNull("no $name in the sheet", waitFor(name) { find(name).firstOrNull() })
            }
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            // The proof's screenshot, while the sheet is on screen (A1255).
            ProofShot.take()
        }
    }

    /** The nodes on screen, in every window (the sheet has its own), whose text is [text]. */
    private fun find(text: String): List<AccessibilityNodeInfo> {
        instrumentation.waitForIdleSync()
        val automation = instrumentation.uiAutomation
        val info = automation.serviceInfo
        if (info.flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS == 0) {
            info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            automation.serviceInfo = info
        }
        val roots = automation.windows.mapNotNull { it.root } + listOfNotNull(automation.rootInActiveWindow)
        val found = mutableListOf<AccessibilityNodeInfo>()
        fun walk(node: AccessibilityNodeInfo) {
            if (node.text?.toString() == text || node.contentDescription?.toString() == text) found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let(::walk)
        }
        roots.forEach(::walk)
        return found
    }

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
