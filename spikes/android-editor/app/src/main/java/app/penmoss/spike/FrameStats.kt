package app.penmoss.spike

import androidx.metrics.performance.FrameData
import androidx.metrics.performance.JankStats
import org.json.JSONObject
import kotlin.math.roundToInt

/** Aggregates JankStats frame data (FrameMetrics underneath) for the whole window. */
class FrameStats : JankStats.OnFrameListener {
    private val window = FloatArray(20_000)
    private var frames = 0L
    private var janky = 0L
    private var next = 0

    @Synchronized
    override fun onFrame(volatileFrameData: FrameData) {
        frames++
        if (volatileFrameData.isJank) janky++
        window[next % window.size] = volatileFrameData.frameDurationUiNanos / 1_000_000f
        next++
    }

    @Synchronized
    fun reset() {
        frames = 0
        janky = 0
        next = 0
    }

    @Synchronized
    fun toJson(refreshHz: Float): JSONObject {
        val n = minOf(next, window.size)
        val sorted = window.copyOf(n).sorted()
        fun pct(p: Int) = if (n == 0) 0f else sorted[minOf(n - 1, n * p / 100)]
        val budget60 = 1000f / 60f
        return JSONObject()
            .put("frames", frames)
            .put("jankyFrames", janky)
            .put("jankPercent", if (frames == 0L) 0 else (janky * 1000 / frames) / 10.0)
            .put("uiDurationP50Ms", round1(pct(50)))
            .put("uiDurationP95Ms", round1(pct(95)))
            .put("uiDurationP99Ms", round1(pct(99)))
            .put("uiDurationMaxMs", round1(sorted.lastOrNull() ?: 0f))
            .put("framesOver60fpsBudget", sorted.count { it > budget60 })
            .put("displayRefreshHz", round1(refreshHz))
    }

    private fun round1(v: Float) = (v * 10).roundToInt() / 10.0
}
