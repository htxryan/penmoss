package app.penmoss.editor

import android.os.SystemClock
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.data.Attachments
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
import org.json.JSONArray
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
 * PEN-28 on the phone: a drawing made on the Mac (an SVG picture linked to its Excalidraw scene,
 * `[![Drawing](attachments/<sha>.svg)](attachments/<sha>.excalidraw)`) shows in the note as a
 * picture, read-only: the phone has no drawing editor, so the slash menu offers no Drawing (the
 * editor has no drawing services) and a tap opens nothing. Typing around it keeps the drawing as it is, picture and link, in the edits
 * the app stores. The real editor WebView, page and bridge, with the SVG served as the app serves
 * a note's pictures (`EditorWebView.pictureResponse`, as image/svg+xml under a sandbox policy).
 *
 * The factory's Android proof runs it on a headless emulator: `task proof:android --
 * app.penmoss.editor.DrawingInstrumentedTest`.
 */
@RunWith(AndroidJUnit4::class)
class DrawingInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private lateinit var scenario: ActivityScenario<ComponentActivity>
    private lateinit var webView: WebView
    private lateinit var db: PenmossDatabase
    private lateinit var controller: NoteEditorController
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private object NoServer : NoteSync {
        override val exchanges = MutableSharedFlow<ExchangeResult>()

        override val foreground = MutableStateFlow(true)

        override suspend fun syncNote(noteId: String): ExchangeResult? = null

        override suspend fun refreshNote(noteId: String): ExchangeResult? = null

        override fun noteEdited(noteId: String) = Unit
    }

    /** The drawing's SVG, answered as the app answers a note's pictures. */
    private fun serve(sha256: String, ext: String): WebResourceResponse? {
        if (sha256 != SVG_SHA || ext != "svg") return null
        val file = java.io.File(instrumentation.targetContext.cacheDir, "$SVG_SHA.svg")
        file.writeBytes(SVG)
        return EditorWebView.pictureResponse(file, ext)
    }

    @Before
    fun launch() {
        db = PenmossDatabase.inMemory(instrumentation.targetContext)
        val store = NoteStore(db)
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
                picture = ::serve,
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
    fun aDrawingShowsAsAPictureAndStaysWhole() {
        instrumentation.runOnMainSync { webView.requestFocus() }
        // The note as a Mac left it: a line of text, then the drawing alone in its paragraph.
        js(
            """
            penmossEditor.editor.editor.chain().focus().insertContent([
              { type: 'paragraph', content: [{ type: 'text', text: 'The garden beds' }] },
              { type: 'paragraph', content: [{
                type: 'image',
                attrs: { src: ${JSONObject.quote(SVG_PATH)}, alt: 'Drawing' },
                marks: [{ type: 'link', attrs: { href: ${JSONObject.quote(SCENE_PATH)} } }],
              }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Plant in March.' }] },
            ]).run(), true
            """.trimIndent(),
        )

        // Shown as a picture, from the app, as wide as it was drawn.
        waitUntil("the drawing shown", 20_000) {
            js(
                "(() => { const d = document.querySelector('[data-testid=\"drawing\"]'); " +
                    "return !!d && d.dataset.state === 'ready' && d.querySelector('img').naturalWidth > 0; })()",
            ) == "true"
        }
        assertEquals("\"Drawing\"", js("document.querySelector('[data-testid=\"drawing\"] img').alt"))

        // No drawing editor on the phone: a tap opens nothing, and the slash menu has no Drawing.
        js("document.querySelector('[data-testid=\"drawing\"]').click(), true")
        assertEquals("false", js("!!document.querySelector('[data-testid=\"drawing-editor\"]')"))
        assertEquals("true", js("penmossEditor.editor.editor.storage.drawing?.services === undefined"))

        // Typed around: before it, and after it.
        js(
            """
            (() => {
              const editor = penmossEditor.editor.editor;
              let end = -1;
              editor.state.doc.descendants((node, pos) => {
                if (end < 0 && node.isTextblock && node.textContent === 'The garden beds') end = pos + node.nodeSize - 1;
              });
              editor.chain().focus().setTextSelection(end).insertContent(', drawn on the Mac').run();
              editor.chain().focus('end').insertContent(' Water weekly.').run();
              return true;
            })()
            """.trimIndent(),
        )
        // The drawing is as it was: the same picture, linked to the same scene, in its own paragraph.
        val doc = JSONTokener(decode(js("JSON.stringify(penmossEditor.editor.editor.getJSON())"))!!).nextValue() as JSONObject
        val blocks = doc.getJSONArray("content")
        val texts = (0 until blocks.length()).map { text(blocks.getJSONObject(it)) }
        assertEquals("The garden beds, drawn on the Mac", texts[0])
        assertEquals("Plant in March. Water weekly.", texts.last())
        val drawing = blocks.getJSONObject(1).getJSONArray("content")
        assertEquals(1, drawing.length())
        val image = drawing.getJSONObject(0)
        assertEquals("image", image.getString("type"))
        assertEquals(SVG_PATH, image.getJSONObject("attrs").getString("src"))
        val marks = image.getJSONArray("marks")
        assertEquals(1, marks.length())
        assertEquals("link", marks.getJSONObject(0).getString("type"))
        assertEquals(SCENE_PATH, marks.getJSONObject(0).getJSONObject("attrs").getString("href"))
        // The edits reached the app and are stored to upload.
        instrumentation.runOnMainSync { controller.flush() }
        waitUntil("the edits stored", 10_000) { runBlocking { db.updates().updates(NOTE, UpdateEntity.PENDING).isNotEmpty() } }

        // The proof's screenshot: the note with its drawing on screen.
        js(
            "penmossEditor.editor.editor.commands.blur(), document.activeElement.blur(), window.scrollTo(0, 0), true",
        )
        SystemClock.sleep(2_000)
        ProofShot.take()
    }

    // ---- helpers ----------------------------------------------------------------

    /** A block's text, its inline nodes' text joined. */
    private fun text(block: JSONObject): String {
        val content = block.optJSONArray("content") ?: JSONArray()
        return (0 until content.length()).joinToString("") { content.getJSONObject(it).optString("text") }
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
        const val NOTE = "01JD2Z7Q8R4T6Y8W0E2R4T6YD8"

        /** An update with nothing in it: what a note holds before its first edit. */
        const val EMPTY_NOTE = "AAA="

        /** A drawing as Excalidraw exports one: a white sheet, a rectangle and a circle in pen. */
        val SVG =
            """
            <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 260" width="480" height="260"><!-- svg-source:excalidraw --><rect x="0" y="0" width="480" height="260" fill="#ffffff"/><path d="M40 60 C120 56, 200 58, 262 62 C266 120, 264 180, 260 220 C180 224, 100 222, 42 218 C38 160, 40 100, 40 60 Z" fill="none" stroke="#1e1e1e" stroke-width="2.5" stroke-linecap="round"/><path d="M380 70 C430 72, 452 120, 440 160 C428 205, 360 214, 322 182 C290 152, 300 96, 342 78 C356 72, 368 70, 380 70 Z" fill="none" stroke="#1e1e1e" stroke-width="2.5" stroke-linecap="round"/></svg>
            """.trimIndent().toByteArray()

        val SVG_SHA = Attachments.sha256(SVG)
        val SVG_PATH = "attachments/$SVG_SHA.svg"
        val SCENE_PATH = "attachments/${"5".repeat(64)}.excalidraw"
    }
}
