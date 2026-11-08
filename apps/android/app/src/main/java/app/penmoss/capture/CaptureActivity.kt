package app.penmoss.capture

import android.content.Intent
import app.penmoss.engine.notes.DeepLink
import app.penmoss.engine.notes.DeepLinks
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import app.penmoss.editor.PickedPictures
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.AppGraph
import app.penmoss.graph
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import app.penmoss.ui.MainActivity
import app.penmoss.ui.PenmossTheme
import app.penmoss.ui.followShownVariant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * Quick capture on Android (T34, A339–A341): the share sheet's target for
 * text, links and pictures, and what the Quick Settings tile and the
 * home-screen widget open. A sheet over whatever was on screen; Save stores
 * the capture on the phone (offline too) and closes, and sync sends it.
 *
 * The save belongs to the draft, not to this instance (A348): the draft's id
 * survives rotation, the save runs on the app's scope under that id, and
 * whichever sheet shows the draft when it is done closes. A sheet made again
 * mid-save shows it saving, and cannot save it a second time.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CaptureActivity : ComponentActivity() {
    private var ui by mutableStateOf(CaptureUi())
    private var draft = CaptureDraft()
    private lateinit var draftId: String

    /** The graph of a git notebook the sheet offers (A888, G8; A1040). */
    private fun graphOf(key: String?): AppGraph? =
        key?.let { graph.gitIfAny?.let { hub -> runCatching { hub.graph(key) }.getOrNull() } }

    /** What the person chose on this sheet (kept through rotation), or null. */
    private var pickedNotebook: String? = null

    /** Where it can go: each git notebook on the phone, by name (A1040). */
    private fun notebookOptions(): List<CaptureNotebook> {
        val git = runCatching { graph.git.notebooks.entries() }.getOrNull().orEmpty()
        return git.map { CaptureNotebook(it.localId, it.name) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        draftId = savedInstanceState?.getString(DRAFT) ?: UUID.randomUUID().toString()
        // A `penmoss://` link other than `penmoss://capture` itself (T40 P7, PL5): ignored.
        if (intent?.action == Intent.ACTION_VIEW && DeepLinks.parse(intent.data?.toString()) != DeepLink.Capture) {
            finish()
            return
        }
        draft = ShareIntents.draftOf(intent, packageName) { authority ->
            packageManager.resolveContentProvider(authority, 0)?.packageName
        } ?: CaptureDraft()
        ui = ui.copy(text = savedInstanceState?.getString(TEXT) ?: draft.text, pictures = draft.pictures.size)
        val chosen = savedInstanceState?.getString(DESTINATION)
        lifecycleScope.launch {
            // Read first: `ui` is copied once it is known, never a copy from before the read.
            val destination = chosen ?: graph.captures.destination()
            ui = ui.copy(destination = destination)
        }
        // Which notebook (A888): named on the sheet, changeable; with several git notebooks and
        // no Journal notebook picked, the person chooses. Followed as notebooks come and go.
        pickedNotebook = savedInstanceState?.getString(NOTEBOOK)
        ui = ui.copy(notebook = pickedNotebook)
        lifecycleScope.launch {
            graph.git.list.collect {
                val options = notebookOptions()
                val kept = pickedNotebook?.takeIf { key -> options.any { it.key == key } }
                ui = ui.copy(
                    notebooks = options,
                    notebook = kept ?: CaptureNotebook.start(graph.git.journalPicked(), options),
                    hasNotebook = options.isNotEmpty(),
                )
            }
        }
        lifecycleScope.launch {
            // The save state of the notebook chosen: a sheet made again mid-save shows it saving.
            snapshotFlow { ui.notebook }.flatMapLatest { key -> graphOf(key)?.captures?.saveState(draftId) ?: flowOf(null) }.collect { state ->
                when (state) {
                    Captures.SaveState.Saving -> ui = ui.copy(busy = true, message = null)
                    is Captures.SaveState.Done -> if (state.saved != null) {
                        finish()
                    } else {
                        ui = ui.copy(busy = false, message = "Nothing could be saved. Check the text or pictures and try again.")
                    }
                    null -> Unit
                }
            }
        }
        setContent {
            val appearance by graph.appearance.collectAsStateWithLifecycle()
            val dark = appearance.isDark(isSystemInDarkTheme())
            // The bars over the sheet follow the variant shown, as the app's do (A414).
            LaunchedEffect(dark) { followShownVariant(dark) }
            PenmossTheme(appearance, dark) {
                CaptureScreen(
                    ui = ui,
                    onText = ::edit,
                    onDestination = { ui = ui.copy(destination = it) },
                    onNotebook = {
                        pickedNotebook = it
                        ui = ui.copy(notebook = it, message = null)
                    },
                    onSave = ::save,
                    onCancel = ::cancel,
                    onKeepEditing = { ui = ui.copy(discarding = false) },
                    onDiscard = ::finish,
                    onOpenApp = {
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        finish()
                    },
                )
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(DRAFT, draftId)
        outState.putString(TEXT, ui.text)
        outState.putString(DESTINATION, ui.destination)
        outState.putString(NOTEBOOK, ui.notebook)
    }

    /**
     * Cancel, Back or a tap outside (A528): text typed or changed here is thrown away only once
     * confirmed. What another app shared, untouched, can be shared again, so it goes at once.
     */
    private fun cancel() {
        if (!ui.busy && ui.text.isNotBlank() && ui.text != draft.text) ui = ui.copy(discarding = true) else finish()
    }

    /** The text as typed or pasted, cut at what a capture may hold (A347). */
    private fun edit(text: String) {
        val kept = Utf8.cut(text, ShareIntents.MAX_TEXT)
        ui = ui.copy(text = kept, message = if (kept.length < text.length) TOO_LONG else null)
    }

    private fun save() {
        if (ui.busy) return
        val text = ui.text
        val destination = ui.destination
        val uris = draft.pictures
        val name = ui.notebooks.firstOrNull { it.key == ui.notebook }?.name
        val graph = graphOf(ui.notebook) ?: return
        val named = ui.notebooks.size > 1
        val resolver = applicationContext.contentResolver
        val app = applicationContext
        // The app's scope: the capture is stored even if this sheet is gone by then.
        graph.scope.launch {
            // Each picture read only when the one before is stored (A348).
            val sources = uris.map { uri -> suspend { withContext(Dispatchers.IO) { PickedPictures.read(resolver, uri) } } }
            val saved = graph.captures.saveDraft(draftId, text, sources, destination) ?: return@launch
            val into = if (named && name != null) " in $name" else ""
            val where = if (saved.destination == CaptureRequest.INBOX) "Saved as a new note in Inbox$into" else "Saved to today’s note$into"
            val unread = saved.refusedPictures
            val pictures = if (unread > 0) " ${if (unread == 1) "A picture" else "$unread pictures"} could not be read." else ""
            val cut = if (saved.cut) " It was too long, so its end was cut." else ""
            Toast.makeText(app, "$where.$pictures$cut", Toast.LENGTH_SHORT).show()
        }
    }

    private companion object {
        const val DRAFT = "draft"
        const val TEXT = "text"
        const val DESTINATION = "destination"
        const val NOTEBOOK = "notebook"
        const val TOO_LONG = "That is more than a capture can hold, so the end is cut."
    }
}
