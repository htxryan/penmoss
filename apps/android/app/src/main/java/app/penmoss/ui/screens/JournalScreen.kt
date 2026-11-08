package app.penmoss.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import app.penmoss.ui.JournalMarks
import app.penmoss.ui.JournalMonth
import app.penmoss.ui.journalLongDate
import app.penmoss.ui.journalToday
import app.penmoss.ui.journalWeeks
import java.time.LocalDate
import java.time.Month
import java.time.format.TextStyle
import java.util.Locale

private val DAY_HEADS = listOf("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su")

private fun monthLabel(month: JournalMonth): String =
    "${Month.of(month.month).getDisplayName(TextStyle.FULL, Locale.getDefault())} ${month.year}"

/**
 * The Journal calendar (T40 P5, JR3): a month grid with a dot under days that have a daily
 * note, an ISO week-number column (a tap opens or creates that week's note), arrows between
 * months, and a Today chip that opens today's note, as the web's does. Offline too: the marks come from Room, which `/sync/changes` and
 * `/sync/tree` fill with each note's kind and period.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JournalScreen(
    timeZone: String,
    marks: JournalMarks,
    onBack: () -> Unit,
    onOpenDay: (day: String) -> Unit,
    onOpenWeek: (monday: String) -> Unit,
    /** Today's note, as the web calendar's Today button runs `journal.today` (review S7). */
    onOpenToday: () -> Unit,
    /** The month shown first (tests pin one; the phone shows the current month). */
    initial: JournalMonth? = null,
) {
    var today by remember(timeZone) { mutableStateOf(journalToday(timeZone)) }
    // Read again whenever the screen comes back, so a midnight while it was away moves the
    // highlight (review N3).
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { today = journalToday(timeZone) }
    // Year and month as saveable ints (T40 P5): a JournalMonth itself is no Bundle value.
    var shownYear by rememberSaveable(timeZone, initial?.year) { mutableIntStateOf(initial?.year ?: today.year) }
    var shownMonth by rememberSaveable(timeZone, initial?.month) { mutableIntStateOf(initial?.month ?: today.monthValue) }
    val shown = JournalMonth(shownYear, shownMonth)
    val show: (JournalMonth) -> Unit = { shownYear = it.year; shownMonth = it.month }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Journal") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    TextButton(
                        onClick = onOpenToday,
                        modifier = Modifier.testTag("journalToday").semantics { contentDescription = "Open Today's Note" },
                    ) { Text("Today") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                IconButton(
                    onClick = { show(shown.previous()) },
                    modifier = Modifier.testTag("journalPrev"),
                ) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Previous Month") }
                Text(
                    monthLabel(shown),
                    Modifier.testTag("journalMonth"),
                    style = MaterialTheme.typography.titleMedium,
                )
                IconButton(
                    onClick = { show(shown.next()) },
                    modifier = Modifier.testTag("journalNext"),
                ) { Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = "Next Month") }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                // The week-number column's header stays empty, as on the web.
                Box(Modifier.weight(0.7f))
                for (head in DAY_HEADS) {
                    Text(
                        head,
                        Modifier.weight(1f),
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            for (week in journalWeeks(shown.year, shown.month)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    val weekMarked = week.period in marks.weeks
                    TextButton(
                        onClick = { onOpenWeek(week.monday.toString()) },
                        modifier = Modifier.weight(0.7f).testTag("journalWeek-${week.period}")
                            .semantics { contentDescription = "Week ${week.period}${if (weekMarked) ", has a note" else ""}" },
                    ) {
                        Text(
                            week.number.toString(),
                            style = if (weekMarked) MaterialTheme.typography.titleSmall else MaterialTheme.typography.bodyMedium,
                            color = if (weekMarked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    for (day in week.days) {
                        DayCell(
                            day = day,
                            inMonth = day.monthValue == shown.month,
                            isToday = day == today,
                            marked = day.toString() in marks.days,
                            onOpen = { onOpenDay(day.toString()) },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DayCell(
    day: LocalDate,
    inMonth: Boolean,
    isToday: Boolean,
    marked: Boolean,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // As the web names a day cell: core's long date (review S7).
    val description = buildString {
        append(journalLongDate(day))
        if (isToday) append(", today")
        if (marked) append(", has a note")
    }
    TextButton(
        onClick = onOpen,
        modifier = modifier.testTag("journalDay-${day}").semantics { contentDescription = description },
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                day.dayOfMonth.toString(),
                style = if (isToday) MaterialTheme.typography.titleSmall else MaterialTheme.typography.bodyMedium,
                color = when {
                    isToday -> MaterialTheme.colorScheme.primary
                    inMonth -> MaterialTheme.colorScheme.onSurface
                    else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                },
            )
            // The mark under days that have a daily note, as the web's sidebar calendar shows.
            Text(
                if (marked) "•" else "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}
