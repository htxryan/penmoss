package app.penmoss.analytics

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The adjustable limits (PEN-137, O7, N8, AC27, AC28): each with its default and range, a value
 * out of range refused with the range, only changed values kept, and the record pruned to the
 * limits in force as soon as they are saved.
 */
@RunWith(AndroidJUnit4::class)
class LimitsTest {
    @Test
    fun eachLimitHasItsDefaultAndRange() {
        assertEquals(7, Limits.DEFAULTS.eventsDays)
        assertEquals(200_000, Limits.DEFAULTS.eventsMax)
        assertEquals(1000, Limits.DEFAULTS.logsFileKb)
        assertEquals(2, Limits.DEFAULTS.logsFiles)
        assertEquals(7, Limits.DEFAULTS.logsDays)
        assertEquals(24, Limits.DEFAULTS.reportHours)
        assertEquals(300, Limits.DEFAULTS.reportLines)
        assertEquals(16, Limits.DEFAULTS.reportKb)
        assertEquals("1–360 days", Limits.spec(Limits.EVENTS_DAYS).rangeLabel)
        assertEquals("500–2,000,000 events", Limits.spec(Limits.EVENTS_MAX).rangeLabel)
        assertEquals(500L, Limits.EVENT_BYTES)
        assertEquals("Between 250 and 80,000", Limits.spec(Limits.LOGS_FILE_KB).rangeMessage)
    }

    @Test
    fun aValueOutOfRangeIsRefused() {
        val days = Limits.spec(Limits.EVENTS_DAYS)
        assertEquals(30, days.parse(" 30 "))
        assertNull(days.parse("0"))
        assertNull(days.parse("361"))
        assertNull(days.parse("7.5"))
        assertNull(days.parse("seven"))
        assertEquals(800_000, Limits.spec(Limits.EVENTS_MAX).parse("800,000"))
        // PEN-177: typed with or without commas, up to 2,000,000.
        assertEquals(200_000, Limits.spec(Limits.EVENTS_MAX).parse("200,000"))
        assertEquals(200_000, Limits.spec(Limits.EVENTS_MAX).parse("200000"))
        assertEquals(2_000_000, Limits.spec(Limits.EVENTS_MAX).parse("2,000,000"))
        assertNull(Limits.spec(Limits.EVENTS_MAX).parse("2,000,001"))
        // A stored value out of range reads as its default.
        assertEquals(7, Limits.of(mapOf(Limits.EVENTS_DAYS to 0)).eventsDays)
        assertEquals(5, Limits.of(mapOf(Limits.LOGS_FILES to 5)).logsFiles)
    }

    @Test
    fun spaceAndTheReportsHoursFollowTheLimits() {
        // "About 100 MB of events at most on this phone" (PEN-177), in decimal units (PEN-188).
        assertEquals("100 MB", Limits.formatBytes(Limits.DEFAULTS.eventSpace))
        assertEquals(2_000_000L, Limits.DEFAULTS.logSpace)
        assertEquals("2 MB", Limits.formatBytes(Limits.DEFAULTS.logSpace))
        val most = Limits.of(Limits.SPECS.associate { it.key to it.max })
        assertEquals("1 GB", Limits.formatBytes(most.eventSpace))
        assertEquals("400 MB", Limits.formatBytes(most.logSpace))
        assertEquals("640 KB", Limits.formatBytes(640_000))
        assertEquals("1.5 MB", Limits.formatBytes(1_500_000))
        // A report never attaches more hours than the logs keep.
        assertEquals(24, Limits.of(mapOf(Limits.LOGS_DAYS to 1, Limits.REPORT_HOURS to 168)).reportHours)
        assertEquals(168, Limits.of(mapOf(Limits.LOGS_DAYS to 7, Limits.REPORT_HOURS to 168)).reportHours)
        assertEquals(mapOf(Limits.REPORT_LINES to 50), Limits.DEFAULTS.with(Limits.REPORT_LINES, 50).changed)
    }

    @Test
    fun savedLimitsAreKeptAndThePhonePrunesToThemAtOnce() = runBlocking {
        AnalyticsHarness().use { phone ->
            val day = AnalyticsStore.DAY
            phone.clicks(20)
            phone.clock += 3 * day
            phone.clicks(10)
            val lower = Limits.DEFAULTS.with(Limits.EVENTS_DAYS, 2).with(Limits.REPORT_LINES, 50)
            assertEquals(20L, phone.store.outside(lower, phone.clock))
            phone.service.setLimits(lower)
            assertEquals(10L, phone.store.size())
            assertEquals(lower, phone.service.stateNow().limits)
            assertEquals(listOf(lower), phone.limitsSeen)
            phone.service.setLimits(Limits.DEFAULTS)
            assertEquals(Limits.DEFAULTS, phone.service.stateNow().limits)
            assertEquals(10L, phone.store.size())
        }
    }
}
