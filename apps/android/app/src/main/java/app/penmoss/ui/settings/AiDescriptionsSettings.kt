package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.ai.AiKeyState
import app.penmoss.ai.AiKeys
import app.penmoss.ai.AiResult
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.FilledTonalButton
import app.penmoss.ui.common.OutlinedButton
import app.penmoss.ui.common.OutlinedTextField
import app.penmoss.ui.common.TextButton
import app.penmoss.ui.common.roles
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/*
 * Settings → AI Descriptions on the phone (PEN-161 T6, A1656): the Mac's page (`AiDescriptionsSettings`)
 * with what the phone has. Describe Notes, Describe a Note and After a Pause Of are synced, as on
 * the Mac; the AI Provider is this phone's own: Not Set Up, or Anthropic with a key kept on this
 * phone, encrypted. Claude Code is the Mac's alone.
 */

/** The prompt sent for each note when none is set (core's `DEFAULT_PROMPT`; `contract/ai-descriptions-v1.json`). */
const val DEFAULT_AI_PROMPT =
    "Write a description of this note for an AI agent deciding whether to read it.\n\n" +
        "One or two plain sentences, at most 40 words. Say what the note is about and what it holds " +
        "(decisions, lists, plans, code, references). No preamble, no quotes, no markdown, and don't start with \"This note\".\n\n" +
        "Title: {{title}}\nTags: {{tags}}\nFolder: {{folder}}\n\n{{body}}"

/** The tokens a prompt can use, in the order Settings offers them (core's `PROMPT_TOKENS`). */
val AI_PROMPT_TOKENS = listOf("{{title}}", "{{body}}", "{{tags}}", "{{folder}}", "{{notebook}}", "{{description}}", "{{date}}")

private val PAUSE_LABELS = mapOf(30 to "30 Seconds", 60 to "1 Minute", 120 to "2 Minutes", 300 to "5 Minutes", 600 to "10 Minutes")

/** What the Settings list says of AI Descriptions. */
fun aiSummary(values: JsonObject, ready: Boolean): String {
    val on = (values[AiKeys.GLOBAL] as? JsonPrimitive)?.booleanOrNull == true
    return when {
        !ready -> if (on) "On · No Provider on This Phone" else "Off"
        on -> "On · Anthropic"
        else -> "Off"
    }
}

@Composable
internal fun AiDescriptionsRoute(host: SettingsHost, onBack: () -> Unit) {
    val graph = host.device
    val state by graph.settings.collectAsStateWithLifecycle()
    val ai = graph.aiDescriptions
    val key by ai.key.collectAsStateWithLifecycle()
    val values = state.settings.values
    val text = { name: String -> (values[name] as? JsonPrimitive)?.contentOrNull }
    val scope = rememberCoroutineScope()
    AiDescriptionsScreen(
        enabled = state.known,
        global = (values[AiKeys.GLOBAL] as? JsonPrimitive)?.booleanOrNull == true,
        whenToDescribe = if (text(AiKeys.WHEN) == "sync") "sync" else "pause",
        pauseS = (values[AiKeys.PAUSE] as? JsonPrimitive)?.intOrNull?.takeIf { it in AiKeys.PAUSES } ?: AiKeys.DEFAULT_PAUSE,
        provider = ai.provider,
        key = key,
        model = ai.model,
        prompt = text(AiKeys.PROMPT),
        onGlobal = { graph.changeSetting(AiKeys.GLOBAL, JsonPrimitive(it)) },
        onWhen = { graph.changeSetting(AiKeys.WHEN, JsonPrimitive(it)) },
        onPause = { graph.changeSetting(AiKeys.PAUSE, JsonPrimitive(it)) },
        onProvider = { graph.changeSetting(AiKeys.PROVIDER, if (it == AiKeys.NONE) null else JsonPrimitive(it)) },
        onModel = { graph.changeSetting(AiKeys.MODEL, JsonPrimitive(it)) },
        onPrompt = { graph.changeSetting(AiKeys.PROMPT, if (it == DEFAULT_AI_PROMPT) null else JsonPrimitive(it)) },
        onSaveKey = { typed, done -> scope.launch { done(ai.saveKey(typed)) } },
        onTestKey = { done -> scope.launch { done(ai.testKey()) } },
        onRemoveKey = ai::removeKey,
        onDescribeAll = { describeAllNotes(graph.gitIfAny) },
        onBack = onBack,
    )
}

/**
 * Describe All Notes (Settings → AI Descriptions): each notebook's Describe Notes Now, one after
 * another. How many notes go in all, or null when no notebook could start.
 */
internal suspend fun describeAllNotes(hub: app.penmoss.git.GitNotebookHub?): Int? {
    hub ?: return null
    val counts = hub.list.value.map { view -> runCatching { hub.graph(view.localId).api.describeAll(null) }.getOrNull() }
    return if (counts.isNotEmpty() && counts.all { it == null }) null else counts.sumOf { it ?: 0 }
}

/** What Describe All Notes says once it has started: how many go, or why none. */
fun describeAllWords(count: Int?): String = when (count) {
    null -> "Couldn’t start describing. Try again once a notebook is open."
    0 -> "Nothing to describe: every note that’s On has a description."
    1 -> "Describing 1 note in the background."
    else -> "Describing $count notes in the background."
}

/**
 * Settings → AI Descriptions (PEN-161): Describe Notes (On or Off), Describe a Note (After a Pause
 * or At Sync), After a Pause Of, Describe All Notes, then this phone's AI Provider with its key,
 * the model, and the prompt with its tokens and Reset to Default.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AiDescriptionsScreen(
    enabled: Boolean,
    global: Boolean,
    whenToDescribe: String,
    pauseS: Int,
    provider: String,
    key: AiKeyState,
    model: String,
    prompt: String?,
    onGlobal: (Boolean) -> Unit,
    onWhen: (String) -> Unit,
    onPause: (Int) -> Unit,
    onProvider: (String) -> Unit,
    onModel: (String) -> Unit,
    onPrompt: (String) -> Unit,
    onSaveKey: (String, (AiResult) -> Unit) -> Unit,
    onTestKey: ((AiResult) -> Unit) -> Unit,
    onRemoveKey: () -> Unit,
    onDescribeAll: suspend () -> Int?,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var describeSaid by remember { mutableStateOf<String?>(null) }
    var describing by remember { mutableStateOf(false) }
    SectionScreen("AI Descriptions", onBack, notice = if (enabled) null else SETTINGS_WAIT) {
        Text("Describe Notes", Modifier.settingRow("describe-notes").padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.bodyLarge)
        Segments(listOf("on" to "On", "off" to "Off"), if (global) "on" else "off", enabled, "aiGlobal", event = "settings.ai.global") { onGlobal(it == "on") }
        Help(
            if (global) {
                "Every notebook describes its notes, unless a notebook, folder or note says Off."
            } else {
                "Nothing is described unless a notebook, folder or note says On."
            },
        )
        Text("Describe a Note", Modifier.settingRow("describe-a-note").padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp), style = MaterialTheme.typography.bodyLarge)
        Segments(listOf("pause" to "After a Pause", "sync" to "At Sync"), whenToDescribe, enabled, "aiWhen", event = "settings.ai.when", onChoose = onWhen)
        Help(if (whenToDescribe == "sync") "Once the notebook has synced." else "Once you stop changing it for a while.")
        if (whenToDescribe == "pause") {
            GroupTitle("After a Pause Of", Modifier.settingRow("pause"))
            Column(Modifier.selectableGroup()) {
                for (seconds in AiKeys.PAUSES) {
                    ChoiceRow(PAUSE_LABELS.getValue(seconds), null, pauseS == seconds, enabled, "aiPause-$seconds", event = "settings.ai.pause") { onPause(seconds) }
                }
            }
        }
        Text("Describe All Notes", Modifier.settingRow("describe-all-notes").padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp), style = MaterialTheme.typography.bodyLarge)
        Help(
            if (provider == AiKeys.NONE) {
                "Pick an AI provider below first."
            } else {
                "Every notebook’s notes with no description, or changed since theirs, now. Notes set to Off are left out."
            },
        )
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            OutlinedButton(
                onClick = trackedClick("settings.ai.describe-all") {
                    describing = true
                    describeSaid = null
                    scope.launch {
                        describeSaid = describeAllWords(onDescribeAll())
                        describing = false
                    }
                },
                enabled = enabled && !describing && provider != AiKeys.NONE,
                modifier = Modifier.testTag("aiDescribeAll"),
            ) { Text("Describe Notes Now") }
        }
        describeSaid?.let {
            Text(
                it,
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("aiDescribeAllSaid"),
                style = MaterialTheme.roles.help,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        GroupTitle("AI Provider", Modifier.settingRow("ai-provider"), deviceOnly = true)
        Column(Modifier.selectableGroup()) {
            ChoiceRow("Not Set Up", "Nothing is sent from this phone", provider == AiKeys.NONE, true, "aiProvider-none", event = "settings.ai.provider") { onProvider(AiKeys.NONE) }
            ChoiceRow("Anthropic (API Key)", "Calls go straight to Anthropic and are billed to the key", provider == AiKeys.ANTHROPIC, true, "aiProvider-anthropic", event = "settings.ai.provider") { onProvider(AiKeys.ANTHROPIC) }
        }
        if (provider == AiKeys.NONE) {
            Help("Not set up: nothing is sent. Your Mac describes this phone’s notes after they sync, when it is set up there. Claude Code is on the Mac only.", Modifier.testTag("aiVia"))
        } else {
            AnthropicKey(key, onSaveKey, onTestKey, onRemoveKey)
            GroupTitle("Model", Modifier.settingRow("model"))
            Column(Modifier.selectableGroup()) {
                AiKeys.MODELS.forEachIndexed { index, (id, label) ->
                    ChoiceRow(if (index == 0) "$label (Fastest)" else label, null, model == id, enabled, "aiModel-$id", event = "settings.ai.model") { onModel(id) }
                }
            }
        }

        GroupTitle("Prompt", Modifier.settingRow("prompt"))
        PromptEditor(prompt ?: DEFAULT_AI_PROMPT, prompt != null, enabled, onPrompt)
    }
}

/** The key: typed, checked with Anthropic and saved; once saved, Test Key and Remove. */
@Composable
private fun AnthropicKey(
    key: AiKeyState,
    onSave: (String, (AiResult) -> Unit) -> Unit,
    onTest: ((AiResult) -> Unit) -> Unit,
    onRemove: () -> Unit,
) {
    var typed by rememberSaveable { mutableStateOf("") }
    var shown by rememberSaveable { mutableStateOf(false) }
    var said by remember { mutableStateOf<AiResult?>(null) }
    var busy by remember { mutableStateOf(false) }
    val words = { result: AiResult? ->
        when (result) {
            is AiResult.Text -> result.text
            is AiResult.Failed -> result.message
            null -> null
        }
    }
    Text("Anthropic API Key", Modifier.settingRow("anthropic-api-key").padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp), style = MaterialTheme.typography.bodyLarge)
    if (key.saved) {
        Help(if (key.refused) "Anthropic refused this key. Remove it and save another." else "Saved on this phone, encrypted. It is never synced or shown again.")
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = trackedClick("settings.ai.test") {
                    busy = true
                    said = null
                    onTest { result ->
                        busy = false
                        said = result
                    }
                },
                enabled = !busy,
                modifier = Modifier.testTag("aiTestKey"),
            ) { Text("Test Key") }
            TextButton(onClick = trackedClick("settings.ai.remove-key") { onRemove(); said = null }, modifier = Modifier.testTag("aiRemoveKey")) { Text("Remove") }
        }
    } else {
        OutlinedTextField(
            value = typed,
            onValueChange = { typed = it },
            placeholder = { Text("sk-ant-…") },
            singleLine = true,
            visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("aiKey"),
        )
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = trackedClick("settings.ai.show-key") { shown = !shown }, modifier = Modifier.testTag("aiShowKey")) { Text(if (shown) "Hide" else "Show") }
            FilledTonalButton(
                onClick = trackedClick("settings.ai.save-key") {
                    busy = true
                    said = null
                    onSave(typed) { result ->
                        busy = false
                        said = result
                        if (result is AiResult.Text) typed = ""
                    }
                },
                enabled = !busy && typed.isNotBlank(),
                modifier = Modifier.testTag("aiSaveKey"),
            ) { Text("Save") }
        }
        Help("Penmoss checks it with Anthropic first. It stays on this phone, encrypted.")
    }
    val message = if (busy) "Checking…" else words(said)
    if (message != null) {
        Text(
            message,
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("aiKeyResult"),
            style = MaterialTheme.roles.help,
            color = if (said is AiResult.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The prompt: its tokens inserted at the cursor, Save, and Reset to Default. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PromptEditor(prompt: String, custom: Boolean, enabled: Boolean, onSave: (String) -> Unit) {
    var draft by remember(prompt) { mutableStateOf(TextFieldValue(prompt, TextRange(prompt.length))) }
    Help("Sent for each note. The tokens are replaced with the note’s own.")
    OutlinedTextField(
        value = draft,
        onValueChange = { draft = it },
        enabled = enabled,
        textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp).padding(horizontal = 16.dp, vertical = 4.dp).testTag("aiPrompt"),
    )
    FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (token in AI_PROMPT_TOKENS) {
            TextButton(
                onClick = trackedClick("settings.ai.token") {
                    val text = draft.text
                    val at = draft.selection.end.coerceIn(0, text.length)
                    val next = text.substring(0, at) + token + text.substring(at)
                    draft = TextFieldValue(next, TextRange(at + token.length))
                },
                enabled = enabled,
                modifier = Modifier.testTag("aiToken-${token.trim('{', '}')}"),
            ) { Text(token, fontFamily = FontFamily.Monospace) }
        }
    }
    if ("{{body}}" !in draft.text) {
        Text(
            "This prompt has no {{body}}, so the model can’t see the note’s text.",
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("aiPromptWarning"),
            style = MaterialTheme.roles.help,
            color = MaterialTheme.colorScheme.error,
        )
    }
    Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilledTonalButton(
            onClick = trackedClick("settings.ai.save-prompt") { onSave(draft.text) },
            enabled = enabled && draft.text != prompt && draft.text.isNotBlank(),
            modifier = Modifier.testTag("aiPromptSave"),
        ) { Text("Save Prompt") }
        TextButton(
            onClick = trackedClick("settings.ai.reset-prompt") { onSave(DEFAULT_AI_PROMPT) },
            enabled = enabled && custom,
            modifier = Modifier.testTag("aiPromptReset"),
        ) { Text("Reset to Default") }
    }
}
