package app.penmoss.ui

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.editor.EditorWebView
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ToEditor
import kotlinx.serialization.json.JsonObject

/** What the preview needs of a WebView: made with a channel, told when the page is ready and when its renderer has gone. */
fun interface PreviewViews {
    fun create(context: Context, channel: EditorWebView.Channel, onReady: () -> Unit, onGone: () -> Unit): View
}

/** The editor page in preview mode (A418): no links out, and only `ready` is listened to. */
val EDITOR_PREVIEW = PreviewViews { context, channel, onReady, onGone ->
    EditorWebView.create(
        context,
        channel,
        onMessage = { raw -> if (BridgeProtocol.decodeFromEditor(raw) == FromEditor.Ready) onReady() },
        onRendererGone = onGone,
        openLinks = false,
    )
}

/**
 * The theme editor's preview (T40 P1b, A418): the real editor page showing its sample note,
 * re-themed through `theme` as each colour changes, so it is the note's own stylesheet. It is
 * an editor WebView like the note's, and never two are alive at once (the matrix's rule for
 * memory): while a note's WebView has not gone yet, this waits and says so, and while this is
 * alive a note's waits ([EditorWebView.previewOpen]). A renderer that dies takes its WebView
 * with it, and Reload makes another.
 */
@Composable
fun ThemePreview(theme: JsonObject, variant: String, modifier: Modifier, views: PreviewViews = EDITOR_PREVIEW) {
    val live by EditorWebView.live.collectAsStateWithLifecycle()
    var view by remember { mutableStateOf<View?>(null) }
    var ready by remember { mutableStateOf(false) }
    var gone by remember { mutableStateOf(false) }
    // Each WebView made here, so Reload makes a new one with a new channel.
    var made by remember { mutableIntStateOf(0) }
    val channel = remember(made) { EditorWebView.Channel() }
    fun release() {
        when (val shown = view) {
            is WebView -> {
                (shown.parent as? ViewGroup)?.removeView(shown)
                EditorWebView.destroy(shown)
            }
            null -> Unit
            else -> EditorWebView.destroyed()
        }
        view = null
        ready = false
        EditorWebView.previewClosed()
    }
    DisposableEffect(Unit) { onDispose { release() } }
    when {
        gone -> {
            Column(modifier, verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Preview unavailable", Modifier.testTag("previewGone"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(
                    onClick = {
                        gone = false
                        made++
                    },
                    modifier = Modifier.testTag("previewReload"),
                ) { Text("Reload") }
            }
            return
        }
        view == null && live > 0 -> {
            Box(modifier, contentAlignment = Alignment.Center) {
                Text(
                    "The preview opens once the note has closed.",
                    Modifier.testTag("previewWaiting"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            return
        }
    }
    key(made) {
        AndroidView(
            factory = { context ->
                EditorWebView.previewOpened()
                views.create(context, channel, onReady = { ready = true }, onGone = {
                    release()
                    gone = true
                }).also { view = it }
            },
            modifier = modifier,
        )
    }
    LaunchedEffect(ready, made) { if (ready) channel.send(BridgeProtocol.encode(ToEditor.Preview)) }
    LaunchedEffect(ready, made, theme, variant) { if (ready) channel.send(BridgeProtocol.encode(ToEditor.Theme(theme, variant))) }
}
