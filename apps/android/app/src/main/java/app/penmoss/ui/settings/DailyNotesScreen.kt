package app.penmoss.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.SettingLimits
import app.penmoss.feedback.MarkdownPreviewView
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.rememberLucideIcons
import app.penmoss.ui.common.OutlinedTextField
import app.penmoss.ui.common.SQUARE
import app.penmoss.ui.common.TextButton
import app.penmoss.ui.common.roles
import kotlinx.coroutines.delay
import java.time.LocalDate

// --- Daily Notes (ST6; PEN-146 option B) ---

/** The keys of the two templates (the web's `template.daily` and `template.weekly`). */
data class TemplateField(val key: String, val label: String, val saved: String, val custom: Boolean)

/** The placeholders a template can hold (core's `fillTemplate`), with what each writes. */
internal val PLACEHOLDERS = listOf(
    "{{date}}" to "2026-10-21",
    "{{longDate}}" to "Wednesday 21 October 2026",
    "{{weekday}}" to "Wednesday",
    "{{week}}" to "2026-W43",
    "{{year}}" to "2026",
    "{{month}}" to "10",
)

/** How long typing rests before a template saves itself (PEN-146): no Save button. */
internal const val TEMPLATE_SAVE_MS = 700L

private val WEEKDAY_NAMES = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

/**
 * A template with its placeholders filled in for [date], as core's `fillTemplate` fills them: a
 * weekly one for [date]'s ISO week, from its Monday. Unknown placeholders stay as typed.
 */
fun fillTemplate(template: String, weekly: Boolean, date: LocalDate): String {
    val fields = java.time.temporal.IsoFields.WEEK_OF_WEEK_BASED_YEAR
    val weekYear = date.get(java.time.temporal.IsoFields.WEEK_BASED_YEAR)
    val weekNumber = date.get(fields)
    val day = if (weekly) date.with(java.time.DayOfWeek.MONDAY) else date
    val values = mapOf(
        "date" to day.toString(),
        "longDate" to app.penmoss.ui.journal.journalLongDate(day),
        "weekday" to WEEKDAY_NAMES[day.dayOfWeek.value - 1],
        "week" to "%d-W%02d".format(weekYear, weekNumber),
        "year" to (if (weekly) weekYear else day.year).toString(),
        "month" to "%02d".format(day.monthValue),
    )
    return Regex("\\{\\{\\s*(\\w+)\\s*\\}\\}").replace(template) { match -> values[match.groupValues[1]] ?: match.value }
}

/**
 * Daily Notes (ST6; PEN-146 option B): the time zone that decides which day today is (with this
 * phone's own one tap away), then the daily and weekly templates as tabs over one editor that
 * saves as you type, with + Placeholder and a preview of today's note under it. They belong to the
 * primary notebook, which holds the journal (A827), and affect notes made afterwards (A78).
 */
@Composable
fun DailyNotesScreen(
    timeZone: String,
    today: LocalDate,
    templates: List<TemplateField>,
    enabled: Boolean,
    onTimeZone: () -> Unit,
    onSave: (key: String, value: String?) -> Unit,
    onBack: () -> Unit,
    /** This phone's own zone; Use This Phone's Zone shows when it differs. */
    phoneZone: String = timeZone,
    onUsePhoneZone: (String) -> Unit = {},
    /** The primary notebook's name, which these belong to. */
    notebook: String? = null,
    /** No notebook on the phone: nothing holds these yet. */
    noNotebook: Boolean = false,
) {
    // A search for the weekly template opens on its tab (PEN-148).
    val asked = LocalSettingMark.current.target
    var tab by rememberSaveable { mutableStateOf(templates.indexOfFirst { settingId(it.label) == asked }.coerceAtLeast(0)) }
    SectionScreen("Daily Notes", onBack, notice = settingsWait(noNotebook).takeIf { !enabled }, fill = templates.isNotEmpty()) {
        ListItem(
            headlineContent = { Text("Time Zone") },
            supportingContent = { Text("$timeZone · today is ${app.penmoss.ui.journal.journalLongDate(today).substringBeforeLast(' ')}") },
            trailingContent = { Text("›", style = MaterialTheme.roles.rowLabel) },
            modifier = Modifier.settingRow("time-zone").testTag("timeZone").clickable(enabled = enabled, role = Role.Button, onClick = trackedClick("settings.journal.time-zone", onTimeZone)),
        )
        if (phoneZone != timeZone) {
            TextButton(onClick = trackedClick("settings.journal.use-phone-zone") { onUsePhoneZone(phoneZone) }, enabled = enabled, modifier = Modifier.padding(horizontal = 8.dp).testTag("dailyUsePhoneZone")) {
                Text("Use This Phone’s Zone ($phoneZone)")
            }
        }
        if (templates.isNotEmpty()) {
            val shown = tab.coerceIn(0, templates.size - 1)
            PrimaryTabRow(selectedTabIndex = shown, modifier = Modifier.padding(top = 8.dp).testTag("templateTabs")) {
                templates.forEachIndexed { index, field ->
                    Tab(selected = index == shown, onClick = trackedClick("settings.journal.template-tab") { tab = index }, text = { Text(field.label) }, modifier = Modifier.settingRow(settingId(field.label)).testTag("tab-${field.key}"))
                }
            }
            val field = templates[shown]
            key(field.key) { TemplateEditor(field, enabled, today, onSave) }
        }
        // Out of the way while typing, so the editor keeps the height the keyboard leaves.
        @OptIn(ExperimentalLayoutApi::class)
        if (!WindowInsets.isImeVisible) {
            Help(
                (notebook?.let { "These belong to $it, your primary notebook. " } ?: "") +
                    "Changes apply to notes made afterwards and sync to your other devices.",
            )
        }
    }
}

/**
 * A template's editor (A1612): Write and Preview over one frame that takes the page's spare
 * height, as GitHub's comment box. Write is the template's markdown; Preview is today's note
 * (this week's for the weekly one) as the template makes it, drawn.
 */
@Composable
private fun ColumnScope.TemplateEditor(field: TemplateField, enabled: Boolean, today: LocalDate, onSave: (String, String?) -> Unit) {
    var draft by remember(field.key) { mutableStateOf(TextFieldValue(field.saved)) }
    // The saved text changed elsewhere (a sync, Use the Default) while nothing is being typed.
    var typed by remember(field.key) { mutableStateOf(false) }
    LaunchedEffect(field.saved) { if (!typed && field.saved != draft.text) draft = TextFieldValue(field.saved, TextRange(field.saved.length)) }
    var status by remember(field.key) { mutableStateOf<String?>(null) }
    var placing by remember { mutableStateOf(false) }
    val text = draft.text
    val tooLong = text.length > SettingLimits.TEMPLATE_MAX_CHARS
    val save by rememberUpdatedState {
        if (text != field.saved && !tooLong) {
            onSave(field.key, text)
            status = "Saved"
        }
        typed = false
    }
    // Saves once typing rests (PEN-146), and on leaving with a change not saved yet.
    LaunchedEffect(text) {
        if (!typed) return@LaunchedEffect
        delay(TEMPLATE_SAVE_MS)
        save()
    }
    DisposableEffect(field.key) { onDispose { if (typed) save() } }
    var previewing by rememberSaveable(field.key) { mutableStateOf(false) }
    val weekly = field.key == SettingKeys.WEEKLY_TEMPLATE
    val icons = rememberLucideIcons()
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp).testTag("templateMode")) {
        listOf(Triple("Write", false, "pencil"), Triple("Preview", true, "eye")).forEachIndexed { index, (label, preview, glyph) ->
            SegmentedButton(
                selected = previewing == preview,
                onClick = trackedClick(if (preview) "settings.journal.template-preview" else "settings.journal.template-write") { previewing = preview },
                shape = SegmentedButtonDefaults.itemShape(index, 2, SQUARE),
                icon = { icons?.icon(glyph)?.let { Icon(LucideAssets.vector(it), contentDescription = null, Modifier.size(18.dp)) } },
                modifier = Modifier.testTag(if (preview) "templatePreviewTab" else "templateWriteTab"),
            ) { Text(label, maxLines = 1, softWrap = false) }
        }
    }
    if (previewing) {
        // Today's note as the template makes it, drawn, in the frame the field has.
        Column(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant)
                .background(MaterialTheme.colorScheme.surfaceBright)
                .verticalScroll(rememberScrollState()).padding(16.dp)
                .testTag("templatePreview"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(if (weekly) "This Week’s Note" else "Today’s Note", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
            MarkdownPreviewView(fillTemplate(text, weekly, today), Modifier.fillMaxWidth().testTag("templatePreviewText"), framed = false)
        }
        return
    }
    OutlinedTextField(
        value = draft,
        onValueChange = {
            if (it.text != draft.text) {
                typed = true
                status = null
            }
            draft = it
        },
        modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("template-${field.key}"),
        enabled = enabled,
        label = { Text(field.label) },
        // The notebook's limit (A410), counted here so a template too long is never "Saved".
        isError = tooLong,
        supportingText = {
            Text(
                if (tooLong) "Too long: at most ${"%,d".format(SettingLimits.TEMPLATE_MAX_CHARS)} characters (${"%,d".format(text.length)} now)"
                else "${"%,d".format(text.length)} / ${"%,d".format(SettingLimits.TEMPLATE_MAX_CHARS)}",
                Modifier.testTag("count-${field.key}"),
            )
        },
        textStyle = MaterialTheme.roles.code,
    )
    Row(Modifier.padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box {
            TextButton(onClick = trackedClick("settings.journal.placeholder-menu") { placing = true }, enabled = enabled, modifier = Modifier.testTag("placeholder-${field.key}")) { Text("+ Placeholder") }
            DropdownMenu(expanded = placing, onDismissRequest = { placing = false }) {
                for ((placeholder, example) in PLACEHOLDERS) {
                    DropdownMenuItem(
                        text = { Text("$placeholder  $example") },
                        onClick = trackedClick("settings.journal.placeholder") {
                            placing = false
                            // At the cursor, or over the selection.
                            val at = draft.selection
                            val next = draft.text.replaceRange(at.min, at.max, placeholder)
                            draft = TextFieldValue(next, TextRange(at.min + placeholder.length))
                            typed = true
                            status = null
                        },
                        modifier = Modifier.testTag("insert-$placeholder"),
                    )
                }
            }
        }
        TextButton(
            onClick = trackedClick("settings.journal.template-reset") {
                typed = false
                onSave(field.key, null)
                status = "Back to the Default"
            },
            enabled = enabled && field.custom,
            modifier = Modifier.testTag("reset-${field.key}"),
        ) { Text("Use the Default") }
        Spacer(Modifier.weight(1f))
        status?.let {
            Text(
                if (it == "Saved") "✓ Saved" else it,
                Modifier.padding(end = 8.dp).testTag("templateStatus").semantics { liveRegion = LiveRegionMode.Polite; contentDescription = it },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.roles.body,
            )
        }
    }
}
