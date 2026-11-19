package app.penmoss.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.AnalyticsCopy
import app.penmoss.analytics.AnalyticsFormat
import app.penmoss.analytics.EventState
import app.penmoss.analytics.LimitSpec
import app.penmoss.analytics.Limits
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.trackedId
import app.penmoss.ui.common.OutlinedTextField
import app.penmoss.ui.common.TextButton
import kotlinx.coroutines.launch

/*
 * Settings → Privacy on the phone (PEN-137, AC5, AC26, AC38, AC40): one layout with the Mac's,
 * the same order and words ("this phone" for "this Mac"). Share Usage Data; View Analytics Data,
 * which opens the record as its own screen; the Analytics ID with Reset My Analytics ID and
 * Delete My Shared Data (which asks first); Logs with Share Log File; then Advanced, closed, which
 * opens in place with every limit. A Privacy Policy link ends the page.
 */

/** What the page shows. */
data class PrivacyUi(
    /** Read yet: until then the switch waits. */
    val known: Boolean = true,
    val sharing: Boolean = false,
    val counts: Map<EventState, Long> = emptyMap(),
    /** The anonymous install ID: 32 hex characters. */
    val install: String = "",
    val limits: Limits = Limits.DEFAULTS,
    /** What the last action came to (a new ID, deleted, offline), read out. */
    val notice: String? = null,
    /** Delete My Shared Data is asking the server. */
    val forgetting: Boolean = false,
)

/** How much a change of limits would delete now: events, and bytes of logs. */
data class LimitsPreview(val events: Long = 0, val logBytes: Long = 0) {
    val deletes: Boolean get() = events > 0 || logBytes > 0
}

/** What the page does. */
class PrivacyActions(
    val onShare: (Boolean) -> Unit = {},
    val onViewData: () -> Unit = {},
    val onResetId: () -> Unit = {},
    /** Delete was pressed in the confirmation: only then is the server asked. */
    val onForget: () -> Unit = {},
    val onShareLog: () -> Unit = {},
    /** How much [Limits] would delete now (counted off the main thread). */
    val preview: suspend (Limits) -> LimitsPreview = { LimitsPreview() },
    /** Saves new limits, pruning what falls outside them. */
    val onLimits: (Limits) -> Unit = {},
    val onPolicy: () -> Unit = {},
    val onBack: () -> Unit = {},
)

/** The ID as the page writes it: its first eight and last four characters. */
fun shortId(install: String): String = if (install.length < 12) install else "${install.take(8)}…${install.takeLast(4)}"

/** The Settings row's line (AC47): whether the record is shared, and how big it is. */
fun privacySummary(sharing: Boolean?, events: Long?): String {
    val state = when (sharing) {
        null -> "Not Answered Yet"
        true -> "Sharing"
        false -> "Not Sharing"
    }
    return if (events == null) state else "$state · ${AnalyticsFormat.number(events)} ${if (events == 1L) "Event" else "Events"}"
}

/** The Advanced rows' ids: the Mac's `data-setting`s; a search result for one opens Advanced. */
val LIMIT_ROW_IDS: Map<String, String> = linkedMapOf(
    Limits.EVENTS_DAYS to "keep-events-for",
    Limits.EVENTS_MAX to "keep-at-most",
    Limits.LOGS_FILE_KB to "log-file-size",
    Limits.LOGS_FILES to "log-files-kept",
    Limits.LOGS_DAYS to "keep-log-lines-for",
    Limits.REPORT_HOURS to "attach-logs-from-the-last",
    Limits.REPORT_LINES to "report-at-most-lines",
    Limits.REPORT_KB to "report-at-most-kb",
)

/** Each limit's label in the copy. */
private fun limitLabel(key: String) = AnalyticsCopy.text("limits.$key.label")

@Composable
fun PrivacyScreen(ui: PrivacyUi, actions: PrivacyActions) {
    var forgetAsk by rememberSaveable { mutableStateOf(false) }
    val mark = LocalSettingMark.current
    // A search result inside Advanced opens it first (AC48).
    var advanced by rememberSaveable { mutableStateOf(mark.target in LIMIT_ROW_IDS.values || mark.target == "reset-to-defaults") }
    SectionScreen(AnalyticsCopy.text("privacy.title"), actions.onBack) {
        Help(AnalyticsCopy.text("privacy.lead"), Modifier.testTag("privacyLead"))
        ListItem(
            headlineContent = { Text(AnalyticsCopy.text("privacy.share.label")) },
            supportingContent = { Text(AnalyticsCopy.text("privacy.share.hint")) },
            trailingContent = { Switch(checked = ui.sharing, onCheckedChange = null, enabled = ui.known) },
            modifier = Modifier.settingRow("share-usage-data").testTag("privacyShare").trackedId("privacy.share.on")
                .toggleable(value = ui.sharing, enabled = ui.known, role = Role.Switch) { on ->
                    app.penmoss.analytics.Analytics.click(if (on) "privacy.share.on" else "privacy.share.off")
                    actions.onShare(on)
                },
        )
        ListItem(
            headlineContent = { Text(AnalyticsCopy.text("privacy.viewData.label")) },
            supportingContent = { Text(AnalyticsFormat.countsLine(ui.counts), Modifier.testTag("privacyCounts")) },
            trailingContent = { Icon(Icons.Default.KeyboardArrowRight, contentDescription = null) },
            modifier = Modifier.settingRow("view-analytics-data").testTag("privacyViewData").trackedId("privacy.view-data")
                .clickable(role = Role.Button, onClick = trackedClick("privacy.view-data", actions.onViewData)),
        )
        ListItem(
            headlineContent = { Text(AnalyticsCopy.text("privacy.id.label")) },
            supportingContent = {
                Column {
                    Text(shortId(ui.install), Modifier.testTag("privacyId"), style = MaterialTheme.typography.bodyMedium)
                    Text(AnalyticsCopy.text("privacy.id.hint"))
                }
            },
            modifier = Modifier.settingRow("analytics-id"),
        )
        ListItem(
            headlineContent = { Text(AnalyticsCopy.text("privacy.resetId.button")) },
            modifier = Modifier.settingRow("reset-my-analytics-id").testTag("privacyResetId").trackedId("privacy.reset-id")
                .clickable(role = Role.Button, enabled = ui.known, onClick = trackedClick("privacy.reset-id", actions.onResetId)),
        )
        ListItem(
            headlineContent = { Text(AnalyticsCopy.text("privacy.forget.button"), color = MaterialTheme.colorScheme.error) },
            modifier = Modifier.settingRow("delete-my-shared-data").testTag("privacyForget").trackedId("privacy.forget")
                .clickable(role = Role.Button, enabled = ui.known && !ui.forgetting, onClick = trackedClick("privacy.forget") { forgetAsk = true }),
        )
        if (ui.notice != null) {
            Help(ui.notice, Modifier.testTag("privacyNotice").semantics { liveRegion = LiveRegionMode.Polite })
        }
        ListItem(
            headlineContent = { Text(AnalyticsCopy.text("privacy.logs.label")) },
            supportingContent = { Text(AnalyticsCopy.text("privacy.logs.hint", "days" to ui.limits.logsDays)) },
            trailingContent = {
                TextButton(onClick = trackedClick("privacy.share-log-file", actions.onShareLog), modifier = Modifier.testTag("privacyShareLog").trackedId("privacy.share-log-file")) {
                    Text(AnalyticsCopy.text("privacy.logs.button"))
                }
            },
            modifier = Modifier.settingRow("logs"),
        )
        HorizontalDivider()
        ListItem(
            headlineContent = { Text(AnalyticsCopy.text("privacy.advanced.label")) },
            trailingContent = { Icon(if (advanced) Icons.Default.KeyboardArrowDown else Icons.Default.KeyboardArrowRight, contentDescription = null) },
            modifier = Modifier.settingRow("advanced").testTag("privacyAdvanced").trackedId("privacy.advanced")
                .semantics { stateDescription = if (advanced) "Open" else "Closed" }
                .toggleable(value = advanced, role = Role.Button) {
                    app.penmoss.analytics.Analytics.click("privacy.advanced", on = it)
                    advanced = it
                },
        )
        if (advanced) AdvancedLimits(ui.limits, actions)
        HorizontalDivider()
        ListItem(
            headlineContent = { Text(AnalyticsCopy.text("privacy.policy.label"), color = MaterialTheme.colorScheme.primary) },
            modifier = Modifier.testTag("privacyPolicy").clickable(role = Role.Button, onClick = trackedClick("privacy.policy", actions.onPolicy)),
        )
    }
    if (forgetAsk) {
        val tracked = rememberTrackedDialog("confirm")
        AlertDialog(
            onDismissRequest = {
                app.penmoss.analytics.Analytics.click("privacy.forget.cancel")
                forgetAsk = false
            },
            title = { Text(AnalyticsCopy.text("forget.title")) },
            text = { Text(AnalyticsCopy.text("forget.body", "id" to shortId(ui.install))) },
            confirmButton = {
                TextButton(
                    onClick = trackedClick("privacy.forget.confirm", tracked.done {
                        forgetAsk = false
                        actions.onForget()
                    }),
                    modifier = Modifier.testTag("confirmForget"),
                ) { Text(AnalyticsCopy.text("confirm.delete.button"), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = trackedClick("privacy.forget.cancel") { forgetAsk = false }, modifier = Modifier.testTag("cancelForget")) {
                    Text(AnalyticsCopy.text("confirm.cancel.button"))
                }
            },
            modifier = Modifier.testTag("forgetDialog"),
        )
    }
}

/** A lowered limit asking first: what it would delete, and the limits it would save. */
private data class Asking(val limits: Limits, val preview: LimitsPreview, val key: String?)

/**
 * Advanced (AC26, AC40): every limit in three groups, stacked on a phone, each field with its unit
 * and range and "Default: n" once changed. A value out of range is refused, saying the range. A
 * lowered value that would delete anything asks first; Cancel puts the old value back.
 */
@Composable
private fun AdvancedLimits(limits: Limits, actions: PrivacyActions) {
    val scope = rememberCoroutineScope()
    var asking by remember { mutableStateOf<Asking?>(null) }
    // Bumped to put every field back to the saved value (Cancel).
    var restore by remember { mutableStateOf(0) }
    fun commit(next: Limits, key: String?) {
        if (next == limits) return
        scope.launch {
            val preview = actions.preview(next)
            if (preview.deletes) asking = Asking(next, preview, key) else save(next, key, actions)
        }
    }
    Column(Modifier.fillMaxWidth().testTag("privacyLimits")) {
        Help(AnalyticsCopy.text("privacy.advanced.intro"))
        for ((group, title) in listOf("usage" to "limits.usage.title", "logs" to "limits.logs.title", "report" to "limits.report.title")) {
            GroupTitle(AnalyticsCopy.text(title))
            for (spec in Limits.SPECS.filter { it.group == group }) {
                LimitField(spec, limits[spec.key], restore) { value -> commit(limits.with(spec.key, value), spec.key) }
            }
            val space = when (group) {
                "usage" -> AnalyticsCopy.text("limits.usage.space", "size" to Limits.formatBytes(limits.eventSpace))
                "logs" -> AnalyticsCopy.text("limits.logs.space", "size" to Limits.formatBytes(limits.logSpace))
                else -> AnalyticsCopy.text("limits.report.space", "hours" to limits.reportHours, "lines" to limits.reportLines, "kb" to limits.reportKb)
            }
            Help(space, Modifier.testTag("limitsSpace-$group"))
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), horizontalArrangement = Arrangement.Start) {
            TextButton(
                onClick = trackedClick("privacy.limits.reset") { commit(Limits.DEFAULTS, null) },
                enabled = limits != Limits.DEFAULTS,
                modifier = Modifier.settingRow("reset-to-defaults").testTag("limitsReset").trackedId("privacy.limits.reset"),
            ) { Text(AnalyticsCopy.text("limits.reset.button")) }
        }
    }
    val ask = asking
    if (ask != null) {
        val back: () -> Unit = {
            asking = null
            restore += 1
        }
        val tracked = rememberTrackedDialog("confirm")
        AlertDialog(
            onDismissRequest = trackedClick("privacy.limits.cancel", back),
            title = { Text(pruneTitle(ask.preview)) },
            text = { Text(AnalyticsCopy.text("prune.body", "reason" to pruneReason(limits, ask))) },
            confirmButton = {
                TextButton(
                    onClick = trackedClick("privacy.limits.confirm", tracked.done {
                        asking = null
                        save(ask.limits, ask.key, actions)
                    }),
                    modifier = Modifier.testTag("confirmPrune"),
                ) { Text(AnalyticsCopy.text("confirm.delete.button"), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = trackedClick("privacy.limits.cancel", back), modifier = Modifier.testTag("cancelPrune")) { Text(AnalyticsCopy.text("confirm.cancel.button")) } },
            modifier = Modifier.testTag("pruneDialog"),
        )
    }
}

private fun save(next: Limits, key: String?, actions: PrivacyActions) {
    if (key == null) {
        app.penmoss.analytics.Analytics.record("setting", "privacy.limits.reset", mapOf("changed" to true))
    } else {
        app.penmoss.analytics.Analytics.setting("privacy.limits.$key", next[key])
    }
    actions.onLimits(next)
}

/** "Delete 41,206 Events?", or "Delete 38 MB of Logs?" when only logs would go. */
internal fun pruneTitle(preview: LimitsPreview): String =
    if (preview.events > 0) AnalyticsCopy.text("prune.events.title", "count" to preview.events)
    else AnalyticsCopy.text("prune.logs.title", "size" to Limits.formatBytes(preview.logBytes))

/** Why they would go: older than the days, beyond the newest n, or beyond the new size. */
private fun pruneReason(saved: Limits, ask: Asking): String {
    val next = ask.limits
    return when {
        ask.preview.events > 0 && next.eventsDays < saved.eventsDays -> AnalyticsCopy.text("prune.reason.age", "days" to next.eventsDays)
        ask.preview.events > 0 -> AnalyticsCopy.text("prune.reason.cap", "max" to next.eventsMax)
        next.logsDays < saved.logsDays -> AnalyticsCopy.text("prune.reason.age", "days" to next.logsDays)
        else -> AnalyticsCopy.text("prune.reason.size")
    }
}

/**
 * One limit's field: its label, the value, its unit and range, and "Default: n" once changed. The
 * value is taken when Done is pressed or the field is left; out of range it says the range and
 * nothing is saved.
 */
@Composable
private fun LimitField(spec: LimitSpec, value: Int, restore: Int, onCommit: (Int) -> Unit) {
    var text by remember(value, restore) { mutableStateOf(value.toString()) }
    var wrong by remember(value, restore) { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    fun commit() {
        if (text.trim() == value.toString()) {
            wrong = false
            return
        }
        val parsed = spec.parse(text)
        wrong = parsed == null
        if (parsed != null) onCommit(parsed)
    }
    val id = LIMIT_ROW_IDS.getValue(spec.key)
    val supporting = buildList {
        add(if (wrong) spec.rangeMessage else spec.rangeLabel)
        if (value != spec.default) add(AnalyticsCopy.text("limits.default", "value" to spec.default))
    }.joinToString(" · ")
    OutlinedTextField(
        value = text,
        onValueChange = { next -> text = next.filter { it.isDigit() || it == ',' }.take(9) },
        label = { Text(limitLabel(spec.key)) },
        suffix = { Text(spec.unit) },
        supportingText = { Text(supporting, Modifier.testTag("limitHint-${spec.key}")) },
        isError = wrong,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { commit() }),
        modifier = Modifier
            .settingRow(id)
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .testTag("limit-${spec.key}")
            .onFocusChanged { state ->
                if (focused && !state.isFocused) commit()
                focused = state.isFocused
            }
            .semantics { if (wrong) error(spec.rangeMessage) },
    )
}
