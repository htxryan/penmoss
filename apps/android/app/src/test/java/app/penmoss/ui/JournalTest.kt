package app.penmoss.ui

import app.penmoss.data.JournalMark
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.time.LocalDate

/**
 * The Journal calendar's month grid (T40 P5, JR3): Monday-first weeks, ISO week numbers from
 * `java.time`, and marks from the phone's journal rows. The edge cases (New Year weeks, 53-week
 * years, a week 1 starting in December, the days either side of both DST changes) are checked
 * against core: `contract/journal-calendar-v1.json` is written from `@penmoss/core/periodic`
 * by the editor page's vitest (review S8). Kotlin lays the grid out and formats what it shows;
 * which period to make is resolved by the editor page, never here.
 */
class JournalTest {
    @Test
    fun october2026StartsOnMondaySeptember28InWeek40() {
        val weeks = journalWeeks(2026, 10)
        assertEquals(6, weeks.size)
        assertEquals(LocalDate.of(2026, 9, 28), weeks[0].monday)
        assertEquals(40, weeks[0].number)
        assertEquals(2026, weeks[0].weekYear)
        assertEquals("2026-W40", weeks[0].period)
        // Every row is seven days from its Monday.
        for (week in weeks) {
            assertEquals((0..6).map { week.monday.plusDays(it.toLong()) }, week.days)
        }
        // Week 43 is October 19 to 25.
        val week43 = weeks.first { it.number == 43 }
        assertEquals("2026-W43", week43.period)
        assertEquals(LocalDate.of(2026, 10, 19), week43.monday)
        assertEquals("2026-10-25", week43.days.last().toString())
    }

    @Test
    fun newYearWeeksFollowTheISOYear() {
        // January 2021 starts on a Friday: its grid starts Monday 2020-12-28, in 2020-W53.
        val weeks = journalWeeks(2021, 1)
        assertEquals(LocalDate.of(2020, 12, 28), weeks[0].monday)
        assertEquals("2020-W53", weeks[0].period)
        assertEquals(2020, weeks[0].weekYear)
        // January 1st itself is in 2020-W53, as core's `isoWeek` says.
        val friday = weeks[0].days.first { it.dayOfMonth == 1 }
        assertEquals(weeks[0].period, "2020-W53")
        assertEquals(weeks[0].monday, LocalDate.of(2020, 12, 28))
        assertEquals(friday, LocalDate.of(2021, 1, 1))
    }

    @Test
    fun monthsStepForwardAndBackOverNewYear() {
        assertEquals(JournalMonth(2027, 1), JournalMonth(2026, 12).next())
        assertEquals(JournalMonth(2026, 12), JournalMonth(2027, 1).previous())
        assertEquals(JournalMonth(2026, 10), JournalMonth(2026, 11).previous())
    }

    @Test
    fun marksSplitIntoDayAndWeekPeriods() {
        val marks = journalMarksOf(
            listOf(
                JournalMark("daily", "2026-10-21"),
                JournalMark("weekly", "2026-W43"),
                JournalMark("note", "2026-10-21"),
            ),
        )
        assertEquals(setOf("2026-10-21"), marks.days)
        assertEquals(setOf("2026-W43"), marks.weeks)
    }

    @Test
    fun todayComesFromTheSyncedZoneAtAFixedInstant() {
        // 04:10 UTC on the 21st is the 20th in Chicago and the 21st in Tokyo: the phone's
        // own zone must not matter. (Display only: the editor page resolves "today", never here.)
        val at = java.time.Instant.parse("2026-10-21T04:10:00Z").toEpochMilli()
        val zone = java.util.TimeZone.getDefault()
        try {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("Asia/Tokyo"))
            assertEquals(LocalDate.of(2026, 10, 20), journalToday("America/Chicago", at))
            assertEquals(LocalDate.of(2026, 10, 21), journalToday("Asia/Tokyo", at))
        } finally {
            java.util.TimeZone.setDefault(zone)
        }
        assertEquals(LocalDate.of(2026, 10, 20), journalToday("Mars/Olympus", at))
    }

    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("journal-calendar-v1.json") }
            ?: File("../contract/journal-calendar-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content

    @Test
    fun everyMonthsGridIsCoresWeekForWeekAndDayForDay() {
        val months = contract.getValue("months").jsonArray.map { it.jsonObject }
        assertEquals(7, months.size)
        for (month in months) {
            val year = month.text("year").toInt()
            val number = month.text("month").toInt()
            val expected = month.getValue("weeks").jsonArray.map { it.jsonObject }
            val weeks = journalWeeks(year, number)
            assertEquals("$year-$number", expected.map { it.text("period") }, weeks.map { it.period })
            for ((week, core) in weeks.zip(expected)) {
                val days = core.getValue("days").jsonArray.map { it.jsonObject }
                assertEquals(days.map { it.text("date") }, week.days.map { it.toString() })
                // TalkBack's name for each day cell: core's longDate (review S7).
                assertEquals(days.map { it.text("longDate") }, week.days.map(::journalLongDate))
            }
        }
    }

    @Test
    fun todayEitherSideOfTheDstChangesIsCores() {
        val cases = contract.getValue("today").jsonArray.map { it.jsonObject }
        assertEquals(10, cases.size)
        for (case in cases) {
            val at = java.time.Instant.parse(case.text("at")).toEpochMilli()
            assertEquals(case.text("at"), LocalDate.parse(case.text("date")), journalToday(case.text("zone"), at))
        }
    }
}
