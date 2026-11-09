package app.penmoss.editor

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.bridge.FormatCommand
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.sync.NoteSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The T2 spike's typing tests (TypingInstrumentedTest), on the production
 * editor (T33, A307): the app's own editor WebView, page and bridge, with an
 * open note from a Room store. Types through the WebView's real
 * InputConnection, the object a soft keyboard talks to, on the thread the
 * framework uses for IME calls, composing each word letter by letter and then
 * committing it as Gboard does, and checks the note the editor holds and the
 * edits the app stored.
 *
 * Needs a device (the worker has no emulator): `./gradlew :app:connectedDebugAndroidTest`
 * on the Pixel (docs/android.md). A debug build loads the page with `?debug`,
 * which exposes the editor as `window.penmossEditor` for these checks.
 */
@RunWith(AndroidJUnit4::class)
class TypingInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private lateinit var scenario: ActivityScenario<ComponentActivity>
    private lateinit var webView: WebView
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var controller: NoteEditorController
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private object NoServer : NoteSync {
        override val exchanges = MutableSharedFlow<ExchangeResult>()

        override val foreground = MutableStateFlow(true)

        override suspend fun syncNote(noteId: String): ExchangeResult? = null

        override suspend fun refreshNote(noteId: String): ExchangeResult? = null

        override fun noteEdited(noteId: String) = Unit
    }

    @Before
    fun launch() {
        db = PenmossDatabase.inMemory(instrumentation.targetContext)
        store = NoteStore(db)
        // A note with nothing in it yet: an empty update, stored as the server sent it.
        runBlocking { db.updates().insert(UpdateEntity(noteId = NOTE, state = UpdateEntity.SYNCED, update = EMPTY_NOTE)) }
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        scenario.onActivity { activity ->
            val channel = EditorWebView.Channel()
            controller = NoteEditorController(NOTE, store, NoServer, scope, channel::send, onOpenNote = {})
            webView = EditorWebView.create(
                activity,
                channel,
                onMessage = controller::onPageMessage,
                onRendererGone = {},
                onBytes = controller::onPageBytes,
            )
            activity.setContentView(webView)
        }
        waitUntil("the note open", 30_000) {
            controller.state.value.phase == EditorUiState.Phase.READY && js("!!window.penmossEditor?.editor") == "true"
        }
    }

    @After
    fun close() {
        scenario.close()
        scope.cancel()
        db.close()
    }

    @Test
    fun composingThenCommittingEachWordWritesTheParagraphExactly() {
        val ic = focusBody()
        val words = PARAGRAPH.split(" ")
        words.forEachIndexed { index, word ->
            onImeThread(ic) {
                it.beginBatchEdit()
                for (end in 1..word.length) it.setComposingText(word.substring(0, end), 1)
                // Alternate the two ways keyboards finish a word.
                if (index % 2 == 0) it.commitText(word, 1) else it.finishComposingText()
                if (index < words.lastIndex) it.commitText(" ", 1)
                it.endBatchEdit()
            }
            SystemClock.sleep(10)
        }
        waitForBody(PARAGRAPH)
        val doc = JSONTokener(js("JSON.stringify(penmossEditor.editor.editor.getJSON())")!!.let(::decode)).nextValue() as JSONObject
        val content = doc.getJSONArray("content")
        assertEquals(1, content.length())
        assertEquals("paragraph", content.getJSONObject(0).getString("type"))
        // The page's edits reached the app and are stored to upload.
        instrumentation.runOnMainSync { controller.flush() }
        waitUntil("the edits stored", 10_000) { runBlocking { db.updates().updates(NOTE, UpdateEntity.PENDING).isNotEmpty() } }
    }

    @Test
    fun enterAndBackspaceInAListMadeFromTheBar() {
        val ic = focusBody()
        instrumentation.runOnMainSync { controller.format(FormatCommand.BULLET_LIST) }
        // The bar's command reaches the page as a message: a person types once the list shows,
        // and so does this test. On a slow emulator (a hosted runner's, A1235) the first word
        // otherwise came first, and the list started at the second line.
        waitUntil("the list from the bar", 10_000) { items() == 1 }
        onImeThread(ic) { it.commitText("first item", 1) }
        enter(ic)
        waitUntil("a second item", 10_000) { items() == 2 }
        onImeThread(ic) { it.commitText("second item", 1) }
        // Keyboards delete with both deleteSurroundingText and DEL key events.
        onImeThread(ic) { it.deleteSurroundingText(2, 0) }
        repeat(2) { key(ic, KeyEvent.KEYCODE_DEL) }
        onImeThread(ic) { it.commitText("thing", 1) }
        waitForBody("first item\nsecond thing")
        enter(ic) // a new, empty item
        waitUntil("a third, empty item", 10_000) { items() == 3 }
        enter(ic) // an empty item: out of the list
        waitUntil("out of the list", 10_000) { items() == 2 }
        onImeThread(ic) { it.commitText("after list", 1) }
        waitForBody("first item\nsecond thing\nafter list")
        val json = decode(js("JSON.stringify(penmossEditor.editor.editor.getJSON())"))!!
        assertEquals("one bulletList", 1, Regex("\"type\":\"bulletList\"").findAll(json).count())
        assertEquals("two list items", 2, Regex("\"type\":\"listItem\"").findAll(json).count())
    }

    @Test
    fun aBarButtonMidWordNeitherLosesNorDoublesTheWord() {
        val ic = focusBody()
        onImeThread(ic) { it.commitText("Some ", 1) }
        onImeThread(ic) {
            it.setComposingText("bo", 1)
            it.setComposingText("bol", 1)
        }
        // The bar never takes the focus, so the composition carries on (A307).
        instrumentation.runOnMainSync { controller.format(FormatCommand.BOLD) }
        SystemClock.sleep(100)
        onImeThread(ic) {
            it.setComposingText("bold", 1)
            it.commitText("bold", 1)
            it.commitText(" text", 1)
        }
        waitForBody("Some bold text")
        assertEquals("true", js("document.activeElement === penmossEditor.editor.editor.view.dom"))
    }

    @Test
    fun enterInTheTitleMovesToTheBody() {
        instrumentation.runOnMainSync { webView.requestFocus() }
        js("document.getElementById('title').focus(), true")
        val ic = inputConnection()
        onImeThread(ic) {
            it.setComposingText("Pla", 1)
            it.commitText("Plan", 1)
        }
        enter(ic)
        // The body has the focus now: a fresh connection to it.
        waitUntil("the body focused", 10_000) { js("document.activeElement === penmossEditor.editor.editor.view.dom") == "true" }
        onImeThread(inputConnection()) { it.commitText("First line", 1) }
        waitForBody("First line")
        assertEquals("Plan", decode(js("document.getElementById('title').value")))
        waitUntil("the title stored", 10_000) { controller.state.value.title == "Plan" }
    }

    /** A baseline through hardware-style key events (Instrumentation.sendStringSync). */
    @Test
    fun keyEventsWriteTheParagraphExactly() {
        focusBody()
        // Injected key events go to whichever window has the input focus, not to this view. A
        // system dialog in front ("System UI isn't responding" on a loaded emulator) takes the
        // first keys and drops them, so type only once the editor's window has the focus.
        waitUntil("the editor's window focused", 10_000) {
            var focused = false
            instrumentation.runOnMainSync { focused = webView.hasWindowFocus() }
            focused
        }
        instrumentation.sendStringSync(PARAGRAPH)
        waitForBody(PARAGRAPH)
    }

    // ---- helpers ----------------------------------------------------------------

    private fun focusBody(): InputConnection {
        instrumentation.runOnMainSync { webView.requestFocus() }
        js("penmossEditor.editor.editor.commands.focus('end'), true")
        return inputConnection()
    }

    /** The WebView's InputConnection, once Chromium reports a focused editable element. */
    private fun inputConnection(): InputConnection {
        var ic: InputConnection? = null
        waitUntil("the WebView's InputConnection", 10_000) {
            instrumentation.runOnMainSync { ic = webView.onCreateInputConnection(EditorInfo()) }
            ic != null
        }
        return ic!!
    }

    /** IME calls where the framework makes them: on the connection's own handler. */
    private fun onImeThread(ic: InputConnection, block: (InputConnection) -> Unit) {
        val handler = ic.handler ?: Handler(Looper.getMainLooper())
        val done = CountDownLatch(1)
        handler.post {
            try {
                block(ic)
            } finally {
                done.countDown()
            }
        }
        check(done.await(5, TimeUnit.SECONDS)) { "IME call timed out" }
        SystemClock.sleep(30)
    }

    private fun key(ic: InputConnection, code: Int) = onImeThread(ic) {
        it.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        it.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    private fun enter(ic: InputConnection) = key(ic, KeyEvent.KEYCODE_ENTER)

    /** How many list items the body has. */
    private fun items(): Int? = js("penmossEditor.editor.editor.view.dom.querySelectorAll('li').length")?.toIntOrNull()

    /** The body's text as the editor holds it, one line per block. */
    private fun waitForBody(expected: String) {
        var last: String? = null
        try {
            waitUntil("the typed text", 10_000) {
                last = decode(js("penmossEditor.editor.editor.getText({ blockSeparator: '\\n' })"))?.replace('\u00a0', ' ')?.trim()
                last == expected
            }
        } catch (e: AssertionError) {
            // The document too: blocks with no text read the same as one in getText.
            val doc = runCatching { decode(js("JSON.stringify(penmossEditor.editor.editor.getJSON())")) }.getOrNull()
            throw AssertionError("Expected <$expected> but the editor has <$last>, as $doc", e)
        }
    }

    /** evaluateJavascript on the main thread; the result JSON-encoded. */
    private fun js(expression: String): String? {
        val done = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            webView.evaluateJavascript(expression) {
                result = it
                done.countDown()
            }
        }
        check(done.await(10, TimeUnit.SECONDS)) { "JS timed out: $expression" }
        return result
    }

    private fun decode(json: String?): String? = json?.let { JSONTokener(it).nextValue() as? String }

    private fun waitUntil(what: String, timeoutMs: Long, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return
            SystemClock.sleep(100)
        }
        throw AssertionError("Timed out after $timeoutMs ms waiting for $what")
    }

    private companion object {
        const val NOTE = "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"

        /** An update with nothing in it: what a note holds before its first edit. */
        const val EMPTY_NOTE = "AAA="

        /** The T2 spike's paragraph (spikes/android-editor), typed word by word. */
        const val PARAGRAPH =
            "The quick brown fox jumps over the lazy dog while Ryan's kettle boils. " +
                "On Tuesday at 7:45 we packed 3 boxes, 12 books and a lamp; nothing broke! " +
                "Is this editor really fast enough for long writing on a phone? " +
                "Let's find out, one sentence at a time, without fixing anything by hand."
    }
}
