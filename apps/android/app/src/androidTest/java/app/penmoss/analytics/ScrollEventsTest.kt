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
 *   (AC5). Settings → Privacy → Analytics Data then holds with those four rows in view (AC10).
 *
 * The phone's own record, answered Don't Share, so nothing leaves it. Run with
 * `task proof:android -- app.penmoss.analytics.ScrollEventsTest`.
 */
@RunWith(AndroidJUnit4::class)
class ScrollEventsTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val graph: DeviceGraph get() = context.graph
    private val analytics: AnalyticsService get() = checkNotNull(graph.analytics) { "no usage analytics on this build" }

    /** The newest event's id before the test: only what the test makes counts. */
    private var since = 0L

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
                hold()
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

            // The drawer, long enough to scroll (more notebooks while it is too short), scrolled.
            notebook.tap("homeMenu")
            drawerScrolls(notebook)
            scrollBy(notebook, "homeDrawerList", 0.6f)
            val sidebar = until("scroll sidebar") { scrolls("sidebar").firstOrNull() }
            assertPosition(sidebar)
            hold()

            // Settings → Appearance, its page scrolled.
            notebook.tap("drawerSettings")
            notebook.tap("section-appearance")
            notebook.tagged("appearanceSettingsPanel")
            scrollBy(notebook, "appearanceSettingsPanel", 0.6f)
            val settings = until("scroll settings") { scrolls("settings").firstOrNull { it.id > sidebar.id } }
            assertPosition(settings)
            hold()

            // A long note with a callout, a code block and a task list, in the real editor page.
            instrumentation.runOnMainSync { GitNotebookActivity.open(inFrontNow()!!, localId, LauncherAction.NewNote) }
            val page = until("the editor page") { editorPage() }
            until("the note open in the page") { js(page, "!!window.penmossEditor?.editor")?.takeIf { it == "true" } }
            js(page, "penmossEditor.editor.editor.commands.insertContent(${LONG_NOTE})")
            until("the note long enough to scroll") { js(page, SCROLLABLE)?.takeIf { it == "true" } }
            hold()
            swipeUp(page)
            val note = until("scroll note") { scrolls("note").firstOrNull { it.id > settings.id } }
            assertPosition(note)
            hold()

            // The callout's fold, tapped where it shows: the same id the Mac records (AC5).
            val (x, y) = foldOnScreen(page)
            tapAt(x, y)
            val fold = until("click editor.callout.fold") { stored().firstOrNull { it.kind == "click" && it.name == "editor.callout.fold" && it.id > note.id } }
            assertTrue("the fold folded the callout", js(page, "document.querySelector('.pm-callout')?.dataset.open") == "\"false\"")
            hold()

            // Analytics Data, from All Notebooks, with the four rows in view.
            context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val home = OnScreen.inFront()
            home.tap("homeSettingsGear")
            home.tap("section-privacy")
            home.tap("privacyViewData")
            home.text(AnalyticsCopy.text("viewer.title"))
            val list = home.tagged("viewerList").boundsInWindow.height
            // The oldest of the four, the drawer's, near the bottom; the newer ones above it.
            val oldest = home.text("scroll · sidebar")
            home.reveal(oldest, margin = list - oldest.size.height - list * 0.08f)
            for (row in listOf(sidebar, settings, note, fold)) {
                assertTrue("the row ${row.kind} · ${row.name} ${row.text} is on screen", home.has("${row.kind} · ${row.name}") && (row.text == "{}" || home.has(row.text)))
            }
            hold()
            assertTrue(home.has("scroll · note"))
            assertTrue(home.has("scroll · sidebar"))
            assertTrue(home.has("scroll · settings"))
            assertTrue(home.has("click · editor.callout.fold"))
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
        throw AssertionError("no $what; recorded since: ${stored().map { "${it.kind} ${it.name} ${it.text}" }}")
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

    /** Scrolls the node tagged [tag] down by [share] of its height, as a person's swipe would. */
    private fun scrollBy(screen: OnScreen, tag: String, share: Float) {
        val node: SemanticsNode = screen.tagged(tag)
        var ok = false
        instrumentation.runOnMainSync {
            ok = node.config.getOrNull(SemanticsActions.ScrollBy)?.action?.invoke(0f, node.boundsInWindow.height * share) == true
        }
        check(ok) { "[$tag] did not scroll" }
        instrumentation.waitForIdleSync()
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

    /** A finger drawn up the page, from three quarters of the way down to a quarter. */
    private fun swipeUp(view: View) {
        val at = IntArray(2)
        instrumentation.runOnMainSync { view.getLocationOnScreen(at) }
        val x = at[0] + view.width / 2f
        val from = at[1] + view.height * 0.75f
        val to = at[1] + view.height * 0.25f
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
            fold.scrollIntoView({ block: 'center' });
            const r = fold.getBoundingClientRect();
            return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2, window.devicePixelRatio]);
        })()"""

        private fun paragraph(text: String) = """{"type":"paragraph","content":[{"type":"text","text":"$text"}]}"""

        /**
         * The fixture note: paragraphs, a foldable callout, a code block and a task list, then
         * more paragraphs, as editor content (ProseMirror JSON) the page inserts.
         */
        val LONG_NOTE: String = buildList {
            for (i in 1..12) add(paragraph("Line $i of a long note about the garden, the kitchen and the week ahead, written to scroll."))
            add("""{"type":"callout","attrs":{"type":"tip","title":"Fold Me","foldable":true,"collapsed":false},"content":[${paragraph("Inside the callout: what the fold hides.")}]}""")
            add("""{"type":"codeBlock","attrs":{"language":"js"},"content":[{"type":"text","text":"const beans = ['runner', 'broad'];\nconsole.log(beans.length);"}]}""")
            add("""{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":false},"content":[${paragraph("Water the beans")}]},{"type":"taskItem","attrs":{"checked":true},"content":[${paragraph("Sow the peas")}]}]}""")
            for (i in 13..40) add(paragraph("Line $i of a long note about the garden, the kitchen and the week ahead, written to scroll."))
        }.joinToString(",", "[", "]")
    }
}
