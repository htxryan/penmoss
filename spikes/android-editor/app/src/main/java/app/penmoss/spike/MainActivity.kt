package app.penmoss.spike

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.inputmethod.InputMethodManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.metrics.performance.JankStats
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/** Single-Activity shell: native top bar and formatting bar around the editor WebView. */
class MainActivity : ComponentActivity() {
    private val timings = NativeTimings(processStart = Process.getStartUptimeMillis())
    private val frameStats = FrameStats()
    private var jankStats: JankStats? = null

    internal val editorState = EditorState()
    internal lateinit var webView: WebView
        private set
    internal lateinit var bridge: EditorBridge
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        timings.activityCreate = SystemClock.uptimeMillis()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect over USB; debug spike only
        webView = createEditorWebView()
        bridge = EditorBridge(
            webView = webView,
            state = editorState,
            timings = timings,
            onReady = { reportFullyDrawn() },
            onExport = { mode, payload -> Diagnostics.export(this, mode, payload, timings, frameStats) },
            onTestResult = { summary -> Toast.makeText(this, summary, Toast.LENGTH_LONG).show() },
        )
        bridge.install()
        webView.loadUrl(EDITOR_URL)

        setContent {
            SpikeTheme {
                SpikeScreen(
                    webView = webView,
                    bridge = bridge,
                    state = editorState,
                    onStartTest = ::startTypingTest,
                    onFocusEditor = ::focusEditor,
                    statsSource = { callback -> collectStats(callback) },
                    onResetFrames = frameStats::reset,
                )
            }
        }
        jankStats = JankStats.createAndTrack(window, frameStats)
    }

    override fun onResume() {
        super.onResume()
        jankStats?.isTrackingEnabled = true
    }

    override fun onPause() {
        jankStats?.isTrackingEnabled = false
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun createEditorWebView(): WebView {
        val assets = WebViewAssetLoader.Builder()
            .setDomain(ASSET_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        return WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            setBackgroundColor(if (dark) 0xFF171A1C.toInt() else 0xFFFBFAF7.toInt())
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == ASSET_HOST) return false
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    } catch (e: ActivityNotFoundException) {
                        Log.w(TAG, "No app for ${request.url}", e)
                    }
                    return true
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    timings.pageFinished = SystemClock.uptimeMillis()
                }
            }
        }
    }

    /** Give the WebView focus and ask for the keyboard (the editor element is focused from JS). */
    private fun focusEditor() {
        webView.requestFocus()
        webView.postDelayed({
            getSystemService(InputMethodManager::class.java).showSoftInput(webView, 0)
        }, 150)
    }

    private fun startTypingTest(mode: String) {
        val ime = Diagnostics.currentIme(this).substringBefore('/')
        bridge.logNative("ime=${Diagnostics.currentIme(this)}")
        bridge.startTest("$mode · $ime")
        focusEditor()
    }

    private fun collectStats(callback: (StatsSnapshot) -> Unit) {
        val frames = frameStats.toJson(Diagnostics.refreshRate(this))
        bridge.getStats { web -> callback(StatsSnapshot(timings.toJson(), frames, web)) }
    }
}
