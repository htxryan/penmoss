package app.penmoss.analytics

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import app.penmoss.git.firstrun.ConsentGate
import app.penmoss.git.firstrun.ConsentStep
import app.penmoss.graph
import app.penmoss.proof.ProofShot
import app.penmoss.ui.MainActivity
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.keys.LauncherAction
import app.penmoss.ui.settings.PrivacyActions
import app.penmoss.ui.settings.PrivacyScreen
import app.penmoss.ui.settings.PrivacyUi
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.eclipse.jgit.api.Git
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Session detail on the phone (PEN-177), in the real app, Don't Share answered so nothing leaves:
 *
 * - The consent step on the first run, and the question before Home, name the shape of notes and
 *   how much you type, never the words (AC20).
 * - A note shown records `note open` with its blocks as tokens, and a change of blocks `note
 *   blocks` (AC5); typing records `note typing` bursts with counts only (AC8); both by the note's
 *   ref, 16 hex characters, never its id, title or path (AC1, AC2).
 * - Search records the length typed in it, never the words (AC14).
 * - The notes list's tree records a folder opened and left, and a note opened from it, by refs (AC15).
 * - Analytics Data shows the new rows as key: value, a long list cut to "… +N" (AC21); Advanced's
 *   Keep at Most reads "200,000" (AC16); Delete My Shared Data asks first (AC23).
 *
 * Each test is its own proof: `task proof:android -- app.penmoss.analytics.SessionDetailTest#<test>`.
 */
@RunWith(AndroidJUnit4::class)
class SessionDetailTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val graph: DeviceGraph get() = context.graph
    private val analytics: AnalyticsService get() = checkNotNull(graph.analytics) { "no usage analytics on this build" }

    /** The newest event's id before the test: only what the test makes counts. */
    private var since = 0L

    private fun hold() = SystemClock.sleep(2_500)

    /** The app's own recorder, put back after each test that swaps it. */
    private val appRecorder = Analytics.service

    @After
    fun putBack() {
        Analytics.install(appRecorder)
        val was = fontScale ?: return
        shell(if (was == "null" || was.isEmpty()) "settings delete system font_scale" else "settings put system font_scale $was")
        fontScale = null
    }

    // AC20: the consent's new line, on the first run and before Home.

    @Test
    fun consentShowsShapeLine() {
        val line = AnalyticsCopy.text("consent.recorded.5")
        assertEquals("The shape of your notes and how much you type, never the words", line)
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent { PenmossTheme { ConsentStep(lastStep = true, onAnswer = {}, openUrl = {}) } }
            }
            val screen = OnScreen(scenario)
            screen.text(AnalyticsCopy.text("consent.lastStep.label"))
            screen.reveal(screen.tagged("consent-recorded"), margin = 120f)
            screen.text(AnalyticsCopy.text("consent.recorded.title"))
            assertTrue("the line is on screen", screen.text(line).boundsInWindow.height > 0f)
            SystemClock.sleep(3_000)

            // Before Home, on a phone that had notebooks before the question: no step bar.
            TestAnalytics().use { phone ->
                scenario.onActivity { activity ->
                    activity.setContent { PenmossTheme { ConsentGate(phone.service, openUrl = {}) { Text("Home of Notebooks") } } }
                }
                // The same activity: the first run's step is gone once the gate has drawn.
                screen.waitFor("the gate, with no step bar") {
                    true.takeIf { !screen.has(AnalyticsCopy.text("consent.lastStep.label")) }
                }
                screen.text(AnalyticsCopy.text("consent.title"))
                assertFalse(screen.has(AnalyticsCopy.text("consent.lastStep.label")))
                screen.reveal(screen.tagged("consent-recorded"), margin = 120f)
                screen.text(AnalyticsCopy.text("consent.recorded.title"))
                assertTrue("the line is on screen before Home", screen.text(line).boundsInWindow.height > 0f)
                SystemClock.sleep(3_000)
                assertTrue(screen.has(line))
                ProofShot.take()
            }
        }
    }

    // AC5, AC1, AC2: a note's shape, by ref.

    @Test
    fun noteOpenRecordsShape() {
        ready()
        val localId = runBlocking { graph.git.notebooks.entries().first().localId }
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val launcher = OnScreen.of(scenario)
            launcher.tap(launcher.text(runBlocking { graph.git.notebooks.entries().first().name }))
            OnScreen.inFront().tagged("homeMenu")
            val (page, noteId) = newNote(localId)
            js(page, "penmossEditor.editor.editor.commands.insertContent($SHAPED_NOTE)")
            setTitle(page, TITLE)
            val opened = until("note open") { notes("open").firstOrNull() }
            val ref = opened.props.getValue("note").jsonPrimitive.content
            assertTrue(ref, SessionDetail.REF.matches(ref))
            val blocks = until("note blocks") { notes("blocks").firstOrNull() }
            assertEquals(ref, blocks.props.getValue("note").jsonPrimitive.content)
            // The note shown again: its shape, every block in order, by the same ref (AC2).
            js(page, "document.activeElement?.blur()")
            SystemClock.sleep(1_500)
            back()
            until("the notebook's notes") { tag(OnScreen.inFront(), "homeMenu") }
            instrumentation.runOnMainSync { GitNotebookActivity.open(inFrontNow()!!, localId, note = noteId) }
            until("the note again") { editorPage()?.takeIf { js(it, "window.penmossEditor?.openNoteId") == "\"$noteId\"" } }
            val again = until("note open again") { notes("open").firstOrNull { it.id > blocks.id } }
            assertEquals(ref, again.props.getValue("note").jsonPrimitive.content)
            val shape = (again.props.getValue("shape") as JsonArray).map { it.jsonPrimitive.content }
            for (token in shape) assertTrue(token, SessionDetail.BLOCK.matches(token))
            assertEquals(listOf("h1:11", "p:31", "li.b.1:5", "li.b.1:4", "hr"), shape.filter { it != "p:0" })
            assertEquals(TITLE.length, again.props.getValue("titleChars").jsonPrimitive.int)
            noIdTitleOrPath(noteId)
            hold()
            ProofShot.take()
        }
    }

    // AC8, then AC21: typing bursts, and the rows in Analytics Data.

    @Test
    fun typingRecordsBursts() {
        ready()
        val localId = runBlocking { graph.git.notebooks.entries().first().localId }
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val launcher = OnScreen.of(scenario)
            launcher.tap(launcher.text(runBlocking { graph.git.notebooks.entries().first().name }))
            OnScreen.inFront().tagged("homeMenu")
            val (page, noteId) = newNote(localId)
            // A long note first, so its splice's list of blocks is cut in the viewer.
            js(page, "penmossEditor.editor.editor.commands.insertContent($LONG_NOTE)")
            until("note blocks") { notes("blocks").firstOrNull() }
            // Forty characters over about three seconds, at the end of the note.
            js(page, "penmossEditor.editor.editor.commands.focus('end')")
            repeat(40) {
                js(page, "penmossEditor.editor.editor.commands.insertContent('q')")
                SystemClock.sleep(75)
            }
            val bursts = until("forty characters in bursts") {
                notes("typing").takeIf { rows -> rows.sumOf { it.props.getValue("typed").jsonPrimitive.int } >= 40 }
            }
            assertEquals(40, bursts.sumOf { it.props.getValue("typed").jsonPrimitive.int })
            assertTrue("${bursts.size} bursts", bursts.size in 2..10)
            for (burst in bursts) {
                assertTrue(burst.text, burst.props.keys.all { it in setOf("note", "block", "typed", "deleted") })
                assertFalse("no character recorded: ${burst.text}", burst.text.contains("q\""))
            }
            val refs = notes(null).map { it.props.getValue("note").jsonPrimitive.content }.toSet()
            assertEquals("one note, one ref", 1, refs.size)
            noIdTitleOrPath(noteId)
            hold()

            // Analytics Data: the splice's row cut to "… +N", the typing rows below it.
            smallerText()
            context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val home = OnScreen.inFront()
            home.tap("homeSettingsGear")
            home.tap("section-privacy")
            home.tap("privacyViewData")
            home.text(AnalyticsCopy.text("viewer.title"))
            val typing = home.waitFor("a typing row") { home.nodes().firstOrNull { "note · typing" in it.texts() } }
            home.reveal(typing, margin = 48f)
            assertTrue("the typing row is in view; it shows ${home.texts()}", inView(home, "note · typing"))
            // The long note's shape (a note open's, or a splice's inserted blocks), cut to "… +N".
            val cut = home.waitFor("the cut list") { home.texts().firstOrNull { "… +" in it } }
            assertTrue(cut, Regex("(shape|inserted): (\\S+ ){12}… \\+\\d+").containsMatchIn(cut))
            home.reveal(home.text(cut), margin = 48f)
            assertTrue("the cut row is in view", inView(home, cut))
            assertTrue("the typing row is in view too", inView(home, "note · typing"))
            hold()
            assertTrue(inView(home, cut))
            ProofShot.take()
        }
    }

    // AC14: search's typed length, never its words.

    @Test
    fun searchRecordsLength() {
        ready()
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val launcher = OnScreen.of(scenario)
            launcher.tap(launcher.text(runBlocking { graph.git.notebooks.entries().first().name }))
            val notebook = OnScreen.inFront()
            notebook.tagged("homeMenu")
            notebook.tap("homeSearch")
            notebook.type("searchField", "garden beans")
            val typed = until("input search") { stored().firstOrNull { it.kind == "input" && it.name == "search" } }
            assertEquals("""{"field":"query","chars":12}""", typed.text)
            assertFalse(stored().any { "garden" in it.text })
            // The words stay in the field, on screen only.
            notebook.waitFor("the words in the field") {
                true.takeIf {
                    notebook.tagged("searchField").config.getOrNull(SemanticsProperties.EditableText)?.text == "garden beans"
                }
            }
            hold()
            ProofShot.take()
        }
    }

    // AC15: the notes list's tree, by refs.

    @Test
    fun drawerTreeRecordsRefs() {
        ready()
        val localId = runBlocking { graph.git.notebooks.entries().first().localId }
        val folderId = checkNotNull(runBlocking { graph.git.graph(localId).store.createFolder(FOLDER, null) }) { "no folder made" }
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val launcher = OnScreen.of(scenario)
            launcher.tap(launcher.text(runBlocking { graph.git.notebooks.entries().first().name }))
            OnScreen.inFront().tagged("homeMenu")
            // A note at the top level, titled, so the list shows it.
            val (page, noteId) = newNote(localId)
            js(page, "penmossEditor.editor.editor.commands.insertContent('Rows of beans.')")
            setTitle(page, TREE_NOTE)
            js(page, "document.activeElement?.blur()")
            SystemClock.sleep(1_500)
            back()
            val home = OnScreen.inFront()
            until("the notebook's notes") { tag(home, "homeMenu") }
            val key = runBlocking { analytics.stateNow().refKey }

            // The folder opened from the list, then left by its Back.
            val folder = home.waitFor("the folder's row") { home.nodes().firstOrNull { FOLDER in it.texts() } }
            home.reveal(folder, margin = 200f)
            home.tap(home.text(FOLDER))
            val expand = until("tree expand") { stored().firstOrNull { it.kind == "tree" && it.name == "expand" } }
            assertEquals(AnalyticsRefs.refOf(key, "folder", folderId), expand.props.getValue("folder").jsonPrimitive.content)
            assertEquals(0, expand.props.getValue("depth").jsonPrimitive.int)
            assertEquals("click", expand.props.getValue("source").jsonPrimitive.content)
            SystemClock.sleep(1_500)
            val back = home.waitFor("Back") { home.nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.ContentDescription)?.contains("Back") == true } }
            home.tap(back)
            val collapse = until("tree collapse") { stored().firstOrNull { it.kind == "tree" && it.name == "collapse" } }
            assertEquals(expand.props.getValue("folder"), collapse.props.getValue("folder"))

            // The note opened from the list, at the top level: no folder.
            until("the notebook's notes again") { tag(home, "homeMenu") }
            val row = home.waitFor("the note's row") { home.nodes().firstOrNull { TREE_NOTE in it.texts() } }
            home.reveal(row, margin = 200f)
            home.tap(home.text(TREE_NOTE))
            val open = until("tree open") { stored().firstOrNull { it.kind == "tree" && it.name == "open" } }
            assertEquals(AnalyticsRefs.refOf(key, "note", noteId), open.props.getValue("note").jsonPrimitive.content)
            assertFalse("folder" in open.props)
            assertEquals(0, open.props.getValue("depth").jsonPrimitive.int)
            for (event in stored()) assertFalse(event.text, event.text.contains(folderId) || event.text.contains(FOLDER) || event.text.contains(noteId))
            until("the note open") { editorPage() }
            hold()
            ProofShot.take()
        }
    }

    // AC16: Keep at Most's new default, grouped.

    @Test
    fun keepAtMostShowsTheNewDefault() {
        TestAnalytics().use { phone ->
            Analytics.install(phone.service)
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.setContent {
                        PenmossTheme {
                            var limits by remember { mutableStateOf(Limits.DEFAULTS) }
                            PrivacyScreen(PrivacyUi(install = "0".repeat(32), limits = limits), PrivacyActions(onLimits = { limits = it }))
                        }
                    }
                }
                val screen = OnScreen(scenario)
                screen.tap("privacyAdvanced")
                // Keep at Most's field, its digits grouped, with its range and the space line.
                val most = { screen.tagged("limit-events.max").config.getOrNull(SemanticsProperties.EditableText)?.text }
                screen.reveal(screen.tagged("limit-events.max"), margin = 200f)
                screen.waitFor("Keep at Most at 200,000") { true.takeIf { most() == "200,000" } }
                screen.text("500–2,000,000 events")
                screen.reveal(screen.text("About 95 MB of events at most on this phone"), margin = 120f)
                val range = screen.text("500–2,000,000 events").boundsInWindow
                assertTrue("Keep at Most is in view", range.height > 0f && range.top >= 0f)
                hold()
                assertEquals("200,000", most())
                ProofShot.take()
            }
        }
    }

    // AC23: Delete My Shared Data asks first.

    @Test
    fun deleteMySharedDataAsksFirst() {
        var forgot = 0
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent { PenmossTheme { PrivacyScreen(PrivacyUi(sharing = true, install = INSTALL), PrivacyActions(onForget = { forgot++ })) } }
            }
            val screen = OnScreen(scenario)
            screen.reveal("privacyForget")
            screen.tap("privacyForget")
            screen.dialogText("Delete Your Shared Data?")
            screen.dialogText("Cancel")
            screen.dialogText("Delete")
            assertEquals(0, forgot)
            hold()
            screen.dialogText("Delete Your Shared Data?")
            ProofShot.take()
            screen.dialogTap("Delete")
            screen.waitFor("Delete asked") { if (forgot == 1) true else null }
        }
    }

    // The app's own recorder and a notebook, as ScrollEventsTest has them.

    private fun ready() = runBlocking {
        Analytics.install(analytics)
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (analytics.state.value == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
        if (analytics.state.value?.answered != true) analytics.answer(ConsentAnswer.NO, BuildConfig.VERSION_NAME)
        if (graph.git.notebooks.entries().isEmpty()) addNotebook(NOTEBOOK)
        analytics.flush()
        since = analytics.store.page(null, null, 1).firstOrNull()?.id ?: 0L
    }

    private suspend fun addNotebook(name: String): String {
        val dir = File(context.cacheDir, "session-proof-${System.nanoTime()}.git")
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

    /** The `note` events since the test began ([name], or all of them). */
    private fun notes(name: String?) = stored().filter { it.kind == "note" && (name == null || it.name == name) }

    /** No event since the test began holds the note's id, its title or a path. */
    private fun noIdTitleOrPath(noteId: String) {
        for (event in stored()) {
            for (word in listOf(noteId, TITLE, TREE_NOTE, ".md", "Garden", "beans")) assertFalse("${event.kind} ${event.name} ${event.text} holds $word", event.text.contains(word))
            for (prop in listOf("note", "folder")) {
                event.props[prop]?.let { assertTrue("${event.text}: $prop is a ref", SessionDetail.REF.matches(it.jsonPrimitive.content)) }
            }
        }
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

    /** A new note in [localId]'s notebook, open in the editor page: the page and the note's id. */
    private fun newNote(localId: String): Pair<WebView, String> {
        instrumentation.runOnMainSync { GitNotebookActivity.open(inFrontNow()!!, localId, LauncherAction.NewNote) }
        val page = until("the editor page") { editorPage() }
        until("the note open in the page") { js(page, "!!window.penmossEditor?.editor")?.takeIf { it == "true" } }
        val id = until("the note's id") { js(page, "window.penmossEditor?.openNoteId")?.takeIf { it.length > 4 && it != "null" } }
        return page to (JSONTokener(id).nextValue() as String)
    }

    /** Types [title] into the page's title field, as the keyboard would. */
    private fun setTitle(page: WebView, title: String) {
        js(
            page,
            """(() => { const t = document.getElementById('title'); t.focus(); t.dispatchEvent(new InputEvent('beforeinput')); t.value = ${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(title))}; t.dispatchEvent(new InputEvent('input', { bubbles: true })); return true; })()""",
        )
    }

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

    /** The node tagged [tag] on screen now, if it is; nothing is scrolled to find it. */
    private fun tag(screen: OnScreen, tag: String): SemanticsNode? =
        screen.nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == tag }

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

    /** Display → Font Size a step smaller, so more rows show on screen; put back after. */
    private fun smallerText() {
        fontScale = shell("settings get system font_scale")
        shell("settings put system font_scale 0.85")
        SystemClock.sleep(500)
    }

    private fun back() {
        instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        instrumentation.waitForIdleSync()
    }

    private companion object {
        const val NOTEBOOK = "Session Proof"
        const val TITLE = "Garden Plan Notes"
        const val TREE_NOTE = "Bean Rows in May"
        const val FOLDER = "Garden Plans"
        const val INSTALL = "5c0e8f6a00000000000000000000" + "7a96"

        private fun paragraph(text: String) = """{"type":"paragraph","content":[{"type":"text","text":"$text"}]}"""

        /** A heading, a paragraph, a list of two and a divider: h1:11, p:31, li.b.1:5, li.b.1:4, hr. */
        val SHAPED_NOTE: String = listOf(
            """{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Garden plan"}]}""",
            paragraph("Water the beans in the morning."),
            """{"type":"bulletList","content":[{"type":"listItem","content":[${paragraph("Beans")}]},{"type":"listItem","content":[${paragraph("Peas")}]}]}""",
            """{"type":"horizontalRule"}""",
        ).joinToString(",", "[", "]")

        /** Twenty paragraphs: a splice of more than twelve blocks, cut in the viewer. */
        val LONG_NOTE: String = (1..20).joinToString(",", "[", "]") { paragraph("Line $it of the list.") }
    }
}
