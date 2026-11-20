package app.penmoss.analytics

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.BuildConfig
import app.penmoss.DeviceGraph
import app.penmoss.engine.git.AddResult
import app.penmoss.git.GitNotebookActivity
import app.penmoss.git.firstrun.ConsentStep
import app.penmoss.graph
import app.penmoss.proof.ProofShot
import app.penmoss.ui.MainActivity
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.keys.LauncherAction
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonPrimitive
import org.eclipse.jgit.api.Git
import org.json.JSONArray
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * How far you scroll, in usage analytics on the phone (PEN-175, AC5, AC7, AC9, AC10), in the real
 * app:
 *
 * - The first run's consent step says What Is Recorded now names scrolling, scrolled into view and
 *   held (AC9).
 * - A notebook's drawer scrolled records `scroll sidebar`; Settings → Appearance scrolled records
 *   `scroll settings`; a long note with a callout, a code block and a task list, scrolled in the
 *   editor page, records `scroll note` with its position in hundredths (AC7); a tap on the
 *   callout's fold in the editor page records `click editor.callout.fold`, the id the Mac records
 *   (AC5); Note Actions opened records `click note.actions.open` (AC4). Settings → Privacy →
 *   Analytics Data then holds on Note Actions' row with the fold's and two scrolls, then ends on
 *   the fold's row with the three scrolls (AC4, AC10).
 *
 * The phone's own record, answered Don't Share, so nothing leaves it. Each test is its own proof,
 * with its own recording: `task proof:android -- app.penmoss.analytics.ScrollEventsTest#<test>`.
 */
@RunWith(AndroidJUnit4::class)
class ScrollEventsTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val graph: DeviceGraph get() = context.graph
    private val analytics: AnalyticsService get() = checkNotNull(graph.analytics) { "no usage analytics on this build" }

    /** The newest event's id before the test: only what the test makes counts. */
    private var since = 0L

    /** Each finger scroll's range before and after, for a failure's message. */
    private var diag = ""

    private fun hold() = SystemClock.sleep(2_500)

    @Test
    fun theConsentStepSaysScrollingIsRecorded() {
        run {
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.setContent { PenmossTheme { ConsentStep(lastStep = true, onAnswer = {}, openUrl = {}) } }
                }
                val screen = OnScreen(scenario)
                screen.text(AnalyticsCopy.text("consent.title"))
                assertEquals(
                    "The app’s and the system’s versions, the window’s size and layout, and how far you scroll",
                    AnalyticsCopy.text("consent.recorded.3"),
                )
                // What Is Recorded, scrolled so its list is in view, the new line with it.
                screen.reveal(screen.tagged("consent-recorded"), margin = 120f)
                screen.text(AnalyticsCopy.text("consent.recorded.title"))
                val line = screen.text(AnalyticsCopy.text("consent.recorded.3"))
                assertTrue("the line is on screen", line.boundsInWindow.height > 0f)
                assertFalse("the old line is gone", screen.has("The app’s and the system’s versions, and the window’s size and layout"))
                // Held long enough that the recording's stills reach it.
                SystemClock.sleep(6_000)
                assertTrue(screen.has(AnalyticsCopy.text("consent.recorded.3")))
                ProofShot.take()
            }
        }
    }

    @Test
    fun theNoteTheDrawerAndSettingsRecordHowFarTheyAreScrolledAndTheCalloutsFoldItsClick() {
        ready()
        val localId = runBlocking { graph.git.notebooks.entries().first().localId }
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val launcher = OnScreen.of(scenario)
            launcher.tap(launcher.text(runBlocking { graph.git.notebooks.entries().first().name }))
            val notebook = OnScreen.inFront()
            notebook.tagged("homeMenu")

            // The drawer long enough to scroll: more notebooks while it is too short.
            notebook.tap("homeMenu")
            drawerScrolls(notebook)

            // Settings → Appearance, its page scrolled by a finger.
            notebook.tap("drawerSettings")
            notebook.tap("section-appearance")
            notebook.tagged("appearanceSettingsPanel")
            scrollBy(notebook, "appearanceSettingsPanel", 0.6f)
            val settings = until("scroll settings") { scrolls("settings").firstOrNull() }
            assertPosition(settings)
            hold()

            // Back to the notebook's notes, the drawer pulled in from the edge and scrolled.
            back()
            until("Settings") { tag(notebook, "settingsSections") }
            back()
            until("the notebook's notes") { tag(notebook, "homeMenu") }
            SystemClock.sleep(800)
            dragAcross(notebook)
            if (tag(notebook, "homeDrawerList") == null) notebook.tap("homeMenu")
            until("the drawer") { tag(notebook, "homeDrawerList") }
            SystemClock.sleep(600)
            scrollBy(notebook, "homeDrawerList", 0.6f)
            val sidebar = until("scroll sidebar") { scrolls("sidebar").firstOrNull { it.id > settings.id } }
            assertPosition(sidebar)
            hold()

            // A long note with a callout, a code block and a task list, in the real editor page,
            // scrolled a little: the callout's fold stays in view.
            instrumentation.runOnMainSync { GitNotebookActivity.open(inFrontNow()!!, localId, LauncherAction.NewNote) }
            val page = until("the editor page") { editorPage() }
            until("the note open in the page") { js(page, "!!window.penmossEditor?.editor")?.takeIf { it == "true" } }
            js(page, "penmossEditor.editor.editor.commands.insertContent(${LONG_NOTE})")
            until("the note long enough to scroll") { js(page, SCROLLABLE)?.takeIf { it == "true" } }
            js(page, "document.activeElement?.blur()")
            hold()
            swipeUp(page, share = 0.15f)
            val note = until("scroll note") { scrolls("note").firstOrNull { it.id > sidebar.id } }
            assertPosition(note)
            hold()

            // The callout's fold, tapped where it shows: the same id the Mac records (AC5).
            val (x, y) = foldOnScreen(page)
            tapAt(x, y)
            val fold = until("click editor.callout.fold") { stored().firstOrNull { it.kind == "click" && it.name == "editor.callout.fold" && it.id > note.id } }
            assertTrue("the fold folded the callout", js(page, "document.querySelector('.pm-callout')?.dataset.open") == "\"false\"")
            assertEquals("the fold's tap scrolled nothing more", listOf(note), scrolls("note"))
            hold()

            // Note Actions, the note's ⋯: its own id, the Mac's too (AC4), never `menu.open`.
            val noteScreen = OnScreen.inFront()
            noteScreen.tap("noteMore")
            val actions = until("click note.actions.open") { stored().firstOrNull { it.kind == "click" && it.name == "note.actions.open" && it.id > fold.id } }
            assertFalse("no generic id", stored().any { it.kind == "click" && it.name == "menu.open" })
            // Its menu open on screen a moment (a popup of its own), then closed by Back.
            SystemClock.sleep(1_500)
            back()
            SystemClock.sleep(400)
            until("the note, its menu closed") { tag(noteScreen, "noteMore") }

            // Analytics Data, from All Notebooks: a finger first, so the large title folds away.
            // The five rows, with the screens and layouts recorded between them, run past a
            // phone's screen even at Display → Font Size's Small, as a person may have it (put back
            // after): first Note Actions' row, the newest, at the top, held; then the fold's row at
            // the top, the three scrolls below it, held to the end (AC10).
            smallerText()
            context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val home = OnScreen.inFront()
            home.tap("homeSettingsGear")
            home.tap("section-privacy")
            home.tap("privacyViewData")
            home.text(AnalyticsCopy.text("viewer.title"))
            scrollBy(home, "viewerList", 0.3f)
            home.reveal(home.text("click · note.actions.open"), margin = 48f)
            val first = listOf("click · note.actions.open", "click · editor.callout.fold", "scroll · note", "scroll · sidebar")
            for (row in first) assertTrue("$row is in view; it shows ${home.texts()}", inView(home, row))
            SystemClock.sleep(3_000)
            for (row in first) assertTrue("$row is still in view", inView(home, row))

            home.reveal(home.text("click · editor.callout.fold"), margin = 48f)
            val last = listOf("click · editor.callout.fold", "scroll · note", "scroll · sidebar", "scroll · settings")
            for (row in last) assertTrue("$row is in view; it shows ${home.texts()}", inView(home, row))
            // Each scroll's row shows the position it recorded.
            for (row in listOf(note, sidebar, settings)) assertTrue("${row.name}'s ${row.text} shows", home.has(row.text))
            hold()
            for (row in last) assertTrue("$row is still in view", inView(home, row))
            ProofShot.take()
        }
    }

    // The app's own recorder and a notebook, as WindowLayoutEventsTest has them.

    private fun ready() = runBlocking {
        Analytics.install(analytics)
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (analytics.state.value == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
        if (analytics.state.value?.answered != true) analytics.answer(ConsentAnswer.NO, BuildConfig.VERSION_NAME)
        if (graph.git.notebooks.entries().isEmpty()) addNotebook(NOTEBOOK)
        // Each area starts afresh: nothing dropped as a repeat of another test's position.
        instrumentation.runOnMainSync { ScrollEvents.forget() }
        WindowEvents.LAST.forget()
        LayoutEvents.LAST.forget()
        analytics.flush()
        since = analytics.store.page(null, null, 1).firstOrNull()?.id ?: 0L
    }

    private suspend fun addNotebook(name: String): String {
        val dir = File(context.cacheDir, "scroll-proof-${System.nanoTime()}.git")
        Git.init().setBare(true).setDirectory(dir).setInitialBranch("main").call().close()
        val added = graph.git.add("file://${dir.absolutePath}", null, null, name, null)
        check(added is AddResult.Added) { "the notebook was not added: $added" }
        return added.notebook.localId
    }

    private fun allNotebooks(): Intent = Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_ALL_NOTEBOOKS, true)

    private data class Stored(val id: Long, val kind: String, val name: String, val text: String, val props: JsonObject)

    /** The events since the test began, oldest first. */
    private fun stored(): List<Stored> = runBlocking {
        analytics.flush()
        analytics.store.page(null, null, 500).filter { it.id > since }.reversed()
            .map { Stored(it.id, it.kind, it.name, it.props, Json.parseToJsonElement(it.props) as JsonObject) }
    }

    private fun scrolls(area: String) = stored().filter { it.kind == "scroll" && it.name == area }

    /** A position: 0 to 1, in whole hundredths, and nothing else. */
    private fun assertPosition(row: Stored) {
        assertEquals(setOf("position"), row.props.keys)
        val position = row.props.getValue("position").jsonPrimitive.double
        assertTrue("$position", position in 0.0..1.0)
        assertEquals(position * 100, Math.round(position * 100).toDouble(), 1e-9)
    }

    private fun <T : Any> until(what: String, timeoutMs: Long = 30_000, read: () -> T?): T {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            read()?.let { return it }
            SystemClock.sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        throw AssertionError("no $what; diag$diag; recorded since: ${stored().map { "${it.kind} ${it.name} ${it.text}" }}")
    }

    private fun inFrontNow(): Activity? =
        androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
            .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).firstOrNull()

    /** Adds notebooks until the open drawer's list can scroll (a tall phone shows it whole). */
    private fun drawerScrolls(screen: OnScreen) {
        repeat(16) { index ->
            val range = screen.tagged("homeDrawerList").config.getOrNull(SemanticsProperties.VerticalScrollAxisRange)
            if (range != null && range.maxValue() > 1f) return
            runBlocking { addNotebook("Scroll Proof ${index + 1}") }
            SystemClock.sleep(500)
        }
        throw AssertionError("the drawer never scrolled")
    }

    /** Where the node tagged [tag] is scrolled now, read without scrolling anything to find it. */
    private fun rangeOf(screen: OnScreen, tag: String): String {
        val node = screen.nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == tag }
        val range = node?.config?.getOrNull(SemanticsProperties.VerticalScrollAxisRange)
        return "$tag=${range?.value?.invoke()}/${range?.maxValue?.invoke()}"
    }

    /** A finger drawn up the node tagged [tag], over [share] of its height, as a person scrolls it. */
    private fun scrollBy(screen: OnScreen, tag: String, share: Float) {
        val bounds = screen.tagged(tag).boundsInWindow
        val window = IntArray(2)
        instrumentation.runOnMainSync { inFrontNow()?.window?.decorView?.getLocationOnScreen(window) }
        val x = window[0] + bounds.center.x
        val from = window[1] + bounds.top + bounds.height * (0.5f + share / 2)
        val to = from - bounds.height * share
        val before = rangeOf(screen, tag)
        drag(x, from, to)
        SystemClock.sleep(600)
        val after = rangeOf(screen, tag)
        diag += " | $before → $after"
    }

    // The editor page.

    /** The note's editor page, the WebView on screen in front. */
    private fun editorPage(): WebView? {
        var found: WebView? = null
        instrumentation.runOnMainSync {
            fun walk(view: View) {
                if (found != null) return
                if (view is WebView && view.isShown && view.url?.contains("/editor/") == true) found = view
                if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
            }
            inFrontNow()?.window?.decorView?.let(::walk)
        }
        return found
    }

    /** evaluateJavascript on the main thread; the result JSON-encoded. */
    private fun js(page: WebView, expression: String): String? {
        val done = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            page.evaluateJavascript(expression) {
                result = it
                done.countDown()
            }
        }
        check(done.await(10, TimeUnit.SECONDS)) { "JS timed out: $expression" }
        return result
    }

    /** A finger drawn up the page from three quarters of the way down, over [share] of its height. */
    private fun swipeUp(view: View, share: Float = 0.5f) {
        val at = IntArray(2)
        instrumentation.runOnMainSync { view.getLocationOnScreen(at) }
        drag(at[0] + view.width / 2f, at[1] + view.height * 0.75f, at[1] + view.height * (0.75f - share))
    }

    /** The node tagged [tag] on screen now, if it is; nothing is scrolled to find it. */
    private fun tag(screen: OnScreen, tag: String): SemanticsNode? =
        screen.nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == tag }

    /** A finger from the screen's left edge across it, as a person pulls a drawer in. */
    private fun dragAcross(screen: OnScreen) {
        val metrics = context.resources.displayMetrics
        val y = metrics.heightPixels / 2f
        val down = SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, 4f, y, 0))
        for (step in 1..12) {
            instrumentation.sendPointerSync(MotionEvent.obtain(down, down + step * 20L, MotionEvent.ACTION_MOVE, 4f + metrics.widthPixels * 0.7f * step / 12, y, 0))
        }
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down + 300L, MotionEvent.ACTION_UP, 4f + metrics.widthPixels * 0.7f, y, 0))
        instrumentation.waitForIdleSync()
        SystemClock.sleep(800)
        screen.nodes()
    }

    /** Whether the text [text] shows whole inside Analytics Data's list, not under its bar or below it. */
    private fun inView(screen: OnScreen, text: String): Boolean {
        val list = tag(screen, "viewerList")?.boundsInWindow ?: return false
        val node = screen.nodes().firstOrNull { text in it.texts() } ?: return false
        val at = node.boundsInWindow
        return at.height > 0f && at.top >= list.top && at.bottom <= list.bottom
    }

    /** The system's font size before [smallerText], put back after each test. */
    private var fontScale: String? = null

    private fun shell(command: String): String =
        instrumentation.uiAutomation.executeShellCommand(command).let { fd ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().use { it.readText().trim() }
        }

    /** Display → Font Size a step smaller (0.85, Android's own "Small"). */
    private fun smallerText() {
        fontScale = shell("settings get system font_scale")
        shell("settings put system font_scale 0.85")
        SystemClock.sleep(500)
    }

    @After
    fun putTextBack() {
        val was = fontScale ?: return
        shell(if (was == "null" || was.isEmpty()) "settings delete system font_scale" else "settings put system font_scale $was")
        fontScale = null
    }

    private fun back() {
        instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        instrumentation.waitForIdleSync()
    }

    /** A finger from [from] to [to] at [x] on the screen, held still before it lifts (no fling). */
    private fun drag(x: Float, from: Float, to: Float) {
        val down = SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, from, 0))
        val steps = 12
        for (step in 1..steps) {
            val y = from + (to - from) * step / steps
            instrumentation.sendPointerSync(MotionEvent.obtain(down, down + step * 25L, MotionEvent.ACTION_MOVE, x, y, 0))
        }
        // Held still before it lifts: no fling, it stops where the finger did.
        SystemClock.sleep(150)
        instrumentation.sendPointerSync(MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, to, 0))
        instrumentation.waitForIdleSync()
    }

    /** Where the callout's fold shows on the screen, brought into view first. */
    private fun foldOnScreen(page: WebView): Pair<Float, Float> {
        val raw = js(page, FOLD_RECT) ?: error("no fold in the note")
        val rect = JSONArray(JSONTokener(raw).nextValue() as String)
        // Its scrolling into view settles before the tap.
        SystemClock.sleep(800)
        val again = JSONArray(JSONTokener(js(page, FOLD_RECT)!!).nextValue() as String)
        val at = IntArray(2)
        instrumentation.runOnMainSync { page.getLocationOnScreen(at) }
        val scale = rect.getDouble(2).toFloat()
        return at[0] + again.getDouble(0).toFloat() * scale to at[1] + again.getDouble(1).toFloat() * scale
    }

    /** A finger's tap at [x], [y] on the screen. */
    private fun tapAt(x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0))
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down + 60, MotionEvent.ACTION_UP, x, y, 0))
        instrumentation.waitForIdleSync()
    }

    private companion object {
        const val NOTEBOOK = "Scroll Proof"

        /** Whether the page can scroll: the note is longer than the WebView. */
        const val SCROLLABLE = "(() => { const p = document.scrollingElement; return p.scrollHeight - p.clientHeight > 200; })()"

        /** The fold's middle in CSS pixels, and the page's scale, once it is in view. */
        const val FOLD_RECT = """(() => {
            const fold = document.querySelector('.pm-callout-fold');
            if (!fold) return null;
            fold.scrollIntoView({ block: 'nearest' });
            const r = fold.getBoundingClientRect();
            return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2, window.devicePixelRatio]);
        })()"""

        private fun paragraph(text: String) = """{"type":"paragraph","content":[{"type":"text","text":"$text"}]}"""

        /**
         * The fixture note: paragraphs, a foldable callout, a code block and a task list, then
         * more paragraphs, as editor content (ProseMirror JSON) the page inserts.
         */
        val LONG_NOTE: String = buildList {
            for (i in 1..3) add(paragraph("Line $i of a long note about the garden, the kitchen and the week ahead, written to scroll."))
            add("""{"type":"callout","attrs":{"type":"tip","title":"Fold Me","foldable":true,"collapsed":false},"content":[${paragraph("Inside the callout: what the fold hides.")}]}""")
            add("""{"type":"codeBlock","attrs":{"language":"js"},"content":[{"type":"text","text":"const beans = ['runner', 'broad'];\nconsole.log(beans.length);"}]}""")
            add("""{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":false},"content":[${paragraph("Water the beans")}]},{"type":"taskItem","attrs":{"checked":true},"content":[${paragraph("Sow the peas")}]}]}""")
            for (i in 4..50) add(paragraph("Line $i of a long note about the garden, the kitchen and the week ahead, written to scroll."))
        }.joinToString(",", "[", "]")
    }
}
