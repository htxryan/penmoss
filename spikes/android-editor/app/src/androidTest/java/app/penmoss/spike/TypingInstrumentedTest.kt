package app.penmoss.spike

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Types through the WebView's real InputConnection, the same object a soft
 * keyboard talks to, and asserts the resulting ProseMirror JSON.
 *
 * How the IME path is reproduced: the test focuses the editor, asks the WebView
 * for its InputConnection (`onCreateInputConnection`, which Chromium answers with
 * its ThreadedInputConnection) and makes every call on `InputConnection.getHandler()`,
 * the thread the framework uses for IME calls. Each word is composed letter by letter
 * (setComposingText) inside a batch edit, then committed, as Gboard does.
 *
 * Needs a connected device or emulator: `./gradlew connectedDebugAndroidTest`.
 */
@RunWith(AndroidJUnit4::class)
class TypingInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var webView: WebView

    @Before
    fun launch() {
        scenario = ActivityScenario.launch(MainActivity::class.java)
        scenario.onActivity { webView = it.webView }
        waitUntil("editor ready", 30_000) { js("window.penmoss && window.penmoss.isReady()") == "true" }
    }

    @After
    fun close() = scenario.close()

    @Test
    fun testParagraphMatchesWebBundle() {
        assertEquals(TEST_PARAGRAPH, decode(js("penmoss.testParagraph")))
    }

    @Test
    fun inputConnection_composeAndCommit_producesExactParagraph() {
        startTest("instrumentation ime")
        val ic = inputConnection()
        val words = TEST_PARAGRAPH.split(" ")
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

        waitForTestText(TEST_PARAGRAPH)
        val nodes = JSONTokener(js("penmoss.getTestJSON()")).nextValue() as JSONArray
        val paragraph = nodes.getJSONObject(0)
        assertEquals("paragraph", paragraph.getString("type"))
        assertEquals(TEST_PARAGRAPH, textOf(paragraph))
        assertEquals(1, nodes.length())

        val result = JSONTokener(js("penmoss.checkTest()")).nextValue() as JSONObject
        assertTrue("consistency checker: $result", result.getBoolean("exact"))
        val compositions = js("penmoss.imeLogTail(20000).filter(e => e.ev === 'compositionstart').length")!!.toInt()
        assertTrue("IME log recorded composition events", compositions >= words.size / 2)
    }

    @Test
    fun inputConnection_enterAndBackspace_inBulletList() {
        startTest("instrumentation list")
        val ic = inputConnection()
        js("penmoss.exec('bulletList')")
        onImeThread(ic) { it.commitText("first item", 1) }
        enter(ic)
        onImeThread(ic) { it.commitText("second item", 1) }
        // Keyboards delete with both deleteSurroundingText and DEL key events.
        onImeThread(ic) { it.deleteSurroundingText(2, 0) }
        repeat(2) { key(ic, KeyEvent.KEYCODE_DEL) }
        onImeThread(ic) { it.commitText("thing", 1) }
        enter(ic) // new empty item
        enter(ic) // empty item: lift out of the list
        onImeThread(ic) { it.commitText("after list", 1) }

        waitForTestText("first item\nsecond thing\nafter list")
        val json = js("penmoss.getTestJSON()")!!
        assertEquals("one bulletList", 1, Regex("\"type\":\"bulletList\"").findAll(json).count())
        assertEquals("two list items", 2, Regex("\"type\":\"listItem\"").findAll(json).count())
    }

    /** Baseline through hardware-style key events (Instrumentation.sendStringSync). */
    @Test
    fun keyEvents_produceExactParagraph() {
        startTest("instrumentation keys")
        inputConnection() // waits until the editor has input focus
        instrumentation.sendStringSync(TEST_PARAGRAPH)
        waitForTestText(TEST_PARAGRAPH)
        val nodes = JSONTokener(js("penmoss.getTestJSON()")).nextValue() as JSONArray
        assertEquals(TEST_PARAGRAPH, textOf(nodes.getJSONObject(0)))
    }

    // ---- helpers ----------------------------------------------------------------

    private fun startTest(label: String) {
        js("penmoss.startTest(${JSONObject.quote(label)}), true")
        instrumentation.runOnMainSync { webView.requestFocus() }
    }

    /** The WebView's InputConnection, once Chromium reports a focused editable element. */
    private fun inputConnection(): InputConnection {
        var ic: InputConnection? = null
        waitUntil("WebView InputConnection", 10_000) {
            instrumentation.runOnMainSync { ic = webView.onCreateInputConnection(EditorInfo()) }
            ic != null
        }
        return ic!!
    }

    /** Run IME calls where the framework would: on the connection's own handler. */
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

    private fun waitForTestText(expected: String) {
        var last: String? = null
        try {
            waitUntil("typed text", 10_000) {
                last = decode(js("penmoss.getTestText()"))?.replace(' ', ' ')?.trim()
                last == expected
            }
        } catch (e: AssertionError) {
            throw AssertionError("Expected <$expected> but editor has <$last>", e)
        }
    }

    /** evaluateJavascript on the main thread; returns the JSON-encoded result. */
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

    private fun textOf(node: JSONObject): String = buildString {
        if (node.has("text")) append(node.getString("text"))
        val content = node.optJSONArray("content") ?: return@buildString
        for (i in 0 until content.length()) append(textOf(content.getJSONObject(i)))
    }

    private fun waitUntil(what: String, timeoutMs: Long, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return
            SystemClock.sleep(100)
        }
        throw AssertionError("Timed out after $timeoutMs ms waiting for $what")
    }
}
