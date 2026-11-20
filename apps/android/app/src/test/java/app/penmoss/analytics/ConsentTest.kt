package app.penmoss.analytics

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The answer and what it does to the record (PEN-137, O3, AC10, AC12, AC16): events are always
 * recorded; with no answer they wait for it; the first Yes sends them (the first run included);
 * No keeps them on the phone for good, even once sharing is turned on later; off turns waiting
 * events local at once; a new ID keeps unsent events on the phone.
 */
@RunWith(AndroidJUnit4::class)
class ConsentTest {
    private val phone = AnalyticsHarness()
    private val service = phone.service

    @After
    fun close() = phone.close()

    private suspend fun count(state: EventState) = phone.store.counts()[state] ?: 0L

    @Test
    fun recordsWithNoAnswerAndTheFirstYesSendsThem() = runBlocking {
        val state = service.stateNow()
        assertNull(state.consent)
        assertTrue(AnalyticsFormat.INSTALL.matches(state.install))
        phone.clicks(3)
        assertEquals(3L, count(EventState.PENDING))

        service.answer(ConsentAnswer.YES, "0.4.2")
        assertEquals(0L, count(EventState.PENDING))
        assertEquals(3L, count(EventState.WAITING))
        val answered = service.stateNow()
        assertEquals(ConsentAnswer.YES, answered.consent)
        assertEquals(phone.clock, answered.sharingSince)
        assertEquals("0.4.2", answered.askedVersion)
        // The ID made the first time stays.
        assertEquals(state.install, answered.install)
        // Yes asks for a send at once.
        assertTrue(phone.scheduled.contains(0L))

        phone.clicks(2)
        assertEquals(5L, count(EventState.WAITING))
    }

    @Test
    fun noKeepsEverythingOnThePhoneEvenWhenSharingIsTurnedOnLater() = runBlocking {
        phone.clicks(4)
        service.answer(ConsentAnswer.NO, "0.4.2")
        assertEquals(4L, count(EventState.LOCAL))
        phone.clicks(2)
        assertEquals(6L, count(EventState.LOCAL))
        assertNull(service.stateNow().sharingSince)

        // On, later: from then on only.
        phone.clock += 60_000
        service.answer(ConsentAnswer.YES, "0.4.3")
        assertEquals(6L, count(EventState.LOCAL))
        assertEquals(0L, count(EventState.WAITING))
        phone.clicks(1)
        assertEquals(1L, count(EventState.WAITING))
        assertEquals(phone.clock - 1, service.stateNow().sharingSince)
    }

    @Test
    fun offTurnsWaitingLocalAndANewIdKeepsUnsentEventsHere() = runBlocking {
        service.answer(ConsentAnswer.YES, "0.4.2")
        phone.clicks(3)
        assertEquals(3L, count(EventState.WAITING))
        service.answer(ConsentAnswer.NO, "0.4.2")
        assertEquals(0L, count(EventState.WAITING))
        assertEquals(3L, count(EventState.LOCAL))
        assertFalse(service.stateNow().sharing)

        service.answer(ConsentAnswer.YES, "0.4.2")
        phone.clicks(2)
        val before = service.stateNow().install
        service.resetId()
        val after = service.stateNow().install
        assertNotEquals(before, after)
        assertTrue(AnalyticsFormat.INSTALL.matches(after))
        assertEquals(0L, count(EventState.WAITING))
        assertEquals(5L, count(EventState.LOCAL))
        // Still sharing: what is recorded from now on goes under the new ID.
        phone.clicks(1)
        assertEquals(1L, count(EventState.WAITING))
    }

    @Test
    fun anEventThatIsNotInTheCatalogueIsNeverStored() = runBlocking {
        val dropped = mutableListOf<String>()
        AnalyticsHarness(onDropped = { problem, _, name -> dropped += "$name $problem" }).use { phone ->
            assertFalse(phone.service.record("click", "Zebracanary Title Q7"))
            assertFalse(phone.service.record("click", "privacy.view-data", mapOf("state" to "pangolincanary")))
            assertFalse(phone.service.record("setting", "privacy.share", mapOf("value" to "slothcanary search text")))
            assertFalse(phone.service.record("screen", "note/01HZX"))
            assertTrue(phone.service.record("click", "privacy.share.on", mapOf("state" to "on")))
            phone.service.flush()
            assertEquals(1L, phone.store.size())
            assertEquals(4, dropped.size)
            val stored = phone.store.page(null, null, 10).joinToString { "${it.name} ${it.props}" }
            assertFalse(stored, stored.contains("canary", ignoreCase = true))
        }
    }

    @Test
    fun eventsRiseInSeqWithinTheSessionAndCarryThePhonesFields() = runBlocking {
        phone.clicks(3)
        val rows = phone.store.page(null, null, 10).reversed()
        assertEquals(listOf(0L, 1L, 2L), rows.map { it.seq })
        assertTrue(rows.all { it.session == service.session && it.client == "android" && it.actor == "person" && it.os == "android" })
        assertEquals("compact", rows.first().sizeClass)
    }
}
