package app.penmoss.ui

import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import app.penmoss.AppGraph
import app.penmoss.PenmossApp
import app.penmoss.TestGraphs
import app.penmoss.data.NoteEntity
import app.penmoss.git.GitNotebookActivity
import app.penmoss.git.FIRST_RUN
import app.penmoss.stopMainScope
import app.penmoss.ui.keys.LauncherAction
import app.penmoss.ui.keys.LauncherShortcuts
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * The app's first screen since T59 (A1040): the git notebooks on the phone, with no sign-in. The
 * first run asks to add or create a notebook; with one, it is listed to open. A
 * `penmoss://note/<id>` link (T40 P7, PL5, A476) opens the note in the notebook that holds it,
 * and a launcher shortcut's Today, This week, New note and Search open the Journal notebook.
 */
@RunWith(AndroidJUnit4::class)
class DeepLinkActivityTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: PenmossApp = ApplicationProvider.getApplicationContext()
    private lateinit var graph: AppGraph
    private var scenario: ActivityScenario<MainActivity>? = null

    private val garden = "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"

    @Before
    fun start() {
        TestGraphs.forgetNotebooks(app)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        graph = TestGraphs.app(app)
        app.useGraph(graph)
    }

    @After
    fun close() {
        scenario?.close()
        // The app’s work has ended before the database closes, never against a closed pool (A610, A690).
        stopMainScope(graph.scope)
        graph.git.madeGraphs().forEach { it.database.close() }
        graph.database.close()
        TestGraphs.forgetNotebooks(app)
    }

    private fun view(link: String) = Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(app, MainActivity::class.java)

    private fun launcher(action: String) = Intent(action).setClassName(app, LauncherShortcuts.ALIAS)

    /** Lets Room, the flows and the screens catch up: Robolectric's looper is paused. */
    private fun settle() {
        repeat(5) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.waitForIdle()
        }
    }

    /** The next activity the app started, waiting for one started from a coroutine. */
    private fun started(): Intent? {
        var next: Intent? = null
        runCatching {
            compose.waitUntil(5_000) {
                shadowOf(Looper.getMainLooper()).idle()
                next = shadowOf(app).nextStartedActivity
                next != null
            }
        }
        return next
    }

    private fun shown(text: String, substring: Boolean = false) =
        compose.onAllNodes(hasText(text, substring = substring)).fetchSemanticsNodes().size

    @Test
    fun theFirstRunAsksToAddOrCreateAGitNotebookAndNeverToSignIn() {
        scenario = ActivityScenario.launch(MainActivity::class.java)
        settle()
        compose.onNodeWithTag("gitFirstRun").assertExists()
        assertEquals(1, shown(FIRST_RUN))
        compose.onNode(hasTestTag("gitAdd")).performScrollTo().assertExists()
        // No sign-in and no personal notes, anywhere on it.
        assertEquals(0, shown("Sign In", substring = true))
        // (Add's "Personal access token" is GitHub's; no notebook or notes are named Personal.)
        assertEquals(0, shown("Personal"))
        assertEquals(0, shown("Personal notes", substring = true))
        compose.onNodeWithTag("gitSignIn").assertDoesNotExist()
        compose.onNodeWithTag("signIn").assertDoesNotExist()
    }

    @Test
    fun withAGitNotebookTheAppListsItToOpen() {
        val work = TestGraphs.addNotebook(app, graph, "Work")
        scenario = ActivityScenario.launch(MainActivity::class.java)
        settle()
        compose.waitUntil(5_000) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.onAllNodes(hasTestTag("gitNotebook-$work")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("gitFirstRun").assertDoesNotExist()
        compose.onNode(hasTestTag("gitOpen-$work")).performScrollTo().assertExists()
        assertEquals(0, shown("Sign In", substring = true))
    }

    @Test
    fun aNoteLinkOpensTheNoteInTheNotebookThatHoldsIt() {
        val work = TestGraphs.addNotebook(app, graph, "Work")
        val home = TestGraphs.addNotebook(app, graph, "Home")
        // The note is in Home's Room cache; Work is the Journal notebook.
        runBlocking { graph.git.graph(home).database.notes().insert(NoteEntity(garden, title = "Garden")) }
        scenario = ActivityScenario.launch(view("penmoss://note/$garden"))
        val opened = started()!!
        assertEquals(GitNotebookActivity::class.java.name, opened.component?.className)
        assertEquals(home, opened.getStringExtra(GitNotebookActivity.EXTRA_LOCAL_ID))
        assertEquals(garden, opened.getStringExtra(GitNotebookActivity.EXTRA_NOTE))
        assertEquals(work, graph.git.journal())
    }

    @Test
    fun aNoteLinkInNoNotebookOpensTheJournalNotebookAndWithNoneNothing() {
        scenario = ActivityScenario.launch(view("penmoss://note/$garden"))
        settle()
        assertNull(shadowOf(app).nextStartedActivity)
        val work = TestGraphs.addNotebook(app, graph, "Work")
        scenario!!.onActivity { InstrumentationRegistry.getInstrumentation().callActivityOnNewIntent(it, view("penmoss://note/$garden")) }
        val opened = started()!!
        assertEquals(work, opened.getStringExtra(GitNotebookActivity.EXTRA_LOCAL_ID))
        assertEquals(garden, opened.getStringExtra(GitNotebookActivity.EXTRA_NOTE))
    }

    /**
     * T40 P9 review S5 (A496): Recents reopens a task whose first intent was a link with that same
     * intent, flagged as from history. It was acted on already: nothing opens again.
     */
    @Test
    fun aNoteLinkRecentsReplaysOpensNothing() {
        TestGraphs.addNotebook(app, graph, "Work")
        scenario = ActivityScenario.launch(view("penmoss://note/$garden").addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
        settle()
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test
    fun aLauncherShortcutOpensTheJournalNotebookOnItsAction() {
        // With no notebook: the first run, nothing else.
        scenario = ActivityScenario.launch(launcher(LauncherShortcuts.ACTION_TODAY))
        settle()
        assertNull(shadowOf(app).nextStartedActivity)
        scenario!!.close()
        val work = TestGraphs.addNotebook(app, graph, "Work")
        scenario = ActivityScenario.launch(launcher(LauncherShortcuts.ACTION_TODAY))
        val opened = started()!!
        assertEquals(GitNotebookActivity::class.java.name, opened.component?.className)
        assertEquals(work, opened.getStringExtra(GitNotebookActivity.EXTRA_LOCAL_ID))
        assertEquals(LauncherAction.Today.name, opened.getStringExtra(GitNotebookActivity.EXTRA_ACTION))
    }

    /** A capture link sent to the app itself is not a note link: nothing opens (PL5). */
    @Test
    fun anyOtherLinkSentToTheAppOpensNothing() {
        TestGraphs.addNotebook(app, graph, "Work")
        scenario = ActivityScenario.launch(view("penmoss://capture"))
        settle()
        assertNull(shadowOf(app).nextStartedActivity)
        scenario!!.onActivity { InstrumentationRegistry.getInstrumentation().callActivityOnNewIntent(it, view("https://app.penmoss.app/android/callback?code=c&state=s")) }
        settle()
        assertNull(shadowOf(app).nextStartedActivity)
    }
}
