package app.penmoss.ui

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.data.NoteListRow
import app.penmoss.editor.EditorUiState
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.IconButton
import app.penmoss.ui.common.Items
import app.penmoss.ui.common.NoteList
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.folders.BreadcrumbBar
import app.penmoss.ui.note.InfoButton
import app.penmoss.ui.note.NoteBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PEN-140's Android proof (AC15): the web and Mac apps' main window gained note tabs and notebook
 * badges, and the note lost its title row there. Android keeps its own screens and the system
 * Back (D44, A715), so a note opened from the list fills the screen under its own top bar, with no
 * tab strip, no Tabs button and no notebook badge. The phone's badges (A1579) are on its notebooks'
 * rows and pages, as the Mac's sidebar and Settings have them, not on a note's screen. Run with
 * `task proof:android -- app.penmoss.ui.NoteOpensWithoutTabsInstrumentedTest`.
 *
 * Built from the app's own pieces (the note list's rows, the note screen's top bar parts and its
 * body), as the other proofs here are. Reads the screen through Compose's semantics tree, not the
 * Compose test rule: the rule's Espresso link doesn't start on the API 37 emulator (see
 * [SnackbarStyleInstrumentedTest]).
 */
@RunWith(AndroidJUnit4::class)
class NoteOpensWithoutTabsInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @OptIn(ExperimentalMaterial3Api::class)
    @Test
    fun aNoteOpensFullScreenWithNoTabsAndNoBadge() {
        val now = System.currentTimeMillis()
        val rows = listOf(
            NoteListRow(MEETING, "Meeting Notes", "Agenda for Thursday, and who brings what", now - 60_000L, null, "a0"),
            NoteListRow("note-2", "Reading List", "Books to find at the library", now - 120_000L, null, "a1"),
            NoteListRow("note-3", "Garden Plan", "Where the beans go this year", now - 180_000L, null, "a2"),
        )
        val items = Items.notes(rows, now = now)
        var open by mutableStateOf<String?>(null)
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        val shown = open
                        if (shown == null) {
                            NoteList(items, onOpen = { open = it })
                        } else {
                            val title = rows.first { it.id == shown }.title
                            // As the note screen shows a note (NoteRoute): its top bar with Back, the
                            // folder path and the notebook's name, then the note's body.
                            Scaffold(
                                topBar = {
                                    TopAppBar(
                                        // A top-level note names its notebook, as NoteRoute's bar does (T52).
                                        title = { BreadcrumbBar(path = emptyList(), onOpenFolder = {}, notebook = "Personal") },
                                        navigationIcon = {
                                            IconButton(onClick = { open = null }) {
                                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                                            }
                                        },
                                        actions = { InfoButton(linked = 0, onClick = {}) },
                                    )
                                },
                            ) { padding ->
                                androidx.compose.foundation.layout.Box(Modifier.padding(padding)) {
                                    NoteBody(
                                        state = EditorUiState(phase = EditorUiState.Phase.READY, title = title),
                                        editorAlive = true,
                                        onRetry = {},
                                    ) { _ ->
                                        androidx.compose.foundation.layout.Column(Modifier.padding(16.dp)) {
                                            Text(title)
                                            Text("Agenda for Thursday, and who brings what.")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // The list, then a tap on Meeting Notes opens it.
            val row = waitFor("the note list") { nodes(scenario).firstOrNull { it.texts().contains("Meeting Notes") } }
            var tapped = false
            scenario.onActivity {
                var node: SemanticsNode? = row
                while (node != null && node.config.getOrNull(SemanticsActions.OnClick) == null) node = node.parent
                tapped = node?.config?.getOrNull(SemanticsActions.OnClick)?.action?.invoke() == true
            }
            assertTrue("the Meeting Notes row could not be tapped", tapped)
            assertEquals(MEETING, open)

            // The note, on a screen of its own: its text under the top bar with Back.
            val body = waitFor("the note's text") {
                nodes(scenario).firstOrNull { it.texts().contains("Agenda for Thursday, and who brings what.") }
            }
            assertTrue("no Back in the note's top bar", nodes(scenario).any { it.descriptions().contains("Back") })
            // The list is gone: the note fills the screen, not one pane among others.
            assertTrue("the list still shows beside the note", nodes(scenario).none { it.texts().contains("Reading List") })
            val screenWidth = instrumentation.targetContext.resources.displayMetrics.widthPixels
            assertTrue("the note is ${body.boundsInWindow.width}px of a $screenWidth px screen", body.boundsInWindow.right <= screenWidth + 1)

            // No tabs on Android (PEN-140, open points 14 and 15), and no badge on a note's screen (A1579).
            val all = nodes(scenario)
            for (word in listOf("New Tab", "Tabs", "Close Tab", "All Tabs")) {
                assertEquals("“$word” shows on the phone", 0, all.count { word in it.texts() || word in it.descriptions() })
            }
            for (tag in listOf("tab-strip", "tabs-button", "notebook-badge")) {
                assertEquals("$tag shows on the phone", 0, all.count { it.config.getOrNull(SemanticsProperties.TestTag) == tag })
            }
            assertEquals("a tab role shows on the phone", 0, all.count { it.config.getOrNull(SemanticsProperties.Role)?.toString() == "Tab" })

            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            // The proof's screenshot, while the note is on screen (A1255).
            ProofShot.take()
        }
    }

    private fun SemanticsNode.texts(): List<String> =
        config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text }

    private fun SemanticsNode.descriptions(): List<String> =
        config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()

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

    private companion object {
        const val MEETING = "note-1"
    }
}
