package app.penmoss.ui

import androidx.compose.runtime.Immutable
import app.penmoss.data.DirectoryRow
import app.penmoss.data.FolderEntity
import app.penmoss.data.GraphSource
import app.penmoss.engine.bridge.GraphGroup
import app.penmoss.engine.bridge.GraphNote
import app.penmoss.engine.bridge.GraphScope
import app.penmoss.engine.bridge.ToGraph
import app.penmoss.engine.tree.FolderRow
import app.penmoss.engine.tree.FolderTree

/** A note the graph's search field can find. */
@Immutable
data class GraphEntry(val id: String, val title: String)

/** The graph page's input, worked out off the main thread (T40 P7, A478). */
@Immutable
data class GraphModel(
    val message: ToGraph.Graph,
    /** Every live note, newest first: the search field's list and the large vault's start. */
    val entries: List<GraphEntry>,
) {
    val ids: Set<String> = entries.mapTo(HashSet()) { it.id }

    fun titleOf(id: String): String? = entries.firstOrNull { it.id == id }?.title
}

/** Where the graph opens: [large] when it opened local because the vault is big (A479). */
data class GraphStart(val scope: GraphScope, val large: Boolean)

/**
 * The graph's data from Room (T40 P7, LK7, LK8; A478), as the web's `graphInput` builds it:
 * each note with the notes it links to and its top-level folder for colour, the top-level
 * folders in the lists' order then the top level, so colours match the web's.
 */
object GraphInput {
    /** Past this many notes the graph opens local (A479): a phone draws a big one slowly. */
    const val LARGE = 1_500

    /** The local graph's depth when it opens, as the web's. */
    const val DEFAULT_DEPTH = 2

    /** At most this many notes in the search field's list. */
    const val MATCHES = 6

    fun model(source: GraphSource): GraphModel {
        val live = source.notes.mapTo(HashSet()) { it.id }
        val linksOf = source.links
            .filter { it.sourceId in live && it.targetId in live && it.sourceId != it.targetId }
            .groupBy({ it.sourceId }, { it.targetId })
        val top = topLevelOf(source.folders)
        val notes = source.notes.map { row ->
            GraphNote(
                row.id,
                row.title.trim(),
                row.folderId?.let(top::get),
                linksOf[row.id].orEmpty().distinct().sorted(),
            )
        }
        val folders = FolderTree.contents(
            null,
            source.rootSortMode,
            source.folders,
            emptyList<FolderEntity>(),
            { FolderRow(it.id, it.name, it.parentId, it.position, it.sortMode) },
            { error("no notes") },
        ).folders
        val groups = folders.map { GraphGroup(it.id, it.name.ifBlank { "Untitled folder" }) } + GraphGroup(null, Items.TOP_LEVEL)
        return GraphModel(
            ToGraph.Graph(notes, groups),
            source.notes.map { GraphEntry(it.id, it.title.ifBlank { Items.UNTITLED }) },
        )
    }

    /** Each folder's top-level ancestor (itself at the top level); a cycle stops where it repeats. */
    fun topLevelOf(folders: List<FolderEntity>): Map<String, String> {
        val parents = folders.associate { it.id to it.parentId }
        return folders.associate { folder ->
            var current = folder.id
            val seen = hashSetOf(current)
            while (true) {
                val parent = parents[current] ?: break
                if (parent !in parents || !seen.add(parent)) break
                current = parent
            }
            folder.id to current
        }
    }

    /**
     * Where the graph opens (A479): around [note] when it was asked from a note; around the
     * newest note when the vault is past [LARGE]; else every note.
     */
    fun start(model: GraphModel, note: String?): GraphStart = when {
        note != null -> GraphStart(GraphScope.Local(note, DEFAULT_DEPTH), large = false)
        model.entries.size > LARGE -> GraphStart(GraphScope.Local(model.entries.first().id, DEFAULT_DEPTH), large = true)
        else -> GraphStart(GraphScope.Global, large = false)
    }

    /** The notes whose title contains [query], those starting with it first, then newest first. */
    fun matches(model: GraphModel, query: String, limit: Int = MATCHES): List<GraphEntry> {
        val wanted = query.trim().lowercase()
        if (wanted.isEmpty()) return emptyList()
        val found = model.entries.filter { it.title.lowercase().contains(wanted) }
        return found.sortedBy { if (it.title.lowercase().startsWith(wanted)) 0 else 1 }.take(limit)
    }

    /** "6 notes · 4 links", as the web's graph counts them. */
    fun count(notes: Int, links: Int): String =
        "${if (notes == 1) "1 note" else "$notes notes"} · ${if (links == 1) "1 link" else "$links links"}"
}
