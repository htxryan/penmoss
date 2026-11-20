package app.penmoss.analytics

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** A clock that moves only when told, running each timer as its time comes (core's FakeClock). */
class FakeScrollClock : ScrollClock {
    var time = 0L
        private set
    private var next = 1L
    private val timers = LinkedHashMap<Long, Pair<Long, () -> Unit>>()

    override fun now(): Long = time

    override fun set(delayMs: Long, run: () -> Unit): Any {
        val id = next++
        timers[id] = (time + delayMs) to run
        return id
    }

    override fun clear(handle: Any) {
        timers.remove(handle as Long)
    }

    /** Moves to [to], running each timer due by then in time order (the first set first at a tie). */
    fun advance(to: Long) {
        while (true) {
            val due = timers.entries.filter { it.value.first <= to }.minByOrNull { it.value.first } ?: break
            timers.remove(due.key)
            time = due.value.first
            due.value.second()
        }
        time = to
    }
}

/**
 * The scroll gate (PEN-175) is core's: every fraction and gate case `scroll-v1.json` pins, which
 * core's `analytics-scroll.test.ts` writes from `scroll.ts`, gives the same here; and an area moved
 * all the time records at most one event a second.
 */
class ScrollGateTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("scroll-v1.json") }
            ?: File("../contract/scroll-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    @After
    fun forget() {
        ScrollEvents.forget()
        ScrollEvents.clock = { ScrollClock.main() }
        ScrollEvents.record = { area, position -> Analytics.record("scroll", area, ScrollEvents.propsOf(position)) }
    }

    @Test
    fun theTimingIsCores() {
        assertEquals(contract.getValue("settleMs").jsonPrimitive.long, ScrollGate.SETTLE_MS)
        assertEquals(contract.getValue("minGapMs").jsonPrimitive.long, ScrollGate.MIN_GAP_MS)
    }

    @Test
    fun eachFractionIsCores() {
        val cases = contract.getValue("fraction").jsonArray
        assertTrue(cases.size >= 10)
        for (case in cases) {
            val (top, height, client) = case.jsonArray.take(3).map { it.jsonPrimitive.double }
            val want = case.jsonArray[3].let { if (it is JsonNull) null else it.jsonPrimitive.double }
            assertEquals("$case", want, ScrollGate.fractionOf(top, height, client))
        }
    }

    private fun run(steps: List<JsonObject>, until: Long): List<Pair<Long, Double>> {
        val clock = FakeScrollClock()
        val recorded = mutableListOf<Pair<Long, Double>>()
        val gate = ScrollGate({ recorded += clock.now() to it }, clock)
        for (step in steps) {
            clock.advance(step.getValue("at").jsonPrimitive.long)
            if (step["reset"]?.jsonPrimitive?.boolean == true) gate.reset() else gate.moved(step.getValue("move").let { (it as? JsonPrimitive)?.doubleOrNull })
        }
        clock.advance(until)
        return recorded
    }

    @Test
    fun eachGateCaseIsCores() {
        val cases = contract.getValue("gate").jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 10)
        for (case in cases) {
            val name = case.getValue("name").jsonPrimitive.content
            val want = case.getValue("recorded").jsonArray.map { it.jsonObject.let { r -> r.getValue("at").jsonPrimitive.long to r.getValue("position").jsonPrimitive.double } }
            val got = run(case.getValue("steps").jsonArray.map { it.jsonObject }, case.getValue("until").jsonPrimitive.long)
            assertEquals(name, want, got)
        }
    }

    @Test
    fun anAreaMovedAllTheTimeRecordsAtMostOneASecond() {
        val clock = FakeScrollClock()
        val recorded = mutableListOf<Pair<Long, Double>>()
        val gate = ScrollGate({ recorded += clock.now() to it }, clock)
        // Back and forth for 20 seconds, stopping for 350 ms after every 400 ms of movement.
        var at = 0L
        var step = 0
        while (at < 20_000) {
            clock.advance(at)
            gate.moved(((step++ % 97) + 1) / 100.0)
            at += if (step % 8 == 0) 350 else 50
        }
        clock.advance(30_000)
        assertTrue("records some", recorded.size > 5)
        assertTrue("at most 21 in 21 s: ${recorded.size}", recorded.size <= 21)
        recorded.zipWithNext().forEach { (a, b) -> assertTrue("$a then $b", b.first - a.first >= ScrollGate.MIN_GAP_MS) }
        // Where it came to rest is recorded last.
        assertEquals(((step - 1) % 97 + 1) / 100.0, recorded.last().second, 0.0)
    }

    @Test
    fun aRecordedPositionIsAWholeNumberAtTheEndsAndHundredthsBetween() {
        assertEquals(mapOf("position" to 0), ScrollEvents.propsOf(0.0))
        assertEquals(mapOf("position" to 1), ScrollEvents.propsOf(1.0))
        assertEquals(mapOf("position" to 0.42), ScrollEvents.propsOf(0.42))
        val catalogue = AnalyticsCatalogue.bundled
        for (position in listOf(0.0, 0.01, 0.42, 0.57, 0.99, 1.0)) {
            val props = JsonObject(ScrollEvents.propsOf(position).mapValues { AnalyticsService.jsonOf(it.value)!! })
            val event = AnalyticsEvent("0123456789abcdef", 0, 1, "android", "person", "0.4.2", "stable", "android", "17", "compact", "scroll", "note", props)
            assertNull("$position", catalogue.problem(event))
        }
    }

    @Test
    fun theScreenThatShowsAnAreaLastOwnsIt() {
        val clock = FakeScrollClock()
        val recorded = mutableListOf<Triple<Long, String, Double>>()
        ScrollEvents.clock = { clock }
        ScrollEvents.record = { area, position -> recorded += Triple(clock.now(), area, position) }
        val appearance = Any()
        val shortcuts = Any()
        ScrollEvents.shown("settings", appearance)
        ScrollEvents.moved("settings", appearance, 0.5)
        clock.advance(400)
        // Another page shows the area: its moves count, the old page's don't, and the old page
        // going drops nothing the new one waits for.
        ScrollEvents.shown("settings", shortcuts)
        ScrollEvents.moved("settings", shortcuts, 0.3)
        ScrollEvents.moved("settings", appearance, 0.9)
        ScrollEvents.gone("settings", appearance)
        // The drawer is an area of its own, with a gap of its own.
        val drawer = Any()
        ScrollEvents.shown("sidebar", drawer)
        ScrollEvents.moved("sidebar", drawer, 1.0)
        clock.advance(5_000)
        assertEquals(listOf(Triple(300L, "settings", 0.5), Triple(700L, "sidebar", 1.0), Triple(1300L, "settings", 0.3)), recorded)
        // The area gone drops what waits.
        ScrollEvents.moved("sidebar", drawer, 0.2)
        ScrollEvents.gone("sidebar", drawer)
        clock.advance(10_000)
        assertEquals(3, recorded.size)
    }
}
