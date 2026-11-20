package app.penmoss.analytics

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import kotlin.math.floor

/** The clock and timers a [ScrollGate] runs on: the main thread's, or a test's. */
interface ScrollClock {
    fun now(): Long

    /** Runs [run] after [delayMs]; the handle [clear] takes. */
    fun set(delayMs: Long, run: () -> Unit): Any

    fun clear(handle: Any)

    companion object {
        /** On the main thread, as Compose's effects and the WebView's messages are. */
        fun main(): ScrollClock = object : ScrollClock {
            private val handler = Handler(Looper.getMainLooper())

            override fun now(): Long = SystemClock.uptimeMillis()

            override fun set(delayMs: Long, run: () -> Unit): Any = Runnable(run).also { handler.postDelayed(it, delayMs) }

            override fun clear(handle: Any) = handler.removeCallbacks(handle as Runnable)
        }
    }
}

/**
 * One area's settle, gap, repeat and reset rules (PEN-175): core's `ScrollGate`
 * (`packages/core/src/analytics/scroll.ts`), checked against `apps/android/contract/scroll-v1.json`.
 *
 * - A position is recorded once the area has been still for [SETTLE_MS].
 * - At most one event every [MIN_GAP_MS]: a position that settles sooner is held, and the latest
 *   is recorded when the gap is up, so where the area comes to rest is never lost.
 * - A position equal to the last recorded is dropped; [reset] (the area's content changed: another
 *   page, another note) takes that memory back to the top (0) and keeps the gap.
 */
class ScrollGate(
    private val emit: (Double) -> Unit,
    private val clock: ScrollClock = ScrollClock.main(),
    private val settleMs: Long = SETTLE_MS,
    private val gapMs: Long = MIN_GAP_MS,
) {
    /** The last position recorded, or the top since the content last changed. */
    private var last = 0.0
    private var lastAt: Long? = null

    /** The latest position seen and not yet recorded. */
    private var latest: Double? = null
    private var settling: Any? = null
    private var holding: Any? = null

    /** The area moved to [position] ([fractionOf]); null, it can't scroll, is ignored. */
    fun moved(position: Double?) {
        position ?: return
        latest = position
        settling?.let(clock::clear)
        settling = clock.set(settleMs) {
            settling = null
            // A held event records the latest position when its gap is up.
            if (holding == null) flush()
        }
    }

    /** The area's content changed: its last position is the top again, and what waits is dropped. */
    fun reset() {
        stop()
        last = 0.0
    }

    /** Drops what waits (the area is gone). */
    fun stop() {
        settling?.let(clock::clear)
        holding?.let(clock::clear)
        settling = null
        holding = null
        latest = null
    }

    private fun flush() {
        val position = latest ?: return
        if (position == last) {
            latest = null
            return
        }
        val wait = lastAt?.let { it + gapMs - clock.now() } ?: 0L
        if (wait > 0) {
            holding = clock.set(wait) {
                holding = null
                // Still moving: the settle records it.
                if (settling == null) flush()
            }
            return
        }
        latest = null
        last = position
        lastAt = clock.now()
        emit(position)
    }

    companion object {
        /** How long an area must be still before its position is recorded (core's SCROLL_SETTLE_MS). */
        const val SETTLE_MS = 300L

        /** The least time between two events for one area (core's SCROLL_MIN_GAP_MS). */
        const val MIN_GAP_MS = 1000L

        /**
         * How far down an area is: [top] over how far it can scroll, held to 0–1 and rounded to
         * hundredths (as JavaScript's Math.round does). Null when it can't scroll at all.
         */
        fun fractionOf(top: Double, scrollHeight: Double, clientHeight: Double): Double? {
            val range = scrollHeight - clientHeight
            if (!range.isFinite() || !top.isFinite() || range < 1) return null
            val fraction = (top / range).coerceIn(0.0, 1.0)
            return floor(fraction * 100 + 0.5) / 100
        }

        /** A Compose [ScrollState]'s position, or null when it can't scroll or isn't laid out yet. */
        fun fractionOf(state: ScrollState): Double? {
            val max = state.maxValue
            if (max == Int.MAX_VALUE) return null
            return fractionOf(state.value.toDouble(), max.toDouble(), 0.0)
        }

        /**
         * A lazy list's position from its layout: the items scrolled past (at the visible items'
         * average size) plus the first one's offset, over the whole estimated length less the
         * viewport. At the end it is 1; at the start 0; null when it can't scroll.
         */
        fun fractionOf(info: LazyListLayoutInfo, firstIndex: Int, firstOffset: Int, canBack: Boolean, canForward: Boolean): Double? {
            if (!canBack && !canForward) return null
            if (!canForward) return 1.0
            if (firstIndex == 0 && firstOffset == 0) return 0.0
            val visible = info.visibleItemsInfo
            if (visible.isEmpty() || info.totalItemsCount == 0) return null
            val average = visible.sumOf { it.size + info.mainAxisItemSpacing }.toDouble() / visible.size
            val viewport = (info.viewportEndOffset - info.viewportStartOffset).toDouble()
            val padding = (info.beforeContentPadding + info.afterContentPadding).toDouble()
            val total = average * info.totalItemsCount + padding
            val top = average * firstIndex + firstOffset
            // Short of the end, it never reads as the end.
            return fractionOf(top, total, viewport)?.coerceAtMost(0.99)
        }
    }
}

/**
 * The `scroll` events (PEN-175): one shared gate per area across the app, so the gap holds for an
 * area however many screens show it in turn. The screen that shows an area last owns it; one that
 * shows it again, or another page in it, starts it again from the top ([ScrollGate.reset]).
 */
object ScrollEvents {
    private val gates = HashMap<String, ScrollGate>()
    private val owners = HashMap<String, Any>()

    /** Where the gates record; tests swap it. */
    @Volatile
    internal var record: (String, Double) -> Unit = { area, position -> Analytics.record("scroll", area, propsOf(position)) }

    /** The clock new gates run on; JVM tests give their own. */
    internal var clock: () -> ScrollClock = { ScrollClock.main() }

    /** The `scroll` event's props: 0 and 1 as whole numbers, anything between in hundredths. */
    fun propsOf(position: Double): Map<String, Any?> = mapOf(
        "position" to when (position) {
            0.0 -> 0
            1.0 -> 1
            else -> position
        },
    )

    private fun gate(area: String): ScrollGate = gates.getOrPut(area) { ScrollGate({ record(area, it) }, clock()) }

    /** [owner] shows [area] with new content: it starts from the top. */
    fun shown(area: String, owner: Any) {
        owners[area] = owner
        gate(area).reset()
    }

    /** [owner]'s [area] moved; ignored once another screen shows the area. */
    fun moved(area: String, owner: Any, position: Double?) {
        if (owners[area] === owner) gate(area).moved(position)
    }

    /** [owner]'s [area] is gone: what waits for it is dropped. */
    fun gone(area: String, owner: Any) {
        if (owners[area] !== owner) return
        owners.remove(area)
        gates[area]?.stop()
    }

    /** Forgets every area: an instrumented test's fresh start. */
    fun forget() {
        gates.values.forEach(ScrollGate::stop)
        gates.clear()
        owners.clear()
    }
}

/**
 * Records how far down [state]'s scroller is as `scroll` [area] (a SCROLL_NAMES name), once it
 * settles; [contentKey] names what it shows (a page, a route), and a different one starts it
 * again from the top.
 */
@Composable
fun TrackScroll(area: String, state: ScrollState, contentKey: Any?) {
    val owner = remember { Any() }
    DisposableEffect(area, owner) { onDispose { ScrollEvents.gone(area, owner) } }
    LaunchedEffect(area, state, contentKey) {
        ScrollEvents.shown(area, owner)
        snapshotFlow { state.value }.collect { ScrollEvents.moved(area, owner, ScrollGate.fractionOf(state)) }
    }
}

/** [TrackScroll] for a lazy list: its position estimated from the items laid out. */
@Composable
fun TrackScroll(area: String, state: LazyListState, contentKey: Any?) {
    val owner = remember { Any() }
    DisposableEffect(area, owner) { onDispose { ScrollEvents.gone(area, owner) } }
    LaunchedEffect(area, state, contentKey) {
        ScrollEvents.shown(area, owner)
        snapshotFlow { state.firstVisibleItemIndex to state.firstVisibleItemScrollOffset }.collect { (index, offset) ->
            val position = ScrollGate.fractionOf(state.layoutInfo, index, offset, state.canScrollBackward, state.canScrollForward)
            ScrollEvents.moved(area, owner, position)
        }
    }
}
