package app.penmoss.analytics

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The phone's `app window` event (PEN-174): its size in dp rounded to 10 and full screen, once as
 * the window first lays out, once 500 ms after the last size change, at once on a multi-window
 * change, and never twice alike for the same window in a session (the launcher handing over to a
 * notebook, Quick Capture's sheet made again by a rotation). No maximised on Android.
 */
@RunWith(AndroidJUnit4::class)
class WindowEventsTest {
    private val catalogue = AnalyticsCatalogue.parse(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("analytics-v1.json") } ?: File("../contract/analytics-v1.json")).readText(),
    )
    private val session = AnalyticsFormat.newSessionId()
    private val recorded = mutableListOf<Map<String, Any?>>()
    private var shape = WindowShape(411.4f, 891.6f, true)

    private fun events(window: String = "main", settle: Settle = FakeSettle()) =
        WindowEvents(window, read = { shape }, settle = settle, record = { recorded += it; true }, session = { session })

    @Test
    fun theFirstLayoutRecordsTheSizeRoundedTo10() {
        events().shown()
        assertEquals(listOf(mapOf("window" to "main", "width" to 410, "height" to 890, "fullScreen" to true)), recorded)
        assertTrue("no maximised on Android", "maximised" !in recorded.single())
    }

    @Test
    fun aRotationRecordsOnce500msAfterTheLastChange() {
        val settle = FakeSettle()
        val window = events(settle = settle)
        window.shown()
        shape = WindowShape(891.6f, 411.4f, true)
        repeat(6) { window.resized() }
        assertEquals("nothing until it settles", 1, recorded.size)
        assertEquals(WindowEvents.SETTLE_MS, settle.delayMs)
        settle.fire()
        assertEquals(mapOf("window" to "main", "width" to 890, "height" to 410, "fullScreen" to true), recorded.last())
        assertEquals(2, recorded.size)
    }

    @Test
    fun multiWindowRecordsAtOnceAndDropsAPendingSettle() {
        val settle = FakeSettle()
        val window = events(settle = settle)
        window.shown()
        window.resized()
        shape = WindowShape(411.4f, 440f, false)
        window.modeChanged()
        assertNull("the settle waiting went", settle.pending)
        assertEquals(mapOf("window" to "main", "width" to 410, "height" to 440, "fullScreen" to false), recorded.last())
        // Leaving split screen: at once again.
        shape = WindowShape(411.4f, 891.6f, true)
        window.modeChanged()
        assertEquals(true, recorded.last()["fullScreen"])
        assertEquals(3, recorded.size)
    }

    @Test
    fun aSizeThatDidNotChangeRecordsNothing() {
        val settle = FakeSettle()
        val window = events(settle = settle)
        window.shown()
        window.resized()
        settle.fire()
        // The notebook's Activity takes over from the launcher at the same size.
        events().shown()
        assertEquals(1, recorded.size)
        // Quick Capture is its own window: its first layout records.
        events("capture").shown()
        assertEquals("capture", recorded.last()["window"])
        // Made again by a rotation: its new size records, once.
        shape = WindowShape(891.6f, 411.4f, true)
        events("capture").shown()
        events("capture").shown()
        assertEquals(3, recorded.size)
        assertEquals(890, recorded.last()["width"])
    }

    @Test
    fun aRecordDroppedIsTriedAgainNextTime() {
        var accept = false
        val window = WindowEvents("main", read = { shape }, settle = FakeSettle(), record = { if (accept) recorded += it; accept }, session = { session })
        window.shown()
        accept = true
        window.modeChanged()
        assertEquals(1, recorded.size)
    }

    @Test
    fun aNewSessionRecordsTheSameSizeAgain() {
        events().shown()
        WindowEvents("main", read = { shape }, settle = FakeSettle(), record = { recorded += it; true }, session = { AnalyticsFormat.newSessionId() }).shown()
        assertEquals(2, recorded.size)
    }

    @Test
    fun lengthsRoundToTheNearest10WithinTheirLimits() {
        assertEquals(1440, AnalyticsFormat.lengthOf(1441f))
        assertEquals(1450, AnalyticsFormat.lengthOf(1445f))
        assertEquals(0, AnalyticsFormat.lengthOf(4f))
        assertEquals(0, AnalyticsFormat.lengthOf(-10f))
        assertEquals(0, AnalyticsFormat.lengthOf(Float.NaN))
        assertEquals(AnalyticsFormat.MAX_LENGTH, AnalyticsFormat.lengthOf(25_000f))
    }

    @Test
    fun whatItRecordsIsAValidEventAndIsStored() = runBlocking {
        AnalyticsHarness().use { harness ->
            Analytics.install(harness.service)
            try {
                shape = WindowShape(600f, 960f, true)
                WindowEvents("main", read = { shape }, settle = FakeSettle()).shown()
                WindowEvents("capture", read = { WindowShape(600f, 300f, false) }, settle = FakeSettle()).shown()
                harness.service.flush()
                val stored = harness.store.page(null, null, 10).map { it.kind to it.name }
                assertEquals(listOf("app" to "window", "app" to "window"), stored)
            } finally {
                Analytics.install(null)
            }
            for (props in listOf(WindowEvents.propsOf("main", shape), WindowEvents.propsOf("capture", WindowShape(10_400f, 0f, false)))) {
                val json = kotlinx.serialization.json.JsonObject(props.mapValues { AnalyticsService.jsonOf(it.value)!! })
                assertNull(catalogue.problem(AnalyticsEvent("0123456789abcdef", 0, 1, "android", "person", "0.4.2", "stable", "android", "17", "compact", "app", "window", json)))
            }
        }
    }
}
