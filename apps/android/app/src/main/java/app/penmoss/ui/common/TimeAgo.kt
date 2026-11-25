package app.penmoss.ui.common

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val DAY = DateTimeFormatter.ofPattern("MMM d", Locale.US)
private val DAY_AND_YEAR = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)

/**
 * How long ago [at] was (epoch ms), in the apps' one way of saying it: "just now" under a minute,
 * "2 min ago", "3 h ago" under a day, then the day, "Nov 7", with its year when that is not this
 * year, "Nov 7, 2024". Minutes and hours are whole ones gone by; a time ahead of [now] (another
 * device's clock) is "just now". Core's `timeAgo` (`@penmoss/core/words`) writes the same:
 * `WordsContractTest` replays `contract/words-v1.json`.
 */
fun timeAgo(at: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    val minutes = Math.floorDiv(now - at, 60_000L)
    if (minutes < 1) return "just now"
    if (minutes < 60) return "$minutes min ago"
    val hours = minutes / 60
    if (hours < 24) return "$hours h ago"
    val day = Instant.ofEpochMilli(at).atZone(zone)
    val thisYear = day.year == Instant.ofEpochMilli(now).atZone(zone).year
    return (if (thisYear) DAY else DAY_AND_YEAR).format(day)
}

/** The time now, again each [everyMs] while shown, so "Synced 2 min ago" keeps true (the web's `useNow`). */
@Composable
fun rememberNow(everyMs: Long = 30_000L): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(everyMs) {
        while (true) {
            delay(everyMs)
            now = System.currentTimeMillis()
        }
    }
    return now
}
