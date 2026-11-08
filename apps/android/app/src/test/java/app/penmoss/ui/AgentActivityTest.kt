package app.penmoss.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.engine.api.ActivityActor
import app.penmoss.engine.api.ActivityUndone
import app.penmoss.engine.api.AgentActivityEntry
import app.penmoss.engine.api.ApiException
import app.penmoss.ui.settings.AgentActivityScreen
import app.penmoss.ui.settings.NO_AGENT_ACTIVITY
import app.penmoss.ui.settings.NO_GIT_AGENT_ACTIVITY
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Agent activity on the phone (T42, A561; T40 P9, AC11): what agent tokens changed, filtered as
 * on the web, and Undo, which says what the server answered and reads the list again.
 */
@RunWith(AndroidJUnit4::class)
class AgentActivityTest {
    @get:Rule
    val compose = createComposeRule()

    private val codex = ActivityActor("agent:codex", "Codex")
    private val claude = ActivityActor("agent:claude", "Claude Code")
    private val rename = AgentActivityEntry(3, at = 3_000, actor = codex, kinds = listOf("folder.rename"), summary = "Renamed the folder “Plans” to “Ideas”")
    private val sort = AgentActivityEntry(2, at = 2_000, actor = claude, kinds = listOf("root.sort"), summary = "Sorted the top level by name")
    private val theme = AgentActivityEntry(1, at = 1_000, actor = claude, kinds = listOf("settings.change"), summary = "Changed theme.id", undoneAt = 1_500, undoneBy = "Pixel 9")

    private val api = FakeApi()
    private var syncs = 0

    @Test
    fun theFiltersPickAnAgentAndAKindOfChangeAsTheWebsDo() {
        val all = listOf(rename, sort, theme)
        assertTrue(inActivityGroup(sort, "folder"))
        assertTrue(inActivityGroup(rename, "folder"))
        assertTrue(!inActivityGroup(theme, "folder"))
        assertTrue(inActivityGroup(theme, "settings"))
        assertEquals(listOf("agent:claude" to "Claude Code", "agent:codex" to "Codex"), activityAgents(all))
        assertEquals(listOf(sort, theme), AgentActivityUi(entries = all, agent = "agent:claude").shown)
        assertEquals(listOf(sort), AgentActivityUi(entries = all, agent = "agent:claude", group = "folder").shown)
        assertEquals(all, AgentActivityUi(entries = all).shown)
        val detail = activityDetail(theme, now = 2_000)
        assertTrue(detail, detail.startsWith("✦ Claude Code · "))
        assertTrue(detail, detail.contains(" · Undone by Pixel 9 "))
    }

    private fun withModel(block: suspend (AgentActivityModel) -> Unit) = runBlocking {
        val job = SupervisorJob()
        val model = AgentActivityModel(api, requestSync = { syncs++ }, scope = CoroutineScope(coroutineContext + job))
        try {
            block(model)
        } finally {
            job.cancelAndJoin()
        }
    }

    private suspend fun AgentActivityModel.until(what: (AgentActivityUi) -> Boolean) = withTimeout(5_000) { ui.first(what) }

    @Test
    fun undoSaysWhatTheServerAnsweredAndReadsTheListAgain() = withModel { model ->
        var listed = listOf(rename, sort)
        api.activityList = { listed }
        model.load()
        assertEquals(listOf(rename, sort), model.until { it.entries != null && !it.loading }.entries)
        api.onUndoActivity = { id ->
            listed = listOf(rename.copy(undoneAt = 4_000, undoneBy = "Pixel 9"), sort)
            ActivityUndone(id, notice = null)
        }
        model.undo(rename)
        val done = model.until { it.message != null && it.entries?.first()?.undoneAt != null }
        assertEquals("Undone: Renamed the folder “Plans” to “Ideas”.", done.message)
        assertEquals(listOf(3L), api.undone.toList())
        assertEquals(1, syncs)
        model.messageShown()
        // The server's notice says what it could not put back; undone before, it says so.
        api.onUndoActivity = { ActivityUndone(it, notice = "Renamed back. 2 notes kept the new tag.") }
        model.undo(sort)
        assertEquals("Renamed back. 2 notes kept the new tag.", model.until { it.message != null }.message)
        model.messageShown()
        api.onUndoActivity = { ActivityUndone(it, alreadyUndone = true) }
        model.undo(sort)
        assertEquals("That change was undone already.", model.until { it.message != null }.message)
    }

    @Test
    fun aChangeMadeSinceIsSaidAndNothingChanges() = withModel { model ->
        api.activityList = { listOf(rename) }
        model.load()
        model.until { it.entries != null }
        api.onUndoActivity = { throw ApiException(409, "changed_since", "“Ideas” was renamed again since, to “Later”") }
        model.undo(rename)
        assertEquals("“Ideas” was renamed again since, to “Later”", model.until { it.message != null }.message)
        assertEquals(0, syncs)
        model.messageShown()
        api.onUndoActivity = { throw java.io.IOException("offline") }
        model.undo(rename)
        assertEquals("Offline: Undo needs Penmoss. Try again once the phone is online.", model.until { it.message != null }.message)
    }

    @Test
    fun offlineTheListSaysWhereItIs() = withModel { model ->
        model.load()
        val ui = model.until { it.problem != null }
        assertEquals("Offline: what agents changed is kept by Penmoss. Try again once the phone is online.", ui.problem)
        // A refusal says the notebook's words (no sign-in to lose since T59).
        api.activityList = { throw ApiException(401, "unauthorized", "Unauthorized") }
        model.load()
        model.until { it.problem?.startsWith("Penmoss couldn’t") == true }
    }

    @Test
    fun theScreenListsEachChangeWithUndoUnlessUndone() {
        val undone = mutableListOf<Long>()
        compose.setContent {
            PenmossTheme {
                AgentActivityScreen(
                    ui = AgentActivityUi(entries = listOf(rename, theme)),
                    onBack = {}, onRetry = {}, onFilter = { _, _ -> }, onUndo = { undone += it.id }, onMessageShown = {}, now = 2_000,
                )
            }
        }
        compose.onNodeWithText("Renamed the folder “Plans” to “Ideas”").assertIsDisplayed()
        compose.onNodeWithContentDescription("Undo: Renamed the folder “Plans” to “Ideas”").performClick()
        assertEquals(listOf(3L), undone)
        // Undone already: who undid it shows, and there is no Undo.
        compose.onNodeWithTag("undo-1").assertDoesNotExist()
        compose.onNodeWithTag("activityAgent").assertIsDisplayed()
        compose.onNodeWithTag("activityGroup").assertIsDisplayed()
    }

    @Test
    fun anEmptyListAndAnUndoUnderWaySayAsMuch() {
        compose.setContent {
            PenmossTheme {
                AgentActivityScreen(
                    ui = AgentActivityUi(entries = listOf(rename), busy = 3, group = "tag"),
                    onBack = {}, onRetry = {}, onFilter = { _, _ -> }, onUndo = {}, onMessageShown = {},
                )
            }
        }
        compose.onNodeWithText(NO_AGENT_ACTIVITY).assertIsDisplayed()
        compose.onNodeWithTag("activityLoading").assertIsDisplayed()
    }

    /** #172 (A920): a git notebook's, read from its branch, in the web's `GitAgentActivity` words. */
    @Test
    fun aGitNotebooksListSaysItIsReadFromItsBranchAndListsNoTags() {
        compose.setContent {
            PenmossTheme {
                AgentActivityScreen(
                    ui = AgentActivityUi(entries = emptyList()),
                    onBack = {}, onRetry = {}, onFilter = { _, _ -> }, onUndo = {}, onMessageShown = {},
                    git = true,
                )
            }
        }
        compose.onNodeWithText(NO_GIT_AGENT_ACTIVITY).assertIsDisplayed()
        compose.onNodeWithText("read from its branch", substring = true).assertIsDisplayed()
        assertEquals("No agent has moved notes or changed folders or settings here in the last 30 days.", NO_GIT_AGENT_ACTIVITY)
    }

    @Test
    fun anUndoUnderWayHoldsTheOthers() {
        compose.setContent {
            PenmossTheme {
                AgentActivityScreen(
                    ui = AgentActivityUi(entries = listOf(rename, sort), busy = 2),
                    onBack = {}, onRetry = {}, onFilter = { _, _ -> }, onUndo = {}, onMessageShown = {},
                )
            }
        }
        compose.onNodeWithTag("undo-3").assertIsNotEnabled()
    }
}
