package app.penmoss.feedback

import androidx.compose.foundation.BorderStroke
import app.penmoss.ui.square.SQUARE
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.square.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/*
 * The Send feedback form on Android (T49, D41, A790, A800): native fields, a markdown toolbar
 * with a preview (the phone may hold only one editor WebView, A418), screenshots, and the
 * captured context exactly as it will be sent, each group with a checkbox to leave it out.
 */

/** Everything the form shows. */
data class FeedbackUi(
    val draft: FeedbackDraft,
    val context: FeedbackContextData,
    val phase: FeedbackFormModel.Phase = FeedbackFormModel.Phase.Editing,
    val showProblems: Boolean = false,
    val notice: String? = null,
    /** This opening's capture of the screen behind, offered unticked (A801); null when none. */
    val capture: File? = null,
    val capturing: Boolean = false,
    /** The draft's screenshot that is this opening's capture, while ticked. */
    val captureFile: String? = null,
) {
    /** What is sent: the context without the groups left out. The preview shows exactly this. */
    val sent: FeedbackContextData get() = context.without(draft.omitted.toSet())
}

/** What the form does. */
class FeedbackActions(
    val close: () -> Unit = {},
    val send: () -> Unit = {},
    val type: (FeedbackType) -> Unit = {},
    val priority: (Int) -> Unit = {},
    val title: (String) -> Unit = {},
    val description: (String) -> Unit = {},
    val pickImages: () -> Unit = {},
    val capture: (Boolean) -> Unit = {},
    val remove: (Int) -> Unit = {},
    val move: (Int, Int) -> Unit = { _, _ -> },
    val omit: (String, Boolean) -> Unit = { _, _ -> },
    val discard: () -> Unit = {},
    val dismissNotice: () -> Unit = {},
    /** A small picture of a screenshot file, off the main thread. */
    val thumbnail: suspend (File) -> ImageBitmap? = { file -> withContext(Dispatchers.IO) { FeedbackImages.thumbnail(file)?.asImageBitmap() } },
    /** A screenshot's file by its name in the draft. */
    val image: (String) -> File = { File(it) },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedbackScreen(ui: FeedbackUi, actions: FeedbackActions) {
    val problems = if (ui.showProblems) FeedbackValidation.problems(ui.draft) else emptyList()
    fun problem(field: FeedbackValidation.Field) = problems.firstOrNull { it.field == field }?.message
    val editing = ui.phase == FeedbackFormModel.Phase.Editing
    var discarding by rememberSaveable { mutableStateOf(false) }
    Scaffold(
        modifier = Modifier.imePadding(),
        topBar = {
            TopAppBar(
                title = { Text("Send Feedback") },
                navigationIcon = {
                    IconButton(onClick = actions.close, modifier = Modifier.testTag("feedbackClose")) { Icon(Icons.Default.Close, contentDescription = "Close") }
                },
                actions = {
                    TextButton(onClick = actions.send, enabled = editing, modifier = Modifier.testTag("feedbackSend")) { Text("Send") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp).testTag("feedbackForm"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Status(ui, actions)
            FeedbackValidation.summary(problems)?.let {
                Text(
                    it,
                    Modifier.semantics { liveRegion = LiveRegionMode.Assertive }.testTag("feedbackProblems"),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Label("Type")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().testTag("feedbackType")) {
                FeedbackType.entries.forEachIndexed { index, type ->
                    SegmentedButton(
                        selected = ui.draft.type == type.wire,
                        onClick = { actions.type(type) },
                        enabled = editing,
                        shape = SegmentedButtonDefaults.itemShape(index, FeedbackType.entries.size, SQUARE),
                        modifier = Modifier.testTag("type-${type.wire}"),
                    ) { Text(type.label) }
                }
            }
            FieldError(problem(FeedbackValidation.Field.TYPE), "typeError")

            Label("Priority")
            Column(Modifier.selectableGroup().testTag("feedbackPriority")) {
                for (priority in FeedbackPriority.all) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .selectable(selected = ui.draft.priority == priority, enabled = editing, role = Role.RadioButton) { actions.priority(priority) }
                            .testTag("priority-$priority"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = ui.draft.priority == priority, onClick = null, enabled = editing)
                        Spacer(Modifier.width(12.dp))
                        Text(FeedbackPriority.label(priority))
                    }
                }
            }
            FieldError(problem(FeedbackValidation.Field.PRIORITY), "priorityError")

            val titleError = problem(FeedbackValidation.Field.TITLE)
            // The field's own text while typing; the model hears each change (see Description).
            var title by remember { mutableStateOf(ui.draft.title) }
            var titleSent by remember { mutableStateOf(ui.draft.title) }
            var titleSeen by remember { mutableStateOf(ui.draft.title) }
            if (ui.draft.title != titleSeen) {
                titleSeen = ui.draft.title
                if (ui.draft.title != titleSent) {
                    titleSent = ui.draft.title
                    title = ui.draft.title
                }
            }
            OutlinedTextField(
                value = title,
                onValueChange = {
                    val line = it.replace('\n', ' ')
                    title = line
                    titleSent = line
                    actions.title(line)
                },
                enabled = editing,
                label = { Text("Title") },
                singleLine = true,
                isError = titleError != null,
                supportingText = { Text(titleError ?: "${FeedbackValidation.title(title).length} of ${FeedbackLimits.TITLE_MAX}") },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth().testTag("feedbackTitle").semantics { if (titleError != null) error(titleError) },
            )

            Description(ui.draft.description, editing, problem(FeedbackValidation.Field.DESCRIPTION), actions.description)

            Screenshots(ui, actions, editing)

            CapturedContext(ui, actions, editing)

            if (editing) {
                OutlinedButton(onClick = { discarding = true }, modifier = Modifier.testTag("feedbackDiscard")) { Text("Discard Draft") }
            }
            Spacer(Modifier.size(24.dp))
        }
    }
    if (discarding) {
        AlertDialog(
            onDismissRequest = { discarding = false },
            title = { Text("Discard this draft?") },
            text = { Text("Its title, description and screenshots are deleted from this phone.") },
            confirmButton = {
                TextButton(onClick = {
                    discarding = false
                    actions.discard()
                }, modifier = Modifier.testTag("confirmDiscardDraft")) { Text("Discard", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { discarding = false }) { Text("Keep It") } },
        )
    }
}

@Composable
private fun Label(text: String) {
    Text(text, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun FieldError(message: String?, tag: String) {
    if (message == null) return
    Text(message, Modifier.testTag(tag), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
}

/** Sending, queued or refused: said at the top and read out (A796). */
@Composable
private fun Status(ui: FeedbackUi, actions: FeedbackActions) {
    val (text, error) = when (val phase = ui.phase) {
        FeedbackFormModel.Phase.Editing -> (ui.notice to true)
        FeedbackFormModel.Phase.Sending -> ("Sending…" to false)
        FeedbackFormModel.Phase.Sent -> ("Sent" to false)
        is FeedbackFormModel.Phase.Queued -> (phase.message to false)
        is FeedbackFormModel.Phase.Failed -> (phase.message to true)
    }
    if (ui.phase == FeedbackFormModel.Phase.Sending) LinearProgressIndicator(Modifier.fillMaxWidth().testTag("feedbackSending"))
    text ?: return
    Surface(
        color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
        shape = RectangleShape,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text,
                Modifier.weight(1f).padding(vertical = 12.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("feedbackStatus"),
                style = MaterialTheme.typography.bodyMedium,
            )
            when (ui.phase) {
                FeedbackFormModel.Phase.Editing -> TextButton(onClick = actions.dismissNotice) { Text("OK") }
                is FeedbackFormModel.Phase.Queued, is FeedbackFormModel.Phase.Failed ->
                    TextButton(onClick = actions.close, modifier = Modifier.testTag("feedbackDone")) { Text("Close") }
                else -> Unit
            }
        }
    }
}

/** A toolbar button: its label drawn, its name for TalkBack, a 48 dp target. */
@Composable
private fun ToolButton(label: AnnotatedString, name: String, enabled: Boolean, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = name }.testTag("tool-$name"),
    ) { Text(label, fontFamily = FontFamily.Monospace) }
}

@Composable
private fun Description(description: String, editing: Boolean, problem: String?, onChange: (String) -> Unit) {
    var value by remember { mutableStateOf(TextFieldValue(description)) }
    // The text is the field's own while typing; only a change from outside (a draft loaded
    // later) replaces it, the caret at its end.
    var emitted by remember { mutableStateOf(description) }
    var seen by remember { mutableStateOf(description) }
    if (description != seen) {
        seen = description
        if (description != emitted) {
            emitted = description
            value = TextFieldValue(description, TextRange(description.length))
        }
    }
    fun changed(text: String) {
        emitted = text
        onChange(text)
    }
    var previewing by rememberSaveable { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    fun apply(change: (MarkdownToolbar.Edit) -> MarkdownToolbar.Edit) {
        val start = minOf(value.selection.start, value.selection.end).coerceIn(0, value.text.length)
        val end = maxOf(value.selection.start, value.selection.end).coerceIn(0, value.text.length)
        val next = change(MarkdownToolbar.Edit(value.text, start, end))
        value = TextFieldValue(next.text, TextRange(next.start, next.end))
        changed(next.text)
        runCatching { focus.requestFocus() }
    }
    Label("Description")
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        listOf("Write" to false, "Preview" to true).forEachIndexed { index, (label, preview) ->
            SegmentedButton(
                selected = previewing == preview,
                onClick = { previewing = preview },
                shape = SegmentedButtonDefaults.itemShape(index, 2, SQUARE),
                modifier = Modifier.testTag(if (preview) "descriptionPreview" else "descriptionWrite"),
            ) { Text(label) }
        }
    }
    if (previewing) {
        MarkdownPreviewView(description, Modifier.fillMaxWidth().heightIn(min = 120.dp).testTag("descriptionRendered"))
        return
    }
    val tools = editing
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).testTag("markdownToolbar")) {
        ToolButton(buildAnnotatedString { pushStyle(SpanStyle(fontWeight = FontWeight.Bold)); append("B") }, "Bold", tools) { apply(MarkdownToolbar::bold) }
        ToolButton(buildAnnotatedString { pushStyle(SpanStyle(fontStyle = FontStyle.Italic)); append("I") }, "Italic", tools) { apply(MarkdownToolbar::italic) }
        ToolButton(AnnotatedString("•"), "Bulleted List", tools) { apply(MarkdownToolbar::bullets) }
        ToolButton(AnnotatedString("1."), "Numbered List", tools) { apply(MarkdownToolbar::numbered) }
        ToolButton(AnnotatedString("⇥"), "Indent", tools) { apply(MarkdownToolbar::indent) }
        ToolButton(AnnotatedString("⇤"), "Outdent", tools) { apply(MarkdownToolbar::outdent) }
        ToolButton(AnnotatedString("🔗"), "Link", tools) { apply(MarkdownToolbar::link) }
        ToolButton(AnnotatedString("<>"), "Inline Code", tools) { apply(MarkdownToolbar::code) }
        ToolButton(AnnotatedString("{ }"), "Code Block", tools) { apply(MarkdownToolbar::codeBlock) }
        ToolButton(AnnotatedString("❝"), "Quote", tools) { apply(MarkdownToolbar::quote) }
    }
    OutlinedTextField(
        value = value,
        onValueChange = {
            value = it
            if (it.text != emitted) changed(it.text)
        },
        enabled = editing,
        label = { Text("What happened, or what you'd like") },
        minLines = 6,
        isError = problem != null,
        supportingText = problem?.let { { Text(it) } } ?: { Text("Markdown: bold, italic, lists, links, code and quotes") },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("feedbackDescription").semantics { if (problem != null) error(problem) },
    )
}

/** The description as GitHub will show it, drawn natively ([MarkdownPreview]). */
@Composable
internal fun MarkdownPreviewView(markdown: String, modifier: Modifier = Modifier) {
    val blocks = remember(markdown) { MarkdownPreview.blocks(markdown) }
    val outline = MaterialTheme.colorScheme.outlineVariant
    Column(modifier.border(BorderStroke(1.dp, outline), RectangleShape).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (blocks.isEmpty()) Text("Nothing to preview", color = MaterialTheme.colorScheme.onSurfaceVariant)
        val codeBackground = MaterialTheme.colorScheme.surfaceVariant
        val link = MaterialTheme.colorScheme.primary
        fun text(runs: List<MarkdownPreview.Run>) = buildAnnotatedString {
            for (run in runs) {
                val style = SpanStyle(
                    fontWeight = if (run.bold) FontWeight.Bold else null,
                    fontStyle = if (run.italic) FontStyle.Italic else null,
                    fontFamily = if (run.code) FontFamily.Monospace else null,
                    background = if (run.code) codeBackground else androidx.compose.ui.graphics.Color.Unspecified,
                )
                if (run.url != null) {
                    pushLink(LinkAnnotation.Url(run.url, TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline))))
                    withStyleRun(style) { append(run.text) }
                    pop()
                } else {
                    withStyleRun(style) { append(run.text) }
                }
            }
        }
        for (block in blocks) {
            when (block) {
                is MarkdownPreview.Block.Paragraph -> Text(text(block.runs), style = MaterialTheme.typography.bodyMedium)
                is MarkdownPreview.Block.Heading -> Text(
                    text(block.runs),
                    Modifier.semantics { heading() },
                    style = if (block.level <= 2) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleSmall,
                )
                is MarkdownPreview.Block.Item -> Row(Modifier.padding(start = (16 * block.depth).dp)) {
                    Text(block.marker, Modifier.width(24.dp), style = MaterialTheme.typography.bodyMedium)
                    Text(text(block.runs), style = MaterialTheme.typography.bodyMedium)
                }
                is MarkdownPreview.Block.Quote -> Row {
                    Box(Modifier.width(3.dp).heightIn(min = 20.dp).background(outline))
                    Text(text(block.runs), Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                is MarkdownPreview.Block.Code -> Text(
                    block.text,
                    Modifier.fillMaxWidth().background(codeBackground, RectangleShape).padding(8.dp),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

private inline fun AnnotatedString.Builder.withStyleRun(style: SpanStyle, block: AnnotatedString.Builder.() -> Unit) {
    pushStyle(style)
    block()
    pop()
}

@Composable
private fun Screenshots(ui: FeedbackUi, actions: FeedbackActions, editing: Boolean) {
    val shots = ui.draft.screenshots
    Label("Screenshots (${shots.size} of ${FeedbackLimits.SCREENSHOTS})")
    Text(
        "PNG, JPEG, WebP or GIF, up to 10 MB each. They're made smaller before they're sent.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (ui.capture != null || ui.capturing) {
        val ticked = ui.captureFile != null
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp)
                .toggleable(value = ticked, enabled = editing && ui.capture != null, role = Role.Checkbox) { actions.capture(it) }
                .testTag("feedbackCapture"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = ticked, onCheckedChange = null, enabled = editing && ui.capture != null)
            Spacer(Modifier.width(8.dp))
            Text(if (ui.capturing) "Capturing the screen behind…" else "Add a screenshot of the screen behind", Modifier.weight(1f))
            ui.capture?.let { Thumbnail(it, actions, "") }
        }
    }
    shots.forEachIndexed { index, shot ->
        val n = index + 1
        Row(Modifier.fillMaxWidth().testTag("screenshot-$n"), verticalAlignment = Alignment.CenterVertically) {
            Thumbnail(actions.image(shot.file), actions, "Screenshot $n${if (shot.capture) ", the screen behind" else ""}")
            Spacer(Modifier.width(8.dp))
            Text("Screenshot $n", Modifier.weight(1f))
            IconButton(onClick = { actions.move(index, -1) }, enabled = editing && index > 0) {
                Icon(Icons.Default.KeyboardArrowUp, contentDescription = "Move screenshot $n up")
            }
            IconButton(onClick = { actions.move(index, 1) }, enabled = editing && index < shots.size - 1) {
                Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Move screenshot $n down")
            }
            IconButton(onClick = { actions.remove(index) }, enabled = editing) {
                Icon(Icons.Default.Delete, contentDescription = "Remove screenshot $n")
            }
        }
    }
    OutlinedButton(
        onClick = actions.pickImages,
        enabled = editing && shots.size < FeedbackLimits.SCREENSHOTS,
        modifier = Modifier.testTag("feedbackAddImages"),
    ) { Text("Add from Photos") }
}

@Composable
private fun Thumbnail(file: File, actions: FeedbackActions, description: String) {
    val bitmap by produceState<ImageBitmap?>(null, file) { value = actions.thumbnail(file) }
    Box(Modifier.size(56.dp).background(MaterialTheme.colorScheme.surfaceVariant, RectangleShape)) {
        bitmap?.let {
            Image(it, contentDescription = description.ifEmpty { null }, contentScale = ContentScale.Crop, modifier = Modifier.size(56.dp))
        }
    }
}

/** The captured context exactly as it will be sent (A791), each group with a checkbox to leave it out. */
@Composable
private fun CapturedContext(ui: FeedbackUi, actions: FeedbackActions, editing: Boolean) {
    var open by rememberSaveable { mutableStateOf(false) }
    HorizontalDivider()
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .toggleable(value = open, role = Role.Button) { open = it }
            .semantics { stateDescription = if (open) "Shown" else "Hidden" }
            .testTag("contextToggle"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Captured context", Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
        Icon(if (open) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown, contentDescription = null)
    }
    Text(
        "Where you are and the note's details, never its text. This is exactly what's sent; untick a group to leave it out.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (!open) return
    for (group in ui.context.groups) {
        val included = group.id !in ui.draft.omitted
        val title = group.group?.title ?: group.id
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .toggleable(value = included, enabled = editing, role = Role.Checkbox) { actions.omit(group.id, !it) }
                .testTag("group-${group.id}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = included, onCheckedChange = null, enabled = editing)
            Spacer(Modifier.width(8.dp))
            Text("Include $title")
        }
    }
    val markdown = FeedbackMarkdown.context(ui.sent)
    SelectionContainer {
        Text(
            markdown.ifEmpty { "Nothing: every group is left out." },
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RectangleShape).padding(8.dp).testTag("contextMarkdown"),
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
