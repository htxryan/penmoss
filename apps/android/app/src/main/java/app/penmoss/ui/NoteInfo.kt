package app.penmoss.ui

import androidx.compose.material3.rememberTooltipState
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.TooltipBox
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.background
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.git.GraphSource
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.penmoss.data.BacklinkSource
import app.penmoss.data.FolderEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.Notebooks
import app.penmoss.editor.NoteCounts
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.BacklinksReply
import app.penmoss.engine.api.PenmossApi
import app.penmoss.engine.api.PenmossJson
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.notes.BacklinkLists
import app.penmoss.engine.notes.Backlinks
import app.penmoss.engine.notes.ContextPart
import app.penmoss.engine.notes.LinkedNote
import app.penmoss.engine.notes.UnlinkedNote
import app.penmoss.ui.settings.SettingsIcons
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException
import java.time.OffsetDateTime

/*
 * The note's Info sheet on the phone (T40 P7, NT23, LK5, LK6; A474, A475): the web's Info panel
 * (`apps/web/src/notes/NoteInfo.tsx`) as a bottom sheet, adapted because a side panel does not
 * fit a phone. Its details, its tags, its frontmatter as the page reads it from the note's own
 * document, then the backlinks and unlinked mentions in the web's words. Counts and the save
 * status are P8's (NT24): the top bar's sync icon has the save status already.
 */

/**
 * The label a periodic note carries at the top of Info (T42, A572; T40 NT27, A653), as the web's
 * `kindLabel`: "Daily note" or "Weekly note". An ordinary note, or an unknown kind, has none.
 */
internal fun kindLabel(kind: String?): String? = when (kind) {
    "daily" -> "Daily note"
    "weekly" -> "Weekly note"
    else -> null
}

/** Info's label for a periodic note, with its period, or null for any other note. */
data class InfoKind(val label: String, val period: String?)

internal fun infoKind(info: FromEditor.NoteInfo?): InfoKind? = kindLabel(info?.kind)?.let { InfoKind(it, info?.period) }

/** One row of the sheet's details: a label and what it says. */
data class InfoRow(val label: String, val value: String)

/** When frontmatter `created` (with its offset) was, in this phone's words; as the web's `createdLabel`. */
internal fun createdLabel(iso: String?, now: Long = System.currentTimeMillis()): String {
    if (iso.isNullOrBlank()) return "Unknown"
    val time = runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull() ?: return iso
    return shortWhen(time, now)
}

/**
 * The details as the web's Info panel lists them: notebook, folder, created, edited, saved and
 * length. [notebook] is [infoNotebook]'s (no row when null); [saved] is the note's sync state, in
 * the top bar's sync icon's words (NT24); [counts] the page's (T40 P8), an ellipsis until it has
 * counted.
 */
internal fun infoRows(
    folders: List<String>,
    info: FromEditor.NoteInfo?,
    editedAt: Long?,
    now: Long = System.currentTimeMillis(),
    saved: NoteSync? = null,
    counts: NoteCounts? = null,
    notebook: String? = null,
): List<InfoRow> {
    // No Kind row: a periodic note's label is at the top of the sheet (A572, A653).
    return listOfNotNull(
        notebook?.let { InfoRow("Notebook", it) },
        InfoRow("Folder", if (folders.isEmpty()) "Top level" else folders.joinToString(" / ")),
        InfoRow("Created", if (info == null) "…" else createdLabel(info.created, now)),
        InfoRow("Edited", if (editedAt == null || editedAt == 0L) "—" else shortWhen(editedAt, now)),
        InfoRow("Saved", saved?.label ?: "…"),
        InfoRow("Length", counts?.label ?: "…"),
    )
}

/**
 * The Notebook row's value (T43, as the web's Info panel), or null for no row: the notebook the
 * note's folder is in, or the default notebook's name ([defaultName], "Personal" unnamed), with
 * "(closed on this phone)" when it is closed here (A752). Shown, as on the web, only when one of
 * [folders] is a notebook; a git notebook's graph has none (A912).
 */
internal fun infoNotebook(
    folders: List<FolderEntity>,
    folderId: String?,
    defaultName: String,
    closed: Set<String> = emptySet(),
): String? {
    val index = Notebooks.index(folders)
    if (index.notebooks.isEmpty()) return null
    val id = index.ofFolder(folderId) ?: return defaultName
    val name = folders.firstOrNull { it.id == id }?.name?.ifBlank { "Untitled folder" } ?: "Notebook"
    return if (id in closed) "$name (closed on this phone)" else name
}

/** [infoNotebook] for the open note in [graph]: none in a git notebook's graph, as on the web. */
@Composable
internal fun rememberInfoNotebook(graph: AppGraph, folders: List<FolderEntity>, folderId: String?): String? {
    val defaultName by remember(graph) { graph.store.observeDefaultNotebookName() }.collectAsStateWithLifecycle(Notebooks.DEFAULT_NAME)
    val closed by graph.closedNotebooks.closed.collectAsStateWithLifecycle()
    if (graph.source is GraphSource.Git) return null
    return remember(folders, folderId, defaultName, closed) { infoNotebook(folders, folderId, defaultName, closed) }
}

/**
 * The note's inline `#tags` (A502, A656): those [all] has (Room's, frontmatter and inline) that
 * its frontmatter does not ([frontmatter], the page's; null until it says, and then none), A–Z.
 * The sheet lists them apart, "In the text", as the body holds them.
 */
internal fun inlineTags(all: List<String>, frontmatter: List<String>?): List<String> {
    if (frontmatter == null) return emptyList()
    val own = frontmatter.toSet()
    return all.filter { it !in own }.distinct().sorted()
}

/** What the sheet says under Tags about the inline ones, as the web's panel; null with none. */
internal fun inlineTagsLine(inline: List<String>): String? =
    if (inline.isEmpty()) null else "In the text: " + inline.joinToString(" ") { "#$it" }

/** Where the backlinks came from, which the sheet says under its heading. */
enum class BacklinksSource {
    /** Read from the server just now. */
    SERVER,

    /** Offline: the last answer read, with this phone's own links laid over it. */
    CACHED,

    /** Offline, nothing read before: this phone's links only, no text around them or mentions. */
    LOCAL,
}

/** What the sheet's Backlinks section shows (T40 P7, LK5, LK6). */
data class BacklinksView(
    val linked: List<LinkedNote>,
    val unlinked: List<UnlinkedNote>,
    val source: BacklinksSource,
    /** When [BacklinksSource.CACHED] was read. */
    val readAt: Long? = null,
)

/**
 * The server's lists (fresh or cached) with this phone's own links laid over them, as the web's
 * `withRecent` lays its local index over the server's: a note linking here that the index has
 * not seen yet (made or edited on this phone, or not indexed) is listed by its title, with no
 * text around it, and drops out of the unlinked mentions. A [recent] note (edited here, its
 * edits not indexed yet) is taken from Room alone: listed by the server but no longer linking
 * here in Room, it leaves the list (T40 P7 review S3). Most recently edited first.
 */
internal fun backlinksView(
    server: BacklinkLists?,
    local: List<BacklinkSource>,
    source: BacklinksSource,
    readAt: Long? = null,
    recent: Set<String> = emptySet(),
): BacklinksView {
    val localIds = local.mapTo(HashSet()) { it.id }
    val listed = server?.linked.orEmpty().filter { it.id !in recent || it.id in localIds }
    val known = listed.mapTo(HashSet()) { it.id }
    val fresh = local.filter { it.id !in known }.map { LinkedNote(it.id, it.title, it.updatedAt, emptyList()) }
    val updatedAt = local.associate { it.id to it.updatedAt }
    val linked = (listed + fresh).sortedByDescending { updatedAt[it.id] ?: it.updatedAt }
    val linkedIds = linked.mapTo(HashSet()) { it.id }
    val unlinked = server?.unlinked.orEmpty().filter { it.id !in linkedIds }
    return BacklinksView(linked, unlinked, source, readAt)
}

/** The Backlinks section's state: [view] is null until something is known. */
data class BacklinksUi(val loading: Boolean = true, val view: BacklinksView? = null)

/**
 * Loads the open note's backlinks (LK5, LK6): online from `GET /api/notes/:id/backlinks` with the
 * title as the phone has it, cached in Room for offline; offline, the last answer read, else this
 * phone's links alone. The phone's own links ([local]) are laid over whichever it is.
 */
class BacklinksModel(
    private val noteId: String,
    private val store: NoteStore,
    private val api: PenmossApi,
    private val scope: CoroutineScope,
    /** The token is no longer valid (401): the phone is signed out, unless it has another token since. */
) {
    private val state = MutableStateFlow(BacklinksUi())
    private var server: Pair<BacklinkLists, BacklinksSource>? = null
    private var readAt: Long? = null
    private var local: List<BacklinkSource> = emptyList()
    private var recent: Set<String> = emptySet()
    private var loading: Job? = null

    val ui: StateFlow<BacklinksUi> = state

    /**
     * This phone's notes linking here, from Room (offline too): laid over the server's lists.
     * [recent] are the notes edited here that the index may not have yet: Room alone says
     * whether they link here.
     */
    fun localChanged(sources: List<BacklinkSource>, recent: Set<String> = this.recent) {
        local = sources
        this.recent = recent
        publish()
    }

    /** Reads the lists again for [title], the note's title as the phone has it. */
    fun load(title: String) {
        loading?.cancel()
        loading = scope.launch {
            state.update { it.copy(loading = true) }
            try {
                val reply = api.backlinks(noteId, title)
                runCatching { store.cacheBacklinks(noteId, PenmossJson.encodeToString(BacklinksReply.serializer(), reply)) }
                server = Backlinks.lists(reply) to BacklinksSource.SERVER
                readAt = null
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (error !is IOException && error !is ApiException) throw error
                val cached = runCatching { store.cachedBacklinks(noteId) }.getOrNull()
                val reply = cached?.let { row ->
                    runCatching { PenmossJson.decodeFromString(BacklinksReply.serializer(), row.json) }.getOrNull()
                }
                if (reply != null) {
                    server = Backlinks.lists(reply) to BacklinksSource.CACHED
                    readAt = cached.fetchedAt
                } else if (server == null) {
                    readAt = null
                }
            }
            state.update { it.copy(loading = false) }
            publish()
        }
    }

    private fun publish() {
        val current = server
        val view = backlinksView(current?.first, local, current?.second ?: BacklinksSource.LOCAL, readAt, recent)
        state.update { it.copy(view = if (current == null && it.loading && local.isEmpty()) null else view) }
    }
}

/** What the sheet says under Backlinks about where they came from; null when they are the server's. */
internal fun backlinksNote(view: BacklinksView?, now: Long = System.currentTimeMillis()): String? = when (view?.source) {
    null, BacklinksSource.SERVER -> null
    BacklinksSource.CACHED -> "Offline: as of ${shortWhen(view.readAt, now)}, with this phone's own links"
    BacklinksSource.LOCAL -> "Offline: from this phone. The text around each link and unlinked mentions need a connection."
}

/** The Info item in the note's top bar (NT23): the count of notes linking here as its badge. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun InfoButton(linked: Int, onClick: () -> Unit) {
    val description = when (linked) {
        0 -> "Info"
        1 -> "Info, linked from 1 note"
        else -> "Info, linked from $linked notes"
    }
    // Its name on a long press (T51, A936); it opens the note panel's Metadata tab.
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Below),
        tooltip = { PlainTooltip { Text("Info") } },
        state = rememberTooltipState(),
    ) {
        IconButton(onClick = onClick, modifier = Modifier.testTag("noteInfo").semantics { contentDescription = description }) {
            BadgedBox(badge = { if (linked > 0) Badge { Text(if (linked > 99) "99+" else linked.toString()) } }) {
                Icon(SettingsIcons.Info, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * The Info sheet (NT23): half height first, dragged to full. [titleOf] gives a linked note's
 * current title, for the links in the text around each backlink; [onOpen] opens a note (the
 * sheet closes first).
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun InfoSheet(
    noteId: String,
    rows: List<InfoRow>,
    tags: List<String>?,
    canTag: Boolean,
    fields: List<app.penmoss.engine.bridge.InfoField>?,
    backlinks: BacklinksUi,
    titleOf: (String) -> String?,
    onTags: () -> Unit,
    onOpen: (String) -> Unit,
    onDismiss: () -> Unit,
    now: Long = System.currentTimeMillis(),
    /** A daily or weekly note's label and period, shown first (A572, A653); null for any other note. */
    kind: InfoKind? = null,
    /** The note panel's Metadata tab (T51, A936), named by its tab, not a sheet of its own. */
    embedded: Boolean = false,
    /** The note's inline `#tags` ([inlineTags]): listed apart under its frontmatter tags (A502). */
    inline: List<String> = emptyList(),
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    SheetOrPanel(embedded, onDismiss, sheet, "infoSheet") {
        LazyColumn(
            Modifier.fillMaxWidth().navigationBarsPadding().testTag("infoList"),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (!embedded) item { SheetHeading("Info", large = true) }
            if (kind != null) {
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp).testTag("infoKind"),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            kind.label,
                            Modifier
                                .background(MaterialTheme.colorScheme.secondaryContainer, MaterialTheme.shapes.small)
                                .padding(horizontal = 10.dp, vertical = 4.dp),
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                            style = MaterialTheme.typography.labelLarge,
                        )
                        kind.period?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium) }
                    }
                }
            }
            val rowLabels = rows.map { it.label }
            items(rows) { row ->
                InfoPair(
                    row.label,
                    row.value,
                    rowLabels,
                    MaterialTheme.typography.bodyMedium,
                    Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp).testTag("infoRow-${row.label}"),
                )
            }
            item { SheetHeading("Tags") }
            item {
                FlowRow(
                    Modifier.fillMaxWidth().padding(horizontal = 24.dp).testTag("infoTags"),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    when {
                        tags == null -> Text("Opening the note…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        // Inline tags only: the line below lists them, so not "No tags yet." (A502).
                        tags.isEmpty() && inline.isEmpty() ->
                            Text("No tags yet.", Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else -> tags.forEach { tag -> Text("#$tag", Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.bodyMedium) }
                    }
                    if (canTag) {
                        AssistChip(onClick = onTags, label = { Text("Edit Tags…") }, modifier = Modifier.testTag("infoEditTags"))
                    }
                }
            }
            inlineTagsLine(if (tags == null) emptyList() else inline)?.let { line ->
                item {
                    Text(
                        line,
                        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp).testTag("infoInlineTags"),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            item { SheetHeading("Frontmatter") }
            val fieldKeys = fields.orEmpty().map { it.key }
            items(fields.orEmpty()) { field ->
                InfoPair(
                    field.key,
                    field.value,
                    fieldKeys,
                    MaterialTheme.typography.bodySmall,
                    Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 2.dp).testTag("frontmatter-${field.key}"),
                )
            }
            item { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            backlinksItems(noteId, backlinks, titleOf, onOpen, now)
        }
    }
}

/**
 * A label and its value, side by side with the label in 35% of the width; when the widest of
 * [labels] would not fit there on one line (large text, or the panel narrowed by its strip), every
 * label goes over its value instead, so none breaks inside a word (T53 pass).
 */
@Composable
private fun InfoPair(label: String, value: String, labels: List<String>, style: TextStyle, modifier: Modifier) {
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(modifier) {
        val widest = remember(labels, style, measurer) {
            labels.maxOfOrNull { measurer.measure(it, style, maxLines = 1, softWrap = false).size.width } ?: 0
        }
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        if (widest > constraints.maxWidth * LABEL_SHARE) {
            Column(Modifier.fillMaxWidth()) {
                Text(label, color = muted, style = style)
                Text(value, style = style)
            }
        } else {
            Row(Modifier.fillMaxWidth()) {
                Text(label, Modifier.weight(LABEL_SHARE), color = muted, style = style)
                Text(value, Modifier.weight(1f - LABEL_SHARE), style = style)
            }
        }
    }
}

private const val LABEL_SHARE = 0.35f

@Composable
private fun SheetHeading(text: String, large: Boolean = false) {
    Text(
        text,
        Modifier.padding(horizontal = 24.dp, vertical = if (large) 8.dp else 12.dp).semantics { heading() },
        style = if (large) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleSmall,
    )
}

/** The web's Backlinks panel, in its words: linked mentions with their text, then unlinked mentions. */
private fun androidx.compose.foundation.lazy.LazyListScope.backlinksItems(
    noteId: String,
    ui: BacklinksUi,
    titleOf: (String) -> String?,
    onOpen: (String) -> Unit,
    now: Long,
) {
    val view = ui.view
    val linked = view?.linked.orEmpty()
    val unlinked = view?.unlinked.orEmpty()
    val first = view == null && ui.loading
    item {
        Text(
            "Backlinks ${if (first) "…" else linked.size}",
            Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() }.testTag("backlinksHeading"),
            style = MaterialTheme.typography.titleMedium,
        )
    }
    backlinksNote(view, now)?.let { note ->
        item {
            Text(
                note,
                Modifier.padding(horizontal = 24.dp).testTag("backlinksNote"),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    item { SheetHeading("Linked mentions ${linked.size}") }
    if (linked.isEmpty()) {
        item { EmptyLine(if (first) "Looking for links…" else "No other notes link here yet.", "noLinkedMentions") }
    }
    items(linked, key = { "linked-${it.id}" }) { entry ->
        Column(Modifier.fillMaxWidth().clickable { onOpen(entry.id) }.heightIn(min = 48.dp).padding(horizontal = 24.dp, vertical = 8.dp).testTag("linked-${entry.id}")) {
            Text(entry.title.ifBlank { Items.UNTITLED }, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            for (mention in entry.mentions) {
                Text(
                    contextString(mention.context, mention.embed, noteId, titleOf),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
    item { SheetHeading("Unlinked mentions ${unlinked.size}") }
    if (unlinked.isEmpty()) {
        item { EmptyLine(if (first) "" else "No other notes mention this title.", "noUnlinkedMentions") }
    }
    items(unlinked, key = { "unlinked-${it.id}" }) { entry ->
        Column(Modifier.fillMaxWidth().clickable { onOpen(entry.id) }.heightIn(min = 48.dp).padding(horizontal = 24.dp, vertical = 8.dp).testTag("unlinked-${entry.id}")) {
            Text(entry.title.ifBlank { Items.UNTITLED }, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(
                buildAnnotatedString {
                    for (part in entry.snippet) {
                        if (part.match) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(part.text) } else append(part.text)
                    }
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun EmptyLine(text: String, tag: String) {
    Text(
        text,
        Modifier.padding(horizontal = 24.dp, vertical = 4.dp).testTag(tag),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * A backlink's text as the web shows it: links by their targets' current titles, the links to
 * this note marked (bold here, `<mark>` there), and "Embeds " before an embed's.
 */
internal fun contextString(
    context: List<ContextPart>,
    embed: Boolean,
    noteId: String,
    titleOf: (String) -> String?,
): AnnotatedString = buildAnnotatedString {
    if (embed) append("Embeds ")
    for (part in context) {
        when (part) {
            is ContextPart.Text -> append(part.text)
            is ContextPart.Link -> {
                val label = Backlinks.linkLabel(part.ref, part.ref.noteId?.let(titleOf))
                if (part.ref.noteId == noteId) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(label) } else append(label)
            }
        }
    }
}
