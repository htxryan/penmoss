package app.penmoss.ui

import app.penmoss.data.JournalMark
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.temporal.IsoFields

/**
 * The Journal calendar's month (T40 P5): which month grid shows, with the previous and next.
 */
data class JournalMonth(val year: Int, val month: Int) {
    fun next(): JournalMonth {
        val next = YearMonth.of(year, month).plusMonths(1)
        return JournalMonth(next.year, next.monthValue)
    }

    fun previous(): JournalMonth {
        val previous = YearMonth.of(year, month).minusMonths(1)
        return JournalMonth(previous.year, previous.monthValue)
    }

    companion object {
        fun of(year: Int, month: Int): JournalMonth = JournalMonth(year, month)

        fun todayIn(zone: String): JournalMonth {
            val today = journalToday(zone)
            return JournalMonth(today.year, today.monthValue)
        }
    }
}

/**
 * One Monday-first week of the Journal grid (T40 P5): its Monday, its seven days, and its ISO
 * week number and week year. The week-number column opens the week's note; the numbers come
 * from `java.time`, and the shared edge cases (New Year weeks, 53-week years) are pinned by
 * [JournalTest], checked against core's functions.
 */
data class JournalWeek(val monday: LocalDate, val days: List<LocalDate>, val number: Int, val weekYear: Int) {
    /** The week's period (`2026-W43`), as core's `isoWeek` writes it and Room holds it. */
    val period: String get() = "$weekYear-W${number.toString().padStart(2, '0')}"
}

/**
 * The six Monday-first weeks shown for a month (T40 P5), as the web's sidebar calendar shows
 * them. Days outside the month show too, greyed out; a tap on one still opens its note.
 */
fun journalWeeks(year: Int, month: Int): List<JournalWeek> {
    val first = LocalDate.of(year, month, 1)
    val start = first.minusDays((first.dayOfWeek.value - DayOfWeek.MONDAY.value).toLong())
    return (0..5).map { week ->
        val monday = start.plusDays((week * 7).toLong())
        JournalWeek(
            monday,
            (0..6).map { monday.plusDays(it.toLong()) },
            monday.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR),
            monday.get(IsoFields.WEEK_BASED_YEAR),
        )
    }
}

/**
 * Today's date in [zone], as the web's Daily notes says it; the default zone when it is
 * unknown here. Display only: which period to make is resolved by the editor page (T40 P5).
 */
fun journalToday(zone: String, now: Long = System.currentTimeMillis()): LocalDate =
    LocalDate.ofInstant(
        java.time.Instant.ofEpochMilli(now),
        runCatching { ZoneId.of(zone) }.getOrDefault(ZoneId.of("America/Chicago")),
    )

private val WEEKDAYS = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
private val MONTHS = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

/**
 * A day's full name (`Wednesday 21 October 2026`), in core's words as its `longDate` writes it,
 * so TalkBack reads a calendar day as the web names it (review S7). Pinned against core by the
 * shared `journal-calendar-v1.json`.
 */
fun journalLongDate(date: LocalDate): String =
    "${WEEKDAYS[date.dayOfWeek.value - 1]} ${date.dayOfMonth} ${MONTHS[date.monthValue - 1]} ${date.year}"

/** Which days and weeks have daily or weekly notes, for the Journal calendar's marks (T40 P5). */
data class JournalMarks(val days: Set<String> = emptySet(), val weeks: Set<String> = emptySet())

/** Splits the phone's journal rows into the day and week periods the calendar marks (T40 P5). */
fun journalMarksOf(marks: List<JournalMark>): JournalMarks = JournalMarks(
    days = marks.filter { it.kind == "daily" }.mapTo(HashSet()) { it.period },
    weeks = marks.filter { it.kind == "weekly" }.mapTo(HashSet()) { it.period },
)
