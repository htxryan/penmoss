package app.penmoss.editor

import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.data.Attachments
import app.penmoss.data.FileStore
import app.penmoss.engine.bridge.StoredFile
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.DrawingAction
import app.penmoss.engine.bridge.DrawingFromEditor
import app.penmoss.engine.bridge.DrawingToEditor
import app.penmoss.engine.bridge.ParityToEditor
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
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * PEN-28 and PEN-189 on the phone. A drawing made on the Mac (an SVG picture linked to its
 * Excalidraw scene, `[![Drawing](attachments/<sha>.svg)](attachments/<sha>.excalidraw)`) shows in
 * the note as a picture; a tap selects it and shows its Edit and Delete, and typing around it keeps
 * it as it is, picture and link, in the edits the app stores. A new drawing is made on the phone:
 * Diagram: Excalidraw opens Excalidraw over the note, Done stores the scene and its SVG as files
 * and puts the drawing in the note, Edit opens it again from its scene, Cancel leaves it, and
 * Delete takes it out. The real editor WebView, page and bridge, with the files kept as the app
 * keeps them and pictures served as it serves them (`EditorWebView.pictureResponse`, an SVG as
 * image/svg+xml under a sandbox policy). The note screen's drawing bar is stood in for by the
 * bridge messages it sends.
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

    /** The note's files, kept as the app keeps them: by their path, which their bytes and name give. */
    private val kept = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()

    private inner class KeptFiles : FileStore {
        override suspend fun add(bytes: ByteArray, noteId: String?): String = error("no pictures here")

        override suspend fun addFromPage(path: String, bytes: ByteArray, noteId: String): String? = null

        override suspend fun addFile(input: InputStream, name: String, noteId: String?): String = error("no picker here")

        override suspend fun addFileFromPage(path: String, name: String, bytes: ByteArray, noteId: String): String? {
            val expected = "attachments/${Attachments.sha256(bytes)}.${name.substringAfterLast('.')}"
            if (path != expected) return null
            kept[path] = bytes
            return path
        }

        override suspend fun info(path: String): StoredFile? = null

        override suspend fun document(path: String): java.io.File? = kept[path]?.let { bytes ->
            java.io.File(instrumentation.targetContext.cacheDir, path.substringAfter('/')).also { it.writeBytes(bytes) }
        }
    }

    /** The page's messages the note screen reads itself: the drawing editor's title as it opens and closes. */
    private val shown = java.util.concurrent.CopyOnWriteArrayList<String?>()

    /** The titles the page said were being saved (the drawing bar's buttons wait meanwhile). */
    private val saving = java.util.concurrent.CopyOnWriteArrayList<String>()

    private lateinit var channel: EditorWebView.Channel

    /** A note's picture, answered as the app answers them: the Mac's drawing, or one kept here. */
    private fun serve(sha256: String, ext: String): WebResourceResponse? {
        val bytes = if (sha256 == SVG_SHA && ext == "svg") SVG else kept["attachments/$sha256.$ext"] ?: return null
        val file = java.io.File(instrumentation.targetContext.cacheDir, "$sha256.$ext")
        file.writeBytes(bytes)
        return EditorWebView.pictureResponse(file, ext)
    }

    @Before
    fun launch() {
        db = PenmossDatabase.inMemory(instrumentation.targetContext)
        val store = NoteStore(db)
        runBlocking { db.updates().insert(UpdateEntity(noteId = NOTE, state = UpdateEntity.SYNCED, update = EMPTY_NOTE)) }
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        scenario.onActivity { activity ->
            channel = EditorWebView.Channel()
            controller = NoteEditorController(NOTE, store, NoServer, scope, channel::send, onOpenNote = {}, files = KeptFiles())
            webView = EditorWebView.create(
                activity,
                channel,
                onMessage = { raw ->
                    (BridgeProtocol.decodeFromEditor(raw) as? DrawingFromEditor.Shown)?.let {
                        shown += it.title
                        if (it.saving) saving += it.title
                    }
                    controller.onPageMessage(raw)
                },
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

        // A tap selects it and shows its Edit and Delete; nothing opens until Edit is tapped.
        js("document.querySelector('[data-testid=\"drawing\"]').click(), true")
        assertEquals("true", js("document.querySelector('[data-testid=\"drawing\"]').classList.contains('ProseMirror-selectednode')"))
        assertEquals("false", js("document.querySelector('[data-testid=\"drawing\"] .pm-drawing-tools').hidden"))
        assertEquals("false", js("!!document.querySelector('[data-testid=\"drawing-editor\"]')"))

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

    @Test
    fun aDrawingIsMadeEditedAndDeletedOnThePhone() {
        instrumentation.runOnMainSync { webView.requestFocus() }
        js("penmossEditor.editor.editor.chain().focus().insertContent('Garden plan').run(), true")
        // Diagram: Excalidraw, as the slash menu and the + sheet insert it.
        channel.send(BridgeProtocol.encode(ParityToEditor.Insert(NOTE, "drawing")))
        waitUntil("the drawing editor open", 30_000) {
            js("!!document.querySelector('[data-testid=\"drawing-editor\"] canvas.interactive')") == "true"
        }
        waitUntil("the drawing bar told", 5_000) { shown.lastOrNull() == "New Excalidraw Diagram" }

        // A rectangle and a word, drawn with Excalidraw's own tools.
        drawRectangle()
        waitUntil("the rectangle drawn", 10_000) {
            js("document.querySelector('[data-testid=\"drawing-editor\"]').dataset.shapes") == "\"1\""
        }
        writeText("Beds")
        waitUntil("the word written", 10_000) {
            js("document.querySelector('[data-testid=\"drawing-editor\"]').dataset.shapes") == "\"2\""
        }
        // The proof's screenshot: the drawing editor over the note.
        SystemClock.sleep(1_000)
        ProofShot.take()

        // Done (the drawing bar's, or the back gesture): the files are stored and the note shows it.
        channel.send(BridgeProtocol.encode(DrawingToEditor.Finish(DrawingAction.DONE)))
        waitUntil("the drawing bar gone", 20_000) { shown.lastOrNull() == null && shown.size >= 2 }
        waitUntil("the drawing in the note", 10_000) { drawingFiles() != null }
        val (svg, scene) = drawingFiles()!!
        val picture = String(kept.getValue(svg))
        assertEquals(true, picture.trimStart().startsWith("<svg"))
        // Its words' font is inlined from the APK's own font files, so it draws the same anywhere.
        assertEquals(true, picture.contains("@font-face"))
        val elements = (JSONTokener(String(kept.getValue(scene))).nextValue() as JSONObject).getJSONArray("elements")
        val drawn = (0 until elements.length()).map { elements.getJSONObject(it) }.sortedBy { it.getString("type") }
        assertEquals(listOf("rectangle", "text"), drawn.map { it.getString("type") })
        // Drawn by the finger's drag and typed by the keys, not empty.
        assertEquals(true, drawn[0].getDouble("width") > 50 && drawn[0].getDouble("height") > 30)
        assertEquals("Beds", drawn[1].getString("text"))
        // While Done was saved the drawing bar's buttons waited.
        assertEquals(true, saving.isNotEmpty())
        assertEquals("false", js("!!document.querySelector('[data-testid=\"drawing-editor\"]')"))
        waitUntil("the new drawing shown", 20_000) {
            js("document.querySelector('[data-testid=\"drawing\"]')?.dataset.state") == "\"ready\""
        }

        // Edit opens it again from its scene, which the app reads for the page; Cancel leaves it.
        js("document.querySelector('[data-testid=\"drawing\"]').click(), true")
        js("document.querySelector('[data-testid=\"drawing\"] .pm-drawing-edit').click(), true")
        waitUntil("the drawing open again", 30_000) {
            js("document.querySelector('[data-testid=\"drawing-editor\"]')?.dataset.shapes") == "\"1\""
        }
        waitUntil("the drawing bar told", 5_000) { shown.lastOrNull() == "Edit Excalidraw Diagram" }
        channel.send(BridgeProtocol.encode(DrawingToEditor.Finish(DrawingAction.CANCEL)))
        waitUntil("the drawing editor closed", 10_000) {
            js("!!document.querySelector('[data-testid=\"drawing-editor\"]')") == "false"
        }
        assertEquals(svg to scene, drawingFiles())

        // A note that can't be edited shows the drawing with no Edit or Delete.
        js("penmossEditor.editor.editor.setEditable(false), true")
        js("document.querySelector('[data-testid=\"drawing\"]').click(), true")
        assertEquals("true", js("document.querySelector('[data-testid=\"drawing\"] .pm-drawing-tools').hidden"))
        js("penmossEditor.editor.editor.setEditable(true), true")

        // Delete takes it out of the note.
        js("document.querySelector('[data-testid=\"drawing\"]').click(), true")
        js("document.querySelector('[data-testid=\"drawing\"] .pm-drawing-delete').click(), true")
        waitUntil("the drawing deleted", 5_000) { drawingFiles() == null }
    }

    // ---- helpers ----------------------------------------------------------------

    /** The note's drawing, as its picture's and its scene's paths; null when it has none. */
    private fun drawingFiles(): Pair<String, String>? {
        val found = decode(
            js(
                """
                (() => {
                  let found = null;
                  penmossEditor.editor.editor.state.doc.descendants((node) => {
                    const link = node.type.name === 'image' && node.marks.find((mark) => mark.type.name === 'link');
                    if (!found && link && link.attrs.href.endsWith('.excalidraw')) found = node.attrs.src + ' ' + link.attrs.href;
                  });
                  return found;
                })()
                """.trimIndent(),
            ),
        ) ?: return null
        val (svg, scene) = found.split(' ')
        return svg to scene
    }

    /** Picks Excalidraw's rectangle and drags one out on its canvas with a finger. */
    private fun drawRectangle() {
        tool("rectangle")
        val (x, y) = canvasAt(60f, 120f)
        val (toX, toY) = canvasAt(220f, 216f)
        val down = SystemClock.uptimeMillis()
        touch(MotionEvent.ACTION_DOWN, x, y, down)
        for (step in 1..10) touch(MotionEvent.ACTION_MOVE, x + (toX - x) * step / 10, y + (toY - y) * step / 10, down)
        touch(MotionEvent.ACTION_UP, toX, toY, down)
    }

    /** Picks Excalidraw's text tool, taps the canvas and types [words] with keys, then Escape ends the text. */
    private fun writeText(words: String) {
        tool("text")
        val (x, y) = canvasAt(80f, 320f)
        val down = SystemClock.uptimeMillis()
        touch(MotionEvent.ACTION_DOWN, x, y, down)
        touch(MotionEvent.ACTION_UP, x, y, down)
        waitUntil("the text box open", 5_000) {
            js("document.activeElement?.classList.contains('excalidraw-wysiwyg') ?? false") == "true"
        }
        instrumentation.sendStringSync(words)
        waitUntil("the words typed", 5_000) {
            decode(js("document.querySelector('textarea.excalidraw-wysiwyg')?.value ?? ''")) == words
        }
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ESCAPE)
    }

    /** Picks one of Excalidraw's tools from its toolbar. */
    private fun tool(name: String) {
        js("document.querySelector('[data-testid=\"drawing-editor\"] [data-testid=\"toolbar-$name\"]').click(), true")
    }

    /** A point on Excalidraw's canvas, given in CSS pixels from its top left, as screen pixels. */
    private fun canvasAt(cssX: Float, cssY: Float): Pair<Float, Float> {
        val box = JSONArray(
            decode(
                js(
                    "JSON.stringify((() => { const r = document.querySelector('[data-testid=\"drawing-editor\"] canvas.interactive')" +
                        ".getBoundingClientRect(); return [r.left, r.top]; })())",
                ),
            ),
        )
        val origin = IntArray(2)
        var density = 1f
        instrumentation.runOnMainSync {
            webView.getLocationOnScreen(origin)
            density = webView.resources.displayMetrics.density
        }
        return (origin[0] + (box.getDouble(0).toFloat() + cssX) * density) to (origin[1] + (box.getDouble(1).toFloat() + cssY) * density)
    }

    /** A finger's touch at a screen point, as the touchscreen sends it. */
    private fun touch(action: Int, x: Float, y: Float, downTime: Long) {
        val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        instrumentation.sendPointerSync(event)
        event.recycle()
    }

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
