package app.penmoss.engine.tree

import org.junit.Assert.assertEquals
import org.junit.Test

class FolderTreeTest {
    private fun folder(id: String, name: String, parent: String? = null, position: String = "a0", mode: String = "manual") =
        FolderRow(id, name, parent, position, mode)

    private fun note(id: String, title: String, folder: String? = null, position: String = "a0", updated: Long = 0) =
        NoteRow(id, folder, position, title, updated)

    private fun contents(folderId: String?, root: String, folders: List<FolderRow>, notes: List<NoteRow>) =
        FolderTree.contents(folderId, root, folders, notes, { it }, { it })

    @Test
    fun manualOrderIsByPositionThenId() {
        val folders = listOf(folder("b", "B", position = "a1"), folder("a", "A", position = "a1"), folder("c", "C", position = "a0"))
        assertEquals(listOf("c", "a", "b"), contents(null, "manual", folders, emptyList()).folders.map { it.id })
    }

    @Test
    fun alphaComparesNumbersAsNumbersAndIgnoresCase() {
        val notes = listOf(note("1", "Note 10"), note("2", "note 9"), note("3", ""), note("4", "apple"))
        assertEquals(
            listOf("4", "2", "1", "3"),
            contents(null, "alpha", emptyList(), notes).notes.map { it.id },
        )
    }

    @Test
    fun modifiedIsNewestFirstAndSubfoldersByName() {
        val folders = listOf(folder("p", "Projects", mode = "modified"), folder("z", "Zoo", "p"), folder("a", "Art", "p", position = "a9"))
        val notes = listOf(note("old", "Old", "p", updated = 1), note("new", "New", "p", updated = 5))
        val inside = contents("p", "manual", folders, notes)
        assertEquals(listOf("a", "z"), inside.folders.map { it.id })
        assertEquals(listOf("new", "old"), inside.notes.map { it.id })
    }

    @Test
    fun positionsCompareAsJavaScriptStringsDo() {
        // Code-unit order: uppercase before lowercase, digits before letters.
        assertEquals(true, FolderTree.compareOrder("Zz", "x", "a0", "x") < 0)
        assertEquals(true, FolderTree.compareOrder("a0", "x", "a0V", "x") < 0)
    }

    /** A manual reorder (T40 P4, NT7): immediately before or after the anchor, or the end. */
    @Test
    fun reorderKeysBeforeAfterOrAtTheEnd() {
        val siblings = listOf(
            FolderTree.ReorderSibling("a", "a0"),
            FolderTree.ReorderSibling("b", "a1"),
            FolderTree.ReorderSibling("c", "a2"),
        )
        val before = FolderTree.reorderKey(siblings, "c", before = "a", after = null)
        assertEquals("a", before.before)
        assertEquals(null, before.after)
        assertEquals(true, before.position < "a0")
        val after = FolderTree.reorderKey(siblings, "a", before = null, after = "b")
        assertEquals(null, after.before)
        assertEquals("b", after.after)
        assertEquals(true, after.position > "a1" && after.position < "a2")
        // A missing anchor means the end, after the last sibling.
        val end = FolderTree.reorderKey(siblings, "a", before = "missing", after = null)
        assertEquals(null, end.before)
        assertEquals("c", end.after)
        assertEquals(true, end.position > "a2")
    }

    /** The phone's own optimistic keys still sort, but cannot bound a new key (T40 P4, A443). */
    @Test
    fun reorderKeysTolerateKeysTheServerCouldNeverHaveMade() {
        val siblings = listOf(
            FolderTree.ReorderSibling("a", "\uFFFF"),
            FolderTree.ReorderSibling("b", "\uFFFF\uFFFF"),
        )
        val key = FolderTree.reorderKey(siblings, "a", before = "b", after = null)
        assertEquals("b", key.before)
        assertEquals(true, OrderKeys.isValid(key.position))
    }

    /** Empty positions, before any tree arrived, reorder to a valid key (T40 P4, A443). */
    @Test
    fun reorderKeysFromNothingAreValid() {
        val siblings = listOf(
            FolderTree.ReorderSibling("a", ""),
            FolderTree.ReorderSibling("b", ""),
        )
        val key = FolderTree.reorderKey(siblings, "a", before = null, after = "b")
        assertEquals(true, OrderKeys.isValid(key.position))
    }
}
