package app.penmoss.ui.tags

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.NavType
import androidx.navigation.navArgument
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
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.typedLength
import app.penmoss.ui.common.IconButton
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
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
import app.penmoss.NotebookGraph
import app.penmoss.data.NoteStore
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.notes.TagNode
import app.penmoss.engine.notes.TagTree
import app.penmoss.engine.notes.Tags
import app.penmoss.ui.settings.BackButton
import app.penmoss.ui.settings.SettingsRoutes
import app.penmoss.ui.common.roles
import app.penmoss.analytics.trackedToggle
import app.penmoss.engine.api.AiNowAnswer
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import app.penmoss.ai.AiDescriptionCopy
import app.penmoss.ai.TAG_DESCRIPTION_MAX
import app.penmoss.engine.api.TagsToDescribe
import app.penmoss.ui.common.PenmossSnackbar
import app.penmoss.ui.common.SheetAction
import app.penmoss.ui.common.SnackbarTone
import app.penmoss.ui.common.say
import kotlinx.coroutines.withTimeoutOrNull
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
import app.penmoss.ui.common.EmptyMessage
import app.penmoss.ui.common.Items
import app.penmoss.ui.common.KeepSelectionShown
import app.penmoss.ui.common.NoteItem
import app.penmoss.ui.common.NoteList
import app.penmoss.ui.common.underSelectionBar
import app.penmoss.ui.RootUi
import app.penmoss.ui.leave
import app.penmoss.ui.open

/** "1 note", "3 notes". */
internal fun notesCount(count: Int) = "$count ${if (count == 1) "note" else "notes"}"

/** The rows the tree shows: each node and its depth, children only under an expanded parent. */
internal fun tagRows(tree: List<TagNode>, expanded: Set<String>, depth: Int = 0): List<Pair<TagNode, Int>> =
    tree.flatMap { node ->
        listOf(node to depth) + if (node.tag in expanded) tagRows(node.children, expanded, depth + 1) else emptyList()
    }

/** A description's first line, as the Mac's Tags page shows it until it is chosen. */
internal fun descriptionLine(description: String): String {
    val lines = description.trim().lines()
    return if (lines.size > 1) "${lines.first()} …" else lines.first()
}

/**
 * Tags (T40 P6, TG1; A1677): every tag on the notes this phone holds, nested by `/`, each with
 * how many notes carry it or a tag under it and the first line of what it means, as the Mac's
 * Tags page; offline too. A tap opens its notes (TG2), a long press its menu (Rename…, its
 * description, Generate AI Description), the arrow opens or closes its nested tags, and
 * Generate All… asks before it describes every tag with none. What a change did is said in
 * [snackbar], with Undo, as the Mac's toast.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun TagsScreen(
    tree: List<TagNode>,
    onBack: () -> Unit,
    onOpenTag: (String) -> Unit,
    /** A long press: the tag's menu. */
    onMenu: (String) -> Unit,
    /** Where what a rename or description did is said, with its Undo (the Mac's tag toast). */
    snackbar: SnackbarHostState = remember { SnackbarHostState() },
    /** Each described tag's description, by its full path. */
    descriptions: Map<String, String> = emptyMap(),
    /** The tags whose description is being generated now. */
    generating: Set<String> = emptySet(),
    /** Generate All… in the top bar; none offered when null. */
    onGenerateAll: (() -> Unit)? = null,
) {
    var expanded by rememberSaveable { mutableStateOf(listOf<String>()) }
    val haptics = LocalHapticFeedback.current
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) { PenmossSnackbar(it) } },
        topBar = {
            TopAppBar(
                title = { Text("Tags") },
                navigationIcon = { BackButton(onBack) },
                actions = {
                    if (onGenerateAll != null && tree.isNotEmpty()) {
                        TextButton(onClick = trackedClick("tags.generate-all", onGenerateAll), modifier = Modifier.testTag("tagsGenerateAll")) { Text("Generate All…") }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (tree.isEmpty()) {
                // The Mac's Tags page's empty state, its heading and line as one (as Trash's, A895).
                EmptyMessage(NO_TAGS, Modifier.testTag("tagsEmpty"))
                return@Column
            }
            LazyColumn(Modifier.fillMaxWidth().testTag("tagTree")) {
                items(tagRows(tree, expanded.toSet()), key = { it.first.tag }) { (node, depth) ->
                    val open = node.tag in expanded
                    val description = descriptions[node.tag]?.takeIf { it.isNotBlank() }
                    val busy = node.tag in generating
                    Row(Modifier.fillMaxWidth().padding(start = (depth * 20).dp), verticalAlignment = Alignment.CenterVertically) {
                        if (node.children.isNotEmpty()) {
                            IconButton(
                                onClick = trackedClick(if (open) "tags.pane.collapse" else "tags.pane.expand") { expanded = if (open) expanded - node.tag else expanded + node.tag },
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
                                    onLongClickLabel = "More Actions",
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        onMenu(node.tag)
                                    },
                                    onClick = trackedClick("tags.pane.show") { onOpenTag(node.tag) },
                                )
                                .semantics(mergeDescendants = true) {
                                    contentDescription = "#${node.tag}, ${notesCount(node.count)}" + (description?.let { ", $it" } ?: "")
                                }
                                .padding(end = 16.dp, top = 12.dp, bottom = 12.dp)
                                .testTag("tag-${node.tag}"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text("#${node.name}", style = MaterialTheme.roles.rowLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (busy) {
                                    Text("Generating…", Modifier.testTag("tagGenerating-${node.tag}"), style = MaterialTheme.roles.help, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                } else if (description != null) {
                                    Text(
                                        descriptionLine(description),
                                        Modifier.testTag("tagDescription-${node.tag}"),
                                        style = MaterialTheme.roles.help,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                            Spacer(Modifier.width(8.dp))
                            Text("${node.count}", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

/**
 * What a long press on a tag offers (A1677): Rename… (TG3), then its description beside it as
 * the Mac's row has it: Add or Edit Description…, Generate AI Description, and Clear Description
 * once it has one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TagMenuSheet(
    tag: String,
    described: Boolean,
    onRename: () -> Unit,
    onEditDescription: () -> Unit,
    onGenerate: () -> Unit,
    onClear: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val tracked = rememberTrackedDialog("tagMenu")
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Text("#$tag", Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = MaterialTheme.roles.groupHead, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp).testTag("tagMenu")) {
            SheetAction("Rename…", "tagAction-rename", "tags.pane.rename", tracked.done(onRename))
            SheetAction(if (described) "Edit Description…" else "Add Description…", "tagAction-describe", "tags.description.edit", tracked.done(onEditDescription))
            SheetAction("Generate AI Description", "tagAction-generate", "tags.row.generate", tracked.done(onGenerate))
            if (described) SheetAction("Clear Description", "tagAction-clear", "tags.row.clear-description", tracked.done(onClear))
        }
    }
}

/** What a tag means, written or changed by hand (A1364's limit); blank text clears it. */
@Composable
fun TagDescriptionDialog(tag: String, initial: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable(tag) { mutableStateOf(initial) }
    val tracked = rememberTrackedDialog("tagDescription")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Description of #$tag") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it.take(TAG_DESCRIPTION_MAX) },
                placeholder = { Text("Add a description") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth().testTag("tagDescriptionField").typedLength("tagDescription", "description", text),
            )
        },
        confirmButton = {
            TextButton(onClick = trackedClick("tags.description.save", tracked.done { onSave(text) }), enabled = text != initial, modifier = Modifier.testTag("tagDescriptionSave")) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = trackedClick("tags.description.cancel", onDismiss)) { Text("Cancel") } },
    )
}

/** Tags' empty state: the Mac's Tags page's heading and its line, as one sentence pair. */
internal const val NO_TAGS = "No tags yet. Tag a note with #name in its text, and the tag shows here."

/**
 * Generate All… (A1677): how many tags it describes and that each goes to the AI provider
 * (core's words), asked before anything is sent. Replace Existing Descriptions takes in the tags
 * described already. [covers] is the engine page's count, by core's set, so the number asked
 * about is the number described.
 */
@Composable
fun GenerateAllTagsDialog(covers: TagsToDescribe, onGenerate: (replace: Boolean) -> Unit, onDismiss: () -> Unit) {
    var replace by rememberSaveable { mutableStateOf(false) }
    val tracked = rememberTrackedDialog("tagsGenerate")
    val going = covers.count(replace)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Generate All Tag Descriptions?") },
        text = {
            Column {
                Text(AiDescriptionCopy.generateAllWords(going, replace), Modifier.testTag("tagsGenerateCount"), style = MaterialTheme.roles.body)
                Row(
                    Modifier.fillMaxWidth().padding(top = 12.dp)
                        .toggleable(value = replace, role = Role.Checkbox, onValueChange = trackedToggle("tags.generate.replace") { replace = it })
                        .testTag("tagsGenerateReplace"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked = replace, onCheckedChange = null)
                    Text("Replace Existing Descriptions", Modifier.padding(start = 12.dp), style = MaterialTheme.roles.body)
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = trackedClick("tags.generate.start", tracked.done { onGenerate(replace) }),
                enabled = going > 0,
                modifier = Modifier.testTag("tagsGenerateStart"),
            ) { Text(if (going == 1) "Generate 1 Description" else "Generate $going Descriptions") }
        },
        dismissButton = { TextButton(onClick = trackedClick("tags.generate.cancel", onDismiss)) { Text("Cancel") } },
    )
}

/** Generating needs an AI provider on this phone: where to choose one, as a note's Describe Now says. */
@Composable
fun ChooseAiProviderDialog(onOpenSettings: () -> Unit, onDismiss: () -> Unit) {
    val tracked = rememberTrackedDialog("aiProvider")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Choose an AI Provider") },
        text = { Text(AiDescriptionCopy.text("chooseProvider.body"), style = MaterialTheme.roles.body) },
        confirmButton = {
            TextButton(onClick = trackedClick("tags.generate.open-settings", tracked.done(onOpenSettings)), modifier = Modifier.testTag("tagsOpenAiSettings")) { Text("Open Settings") }
        },
        dismissButton = { TextButton(onClick = trackedClick("tags.generate.cancel", onDismiss)) { Text("Cancel") } },
    )
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
    val tracked = rememberTrackedDialog("tagRename")
    val submit: () -> Unit = {
        when (check) {
            is TagRenameCheck.Invalid -> error = check.message
            TagRenameCheck.Same -> onDone(null)
            is TagRenameCheck.Ready -> {
                tracked.done()
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
                    modifier = Modifier.fillMaxWidth().testTag("tagRenameField").typedLength("tagRename", "name", value),
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
                TextButton(onClick = trackedClick("tags.pane.rename.sync-now", onSyncNow), modifier = Modifier.testTag("tagRenameSync")) { Text("Sync Now") }
            } else {
                TextButton(onClick = trackedClick("tags.pane.rename.submit", submit), enabled = !busy, modifier = Modifier.testTag("tagRenameConfirm")) { Text(if (merge) "Merge" else "Rename") }
            }
        },
        dismissButton = { TextButton(onClick = trackedClick("tags.pane.rename.cancel") { onDone(null) }, enabled = !busy) { Text("Cancel") } },
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

private class GraphTagRenamer(private val graph: NotebookGraph) : TagRenamer {
    override suspend fun rename(from: String, to: String, noteIds: List<String>): List<String> =
        graph.api.renameTag(from, to, noteIds).notes

    override fun syncNow() {
        // Outlives the screen: a sync the person asked for.
        graph.launchReporting(Dispatchers.Main.immediate) { graph.sync.syncNow() }
    }

    override fun syncAfterRename() {
        graph.sync.requestSync()
        // Outlives the screen: the rename's second sync, once the server has rewritten the notes.
        graph.launchReporting(Dispatchers.Main.immediate) {
            delay(RENAME_RESYNC_MS)
            graph.sync.requestSync()
        }
    }
}

/** How long after a rename the second sync waits: the server rewrites the notes in the background (202). */
internal const val RENAME_RESYNC_MS = 5_000L

/**
 * What Tags' route asks of the notebook's engine page for descriptions (A1677): a fake in
 * tests. The page writes the notebook's WorkspaceDoc (Kotlin never does, A11); each answer is
 * shown at once ([NoteStore.setTagDescriptionLocally]) and the next pass brings the same.
 */
internal interface TagDescriber {
    /** Whether this phone has an AI provider it can call (Settings → AI Descriptions). */
    val ready: Boolean

    /** Writes what [tag] means (blank clears it); the description as kept, or null. */
    suspend fun setDescription(tag: String, description: String): String?

    /** Generate AI Description: what came of it, written when it worked. */
    suspend fun generate(tag: String): AiNowAnswer

    /** What Generate All covers, by core's set on the engine page: asked before its dialog shows. */
    suspend fun toDescribe(): TagsToDescribe

    /** Generate All: how many tags go, described in the background. */
    suspend fun generateAll(replace: Boolean): Int

    /** A sync now, so a description written here reaches the notebook's repository. */
    fun synced()
}

private class GraphTagDescriber(private val graph: NotebookGraph) : TagDescriber {
    override val ready: Boolean get() = graph.device.aiDescriptions.ready

    override suspend fun setDescription(tag: String, description: String): String? = graph.api.setTagDescription(tag, description)

    override suspend fun generate(tag: String): AiNowAnswer = graph.api.describeTag(tag)

    override suspend fun toDescribe(): TagsToDescribe = graph.api.tagsToDescribe()

    override suspend fun generateAll(replace: Boolean): Int = graph.api.describeAllTags(replace)

    override fun synced() = graph.sync.requestSync()
}

/** Tags' route (TG1, TG3; A1677): the tree and descriptions from Room, its menu and dialogs. */
@Composable
internal fun TagsRoute(graph: NotebookGraph, onBack: () -> Unit, onOpenTag: (String) -> Unit, onOpenAiSettings: () -> Unit) {
    val renamer = remember(graph) { GraphTagRenamer(graph) }
    val describer = remember(graph) { GraphTagDescriber(graph) }
    TagsRoute(graph.store, renamer, onBack, onOpenTag, describer, onOpenAiSettings)
}

/** How long a tag change's Undo is offered, as the Mac's tag toast (`TAG_DONE_MS`). */
internal const val TAG_UNDO_MS = 8_000L

@Composable
internal fun TagsRoute(
    store: NoteStore,
    renamer: TagRenamer,
    onBack: () -> Unit,
    onOpenTag: (String) -> Unit,
    describer: TagDescriber? = null,
    onOpenAiSettings: () -> Unit = {},
    /** How long Undo is offered; tests hold it open. */
    undoFor: Long = TAG_UNDO_MS,
) {
    // One Room read for both the tree and the dialog's known tags, coalesced while a first fill writes (review nit).
    val scope = rememberCoroutineScope()
    val shared = remember(store) {
        store.observeNoteTags().conflate().distinctUntilChanged().shareIn(scope, SharingStarted.WhileSubscribed(), replay = 1)
    }
    val noteTags by shared.collectAsStateWithLifecycle(emptyList())
    val tree by remember(shared) { shared.map { TagTree.build(it) }.flowOn(Dispatchers.Default) }.collectAsStateWithLifecycle(emptyList())
    val descriptions by remember(store) { store.observeTagDescriptions().distinctUntilChanged() }.collectAsStateWithLifecycle(emptyMap())
    // Every edit this phone has not sent, to any note (review S4): one that typed the old tag
    // offline is on a note no tag list here may name yet.
    val unsent by remember(store) { store.observeUnsent().distinctUntilChanged() }.collectAsStateWithLifecycle(0)
    val snackbar = remember { SnackbarHostState() }
    var menu by rememberSaveable { mutableStateOf<String?>(null) }
    var renaming by rememberSaveable { mutableStateOf<String?>(null) }
    var describing by rememberSaveable { mutableStateOf<String?>(null) }
    var askingAll by remember { mutableStateOf<TagsToDescribe?>(null) }
    var noProvider by rememberSaveable { mutableStateOf(false) }
    var generating by remember { mutableStateOf(setOf<String>()) }

    /**
     * Says what a change did in the snackbar, as the Mac's tag toast; with [undo], offers Undo
     * for [undoFor], and says what Undo did. A snackbar still showing goes first.
     */
    fun say(text: String, tone: SnackbarTone, undo: (suspend () -> String?)? = null) {
        scope.launch {
            snackbar.currentSnackbarData?.dismiss()
            if (undo == null) {
                snackbar.say(text, tone, duration = SnackbarDuration.Long)
                return@launch
            }
            val undone = withTimeoutOrNull(undoFor) {
                snackbar.say(text, tone, actionLabel = "Undo", duration = SnackbarDuration.Indefinite)
            } == SnackbarResult.ActionPerformed
            if (!undone) {
                snackbar.currentSnackbarData?.dismiss()
                return@launch
            }
            undo()?.let { snackbar.say(it, SnackbarTone.Done, duration = SnackbarDuration.Long) }
        }
    }

    /** Writes [text] as [tag]'s description and shows it at once; false (and said) when it failed. */
    suspend fun write(tag: String, text: String): Boolean {
        val d = describer ?: return false
        return try {
            store.setTagDescriptionLocally(tag, d.setDescription(tag, text))
            d.synced()
            true
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            say("Couldn’t save the description of #$tag: ${error.message ?: "the notebook didn’t answer"}", SnackbarTone.Error)
            false
        }
    }

    /** Undo for a description changed from [before]: writes it back, and says so. */
    val undoTo = { tag: String, before: String -> suspend { if (write(tag, before)) "The description of #$tag is as it was." else null } }

    fun generate(tag: String) {
        val d = describer ?: return
        if (!d.ready) {
            noProvider = true
            return
        }
        val before = descriptions[tag] ?: ""
        generating = generating + tag
        scope.launch {
            val answer = try {
                d.generate(tag)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                AiNowAnswer(ok = false, message = error.message ?: "The notebook didn’t answer.")
            }
            generating = generating - tag
            val text = answer.text
            if (answer.ok && text != null) {
                store.setTagDescriptionLocally(tag, text)
                d.synced()
                say("Wrote a description of #$tag.", SnackbarTone.Done, undoTo(tag, before))
            } else {
                say("Couldn’t generate a description of #$tag: ${answer.message ?: "the AI provider didn’t answer"}", SnackbarTone.Error)
            }
        }
    }

    TagsScreen(
        tree,
        onBack,
        onOpenTag,
        onMenu = { menu = it },
        snackbar = snackbar,
        descriptions = descriptions,
        generating = generating,
        onGenerateAll = describer?.let { d ->
            {
                if (d.ready) {
                    // How many go, by core's set on the engine page, before the dialog asks.
                    scope.launch {
                        askingAll = try {
                            d.toDescribe()
                        } catch (error: Exception) {
                            if (error is kotlinx.coroutines.CancellationException) throw error
                            say(GENERATE_ALL_FAILED, SnackbarTone.Error)
                            null
                        }
                    }
                } else {
                    noProvider = true
                }
            }
        },
    )
    menu?.let { tag ->
        TagMenuSheet(
            tag = tag,
            described = descriptions[tag] != null,
            onRename = { menu = null; renaming = tag },
            onEditDescription = { menu = null; describing = tag },
            onGenerate = { menu = null; generate(tag) },
            onClear = {
                menu = null
                val before = descriptions[tag] ?: ""
                scope.launch { if (write(tag, "")) say("Cleared the description of #$tag.", SnackbarTone.Done, undoTo(tag, before)) }
            },
            onDismiss = { menu = null },
        )
    }
    describing?.let { tag ->
        val before = descriptions[tag] ?: ""
        TagDescriptionDialog(
            tag = tag,
            initial = before,
            onSave = { text ->
                describing = null
                scope.launch {
                    if (write(tag, text)) say(if (text.isBlank()) "Cleared the description of #$tag." else "Saved the description of #$tag.", SnackbarTone.Done, undoTo(tag, before))
                }
            },
            onDismiss = { describing = null },
        )
    }
    askingAll?.let { covers ->
        val d = describer ?: return@let
        GenerateAllTagsDialog(
            covers = covers,
            onGenerate = { replace ->
                askingAll = null
                scope.launch {
                    try {
                        say(
                            when (val count = d.generateAll(replace)) {
                                0 -> "Nothing to describe: every tag has a description."
                                1 -> "Generating a description of 1 tag in the background."
                                else -> "Generating descriptions of $count tags in the background."
                            },
                            SnackbarTone.Info,
                        )
                    } catch (error: Exception) {
                        if (error is kotlinx.coroutines.CancellationException) throw error
                        say(GENERATE_ALL_FAILED, SnackbarTone.Error)
                    }
                }
            },
            onDismiss = { askingAll = null },
        )
    }
    if (noProvider) {
        ChooseAiProviderDialog(onOpenSettings = { noProvider = false; onOpenAiSettings() }, onDismiss = { noProvider = false })
    }
    renaming?.let { from ->
        RenameTagDialog(
            from = from,
            known = noteTags.flatten().toSet(),
            unsent = unsent,
            onRename = { to, merge ->
                when (val outcome = renameTag(store, renamer, from, to)) {
                    is Result.Success -> {
                        say(tagRenamedMessage(from, to, merge, outcome.notes), SnackbarTone.Done)
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

/** What Generate All says when the engine page could not start it. */
private const val GENERATE_ALL_FAILED = "Couldn’t start generating. Try again once the notebook is open."

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
internal fun TaggedRoute(graph: NotebookGraph, tag: String, onBack: () -> Unit, onOpen: (String) -> Unit, onNoteLongPress: (NoteItem) -> Unit) {
    val notes by remember(graph, tag) {
        graph.store.observeTagged(tag).map { Items.notes(it, System.currentTimeMillis()) }.distinctUntilChanged().flowOn(Dispatchers.Default)
    }.collectAsStateWithLifecycle(emptyList())
    TaggedNotesScreen(tag, notes, onBack, onOpen, onNoteLongPress)
}

/** Tags (T40 P6, TG1–TG3): the tree, a tag's notes, rename and merge. */
internal fun NavGraphBuilder.tagRoutes(root: RootUi) {
    composable("tags") { entry ->
        TagsRoute(root.graph, onBack = { root.nav.leave(entry) }, onOpenTag = root::openTag, onOpenAiSettings = { root.nav.open(SettingsRoutes.AI) })
    }
    composable("tag/{tag}", arguments = listOf(navArgument("tag") { type = NavType.StringType })) { entry ->
        val tag = entry.arguments?.getString("tag") ?: return@composable
        TaggedRoute(root.graph, tag, onBack = { root.nav.leave(entry) }, onOpen = root::openNote, onNoteLongPress = root::startSelection)
    }
}
