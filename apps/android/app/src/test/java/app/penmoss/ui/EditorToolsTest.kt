package app.penmoss.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.editor.BlockChoices
import app.penmoss.editor.FormatState
import app.penmoss.editor.NoteCounts
import app.penmoss.engine.bridge.BlockAction
import app.penmoss.engine.bridge.BlockEntry
import app.penmoss.engine.bridge.BlockPurpose
import app.penmoss.engine.bridge.CopyFormat
import app.penmoss.engine.bridge.FormatCommand
import app.penmoss.engine.bridge.TextCounts
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** The note screen's editor tools (T40 P8): the find bar, the sheets, the Block menu, the menu items. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EditorToolsTest {
    @get:Rule
    val compose = createComposeRule()

    /** The WebView's find, played by the test: it counts 12 matches of anything. */
    private class FakeFind : FindTarget {
        val queries = mutableListOf<String>()
        val moves = mutableListOf<Boolean>()
        var cleared = 0
        var listener: ((Int, Int, Boolean) -> Unit)? = null

        override fun find(query: String) {
            queries += query
            listener?.invoke(0, if (query.isEmpty()) 0 else 12, true)
        }

        override fun next(forward: Boolean) {
            moves += forward
            listener?.invoke(if (forward) 1 else 0, 12, true)
        }

        override fun clear() {
            cleared++
        }

        override fun listen(listener: ((Int, Int, Boolean) -> Unit)?) {
            this.listener = listener
        }
    }

    @Test
    fun findsInTheNoteAndMovesBetweenMatches() {
        val find = FakeFind()
        var closed = 0
        compose.setContent { PenmossTheme { FindBar(find, onClose = { closed++ }) } }
        compose.onNodeWithTag("findNext").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Find in note").assertExists()
        compose.onNodeWithTag("findQuery").performTextInput("bed")
        compose.waitForIdle()
        assertEquals("bed", find.queries.last())
        compose.onNodeWithTag("findCount").assertTextEquals("1 of 12")
        compose.onNodeWithTag("findNext").assertIsEnabled().performClick()
        compose.onNodeWithTag("findCount").assertTextEquals("2 of 12")
        compose.onNodeWithTag("findPrevious").performClick()
        assertEquals(listOf(true, false), find.moves)
        compose.onNodeWithTag("findClose").performClick()
        assertEquals(1, closed)
    }

    @Test
    fun clearsTheHighlightsWhenTheBarGoes() {
        val find = FakeFind()
        var shown by androidx.compose.runtime.mutableStateOf(true)
        compose.setContent { PenmossTheme { if (shown) FindBar(find, onClose = {}) } }
        compose.onNodeWithTag("findQuery").performTextInput("x")
        compose.waitForIdle()
        shown = false
        compose.waitForIdle()
        assertEquals(1, find.cleared)
        assertEquals(null, find.listener)
    }

    @Test
    fun findsAgainWhenTheNoteChanges() {
        // Edits arriving from elsewhere: the count is taken again (review nit).
        val find = FakeFind()
        var refresh by androidx.compose.runtime.mutableStateOf(0)
        compose.setContent { PenmossTheme { FindBar(find, onClose = {}, refresh = refresh) } }
        compose.onNodeWithTag("findQuery").performTextInput("bed")
        compose.waitForIdle()
        val before = find.queries.size
        refresh = 1
        compose.waitForIdle()
        assertEquals(before + 1, find.queries.size)
        assertEquals("bed", find.queries.last())
    }

    @Test
    fun labelsMatchesAsTheWebsFindDoes() {
        assertEquals("", findLabel("", 0, 0))
        assertEquals("No matches", findLabel("zz", 0, 0))
        assertEquals("3 of 12", findLabel("a", 2, 12))
    }

    @Test
    fun theInsertSheetSearchesThroughThePageAndInsertsAChoice() {
        val queries = mutableListOf<String>()
        val picked = mutableListOf<String>()
        var choices by androidx.compose.runtime.mutableStateOf<BlockChoices?>(null)
        compose.setContent {
            PenmossTheme {
                BlockSheet(
                    BlockPurpose.INSERT,
                    choices,
                    onQuery = { queries += it },
                    onPick = { picked += it.id },
                    onDismiss = {},
                )
            }
        }
        compose.waitForIdle()
        assertEquals(listOf(""), queries)
        compose.onNodeWithTag("blockSearch").performTextInput("tab")
        compose.waitForIdle()
        assertEquals("tab", queries.last())
        // An answer for an older search is not shown as this one's.
        choices = BlockChoices(BlockPurpose.INSERT, "", listOf(BlockEntry("paragraph", "Text", "T")))
        compose.waitForIdle()
        compose.onNodeWithTag("block-paragraph").assertDoesNotExist()
        choices = BlockChoices(BlockPurpose.INSERT, "tab", listOf(BlockEntry("table", "Table", "▦", "| a | b |")))
        compose.onNodeWithText("| a | b |").assertExists()
        // TalkBack reads "Table", not the glyph and the Markdown punctuation (review nit).
        compose.onNodeWithText("| a | b |", useUnmergedTree = true)
            .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.HideFromAccessibility))
        compose.onNodeWithText("▦", useUnmergedTree = true)
            .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.HideFromAccessibility))
        compose.onNodeWithTag("block-table").performClick()
        assertEquals(listOf("table"), picked)
    }

    @Test
    fun turnIntoMarksTheCurrentKindAndSaysWhenNothingApplies() {
        var choices by androidx.compose.runtime.mutableStateOf<BlockChoices?>(
            BlockChoices(
                BlockPurpose.TURN_INTO,
                "",
                listOf(BlockEntry("paragraph", "Text", "T", active = true), BlockEntry("heading1", "Heading 1", "H1", "# ", active = false)),
            ),
        )
        compose.setContent { PenmossTheme { BlockSheet(BlockPurpose.TURN_INTO, choices, onQuery = {}, onPick = {}, onDismiss = {}) } }
        compose.onNodeWithText("Turn into").assertExists()
        compose.onNodeWithTag("block-paragraph").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        compose.onNodeWithTag("block-heading1").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        choices = BlockChoices(BlockPurpose.TURN_INTO, "", emptyList())
        compose.onNodeWithTag("blockNone").assertTextEquals("This can't be turned into another kind here.")
    }

    @Test
    fun theBarHasPlusTheBlockMenuAndTableButtonsInATable() {
        val commands = mutableListOf<FormatCommand>()
        val actions = mutableListOf<BlockAction>()
        var inserts = 0
        var turns = 0
        var state by androidx.compose.runtime.mutableStateOf(FormatState(canMoveDown = true, canTurnInto = true))
        compose.setContent {
            PenmossTheme {
                FormatBar(
                    state,
                    onCommand = { commands += it },
                    onLink = {},
                    onPicture = {},
                    onInsert = { inserts++ },
                    onBlock = { actions += it },
                    onTurnInto = { turns++ },
                )
            }
        }
        compose.onNodeWithContentDescription("Next Cell").assertDoesNotExist()
        compose.onNodeWithContentDescription("Insert a Block").performScrollTo().performClick()
        assertEquals(1, inserts)

        compose.onNodeWithContentDescription("Block Actions").assertExists()
        compose.onNodeWithTag("blockMenu").performScrollTo().performClick()
        compose.onNodeWithTag("blockMoveUp").assertIsNotEnabled()
        compose.onNodeWithTag("blockMoveDown").performClick()
        compose.onNodeWithTag("blockMenu").performScrollTo().performClick()
        compose.onNodeWithTag("blockTurnInto").performClick()
        compose.onNodeWithTag("blockMenu").performScrollTo().performClick()
        compose.onNodeWithTag("blockDuplicate").performClick()
        compose.onNodeWithTag("blockMenu").performScrollTo().performClick()
        compose.onNodeWithTag("blockDelete").performClick()
        assertEquals(listOf(BlockAction.MOVE_DOWN, BlockAction.DUPLICATE, BlockAction.DELETE), actions)
        assertEquals(1, turns)

        state = FormatState(inTable = true)
        for (label in listOf("Previous Cell", "Next Cell", "Add Row", "Add Column")) {
            compose.onNodeWithContentDescription(label).performScrollTo().performClick()
        }
        assertEquals(
            listOf(FormatCommand.PREVIOUS_CELL, FormatCommand.NEXT_CELL, FormatCommand.ADD_ROW, FormatCommand.ADD_COLUMN),
            commands,
        )
    }

    @Test
    fun theTextStyleMenuOffersHeadingsFourToSix() {
        val commands = mutableListOf<FormatCommand>()
        compose.setContent { PenmossTheme { FormatBar(FormatState(), onCommand = { commands += it }, onLink = {}, onPicture = {}) } }
        compose.onNodeWithContentDescription("Text Style").performScrollTo().performClick()
        compose.onNodeWithText("Heading 6").performClick()
        assertEquals(listOf(FormatCommand.HEADING6), commands)
        // Without the tools' callbacks (the theme preview's bar), no + and no Block.
        compose.onNodeWithContentDescription("Insert a Block").assertDoesNotExist()
        compose.onNodeWithTag("blockMenu").assertDoesNotExist()
    }

    // The ⋮ menu's copies, source, Find in Note and Word Count: NoteMenuTest (T51, A937).

    @Test
    fun theWordCountReadsAsTheWebsStatusBar() {
        var counts by androidx.compose.runtime.mutableStateOf<NoteCounts?>(null)
        compose.setContent { PenmossTheme { WordCountDialog(counts, onDismiss = {}) } }
        compose.onNodeWithText("Counting…").assertExists()
        counts = NoteCounts(1204, 6780, 5, TextCounts(2, 9))
        compose.onNodeWithText("1,204 words").assertExists()
        compose.onNodeWithText("6,780 characters").assertExists()
        compose.onNodeWithText("5 min read").assertExists()
        compose.onNodeWithText("2 words and 9 characters selected").assertExists()
        counts = NoteCounts(1, 1, 0, null)
        compose.onNodeWithText("1 word").assertExists()
        compose.onNodeWithText("min read", substring = true).assertDoesNotExist()
    }
}
