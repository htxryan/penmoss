package app.penmoss.analytics

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.AnnotatedString
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.penmoss.ScreenTree

/**
 * The analytics specs' view of the screen (PEN-137): Compose's semantics tree read through
 * [ScreenTree] and its actions invoked directly, never the Compose test rule, whose Espresso link
 * doesn't start on the API 37 emulator.
 */
class OnScreen(private val scenario: ActivityScenario<ComponentActivity>) {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    /** Every laid-out node now. */
    fun nodes(): List<SemanticsNode> {
        instrumentation.waitForIdleSync()
        var found = emptyList<SemanticsNode>()
        scenario.onActivity { activity -> found = ScreenTree.nodes(activity.window.decorView).filter { it.boundsInWindow.width > 0f } }
        return found
    }

    fun texts(): List<String> = nodes().flatMap { it.texts() }

    fun <T : Any> waitFor(what: String, timeoutMs: Long = 30_000, read: () -> T?): T {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            read()?.let { return it }
            SystemClock.sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        throw AssertionError("no $what on screen; it shows ${texts()}")
    }

    fun tagged(tag: String): SemanticsNode = waitFor("[$tag]") { nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == tag } }

    fun text(text: String): SemanticsNode = waitFor("“$text”") { nodes().firstOrNull { text in it.texts() } }

    fun has(text: String): Boolean = nodes().any { text in it.texts() }

    /** Runs [node]'s click, or its nearest clickable ancestor's. */
    fun tap(node: SemanticsNode) {
        var ok = false
        scenario.onActivity {
            var at: SemanticsNode? = node
            while (at != null && at.config.getOrNull(SemanticsActions.OnClick) == null) at = at.parent
            ok = at?.config?.getOrNull(SemanticsActions.OnClick)?.action?.invoke() == true
        }
        check(ok) { "could not tap ${node.texts()} ${node.config.getOrNull(SemanticsProperties.TestTag)}" }
        instrumentation.waitForIdleSync()
    }

    fun tap(tag: String) = tap(tagged(tag))

    /** Types [value] into the field [tag] and presses its Done. */
    fun type(tag: String, value: String) {
        val field = tagged(tag)
        scenario.onActivity {
            field.config.getOrNull(SemanticsActions.RequestFocus)?.action?.invoke()
            field.config[SemanticsActions.SetText].action?.invoke(AnnotatedString(value))
        }
        instrumentation.waitForIdleSync()
        val again = tagged(tag)
        scenario.onActivity { again.config.getOrNull(SemanticsActions.OnImeAction)?.action?.invoke() }
        instrumentation.waitForIdleSync()
    }

    /** Scrolls [node]'s scrolling parent so it sits near the top of the screen. */
    fun reveal(node: SemanticsNode, margin: Float = 160f) {
        scenario.onActivity {
            var at: SemanticsNode? = node.parent
            while (at != null && at.config.getOrNull(SemanticsActions.ScrollBy) == null) at = at.parent
            val parent = at ?: return@onActivity
            val by = node.boundsInWindow.top - parent.boundsInWindow.top - margin
            parent.config[SemanticsActions.ScrollBy].action?.invoke(0f, by)
        }
        instrumentation.waitForIdleSync()
        SystemClock.sleep(300)
    }

    fun reveal(tag: String) = reveal(tagged(tag))

    /**
     * The accessibility nodes in every window whose text is [text]: a dialog has a window of its
     * own, which the activity's Compose tree does not reach.
     */
    fun anywhere(text: String): List<android.view.accessibility.AccessibilityNodeInfo> {
        instrumentation.waitForIdleSync()
        val automation = instrumentation.uiAutomation
        val info = automation.serviceInfo
        if (info.flags and android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS == 0) {
            info.flags = info.flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            automation.serviceInfo = info
        }
        val roots = automation.windows.mapNotNull { it.root } + listOfNotNull(automation.rootInActiveWindow)
        return ScreenTree.accessibilityNodes(roots).filter { it.text?.toString() == text || it.contentDescription?.toString() == text }
    }

    /** Waits for [text] in any window (a dialog's). */
    fun dialogText(text: String) = waitFor("“$text” in a dialog") { anywhere(text).firstOrNull() }

    /** Clicks the control that says [text] in any window (a dialog's button). */
    fun dialogTap(text: String) {
        val node = dialogText(text)
        var at: android.view.accessibility.AccessibilityNodeInfo? = node
        while (at != null && !at.isClickable) at = at.parent
        check(at?.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK) == true) { "could not click “$text”" }
        instrumentation.waitForIdleSync()
    }

    /** Where [node] is, in the window. */
    fun top(node: SemanticsNode): Float = node.boundsInWindow.top
}

fun SemanticsNode.texts(): List<String> = config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text }

/** A phone's analytics for a spec: an in-memory record and a consent file of its own; nothing is sent. */
class TestAnalytics : AutoCloseable {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO)
    private val dir = java.io.File(context.cacheDir, "analytics-spec-${System.nanoTime()}").apply { mkdirs() }
    val database = AnalyticsDatabase.inMemory(context)
    val store = AnalyticsStore(database)
    var clock = System.currentTimeMillis()
    val service = AnalyticsService(
        store = store,
        consent = ConsentStore.create(dir, scope),
        sender = AnalyticsSender(okhttp3.OkHttpClient(), base = { "http://127.0.0.1:9" }),
        scope = scope,
        fields = { ClientFields(version = "0.4.2", channel = "dev", osVersion = "17", sizeClass = "compact") },
        now = { clock },
    )

    /** [count] events of [state], one a minute, the newest now. */
    fun seed(count: Int, state: EventState, name: String = "privacy.view-data", ageMs: Long = 60_000) = kotlinx.coroutines.runBlocking {
        val session = AnalyticsFormat.newSessionId()
        val events = (0 until count).map { index ->
            AnalyticsEvent(session, index.toLong(), clock - (count - index) * ageMs, "android", "person", "0.4.2", "dev", "android", "17", "compact", "click", name)
        }
        events.chunked(500).forEach { chunk -> store.insert(chunk.map { it to state }) }
    }

    override fun close() {
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
        database.close()
        dir.deleteRecursively()
    }
}
