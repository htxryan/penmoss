package app.penmoss.editor

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.browser.customtabs.CustomTabsIntent
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.penmoss.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream

/**
 * The WebView that hosts the shared editor (T32, A282, A293): the page comes
 * from the APK through WebViewAssetLoader at a fixed https origin, talks to the
 * app only through the `penmossNative` WebMessageListener (restricted to that
 * origin; no addJavascriptInterface), and reaches nothing else: every request
 * for anything but the editor's own assets and the note's pictures (A304) is
 * refused here, the page's CSP refuses them too, and links open in a Custom
 * Tab. It has no token: the app fetches a picture the phone lacks itself.
 */
object EditorWebView {
    const val ASSET_HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$ASSET_HOST"
    const val ASSET_PATH = "/assets/editor/"
    const val PAGE_URL = "$ORIGIN${ASSET_PATH}index.html"

    /** The graph page (T40 P7, A478), beside the editor's: the same origin, CSP and blocking. */
    const val GRAPH_PAGE = "graph.html"

    /**
     * Whether a key with [focus] is the page's to dispatch (A493): the note's editor page only
     * (T40 P9 review S1, A555). The graph's and the theme preview's run no key handling, so with
     * either focused the app's shortcuts still run natively.
     */
    fun handsKeysToPage(focus: android.view.View?): Boolean = (focus as? SelectionWebView)?.dispatchesKeys == true

    /** Where the page asks for a note's pictures (A304): `/attachments/<sha256>.<ext>`. */
    private val PICTURE_PATH = Regex("^/attachments/([0-9a-f]{64})\\.(png|jpg|gif|webp|avif)$")

    /** Where the page asks for a picture from a web address (T40 P8, ED13): `/remote?u=<address>`. */
    const val REMOTE_PATH = "/remote"

    /** A picture from a web address, as the page asks for it. */
    data class RemoteRequest(val address: String, val tapped: Boolean)

    /** The web address the page asks for on its own origin, or null: `?u=`, and `now=1` once tapped. */
    fun remoteOf(url: Uri): RemoteRequest? {
        if (url.scheme != "https" || url.host != ASSET_HOST || url.port != -1 || url.path != REMOTE_PATH) return null
        val names = url.queryParameterNames
        if (!names.contains("u") || !names.all { it == "u" || it == "now" }) return null
        val address = url.getQueryParameters("u").singleOrNull() ?: return null
        val now = url.getQueryParameters("now")
        if (now.size > 1 || (now.isNotEmpty() && now[0] != "1")) return null
        return RemoteRequest(address, tapped = now.isNotEmpty())
    }

    private val alive = MutableStateFlow(0)

    /**
     * How many editor WebViews exist now (T40 P1b, A418). Never two at once: each holds a
     * renderer and the editor, too much memory for a phone, so the theme editor's preview waits
     * until the note's WebView has gone.
     */
    val live: StateFlow<Int> = alive.asStateFlow()

    /** One was made outside [create] (tests); [destroyed] balances it. */
    fun created() = alive.update { it + 1 }

    fun destroyed() = alive.update { (it - 1).coerceAtLeast(0) }

    private val previewing = MutableStateFlow(false)

    /**
     * Whether the theme editor's preview is alive (A418). A note's WebView is not made while it
     * is, as the preview is not made while a note's is: never two, either way round.
     */
    val previewOpen: StateFlow<Boolean> = previewing.asStateFlow()

    fun previewOpened() {
        previewing.value = true
    }

    fun previewClosed() {
        previewing.value = false
    }

    /** Destroys an editor WebView made by [create], so the next may be made. */
    fun destroy(view: WebView) {
        view.destroy()
        destroyed()
    }

    /** A debug build loads the page with `?debug`, which exposes the editor to chrome://inspect. */
    val pageUrl: String get() = urlOf("index.html")

    /** One of the APK's pages by file name, with `?debug` on a debug build. */
    fun urlOf(page: String): String = "$ORIGIN$ASSET_PATH$page" + if (BuildConfig.DEBUG) "?debug" else ""

    /** One of the editor page's own files, served from the APK. */
    fun isEditorAsset(url: Uri): Boolean =
        url.scheme == "https" && url.host == ASSET_HOST && url.port == -1 &&
            url.path.orEmpty().startsWith(ASSET_PATH) && !url.path.orEmpty().contains("..")

    /** One of the note's pictures, as the page asks for it: its hash and extension, or null. */
    fun pictureOf(url: Uri): Pair<String, String>? {
        if (url.scheme != "https" || url.host != ASSET_HOST || url.port != -1 || url.query != null) return null
        val match = PICTURE_PATH.matchEntire(url.path.orEmpty()) ?: return null
        return match.groupValues[1] to match.groupValues[2]
    }

    /** A picture's file as the WebView's answer: its type, never sniffed, cached by the WebView. */
    fun pictureResponse(file: File, ext: String): WebResourceResponse = WebResourceResponse(
        "image/" + if (ext == "jpg") "jpeg" else ext,
        null,
        200,
        "OK",
        mapOf("X-Content-Type-Options" to "nosniff", "Cache-Control" to "private, max-age=31536000, immutable"),
        FileInputStream(file),
    )

    /**
     * A picture from a web address as the WebView's answer (ED13): its sniffed type, and never
     * kept by the WebView, so turning the setting off takes effect at once.
     */
    fun remoteResponse(file: File, ext: String): WebResourceResponse = WebResourceResponse(
        "image/" + if (ext == "jpg") "jpeg" else ext,
        null,
        200,
        "OK",
        mapOf("X-Content-Type-Options" to "nosniff", "Cache-Control" to "no-store"),
        FileInputStream(file),
    )

    /** Posts messages to the page once it has said something (the listener's reply proxy). */
    class Channel {
        private var proxy: JavaScriptReplyProxy? = null
        private val queued = mutableListOf<String>()

        /** The page's proxy; a reloaded page brings a new one, which replaces the old. */
        fun attach(reply: JavaScriptReplyProxy) {
            if (proxy === reply) return
            proxy = reply
            queued.forEach(reply::postMessage)
            queued.clear()
        }

        fun send(message: String) {
            proxy?.postMessage(message) ?: queued.add(message)
        }
    }

    /**
     * What the editor's WebView may load (A293): its own assets, nothing else. A
     * navigation away opens http(s) links in a Custom Tab and drops anything else.
     */
    class Client(
        private val serve: (Uri) -> WebResourceResponse?,
        private val openExternally: (Uri) -> Unit,
        private val onRendererGone: () -> Unit,
        /** A note's picture by hash and extension (A304); null when the phone cannot get it. */
        private val picture: (String, String) -> WebResourceResponse? = { _, _ -> null },
        /** A picture from a web address (ED13); null when it may not or cannot be had. */
        private val remote: (RemoteRequest) -> WebResourceResponse? = { null },
    ) : WebViewClientCompat() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            intercept(request.url)

        /**
         * The response for one request: an asset, a picture, or a refusal that never reaches
         * the network. Never throws: an exception here would take the whole app down (A312).
         */
        fun intercept(url: Uri): WebResourceResponse {
            if (isEditorAsset(url)) {
                return try {
                    serve(url)
                } catch (error: Exception) {
                    null
                } ?: refused()
            }
            remoteOf(url)?.let { asked ->
                return try {
                    remote(asked)
                } catch (error: Exception) {
                    null
                } ?: missing()
            }
            val (sha, ext) = pictureOf(url) ?: return refused()
            return try {
                picture(sha, ext)
            } catch (error: Exception) {
                null
            } ?: missing()
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            !allowNavigation(request.url)

        /** True only for the page's own documents; anything else goes outside or nowhere. */
        fun allowNavigation(url: Uri): Boolean {
            if (isEditorAsset(url)) return true
            val web = url.host != ASSET_HOST && (url.scheme == "https" || url.scheme == "http")
            // Mail and phone links (A301) go to the apps that handle them.
            if (web || url.scheme == "mailto" || url.scheme == "tel") openExternally(url)
            return false
        }

        /** The renderer crashed or was killed: the app carries on; the note screen says so. */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onRendererGone()
            return true
        }

        private fun refused() =
            WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

        private fun missing() =
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    /** Whether a file chooser asks for pictures only (the Image item's), not any file (File's, ED12). */
    fun picturesOnly(acceptTypes: Array<String>?): Boolean {
        val types = acceptTypes.orEmpty().flatMap { it.split(',') }.map(String::trim).filter(String::isNotEmpty)
        return types.isNotEmpty() && types.all { it.startsWith("image/") }
    }

    /**
     * The page's own file picker opens Android's instead (A304; T40 P8, ED12): the slash menu's
     * Image the photo picker, and File the document picker. The app reads what was picked and
     * inserts it, so the page never gets a file.
     */
    class Chrome(
        /** The File item's picker; without it, the photo picker. */
        private val onPickFiles: (() -> Unit)? = null,
        private val onPickImages: () -> Unit,
    ) : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            callback.onReceiveValue(null)
            if (picturesOnly(params.acceptTypes)) onPickImages() else (onPickFiles ?: onPickImages)()
            return true
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun create(
        context: Context,
        channel: Channel,
        onMessage: (String) -> Unit,
        onRendererGone: () -> Unit,
        /** A picture's bytes, sent right after its `attachment` message (A304). */
        onBytes: (ByteArray) -> Unit = {},
        picture: (String, String) -> WebResourceResponse? = { _, _ -> null },
        onPickImages: () -> Unit = {},
        /** False for the theme preview: a link there goes nowhere, not to the browser. */
        openLinks: Boolean = true,
        /** The File item's picker (ED12): the document picker. */
        onPickFiles: () -> Unit = onPickImages,
        /** A picture from a web address (ED13). */
        remote: (RemoteRequest) -> WebResourceResponse? = { null },
        /** The page to load: the editor's, or [GRAPH_PAGE] (T40 P7). */
        page: String = "index.html",
        /** The note's page, which dispatches its own keys ([handsKeysToPage], A555). */
        dispatchesKeys: Boolean = false,
    ): WebView {
        val loader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
        // Its selection menu gains the copies and Penmoss's Paste as plain text (T40 P8).
        val view = SelectionWebView(context)
        view.dispatchesKeys = dispatchesKeys
        // Fills its slot (T39): a WebView left at Compose's default WRAP_CONTENT reports a
        // viewport of zero height to the page, so CSS `vh` is 0 and the slash and `[[` menus
        // (max-height in vh) open as an empty sliver.
        view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        view.webViewClient = Client(
            serve = loader::shouldInterceptRequest,
            openExternally = { if (openLinks) openExternally(view.context, it) },
            onRendererGone = onRendererGone,
            picture = picture,
            remote = remote,
        )
        view.webChromeClient = Chrome(onPickFiles, onPickImages)
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            "This Android System WebView is too old for Penmoss; update it from Google Play."
        }
        val bytes = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        WebViewCompat.addWebMessageListener(view, "penmossNative", setOf(ORIGIN)) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            if (bytes && message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
                channel.attach(reply)
                onBytes(message.arrayBuffer)
                return@addWebMessageListener
            }
            val data = message.data ?: return@addWebMessageListener
            channel.attach(reply)
            onMessage(data)
        }
        view.loadUrl(urlOf(page))
        created()
        return view
    }

    /** A web link from a note: the browser, never the editor's WebView. */
    fun openExternally(context: Context, url: Uri) {
        when (url.scheme) {
            "https", "http" -> runCatching { CustomTabsIntent.Builder().build().launchUrl(context, url) }
            // No app for it (a phone with no mail app): nothing happens, as on a desktop.
            "mailto", "tel" -> runCatching {
                context.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }
}
