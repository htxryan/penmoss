package app.penmoss.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Material's folder icon (Apache 2.0); the core icon set has none. */
val FolderIcon: ImageVector by lazy {
    ImageVector.Builder("Folder", 24.dp, 24.dp, 24f, 24f).apply {
        path(fill = SolidColor(androidx.compose.ui.graphics.Color.Black)) {
            moveTo(10f, 4f)
            horizontalLineTo(4f)
            curveToRelative(-1.1f, 0f, -2f, 0.9f, -2f, 2f)
            verticalLineToRelative(12f)
            curveToRelative(0f, 1.1f, 0.9f, 2f, 2f, 2f)
            horizontalLineToRelative(16f)
            curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f)
            verticalLineTo(8f)
            curveToRelative(0f, -1.1f, -0.9f, -2f, -2f, -2f)
            horizontalLineToRelative(-8f)
            lineToRelative(-2f, -2f)
            close()
        }
    }.build()
}

/**
 * One note in a list: title, first line, date. Plain Text, no per-row state. A long press
 * ([onLongPress], T38) offers what can be done with it: in a list that takes part in selection
 * mode ([selectable], with a [LocalNoteSelection]; T42 on Android, A652), it starts selection
 * mode, where a tap adds or takes out the note; elsewhere the list's own long press, never
 * "Select" (#137, A658).
 */
@Composable
fun NoteRowView(
    item: NoteItem,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
    onLongPress: ((NoteItem) -> Unit)? = null,
    /** Where a search matched in [NoteItem.excerpt]: shown bold, on two lines so the match is seen (T39). */
    matches: List<IntRange> = emptyList(),
    /** Whether this row's list takes part in selection mode: opted into, never by being in the app (#137). */
    selectable: Boolean = false,
) {
    val haptics = LocalHapticFeedback.current
    // Selection mode (T42 on Android, NT26, A652): only a list that takes part joins it (A658).
    val selection = LocalNoteSelection.current?.takeIf { selectable && onLongPress != null }
    val selecting = selection?.active == true
    val chosen = selecting && selection.contains(item.id)
    Row(
        modifier
            .fillMaxWidth()
            .then(if (chosen) Modifier.background(MaterialTheme.colorScheme.secondaryContainer) else Modifier)
            .then(
                if (selecting) {
                    // A tap adds or takes out the note; TalkBack reads a checkbox with its state.
                    Modifier.toggleable(value = chosen, role = Role.Checkbox) { selection.toggle(item) }
                } else {
                    Modifier.combinedClickable(
                        role = Role.Button,
                        onClickLabel = "Open",
                        onLongClickLabel = when {
                            onLongPress == null -> null
                            selection != null -> "Select"
                            else -> "Note Actions"
                        },
                        onLongClick = onLongPress?.let { press ->
                            {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                press(item)
                            }
                        },
                    ) { onOpen(item.id) }
                },
            )
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selecting) {
            Checkbox(checked = chosen, onCheckedChange = null, modifier = Modifier.padding(end = 12.dp).testTag("noteChosen:${item.id}"))
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.title,
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (item.date.isNotEmpty()) {
                    Spacer(Modifier.width(12.dp))
                    Text(item.date, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (item.excerpt.isNotEmpty()) {
                val strong = MaterialTheme.colorScheme.onSurface
                val excerpt = remember(item.excerpt, matches, strong) {
                    buildAnnotatedString {
                        append(item.excerpt)
                        for (match in matches) {
                            if (match.first < 0 || match.last >= item.excerpt.length) continue
                            addStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = strong), match.first, match.last + 1)
                        }
                    }
                }
                Text(
                    excerpt,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = if (matches.isEmpty()) 1 else 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
fun FolderRowView(
    item: FolderItem,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** A long press on a folder (T40 P4, NT3–NT5): rename it, make a subfolder, move or delete it. */
    onLongPress: ((FolderItem) -> Unit)? = null,
    /**
     * False while notes are chosen (A652, review N2): opening the folder would drop the selection
     * out of sight, so it waits, dimmed, and TalkBack says it is unavailable.
     */
    enabled: Boolean = true,
) {
    val haptics = LocalHapticFeedback.current
    Row(
        modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else DISABLED_ALPHA)
            .combinedClickable(
                enabled = enabled,
                role = Role.Button,
                onClickLabel = if (item.notebook) "Open Notebook" else "Open Folder",
                onLongClickLabel = if (onLongPress != null) (if (item.notebook) "Notebook Actions" else "Folder Actions") else null,
                onLongClick = onLongPress?.let { press ->
                    {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        press(item)
                    }
                },
            ) { onOpen(item.id) }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // A notebook's own icon, apart from a folder's (T43, A750).
        Icon(if (item.notebook) NotebookIcon else FolderIcon, contentDescription = null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
        Text(item.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Folders, then notes, in one lazy list (A285): rows are keyed by id with a
 * content type per kind, so Compose reuses them while scrolling and composes
 * only those on screen, whether the list holds 50 notes or 5,000.
 */
@Composable
fun NoteList(
    notes: List<NoteItem>,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
    folders: List<FolderItem> = emptyList(),
    onFolder: (String) -> Unit = {},
    state: LazyListState = rememberLazyListState(),
    contentPadding: PaddingValues = PaddingValues(),
    header: (LazyListScope.() -> Unit)? = null,
    /** A long press on a note (T38): moving it. */
    onLongPress: ((NoteItem) -> Unit)? = null,
    /** A long press on a folder (T40 P4, NT3–NT5): rename it, make a subfolder, move or delete it. */
    onFolderLongPress: ((FolderItem) -> Unit)? = null,
    /** A heading over the notes (Home's "Recent notes", T39); without one, a divider after the folders. */
    notesTitle: String? = null,
    /**
     * Whether a long press on a note starts selection mode (T42 on Android, A652): Home, a folder,
     * All notes and a tag's notes say so; any other list keeps its own long press (#137, A658).
     */
    selectable: Boolean = false,
) {
    // Folders wait while this list's notes are chosen (A652, review N2).
    val choosing = selectable && onLongPress != null && LocalNoteSelection.current?.active == true
    LazyColumn(modifier.testTag("noteList"), state = state, contentPadding = contentPadding) {
        header?.invoke(this)
        items(folders, key = { "folder:${it.id}" }, contentType = { "folder" }) { folder ->
            FolderRowView(folder, onFolder, onLongPress = onFolderLongPress, enabled = !choosing)
        }
        if (notesTitle != null && notes.isNotEmpty()) {
            item(key = "notesTitle", contentType = "title") {
                SectionTitle(notesTitle)
            }
        } else if (folders.isNotEmpty() && notes.isNotEmpty()) {
            item(key = "divider", contentType = "divider") { HorizontalDivider() }
        }
        items(notes, key = { it.id }, contentType = { "note" }) { note ->
            NoteRowView(note, onOpen, onLongPress = onLongPress, selectable = selectable)
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        // A heading for TalkBack's headings navigation (T40 P9, PL14, A498).
        modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp).semantics { heading() },
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
fun EmptyMessage(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(24.dp),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Material's opacity for content that is unavailable for now. */
private const val DISABLED_ALPHA = 0.38f
