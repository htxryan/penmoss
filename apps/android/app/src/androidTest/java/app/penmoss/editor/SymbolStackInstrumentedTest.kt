package app.penmoss.editor

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.proof.ProofShot
import app.penmoss.sync.NoteSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A1678 to A1680's Android proof in a note: the symbol sheet's symbols stack at a line's start
 * in the list's order (★, →, then Strikethrough's ⊘ as symbol 7), the line's text after them is
 * struck through, and the gutter is as wide as the three, drawn before the text. The production
 * editor (the app's WebView, page and bridge) on a note from a Room store, as
 * `TypingInstrumentedTest` opens it; the symbols come from the sheet's command
 * ([NoteEditorController.toggleSymbol]). Run with
 * `task proof:android -- app.penmoss.editor.SymbolStackInstrumentedTest`.
 */
@RunWith(AndroidJUnit4::class)
class SymbolStackInstrumentedTest {
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
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }
        db.close()
    }

    @Test
    fun symbolsStackAtALinesStartAndStrikethroughStrikesItsText() {
        val ic = focusBody()
        onImeThread(ic) { it.commitText("Call the bank", 1) }
        waitForBody("Call the bank")
        // The default list: ★ is symbol 2, → symbol 6 and Strikethrough symbol 7 (A1679).
        for (index in listOf(1, 5, 6)) {
            instrumentation.runOnMainSync { controller.toggleSymbol(index) }
            SystemClock.sleep(PROOF_PAUSE_MS)
        }
        // Stacked in the list's order, each a glyph and a space, never replacing another.
        waitForBody("★ → ⊘ Call the bank")
        waitUntil("the gutter three symbols wide", 10_000) { decode(js("penmossEditor.editor.editor.view.dom.getAttribute('data-symbol-slots')")) == "3" }
        assertEquals("Call the bank", decode(js("penmossEditor.editor.editor.view.dom.querySelector('.pm-symbol-struck')?.textContent ?? ''")))
        assertEquals(
            "★→⊘",
            decode(js("[...penmossEditor.editor.editor.view.dom.querySelectorAll('.pm-symbols > .pm-symbol')].map(s => s.textContent).join('')")),
        )
        // The symbols are drawn in the gutter, before the struck text.
        val beforeText = js(
            "(() => { const d = penmossEditor.editor.editor.view.dom; const s = d.querySelector('.pm-symbols').getBoundingClientRect();" +
                " const t = d.querySelector('.pm-symbol-struck').getBoundingClientRect(); return s.right <= t.left + 1; })()",
        )
        assertEquals("true", beforeText)
        // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
        SystemClock.sleep(2_000)
        ProofShot.take()
    }

    private fun focusBody(): InputConnection {
        instrumentation.runOnMainSync { webView.requestFocus() }
        js("penmossEditor.editor.editor.commands.focus('end'), true")
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

    /** The body's text, one line per textblock, as `TypingInstrumentedTest` reads it. */
    private fun waitForBody(expected: String) {
        var last: String? = null
        try {
            waitUntil("the text", 10_000) {
                last = decode(js("(d => d.textBetween(0, d.content.size, '\\n'))(penmossEditor.editor.editor.state.doc)"))
                    ?.replace(' ', ' ')?.trim()
                last == expected
            }
        } catch (e: AssertionError) {
            throw AssertionError("Expected <$expected> but the editor has <$last>", e)
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
        const val NOTE = "01JD2Z7Q8R4T6Y8W0E2R4T6YB2"

        /** An update with nothing in it: what a note holds before its first edit. */
        const val EMPTY_NOTE = "AAA="

        /** A pause between symbols, so the proof's video shows each one added. */
        const val PROOF_PAUSE_MS = 400L
    }
}
