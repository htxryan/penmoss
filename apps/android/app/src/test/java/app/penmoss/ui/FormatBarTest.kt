package app.penmoss.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.TextField
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.editor.FormatState
import app.penmoss.engine.bridge.FormatCommand
import app.penmoss.engine.settings.LineSymbols
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** The formatting bar above the keyboard (T33, A301), on Robolectric. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FormatBarTest {
    @get:Rule
    val compose = createComposeRule()

    private val commands = mutableListOf<FormatCommand>()
    private var links = 0
    private var pictures = 0

    private fun selected(on: Boolean) = SemanticsMatcher.expectValue(SemanticsProperties.Selected, on)

    private fun bar(state: FormatState) {
        compose.setContent {
            PenmossTheme {
                FormatBar(state, onCommand = { commands += it }, onLink = { links++ }, onPicture = { pictures++ })
            }
        }
    }

    @Test
    fun theBarGoesWhileTheCaretIsInTheTitle() {
        // T39 pass 1's proposal 5, settled in pass 3 (A554): the buttons act on the text only.
        assertTrue(showsFormatBar(editable = true, source = false, FormatState()))
        assertFalse(showsFormatBar(editable = true, source = false, FormatState(inTitle = true)))
        assertFalse(showsFormatBar(editable = true, source = true, FormatState()))
        assertFalse(showsFormatBar(editable = false, source = false, FormatState()))
    }

    @Test
    fun theSymbolMenuTicksTheLinesSymbolsTogglesOneAndOpensSettings() {
        // T44 (A747): the person's symbols, ticked when every selected line has one.
        val toggled = mutableListOf<Int>()
        var edits = 0
        compose.setContent {
            PenmossTheme {
                FormatBar(
                    FormatState(symbols = setOf(0), canSymbol = true),
                    onCommand = { commands += it },
                    onLink = {},
                    onPicture = {},
                    symbols = LineSymbols.DEFAULTS,
                    onSymbol = { toggled += it },
                    onEditSymbols = { edits++ },
                )
            }
        }
        compose.onNodeWithContentDescription("Symbol").performScrollTo().assert(selected(true)).performClick()
        compose.onNodeWithTag("symbol-0").assert(selected(true))
        compose.onNodeWithTag("symbol-1").assert(selected(false))
        // Each goes by its glyph, in its colour, not its name (T51, A940).
        compose.onNodeWithTag("symbol-2").assertTextContains("!")
        compose.onNodeWithText("Follow-up").assertDoesNotExist()
        compose.onNodeWithTag("symbol-2").performClick()
        assertEquals(listOf(2), toggled)
        compose.onNodeWithContentDescription("Symbol").performClick()
        compose.onNodeWithTag("symbol-edit").performClick()
        assertEquals(1, edits)
        // Nothing in the note was formatted on the way.
        assertEquals(emptyList<FormatCommand>(), commands)
    }

    @Test
    fun theSymbolButtonIsOffWhereNoLineMayHaveOne() {
        compose.setContent {
            PenmossTheme {
                FormatBar(FormatState(canSymbol = false), onCommand = {}, onLink = {}, onPicture = {}, symbols = LineSymbols.DEFAULTS, onSymbol = {})
            }
        }
        compose.onNodeWithContentDescription("Symbol").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun eachButtonRunsItsCommand() {
        bar(FormatState(canUndo = true, canRedo = true, canIndent = true, canOutdent = true))
        for (label in listOf("Bold", "Italic", "Inline Code", "Bulleted List", "Numbered List", "Checklist", "Outdent", "Indent", "Undo", "Redo")) {
            compose.onNodeWithContentDescription(label).performScrollTo().performClick()
        }
        assertEquals(
            listOf(
                FormatCommand.BOLD,
                FormatCommand.ITALIC,
                FormatCommand.CODE,
                FormatCommand.BULLET_LIST,
                FormatCommand.ORDERED_LIST,
                FormatCommand.TASK_LIST,
                FormatCommand.OUTDENT,
                FormatCommand.INDENT,
                FormatCommand.UNDO,
                FormatCommand.REDO,
            ),
            commands,
        )
        compose.onNodeWithContentDescription("Link").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Add a Picture").performScrollTo().performClick()
        assertEquals(1, links)
        assertEquals(1, pictures)
    }

    @Test
    fun showsWhatIsOnAndWhatCannotBeDone() {
        bar(FormatState(active = setOf(FormatCommand.BOLD, FormatCommand.TASK_LIST)))
        compose.onNodeWithContentDescription("Bold").assert(selected(true))
        compose.onNodeWithContentDescription("Italic").assert(selected(false))
        compose.onNodeWithContentDescription("Checklist").performScrollTo().assert(selected(true))
        compose.onNodeWithContentDescription("Undo").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithContentDescription("Indent").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithContentDescription("Undo").performClick()
        assertEquals(emptyList<FormatCommand>(), commands)
    }

    @Test
    fun theStyleMenuTurnsTheBlockIntoAHeadingAndShowsTheCurrentOne() {
        bar(FormatState(active = setOf(FormatCommand.HEADING2)))
        compose.onNodeWithContentDescription("Text Style").assert(selected(true)).performClick()
        compose.onNodeWithText("Heading 2").assert(selected(true))
        compose.onNodeWithText("Heading 1").performClick()
        assertEquals(listOf(FormatCommand.HEADING1), commands)
        // The menu closed.
        compose.onNodeWithText("Heading 3").assertDoesNotExist()
    }

    @Test
    fun theButtonsNeverTakeTheFocusFromTheNote() {
        compose.setContent {
            PenmossTheme {
                Column {
                    var text by remember { mutableStateOf("") }
                    TextField(text, { text = it }, Modifier.testTag("note"))
                    FormatBar(FormatState(canUndo = true), onCommand = { commands += it }, onLink = {}, onPicture = {})
                }
            }
        }
        compose.onNodeWithTag("note").performClick().assertIsFocused()
        compose.onNodeWithContentDescription("Bold").performClick()
        compose.onNodeWithContentDescription("Undo").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Text Style").performScrollTo().performClick()
        compose.onNodeWithText("Quote").performClick()
        compose.onNodeWithTag("note").assertIsFocused()
        assertEquals(listOf(FormatCommand.BOLD, FormatCommand.UNDO, FormatCommand.BLOCKQUOTE), commands)
    }

    @Test
    fun theLinkDialogEditsRemovesOrAddsAnAddress() {
        val applied = mutableListOf<String>()
        var dismissed = 0
        val current = "https://penmoss.app"
        compose.setContent {
            PenmossTheme { LinkDialog(current, onApply = { applied += it }, onDismiss = { dismissed++ }) }
        }
        compose.onNodeWithText("Edit the link").assertExists()
        compose.onNodeWithTag("link-address").performTextReplacement("example.com/page")
        compose.onNodeWithText("Link").assertIsEnabled().performClick()
        compose.onNodeWithText("Remove Link").performClick()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(listOf("example.com/page", ""), applied)
        assertEquals(1, dismissed)
        compose.onNodeWithTag("link-address").performTextReplacement(" ")
        compose.onNodeWithText("Link").assertIsNotEnabled()
    }
}
