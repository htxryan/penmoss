package app.penmoss.editor

import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream

/**
 * What the editor's WebView may reach (T32, A293): its own assets from the APK,
 * and nothing else. Requests elsewhere get an empty 403 without touching the
 * network; navigations away go to a Custom Tab (web links) or nowhere.
 */
@RunWith(AndroidJUnit4::class)
class EditorWebViewTest {
    private val asset = WebResourceResponse("text/javascript", "utf-8", ByteArrayInputStream(ByteArray(1)))
    private val served = mutableListOf<Uri>()
    private val external = mutableListOf<Uri>()
    private var gone = 0
    private val picture = WebResourceResponse("image/png", null, ByteArrayInputStream(ByteArray(1)))
    private val pictures = mutableListOf<Pair<String, String>>()
    private val client = EditorWebView.Client(
        serve = { served += it; asset },
        openExternally = { external += it },
        onRendererGone = { gone++ },
        picture = { sha, ext ->
            pictures += sha to ext
            picture.takeIf { sha != MISSING }
        },
    )

    private fun uri(text: String) = Uri.parse(text)

    @Test
    fun servesTheEditorsOwnAssets() {
        assertSame(asset, client.intercept(uri(EditorWebView.PAGE_URL)))
        assertSame(asset, client.intercept(uri("https://appassets.androidplatform.net/assets/editor/chunks/mermaid-abc.js")))
        assertEquals(2, served.size)
    }

    @Test
    fun refusesEveryOtherRequestWithoutGoingToTheNetwork() {
        for (url in listOf(
            "https://api.penmoss.app/sync/batch",
            "https://evil.example/steal?data=x",
            "http://appassets.androidplatform.net/assets/editor/editor.js",
            "https://appassets.androidplatform.net/assets/other/secret.json",
            "https://appassets.androidplatform.net/assets/editor/../../res/raw/x",
            "https://appassets.androidplatform.net:8443/assets/editor/editor.js",
            "file:///data/data/app.penmoss/databases/penmoss.db",
            "content://app.penmoss.provider/x",
            "data:text/html,hi",
        )) {
            val response = client.intercept(uri(url))
            assertEquals(url, 403, response.statusCode)
            assertEquals(url, -1, response.data.read())
        }
        assertEquals(emptyList<Uri>(), served)
    }

    @Test
    fun navigatesOnlyWithinTheEditorAndSendsWebLinksToTheBrowser() {
        assertTrue(client.allowNavigation(uri(EditorWebView.PAGE_URL)))
        assertTrue(client.allowNavigation(uri("${EditorWebView.PAGE_URL}?debug")))
        assertFalse(client.allowNavigation(uri("https://example.com/article")))
        assertFalse(client.allowNavigation(uri("http://example.com/")))
        assertEquals(listOf("https://example.com/article", "http://example.com/"), external.map { it.toString() })
        // Never the asset host under another scheme or path, and never handed out either.
        assertFalse(client.allowNavigation(uri("http://appassets.androidplatform.net/assets/editor/index.html")))
        assertFalse(client.allowNavigation(uri("https://appassets.androidplatform.net/assets/")))
        assertFalse(client.allowNavigation(uri("intent://scan#Intent;scheme=zxing;end")))
        assertFalse(client.allowNavigation(uri("javascript:alert(1)")))
        assertEquals(2, external.size)
        // Mail and phone links (A301) go to the apps that handle them.
        assertFalse(client.allowNavigation(uri("mailto:ryan@example.com")))
        assertFalse(client.allowNavigation(uri("tel:+15125550100")))
        assertEquals(listOf("mailto:ryan@example.com", "tel:+15125550100"), external.drop(2).map { it.toString() })
    }

    @Test
    fun theAppOutlivesTheEditorsRenderer() {
        assertTrue(client.onRenderProcessGone(android.webkit.WebView(org.robolectric.RuntimeEnvironment.getApplication()), FakeGone))
        assertEquals(1, gone)
    }

    @Test
    fun servesTheNotesPicturesByTheirHashOnly() {
        val sha = "a".repeat(64)
        assertSame(picture, client.intercept(uri("https://${EditorWebView.ASSET_HOST}/attachments/$sha.png")))
        assertSame(picture, client.intercept(uri("https://${EditorWebView.ASSET_HOST}/attachments/$sha.jpg")))
        // A drawing's SVG (PEN-28), shown as a picture.
        assertSame(picture, client.intercept(uri("https://${EditorWebView.ASSET_HOST}/attachments/$sha.svg")))
        // A picture the phone cannot get: missing, not refused, so the editor shows its placeholder.
        assertEquals(404, client.intercept(uri("https://${EditorWebView.ASSET_HOST}/attachments/$MISSING.webp")).statusCode)
        assertEquals(listOf(sha to "png", sha to "jpg", sha to "svg", MISSING to "webp"), pictures)
    }

    @Test
    fun aRequestThatFailsIsAnsweredNeverThrown() {
        // An exception on the WebView's request thread would take the whole app down (A312).
        val failing = EditorWebView.Client(
            serve = { throw IllegalStateException("asset gone") },
            openExternally = {},
            onRendererGone = {},
            picture = { _, _ -> throw java.io.FileNotFoundException("cleared meanwhile") },
        )
        assertEquals(403, failing.intercept(uri(EditorWebView.PAGE_URL)).statusCode)
        assertEquals(404, failing.intercept(uri("https://${EditorWebView.ASSET_HOST}/attachments/${"a".repeat(64)}.png")).statusCode)
    }

    @Test
    fun refusesAnythingElseThatLooksLikeAPicture() {
        val sha = "a".repeat(64)
        for (url in listOf(
            "http://${EditorWebView.ASSET_HOST}/attachments/$sha.png",
            "https://api.penmoss.app/attachments/$sha.png",
            "https://${EditorWebView.ASSET_HOST}:8443/attachments/$sha.png",
            "https://${EditorWebView.ASSET_HOST}/attachments/$sha.svg?x=1",
            "https://${EditorWebView.ASSET_HOST}/attachments/$sha.excalidraw",
            "https://${EditorWebView.ASSET_HOST}/attachments/${"A".repeat(64)}.png",
            "https://${EditorWebView.ASSET_HOST}/attachments/$sha.png?token=x",
            "https://${EditorWebView.ASSET_HOST}/attachments/../databases/penmoss.db",
            "https://${EditorWebView.ASSET_HOST}/notes/attachments/$sha.png",
        )) {
            assertEquals(url, 403, client.intercept(uri(url)).statusCode)
        }
        assertEquals(emptyList<Pair<String, String>>(), pictures)
    }

    @Test
    fun aPictureIsAnsweredWithItsTypeAndNeverSniffed() {
        val file = java.io.File.createTempFile("picture", ".jpg").apply { writeBytes(byteArrayOf(1, 2)) }
        try {
            val response = EditorWebView.pictureResponse(file, "jpg")
            assertEquals("image/jpeg", response.mimeType)
            assertEquals(200, response.statusCode)
            assertEquals("nosniff", response.responseHeaders["X-Content-Type-Options"])
            assertEquals(1, response.data.read())
            response.data.close()
        } finally {
            file.delete()
        }
    }

    @Test
    fun aDrawingsSvgIsAnsweredAsAPictureThatCouldNeverRunAsAPage() {
        // PEN-28: an `<img>` runs none of an SVG's script; opened as a page, the policy would
        // still give it no script, no requests and an origin of its own.
        val file = java.io.File.createTempFile("drawing", ".svg").apply { writeText("<svg xmlns=\"http://www.w3.org/2000/svg\"/>") }
        try {
            val response = EditorWebView.pictureResponse(file, "svg")
            assertEquals("image/svg+xml", response.mimeType)
            assertEquals("nosniff", response.responseHeaders["X-Content-Type-Options"])
            val policy = response.responseHeaders["Content-Security-Policy"]!!
            assertTrue(policy, policy.contains("default-src 'none'"))
            assertTrue(policy, policy.endsWith("sandbox"))
            assertEquals(null, EditorWebView.pictureResponse(file, "png").responseHeaders["Content-Security-Policy"])
            response.data.close()
        } finally {
            file.delete()
        }
    }

    @Test
    fun thePagesFilePickerOpensThePhotoPickerInstead() {
        var picked = 0
        val chrome = EditorWebView.Chrome { picked++ }
        var answered: Array<Uri>? = arrayOf(Uri.EMPTY)
        val view = android.webkit.WebView(org.robolectric.RuntimeEnvironment.getApplication())
        assertTrue(chrome.onShowFileChooser(view, { answered = it }, FakeChooser))
        // The page gets no file: the app inserts the pictures itself.
        assertEquals(null, answered)
        assertEquals(1, picked)
    }

    @Test
    fun theFileItemsPickerOpensTheDocumentPickerAndImagesThePhotoPicker() {
        // T40 P8, ED12: the slash menu's File asks for any type; Image for the picture types.
        val picked = mutableListOf<String>()
        val chrome = EditorWebView.Chrome(onPickFiles = { picked += "files" }, onPickImages = { picked += "pictures" })
        var answered: Array<Uri>? = arrayOf(Uri.EMPTY)
        val view = android.webkit.WebView(org.robolectric.RuntimeEnvironment.getApplication())
        assertTrue(chrome.onShowFileChooser(view, { answered = it }, Chooser(arrayOf(""))))
        assertEquals(null, answered)
        chrome.onShowFileChooser(view, {}, Chooser(arrayOf("image/png,image/jpeg,image/gif,image/webp,image/avif")))
        chrome.onShowFileChooser(view, {}, Chooser(arrayOf("image/png", "application/pdf")))
        assertEquals(listOf("files", "pictures", "files"), picked)
        assertTrue(EditorWebView.picturesOnly(arrayOf("image/*")))
        assertFalse(EditorWebView.picturesOnly(null))
    }

    @Test
    fun answersAWebPictureOnlyAtItsOwnPathAndNeverThrows() {
        // T40 P8, ED13: `/remote?u=<address>`, and `now=1` once tapped; anything else is refused.
        val asked = mutableListOf<EditorWebView.RemoteRequest>()
        val file = java.io.File.createTempFile("remote", ".png").apply { writeBytes(byteArrayOf(1)) }
        try {
            val remote = EditorWebView.Client(
                serve = { null },
                openExternally = {},
                onRendererGone = {},
                remote = { request ->
                    asked += request
                    if (request.address.endsWith("boom")) throw IllegalStateException("boom")
                    EditorWebView.remoteResponse(file, "png")
                },
            )
            val address = "https://example.com/cat.png?size=2"
            val ok = remote.intercept(Uri.parse("${EditorWebView.ORIGIN}/remote?u=${Uri.encode(address)}"))
            assertEquals(200, ok.statusCode)
            assertEquals("image/png", ok.mimeType)
            assertEquals("no-store", ok.responseHeaders["Cache-Control"])
            ok.data.close()
            remote.intercept(Uri.parse("${EditorWebView.ORIGIN}/remote?now=1&u=${Uri.encode(address)}")).data.close()
            assertEquals(
                listOf(EditorWebView.RemoteRequest(address, tapped = false), EditorWebView.RemoteRequest(address, tapped = true)),
                asked,
            )
            assertEquals(404, remote.intercept(Uri.parse("${EditorWebView.ORIGIN}/remote?u=https%3A%2F%2Fx%2Fboom")).statusCode)
            for (bad in listOf(
                "${EditorWebView.ORIGIN}/remote",
                "${EditorWebView.ORIGIN}/remote?u=a&u=b",
                "${EditorWebView.ORIGIN}/remote?u=a&now=2",
                "${EditorWebView.ORIGIN}/remote?u=a&token=x",
                "${EditorWebView.ORIGIN}/remote/x?u=a",
                "https://example.com/remote?u=a",
            )) {
                assertEquals(bad, null, EditorWebView.remoteOf(Uri.parse(bad)))
                assertEquals(bad, 403, remote.intercept(Uri.parse(bad)).statusCode)
            }
            assertEquals(3, asked.size)
        } finally {
            file.delete()
        }
    }

    private class Chooser(private val types: Array<String>) : android.webkit.WebChromeClient.FileChooserParams() {
        override fun getMode() = MODE_OPEN_MULTIPLE

        override fun getAcceptTypes() = types

        override fun isCaptureEnabled() = false

        override fun getTitle(): CharSequence? = null

        override fun getFilenameHint(): String? = null

        override fun createIntent() = android.content.Intent()
    }

    private object FakeChooser : android.webkit.WebChromeClient.FileChooserParams() {
        override fun getMode() = MODE_OPEN_MULTIPLE

        override fun getAcceptTypes() = arrayOf("image/*")

        override fun isCaptureEnabled() = false

        override fun getTitle(): CharSequence? = null

        override fun getFilenameHint(): String? = null

        override fun createIntent() = android.content.Intent()
    }

    private companion object {
        val MISSING = "f".repeat(64)
    }

    private object FakeGone : android.webkit.RenderProcessGoneDetail() {
        override fun didCrash() = true

        override fun rendererPriorityAtExit() = 0
    }
}
