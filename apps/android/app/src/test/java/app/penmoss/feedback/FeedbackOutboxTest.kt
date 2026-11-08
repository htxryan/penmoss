package app.penmoss.feedback

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.FeedbackAnswer
import app.penmoss.engine.api.FeedbackImage
import app.penmoss.engine.api.PenmossFeedbackApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.nio.file.Files

/**
 * Feedback's Room outbox (T49, A796, A802): a submission waits until Penmoss files it, is tried
 * again for answers that pass, and stays with Retry and Discard for any other refusal. The same
 * submission id goes every time, so a replay files one issue.
 */
@RunWith(AndroidJUnit4::class)
class FeedbackOutboxTest {
    private lateinit var db: PenmossDatabase
    private lateinit var dir: File
    private var clock = 1_000_000L
    private val api = Fake()
    private var retried = 0
    private lateinit var outbox: FeedbackOutbox

    private class Fake : PenmossFeedbackApi {
        val answers = ArrayDeque<() -> FeedbackAnswer>()
        val sent = mutableListOf<Pair<String, List<FeedbackImage>>>()

        /** Set: a send reaches the API, says so, and answers only once it completes. */
        var gate: CompletableDeferred<Unit>? = null
        var reached = CompletableDeferred<Unit>()

        override suspend fun sendFeedback(payload: String, images: List<FeedbackImage>): FeedbackAnswer {
            sent += payload to images
            gate?.let {
                reached.complete(Unit)
                it.await()
            }
            return answers.removeFirst()()
        }
    }

    private fun filed(n: Long) = { FeedbackAnswer.Filed(n, "https://github.com/htxryan/penmoss/issues/$n", false) }

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        dir = Files.createTempDirectory("outbox").toFile()
        outbox = FeedbackOutbox(db.feedback(), dir, api, now = { clock }, onRetry = { retried++ })
    }

    @After
    fun close() {
        db.close()
        dir.deleteRecursively()
    }

    private suspend fun queue(id: String, vararg shots: String): FeedbackOutboxEntity {
        val folder = outbox.folder(id).apply { mkdirs() }
        for (shot in shots) File(folder, shot).writeBytes(byteArrayOf(1, 2, 3))
        assertTrue(outbox.enqueue(id, """{"submissionId":"$id"}""", "Title $id", shots.toList()))
        return db.feedback().get(id)!!
    }

    @Test
    fun aFiledSubmissionGoesWithItsFilesAndIsAnnounced() = runTest {
        queue("A", "screenshot-1.png", "screenshot-2.jpg")
        api.answers += filed(123)
        val announced = async(start = CoroutineStart.UNDISPATCHED) { outbox.sent.first() }
        assertTrue(outbox.send("A") is FeedbackOutbox.Outcome.Sent)
        assertEquals(123L, announced.await().number)
        assertNull(db.feedback().get("A"))
        assertFalse(outbox.folder("A").exists())
        // Its images went in order, each with its own type.
        val images = api.sent.single().second
        assertEquals(listOf("screenshot-1.png" to "image/png", "screenshot-2.jpg" to "image/jpeg"), images.map { it.name to it.contentType })
    }

    @Test
    fun answersThatMayPassWaitAndAre429sRetryAfterHonoured() = runTest {
        queue("A")
        api.answers += { FeedbackAnswer.Refused(503, "github_failed", "GitHub failed") }
        val queued = outbox.send("A")
        assertTrue(queued is FeedbackOutbox.Outcome.Queued)
        var row = db.feedback().get("A")!!
        assertEquals(FeedbackOutboxEntity.QUEUED, row.state)
        assertEquals(1, row.attempts)
        assertEquals(503, row.lastStatus)
        assertEquals(clock + FeedbackOutbox.FIRST_BACKOFF_MS, row.nextAttemptAt)
        // Not due yet: a pass leaves it.
        assertEquals(0, outbox.sendDue())
        clock = row.nextAttemptAt
        api.answers += { FeedbackAnswer.Refused(429, "too_many_requests", "Slow down", retryAfterMs = 600_000) }
        outbox.sendDue()
        row = db.feedback().get("A")!!
        assertEquals(clock + 600_000, row.nextAttemptAt)
        assertEquals(2, row.attempts)
        clock = row.nextAttemptAt
        api.answers += { FeedbackAnswer.Refused(409, "in_progress", "Being filed") }
        outbox.sendDue()
        assertEquals(clock + FeedbackOutbox.IN_PROGRESS_MS, db.feedback().get("A")!!.nextAttemptAt)
        clock += FeedbackOutbox.IN_PROGRESS_MS
        api.answers += filed(7)
        assertEquals(1, outbox.sendDue())
        assertEquals(0, db.feedback().count())
        // The same submission each time.
        assertEquals(4, api.sent.size)
        assertEquals(1, api.sent.map { it.first }.distinct().size)
    }

    @Test
    fun offlineWaitsUncountedAndStopsThePassATimeoutIsCounted() = runTest {
        queue("A")
        queue("B")
        api.answers += { throw IOException("no route") }
        assertEquals(0, outbox.sendDue())
        // B was not tried: the phone is offline.
        assertEquals(1, api.sent.size)
        val row = db.feedback().get("A")!!
        assertEquals(0, row.attempts)
        assertEquals(clock, row.nextAttemptAt)
        assertEquals(FeedbackOutbox.OFFLINE, row.lastError)
        api.answers += { throw InterruptedIOException("timeout") }
        api.answers += filed(2)
        assertEquals(1, outbox.sendDue())
        assertEquals(1, db.feedback().get("A")!!.attempts)
        assertNull(db.feedback().get("B"))
    }

    @Test
    fun anyOther4xxStaysRefusedWithRetryAndDiscard() = runTest {
        queue("A", "screenshot-1.png")
        api.answers += { FeedbackAnswer.Refused(403, "device_only", "Feedback comes from the Penmoss apps only") }
        val failed = outbox.send("A") as FeedbackOutbox.Outcome.Failed
        assertEquals(403, failed.status)
        var row = db.feedback().get("A")!!
        assertEquals(FeedbackOutboxEntity.FAILED, row.state)
        assertEquals("Feedback comes from the Penmoss apps only", row.lastError)
        // Never sent again by itself.
        clock += 10 * 60 * 60_000L
        assertEquals(0, outbox.sendDue())
        assertEquals(1, api.sent.size)
        assertEquals(1, outbox.count())
        assertEquals(0, outbox.waitingCount())
        // Retry: from the start, and a sync is asked for.
        outbox.retry("A")
        assertEquals(1, retried)
        row = db.feedback().get("A")!!
        assertEquals(FeedbackOutboxEntity.QUEUED, row.state)
        assertEquals(0, row.attempts)
        assertNull(row.lastError)
        api.answers += { FeedbackAnswer.Refused(400, "invalid_request", "title is required") }
        outbox.sendDue()
        assertEquals(FeedbackOutboxEntity.FAILED, db.feedback().get("A")!!.state)
        // Discard: the row and its screenshots go.
        outbox.discard("A")
        assertEquals(0, outbox.count())
        assertFalse(outbox.folder("A").exists())
    }

    @Test
    fun aDiscardDuringASendWaitsForItAndItsFailureDoesNotBringTheReportBack() = runTest {
        for ((id, answer) in listOf(
            "A" to { FeedbackAnswer.Refused(503, "github_failed", "GitHub failed") },
            "B" to { FeedbackAnswer.Refused(422, "invalid_request", "Too large") },
        )) {
            queue(id, "screenshot-1.png")
            val gate = CompletableDeferred<Unit>()
            api.gate = gate
            api.reached = CompletableDeferred()
            api.answers += answer
            val sending = async { outbox.send(id) }
            api.reached.await()
            val discarding = async { outbox.discard(id) }
            testScheduler.advanceUntilIdle()
            // The send holds the lock: the discard waits for its answer.
            assertFalse(discarding.isCompleted)
            assertTrue(db.feedback().get(id) != null)
            gate.complete(Unit)
            sending.await()
            discarding.await()
            // The failed send wrote its answer first; the discard came after and won.
            assertNull(db.feedback().get(id))
            assertFalse(outbox.folder(id).exists())
            api.gate = null
        }
        clock += 10 * 60 * 60_000L
        assertEquals(0, outbox.sendDue())
        assertEquals(2, api.sent.size)
    }

    @Test
    fun oneFormIsOneSubmissionAndARowLeftSendingIsSentAgain() = runTest {
        queue("A")
        assertFalse(outbox.enqueue("A", "{}", "again", emptyList()))
        assertEquals("""{"submissionId":"A"}""", db.feedback().get("A")!!.payload)
        // A run stopped mid-send (the app was killed): the row says sending, and is due.
        db.feedback().sending("A")
        api.answers += filed(9)
        assertEquals(1, outbox.sendDue())
        assertEquals(FeedbackOutbox.Outcome.Gone, outbox.send("A"))
    }

    @Test
    fun aSubmissionWhoseScreenshotsWentIsRefusedNotSentWithout() = runTest {
        queue("A", "screenshot-1.png")
        File(outbox.folder("A"), "screenshot-1.png").delete()
        assertEquals(FeedbackOutbox.Outcome.Failed(null, FeedbackOutbox.MISSING_FILES), outbox.send("A"))
        assertTrue(api.sent.isEmpty())
    }
}
