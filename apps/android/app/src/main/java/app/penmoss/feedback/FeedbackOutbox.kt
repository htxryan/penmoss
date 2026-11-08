package app.penmoss.feedback

import app.penmoss.engine.api.FeedbackAnswer
import app.penmoss.engine.api.FeedbackImage
import app.penmoss.engine.api.PenmossFeedbackApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException

/**
 * Feedback waiting to go (T49, A796, A802): a submission is stored in Room with its screenshots
 * ready to upload, then sent with `POST /api/feedback`, at once when the form is sent and by
 * each sync pass after that (PassWork). The same `submissionId` goes with every try, so a reply
 * lost on the way and sent again files one issue.
 *
 * - **Sent** (201, or 200 for a repeat): the row and its files go, and [sent] says so.
 * - **Waits** for a network failure (tried again on the next pass, not counted), a timeout,
 *   any 5xx, 429 (after its `Retry-After`) and 409 `in_progress` (backing off).
 * - **Waits for a GitHub token** (A1012): with none saved the report stays queued, not failed,
 *   and goes as soon as one is saved ([tokenSaved]).
 * - **Refused** for any other answer: kept, `failed`, with its status and message, until the
 *   person retries or discards it in Settings → About; one GitHub refused the token for is
 *   tried again when another token is saved.
 */
class FeedbackOutbox(
    private val dao: FeedbackDao,
    /** `filesDir/feedback/outbox`: a folder per submission holding its screenshots. */
    private val dir: File,
    private val api: PenmossFeedbackApi,
    private val now: () -> Long = System::currentTimeMillis,
    /** The person asked to try one again: sync soon. */
    private val onRetry: () -> Unit = {},
) {
    private val sending = Mutex()
    private val _sent = MutableSharedFlow<FeedbackAnswer.Filed>(extraBufferCapacity = 8)

    /** Each submission filed, as it is: the app's snackbar says "Sent as #n" with a link. */
    val sent: SharedFlow<FeedbackAnswer.Filed> = _sent.asSharedFlow()

    /** What one attempt came to. */
    sealed interface Outcome {
        data class Sent(val filed: FeedbackAnswer.Filed) : Outcome

        /** Kept to send again: offline, or an answer that may pass. */
        data class Queued(val why: String) : Outcome

        /** Refused for good: kept with Retry and Discard. */
        data class Failed(val status: Int?, val message: String) : Outcome

        /** Not in the outbox (sent by another attempt, or discarded). */
        data object Gone : Outcome
    }

    /** How an answer is taken (A796). */
    enum class Verdict { SENT, RETRY, NO_TOKEN, FINAL }

    /** The folder holding one submission's screenshots. */
    fun folder(id: String) = File(dir, id)

    /**
     * Stores a submission whose screenshots are in [folder] already, named in order. A second
     * store of the same id keeps the first: one form, one submission.
     */
    suspend fun enqueue(id: String, payload: String, title: String, screenshots: List<String>): Boolean =
        dao.insert(
            FeedbackOutboxEntity(
                id = id,
                payload = payload,
                title = title,
                screenshots = screenshots.joinToString("\n"),
                createdAt = now(),
            ),
        ) != -1L

    fun observe(): Flow<List<FeedbackOutboxEntity>> = dao.observeAll()

    /** Waiting to be sent (not refused), for leaving the app (A330) and the context's Outbox. */
    suspend fun waitingCount(): Int = dao.waitingCount()

    suspend fun count(): Int = dao.count()

    /** Tries a refused or waiting submission again from the start: the person asked. */
    suspend fun retry(id: String) {
        dao.retry(id)
        onRetry()
    }

    /**
     * A GitHub token was saved (A1012): what waited for one, and what GitHub refused the last
     * token for, is sent now.
     */
    suspend fun tokenSaved(): Int {
        sending.withLock {
            for (row in dao.all()) {
                if (row.state == FeedbackOutboxEntity.FAILED && row.lastStatus == TOKEN_REFUSED_STATUS) dao.retry(row.id)
            }
        }
        return sendDue()
    }

    /** Deletes a submission and its screenshots: the person chose to. */
    suspend fun discard(id: String) = sending.withLock {
        dao.delete(id)
        folder(id).deleteRecursively()
        Unit
    }

    /**
     * Takes a submission back out (the person chose Edit, T49 review): [restore] gets its row and
     * folder while nothing can send it, and they go only once it returns true. False when the
     * submission is gone or [restore] kept it.
     */
    suspend fun takeBack(id: String, restore: suspend (FeedbackOutboxEntity, File) -> Boolean): Boolean = sending.withLock {
        val row = dao.get(id) ?: return@withLock false
        if (!restore(row, folder(id))) return@withLock false
        dao.delete(id)
        folder(id).deleteRecursively()
        true
    }

    /** Sends one submission now (the form's Send), whatever its next attempt time. */
    suspend fun send(id: String): Outcome = sending.withLock {
        val row = dao.get(id) ?: return@withLock Outcome.Gone
        if (row.state == FeedbackOutboxEntity.FAILED) return@withLock Outcome.Failed(row.lastStatus, row.lastError.orEmpty())
        attempt(row)
    }

    /**
     * Sends what is due, oldest first (after each sync pass). Stops at the first network failure:
     * the phone is offline.
     */
    suspend fun sendDue(limit: Int = 10): Int = sending.withLock {
        var sent = 0
        for (row in dao.due(now(), limit)) {
            when (val outcome = attempt(row)) {
                is Outcome.Sent -> sent++
                // Offline, or no GitHub token: the others would wait too.
                is Outcome.Queued -> if (outcome.why == OFFLINE || outcome.why == NO_TOKEN) break
                else -> Unit
            }
        }
        sent
    }

    private suspend fun attempt(row: FeedbackOutboxEntity): Outcome {
        val images = try {
            images(row)
        } catch (error: IOException) {
            dao.failed(row.id, null, MISSING_FILES)
            return Outcome.Failed(null, MISSING_FILES)
        }
        dao.sending(row.id)
        val answer = try {
            api.sendFeedback(row.payload, images)
        } catch (error: CancellationException) {
            dao.waiting(row.id, now(), 0, null, null)
            throw error
        } catch (error: InterruptedIOException) {
            // A timeout: the upload was tried; counted, and backed off.
            dao.waiting(row.id, now() + backoff(row.attempts), 1, null, TIMED_OUT)
            return Outcome.Queued(TIMED_OUT)
        } catch (error: IOException) {
            dao.waiting(row.id, now(), 0, null, OFFLINE)
            return Outcome.Queued(OFFLINE)
        }
        return when (verdict(answer)) {
            Verdict.SENT -> {
                val filed = answer as FeedbackAnswer.Filed
                dao.delete(row.id)
                folder(row.id).deleteRecursively()
                _sent.tryEmit(filed)
                Outcome.Sent(filed)
            }
            Verdict.RETRY -> {
                val refused = answer as FeedbackAnswer.Refused
                val wait = refused.retryAfterMs ?: if (refused.code == IN_PROGRESS) IN_PROGRESS_MS else backoff(row.attempts)
                dao.waiting(row.id, now() + wait, 1, refused.status, refused.message)
                Outcome.Queued(refused.message)
            }
            Verdict.NO_TOKEN -> {
                // Not counted, not failed: it goes once a token is saved.
                dao.waiting(row.id, now(), 0, null, NO_TOKEN)
                Outcome.Queued(NO_TOKEN)
            }
            Verdict.FINAL -> {
                val refused = answer as FeedbackAnswer.Refused
                dao.failed(row.id, refused.status, refused.message)
                Outcome.Failed(refused.status, refused.message)
            }
        }
    }

    private fun images(row: FeedbackOutboxEntity): List<FeedbackImage> =
        row.screenshots.split('\n').filter { it.isNotEmpty() }.map { name ->
            val file = File(folder(row.id), name)
            if (!file.isFile) throw IOException("Missing $name")
            val ext = name.substringAfterLast('.', "")
            val type = FeedbackImages.TYPES.entries.firstOrNull { it.value == ext }?.key ?: throw IOException("Unknown type $name")
            FeedbackImage(file, type, name)
        }

    private fun backoff(attempts: Int): Long = minOf(MAX_BACKOFF_MS, FIRST_BACKOFF_MS shl minOf(attempts, 20))

    companion object {
        const val FIRST_BACKOFF_MS = 30_000L
        const val MAX_BACKOFF_MS = 60 * 60_000L
        const val IN_PROGRESS_MS = 15_000L
        const val IN_PROGRESS = "in_progress"

        const val OFFLINE = "No connection"
        const val TIMED_OUT = "Timed out"
        const val MISSING_FILES = "Its screenshots are no longer on this phone"

        /** Why a report waits with no GitHub token on the phone (A1012). */
        const val NO_TOKEN = GitHubTokenMessages.MISSING

        /** GitHub refused the token (424 `token_cannot_file`): tried again with the next one saved. */
        const val TOKEN_REFUSED_STATUS = 424

        /**
         * Which answers pass by themselves (A796): any 5xx, 429 and 409 `in_progress` are tried
         * again; no GitHub token waits for one (A1012); any other 4xx is final. GitHub refusing the
         * token is 424 `token_cannot_file` (A1011).
         */
        fun verdict(answer: FeedbackAnswer): Verdict = when (answer) {
            is FeedbackAnswer.Filed -> Verdict.SENT
            is FeedbackAnswer.Refused -> when {
                answer.code == GitHubFeedbackApi.NO_TOKEN -> Verdict.NO_TOKEN
                answer.status >= 500 -> Verdict.RETRY
                answer.status == 429 -> Verdict.RETRY
                answer.status == 409 && answer.code == IN_PROGRESS -> Verdict.RETRY
                else -> Verdict.FINAL
            }
        }
    }
}
