package app.penmoss.capture

import app.penmoss.data.Attachments
import app.penmoss.data.CaptureDao
import app.penmoss.data.CaptureEntity
import app.penmoss.data.CapturesWaiting
import app.penmoss.data.NoteStore
import app.penmoss.data.PictureRefused
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.api.PenmossApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.io.InterruptedIOException
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Quick captures on the phone (T34, A335–A338, A343–A349). Saving one only
 * writes Room (and the pictures' files), so it works offline and takes
 * milliseconds; the sync pass sends it with `POST /api/capture` once the
 * pictures it names have uploaded, and the server adds it to the day's note or
 * a new Inbox note as the web and Mac apps do. Kotlin never writes Yjs (A11).
 * The same id goes with every try, so a request whose reply was lost adds
 * nothing when it is sent again. Nothing captured is ever dropped without the
 * person deciding: a capture that cannot go as it is waits in the list Home
 * opens (A345).
 */
class Captures(
    private val dao: CaptureDao,
    private val store: NoteStore,
    private val pictures: Attachments,
    private val api: PenmossApi,
    /** A capture was saved, or the person asked for one to be tried again: sync soon. */
    private val onSaved: () -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    /** The phone's time zone, for a capture made before any pass brought the synced one. */
    private val zone: () -> String = { ZoneId.systemDefault().id },
) {
    private val sending = Mutex()

    /**
     * A saved capture: how many of its pictures could not be read or stored, and whether its
     * text was too long and its end cut (A347).
     */
    data class Saved(val id: String, val destination: String, val refusedPictures: Int, val cut: Boolean = false)

    /** Where a sheet's save is, by the sheet's draft id: a sheet made again after rotation finds it (A348). */
    sealed interface SaveState {
        data object Saving : SaveState

        /** Saved, or null when there was nothing to save or it failed. */
        data class Done(val saved: Saved?) : SaveState
    }

    private val saves = ConcurrentHashMap<String, MutableStateFlow<SaveState?>>()

    /** The save of the sheet with this draft id: none, under way, or done. */
    fun saveState(draftId: String): StateFlow<SaveState?> = flowOf(draftId).asStateFlow()

    private fun flowOf(draftId: String) = saves.getOrPut(draftId) { MutableStateFlow(null) }

    /** Where the next capture starts: the remembered choice (A336). */
    suspend fun destination(): String = store.captureDestination()

    /**
     * Saves the capture of the sheet `draftId`, once: a second call while the first is under
     * way, or after it saved, does nothing (A348). The capture's id is the draft's, so even a
     * save started twice stores one capture.
     */
    suspend fun saveDraft(
        draftId: String,
        text: String,
        pictureSources: List<suspend () -> ByteArray?>,
        destination: String,
    ): Saved? {
        val state = flowOf(draftId)
        synchronized(state) {
            val current = state.value
            if (current == SaveState.Saving || (current is SaveState.Done && current.saved != null)) return null
            state.value = SaveState.Saving
        }
        val saved = try {
            save(draftId, text, pictureSources, destination)
        } catch (error: Exception) {
            null
        }
        state.value = SaveState.Done(saved)
        return saved
    }

    /** Saves a capture with pictures already read (tests, and callers with a few small ones). */
    suspend fun save(text: String, pictureBytes: List<ByteArray>, destination: String): Saved? =
        save(newId(), text, pictureBytes.map { bytes -> suspend { bytes } }, destination)

    /**
     * Saves a capture: its pictures stored first (A304), one at a time, each read only when the
     * one before is stored, so only one is ever held in memory (A348); then the capture naming
     * them, in Room. Null when there is nothing to save. Picking the destination the sheet did not
     * start on affects this capture only: the default is Settings → Quick Capture's (T51, A947).
     * The text is cut to fit what the server takes, by UTF-8 bytes (A347).
     */
    suspend fun save(id: String, text: String, pictureSources: List<suspend () -> ByteArray?>, destination: String): Saved? {
        require(destination == CaptureRequest.DAILY || destination == CaptureRequest.INBOX) { "Unknown destination $destination" }
        dao.get(id)?.let { return Saved(it.id, it.destination, 0) }
        var refused = 0
        val paths = mutableListOf<String>()
        for (source in pictureSources) {
            val path = try {
                source()?.let { bytes -> pictures.add(bytes, null) }
            } catch (error: PictureRefused) {
                null
            } catch (error: IOException) {
                null
            } catch (error: OutOfMemoryError) {
                null
            }
            if (path == null) refused++ else if (path !in paths) paths += path
        }
        val lines = paths.map { "![]($it)" }
        val room = MAX_CAPTURE_BYTES - lines.sumOf { Utf8.size(it) + 2 }
        val trimmed = text.trim()
        val kept = Utf8.cut(trimmed, room).trimEnd()
        val markdown = (listOf(kept).filter { it.isNotEmpty() } + lines).joinToString("\n\n")
        if (markdown.isEmpty()) return null
        val inserted = dao.insert(
            CaptureEntity(
                id = id,
                text = markdown,
                destination = destination,
                capturedAt = now(),
                // Never remembered since T51 (A947): the sheet's choice is this capture's only.
                remember = false,
                pictures = paths.joinToString(" ") { it.removePrefix(ATTACHMENTS) },
                timeZone = store.captureTimeZone() ?: zone(),
            ),
        )
        // Saved already, by a save of the same sheet that raced this one: one capture (A348).
        if (inserted == -1L) return dao.get(id)?.let { Saved(it.id, it.destination, refused) }
        onSaved()
        return Saved(id, destination, refused, cut = kept.length < trimmed.length)
    }

    /** Captures not sent yet. */
    fun observeWaiting(): Flow<Int> = dao.observeWaiting()

    /** How many wait, since when, and whether the server is waiting for a deploy (A345). */
    fun observeWaitingSummary(): Flow<CapturesWaiting> = dao.observeWaitingSummary()

    /** Captures not sent yet, now: leaving the app asks for a run while there are some (A330). */
    suspend fun waitingCount(): Int = dao.waitingCount()

    /** Captures that cannot go as they are: kept on the phone, never sent again unless asked. */
    fun observeRefused(): Flow<Int> = dao.observeRefused()

    /** A capture Home lists because it cannot go as it is (A345). */
    data class Refused(
        val id: String,
        val text: String,
        val reason: String,
        val capturedAt: Long,
        val destination: String,
        /** Its pictures could not be uploaded: it can be sent without them. */
        val missingPictures: Boolean,
    )

    fun observeRefusedList(): Flow<List<Refused>> = dao.observeRefusedList().map { rows ->
        rows.map { Refused(it.id, it.text, it.refused.orEmpty(), it.capturedAt, it.destination, it.refused == PICTURES_MISSING) }
    }

    /** Tries a capture again from the start, its pictures too: the person asked (A345). */
    suspend fun retry(id: String) {
        val capture = dao.get(id) ?: return
        for (name in names(capture)) pictures.retry(name.substringBefore('.'))
        dao.retry(id)
        onSaved()
    }

    /**
     * Sends a capture without the pictures that could not be uploaded, which the person chose
     * (A348); a capture of nothing else stays as it is.
     */
    suspend fun sendWithoutMissingPictures(id: String) {
        val capture = dao.get(id) ?: return
        val lost = names(capture).filter { pictures.upload(it.substringBefore('.')) == Attachments.Upload.REFUSED }
        val text = capture.text.split("\n\n").filterNot { block -> lost.any { block.trim() == "![]($ATTACHMENTS$it)" } }.joinToString("\n\n")
        if (text.isBlank()) return
        dao.rewrite(id, text, names(capture).filterNot { it in lost }.joinToString(" "))
        dao.retry(id)
        onSaved()
    }

    /** Deletes a capture: the person chose to (A345). */
    suspend fun discard(id: String) = dao.delete(id)

    /**
     * Sends the captures due, oldest first (a pass's first work, after the pictures, A338).
     * A capture whose pictures are still uploading waits; one whose picture could not be
     * uploaded is kept, never sent without it unless the person says so (A348). Stops when
     * offline.
     */
    suspend fun sendDue(limit: Int = 20): Int = sending.withLock {
        var sent = 0
        for (capture in dao.due(now(), limit)) {
            if (!ready(capture)) continue
            try {
                api.capture(
                    CaptureRequest(capture.id, capture.text, capture.destination, capture.capturedAt, capture.remember, capture.timeZone),
                )
                dao.delete(capture.id)
                sent++
            } catch (error: ApiException) {
                if (error.unauthorized) throw error
                if (passes(error)) {
                    dao.attempted(capture.id, now() + backoff(capture.attempts), error.status)
                } else {
                    dao.refuse(capture.id, error.message ?: "Refused (${error.status})")
                }
            } catch (error: InterruptedIOException) {
                // A request that timed out (a slow link, a proxy that stalls on large bodies) is
                // counted and waits, so it never holds back the captures after it (A349).
                dao.attempted(capture.id, now() + backoff(capture.attempts), null)
            } catch (error: IOException) {
                // Offline: tried again on the next pass, and not counted against it.
                break
            }
        }
        sent
    }

    /** Whether a refusal may pass: anything but a refusal of the capture itself (A345). */
    private fun passes(error: ApiException): Boolean =
        error.status !in 400..499 || error.status in RETRIED || (error.status == 409 && error.code == "gone")

    /**
     * Whether the capture can be sent now: false while a picture it names is uploading, or when
     * one could not be uploaded, which keeps it in Home's list (A348).
     */
    private suspend fun ready(capture: CaptureEntity): Boolean {
        val names = names(capture)
        if (names.isEmpty()) return true
        val states = names.map { pictures.upload(it.substringBefore('.')) }
        if (states.any { it == Attachments.Upload.WAITING }) return false
        if (states.any { it == Attachments.Upload.REFUSED }) {
            dao.refuse(capture.id, PICTURES_MISSING)
            return false
        }
        return true
    }

    private fun names(capture: CaptureEntity) = capture.pictures.split(' ').filter { it.isNotEmpty() }

    private fun backoff(attempts: Int): Long = minOf(MAX_BACKOFF_MS, FIRST_BACKOFF_MS shl minOf(attempts, 20))

    companion object {
        private const val ATTACHMENTS = "attachments/"

        /**
         * Refusals that pass: a timeout, too many requests, and 404, which is what a server
         * without `/api/capture` answers (one not yet deployed, A342): the capture waits for it.
         */
        private val RETRIED = setOf(404, 408, 429)
        const val FIRST_BACKOFF_MS = 30_000L
        const val MAX_BACKOFF_MS = 60 * 60_000L

        /** UTF-8 bytes a capture may take, pictures' lines included: under the server's 256 KB (A347). */
        const val MAX_CAPTURE_BYTES = 240 * 1024

        /** Why a capture waits when a picture it names could not be uploaded (A348). */
        const val PICTURES_MISSING = "A picture in it could not be uploaded"
    }
}
