package app.penmoss.analytics

import android.app.Activity
import android.app.UiAutomation
import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.BuildConfig
import app.penmoss.DeviceGraph
import app.penmoss.capture.CaptureActivity
import app.penmoss.engine.git.AddResult
import app.penmoss.git.GitNotebookActivity
import app.penmoss.graph
import app.penmoss.proof.ProofShot
import app.penmoss.ui.MainActivity
import app.penmoss.ui.keys.LauncherAction
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.eclipse.jgit.api.Git
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The window's size and layout in usage analytics on the phone (PEN-174, ac4, ac5, ac8), in the
 * real app: the launcher ([MainActivity]) records `app window` for `main` as it lays out, a
 * rotation records the swapped size once, and the notebook it opens at the same size records
 * nothing more; Quick Capture's sheet ([CaptureActivity]) records `capture`, and once more when a
 * rotation makes it again; a notebook's own screens record `app layout` after the drawer's
 * `click sidebar.drawer.open` and the note panel's `click note.info`, and a notebook turned and its
 * drawer opened and closed shows its window and layout rows together. Each test ends on Settings →
 * Privacy → View Analytics Data with those rows on screen. The phone's own record, answered Don't
 * Share, so nothing leaves it. Run with
 * `task proof:android -- app.penmoss.analytics.WindowLayoutEventsTest`.
 */
@RunWith(AndroidJUnit4::class)
class WindowLayoutEventsTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val graph: DeviceGraph get() = context.graph
    private val analytics: AnalyticsService get() = checkNotNull(graph.analytics) { "no usage analytics on this build" }

    /** The newest event's id before the test: only what the test makes counts. */
    private var since = 0L

    @Before
    fun ready() = runBlocking {
        // Answered (Don't Share), so the launcher shows All Notebooks rather than the question.
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (analytics.state.value == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
        if (analytics.state.value?.answered != true) analytics.answer(ConsentAnswer.NO, BuildConfig.VERSION_NAME)
        notebook()
        // Each test starts afresh, as a new session would: nothing dropped as a repeat of another test's.
        WindowEvents.LAST.forget()
        LayoutEvents.LAST.forget()
        analytics.flush()
        since = analytics.store.page(null, null, 1).firstOrNull()?.id ?: 0L
    }

    @After
    fun upright() {
        instrumentation.uiAutomation.setRotation(UiAutomation.ROTATION_FREEZE_0)
        instrumentation.uiAutomation.setRotation(UiAutomation.ROTATION_UNFREEZE)
    }

    /** A notebook on this phone, from a bare repository beside the app's files; its local id. */
    private fun notebook(): String = runBlocking {
        graph.git.notebooks.entries().firstOrNull()?.let { return@runBlocking it.localId }
        val dir = File(context.cacheDir, "window-proof-${System.nanoTime()}.git")
        Git.init().setBare(true).setDirectory(dir).setInitialBranch("main").call().close()
        val added = graph.git.add("file://${dir.absolutePath}", null, null, NOTEBOOK, null)
        check(added is AddResult.Added) { "the notebook was not added: $added" }
        added.notebook.localId
    }

    private data class Stored(val id: Long, val kind: String, val name: String, val text: String, val props: JsonObject)

    /** The events since the test began, oldest first. */
    private fun stored(): List<Stored> = runBlocking {
        analytics.flush()
        analytics.store.page(null, null, 500).filter { it.id > since }.reversed()
            .map { Stored(it.id, it.kind, it.name, it.props, Json.parseToJsonElement(it.props) as JsonObject) }
    }

    private fun windows(which: String) = stored().filter { it.kind == "app" && it.name == "window" && it.props.str("window") == which }

    private fun layouts() = stored().filter { it.kind == "app" && it.name == "layout" }

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content

    private fun JsonObject.num(key: String) = getValue(key).jsonPrimitive.int

    private fun <T : Any> until(what: String, timeoutMs: Long = 30_000, read: () -> T?): T {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            read()?.let { return it }
            SystemClock.sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        throw AssertionError("no $what; recorded since: ${stored().map { "${it.kind} ${it.name} ${it.text}" }}")
    }

    /** The Activity's window in dp, rounded as the event rounds it. */
    private fun sizeOf(activity: Activity): Pair<Int, Int> {
        val shape = WindowEvents.shapeOf(activity as ComponentActivity)
        return AnalyticsFormat.lengthOf(shape.widthDp) to AnalyticsFormat.lengthOf(shape.heightDp)
    }

    private fun Stored.size() = props.num("width") to props.num("height")

    /** Turns the phone, as a person turning it would; the app follows. */
    private fun turn(landscape: Boolean) {
        instrumentation.uiAutomation.setRotation(if (landscape) UiAutomation.ROTATION_FREEZE_90 else UiAutomation.ROTATION_FREEZE_0)
        instrumentation.waitForIdleSync()
    }

    private fun hold() = SystemClock.sleep(2_500)

    /** The app's activity in front now, if one is (on the main thread). */
    private fun inFrontNow(): Activity? =
        androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
            .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).firstOrNull()

    /** The [kind] of activity in front, once it is. */
    private fun inFront(kind: Class<out Activity>): Activity = until("${kind.simpleName} in front") {
        var found: Activity? = null
        instrumentation.runOnMainSync { found = inFrontNow()?.takeIf { kind.isInstance(it) } }
        found
    }

    private fun allNotebooks(): Intent = Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_ALL_NOTEBOOKS, true)

    /** From All Notebooks: the gear, Privacy, View Analytics Data. */
    private fun analyticsData(screen: OnScreen) {
        screen.tap("homeSettingsGear")
        screen.tap("section-privacy")
        screen.tap("privacyViewData")
        screen.text(AnalyticsCopy.text("viewer.title"))
    }

    /** Scrolls Analytics Data so [row]'s props sit halfway down, the newer rows above them in sight. */
    private fun showRow(screen: OnScreen, row: Stored) {
        val node = screen.text(row.text)
        screen.reveal(node, margin = screen.tagged("viewerList").boundsInWindow.height * 0.5f)
        assertTrue("the row ${row.text} is on screen", screen.has(row.text))
    }

    /**
     * Scrolls Analytics Data so the [older] row sits near the bottom of the list, with the
     * [newer] one above it: both in sight, whatever rows were recorded between them.
     */
    private fun showRows(screen: OnScreen, older: Stored, newer: Stored) {
        val node = screen.text(older.text)
        val list = screen.tagged("viewerList").boundsInWindow.height
        screen.reveal(node, margin = list - node.size.height - list * 0.08f)
        assertTrue("the row ${older.text} is on screen", screen.has(older.text))
        assertTrue("the row ${newer.text} is on screen", screen.has(newer.text))
    }

    @Test
    fun theLauncherRecordsItsSizeAndARotationOnce() {
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val screen = OnScreen.of(scenario)
            screen.tagged("homeSettingsGear")
            var portrait = 0 to 0
            scenario.onActivity { portrait = sizeOf(it) }
            // As the launcher lays out: main, its size in dp to 10, full screen, no maximised (ac4).
            val first = until("the launcher's app window") { windows("main").firstOrNull() }
            assertEquals(portrait, first.size())
            assertEquals(0, first.props.num("width") % 10)
            assertTrue(first.props.getValue("fullScreen").jsonPrimitive.boolean)
            assertFalse("no maximised on Android", "maximised" in first.props)
            hold()

            // Turned: one record, once it settles, with the sides swapped (ac5).
            turn(landscape = true)
            val turned = until("the launcher's landscape app window") { windows("main").drop(1).firstOrNull() }
            assertEquals(portrait.second to portrait.first, turned.size())
            SystemClock.sleep(1_500)
            assertEquals("one record for the turn", 2, windows("main").size)
            screen.tagged("homeSettingsGear")
            hold()

            // Back upright: one more.
            turn(landscape = false)
            val upright = until("the launcher's upright app window") { windows("main").drop(2).firstOrNull() }
            assertEquals(portrait, upright.size())

            // Analytics Data: the launcher's three window rows, the turned one in the middle.
            analyticsData(screen)
            showRow(screen, turned)
            assertTrue(screen.has(upright.text))
            hold()
            assertTrue(screen.has(turned.text))
            ProofShot.take()
        }
    }

    @Test
    fun quickCaptureRecordsItsSizeAndAgainWhenARotationMakesItAgain() {
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val screen = OnScreen.of(scenario)
            screen.tagged("homeSettingsGear")
            // Quick Capture's sheet over the launcher, as the app's own Quick Capture opens it.
            scenario.onActivity { it.startActivity(Intent(it, CaptureActivity::class.java)) }
            val first = until("Quick Capture's app window") { windows("capture").firstOrNull() }
            val upright = sizeOf(inFront(CaptureActivity::class.java))
            // The sheet: capture, its size in dp to 10 (ac4).
            assertEquals(upright, first.size())
            assertTrue(first.props.getValue("fullScreen").jsonPrimitive.boolean)
            assertFalse("no maximised on Android", "maximised" in first.props)
            hold()

            // Turned: the sheet is made again, and its new first layout records the new size, once (ac5).
            turn(landscape = true)
            val turned = until("Quick Capture's landscape app window") { windows("capture").drop(1).firstOrNull() }
            assertEquals(upright.second to upright.first, turned.size())
            assertTrue("made again", inFront(CaptureActivity::class.java).let { sizeOf(it) } == turned.size())
            SystemClock.sleep(1_500)
            assertEquals("one record for the turn", 2, windows("capture").size)
            hold()

            // The sheet closed, and the phone upright: Analytics Data, from the launcher, with the
            // sheet's two rows, the turned one first.
            instrumentation.runOnMainSync { inFrontNow()?.takeIf { it is CaptureActivity }?.finish() }
            turn(landscape = false)
            screen.tagged("homeSettingsGear")
            analyticsData(screen)
            showRows(screen, older = first, newer = turned)
            hold()
            assertTrue(screen.has(first.text))
            assertTrue(screen.has(turned.text))
            ProofShot.take()
        }
    }

    @Test
    fun aNotebookRecordsItsLayoutAfterTheDrawersAndThePanelsClicks() {
        val name = runBlocking { graph.git.notebooks.entries().first().name }
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val launcher = OnScreen.of(scenario)
            val window = until("the launcher's app window") { windows("main").firstOrNull() }

            // The notebook opens at the same size: no second window record (ac4), and its layout (ac8).
            launcher.tap(launcher.text(name))
            val notebook = OnScreen.inFront()
            notebook.tagged("homeMenu")
            val start = until("the notebook's app layout") { layouts().firstOrNull() }
            assertEquals("main", start.props.str("window"))
            assertEquals("hidden", start.props.str("sidebar"))
            assertEquals("none", start.props.str("panel"))
            assertTrue(start.props.str("themeMode") in AnalyticsCatalogue.THEME_MODES)
            assertFalse("no tabs on a phone", "tabs" in start.props)
            assertFalse("the drawer has no width of its own", "sidebarWidth" in start.props)
            SystemClock.sleep(1_500)
            assertEquals("the notebook at the launcher's size records nothing", listOf(window), windows("main"))

            // The drawer: its click, then the layout, sidebar shown.
            notebook.tap("homeMenu")
            notebook.tagged("drawerSettings")
            val shown = until("the layout with the drawer shown") { layouts().firstOrNull { it.props.str("sidebar") == "shown" } }
            val drawerClick = stored().single { it.kind == "click" && it.name == "sidebar.drawer.open" }
            assertTrue("the click comes first", drawerClick.id < shown.id)
            hold()
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            until("the layout with the drawer hidden again") { layouts().lastOrNull()?.takeIf { it.id > shown.id && it.props.str("sidebar") == "hidden" } }

            // A note (the launcher shortcut's New Note), and its panel: Info's click, then the layout.
            val localId = runBlocking { graph.git.notebooks.entries().first().localId }
            val notebookActivity = inFront(GitNotebookActivity::class.java)
            instrumentation.runOnMainSync { GitNotebookActivity.open(notebookActivity, localId, LauncherAction.NewNote) }
            notebook.tap("noteInfo")
            notebook.tagged("panelClose")
            val open = until("the layout with the panel open") { layouts().firstOrNull { it.props.str("panel") == "open" } }
            val infoClick = stored().last { it.kind == "click" && it.name == "note.info" }
            assertTrue("the click comes first", infoClick.id < open.id)
            hold()
            notebook.tap("panelClose")
            until("the layout with the panel closed") { layouts().lastOrNull()?.takeIf { it.id > open.id && it.props.str("panel") == "closed" } }

            // Analytics Data, from All Notebooks: the panel's click and layout, then the drawer's.
            context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val home = OnScreen.inFront()
            analyticsData(home)
            showRow(home, open)
            assertTrue(home.has("click · note.info"))
            hold()
            showRow(home, shown)
            assertTrue(home.has("click · sidebar.drawer.open"))
            hold()
            assertTrue(home.has(shown.text))
            ProofShot.take()
        }
    }

    /**
     * Ryan's review: Analytics Data on the phone with a notebook's `app window` rows after a turn,
     * and its `app layout` rows after the drawer opened and closed, in sight together (ac4, ac5, ac8).
     */
    @Test
    fun aNotebookTurnedAndItsDrawerOpenedAndClosedShowsItsWindowAndLayoutRows() {
        val name = runBlocking { graph.git.notebooks.entries().first().name }
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val launcher = OnScreen.of(scenario)
            until("the launcher's app window") { windows("main").firstOrNull() }
            launcher.tap(launcher.text(name))
            val notebook = OnScreen.inFront()
            notebook.tagged("homeMenu")
            until("the notebook's app layout") { layouts().firstOrNull() }
            val upright = sizeOf(inFront(GitNotebookActivity::class.java))

            // Turned, in the notebook: one app window, the sides swapped (ac5).
            val before = windows("main").size
            turn(landscape = true)
            val turned = until("the notebook's landscape app window") { windows("main").drop(before).firstOrNull() }
            assertEquals(upright.second to upright.first, turned.size())
            notebook.tagged("homeMenu")
            hold()
            turn(landscape = false)
            val back = until("the notebook's upright app window") { windows("main").drop(before + 1).firstOrNull() }
            assertEquals(upright, back.size())

            // The drawer opened, then closed: a layout for each, sidebar shown, then hidden (ac8).
            notebook.tap("homeMenu")
            notebook.tagged("drawerSettings")
            val shown = until("the layout with the drawer shown") { layouts().lastOrNull()?.takeIf { it.id > back.id && it.props.str("sidebar") == "shown" } }
            hold()
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            val hidden = until("the layout with the drawer hidden again") { layouts().lastOrNull()?.takeIf { it.id > shown.id && it.props.str("sidebar") == "hidden" } }
            assertTrue(stored().any { it.kind == "click" && it.name == "sidebar.drawer.open" && it.id < shown.id })

            // Analytics Data, from All Notebooks: the turned window's row near the bottom, and the
            // drawer's two layout rows above it, all in sight.
            context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val home = OnScreen.inFront()
            analyticsData(home)
            showRows(home, older = turned, newer = hidden)
            assertTrue("the drawer-shown layout row is on screen", home.has(shown.text))
            assertTrue("the upright window row is on screen", home.has(back.text))
            hold()
            assertTrue(home.has(turned.text))
            assertTrue(home.has(hidden.text))
            ProofShot.take()
        }
    }

    private companion object {
        const val NOTEBOOK = "Window Proof"
    }
}
