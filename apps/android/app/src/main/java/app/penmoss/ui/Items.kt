package app.penmoss.ui

import androidx.compose.runtime.Immutable
import app.penmoss.data.FolderEntity
import app.penmoss.data.NoteListRow
import app.penmoss.engine.tree.FolderRow
import app.penmoss.engine.tree.FolderTree
import app.penmoss.engine.tree.NoteRow
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * A note as the lists show it, with every string worked out before it reaches
 * Compose (off the main thread), so a row does no formatting while it scrolls.
 */
@Immutable
data class NoteItem(val id: String, val title: String, val excerpt: String, val date: String)

/**
 * A folder as the lists show it. [notebook]: a notebook's own folder (T43, A750); [canBeNotebook]:
 * a top-level folder that Turn into notebook may flag (not one holding Journal or the Inbox).
 */
@Immutable
data class FolderItem(val id: String, val name: String, val notebook: Boolean = false, val canBeNotebook: Boolean = false)

/**
 * A row of the folder picker (T38): the top level (null id), or a folder at its depth in the tree,
 * with its parent's name ([parent], null for a top-level folder) for TalkBack. With notebooks
 * (T43), [group] names the notebook the row is in, and [notebook] marks a notebook's own folder.
 */
@Immutable
data class FolderChoice(
    val id: String?,
    val name: String,
    val depth: Int,
    val parent: String? = null,
    val group: String? = null,
    val notebook: Boolean = false,
)

object Items {
    const val UNTITLED = "Untitled"
    private const val EXCERPT_CHARS = 140

    fun notes(rows: List<NoteListRow>, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<NoteItem> {
        val dates = DateLabels(now, zone)
        return rows.map { note(it, dates) }
    }

    fun note(row: NoteListRow, dates: DateLabels): NoteItem = NoteItem(
        id = row.id,
        title = row.title.ifBlank { UNTITLED },
        excerpt = row.excerpt.replace(WHITESPACE, " ").trim().take(EXCERPT_CHARS),
        date = if (row.updatedAt > 0) dates.label(row.updatedAt) else "",
    )

    /** A folder's subfolders and notes in the order every client shows them (A17). */
    fun folder(
        folderId: String?,
        rootSortMode: String,
        folders: List<FolderEntity>,
        notes: List<NoteListRow>,
        now: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Pair<List<FolderItem>, List<NoteItem>> {
        val contents = FolderTree.contents(
            folderId,
            rootSortMode,
            folders,
            notes,
            { FolderRow(it.id, it.name, it.parentId, it.position, it.sortMode) },
            { NoteRow(it.id, it.folderId, it.position, it.title, it.updatedAt) },
        )
        val dates = DateLabels(now, zone)
        return contents.folders.map { item(it, folders) } to contents.notes.map { note(it, dates) }
    }

    /**
     * A folder path as the bars show it: "Projects › Penmoss", or Top level. Each name is isolated
     * (FSI…PDI) so a name with a bidi override can't reorder the others (T39 pass 3 review, A907).
     */
    fun pathText(names: List<String>): String =
        if (names.isEmpty()) TOP_LEVEL else names.joinToString(" › ") { "\u2068${it.ifBlank { "Untitled folder" }}\u2069" }

    /** A folder's row, with what notebooks need of it (T43). */
    fun item(folder: FolderEntity, folders: List<FolderEntity>): FolderItem = FolderItem(
        folder.id,
        folder.name.ifBlank { "Untitled folder" },
        notebook = folder.notebook,
        canBeNotebook = !folder.notebook && folder.parentId == null && !app.penmoss.data.Notebooks.holdsJournal(folders, folder.id),
    )

    /**
     * Home's top (T43, A750): the notebooks open on this phone, in the top level's order, and the
     * default notebook's top-level folders. A closed notebook is not listed (A752).
     */
    fun home(rootSortMode: String, folders: List<FolderEntity>, closed: Set<String>, now: Long): Pair<List<FolderItem>, List<FolderItem>> {
        val (top, _) = folder(null, rootSortMode, folders, emptyList(), now)
        return top.filter { it.notebook && it.id !in closed } to top.filterNot { it.notebook }
    }

    /**
     * Every folder as the picker shows it (T38): the top level first, then the tree depth first,
     * each folder's subfolders in that folder's own order, as the lists show them (A17).
     */
    fun folderChoices(
        rootSortMode: String,
        folders: List<FolderEntity>,
        /** The default notebook's name, which heads its group once there are notebooks (T43). */
        defaultNotebook: String = app.penmoss.data.Notebooks.DEFAULT_NAME,
    ): List<FolderChoice> {
        if (folders.none { it.notebook && it.parentId == null }) return plainChoices(rootSortMode, folders)
        // Grouped by notebook (T43, A750): the default notebook's top level and folders, then
        // each notebook, its own folder the root of its group.
        val plain = plainChoices(rootSortMode, folders)
        val notebooks = plain.filter { it.depth == 0 && it.id != null && folders.any { f -> f.id == it.id && f.notebook } }.map { it.id }.toSet()
        val out = mutableListOf<FolderChoice>()
        var current: String? = null
        val inNotebook = mutableListOf<FolderChoice>()
        for (choice in plain) {
            if (choice.depth == 0) current = choice.id?.takeIf { it in notebooks }
            if (current == null) {
                out += choice.copy(group = defaultNotebook)
            } else {
                val root = choice.id == current
                inNotebook += choice.copy(group = plain.first { it.id == current }.name, notebook = root)
            }
        }
        return out + inNotebook
    }

    private fun plainChoices(rootSortMode: String, folders: List<FolderEntity>): List<FolderChoice> {
        val out = mutableListOf(FolderChoice(null, TOP_LEVEL, 0))
        val seen = HashSet<String>()
        fun visit(parentId: String?, parentName: String?, depth: Int) {
            val children = FolderTree.contents(
                parentId,
                rootSortMode,
                folders,
                emptyList<FolderEntity>(),
                { FolderRow(it.id, it.name, it.parentId, it.position, it.sortMode) },
                { error("no notes") },
            ).folders
            for (folder in children) {
                // The server resolves cycles (A17); this only keeps a bad tree from looping.
                if (!seen.add(folder.id)) continue
                val name = folder.name.ifBlank { "Untitled folder" }
                out += FolderChoice(folder.id, name, depth, parentName)
                visit(folder.id, name, depth + 1)
            }
        }
        visit(null, null, 0)
        return out
    }

    const val TOP_LEVEL = "Top level"

    /**
     * Every folder as the move picker shows it (T40 P4, NT5), except [exclude] and the folders
     * below it: a folder cannot move into itself or one of its subfolders (the server refuses
     * those too). The top level stays, as every folder may move there.
     */
    fun folderChoicesExcluding(
        rootSortMode: String,
        folders: List<FolderEntity>,
        exclude: String,
        defaultNotebook: String = app.penmoss.data.Notebooks.DEFAULT_NAME,
    ): List<FolderChoice> {
        val doomed = HashSet<String>()
        val queue = ArrayDeque<String>()
        queue += exclude
        // A notebook stays at the top level; Journal and the Inbox, and every folder in them at any
        // depth, never go into a notebook (T43, A750, review S4).
        val moving = folders.firstOrNull { it.id == exclude }
        if (moving?.notebook == true) return listOf(FolderChoice(null, TOP_LEVEL, 0))
        if (app.penmoss.data.Notebooks.staysInDefault(folders, exclude)) {
            val index = app.penmoss.data.Notebooks.index(folders)
            folders.filter { index.ofFolder(it.id) != null }.forEach { doomed += it.id }
        }
        while (queue.isNotEmpty()) {
            val id = queue.removeFirst()
            if (!doomed.add(id)) continue
            for (child in folders.filter { it.parentId == id }) queue += child.id
        }
        return folderChoices(rootSortMode, folders.filter { it.id !in doomed }, defaultNotebook)
    }

    /**
     * A folder's path from the top (T40 P4, NT11): the chain of its parents, root first, for the
     * breadcrumb. A cycle or an unknown folder ends the path, as the lists do (A17).
     */
    fun folderPath(folders: List<FolderEntity>, folderId: String?): List<FolderItem> {
        if (folderId == null) return emptyList()
        val byId = folders.associateBy { it.id }
        val chain = mutableListOf<FolderItem>()
        var current: String? = folderId
        val seen = HashSet<String>()
        while (current != null && seen.add(current)) {
            val folder = byId[current] ?: break
            chain += FolderItem(folder.id, folder.name.ifBlank { "Untitled folder" })
            current = folder.parentId
        }
        return chain.reversed()
    }

    /** Search snippets mark matches with U+0002…U+0003; the list shows plain text. */
    fun plainSnippet(snippet: String): String = snippetMatches(snippet).first

    /**
     * A search snippet's plain text and where it matched (T39), from its U+0002…U+0003 marks,
     * so a result can show the matching words. A mark left open runs to the end.
     */
    fun snippetMatches(snippet: String): Pair<String, List<IntRange>> {
        val text = StringBuilder(snippet.length)
        val matches = mutableListOf<IntRange>()
        var start = -1
        for (char in snippet) {
            when (char) {
                '\u0002' -> if (start < 0) start = text.length
                '\u0003' -> if (start >= 0) {
                    if (text.length > start) matches += start until text.length
                    start = -1
                }
                else -> text.append(char)
            }
        }
        if (start >= 0 && text.length > start) matches += start until text.length
        return text.toString() to matches
    }

    private val WHITESPACE = Regex("\\s+")
}

/** "3:42 PM" today, "Oct 21" this year, "Oct 21, 2025" before. */
class DateLabels(now: Long, private val zone: ZoneId) {
    private val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    private val time = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())
    private val day = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
    private val full = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.getDefault())

    fun label(at: Long): String {
        val moment = Instant.ofEpochMilli(at).atZone(zone)
        val date = moment.toLocalDate()
        return when {
            date == today -> time.format(moment)
            date.year == today.year -> day.format(moment)
            else -> full.format(moment)
        }
    }
}
