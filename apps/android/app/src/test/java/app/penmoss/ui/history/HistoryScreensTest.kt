package app.penmoss.ui.history

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.DiffOp
import app.penmoss.engine.api.HistoryAuthor
import app.penmoss.engine.api.NoteHistory
import app.penmoss.engine.api.NoteVersion
import app.penmoss.engine.api.RevertConflict
import app.penmoss.engine.api.VersionDetail
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import app.penmoss.ui.common.PenmossTheme

/** Version history's screens (T40 P3b, NT16–NT20), on Robolectric. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HistoryScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val events = mutableListOf<String>()

    private val agent = NoteVersion(
        3,
        createdAt = 1761376800000,
        reason = "edit",
        summary = "Appended",
        authors = listOf(HistoryAuthor("a1", "agent", "Claude")),
    )
    private val device = NoteVersion(
        2,
        createdAt = 1761376700000,
        reason = "manual",
        summary = "",
        authors = listOf(HistoryAuthor("d1", "device", "Pixel")),
    )
    private val detail = VersionDetail(
        3,
        previousId = 2,
        markdown = "# T\nnew\n",
        diff = listOf(DiffOp("same", "# T"), DiffOp("add", "new")),
    )

    private fun screen(ui: HistoryUi) = compose.setContent {
        PenmossTheme {
            HistoryScreen(
                ui = ui,
                onSelect = { events += "select:$it" },
                onToggleWhole = { events += "whole:$it" },
                onAskRestore = { events += "ask:$it" },
                onDismissConfirm = { events += "dismiss" },
                onRestore = { events += "restore:$it" },
                onRevert = { events += "revert:$it" },
                onSaveNow = { events += "save" },
                onMessageShown = { events += "shown" },
                onConflictsDismissed = { events += "nodiff" },
                onRefresh = { events += "refresh" },
                onBack = { events += "back" },
            )
        }
    }

    private fun loaded(selected: Long? = 3, withDetail: Boolean = true) = HistoryUi(
        history = NoteHistory(listOf(agent, device)),
        selected = selected,
        detail = if (withDetail && selected == 3L) detail else null,
    )

    @Test
    fun listsVersionsWithTimeAuthorChipAndSummary() {
        screen(loaded(selected = null, withDetail = false))
        compose.onNodeWithText("Appended").assertIsDisplayed()
        // Who made each, as the Mac's rows: an icon, named for screen readers.
        compose.onNodeWithContentDescription("Agent · Claude").assertIsDisplayed()
        compose.onNodeWithContentDescription("Pixel").assertIsDisplayed()
        compose.onNodeWithText("Saved by hand").assertIsDisplayed()
        // Master → detail: no diff under the list.
        compose.onNodeWithTag("historyDetail").assertDoesNotExist()
    }

    @Test
    fun selectingAVersionReadsItsDiff() {
        screen(loaded(selected = null, withDetail = false))
        events.clear()
        compose.onNodeWithTag("history-3").performClick()
        assert(events.single() == "select:3")
    }

    /** A version opens on its own screen; Versions (or Back) returns to the list (item 9). */
    @Test
    fun aVersionOpensOnItsOwnScreenAndBackReturns() {
        screen(loaded())
        compose.onNodeWithTag("history-3").performClick()
        compose.onNodeWithTag("historyDetail").assertIsDisplayed()
        compose.onNodeWithTag("historyList").assertDoesNotExist()
        compose.onNodeWithTag("copyVersion").assertIsDisplayed()
        compose.onNodeWithTag("historyBack").performClick()
        compose.onNodeWithTag("historyList").assertIsDisplayed()
        compose.onNodeWithTag("historyDetail").assertDoesNotExist()
    }

    @Test
    fun theDiffShowsAddedLinesAndTogglesToTheWholeVersion() {
        var whole by mutableStateOf(false)
        var ui by mutableStateOf(loaded())
        compose.setContent {
            PenmossTheme {
                HistoryScreen(
                    ui = ui.copy(showWhole = whole),
                    onSelect = {},
                    onToggleWhole = { whole = it },
                    onAskRestore = {},
                    onDismissConfirm = {},
                    onRestore = {},
                    onRevert = {},
                    onSaveNow = {},
                    onMessageShown = {},
                    onConflictsDismissed = {},
                    onRefresh = {},
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("history-3").performClick()
        compose.onNodeWithTag("historyDiff").assertIsDisplayed()
        compose.onNodeWithText("+ new", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("historyToggleWhole").performClick()
        compose.onNodeWithText("# T\nnew", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("historyWhole").assertIsDisplayed()
    }

    @Test
    fun restoreAsksForConfirmFirst() {
        var ui by mutableStateOf(loaded())
        compose.setContent {
            PenmossTheme {
                HistoryScreen(
                    ui = ui,
                    onSelect = {},
                    onToggleWhole = {},
                    onAskRestore = { ui = ui.copy(confirming = it) },
                    onDismissConfirm = { ui = ui.copy(confirming = null) },
                    onRestore = { events += "restore:$it" },
                    onRevert = {},
                    onSaveNow = {},
                    onMessageShown = {},
                    onConflictsDismissed = {},
                    onRefresh = {},
                    onBack = {},
                )
            }
        }
        // Asking does not restore yet; the confirm does.
        compose.onNodeWithTag("history-3").performClick()
        compose.onNodeWithTag("restoreVersion").performClick()
        compose.onNodeWithText("Restore This Version?").assertIsDisplayed()
        assert(!events.any { it.startsWith("restore:") })
        compose.onNodeWithTag("confirmRestore").performClick()
        assert(events.single() == "restore:3")
    }

    @Test
    fun revertIsOnEveryWritersVersion() {
        var selected by mutableStateOf<Long?>(2)
        compose.setContent {
            PenmossTheme {
                HistoryScreen(
                    ui = loaded(selected = selected, withDetail = false),
                    onSelect = {},
                    onToggleWhole = {},
                    onAskRestore = {},
                    onDismissConfirm = {},
                    onRestore = {},
                    onRevert = { events += "revert:$it" },
                    onSaveNow = {},
                    onMessageShown = {},
                    onConflictsDismissed = {},
                    onRefresh = {},
                    onBack = {},
                )
            }
        }
        // This phone's own version as well as an agent's (A1575).
        compose.onNodeWithTag("history-2").performClick()
        compose.onNodeWithTag("revertVersion").assertIsDisplayed()
        selected = 3
        compose.onNodeWithTag("revertVersion").assertIsDisplayed()
        // The web's name (T39 pass 3, A896), its word Revert as the Mac's button.
        compose.onNodeWithTag("revertVersion").assertContentDescriptionEquals("Revert This Edit")
        compose.onNodeWithTag("revertVersion").performClick()
        assert(events.single() == "revert:3")
    }

    @Test
    fun overlapsTheRevertCouldNotUndoAreListed() {
        screen(
            loaded().copy(
                conflicts = listOf(
                    RevertConflict("body", ours = listOf("kept"), theirs = listOf("gone")),
                    RevertConflict("title", ours = emptyList(), theirs = listOf("Old")),
                ),
            ),
        )
        compose.onNodeWithText("Some Changes Overlapped").assertIsDisplayed()
        compose.onAllNodesWithTag("historyConflicts").assertCountEquals(2)
        compose.onNodeWithText("Before the edit: gone", substring = true).assertIsDisplayed()
    }

    @Test
    fun offlineShowsTheProblemWithTheCachedList() {
        screen(loaded(selected = null, withDetail = false).copy(problem = "Offline: showing versions from 25 Oct, 4:25 AM."))
        compose.onNodeWithTag("historyProblem").assertIsDisplayed()
        compose.onNodeWithText("Appended").assertIsDisplayed()
    }

    /** T42 (A574; T40 NT28, A654): versions are automatic, said by the Now row's ⓘ as the Mac's; saving one is the quiet extra. */
    @Test
    fun historySaysVersionsAreAutomaticWithSaveVersionOnTheNowRow() {
        screen(loaded())
        events.clear()
        compose.onNodeWithTag("historyExplained").assertDoesNotExist()
        compose.onNodeWithContentDescription("About Versions").performClick()
        compose.onNodeWithTag("historyExplained").assertTextEquals(VERSIONS_EXPLAINED)
        compose.onNodeWithText("Save version").assertDoesNotExist()
        compose.onNodeWithText("Save Version").assertIsDisplayed().performClick()
        assert(events.single() == "save")
    }

    /** A move to Trash or its restore has no edit to take back: Restore only (A574, N7, A654). */
    @Test
    fun anAgentsMoveToTrashOffersNoRevert() {
        for (summary in listOf("Moved to Trash", "Restored from Trash", " Moved to Trash ")) {
            assertFalse(summary, revertible(agent.copy(summary = summary)))
        }
        assertTrue(revertible(agent))
        assertTrue(revertible(device))
        var selected by mutableStateOf<Long?>(4)
        val trashed = agent.copy(id = 4, summary = "Moved to Trash")
        compose.setContent {
            PenmossTheme {
                HistoryScreen(
                    ui = HistoryUi(history = NoteHistory(listOf(trashed, agent, device)), selected = selected),
                    onSelect = {}, onToggleWhole = {}, onAskRestore = {}, onDismissConfirm = {}, onRestore = {},
                    onRevert = { events += "revert:$it" }, onSaveNow = {}, onMessageShown = {}, onConflictsDismissed = {}, onRefresh = {}, onBack = {},
                )
            }
        }
        compose.onNodeWithTag("history-4").performClick()
        compose.onNodeWithTag("restoreVersion").assertIsDisplayed()
        compose.onAllNodesWithTag("revertVersion").assertCountEquals(0)
        selected = 3
        compose.onNodeWithTag("revertVersion").assertIsDisplayed()
    }
}
