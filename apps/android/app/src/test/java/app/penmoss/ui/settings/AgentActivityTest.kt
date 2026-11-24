package app.penmoss.ui.settings

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
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.AgentActivityScreen
import app.penmoss.ui.settings.NO_AGENT_ACTIVITY
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
 * Agent Activity on the phone (T42, A561; #172, A920; PEN-146): what agents changed across every
 * notebook, filtered by notebook, agent and kind, and Undo, which says what the notebook answered
 * and reads the lists again.
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
    private val other = FakeApi()
    private var syncs = 0

    private fun personal(entry: AgentActivityEntry) = ActivityItem("n1", "Personal", entry)

    @Test
    fun theFiltersPickANotebookAnAgentAndAKindOfChange() {
        val all = listOf(personal(rename), personal(sort), ActivityItem("n2", "Quanta", theme))
        assertTrue(inActivityGroup(sort, "folder"))
        assertTrue(inActivityGroup(rename, "folder"))
        assertTrue(!inActivityGroup(theme, "folder"))
        assertTrue(inActivityGroup(theme, "settings"))
        assertEquals(listOf("agent:claude" to "Claude Code", "agent:codex" to "Codex"), activityAgents(all.map { it.entry }))
        assertEquals(listOf(sort, theme), AgentActivityUi(items = all, agent = "agent:claude").shown.map { it.entry })
        assertEquals(listOf(sort), AgentActivityUi(items = all, agent = "agent:claude", group = "folder").shown.map { it.entry })
        assertEquals(listOf(theme), AgentActivityUi(items = all, notebook = "n2").shown.map { it.entry })
        assertEquals(listOf("n1" to "Personal", "n2" to "Quanta"), AgentActivityUi(items = all).notebooks)
        assertEquals(all, AgentActivityUi(items = all).shown)
        val detail = activityDetail(theme, now = 2_000, notebook = "Quanta")
        assertTrue(detail, detail.startsWith("✦ Claude Code · Quanta · "))
        assertTrue(detail, detail.contains(" · Undone by Pixel 9 "))
    }

    private fun withModel(block: suspend (AgentActivityModel) -> Unit) = runBlocking {
        val job = SupervisorJob()
        val sources = listOf(
            ActivitySource("n1", "Personal", api = { api }, requestSync = { syncs++ }),
            ActivitySource("n2", "Quanta", api = { other }),
        )
        val model = AgentActivityModel({ sources }, scope = CoroutineScope(coroutineContext + job))
        try {
            block(model)
        } finally {
            job.cancelAndJoin()
        }
    }

    private suspend fun AgentActivityModel.until(what: (AgentActivityUi) -> Boolean) = withTimeout(5_000) { ui.first(what) }

    @Test
    fun theListIsEveryNotebooksNewestFirst() = withModel { model ->
        api.activityList = { listOf(sort) }
        other.activityList = { listOf(rename, theme) }
        model.load()
        val ui = model.until { it.items != null && !it.loading }
        assertEquals(listOf("n2-3", "n1-2", "n2-1"), ui.items!!.map { it.key })
        assertEquals(null, ui.problem)
    }

    @Test
    fun undoSaysWhatTheNotebookAnsweredAndReadsTheListAgain() = withModel { model ->
        var listed = listOf(rename, sort)
        api.activityList = { listed }
        other.activityList = { emptyList() }
        model.load()
        assertEquals(listOf(rename, sort), model.until { it.items != null && !it.loading }.items!!.map { it.entry })
        api.onUndoActivity = { id ->
            listed = listOf(rename.copy(undoneAt = 4_000, undoneBy = "Pixel 9"), sort)
            ActivityUndone(id, notice = null)
        }
        model.undo(personal(rename))
        val done = model.until { it.message != null && it.items?.first()?.entry?.undoneAt != null }
        assertEquals("Undone: Renamed the folder “Plans” to “Ideas”.", done.message)
        assertEquals(listOf(3L), api.undone.toList())
        assertEquals(1, syncs)
        model.messageShown()
        // The notebook's notice says what it could not put back; undone before, it says so.
        api.onUndoActivity = { ActivityUndone(it, notice = "Renamed back. 2 notes kept the new tag.") }
        model.undo(personal(sort))
        assertEquals("Renamed back. 2 notes kept the new tag.", model.until { it.message != null }.message)
        model.messageShown()
        api.onUndoActivity = { ActivityUndone(it, alreadyUndone = true) }
        model.undo(personal(sort))
        assertEquals("That change was undone already.", model.until { it.message != null }.message)
    }

    @Test
    fun aChangeMadeSinceIsSaidAndNothingChanges() = withModel { model ->
        api.activityList = { listOf(rename) }
        other.activityList = { emptyList() }
        model.load()
        model.until { it.items != null }
        api.onUndoActivity = { throw ApiException(409, "changed_since", "“Ideas” was renamed again since, to “Later”") }
        model.undo(personal(rename))
        assertEquals("“Ideas” was renamed again since, to “Later”", model.until { it.message != null }.message)
        assertEquals(0, syncs)
        model.messageShown()
        api.onUndoActivity = { throw java.io.IOException("the page is gone") }
        model.undo(personal(rename))
        assertEquals("Couldn’t undo it just now: the page is gone.", model.until { it.message != null }.message)
    }

    /** No server-era words (PEN-146): a notebook whose list can't be read is named, and the others still show. */
    @Test
    fun aNotebookThatCannotBeReadIsNamedAndTheOthersShow() = withModel { model ->
        api.activityList = { throw java.io.IOException("the page is gone") }
        other.activityList = { listOf(theme) }
        model.load()
        val ui = model.until { it.problem != null && !it.loading }
        assertEquals("Penmoss couldn’t read what agents changed in Personal: the page is gone.", ui.problem)
        assertEquals(listOf(theme), ui.items!!.map { it.entry })
        assertTrue(!ui.problem!!.contains("server") && !ui.problem!!.contains("kept by Penmoss"))
    }

    @Test
    fun theScreenListsEachChangeWithItsNotebookAndUndoUnlessUndone() {
        val undone = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                AgentActivityScreen(
                    ui = AgentActivityUi(items = listOf(personal(rename), personal(theme))),
                    onBack = {}, onRetry = {}, onFilter = { _, _, _ -> }, onUndo = { undone += it.key }, onMessageShown = {}, now = 2_000,
                )
            }
        }
        compose.onNodeWithText("Renamed the folder “Plans” to “Ideas”").assertIsDisplayed()
        compose.onNodeWithText("✦ Codex · Personal", substring = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("Undo: Renamed the folder “Plans” to “Ideas”").performClick()
        assertEquals(listOf("n1-3"), undone)
        // Undone already: who undid it shows, and there is no Undo.
        compose.onNodeWithTag("undo-n1-1").assertDoesNotExist()
        compose.onNodeWithTag("activityNotebook").assertIsDisplayed()
        compose.onNodeWithTag("activityAgent").assertIsDisplayed()
        compose.onNodeWithTag("activityGroup").assertIsDisplayed()
        compose.onNodeWithText("All Notebooks").assertIsDisplayed()
        compose.onNodeWithText("All Agents").assertIsDisplayed()
    }

    @Test
    fun anEmptyListAndAnUndoUnderWaySayAsMuch() {
        compose.setContent {
            PenmossTheme {
                AgentActivityScreen(
                    ui = AgentActivityUi(items = listOf(personal(rename)), busy = "n1-3", group = "tag"),
                    onBack = {}, onRetry = {}, onFilter = { _, _, _ -> }, onUndo = {}, onMessageShown = {},
                )
            }
        }
        compose.onNodeWithText(NO_AGENT_ACTIVITY).assertIsDisplayed()
        compose.onNodeWithTag("activityLoading").assertIsDisplayed()
        compose.onNodeWithText("read from each notebook’s branch", substring = true).assertIsDisplayed()
    }

    @Test
    fun anUndoUnderWayHoldsTheOthers() {
        compose.setContent {
            PenmossTheme {
                AgentActivityScreen(
                    ui = AgentActivityUi(items = listOf(personal(rename), personal(sort)), busy = "n1-2"),
                    onBack = {}, onRetry = {}, onFilter = { _, _, _ -> }, onUndo = {}, onMessageShown = {},
                )
            }
        }
        compose.onNodeWithTag("undo-n1-3").assertIsNotEnabled()
    }
}
