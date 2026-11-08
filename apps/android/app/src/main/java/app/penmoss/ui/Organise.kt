package app.penmoss.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.engine.notes.Tags

/**
 * Where a note goes (T38): the top level and every folder, nested as the tree is. [current]
 * is marked: where the note is now when moving it, or where a new note goes by default. Each row
 * is a choice; picking one closes the sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderPickerSheet(
    title: String,
    choices: List<FolderChoice>,
    current: String?,
    onPick: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Text(
            title,
            Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
            style = MaterialTheme.typography.titleMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        LazyColumn(Modifier.fillMaxWidth().testTag("folderPicker"), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
            // Grouped by notebook once there are notebooks (T43, A750): each group under its name.
            choices.forEachIndexed { at, choice ->
                if (choice.group != null && choices.getOrNull(at - 1)?.group != choice.group) {
                    item(key = "group:$at", contentType = "group") { SectionTitle(choice.group, Modifier.testTag("folderGroup:${choice.group}")) }
                }
                item(key = choice.id ?: "", contentType = "choice") {
                    FolderChoiceRow(choice, chosen = choice.id == current, onPick = onPick)
                }
            }
        }
    }
}

/** Deeper folders are indented no further, so a deep tree keeps room for the name. */
private const val MAX_INDENT_LEVELS = 6

@Composable
private fun FolderChoiceRow(choice: FolderChoice, chosen: Boolean, onPick: (String?) -> Unit) {
    val top = choice.id == null
    val indent = if (top) 0 else minOf(choice.depth + 1, MAX_INDENT_LEVELS)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .semantics {
                selected = chosen
                // Two folders of the same name are told apart by their parent.
                choice.parent?.let { stateDescription = "in ${it}" }
            }
            .clickable(role = Role.Button, onClickLabel = "Choose") { onPick(choice.id) }
            .padding(start = 24.dp + 20.dp * indent, end = 24.dp)
            .testTag("folderChoice:${choice.id ?: "top"}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            when {
                top -> Icons.Default.Home
                choice.notebook -> NotebookIcon
                else -> FolderIcon
            },
            contentDescription = null,
            Modifier.size(20.dp),
            tint = MaterialTheme.colorScheme.primary,
        )
        Text(
            choice.name,
            Modifier.weight(1f),
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        // Shown, not announced: the row says it is selected.
        if (chosen) Icon(Icons.Default.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
    }
}

/**
 * The open note's tags (T38), as the web shows them under the title: its frontmatter tags,
 * each removable, and a field to add one with suggestions from the workspace's tags. Inline
 * `#tags` stay in the text, as on the web (A188). [tags] is null until the editor has read them;
 * a note that cannot be changed here shows its tags only.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun TagSheet(
    tags: List<String>?,
    editable: Boolean,
    known: List<Pair<String, Int>>,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var typed by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val add = { raw: String ->
        val tag = Tags.normalise(raw)
        if (tag == null) {
            error = Tags.INVALID
        } else {
            onAdd(tag)
            typed = ""
            error = null
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).navigationBarsPadding().imePadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Tags", style = MaterialTheme.typography.titleMedium)
            when {
                tags == null -> Text("Opening the note…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                tags.isEmpty() -> Text("No tags yet.", Modifier.testTag("noTags"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> FlowRow(Modifier.testTag("noteTags"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (tag in tags) {
                        // A tag longer than the phone sends (set on the web, which has no limit) is
                        // shown but cannot be removed here (A361).
                        if (editable && tag.length <= Tags.MAX_CHARS) {
                            // The whole chip removes the tag: one target, at the chip's full size.
                            InputChip(
                                selected = false,
                                onClick = { onRemove(tag) },
                                label = { Text("#$tag", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                trailingIcon = { Icon(Icons.Default.Close, contentDescription = null, Modifier.size(InputChipDefaults.IconSize)) },
                                modifier = Modifier
                                    .semantics { onClick(label = "Remove the Tag") { onRemove(tag); true } }
                                    .testTag("tag:$tag"),
                            )
                        } else {
                            TagPill(tag)
                        }
                    }
                }
            }
            if (!editable) {
                Text(
                    "This note can't be changed here, so its tags can't either.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                return@Column
            }
            if (tags == null) return@Column
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = typed,
                    onValueChange = {
                        typed = it
                        error = null
                    },
                    modifier = Modifier.weight(1f).testTag("tagField"),
                    label = { Text("Add a tag") },
                    placeholder = { Text("tag or area/tag") },
                    singleLine = true,
                    isError = error != null,
                    supportingText = error.let { message -> if (message == null) null else { { Text(message, Modifier.testTag("tagError")) } } },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (typed.isNotBlank()) add(typed) }),
                )
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = { add(typed) }, enabled = typed.isNotBlank()) { Text("Add") }
            }
            val suggestions = remember(typed, known, tags) { Tags.suggest(typed, known, tags) }
            if (suggestions.isNotEmpty()) {
                FlowRow(Modifier.testTag("tagSuggestions"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (name in suggestions) {
                        SuggestionChip(onClick = { add(name) }, label = { Text("#$name") }, modifier = Modifier.testTag("suggestion:$name"))
                    }
                }
            }
            Text(
                "Tags written in the text as #tag stay in the text.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A tag shown, not changed: plain text in the chip's outline, with nothing to press. */
@Composable
private fun TagPill(tag: String) {
    Text(
        "#$tag",
        Modifier
            .heightIn(min = 32.dp)
            .border(1.dp, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.small)
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag("tag:$tag"),
        style = MaterialTheme.typography.labelLarge,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}
