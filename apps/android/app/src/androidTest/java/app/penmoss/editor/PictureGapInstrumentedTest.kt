package app.penmoss.editor

import android.os.SystemClock
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.PictureStore
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.proof.ProofShot
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * PEN-66 (A1283) on the phone: a picture keeps its own line (A506) and leaves no empty line
 * under it. The real editor WebView, page and bridge, with a note from an in-memory Room store
 * (as TypingInstrumentedTest), its pictures kept in memory: a paragraph of text ending in a 200×100 picture, a picture alone in
 * its paragraph, and a bulleted item ending in a picture, each pasted as a screenshot is, stored
 * through the app and shown from it. Each block ends at its picture's bottom edge, and the next
 * block starts the normal gap below it, as below a line of text, ±1 px.
 *
 * The factory's Android proof runs it on a headless emulator: `task proof:android --
 * app.penmoss.editor.PictureGapInstrumentedTest`.
 */
@RunWith(AndroidJUnit4::class)
class PictureGapInstrumentedTest {
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

    /** Pasted pictures, kept in memory as the app keeps them on disk, and served to the page. */
    private object Pictures : PictureStore {
        private val stored = ConcurrentHashMap<String, ByteArray>()

        override suspend fun add(bytes: ByteArray, noteId: String?): String = error("No picture is picked here")

        override suspend fun addFromPage(path: String, bytes: ByteArray, noteId: String): String {
            stored[path] = bytes
            return path
        }

        fun serve(sha256: String, ext: String): WebResourceResponse? =
            stored["attachments/$sha256.$ext"]?.let { WebResourceResponse("image/$ext", null, ByteArrayInputStream(it)) }
    }

    @Before
    fun launch() {
        db = PenmossDatabase.inMemory(instrumentation.targetContext)
        val store = NoteStore(db)
        runBlocking { db.updates().insert(UpdateEntity(noteId = NOTE, state = UpdateEntity.SYNCED, update = EMPTY_NOTE)) }
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        scenario.onActivity { activity ->
            val channel = EditorWebView.Channel()
            controller = NoteEditorController(NOTE, store, NoServer, scope, channel::send, onOpenNote = {}, pictures = Pictures)
            webView = EditorWebView.create(
                activity,
                channel,
                onMessage = controller::onPageMessage,
                onRendererGone = {},
                onBytes = controller::onPageBytes,
                picture = Pictures::serve,
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
    fun aParagraphALonePictureAndAListItemEndingInAPictureKeepTheirNormalGaps() {
        instrumentation.runOnMainSync { webView.requestFocus() }
        js(
            """
            penmossEditor.editor.editor.chain().focus().insertContent(
              '<p>Text above the picture</p><p>LONE</p><p>After the lone picture</p>' +
              '<ul><li><p>Item with a picture</p></li><li><p>Item two</p></li><li><p>Item three</p></li></ul>' +
              '<p>After the list</p>'
            ).run(), true
            """.trimIndent(),
        )
        waitUntil("the note's blocks", 10_000) { js("penmossEditor.editor.editor.view.dom.querySelectorAll('li').length") == "3" }
        pasteAt("Text above the picture", replace = false, count = 1)
        pasteAt("LONE", replace = true, count = 2)
        pasteAt("Item with a picture", replace = false, count = 3)

        val measured = JSONTokener(decode(js(MEASURE))!!).nextValue() as JSONObject
        val blockGap = measured.getDouble("blockGap")
        val listGap = measured.getDouble("listGap")
        val pictures = measured.getJSONArray("pictures")
        assertEquals(3, pictures.length())
        for (i in 0 until pictures.length()) {
            val picture = pictures.getJSONObject(i)
            val which = picture.getString("text").ifEmpty { "the lone picture" }
            // Below the text, on a line of its own; the block ends at the picture's bottom edge.
            assertNear("no empty line under the picture after <$which>", 0.0, picture.getDouble("under"))
            val gap = if (picture.getBoolean("inList")) listGap else blockGap
            assertNear("the gap below the picture after <$which>", gap, picture.getDouble("gap"))
        }
        val lone = pictures.getJSONObject(1)
        assertNear("the lone picture's paragraph as tall as it", 0.0, lone.getDouble("above"))
        assertTrue("the text above its own line", pictures.getJSONObject(0).getDouble("above") > 20)

        // The proof's screenshot: the three pictures and the blocks after them, on screen.
        js("penmossEditor.editor.editor.commands.blur(), document.activeElement.blur(), window.scrollTo(0, 0), true")
        SystemClock.sleep(2_000)
        ProofShot.take()
    }

    // ---- helpers ----------------------------------------------------------------

    /**
     * Puts the caret at the end of the textblock holding `text` (or selects that text), and pastes
     * a 200×100 PNG there as a screenshot arrives; waits for the `count`th picture to show.
     */
    private fun pasteAt(text: String, replace: Boolean, count: Int) {
        js(
            """
            (() => {
              const editor = penmossEditor.editor.editor;
              let from = -1, to = -1;
              editor.state.doc.descendants((node, pos) => {
                if (from < 0 && node.isTextblock && node.textContent === ${JSONObject.quote(text)}) {
                  from = pos + 1;
                  to = pos + node.nodeSize - 1;
                }
              });
              editor.chain().focus().setTextSelection(${if (replace) "{ from, to }" else "to"}).run();
              const canvas = document.createElement('canvas');
              canvas.width = 200;
              canvas.height = 100;
              const context = canvas.getContext('2d');
              context.fillStyle = '#3f7d4e';
              context.fillRect(0, 0, 200, 100);
              canvas.toBlob((blob) => {
                const transfer = new DataTransfer();
                transfer.items.add(new File([blob], 'Shot.png', { type: 'image/png' }));
                editor.view.dom.dispatchEvent(
                  new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
                );
              }, 'image/png');
              return true;
            })()
            """.trimIndent(),
        )
        try {
            waitUntil("picture $count shown", 20_000) {
                js(
                    "[...document.querySelectorAll('.pm-image')].filter((p) => p.dataset.state === 'ready' && " +
                        "p.querySelector('img').complete && p.querySelector('img').naturalWidth > 0).length",
                ) == "$count"
            }
        } catch (e: AssertionError) {
            val pictures = js(
                "JSON.stringify([...document.querySelectorAll('.pm-image')].map((p) => [p.dataset.state, " +
                    "p.querySelector('img').getAttribute('src'), p.querySelector('img').naturalWidth]))",
            )
            val doc = js("JSON.stringify(penmossEditor.editor.editor.getJSON())")
            throw AssertionError("Pictures $pictures in $doc", e)
        }
    }

    private fun assertNear(what: String, expected: Double, actual: Double) {
        assertTrue("$what: expected $expected ±1 px, was $actual", abs(expected - actual) <= 1.05)
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

        /**
         * Each picture's distances: from its block's top and bottom edges to the picture's, and from
         * the picture's bottom to the next block or item. And the normal gaps, below a line of text:
         * from a paragraph to the next, and from a list item's text to the next item.
         */
        val MEASURE =
            """
            JSON.stringify((() => {
              const dom = penmossEditor.editor.editor.view.dom;
              const rect = (element) => element.getBoundingClientRect();
              const after = (element) => {
                for (let at = element; at && at !== dom; at = at.parentElement) {
                  if (at.nextElementSibling) return at.nextElementSibling;
                }
                return null;
              };
              const textOnly = [...dom.querySelectorAll(':scope > p')].find((p) => p.textContent === 'After the lone picture');
              const items = dom.querySelectorAll('li');
              return {
                blockGap: rect(after(textOnly)).top - rect(textOnly).bottom,
                listGap: rect(items[2]).top - rect(items[1].querySelector('p')).bottom,
                pictures: [...dom.querySelectorAll('.pm-image')].map((picture) => {
                  const img = rect(picture.querySelector('img'));
                  const block = picture.closest('p');
                  const outer = picture.closest('li') ?? block;
                  return {
                    text: [...block.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(''),
                    inList: outer !== block,
                    above: img.top - rect(block).top,
                    under: rect(block).bottom - img.bottom,
                    gap: rect(after(outer)).top - img.bottom,
                  };
                }),
              };
            })())
            """.trimIndent()
    }
}
