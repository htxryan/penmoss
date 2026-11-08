package app.penmoss.editor

import app.penmoss.data.FileStore
import app.penmoss.data.PictureRefused
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.FileAction
import app.penmoss.engine.bridge.FileLimits
import app.penmoss.engine.bridge.FileRef
import app.penmoss.engine.bridge.ParityFromEditor
import app.penmoss.engine.bridge.ParityToEditor
import app.penmoss.engine.bridge.WebPictureMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.InputStream

/** A chip's Open or Save a copy (ED12), for the note screen to carry out. */
data class FileRequest(val path: String, val name: String, val action: FileAction)

/**
 * A file picked from the document picker: the name it had, and how to read it. It is opened only
 * when its turn comes, so one file at a time is read, and streamed to disk (review PS1); null when
 * it cannot be opened.
 */
class PickedFile(val name: String, val open: () -> InputStream?)

/**
 * Files in the open note through the app (T40 P8, ED12), and how pictures from web addresses
 * show in it (ED13). A file dropped or pasted on the page comes with its bytes, as a picture's
 * do (A304), and is stored only if its path is what its bytes and name give; it goes into the
 * note once stored (A311). Files from the document picker are stored first, then inserted. A
 * chip's size and type come from Room, and its Open or Save a copy goes to the note screen,
 * which reads the file here. [NoteEditorController] hands it the page's messages and bytes.
 */
class NoteFiles(
    private val noteId: String,
    private val send: (String) -> Unit,
    private val scope: CoroutineScope,
    /** Where files are kept; without it, they are refused. */
    private val store: FileStore?,
    /** How web pictures show in a note opened now (the setting, and the network); null: not at all. */
    private val webPictures: (() -> WebPictureMode)?,
    /** Whether the page shows the note now: files picked meanwhile wait. */
    private val showing: () -> Boolean,
    private val notify: (String) -> Unit,
) {
    /** A file's message, waiting for its bytes, which come next. */
    private var awaiting: ParityFromEditor.File? = null

    /** Files picked while the page was not showing the note: inserted once it is. */
    private val waiting = mutableListOf<FileRef>()

    private val _requests = MutableSharedFlow<FileRequest>(extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** What a chip asked of the app: the note screen opens the file or saves a copy. */
    val requests: SharedFlow<FileRequest> = _requests.asSharedFlow()

    /** A message of these from the page. */
    fun onMessage(message: ParityFromEditor) {
        if (message.noteId != noteId) return
        when (message) {
            is ParityFromEditor.File -> awaiting = message
            is ParityFromEditor.FileInfo -> scope.launch {
                val info = try {
                    store?.info(message.path)
                } catch (error: IOException) {
                    null
                }
                send(BridgeProtocol.encode(ParityToEditor.FileInfo(noteId, message.path, info)))
            }
            is ParityFromEditor.OpenFile -> _requests.tryEmit(FileRequest(message.path, message.name, message.action))
            else -> Unit
        }
    }

    /** A picture's message came instead: these bytes are not a file's. */
    fun pictureMessage() {
        awaiting = null
    }

    /** Bytes from the page: true when they were a file's, stored if they are what its path names. */
    fun onBytes(bytes: ByteArray): Boolean {
        val file = awaiting ?: return false
        awaiting = null
        val files = store
        if (bytes.size.toLong() != file.size || files == null) {
            stored(file.path, ok = false)
            return true
        }
        scope.launch {
            // The page inserts the file only once it is stored here (A311).
            val path = try {
                files.addFileFromPage(file.path, file.name, bytes, noteId)
            } catch (error: IOException) {
                null
            }
            stored(file.path, ok = path != null)
        }
        return true
    }

    private fun stored(path: String, ok: Boolean) {
        send(BridgeProtocol.encode(ParityToEditor.FileStored(noteId, path, ok)))
    }

    /** Files from the document picker: stored on the phone first, then inserted at the selection. */
    suspend fun insertPicked(files: List<PickedFile>) {
        val store = this.store ?: return
        val refs = mutableListOf<FileRef>()
        for (file in files) {
            try {
                val path = withContext(Dispatchers.IO) { file.open()?.use { store.addFile(it, file.name, noteId) } }
                if (path == null) {
                    notify("“${file.name}” could not be read.")
                    continue
                }
                refs += FileRef(path, file.name.take(FileLimits.MAX_NAME))
            } catch (refused: PictureRefused) {
                notify(refused.message ?: "The file could not be added.")
            } catch (error: IOException) {
                notify("“${file.name}” could not be stored on this phone.")
            } catch (error: SecurityException) {
                notify("“${file.name}” could not be read.")
            }
        }
        if (refs.isEmpty()) return
        if (showing()) sendInserts(refs) else waiting += refs
    }

    /** The note shows again: the files picked meanwhile go in. */
    fun opened() {
        if (waiting.isEmpty()) return
        sendInserts(waiting.toList())
        waiting.clear()
    }

    private fun sendInserts(refs: List<FileRef>) {
        refs.chunked(FileLimits.MAX_INSERT).forEach { send(BridgeProtocol.encode(ParityToEditor.InsertFiles(noteId, it))) }
    }

    /** Sent right before each `open`: how pictures from web addresses show in the note (ED13). */
    fun beforeOpen() {
        // Without the setting (tests, the theme preview) the page shows none: nothing to send.
        val mode = webPictures?.invoke() ?: return
        send(BridgeProtocol.encode(ParityToEditor.WebPictures(noteId, mode)))
    }

    /** The file a chip asked for, read from the phone or fetched with the device token; null if it cannot be had. */
    suspend fun document(path: String): File? = store?.document(path)

    companion object {
        /** Files the document picker takes at once (the page inserts at most [FileLimits.MAX_INSERT] per message). */
        const val MAX_PICKED = 10
    }
}
