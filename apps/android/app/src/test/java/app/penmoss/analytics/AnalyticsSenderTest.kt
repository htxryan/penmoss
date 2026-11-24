package app.penmoss.analytics

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Sending (PEN-137, AC12, AC17): only waiting events, oldest first, 200 at most in a batch of at
 * most 64 KB; a 4xx refuses the batch; offline, a 5xx or a 429 keeps it and backs off (a minute,
 * doubling to an hour, or Retry-After); Delete My Shared Data asks the server, then takes a new ID.
 */
@RunWith(AndroidJUnit4::class)
class AnalyticsSenderTest {
    private val phone = AnalyticsHarness()
    private val service = phone.service

    @After
    fun close() = phone.close()

    private suspend fun count(state: EventState) = phone.store.counts()[state] ?: 0L

    private fun batch(index: Int): JsonObject = Json.parseToJsonElement(phone.endpoint.requests[index].second).jsonObject

    @Test
    fun sendsWaitingEventsOldestFirstInBatchesOf200() = runBlocking {
        phone.clicks(250)
        service.answer(ConsentAnswer.YES, "0.4.2")
        assertTrue(service.sendDue())
        assertEquals(2, phone.endpoint.requests.size)
        assertEquals("/v1/batch", phone.endpoint.requests[0].first)
        val first = batch(0)
        assertEquals(1, first["v"]!!.jsonPrimitive.content.toInt())
        assertEquals(service.stateNow().install, first["install"]!!.jsonPrimitive.content)
        val events = first["events"]!!.jsonArray
        assertEquals(200, events.size)
        assertEquals((0L until 200L).toList(), events.map { it.jsonObject["seq"]!!.jsonPrimitive.long })
        val one = events[0].jsonObject
        assertEquals(
            listOf("session", "seq", "at", "client", "actor", "version", "channel", "os", "osVersion", "sizeClass", "kind", "name", "props"),
            one.keys.toList(),
        )
        assertEquals(50, batch(1)["events"]!!.jsonArray.size)
        assertEquals(250L, count(EventState.SENT))
        // Copy as JSON's body: the last batch, exactly as sent.
        assertEquals(phone.endpoint.requests[1].second, phone.store.meta(AnalyticsStore.LAST_BATCH))
    }

    @Test
    fun eventsTheWorkerRefusedAreMarkedSoAndTheRestSent() = runBlocking {
        service.answer(ConsentAnswer.YES, "0.4.2")
        phone.clicks(5)
        phone.endpoint.answer(AnalyticsHarness.Endpoint.json(202, """{"accepted":3,"dropped":2,"refused":[1,3]}"""))
        service.sendDue()
        assertEquals(3L, count(EventState.SENT))
        assertEquals(2L, count(EventState.REFUSED))
        val refused = phone.store.page(EventState.REFUSED, null, 10).map { it.seq }.sorted()
        assertEquals(listOf(1L, 3L), refused)
    }

    @Test
    fun a4xxRefusesTheBatch() = runBlocking {
        service.answer(ConsentAnswer.YES, "0.4.2")
        phone.clicks(4)
        phone.endpoint.answer(AnalyticsHarness.Endpoint.json(400, """{"error":"invalid"}"""))
        service.sendDue()
        assertEquals(4L, count(EventState.REFUSED))
        assertEquals(0L, count(EventState.WAITING))
    }

    @Test
    fun offlineOrA5xxKeepsTheEventsAndBacksOffToAnHour() = runBlocking {
        service.answer(ConsentAnswer.YES, "0.4.2")
        phone.clicks(4)
        phone.scheduled.clear()
        val waits = mutableListOf<Long>()
        repeat(9) {
            phone.endpoint.answer(AnalyticsHarness.Endpoint.json(503, "{}"))
            assertFalse(service.sendDue())
            waits += phone.scheduled.last()
        }
        assertEquals(4L, count(EventState.WAITING))
        assertEquals(listOf(60_000L, 120_000L, 240_000L, 480_000L, 960_000L, 1_920_000L, 3_600_000L, 3_600_000L, 3_600_000L), waits)
        // A success starts again from a minute.
        assertTrue(service.sendDue())
        assertEquals(4L, count(EventState.SENT))
        assertEquals("0", phone.store.meta(AnalyticsStore.FAILURES))

        // Nowhere to send to: kept, never an error.
        phone.clicks(2)
        phone.server.close()
        assertFalse(service.sendDue())
        assertEquals(2L, count(EventState.WAITING))
    }

    @Test
    fun a429WaitsAsLongAsItSays() = runBlocking {
        service.answer(ConsentAnswer.YES, "0.4.2")
        phone.clicks(2)
        phone.scheduled.clear()
        phone.endpoint.answer(AnalyticsHarness.Endpoint.json(429, "{}", mapOf("Retry-After" to "30")))
        assertFalse(service.sendDue())
        assertEquals(30_000L, phone.scheduled.last())
        assertEquals(2L, count(EventState.WAITING))
    }

    /**
     * An event recorded just after the answer is stored as answered, however the first read of the
     * consent store and the answer interleave (PEN-182's CI: the 429 test's events were stored as
     * not yet answered once, so it sent nothing). The service's first read is held until the answer
     * is in, then its watch on the store is held too, so only the store itself has the answer.
     */
    @Test
    fun anEventJustAfterTheAnswerIsStoredAsAnswered() = runBlocking<Unit> {
        val real = PreferenceDataStoreFactory.create(scope = phone.scope) { File(phone.dir, "held.preferences_pb") }
        // An install that has its ID already, as every one has after its first start.
        ConsentStore(real).now()
        val held = HeldStore(real)
        val service = AnalyticsService(
            store = phone.store,
            consent = ConsentStore(held),
            sender = phone.sender,
            scope = phone.scope,
            fields = { ClientFields(version = "0.4.2", channel = "stable", osVersion = "17", sizeClass = "compact") },
            now = { phone.clock },
            schedule = {},
            onLimits = {},
            onDropped = { problem, kind, name -> throw AssertionError("Dropped $kind $name: $problem") },
        )
        held.firstRead.await()
        service.answer(ConsentAnswer.YES, "0.4.2")
        held.holdNext.set(true)
        held.releaseFirst.complete(Unit)
        // The first read has finished (with the state from before the answer) once the watch begins.
        held.nextRead.await()
        assertEquals(ConsentAnswer.YES, service.state.value?.consent)
        check(service.record("click", "privacy.view-data"))
        service.flush()
        assertEquals(1L, count(EventState.WAITING))
        held.releaseNext.complete(Unit)
    }

    /** A store whose first read, and the one after [holdNext] is set, wait to be let go. */
    private class HeldStore(private val real: DataStore<Preferences>) : DataStore<Preferences> {
        val firstRead = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        val holdNext = AtomicBoolean(false)
        val nextRead = CompletableDeferred<Unit>()
        val releaseNext = CompletableDeferred<Unit>()
        private val reads = AtomicInteger()

        override val data: Flow<Preferences> = flow {
            when {
                reads.incrementAndGet() == 1 -> {
                    val before = real.data.first()
                    firstRead.complete(Unit)
                    releaseFirst.await()
                    emit(before)
                }
                holdNext.compareAndSet(true, false) -> {
                    nextRead.complete(Unit)
                    releaseNext.await()
                    emitAll(real.data)
                }
                else -> emitAll(real.data)
            }
        }

        override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences = real.updateData(transform)
    }

    @Test
    fun aBatchIsCutToFitIn64Kb() {
        val row = EventEntity(
            id = 1, at = 1, session = "0123456789abcdef", seq = 0, client = "android", actor = "person", version = "0.4.2",
            channel = "stable", os = "android", osVersion = "17", sizeClass = null, kind = "cli", name = "search",
            props = """{"flags":[${(1..16).joinToString(",") { "\"flag-name-that-is-long-$it\"" }}]}""", state = EventState.WAITING.code,
        )
        val rows = (0 until 200).map { row.copy(id = it + 1L, seq = it.toLong()) }
        val (body, kept) = AnalyticsSender.batchBody("0".repeat(32), rows)
        assertTrue(body.toByteArray().size <= AnalyticsFormat.MAX_BATCH_BYTES)
        assertTrue(kept.size in 1 until 200)
        assertEquals(rows.take(kept.size), kept)
    }

    @Test
    fun deleteMySharedDataAsksTheServerThenTakesANewId() = runBlocking {
        val install = service.stateNow().install
        assertEquals(ForgetOutcome.OK, service.forget())
        assertEquals("/v1/forget", phone.endpoint.requests.single().first)
        val body = Json.parseToJsonElement(phone.endpoint.requests.single().second).jsonObject
        assertEquals(install, body["install"]!!.jsonPrimitive.content)
        assertNotEquals(install, service.stateNow().install)

        val second = service.stateNow().install
        phone.endpoint.answer(AnalyticsHarness.Endpoint.json(500, "{}"))
        assertEquals(ForgetOutcome.FAILED, service.forget())
        assertEquals(second, service.stateNow().install)

        phone.server.close()
        assertEquals(ForgetOutcome.OFFLINE, service.forget())
        assertEquals(second, service.stateNow().install)
    }
}
