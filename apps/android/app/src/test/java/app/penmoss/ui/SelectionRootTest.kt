package app.penmoss.ui

import android.os.Looper
import android.view.KeyEvent
import android.view.View
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.room.Room
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import app.penmoss.AppGraph
import app.penmoss.PenmossApp
import app.penmoss.TestGraphs
import app.penmoss.git.GitNotebookActivity
import app.penmoss.data.PenmossDatabase
import app.penmoss.editor.NotePages
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeNote
import app.penmoss.stopMainScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Selection mode through the app (T42 on Android, NT26, A652; review S2–S4): the root's bar moves
 * every chosen note to Trash with one Undo, ends when the screen goes or on Back, keeps TalkBack
 * off the screen's own bar under it, and lets go of a chosen note a pass takes off the list.
 */
@RunWith(AndroidJUnit4::class)
class SelectionRootTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: PenmossApp = ApplicationProvider.getApplicationContext()
    /** The app's graph, and the git notebook's whose Home is open. */
    private lateinit var main: AppGraph
    private lateinit var graph: AppGraph
    private var scenario: ActivityScenario<GitNotebookActivity>? = null

    private val roomQueries = Executors.newSingleThreadExecutor()
    private val roomTransactions = Executors.newSingleThreadExecutor()

    @After
    fun close() {
        scenario?.close()
        // The graph's work ends before Room's threads and the database close (A690).
        if (::main.isInitialized) stopMainScope(main.scope)
        repeat(3) {
            shadowOf(Looper.getMainLooper()).idle()
            listOf(roomQueries, roomTransactions).forEach { it.submit {}.get(5, TimeUnit.SECONDS) }
        }
        if (::graph.isInitialized) graph.database.close()
        if (::main.isInitialized) main.database.close()
        roomQueries.shutdown()
        roomTransactions.shutdown()
        TestGraphs.forgetNotebooks(app)
    }

    /** A git notebook's Home, offline, with Soup, Tea and Bread among its recent notes. */
    private fun openHome() {
        TestGraphs.forgetNotebooks(app)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        val pages = NotePages { context, _, _, _ -> View(context) }
        main = TestGraphs.app(app, pages) {
            Room.inMemoryDatabaseBuilder(app, PenmossDatabase::class.java)
                .setQueryExecutor(roomQueries).setTransactionExecutor(roomTransactions).build()
        }
        app.useGraph(main)
        val notebook = TestGraphs.addNotebook(app, main, "Notes")
        graph = main.git.graph(notebook)
        runBlocking {
            graph.store.saveTree(SyncTree(hash = "h1", notes = listOf(TreeNote("a", null, "a0"), TreeNote("b", null, "a1"), TreeNote("c", null, "a2"))))
            graph.store.saveChanges(
                ChangesPage(1, notes = listOf(ChangedNote("a", 1, "Soup", "", 5), ChangedNote("b", 1, "Tea", "", 4), ChangedNote("c", 1, "Bread", "", 3))),
            )
        }
        scenario = ActivityScenario.launch(TestGraphs.opening(app, notebook))
        await { exists(hasText("Soup")) && exists(hasText("Bread")) }
    }

    private fun exists(matcher: androidx.compose.ui.test.SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()

    private fun await(condition: () -> Boolean) = compose.waitUntil(5_000) {
        shadowOf(Looper.getMainLooper()).idle()
        condition()
    }

    private fun listed(): List<String> = runBlocking { graph.store.observeList().first().map { it.id }.sorted() }

    private fun inTrash(): List<String> = runBlocking { graph.store.observeTrash().first().map { it.id }.sorted() }

    @Test
    fun theBarsMoveToTrashTakesEveryChosenNoteWithOneUndo() {
        openHome()
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        compose.onNodeWithText("Tea").performClick()
        compose.onNodeWithTag("selectionCount").assertTextEquals("2 selected")
        compose.onNodeWithTag("selectionTrash").performClick()
        await { exists(hasText("Moved 2 notes to Trash")) }
        assertEquals(listOf("a", "b"), inTrash())
        compose.onNodeWithTag("selectionBar").assertDoesNotExist()
        compose.onNodeWithText("Undo").performClick()
        await { listed() == listOf("a", "b", "c") }
        assertEquals(emptyList<String>(), inTrash())
    }

    @Test
    fun selectionEndsWhenTheScreenGoesAndOnBack() {
        openHome()
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        compose.onNodeWithTag("selectionBar").assertIsDisplayed()
        // Back ends selection mode first, on Home.
        scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        await { !exists(hasTestTag("selectionBar")) }
        compose.onNodeWithText("Soup").assertIsDisplayed()
        // Leaving the screen ends it: no Move or Trash of notes out of sight.
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        compose.onNodeWithTag("selectionBar").assertIsDisplayed()
        // Ctrl+, opens Settings over Home (a screen with no note page to load).
        scenario!!.onActivity { activity ->
            listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP).forEach { action ->
                activity.dispatchKeyEvent(KeyEvent(0, 0, action, KeyEvent.KEYCODE_COMMA, 0, KeyEvent.META_CTRL_ON))
            }
        }
        await { !exists(hasTestTag("homeToday")) }
        compose.onNodeWithTag("selectionBar").assertDoesNotExist()
    }

    @Test
    fun talkBackSkipsHomesBarUnderTheSelectionBar() {
        openHome()
        compose.onNodeWithTag("homeMore").assertIsDisplayed()
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        // Covered by the selection bar: Search and ⋮ are not in the tree TalkBack reads.
        await { !exists(hasTestTag("homeMore")) }
        compose.onNodeWithTag("selectionClose").performClick()
        await { exists(hasTestTag("homeMore")) }
    }

    @Test
    fun aChosenNoteAPassTakesOffHomeIsNoLongerChosen() {
        openHome()
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        compose.onNodeWithText("Tea").performClick()
        compose.onNodeWithTag("selectionCount").assertTextEquals("2 selected")
        // Tea goes to Trash elsewhere: the bar now acts on Soup alone.
        runBlocking { graph.store.moveToTrash("b") }
        await { !exists(hasText("Tea")) }
        await { exists(hasText("1 selected")) }
        compose.onNodeWithTag("selectionTrash").performClick()
        await { inTrash() == listOf("a", "b") }
        assertEquals(listOf("c"), listed())
    }
}
