package app.penmoss.ui.settings

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.paging.compose.LazyPagingItems
import androidx.paging.compose.itemKey
import app.penmoss.analytics.AnalyticsCopy
import app.penmoss.analytics.AnalyticsFormat
import app.penmoss.analytics.EventEntity
import app.penmoss.analytics.EventState
import app.penmoss.analytics.trackedId
import app.penmoss.ui.common.TextButton
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** When an event happened, in the phone's time zone: `2026-11-19 11:54:16`. */
private val TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

fun eventTime(at: Long, zone: ZoneId = ZoneId.systemDefault()): String = TIME.format(Instant.ofEpochMilli(at).atZone(zone))

/** The date sharing began, as the summary says it. */
private val DATE = DateTimeFormatter.ofPattern("d MMM yyyy", java.util.Locale.UK)

/** The viewer's summary: where the record is, how long it is kept, the ID, and whether it is shared. */
fun viewerSummary(days: Int, install: String, sharing: Boolean?, since: Long?, zone: ZoneId = ZoneId.systemDefault()): String {
    val state = when {
        sharing == null -> AnalyticsCopy.text("viewer.sharing.unanswered")
        sharing && since != null -> AnalyticsCopy.text("viewer.sharing.on", "date" to DATE.format(Instant.ofEpochMilli(since).atZone(zone)))
        sharing -> AnalyticsCopy.text("viewer.sharing.on", "date" to "now")
        else -> AnalyticsCopy.text("viewer.sharing.off")
    }
    return AnalyticsCopy.text("viewer.summary", "days" to days, "id" to shortId(install), "sharing" to state)
}

/**
 * Analytics Data (PEN-137, AC6): the record on this phone, whatever the switch says, newest first,
 * a page of 100 at a time as the list scrolls (Paging 3, keyset on time and id). Each row shows
 * its time, kind, name, props and state; the chips filter by state. Its own screen with a back
 * arrow to Privacy.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AnalyticsDataScreen(
    summary: String,
    counts: Map<EventState, Long>,
    filter: EventState?,
    onFilter: (EventState?) -> Unit,
    events: LazyPagingItems<EventEntity>,
    onCopyJson: (() -> Unit)?,
    onBack: () -> Unit,
) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = { Text(AnalyticsCopy.text("viewer.title")) },
                navigationIcon = { BackButton(onBack) },
                actions = {
                    if (onCopyJson != null) {
                        TextButton(onClick = app.penmoss.analytics.trackedClick("privacy.data.copy-json", onCopyJson), modifier = Modifier.testTag("viewerCopyJson").trackedId("privacy.data.copy-json")) {
                            Text(AnalyticsCopy.text("viewer.copyJson.button"))
                        }
                    }
                },
                scrollBehavior = scroll,
                modifier = Modifier.testTag("sectionTopBar"),
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).testTag("viewerList")) {
            item(key = "summary") { Help(summary, Modifier.testTag("viewerSummary")) }
            item(key = "counts") { Help(AnalyticsFormat.countsLine(counts), Modifier.testTag("viewerCounts")) }
            item(key = "filters") {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp).testTag("viewerFilters").trackedId("privacy.data.filter-state"),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val choices = listOf<EventState?>(null) + EventState.ORDER
                    for (choice in choices) {
                        FilterChip(
                            selected = filter == choice,
                            onClick = {
                                app.penmoss.analytics.Analytics.click("privacy.data.filter-state")
                                onFilter(choice)
                            },
                            label = { Text(choice?.label ?: AnalyticsCopy.text("viewer.filter.all.label")) },
                            modifier = Modifier.testTag("viewerFilter-${choice?.wire ?: "all"}"),
                        )
                    }
                }
            }
            if (events.itemCount == 0 && events.loadState.refresh !is androidx.paging.LoadState.Loading) {
                item(key = "empty") { Help(AnalyticsCopy.text("viewer.empty.title"), Modifier.testTag("viewerEmpty")) }
            }
            items(events.itemCount, key = events.itemKey { it.id }) { index ->
                val event = events[index] ?: return@items
                EventRow(event)
            }
        }
    }
}

@Composable
private fun EventRow(event: EventEntity) {
    ListItem(
        overlineContent = { Text("${eventTime(event.at)} · ${event.eventState.label}") },
        headlineContent = { Text("${event.kind} · ${event.name}", maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = if (event.props == "{}") null else {
            { Text(event.props, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        },
        modifier = Modifier.testTag("viewerEvent"),
    )
}
