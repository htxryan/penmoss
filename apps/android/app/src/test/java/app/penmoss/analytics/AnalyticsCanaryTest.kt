package app.penmoss.analytics

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Nothing leaves the phone without a Yes (PEN-137, AC11, AC12, AC14): with no answer, or with No,
 * the endpoint never hears from it, however often a send is asked for; what was recorded under No
 * never goes, even once sharing is on; and the canary notebook's words never reach the record or
 * a request.
 */
@RunWith(AndroidJUnit4::class)
class AnalyticsCanaryTest {
    private val phone = AnalyticsHarness(onDropped = { _, _, _ -> })
    private val service = phone.service

    @After
    fun close() = phone.close()

    private val canaries = listOf(
        "Zebracanary Title Q7", "Okapicanary Folder", "narwhalcanary", "quokkacanary.png", "Axolotlcanary Target", "pangolincanary",
        "Wombatcanary Notebook", "canary-owner/kiwicanary-repo", "tapircanary-branch", "lemurcanary", "ibis.canary@example.invalid",
        "ghp_CANARY000000000000000000000000000000", "slothcanary",
    )

    /** Every way the phone might slip text in: as a name, a screen, a prop's value or its key. */
    private fun tryCanaries() {
        for (canary in canaries) {
            service.record("click", canary)
            service.record("screen", canary)
            service.record("screen", "settings", mapOf("from" to canary))
            service.record("command", "app.search", mapOf("source" to canary))
            service.record("command", "app.search", mapOf("source" to "key", "keys" to canary))
            service.record("click", "privacy.view-data", mapOf("state" to canary))
            service.record("click", "privacy.view-data", mapOf(canary to true))
        }
        service.record("click", "privacy.view-data")
    }

    @Test
    fun noAnswerSendsNothing() = runBlocking {
        tryCanaries()
        phone.clicks(30)
        repeat(3) { service.sendDue() }
        service.leftScreen()
        assertEquals(0, phone.endpoint.requests.size)
        assertEquals(0, phone.server.requestCount)
        assertTrue((phone.store.counts()[EventState.PENDING] ?: 0) > 0)
    }

    @Test
    fun noSendsNothingEverAndItsEventsNeverGoLater() = runBlocking {
        phone.clicks(10)
        service.answer(ConsentAnswer.NO, "0.4.2")
        tryCanaries()
        phone.clicks(30)
        repeat(3) { service.sendDue() }
        assertEquals(0, phone.server.requestCount)

        service.answer(ConsentAnswer.YES, "0.4.3")
        val firstNew = phone.store.counts().values.sum()
        phone.clicks(3)
        service.sendDue()
        val sent = phone.endpoint.requests.flatMap { (_, body) ->
            Json.parseToJsonElement(body).jsonObject["events"]!!.jsonArray.map { it.jsonObject["seq"]!!.jsonPrimitive.long }
        }
        // Only the three recorded since sharing was turned on.
        assertEquals(3, sent.size)
        assertTrue(sent.all { it >= firstNew })
        assertEquals(41L, phone.store.counts()[EventState.LOCAL])
    }

    @Test
    fun theCanariesReachNeitherTheRecordNorARequest() = runBlocking {
        service.answer(ConsentAnswer.YES, "0.4.2")
        tryCanaries()
        service.flush()
        service.sendDue()
        val stored = phone.store.page(null, null, 1000).joinToString("\n") { "${it.kind} ${it.name} ${it.props}" }
        val sent = phone.endpoint.requests.joinToString("\n") { it.second }
        assertTrue(sent.isNotEmpty())
        for (canary in canaries) {
            for (form in listOf(canary, java.net.URLEncoder.encode(canary, "UTF-8"))) {
                assertFalse("$form in the record", stored.contains(form, ignoreCase = true))
                assertFalse("$form in a request", sent.contains(form, ignoreCase = true))
            }
        }
        assertFalse(stored.contains("canary", ignoreCase = true))
    }
}
