package app.penmoss.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** "3 Oct, 4:12 PM", the year only when it is not this one; "never" without a time (the web's `shortWhen`). */
internal fun shortWhen(time: Long?, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    if (time == null || time == 0L) return "never"
    val date = Instant.ofEpochMilli(time).atZone(zone)
    val thisYear = date.year == Instant.ofEpochMilli(now).atZone(zone).year
    val pattern = if (thisYear) "d MMM, h:mm a" else "d MMM yyyy, h:mm a"
    return DateTimeFormatter.ofPattern(pattern, locale).format(date)
}
