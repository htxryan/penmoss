package app.penmoss.analytics

import android.os.Handler
import android.os.Looper
import android.view.ViewTreeObserver
import androidx.activity.ComponentActivity
import androidx.core.util.Consumer
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/** Runs one thing later, replacing what was waiting (a Handler in the app; tests move their own clock). */
interface Settle {
    fun after(delayMs: Long, run: () -> Unit)

    fun cancel()

    companion object {
        /** On the main thread, as the Activity's callbacks are. */
        fun main(): Settle = object : Settle {
            private val handler = Handler(Looper.getMainLooper())
            private var waiting: Runnable? = null

            override fun after(delayMs: Long, run: () -> Unit) {
                cancel()
                val next = Runnable {
                    waiting = null
                    run()
                }
                waiting = next
                handler.postDelayed(next, delayMs)
            }

            override fun cancel() {
                waiting?.let(handler::removeCallbacks)
                waiting = null
            }
        }
    }
}

/**
 * What was recorded last for each window (PEN-174), across the process: a record that matches the
 * last one for its window in the same session is dropped, so the launcher handing over to a
 * notebook at the same size, or Quick Capture's sheet made again by a rotation, records nothing
 * twice. A new session (a new recorder) starts afresh.
 */
internal class LastRecorded {
    private val last = HashMap<String, Pair<String?, Map<String, Any?>>>()

    /** Whether [props] for [window] differ from the last kept in [session]. */
    @Synchronized
    fun isNew(session: String?, window: String, props: Map<String, Any?>): Boolean = last[window] != (session to props)

    @Synchronized
    fun kept(session: String?, window: String, props: Map<String, Any?>) {
        last[window] = session to props
    }
}

/** A window's size in dp and whether it fills the screen (not split screen, free-form or a pop-up view). */
data class WindowShape(val widthDp: Float, val heightDp: Float, val fullScreen: Boolean)

/**
 * The `app window` event for one window (PEN-174): its size in dp rounded to 10, and full screen
 * on or off, once when it first lays out, [SETTLE_MS] after the last size change, and at once when
 * it enters or leaves multi-window mode (which also drops a pending settle). Moving a window is
 * never recorded, and Android has no maximised.
 */
class WindowEvents(
    /** `main` (the launcher and each notebook) or `capture` (Quick Capture's sheet). */
    private val window: String,
    private val read: () -> WindowShape,
    private val settle: Settle = Settle.main(),
    private val record: (Map<String, Any?>) -> Boolean = { Analytics.record("app", "window", it) },
    private val session: () -> String? = { Analytics.service?.session },
) {
    /** The window laid out for the first time. */
    fun shown() = recordNow()

    /** Its configuration changed (a rotation, a resize): recorded once the changes stop. */
    fun resized() = settle.after(SETTLE_MS) { recordNow() }

    /** Split screen, free-form or a pop-up view began or ended: recorded at once. */
    fun modeChanged() {
        settle.cancel()
        recordNow()
    }

    fun stop() = settle.cancel()

    private fun recordNow() {
        val props = runCatching { propsOf(window, read()) }.getOrNull() ?: return
        val now = session()
        if (!LAST.isNew(now, window, props)) return
        if (record(props)) LAST.kept(now, window, props)
    }

    companion object {
        const val SETTLE_MS = 500L

        internal val LAST = LastRecorded()

        fun propsOf(window: String, shape: WindowShape): Map<String, Any?> = mapOf(
            "window" to window,
            "width" to AnalyticsFormat.lengthOf(shape.widthDp),
            "height" to AnalyticsFormat.lengthOf(shape.heightDp),
            "fullScreen" to shape.fullScreen,
        )

        /** The Activity's window now: its bounds (WindowManager's) in dp, and multi-window mode. */
        fun shapeOf(activity: ComponentActivity): WindowShape {
            val bounds = activity.windowManager.currentWindowMetrics.bounds
            val density = activity.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
            return WindowShape(bounds.width() / density, bounds.height() / density, !activity.isInMultiWindowMode)
        }

        /**
         * Records [activity]'s window as [window]: at its first layout, after each configuration
         * change it handles itself (an Activity that declares none is made again instead, and its
         * new first layout records), and on each multi-window change; until it is destroyed.
         */
        fun attach(activity: ComponentActivity, window: String): WindowEvents {
            val events = WindowEvents(window, read = { shapeOf(activity) })
            val onConfiguration = Consumer<android.content.res.Configuration> { events.resized() }
            val onMode = Consumer<androidx.core.app.MultiWindowModeChangedInfo> { events.modeChanged() }
            activity.addOnConfigurationChangedListener(onConfiguration)
            activity.addOnMultiWindowModeChangedListener(onMode)
            val decor = activity.window.decorView
            val firstLayout = object : ViewTreeObserver.OnGlobalLayoutListener {
                override fun onGlobalLayout() {
                    if (decor.viewTreeObserver.isAlive) decor.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    events.shown()
                }
            }
            decor.viewTreeObserver.addOnGlobalLayoutListener(firstLayout)
            activity.lifecycle.addObserver(
                object : DefaultLifecycleObserver {
                    override fun onDestroy(owner: LifecycleOwner) {
                        activity.removeOnConfigurationChangedListener(onConfiguration)
                        activity.removeOnMultiWindowModeChangedListener(onMode)
                        if (decor.viewTreeObserver.isAlive) decor.viewTreeObserver.removeOnGlobalLayoutListener(firstLayout)
                        events.stop()
                    }
                },
            )
            return events
        }
    }
}
