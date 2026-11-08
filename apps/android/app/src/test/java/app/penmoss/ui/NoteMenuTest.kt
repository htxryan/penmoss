package app.penmoss.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.bridge.CopyFormat
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * The note's ⋮ menu (T51, A937): the web's groups with the phone's own tools, Find in Note and
 * Word Count. Tags are in the Metadata tab and Send Feedback in Home's ⋮ and Settings → About.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NoteMenuTest {
    @get:Rule
    val compose = createComposeRule()

    private fun items() = compose.onAllNodes(hasClickAction() and hasAnyAncestor(isPopup())).fetchSemanticsNodes()
        .map { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty() }

    @Test
    fun theMenuListsTheNotesActionsInTheWebsGroups() {
        compose.setContent {
            PenmossTheme { NoteMenu(open = true, onOpen = {}, ready = true, onPanel = {}, pinned = false, openComments = 3) }
        }
        assertEquals(
            listOf(
                "View Metadata", "Comments3", "Version History", "Local Graph", "Markdown Source",
                "Copy Note as Markdown", "Copy Note as Rich Text",
                "Find in Note", "Word Count",
                "Pin to Quick Access", "Move to Folder…", "Move to Trash",
            ),
            items(),
        )
        compose.onNodeWithText("Tags…").assertDoesNotExist()
        compose.onNodeWithText("Send Feedback").assertDoesNotExist()
        compose.onNodeWithText("Send Feedback").assertDoesNotExist()
    }

    /** Copy Agent Reference (T52 item 4) is the copies' third, and does its action. */
    @Test
    fun copyAgentReferenceIsWithTheCopies() {
        var copied = 0
        var closed = false
        compose.setContent {
            PenmossTheme {
                NoteMenu(open = true, onOpen = { if (!it) closed = true }, ready = true, onPanel = {}, pinned = false, onCopyAgentReference = { copied++ })
            }
        }
        val shown = items()
        assertEquals(shown.indexOf("Copy Note as Rich Text") + 1, shown.indexOf("Copy Agent Reference"))
        assertEquals(shown.indexOf("Find in Note") - 1, shown.indexOf("Copy Agent Reference"))
        compose.onNodeWithTag("noteCopyAgentReference").performScrollTo().performClick()
        assertEquals(1, copied)
        assertEquals(true, closed)
    }

    /** A git notebook's note is not offered Quick Access (its pins are the personal notes'). */
    @Test
    fun aNoteWithoutQuickAccessIsNotOfferedIt() {
        compose.setContent { PenmossTheme { NoteMenu(open = true, onOpen = {}, ready = true, onPanel = {}, pinned = null) } }
        assertEquals(false, items().any { it.contains("Quick Access") })
    }

    @Test
    fun eachItemDoesItsActionAndClosesTheMenu() {
        val panels = mutableListOf<PanelTab>()
        val copies = mutableListOf<CopyFormat>()
        val events = mutableListOf<String>()
        var source by mutableStateOf(false)
        var pinned by mutableStateOf(false)
        var closes = 0
        compose.setContent {
            PenmossTheme {
                NoteMenu(
                    open = true,
                    onOpen = { if (!it) closes++ },
                    ready = true,
                    onPanel = { panels += it },
                    source = source,
                    onSource = { events += "source:$it" },
                    onCopy = { copies += it },
                    onFind = { events += "find" },
                    onCount = { events += "count" },
                    pinned = pinned,
                    onPin = { events += "pin" },
                    onMove = { events += "move" },
                    onTrash = { events += "trash" },
                )
            }
        }
        for (tag in listOf("noteMetadata", "noteComments", "noteHistory", "noteLocalGraph")) compose.onNodeWithTag(tag).performScrollTo().performClick()
        assertEquals(listOf(PanelTab.METADATA, PanelTab.COMMENTS, PanelTab.HISTORY, PanelTab.GRAPH), panels)
        // The menu scrolls on a small screen: each item is brought into view first.
        compose.onNodeWithText("Markdown Source").performScrollTo().assertIsNotSelected().performClick()
        source = true
        compose.onNodeWithText("Markdown Source").performScrollTo().assertIsSelected().performClick()
        compose.onNodeWithText("Copy Note as Markdown").performScrollTo().performClick()
        compose.onNodeWithText("Copy Note as Rich Text").performScrollTo().performClick()
        compose.onNodeWithText("Find in Note").performScrollTo().performClick()
        compose.onNodeWithText("Word Count").performScrollTo().performClick()
        compose.onNodeWithText("Pin to Quick Access").performScrollTo().performClick()
        pinned = true
        compose.onNodeWithText("Unpin from Quick Access").performScrollTo().performClick()
        compose.onNodeWithTag("noteMove").performScrollTo().performClick()
        compose.onNodeWithTag("noteTrash").performScrollTo().performClick()
        assertEquals(listOf(CopyFormat.MARKDOWN, CopyFormat.RICH), copies)
        assertEquals(listOf("source:true", "source:false", "find", "count", "pin", "pin", "move", "trash"), events)
        assertEquals(14, closes)
    }

    /** The editor's tools, Version History and Move to Trash wait for the note to open. */
    @Test
    fun theToolsWaitForTheNote() {
        compose.setContent { PenmossTheme { NoteMenu(open = true, onOpen = {}, ready = false, onPanel = {}) } }
        for (tag in listOf("noteCopyMarkdown", "noteFind", "noteHistory", "noteSource", "noteTrash")) {
            compose.onNode(hasTestTag(tag)).assertIsNotEnabled()
        }
    }
}
