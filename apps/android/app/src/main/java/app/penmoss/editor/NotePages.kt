package app.penmoss.editor

import android.content.Context
import android.view.View
import android.webkit.WebResourceResponse

/**
 * What a note screen shows its note in (T40 P7 review S1, S7): the editor's WebView, or under
 * test a stand-in handed the same channel and hooks, so the screen's wiring (what reaches the
 * page, what the page's messages reach) can be driven where no WebView runs.
 */
fun interface NotePages {
    fun create(context: Context, noteId: String, channel: EditorWebView.Channel, hooks: Hooks): View

    /** What the page's side of the bridge calls into, as [EditorWebView.create] takes them. */
    class Hooks(
        val onMessage: (String) -> Unit,
        val onRendererGone: () -> Unit,
        val onBytes: (ByteArray) -> Unit,
        val picture: (String, String) -> WebResourceResponse?,
        val onPickImages: () -> Unit,
        /** The File item's picker (T40 P8, ED12). */
        val onPickFiles: () -> Unit = onPickImages,
        /** A picture from a web address (T40 P8, ED13). */
        val remote: (EditorWebView.RemoteRequest) -> WebResourceResponse? = { null },
    )

    companion object {
        /** The editor's own page (A293). */
        val Editor = NotePages { context, _, channel, hooks ->
            EditorWebView.create(
                context,
                channel,
                onMessage = hooks.onMessage,
                onRendererGone = hooks.onRendererGone,
                onBytes = hooks.onBytes,
                picture = hooks.picture,
                onPickImages = hooks.onPickImages,
                onPickFiles = hooks.onPickFiles,
                remote = hooks.remote,
                dispatchesKeys = true,
            )
        }
    }
}
