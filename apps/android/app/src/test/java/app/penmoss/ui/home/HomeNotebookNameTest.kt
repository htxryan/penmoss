package app.penmoss.ui.home

import android.os.Looper
import android.view.View
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.room.Room
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import app.penmoss.DeviceGraph
import app.penmoss.NotebookGraph
import app.penmoss.PenmossApp
import app.penmoss.TestGraphs
import app.penmoss.data.PenmossDatabase
import app.penmoss.editor.NotePages
import app.penmoss.git.GitNotebookActivity
import app.penmoss.stopMainScope
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Home's notebook heading names the git notebook it is in, as the web's sidebar names its section,
 * never "Personal" (A1538).
 */
@RunWith(AndroidJUnit4::class)
@Config(application = PenmossApp::class)
class HomeNotebookNameTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: PenmossApp = ApplicationProvider.getApplicationContext()
    private lateinit var main: DeviceGraph
    private lateinit var graph: NotebookGraph
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

    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theHeadingIsTheNotebooksName() {
        TestGraphs.forgetNotebooks(app)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        val pages = NotePages { context, _, _, _ -> View(context) }
        main = TestGraphs.app(app, pages) {
            Room.inMemoryDatabaseBuilder(app, PenmossDatabase::class.java)
                .setQueryExecutor(roomQueries).setTransactionExecutor(roomTransactions).build()
        }
        app.useGraph(main)
        val notebook = TestGraphs.addNotebook(app, main, "Garden Notes")
        graph = main.git.graph(notebook)
        scenario = ActivityScenario.launch(TestGraphs.opening(app, notebook))

        // The notes list's title is the notebook (A1613).
        val title = hasTestTag("homeTitle")
        compose.waitUntil(5_000) {
            shadowOf(Looper.getMainLooper()).idle()
            exists(hasText("Garden Notes") and title)
        }
        check(!exists(hasText("Personal") and title)) { "the title still says Personal" }
    }
}
