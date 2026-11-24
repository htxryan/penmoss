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
import kotlinx.coroutines.flow.first
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
 * - A note's page made again behind Settings (a change of font size) records no open or cursor
 *   until the note is shown again.
 * - The notes list's tree records a folder opened and left (by its Back or the system Back), and a
 *   note opened from it, by refs; Analytics Data shows the rows (AC15).
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
            val opened = until("note open") { notesOf(noteId, "open").firstOrNull() }
            val ref = opened.props.getValue("note").jsonPrimitive.content
            assertTrue(ref, SessionDetail.REF.matches(ref))
            val blocks = until("note blocks") { notesOf(noteId, "blocks").firstOrNull() }
            assertEquals(ref, blocks.props.getValue("note").jsonPrimitive.content)
            // The note shown again: its shape, every block in order, by the same ref (AC2).
            js(page, "document.activeElement?.blur()")
            SystemClock.sleep(1_500)
            back()
            until("the notebook's notes") { tag(OnScreen.inFront(), "homeMenu") }
            instrumentation.runOnMainSync { GitNotebookActivity.open(inFrontNow()!!, localId, note = noteId) }
            until("the note again") { editorPage()?.takeIf { js(it, "window.penmossEditor?.openNoteId") == "\"$noteId\"" } }
            val again = until("note open again") { notesOf(noteId, "open").firstOrNull { it.id > blocks.id } }
            assertEquals(ref, again.props.getValue("note").jsonPrimitive.content)
            val shape = (again.props.getValue("shape") as JsonArray).map { it.jsonPrimitive.content }
            for (token in shape) assertTrue(token, SessionDetail.BLOCK.matches(token))
            assertEquals(listOf("h1:11", "p:31", "li.b.1:5", "li.b.1:4", "hr"), shape.filter { it != "p:0" })
            assertEquals(TITLE.length, again.props.getValue("titleChars").jsonPrimitive.int)
            noIdTitleOrPath(noteId)
            hold()

            // Analytics Data: the shaped note's open row, its blocks as tokens, ended on.
            endOnRow("note · open") { "how: open" in it && "titleChars: ${TITLE.length}" in it && "h1:11" in it && "li.b.1:5" in it }
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
            until("note blocks") { notesOf(noteId, "blocks").firstOrNull() }
            // Forty characters over about three seconds, at the end of the note.
            js(page, "penmossEditor.editor.editor.commands.focus('end')")
            repeat(40) {
                js(page, "penmossEditor.editor.editor.commands.insertContent('q')")
                SystemClock.sleep(75)
            }
            val bursts = until("forty characters in bursts") {
                notesOf(noteId, "typing").takeIf { rows -> rows.sumOf { it.props.getValue("typed").jsonPrimitive.int } >= 40 }
            }
            assertEquals(40, bursts.sumOf { it.props.getValue("typed").jsonPrimitive.int })
            assertTrue("${bursts.size} bursts", bursts.size in 2..10)
            for (burst in bursts) {
                assertTrue(burst.text, burst.props.keys.all { it in setOf("note", "block", "typed", "deleted") })
                assertFalse("no character recorded: ${burst.text}", burst.text.contains("q\""))
            }
            // From this note's first event on (a note an earlier test left may show a moment as
            // the notebook opens, before it), every note event is this note's, by one ref.
            val firstOfNote = notesOf(noteId, null).first().id
            val refs = notes(null).filter { it.id >= firstOfNote }.map { it.props.getValue("note").jsonPrimitive.content }.toSet()
            assertEquals("one note, one ref", 1, refs.size)
            noIdTitleOrPath(noteId)
            hold()

            // Analytics Data: the splice's row cut to "… +N", the typing rows below it.
            smallerText()
            context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val home = OnScreen.inFront()
            home.openAnalyticsData()
            // Newest first, the rows recorded after the typing (Home and Settings; the note page
            // made again behind them for the smaller text records nothing) come before it, so the
            // list is scrolled to them:
            // the splice's row, its inserted blocks cut to "… +N", brought to the list's foot,
            // with the typing rows recorded after it just above.
            val splice = seek(home, "the splice's cut row") { node -> node.texts().any { "inserted: " in it && "… +" in it } }
            val cut = splice.texts().first { "inserted: " in it && "… +" in it }
            assertTrue(cut, Regex("inserted: (\\S+ ){12}… \\+\\d+").containsMatchIn(cut))
            val list = checkNotNull(tag(home, "viewerList")) { "no list" }.boundsInWindow
            home.reveal(splice, margin = maxOf(48f, list.height - splice.size.height - 24f))
            home.waitFor("the cut row and a typing row in view") { true.takeIf { inView(home, cut) && inView(home, "note · typing") } }
            hold()
            assertTrue("the typing row is in view too", inView(home, "note · typing"))
            assertTrue(inView(home, cut))
            ProofShot.take()
        }
    }

    // Review round 2: the note's page made again behind Settings records no open.

    @Test
    fun noteBehindSettingsRecordsNoOpen() {
        ready()
        val localId = runBlocking { graph.git.notebooks.entries().first().localId }
        ActivityScenario.launch<MainActivity>(allNotebooks()).use { scenario ->
            val launcher = OnScreen.of(scenario)
            launcher.tap(launcher.text(runBlocking { graph.git.notebooks.entries().first().name }))
            OnScreen.inFront().tagged("homeMenu")
            val (page, noteId) = newNote(localId)
            js(page, "penmossEditor.editor.editor.commands.insertContent($SHAPED_NOTE)")
            val first = until("note open") { notesOf(noteId, "open").firstOrNull() }
            js(page, "document.activeElement?.blur()")
            SystemClock.sleep(1_500)

            // Settings in front, the note's screen behind it.
            context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val settings = OnScreen.inFront()
            settings.open("homeSettingsGear", then = "section-privacy")
            settings.open("section-privacy", then = "privacyViewData")
            SystemClock.sleep(1_500)
            val mark = stored().lastOrNull()?.id ?: since
            val behind = { stored().filter { it.id > mark && it.kind == "note" && it.name in setOf("open", "cursor") } }

            // A change of font size: the note's activity is made again behind Settings.
            smallerText()
            SystemClock.sleep(6_000)
            assertEquals("no note open or cursor while the note is behind Settings", emptyList<String>(), behind().map { "${it.name} ${it.text}" })
            // Settings is still in front, made again for the font size too.
            OnScreen.inFront().tagged("privacyViewData")
            assertEquals(emptyList<String>(), behind().map { "${it.name} ${it.text}" })

            // Shown again: its open is recorded then, by the same ref.
            instrumentation.runOnMainSync { GitNotebookActivity.open(inFrontNow()!!, localId, note = noteId) }
            until("the note again") { editorPage()?.takeIf { js(it, "window.penmossEditor?.openNoteId") == "\"$noteId\"" } }
            val ref = first.props.getValue("note")
            val again = until("note open once shown") { behind().firstOrNull { it.name == "open" && it.props["note"] == ref } }
            assertEquals(first.props.getValue("note"), again.props.getValue("note"))
            noIdTitleOrPath(noteId)
            hold()
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

            // Analytics Data: the search's row, its length and never its words, ended on.
            endOnRow("input · search") { it == "field: query, chars: 12" }
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
            // A note at the top level made with its title, so the list shows it: the editor page
            // makes it as it makes a link's new note (its title in the note itself, never typed),
            // and the app stores it (NoteStore.addLocalNote). This test is about the tree.
            val (page, scratchId) = newNote(localId)
            val made = js(page, "penmossEditor.createNote(${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(scratchId))}, ${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(TREE_NOTE))})")
            val noteId = JSONTokener(checkNotNull(made) { "no note made" }).nextValue() as? String ?: throw AssertionError("no note made: $made")
            val store = graph.git.graph(localId).store
            until("the titled note stored") { runBlocking { store.noteTitle(noteId) }?.takeIf { it == TREE_NOTE } }
            // The keyboard down first, so Back leaves the note.
            js(page, "document.activeElement?.blur()")
            SystemClock.sleep(1_500)
            back()
            val home = OnScreen.inFront()
            until("the notebook's notes") { tag(home, "homeMenu") }
            val key = runBlocking { analytics.stateNow().refKey }

            // The folder opened from the list, then left by its top bar's Back.
            val openFolder = {
                until("the notebook's notes") { tag(home, "homeMenu") }
                val folder = home.waitFor("the folder's row") { home.nodes().firstOrNull { FOLDER in it.texts() } }
                home.reveal(folder, margin = 200f)
                home.tap(home.text(FOLDER))
            }
            val trees = { name: String -> stored().filter { it.kind == "tree" && it.name == name } }
            openFolder()
            val expand = until("tree expand") { trees("expand").firstOrNull() }
            assertEquals(AnalyticsRefs.refOf(key, "folder", folderId), expand.props.getValue("folder").jsonPrimitive.content)
            assertEquals(0, expand.props.getValue("depth").jsonPrimitive.int)
            assertEquals("click", expand.props.getValue("source").jsonPrimitive.content)
            SystemClock.sleep(1_500)
            val bar = home.waitFor("Back") { home.nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.ContentDescription)?.contains("Back") == true } }
            home.tap(bar)
            val collapse = until("tree collapse") { trees("collapse").firstOrNull() }
            assertEquals(expand.props.getValue("folder"), collapse.props.getValue("folder"))
            assertEquals(0, collapse.props.getValue("depth").jsonPrimitive.int)
            assertEquals("click", collapse.props.getValue("source").jsonPrimitive.content)

            // Opened again, then left by the system Back: a collapse too, by `key`.
            openFolder()
            until("tree expand again") { trees("expand").getOrNull(1) }
            SystemClock.sleep(1_500)
            back()
            val leftByBack = until("tree collapse by the system Back") { trees("collapse").getOrNull(1) }
            assertEquals(expand.props.getValue("folder"), leftByBack.props.getValue("folder"))
            assertEquals("key", leftByBack.props.getValue("source").jsonPrimitive.content)
            assertEquals("one collapse each time it was left", 2, trees("collapse").size)

            // The note opened from the list, at the top level: no folder.
            until("the notebook's notes again") { tag(home, "homeMenu") }
            // The note's row, the list scrolled to it if it sits below the first screen; if it
            // isn't there, what the phone holds for the notebook's notes says why.
            val row = runCatching { home.text(TREE_NOTE) }.getOrElse { missing ->
                val held = runBlocking { store.observeList().first() }.map { (if (it.id == noteId) "this note " else "") + "“${it.title}”" }
                throw AssertionError("no row for the note; the notebook's notes, as the phone holds them: $held", missing)
            }
            home.reveal(row, margin = 200f)
            home.tap(home.text(TREE_NOTE))
            val open = until("tree open") { stored().firstOrNull { it.kind == "tree" && it.name == "open" } }
            assertEquals(AnalyticsRefs.refOf(key, "note", noteId), open.props.getValue("note").jsonPrimitive.content)
            assertFalse("folder" in open.props)
            assertEquals(0, open.props.getValue("depth").jsonPrimitive.int)
            for (event in stored()) assertFalse(event.text, event.text.contains(folderId) || event.text.contains(FOLDER) || event.text.contains(noteId))
            until("the note open") { editorPage() }
            SystemClock.sleep(1_500)

            // Analytics Data: the tree's open, collapse and expand rows, newest first, on screen.
            smallerText()
            context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val viewer = OnScreen.inFront()
            viewer.openAnalyticsData()
            val rows = listOf("tree · open", "tree · collapse", "tree · expand")
            viewer.reveal(seek(viewer, "tree · open"), margin = 48f)
            // The list pages in its rows as it nears its end: brought up again until the older
            // rows below the open are loaded and placed under it.
            viewer.waitFor("the tree's rows in view") {
                if (rows.all { inView(viewer, it) }) true else null.also { viewer.reveal(seek(viewer, "tree · open"), margin = 48f) }
            }
            hold()
            for (row in rows) assertTrue("$row is in view; it shows ${viewer.texts()}", inView(viewer, row))
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
                // Keep at Most's field, its digits grouped, with its range and the space line below
                // it: the field brought a little under the top bar, so all three show whole.
                val most = { screen.tagged("limit-events.max").config.getOrNull(SemanticsProperties.EditableText)?.text }
                screen.waitFor("Keep at Most at 200,000") { true.takeIf { most() == "200,000" } }
                screen.reveal(screen.tagged("limit-events.max"), margin = 160f)
                val space = "About 100 MB of events at most on this phone"
                val whole = {
                    listOf(screen.tagged("limit-events.max"), screen.text("500–2,000,000 events"), screen.text(space))
                        .all { shownWhole(screen, it) }
                }
                screen.waitFor("Keep at Most, its range and the space line, whole below the top bar") { true.takeIf { whole() } }
                hold()
                assertEquals("200,000", most())
                assertTrue("still whole below the top bar", whole())
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

    /**
     * The `note` events since the test began about [noteId], by its ref: a note an earlier test
     * left open in the same notebook's activity may show a moment as this one opens, and records
     * its own.
     */
    private fun notesOf(noteId: String, name: String?): List<Stored> {
        val ref = AnalyticsRefs.refOf(runBlocking { analytics.stateNow().refKey }, "note", noteId)
        return notes(name).filter { it.props["note"]?.jsonPrimitive?.content == ref }
    }

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

    /**
     * The row [text] in Analytics Data's list, a page down at a time: the list makes only the rows
     * on screen, so a row further down is found by bringing the lowest one shown to the top.
     */
    private fun seek(screen: OnScreen, text: String): SemanticsNode = seek(screen, text) { text in it.texts() }

    /** The first row in Analytics Data's list that [match]es, found as [seek] finds one by its text. */
    private fun seek(screen: OnScreen, what: String, match: (SemanticsNode) -> Boolean): SemanticsNode {
        repeat(40) {
            screen.nodes().firstOrNull(match)?.let { return it }
            val list = tag(screen, "viewerList")?.boundsInWindow ?: return@repeat
            val lowest = screen.nodes()
                .filter { it.texts().isNotEmpty() && it.boundsInWindow.height > 0f && it.boundsInWindow.top >= list.top && it.boundsInWindow.bottom <= list.bottom }
                .maxByOrNull { it.boundsInWindow.top }
            if (lowest != null) screen.reveal(lowest, margin = 0f) else SystemClock.sleep(300)
        }
        return screen.waitFor("the row $what") { screen.nodes().firstOrNull(match) }
    }

    /**
     * Settings → Privacy → View Analytics Data, scrolled to the row headed [headline] whose props
     * line [matches], held with both on screen, and ended on: the proof's last screenshot.
     */
    private fun endOnRow(headline: String, matches: (String) -> Boolean) {
        context.startActivity(allNotebooks().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val viewer = OnScreen.inFront()
        viewer.openAnalyticsData()
        val props = seek(viewer, "the $headline row") { node -> node.texts().any(matches) }
        val line = props.texts().first(matches)
        // The props line a little below the list's top, so its headline shows above it.
        viewer.reveal(props, margin = 160f)
        val heading = {
            val at = viewer.nodes().firstOrNull { line in it.texts() }?.boundsInWindow
            at != null && viewer.nodes().any { node ->
                headline in node.texts() && node.boundsInWindow.let { it.height > 0f && it.bottom <= at.top + 1f && at.top - it.bottom < 120f }
            }
        }
        viewer.waitFor("the $headline row in view") { true.takeIf { inView(viewer, line) && heading() } }
        hold()
        assertTrue("$line is in view; it shows ${viewer.texts()}", inView(viewer, line))
        assertTrue("$headline heads it", heading())
        ProofShot.take()
    }

    /** Whether [node] shows whole on screen: below the page's top bar, and not cut at the bottom. */
    private fun shownWhole(screen: OnScreen, node: SemanticsNode): Boolean {
        val bar = tag(screen, "sectionTopBar")?.boundsInWindow?.bottom ?: 0f
        val at = node.boundsInWindow
        return at.height > 0f && at.height >= node.size.height - 1f && at.top >= bar
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
