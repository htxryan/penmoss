package app.penmoss.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import app.penmoss.editor.FileRequest
import app.penmoss.editor.NoteFiles
import app.penmoss.editor.OpenedFiles
import app.penmoss.engine.bridge.FileAction
import app.penmoss.engine.bridge.FileLimits
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The note screen's files (T40 P8, ED12): the document picker for the bar's Attach and the
 * slash menu's File, and a chip's Open and Save a copy. Returns what opens the picker.
 */
@Composable
internal fun rememberNoteFiles(
    files: NoteFiles,
    scope: CoroutineScope,
    snackbar: SnackbarHostState,
    /** The note takes the focus back once a picker closes. */
    onRefocus: () -> Unit,
): () -> Unit {
    val context = LocalContext.current
    val refocus by rememberUpdatedState(onRefocus)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        refocus()
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val picked = withContext(Dispatchers.IO) {
                uris.take(NoteFiles.MAX_PICKED).map { OpenedFiles.picked(context.contentResolver, it) }
            }
            if (uris.size > NoteFiles.MAX_PICKED) snackbar.showSnackbar("Up to ${NoteFiles.MAX_PICKED} files go in at once.")
            // One at a time, each streamed to disk (review PS1); refusals say why through the note's notices.
            files.insertPicked(picked)
        }
    }
    // What Save a copy writes while its picker is open (one at a time): the chip's path and name,
    // kept across the activity being recreated meanwhile, as the file is found again (review PS4).
    var saving by rememberSaveable { mutableStateOf<List<String>?>(null) }
    val saver = rememberLauncherForActivityResult(OpenedFiles.SaveCopy()) { target ->
        val request = saving
        saving = null
        refocus()
        if (target == null) return@rememberLauncherForActivityResult
        scope.launch {
            val file = request?.let { files.document(it[0]) }
            val ok = file != null && withContext(Dispatchers.IO) { OpenedFiles.save(context.contentResolver, file, target) }
            // The picker made the document already: never leave it empty.
            if (!ok) withContext(Dispatchers.IO) { OpenedFiles.discard(context.contentResolver, target) }
            snackbar.showSnackbar(
                when {
                    ok -> "Saved a copy."
                    request != null && file == null -> unavailable(FileRequest(request[0], request[1], FileAction.SAVE))
                    else -> "The copy could not be saved."
                },
            )
        }
    }
    LaunchedEffect(files) {
        files.requests.collect { request ->
            val ext = FileLimits.PATH.matchEntire(request.path)?.groupValues?.get(2) ?: return@collect
            val file = files.document(request.path)
            if (file == null) {
                snackbar.showSnackbar(unavailable(request))
                return@collect
            }
            when (request.action) {
                FileAction.SAVE -> {
                    saving = listOf(request.path, request.name)
                    saver.launch(OpenedFiles.safeName(request.name, ext) to OpenedFiles.viewType(ext))
                }
                FileAction.OPEN -> {
                    val opened = withContext(Dispatchers.IO) { OpenedFiles.open(context, file, request.name, ext) }
                    if (!opened) {
                        val answer = snackbar.showSnackbar(
                            "No app on this phone opens “${request.name}”.",
                            actionLabel = "Save a Copy",
                            duration = SnackbarDuration.Long,
                        )
                        if (answer == SnackbarResult.ActionPerformed) {
                            saving = listOf(request.path, request.name)
                            saver.launch(OpenedFiles.safeName(request.name, ext) to OpenedFiles.viewType(ext))
                        }
                    }
                }
            }
        }
    }
    return remember(picker) { { picker.launch(arrayOf("*/*")) } }
}

/** What a chip says when its file is not on the phone and cannot be fetched, in the web's words. */
internal fun unavailable(request: FileRequest) = "“${request.name}” is not available yet: it downloads once online."
