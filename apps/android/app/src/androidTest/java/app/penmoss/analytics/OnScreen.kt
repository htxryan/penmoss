package app.penmoss.analytics

import android.app.Activity
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
class OnScreen(private val onActivity: (block: (Activity) -> Unit) -> Unit) {
    constructor(scenario: ActivityScenario<ComponentActivity>) : this({ block -> scenario.onActivity { block(it) } })

    companion object {
        /** How long a finder waits for its node to appear before it scrolls to look for it. */
        private const val SEEK_AFTER_MS = 1_000L

        /** How long [open] waits for its screen before it taps again. */
        private const val OPEN_RETAP_MS = 2_000L

        /** The screen of [scenario]'s activity, whichever kind it is (the app's own activities). */
        fun <A : Activity> of(scenario: ActivityScenario<A>) = OnScreen { block -> scenario.onActivity { block(it) } }

        /**
         * The screen of whichever of the app's activities is in front: the app moving from one
         * activity to the next (the launcher opening a notebook) reads nothing until it settles.
         */
        fun inFront() = OnScreen { block ->
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).firstOrNull()?.let(block)
            }
        }
    }

    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    /**
     * Every laid-out node now. A lazy list's row composed ahead of a scroll but not placed yet
     * (prefetched) is left out: it reports bounds at the list's top, though nothing shows there.
     */
    fun nodes(): List<SemanticsNode> {
        instrumentation.waitForIdleSync()
        var found = emptyList<SemanticsNode>()
        onActivity { activity -> found = ScreenTree.nodes(activity.window.decorView).filter { it.boundsInWindow.width > 0f && it.layoutInfo.isPlaced } }
        return found
    }

    fun texts(): List<String> = nodes().flatMap { it.texts() }

    /** Every node in the tree, laid out or not, on screen or scrolled off it. */
    private fun allNodes(): List<SemanticsNode> {
        instrumentation.waitForIdleSync()
        var found = emptyList<SemanticsNode>()
        onActivity { activity -> found = ScreenTree.nodes(activity.window.decorView) }
        return found
    }

    /**
     * The first on-screen node that [match]es. A node scrolled out of sight is scrolled into it,
     * and when nothing matches, a lazy list is moved on a screen, so the next look finds a row it
     * hadn't composed yet; past its end it goes back to the top.
     */
    private fun seek(since: Long, match: (SemanticsNode) -> Boolean): SemanticsNode? {
        nodes().firstOrNull(match)?.let { return it }
        // A moment first for what is still loading, then go looking for it.
        if (SystemClock.uptimeMillis() - since < SEEK_AFTER_MS) return null
        // Placed off screen (a scrolled column's), never a lazy row only prefetched (see [nodes]).
        val hidden = allNodes().firstOrNull { match(it) && it.layoutInfo.isPlaced }
        if (hidden != null) {
            reveal(hidden)
            return nodes().firstOrNull(match)
        }
        page()
        return null
    }

    /** Moves the tallest vertical list down a screen, or back to its top once at its end. */
    private fun page() {
        val lists = allNodes().filter {
            it.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange) != null &&
                it.config.getOrNull(SemanticsActions.ScrollBy) != null && it.boundsInWindow.height > 0f
        }
        val list = lists.maxByOrNull { it.boundsInWindow.height } ?: return
        onActivity {
            // A list on a screen that is leaving (open() waits through a screen change) can be
            // detached by now: it isn't scrolled this time, and the next look finds the new screen.
            if (!list.layoutInfo.isAttached) return@onActivity
            val range = list.config[SemanticsProperties.VerticalScrollAxisRange]
            val by = if (range.value() < range.maxValue()) list.boundsInWindow.height * 0.6f else -1_000_000f
            runCatching { list.config[SemanticsActions.ScrollBy].action?.invoke(0f, by) }
        }
        instrumentation.waitForIdleSync()
        SystemClock.sleep(200)
    }

    fun <T : Any> waitFor(what: String, timeoutMs: Long = 30_000, read: () -> T?): T {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            read()?.let { return it }
            SystemClock.sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        throw AssertionError("no $what on screen; it shows ${texts()}")
    }

    /** The node tagged [tag], scrolled into sight. */
    fun tagged(tag: String): SemanticsNode = SystemClock.uptimeMillis().let { since -> waitFor("[$tag]") { seek(since) { it.config.getOrNull(SemanticsProperties.TestTag) == tag } } }

    /** The node that says [text], scrolled into sight. */
    fun text(text: String): SemanticsNode =
        SystemClock.uptimeMillis().let { since -> waitFor("“$text”") { seek(since) { text in it.texts() } } }

    /** Where each tagged node sits in one layout, scrolled into sight or not: to compare their order. */
    fun layoutTops(tags: List<String>): List<Float> {
        val all = allNodes()
        return tags.map { tag -> (all.firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == tag } ?: throw AssertionError("no [$tag] laid out; it shows ${texts()}")).positionInWindow.y }
    }

    fun has(text: String): Boolean = nodes().any { text in it.texts() }

    /** Runs [node]'s click, or its nearest clickable ancestor's. */
    fun tap(node: SemanticsNode) {
        var ok = false
        onActivity {
            var at: SemanticsNode? = node
            while (at != null && at.config.getOrNull(SemanticsActions.OnClick) == null) at = at.parent
            ok = at?.config?.getOrNull(SemanticsActions.OnClick)?.action?.invoke() == true
        }
        check(ok) { "could not tap ${node.texts()} ${node.config.getOrNull(SemanticsProperties.TestTag)}" }
        instrumentation.waitForIdleSync()
    }

    fun tap(tag: String) = tap(tagged(tag))

    /**
     * Taps [tag], a control that opens another screen, until [arrived] holds. The app opens a
     * screen only from the one that has settled in front (A387), so a tap made while that one
     * still slides in does nothing: a slow phone (CI's emulator) needs it made again.
     */
    fun open(tag: String, arrived: () -> Boolean) {
        tap(tag)
        waitFor("the screen [$tag] opens") {
            val again = SystemClock.uptimeMillis() + OPEN_RETAP_MS
            while (SystemClock.uptimeMillis() < again) {
                if (arrived()) return@waitFor true
                SystemClock.sleep(100)
            }
            nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == tag }?.let { tap(it) }
            null
        }
    }

    /**
     * Opens [tag]'s screen, known by the node tagged [then] on it (see [open]), which may sit
     * below the fold: it is looked for as [tagged] does, the list scrolled to find it.
     */
    fun open(tag: String, then: String) {
        val since = SystemClock.uptimeMillis()
        open(tag) { seek(since) { it.config.getOrNull(SemanticsProperties.TestTag) == then } != null }
    }

    /** From Home: the gear, Privacy, then View Analytics Data, known by its title. */
    fun openAnalyticsData() {
        open("homeSettingsGear", then = "section-privacy")
        open("section-privacy", then = "privacyViewData")
        open("privacyViewData") { has(AnalyticsCopy.text("viewer.title")) }
    }

    /** Types [value] into the field [tag] and presses its Done. */
    fun type(tag: String, value: String) {
        val field = tagged(tag)
        onActivity {
            field.config.getOrNull(SemanticsActions.RequestFocus)?.action?.invoke()
            field.config[SemanticsActions.SetText].action?.invoke(AnnotatedString(value))
        }
        instrumentation.waitForIdleSync()
        val again = tagged(tag)
        onActivity { again.config.getOrNull(SemanticsActions.OnImeAction)?.action?.invoke() }
        instrumentation.waitForIdleSync()
    }

    /**
     * Scrolls [node]'s scrolling parents so it sits near the top of the screen ([margin] below
     * the parent's top), and in sight along a row that scrolls sideways.
     */
    fun reveal(node: SemanticsNode, margin: Float = 160f) {
        onActivity {
            var at: SemanticsNode? = node.parent
            while (at != null) {
                val scroll = at.config.getOrNull(SemanticsActions.ScrollBy)
                if (scroll != null) {
                    val sideways = at.config.getOrNull(SemanticsProperties.HorizontalScrollAxisRange) != null &&
                        at.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange) == null
                    if (sideways) {
                        val left = node.positionInWindow.x - at.boundsInWindow.left
                        val right = left + node.size.width - at.boundsInWindow.width
                        val by = if (left < 0f) left - 48f else if (right > 0f) right + 48f else 0f
                        if (by != 0f) scroll.action?.invoke(by, 0f)
                    } else {
                        scroll.action?.invoke(0f, node.positionInWindow.y - at.boundsInWindow.top - margin)
                        break
                    }
                }
                at = at.parent
            }
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
