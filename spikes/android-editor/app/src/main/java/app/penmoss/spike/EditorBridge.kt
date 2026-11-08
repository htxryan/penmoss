package app.penmoss.spike

import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

const val TAG = "PenmossSpike"
const val ASSET_HOST = "appassets.androidplatform.net"
const val EDITOR_ORIGIN = "https://$ASSET_HOST"
const val EDITOR_URL = "$EDITOR_ORIGIN/assets/editor/index.html"

/** Uptime-millis timestamps for the cold-open measurement. */
class NativeTimings(val processStart: Long) {
    var activityCreate: Long = 0
    var pageFinished: Long = 0
    var editorReady: Long = 0

    val coldOpenMs: Long? get() = if (editorReady > 0) editorReady - processStart else null

    fun toJson(): JSONObject = JSONObject()
        .put("processStartToActivityCreateMs", activityCreate - processStart)
        .put("processStartToPageFinishedMs", if (pageFinished > 0) pageFinished - processStart else JSONObject.NULL)
        .put("processStartToNotePaintedMs", coldOpenMs ?: JSONObject.NULL)
        .put("activityCreateToNotePaintedMs", if (editorReady > 0) editorReady - activityCreate else JSONObject.NULL)
}

/** Compose-observable editor state pushed from the web side. */
class EditorState {
    var active by mutableStateOf<Map<String, Boolean>>(emptyMap())
    var canUndo by mutableStateOf(false)
    var canRedo by mutableStateOf(false)
    var coldOpenMs by mutableStateOf<Long?>(null)
    var testActive by mutableStateOf(false)
    var lastTestSummary by mutableStateOf<String?>(null)
}

/**
 * Two-way bridge to `window.penmoss` in the editor bundle.
 *
 * Web → native uses a WebMessageListener restricted to the asset-loader origin
 * (no addJavascriptInterface). Native → web uses evaluateJavascript.
 */
class EditorBridge(
    private val webView: WebView,
    private val state: EditorState,
    private val timings: NativeTimings,
    private val onReady: () -> Unit,
    private val onExport: (mode: String, payload: String) -> Unit,
    private val onTestResult: (summary: String) -> Unit,
) {
    fun install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.e(TAG, "WebView too old: WEB_MESSAGE_LISTENER unsupported; native bar state and export disabled")
            return
        }
        WebViewCompat.addWebMessageListener(webView, "penmossNative", setOf(EDITOR_ORIGIN)) { _, message, _, isMainFrame, _ ->
            val data = message.data
            if (isMainFrame && data != null) handle(data)
        }
    }

    private fun handle(raw: String) {
        val msg = runCatching { JSONObject(raw) }.getOrElse {
            Log.w(TAG, "Bad bridge message: $raw")
            return
        }
        when (msg.optString("type")) {
            "ready" -> {
                timings.editorReady = SystemClock.uptimeMillis()
                state.coldOpenMs = timings.coldOpenMs
                Log.i(TAG, "Note painted: cold open ${timings.coldOpenMs} ms (process start → note painted); web ${msg.optJSONObject("timings")}")
                onReady()
            }
            "state" -> {
                val active = msg.optJSONObject("active") ?: JSONObject()
                state.active = active.keys().asSequence().associateWith { active.optBoolean(it) }
                state.canUndo = msg.optBoolean("canUndo")
                state.canRedo = msg.optBoolean("canRedo")
            }
            "export" -> onExport(msg.optString("mode", "share"), msg.optString("payload"))
            "testResult" -> {
                val summary = msg.optString("summary")
                state.lastTestSummary = summary
                onTestResult(summary)
            }
            "log" -> Log.i(TAG, "web: ${msg.optString("message")}")
        }
    }

    /** Evaluate `expression` (which may reference `penmoss`) once the bundle has loaded. */
    fun call(expression: String, callback: ((String?) -> Unit)? = null) {
        webView.evaluateJavascript("(window.penmoss ? (function(penmoss){ return $expression; })(window.penmoss) : null)", callback)
    }

    fun exec(command: String, arg: String? = null) {
        val args = if (arg == null) q(command) else "${q(command)}, ${q(arg)}"
        call("penmoss.exec($args)")
    }

    fun startTest(label: String) {
        state.testActive = true
        call("penmoss.startTest(${q(label)})")
    }

    fun checkTest() = call("penmoss.checkTest() && true")

    fun requestExport(mode: String) = call("penmoss.requestExport(${q(mode)})")

    fun getStats(callback: (JSONObject?) -> Unit) = call("penmoss.getStats()") { result ->
        callback(result?.takeIf { it != "null" }?.let { runCatching { JSONObject(it) }.getOrNull() })
    }

    fun logNative(note: String) = call("penmoss.logNative(${q(note)})")

    private fun q(value: String): String = JSONObject.quote(value)
}
