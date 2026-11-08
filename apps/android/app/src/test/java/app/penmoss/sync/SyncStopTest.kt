package app.penmoss.sync

import android.content.Context
import android.database.sqlite.SQLiteConstraintException
import android.database.sqlite.SQLiteFullException
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.sync.SyncEngine
import app.penmoss.stopScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * "Sync stopped" on the phone (T42 on Android, AC12, A651): the web's stop reasons this phone can
 * meet, kept by the coordinator with the sync state so Home can lead to what resolves each. The
 * app's real engine, Room store and HTTP client against the fake Penmoss server.
 */
@RunWith(AndroidJUnit4::class)
class SyncStopTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val penmoss = FakePenmoss()
    private val scope = CoroutineScope(SupervisorJob())

    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var sync: SyncCoordinator

    /** Thrown by the pass's first step when set: the phone's own storage failing. */
    @Volatile
    private var storage: Exception? = null

    @Before
    fun setUp() {
        server.dispatcher = penmoss
        server.start()
        val api = HttpPenmossApi(server.url("/").toString(), OkHttpClient())
        db = PenmossDatabase.inMemory(context)
        store = NoteStore(db)
        lateinit var coordinator: SyncCoordinator
        val engine = SyncEngine(api, store) { coordinator.publish(it) }
        coordinator = SyncCoordinator(
            scope,
            engine = { engine },
            now = { 42L },
            beforePass = { storage?.let { throw it } },
        )
        sync = coordinator
    }

    @After
    fun tearDown() {
        // Its work ends before the database closes (A690).
        stopScope(scope)
        db.close()
        server.close()
    }

    private fun pass() = runBlocking { sync.backgroundPass(prefetch = true, maxBatches = SyncEngine.MAX_BATCHES) }

    @Test
    fun editsTheServerKeepsRefusingStopSyncUntilAPassSendsThem() = runBlocking {
        penmoss.write("a", "Plan", "steady text")
        penmoss.write("b", "Other", "more text")
        pass()
        assertNull(sync.stop.value)
        store.addPending("a", "UEhPTkU=", store.note("a")!!.epoch)
        penmoss.readOnly += "a"
        pass()
        assertEquals(SyncStop.Notes(mapOf("a" to "Read-only")), sync.stop.value)
        // The pass itself ended: Home says the stop, not "Syncing" for ever (A582).
        assertTrue(sync.status.value is SyncStatus.Synced)
        // Still refused at the next pass, which sends the edit again: still stopped.
        pass()
        assertEquals(SyncStop.Notes(mapOf("a" to "Read-only")), sync.stop.value)
        // Taken once the server can: sync goes on.
        penmoss.readOnly.clear()
        pass()
        assertNull(sync.stop.value)
        assertEquals(0, store.content("a").pending.size)
    }

    @Test
    fun aNoteExchangedOnItsOwnSaysItTooAndClearsIt() = runBlocking {
        penmoss.write("a", "Plan", "steady text")
        pass()
        store.addPending("a", "UEhPTkU=", store.note("a")!!.epoch)
        penmoss.readOnly += "a"
        sync.syncNote("a")
        assertEquals(SyncStop.Notes(mapOf("a" to "Read-only")), sync.stop.value)
        penmoss.readOnly.clear()
        sync.syncNote("a")
        assertNull(sync.stop.value)
    }

    /** A 403 is a failed pass, tried again, not a stop: no sign-in to fix since T59 (A1040). */
    @Test
    fun aForbiddenAnswerFailsThePassWithoutStoppingSync() {
        penmoss.forbidding = true
        assertEquals(PassOutcome.FAILED, pass())
        assertNull(sync.stop.value)
        assertEquals(SyncStatus.Offline(42L, serverError = true), sync.status.value)
        penmoss.forbidding = false
        assertEquals(PassOutcome.SYNCED, pass())
    }

    @Test
    fun aFullPhoneStopsSyncAndSaysSoInsteadOfEndingTheLoop() {
        storage = SQLiteFullException("database or disk is full")
        assertEquals(PassOutcome.FAILED, pass())
        assertEquals(SyncStop.Storage("database or disk is full"), sync.stop.value)
        assertEquals(SyncStatus.Offline(42L, serverError = true), sync.status.value)
        storage = null
        pass()
        assertNull(sync.stop.value)
    }

    /**
     * #137 (review N3): a note's own exchange going through says nothing about the pass that ran
     * out of room, so "Sync stopped" stays until a pass goes through, instead of flickering off and
     * on again with each small exchange.
     */
    @Test
    fun aFullPhoneStaysStoppedUntilAPassGoesThroughNotOneNotesExchange() = runBlocking {
        penmoss.write("a", "Plan", "steady text")
        pass()
        storage = SQLiteFullException("database or disk is full")
        assertEquals(PassOutcome.FAILED, pass())
        assertEquals(SyncStop.Storage("database or disk is full"), sync.stop.value)
        storage = null
        assertTrue(sync.syncNote("a") != null)
        assertEquals(SyncStop.Storage("database or disk is full"), sync.stop.value)
        assertEquals(PassOutcome.SYNCED, pass())
        assertNull(sync.stop.value)
    }

    /** Any other database error is a fault in the app, thrown as before, not a stop to explain. */
    @Test
    fun anotherDatabaseErrorIsNotCalledStorage() {
        storage = SQLiteConstraintException("UNIQUE constraint failed")
        val thrown = runCatching { pass() }.exceptionOrNull()
        assertTrue(thrown is SQLiteConstraintException)
        assertNull(sync.stop.value)
    }

    /** A git notebook removed quiesces its sync (A856): what stopped it goes with it. */
    @Test
    fun quiescingForgetsWhatStoppedTheSync() = runBlocking {
        storage = SQLiteFullException("database or disk is full")
        pass()
        assertTrue(sync.stop.value is SyncStop.Storage)
        sync.quiesce()
        assertNull(sync.stop.value)
    }
}
