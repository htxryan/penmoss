package app.penmoss.ui.settings

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.paging.compose.LazyPagingItems
import androidx.paging.compose.itemKey
import app.penmoss.analytics.AnalyticsCopy
import app.penmoss.analytics.AnalyticsFormat
import app.penmoss.analytics.EventEntity
import app.penmoss.analytics.EventState
import app.penmoss.analytics.SessionDetail
import app.penmoss.analytics.TrackScroll
import app.penmoss.analytics.TrackedScreen
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.trackedId
import app.penmoss.ui.common.TextButton
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import app.penmoss.ui.common.BackButton

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
 * its time, kind, name, props and its state as a tinted chip; the filter chips filter by state. Its own screen with a back
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
    TrackedScreen("settings.privacy-data")
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = { Text(AnalyticsCopy.text("viewer.title")) },
                navigationIcon = { BackButton(onBack) },
                actions = {
                    if (onCopyJson != null) {
                        TextButton(onClick = trackedClick("privacy.data.copy-json", onCopyJson), modifier = Modifier.testTag("viewerCopyJson").trackedId("privacy.data.copy-json")) {
                            Text(AnalyticsCopy.text("viewer.copyJson.button"))
                        }
                    }
                },
                scrollBehavior = scroll,
                modifier = Modifier.testTag("sectionTopBar"),
            )
        },
    ) { padding ->
        val list = rememberLazyListState()
        // How far down the page is (PEN-175): a Settings page, this one too.
        TrackScroll("settings", list, "analytics-data")
        LazyColumn(Modifier.fillMaxSize().padding(padding).testTag("viewerList"), state = list) {
            item(key = "summary") { Help(summary, Modifier.testTag("viewerSummary")) }
            // The counts by state under the summary, name first, as the Mac's (AC6, ac36).
            item(key = "counts") {
                Text(
                    AnalyticsFormat.countsLine(counts),
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("viewerCounts"),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            item(key = "filters") {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp).testTag("viewerFilters").trackedId("privacy.data.filter-state"),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val choices = listOf<EventState?>(null) + EventState.ORDER
                    for (choice in choices) {
                        FilterChip(
                            selected = filter == choice,
                            onClick = trackedClick("privacy.data.filter-state") { onFilter(choice) },
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
        overlineContent = { Text(eventTime(event.at)) },
        headlineContent = { EventName(event.kind, event.name) },
        supportingContent = if (event.props == "{}") null else {
            // As the Mac's viewer writes them (PEN-177, core's propsLine): key: value, a long list cut.
            { Text(propsText(event.props), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        },
        trailingContent = { StateChip(event.eventState) },
        modifier = Modifier.testTag("viewerEvent"),
    )
}

/**
 * An event's kind and name, each whole (PEN-177): where the row is too narrow for both, the name
 * goes under the kind rather than breaking mid-word, as the Mac's Name cell never wraps; only the
 * props line below wraps. It reads as one text, "kind · name".
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun EventName(kind: String, name: String) {
    val line = "$kind · $name"
    FlowRow(Modifier.clearAndSetSemantics { text = AnnotatedString(line) }) {
        Text("$kind ·\u00A0", softWrap = false, maxLines = 1)
        Text(name, softWrap = false, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** An event's stored props as one line ([SessionDetail.propsLine]); what isn't JSON, as it is. */
internal fun propsText(props: String): String =
    runCatching { SessionDetail.propsLine(kotlinx.serialization.json.Json.parseToJsonElement(props) as kotlinx.serialization.json.JsonObject) }
        .getOrDefault(props)

/** Penmoss's `warnBg` and `success` tokens (packages/ui/src/theme/builtins.ts), light and dark. */
private val WARN_BG_LIGHT = Color(0xFFFBEFC9)
private val WARN_BG_DARK = Color(0xFF4A3D14)
private val SUCCESS_LIGHT = Color(0xFF4E7A3C)
private val SUCCESS_DARK = Color(0xFF8DB974)

/**
 * An event's state as a tinted chip, as the Mac's (ac36): Waiting to Send amber, Sent green,
 * Not Shared, Refused and Waiting for Your Answer neutral.
 */
@Composable
internal fun StateChip(state: EventState) {
    val colours = MaterialTheme.colorScheme
    val dark = colours.background.luminance() < 0.5f
    val tint = when (state) {
        EventState.WAITING -> if (dark) WARN_BG_DARK else WARN_BG_LIGHT
        EventState.SENT -> (if (dark) SUCCESS_DARK else SUCCESS_LIGHT).copy(alpha = 0.18f)
        else -> colours.onSurface.copy(alpha = 0.08f)
    }
    Surface(color = tint, contentColor = colours.onSurface, shape = RoundedCornerShape(4.dp), modifier = Modifier.testTag("viewerState-${state.wire}")) {
        Text(state.label, Modifier.padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}
