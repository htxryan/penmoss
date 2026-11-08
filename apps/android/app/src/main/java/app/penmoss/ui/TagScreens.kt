package app.penmoss.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.data.NoteStore
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.notes.TagNode
import app.penmoss.engine.notes.TagTree
import app.penmoss.engine.notes.Tags
import app.penmoss.ui.settings.BackButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.shareIn
import kotlinx.coroutines.launch
import java.io.IOException

/** "1 note", "3 notes". */
internal fun notesCount(count: Int) = "$count ${if (count == 1) "note" else "notes"}"

/** The rows the tree shows: each node and its depth, children only under an expanded parent. */
internal fun tagRows(tree: List<TagNode>, expanded: Set<String>, depth: Int = 0): List<Pair<TagNode, Int>> =
    tree.flatMap { node ->
        listOf(node to depth) + if (node.tag in expanded) tagRows(node.children, expanded, depth + 1) else emptyList()
    }

/**
 * Tags (T40 P6, TG1): every tag on the notes this phone holds, nested by `/`, each with how many
 * notes carry it or a tag under it, as the web's tag pane; offline too. A tap opens its notes
 * (TG2), a long press renames or merges it (TG3), the arrow opens or closes its nested tags.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun TagsScreen(
    tree: List<TagNode>,
    onBack: () -> Unit,
    onOpenTag: (String) -> Unit,
    onRename: (String) -> Unit,
    /** What the last rename did, said under the list (the web's tag-status line). */
    status: String? = null,
) {
    var expanded by rememberSaveable { mutableStateOf(listOf<String>()) }
    val haptics = LocalHapticFeedback.current
    Scaffold(topBar = { TopAppBar(title = { Text("Tags") }, navigationIcon = { BackButton(onBack) }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (status != null) {
                Text(
                    status,
                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("tagStatus"),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (tree.isEmpty()) {
                EmptyMessage("No tags")
                return@Column
            }
            LazyColumn(Modifier.fillMaxWidth().testTag("tagTree")) {
                items(tagRows(tree, expanded.toSet()), key = { it.first.tag }) { (node, depth) ->
                    val open = node.tag in expanded
                    Row(Modifier.fillMaxWidth().padding(start = (depth * 20).dp), verticalAlignment = Alignment.CenterVertically) {
                        if (node.children.isNotEmpty()) {
                            IconButton(
                                onClick = { expanded = if (open) expanded - node.tag else expanded + node.tag },
                                modifier = Modifier.testTag("twisty-${node.tag}"),
                            ) {
                                Icon(
                                    if (open) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                    contentDescription = "${if (open) "Collapse" else "Expand"} #${node.tag}",
                                )
                            }
                        } else {
                            Spacer(Modifier.size(48.dp))
                        }
                        Row(
                            Modifier.weight(1f)
                                .combinedClickable(
                                    role = Role.Button,
                                    onClickLabel = "Show Its Notes",
                                    onLongClickLabel = "Rename or Merge",
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        onRename(node.tag)
                                    },
                                ) { onOpenTag(node.tag) }
                                .semantics(mergeDescendants = true) { contentDescription = "#${node.tag}, ${notesCount(node.count)}" }
                                .padding(end = 16.dp, top = 12.dp, bottom = 12.dp)
                                .testTag("tag-${node.tag}"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("#${node.name}", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.width(8.dp))
                            Text("${node.count}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

/**
 * A tag's notes (T40 P6, TG2): those tagged with it or a tag under it, newest first, from the
 * phone's own index, offline too. The top bar names the tag; Back is the web's "All notes".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaggedNotesScreen(tag: String, notes: List<NoteItem>, onBack: () -> Unit, onOpen: (String) -> Unit, onNoteLongPress: ((NoteItem) -> Unit)? = null) {
    // Selection mode (A652): a chosen note the tag stops listing is let go (review S2), and the
    // bar under the selection bar is out of TalkBack's reach (review S4).
    if (onNoteLongPress != null) KeepSelectionShown(notes)
    Scaffold(
        topBar = {
            TopAppBar(
                modifier = Modifier.underSelectionBar(),
                title = {
                    Column {
                        Text("#$tag", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(notesCount(notes.size), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                navigationIcon = { BackButton(onBack) },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (notes.isEmpty()) EmptyMessage("No notes use this tag.") else NoteList(notes = notes, onOpen = onOpen, onLongPress = onNoteLongPress, selectable = true)
        }
    }
}

/** What a rename's new name means, checked as the web's tag pane checks it before asking. */
internal sealed interface TagRenameCheck {
    data class Invalid(val message: String) : TagRenameCheck
    data object Same : TagRenameCheck
    data class Ready(val to: String, val merge: Boolean) : TagRenameCheck
}

internal fun checkTagRename(from: String, value: String, known: Set<String>): TagRenameCheck {
    val to = Tags.normalise(value) ?: return TagRenameCheck.Invalid(Tags.INVALID)
    if (to == from) return TagRenameCheck.Same
    if (to.startsWith("$from/")) return TagRenameCheck.Invalid("#$from cannot move inside itself.")
    return TagRenameCheck.Ready(to, merge = to in known)
}

/** What the tag pane's status line says once a rename has started. */
internal fun tagRenamedMessage(from: String, to: String, merge: Boolean, notes: Int): String =
    if (merge) "Merged #$from into #$to in ${notesCount(notes)}" else "Renamed #$from to #$to in ${notesCount(notes)}"

/** The words for a rename that did not start: the server's own for a refusal. */
internal fun tagRenameError(error: Throwable): String = when (error) {
    is ApiException -> error.message ?: "Could not rename (HTTP ${error.status})"
    is IOException -> "Renaming a tag needs a connection. Try again when you are online."
    else -> "Could not rename: ${error.message}"
}

/**
 * Rename or merge a tag (T40 P6, TG3, A468): the new name, saying when it merges into a tag that
 * exists, as the web's. Online only: the server renames it in every note. While this phone has
 * edits it has not sent, to any note ([unsent], review S4), the rename waits ("Sync first"), so
 * an edit made offline cannot bring the old tag back after the server renamed it.
 */
@Composable
fun RenameTagDialog(
    from: String,
    known: Set<String>,
    unsent: Int,
    onRename: suspend (to: String, merge: Boolean) -> String?,
    onSyncNow: () -> Unit,
    onDone: (String?) -> Unit,
) {
    var value by rememberSaveable(from) { mutableStateOf(from) }
    var error by remember(from) { mutableStateOf<String?>(null) }
    var busy by remember(from) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val check = checkTagRename(from, value, known)
    val merge = (check as? TagRenameCheck.Ready)?.merge == true
    val submit: () -> Unit = {
        when (check) {
            is TagRenameCheck.Invalid -> error = check.message
            TagRenameCheck.Same -> onDone(null)
            is TagRenameCheck.Ready -> {
                busy = true
                scope.launch {
                    val failed = onRename(check.to, check.merge)
                    busy = false
                    // Done: the route has closed the dialog and said so; else the server's words.
                    if (failed != null) error = failed
                }
            }
        }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDone(null) },
        title = { Text("Rename #$from") },
        text = {
            Column {
                OutlinedTextField(
                    value = value,
                    onValueChange = {
                        error = null
                        value = it
                    },
                    label = { Text("New name for #$from") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("tagRenameField"),
                )
                if (merge && check is TagRenameCheck.Ready) {
                    Text("#${check.to} exists: its notes and these will share it.", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyMedium)
                }
                if (unsent > 0) {
                    Text(
                        "Sync first: this phone has ${if (unsent == 1) "an edit" else "$unsent edits"} not sent yet.",
                        Modifier.padding(top = 8.dp).testTag("tagRenameSyncFirst"),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                error?.let {
                    Text(
                        it,
                        Modifier.padding(top = 8.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("tagRenameError"),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        },
        confirmButton = {
            if (unsent > 0) {
                TextButton(onClick = onSyncNow, modifier = Modifier.testTag("tagRenameSync")) { Text("Sync Now") }
            } else {
                TextButton(onClick = submit, enabled = !busy, modifier = Modifier.testTag("tagRenameConfirm")) { Text(if (merge) "Merge" else "Rename") }
            }
        },
        dismissButton = { TextButton(onClick = { onDone(null) }, enabled = !busy) { Text("Cancel") } },
    )
}

/** What Tags' route asks of the server and the sync (TG3): a fake in tests. */
internal interface TagRenamer {
    /** Renames [from] to [to] in every note; [noteIds] are those this phone holds. The notes renamed. */
    suspend fun rename(from: String, to: String, noteIds: List<String>): List<String>

    /** Sends this phone's edits now ("Sync now"). */
    fun syncNow()

    /** After a rename: a sync now, and one more a few seconds on, once the server has rewritten the notes (review S5). */
    fun syncAfterRename()
}

private class GraphTagRenamer(private val graph: AppGraph) : TagRenamer {
    override suspend fun rename(from: String, to: String, noteIds: List<String>): List<String> =
        graph.api.renameTag(from, to, noteIds).notes

    override fun syncNow() {
        graph.scope.launch { graph.sync.syncNow() }
    }

    override fun syncAfterRename() {
        graph.sync.requestSync()
        graph.scope.launch {
            delay(RENAME_RESYNC_MS)
            graph.sync.requestSync()
        }
    }
}

/** How long after a rename the second sync waits: the server rewrites the notes in the background (202). */
internal const val RENAME_RESYNC_MS = 5_000L

/** Tags' route (TG1, TG3): the tree from Room, and the rename dialog over it. */
@Composable
internal fun TagsRoute(graph: AppGraph, onBack: () -> Unit, onOpenTag: (String) -> Unit) {
    val renamer = remember(graph) { GraphTagRenamer(graph) }
    TagsRoute(graph.store, renamer, onBack, onOpenTag, graph.hiddenFolders)
}

/** [hidden]: the folders of notebooks closed here, whose notes' tags are left out (T43, A752). */
@Composable
internal fun TagsRoute(
    store: NoteStore,
    renamer: TagRenamer,
    onBack: () -> Unit,
    onOpenTag: (String) -> Unit,
    hidden: kotlinx.coroutines.flow.Flow<Set<String>> = kotlinx.coroutines.flow.flowOf(emptySet()),
) {
    // One Room read for both the tree and the dialog's known tags, coalesced while a first fill writes (review nit).
    val scope = rememberCoroutineScope()
    val shared = remember(store) {
        store.observeNoteTags(hidden).conflate().distinctUntilChanged().shareIn(scope, SharingStarted.WhileSubscribed(), replay = 1)
    }
    val noteTags by shared.collectAsStateWithLifecycle(emptyList())
    val tree by remember(shared) { shared.map { TagTree.build(it) }.flowOn(Dispatchers.Default) }.collectAsStateWithLifecycle(emptyList())
    // Every edit this phone has not sent, to any note (review S4): one that typed the old tag
    // offline is on a note no tag list here may name yet.
    val unsent by remember(store) { store.observeUnsent().distinctUntilChanged() }.collectAsStateWithLifecycle(0)
    var renaming by rememberSaveable { mutableStateOf<String?>(null) }
    var status by rememberSaveable { mutableStateOf<String?>(null) }
    TagsScreen(tree, onBack, onOpenTag, onRename = { status = null; renaming = it }, status = status)
    renaming?.let { from ->
        RenameTagDialog(
            from = from,
            known = noteTags.flatten().toSet(),
            unsent = unsent,
            onRename = { to, merge ->
                when (val outcome = renameTag(store, renamer, from, to)) {
                    is Result.Success -> {
                        status = tagRenamedMessage(from, to, merge, outcome.notes)
                        renaming = null
                        null
                    }
                    is Result.Failure -> outcome.message
                }
            },
            onSyncNow = renamer::syncNow,
            onDone = { renaming = null },
        )
    }
}

private sealed interface Result {
    data class Success(val notes: Int) : Result
    data class Failure(val message: String) : Result
}

/**
 * Asks the server to rename [from] in every note, naming those this phone holds; renames it here
 * at once on the notes the server named (review S5), then syncs.
 */
private suspend fun renameTag(store: NoteStore, renamer: TagRenamer, from: String, to: String): Result =
    try {
        val renamed = renamer.rename(from, to, store.taggedIds(from))
        store.renameTagLocally(from, to, renamed)
        renamer.syncAfterRename()
        Result.Success(renamed.size)
    } catch (error: Exception) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        Result.Failure(tagRenameError(error))
    }

/** A tag's notes' route (TG2). */
@Composable
internal fun TaggedRoute(graph: AppGraph, tag: String, onBack: () -> Unit, onOpen: (String) -> Unit, onNoteLongPress: (NoteItem) -> Unit) {
    val notes by remember(graph, tag) {
        graph.store.observeTagged(tag, graph.hiddenFolders).map { Items.notes(it, System.currentTimeMillis()) }.distinctUntilChanged().flowOn(Dispatchers.Default)
    }.collectAsStateWithLifecycle(emptyList())
    TaggedNotesScreen(tag, notes, onBack, onOpen, onNoteLongPress)
}
