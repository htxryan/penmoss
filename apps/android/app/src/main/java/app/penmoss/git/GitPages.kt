package app.penmoss.git

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.penmoss.engine.git.FramePort
import java.io.ByteArrayInputStream

/**
 * The git engine pages (T50 G7, A872, A879): `git.html` from the APK in a WebView that is never
 * shown, one per open notebook (`role=engine`) and one for the commit check (`role=guard`).
 *
 * - Its own origin (names that resolve nowhere): the engine pages `https://git.penmoss.invalid`,
 *   the commit check `https://git-guard.penmoss.invalid`. So an engine's store in IndexedDB is not
 *   the editor's origin's (a note's page can't read or change a notebook's engine store, nor the
 *   other way round), and the guard shares no storage or BroadcastChannel with the engines it
 *   checks (A872, A876).
 * - It loads its own assets and nothing else; the page's CSP refuses every connection too.
 * - It talks only to the app, through the `penmossNative` web message listener on that origin,
 *   in binary frames (A873). The page speaks first ('ready'): its reply proxy is how the app answers.
 */
object GitPages {
    const val HOST = "git.penmoss.invalid"
    const val ORIGIN = "https://$HOST"

    /** The commit check's own origin, apart from every engine page's. */
    const val GUARD_HOST = "git-guard.penmoss.invalid"
    const val GUARD_ORIGIN = "https://$GUARD_HOST"

    /** The host a page of [role] is served from. */
    fun hostOf(role: String): String = if (role == "guard") GUARD_HOST else HOST

    /** Whether this WebView can carry the frames (an Android System WebView from the last years). */
    fun supported(): Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)

    /** Only the page's own files: the editor folder of the APK's assets. */
    internal fun isPageAsset(url: Uri, host: String = HOST): Boolean =
        url.scheme == "https" && url.host == host && url.port == -1 &&
            url.path.orEmpty().startsWith("/assets/editor/") && !url.path.orEmpty().contains("..")

    /** A page of [role] (`engine` or `guard`), made on the main thread; [onGone] when its renderer dies. */
    fun open(context: Context, role: String, onGone: () -> Unit): PagePort {
        require(role == "engine" || role == "guard")
        val port = PagePort()
        val make = Runnable { port.attach(create(context.applicationContext, role, port, onGone)) }
        if (Looper.myLooper() == Looper.getMainLooper()) make.run() else Handler(Looper.getMainLooper()).post(make)
        return port
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun create(context: Context, role: String, port: PagePort, onGone: () -> Unit): WebView {
        check(supported()) { "This Android System WebView is too old for git notebooks; update it from Google Play." }
        val host = hostOf(role)
        val loader = WebViewAssetLoader.Builder()
            .setDomain(host)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
        val view = WebView(context)
        view.settings.apply {
            javaScriptEnabled = true
            // The engine's store is IndexedDB on the page's own origin.
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        view.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                try {
                    if (isPageAsset(request.url, host)) loader.shouldInterceptRequest(request.url) ?: refused() else refused()
                } catch (error: Exception) {
                    refused()
                }

            // A git page never navigates.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                port.gone()
                onGone()
                return true
            }
        }
        WebViewCompat.addWebMessageListener(view, "penmossNative", setOf("https://$host")) { _, message, _, isMainFrame, reply ->
            // Frames only: a string is not one (A873).
            if (!isMainFrame || message.type != WebMessageCompat.TYPE_ARRAY_BUFFER) return@addWebMessageListener
            port.received(reply, message.arrayBuffer)
        }
        view.loadUrl("https://$host/assets/editor/git.html?role=$role")
        return view
    }

    private fun refused() =
        WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}

/**
 * A git page as a [FramePort]: frames to the page wait until it has spoken (its reply proxy), and
 * every call into the WebView runs on the main thread, as the WebView needs.
 */
class PagePort internal constructor() : FramePort {
    private val main = Handler(Looper.getMainLooper())
    private var view: WebView? = null
    private var reply: JavaScriptReplyProxy? = null
    private val queued = ArrayDeque<ByteArray>()
    @Volatile
    private var listener: ((ByteArray) -> Unit)? = null
    @Volatile
    var alive = true
        private set

    internal fun attach(made: WebView) {
        if (!alive) {
            made.destroy()
            return
        }
        view = made
    }

    internal fun received(proxy: JavaScriptReplyProxy, bytes: ByteArray) {
        if (reply !== proxy) {
            reply = proxy
            while (queued.isNotEmpty()) proxy.postMessage(queued.removeFirst())
        }
        // 'ready' and every other frame go to the channel, which reads what it knows.
        listener?.invoke(bytes)
    }

    internal fun gone() {
        alive = false
        reply = null
        queued.clear()
        view?.let { runCatching { it.destroy() } }
        view = null
    }

    override fun send(frame: ByteArray) {
        main.post {
            if (!alive) return@post
            val proxy = reply
            if (proxy == null) queued.addLast(frame) else proxy.postMessage(frame)
        }
    }

    override fun listen(listener: (ByteArray) -> Unit) {
        this.listener = listener
    }

    override fun close() {
        main.post { gone() }
    }
}
