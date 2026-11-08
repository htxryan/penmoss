package app.penmoss

import app.penmoss.data.FolderEntity
import app.penmoss.data.NoteListRow
import app.penmoss.ui.DateLabels
import app.penmoss.ui.Items
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneOffset

class ItemsTest {
    private val zone = ZoneOffset.UTC
    private fun at(text: String) = LocalDateTime.parse(text).toInstant(zone).toEpochMilli()

    @Test
    fun labelsDatesByHowLongAgo() {
        val labels = DateLabels(at("2026-10-23T15:00:00"), zone)
        assertEquals("9:05 AM", labels.label(at("2026-10-23T09:05:00")).replace(' ', ' '))
        assertEquals("Oct 21", labels.label(at("2026-10-21T09:05:00")))
        assertEquals("Dec 31, 2025", labels.label(at("2025-12-31T09:05:00")))
    }

    @Test
    fun showsUntitledNotesAndOneLineExcerpts() {
        val item = Items.notes(listOf(NoteListRow("a", " ", "two\n\nlines   here", 0, null, "")), now = 0, zone = zone).single()
        assertEquals("Untitled", item.title)
        assertEquals("two lines here", item.excerpt)
        assertEquals("", item.date)
    }

    @Test
    fun ordersAFolderAsTheTreeDoes() {
        val folders = listOf(
            FolderEntity("p", "Projects", null, "a1", "alpha"),
            FolderEntity("z", "Zoo", "p", "a0", "manual"),
            FolderEntity("b", "Books", "p", "a1", "manual"),
        )
        val notes = listOf(
            NoteListRow("n2", "beta", "", 0, "p", "a0"),
            NoteListRow("n1", "Alpha", "", 0, "p", "a1"),
        )
        val (subfolders, filed) = Items.folder("p", "manual", folders, notes, now = 0, zone = zone)
        assertEquals(listOf("Books", "Zoo"), subfolders.map { it.name })
        assertEquals(listOf("n1", "n2"), filed.map { it.id })
    }

    @Test
    fun stripsSearchMatchMarkers() {
        assertEquals("a garden plan", Items.plainSnippet("a \u0002garden\u0003 plan"))
    }

    /** The breadcrumb (T40 P4, NT11): the folder's path from the top, root first. */
    @Test
    fun readsAFoldersPathFromTheTop() {
        val folders = listOf(
            FolderEntity("p", "Projects", null, "a0", "manual"),
            FolderEntity("q", "Penmoss", "p", "a0", "manual"),
            FolderEntity("z", "Zoo", null, "a1", "manual"),
        )
        assertEquals(listOf("Projects", "Penmoss"), Items.folderPath(folders, "q").map { it.name })
        assertEquals(listOf("Projects"), Items.folderPath(folders, "p").map { it.name })
        assertEquals(emptyList<String>(), Items.folderPath(folders, null).map { it.name })
        // An unknown folder, or a cycle, ends the path instead of looping.
        assertEquals(emptyList<String>(), Items.folderPath(folders, "missing").map { it.name })
        val cyclic = listOf(
            FolderEntity("a", "A", "b", "a0", "manual"),
            FolderEntity("b", "B", "a", "a1", "manual"),
        )
        assertEquals(listOf("B", "A"), Items.folderPath(cyclic, "a").map { it.name })
    }

    /** The move picker (T40 P4, NT5): without the folder itself and its subfolders. */
    @Test
    fun excludesAFolderAndItsSubfoldersFromItsMoveTargets() {
        val folders = listOf(
            FolderEntity("p", "Projects", null, "a0", "manual"),
            FolderEntity("q", "Penmoss", "p", "a0", "manual"),
            FolderEntity("z", "Zoo", null, "a1", "manual"),
        )
        val choices = Items.folderChoicesExcluding("manual", folders, "p")
        assertEquals(listOf(null, "z"), choices.map { it.id })
        assertEquals(listOf(null, "p", "q", "z"), Items.folderChoices("manual", folders).map { it.id })
    }

    /** Search results show where the words matched (T39): the marked ranges of the plain text. */
    @Test
    fun findsWhereASnippetMatched() {
        val (text, matches) = Items.snippetMatches("…the \u0002garden\u0003 hose and the \u0002Garden\u0003 plan")
        assertEquals("…the garden hose and the Garden plan", text)
        assertEquals(listOf(5 until 11, 25 until 31), matches)
        assertEquals("garden", text.substring(matches[0].first, matches[0].last + 1))
        // A marker left open (a cut snippet) runs to the end; none at all is no match.
        assertEquals(listOf(2 until 6), Items.snippetMatches("a \u0002plan").second)
        assertEquals(emptyList<IntRange>(), Items.snippetMatches("plain text").second)
    }
}
