package app.penmoss.engine.tree

import java.text.Collator
import java.util.Locale

/** A folder as the device stores it; `parentId` is the parent the tree shows (A17, A281). */
data class FolderRow(
    val id: String,
    val name: String,
    val parentId: String?,
    val position: String,
    val sortMode: String,
)

/** A note's place in the tree, with what sorting needs. */
data class NoteRow(
    val id: String,
    val folderId: String?,
    val position: String,
    val title: String,
    val updatedAt: Long,
)

data class FolderContents<F, N>(val folders: List<F>, val notes: List<N>)

/**
 * Display order, as every client sorts (packages/core/src/workspace/tree.ts):
 * `manual` by fractional position then id; `alpha` by name or title (numbers
 * compared as numbers, case and accents ignored, an empty title as
 * "Untitled"); `modified` newest first. Subfolders sort by name in alpha and
 * modified modes (folders have no modified time). The server resolves the
 * tree's parents, so this only orders siblings.
 */
object FolderTree {
    const val MANUAL = "manual"
    const val ALPHA = "alpha"
    const val MODIFIED = "modified"

    fun <F, N> contents(
        folderId: String?,
        rootSortMode: String,
        folders: List<F>,
        notes: List<N>,
        folderRow: (F) -> FolderRow,
        noteRow: (N) -> NoteRow,
    ): FolderContents<F, N> {
        val mode = if (folderId == null) {
            rootSortMode
        } else {
            folders.firstOrNull { folderRow(it).id == folderId }?.let { folderRow(it).sortMode } ?: MANUAL
        }
        val childFolders = folders.filter { folderRow(it).parentId == folderId }
            .sortedWith { a, b -> compareFolders(mode, folderRow(a), folderRow(b)) }
        val childNotes = notes.filter { noteRow(it).folderId == folderId }
            .sortedWith { a, b -> compareNotes(mode, noteRow(a), noteRow(b)) }
        return FolderContents(childFolders, childNotes)
    }

    fun compareFolders(mode: String, a: FolderRow, b: FolderRow): Int = when (mode) {
        MANUAL -> compareOrder(a.position, a.id, b.position, b.id)
        else -> natural(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }

    fun compareNotes(mode: String, a: NoteRow, b: NoteRow): Int = when (mode) {
        ALPHA -> natural(a.title.ifEmpty { UNTITLED }, b.title.ifEmpty { UNTITLED }).takeIf { it != 0 }
            ?: a.id.compareTo(b.id)
        MODIFIED -> b.updatedAt.compareTo(a.updatedAt).takeIf { it != 0 } ?: a.id.compareTo(b.id)
        else -> compareOrder(a.position, a.id, b.position, b.id)
    }

    /** Fractional keys compare as strings (UTF-16 code units, as JavaScript does), ties by id. */
    fun compareOrder(aPosition: String, aId: String, bPosition: String, bId: String): Int =
        aPosition.compareTo(bPosition).takeIf { it != 0 } ?: aId.compareTo(bId)

    /** A sibling's place in a manual order: its id and order key. */
    data class ReorderSibling(val id: String, val position: String)

    /** An optimistic order key and the normalized anchors to send as `place` (NT7). */
    data class ReorderKey(val position: String, val before: String?, val after: String?)

    /**
     * The key for moving [exclude] among [siblings] (its current siblings, itself included):
     * immediately before or after the anchor, as asked. A missing or foreign anchor means the
     * end (so a stale view never writes a stale key); `before` wins when both are given.
     *
     * The bounds are the nearest valid keys around the insertion point: the phone's own
     * optimistic keys (an end key pasted past the last row) still sort, but the server could
     * never have made them, so they cannot bound a new key.
     */
    fun reorderKey(siblings: List<ReorderSibling>, exclude: String, before: String?, after: String?): ReorderKey {
        val others = siblings.filter { it.id != exclude }.sortedWith { a, b -> compareOrder(a.position, a.id, b.position, b.id) }
        val ids = others.map { it.id }.toSet()
        val anchorBefore = before?.takeIf { it != exclude && it in ids }
        val anchorAfter = if (anchorBefore == null) after?.takeIf { it != exclude && it in ids } else null
        val index = when {
            anchorBefore != null -> others.indexOfFirst { it.id == anchorBefore }
            anchorAfter != null -> others.indexOfFirst { it.id == anchorAfter } + 1
            else -> others.size
        }
        var lo: String? = null
        for (i in index - 1 downTo 0) {
            val position = others[i].position
            if (OrderKeys.isValid(position)) {
                lo = position
                break
            }
        }
        var hi: String? = null
        for (i in index until others.size) {
            val position = others[i].position
            if (OrderKeys.isValid(position)) {
                hi = position
                break
            }
        }
        val position = OrderKeys.keyBetween(lo, hi)
        return ReorderKey(position, anchorBefore, if (anchorBefore == null) anchorAfter ?: others.lastOrNull()?.id else null)
    }

    private const val UNTITLED = "Untitled"
    private val collator: Collator = Collator.getInstance(Locale.ROOT).apply { strength = Collator.PRIMARY }

    /** Like `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`: digit runs compare as numbers. */
    fun natural(a: String, b: String): Int {
        val left = chunks(a)
        val right = chunks(b)
        for (i in 0 until minOf(left.size, right.size)) {
            val x = left[i]
            val y = right[i]
            val result = if (x.first().isDigit() && y.first().isDigit()) {
                x.trimStart('0').length.compareTo(y.trimStart('0').length).takeIf { it != 0 }
                    ?: x.trimStart('0').compareTo(y.trimStart('0'))
            } else {
                collator.compare(x, y)
            }
            if (result != 0) return result
        }
        return left.size.compareTo(right.size)
    }

    private fun chunks(text: String): List<String> {
        if (text.isEmpty()) return emptyList()
        val out = mutableListOf<String>()
        var start = 0
        for (i in 1..text.length) {
            if (i == text.length || text[i].isDigit() != text[start].isDigit()) {
                out += text.substring(start, i)
                start = i
            }
        }
        return out
    }
}
