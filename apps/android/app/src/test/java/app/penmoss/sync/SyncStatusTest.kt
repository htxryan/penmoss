package app.penmoss.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.sync.SyncEngine
import app.penmoss.stopScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/**
 * What the status line can say after a pass that failed (T39): offline, or Penmoss answering
 * with a failure, which is not the phone being offline.
 */
@RunWith(AndroidJUnit4::class)
class SyncStatusTest {
    private lateinit var db: PenmossDatabase
    private val scope = CoroutineScope(SupervisorJob())

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), PenmossDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() {
        // Its work ends before the dispatcher and the database close (A690).
        stopScope(scope)
        db.close()
    }

    private val failures = mutableListOf<Throwable>()

    private var lastFailure: Throwable? = null

    private fun statusAfterAPassWhere(
        failure: Exception,
        outcome: PassOutcome = PassOutcome.FAILED,
    ): SyncStatus = runBlocking {
        val api = object : FakeApi() {
            override suspend fun tree(since: String?): SyncTree = throw failure
        }
        val engine = SyncEngine(api, NoteStore(db))
        val sync = SyncCoordinator(scope, engine = { engine }, onFailure = { failures += it }, now = { 42L })
        assertEquals(outcome, sync.backgroundPass(prefetch = true, maxBatches = 1))
        lastFailure = sync.lastFailure
        sync.status.value
    }

    /** What feedback's Recent errors hear of (A791): a notes server failure, never being offline. */
    @Test
    fun aFailedPassIsReportedButNotBeingOffline() {
        statusAfterAPassWhere(IOException("no route to host"))
        assertEquals(emptyList<Throwable>(), failures)
        statusAfterAPassWhere(ApiException(500, "internal", "Internal error"))
        assertEquals(listOf(500), failures.map { (it as ApiException).status })
    }

    /** Review of #93, N1: what a background run that gave up names: a server failure, never being offline. */
    @Test
    fun theLastFailureIsAServerFailureOnly() {
        statusAfterAPassWhere(ApiException(500, "internal", "Internal error"))
        assertEquals(500, (lastFailure as ApiException).status)
        statusAfterAPassWhere(IOException("no route to host"))
        assertEquals(null, lastFailure)
        statusAfterAPassWhere(kotlinx.serialization.SerializationException("Unexpected JSON token"))
        assertTrue(lastFailure is kotlinx.serialization.SerializationException)
    }

    @Test
    fun noNetworkIsOffline() {
        assertEquals(SyncStatus.Offline(42L, serverError = false), statusAfterAPassWhere(IOException("no route to host")))
    }

    @Test
    fun aServerFailureIsNotCalledOffline() {
        assertEquals(SyncStatus.Offline(42L, serverError = true), statusAfterAPassWhere(ApiException(500, "internal", "Internal error")))
    }

    /** A 401 is a refusal like any other since T59 (A1040): no sign-in to lose, so the pass failed and says so. */
    @Test
    fun anUnauthorizedAnswerIsAServerFailure() {
        val status = statusAfterAPassWhere(ApiException(401, "unauthorized", "Unauthorized"))
        assertEquals(SyncStatus.Offline(42L, serverError = true), status)
        assertEquals(401, (lastFailure as ApiException).status)
    }

    /**
     * Sync now (T39 review) waits for a pass that began after it was asked, not one already
     * running, and returns as soon as that pass ends, even when it fails at once.
     */
    @Test
    fun syncNowWaitsForItsOwnPassAndNoLonger() = runBlocking {
        val api = object : FakeApi() {
            override suspend fun tree(since: String?): SyncTree = throw IOException("no route to host")
        }
        val engine = SyncEngine(api, NoteStore(db))
        val begun = MutableStateFlow(0)
        val release = Channel<Unit>(Channel.UNLIMITED)
        val sync = SyncCoordinator(
            scope,
            engine = { engine },
            now = { 42L },
            beforePass = {
                begun.update { it + 1 }
                release.receive()
            },
        )
        sync.start()
        sync.setForeground(true)
        begun.first { it == 1 }
        // A long start window: were the asked pass missed, syncNow would wait it out.
        val done = async { sync.syncNow(startWithinMs = 60_000) }
        release.send(Unit)
        // The pass running when it was asked has ended; the one it asked for has begun.
        begun.first { it == 2 }
        assertFalse(done.isCompleted)
        release.send(Unit)
        withTimeout(10_000) { done.await() }
        assertEquals(SyncStatus.Offline(42L), sync.status.value)
    }
}
