package app.penmoss.ui

import app.penmoss.data.DirectoryRow
import app.penmoss.data.FolderEntity
import app.penmoss.data.GraphSource
import app.penmoss.data.NoteLinkEntity
import app.penmoss.engine.bridge.GraphGroup
import app.penmoss.engine.bridge.GraphNote
import app.penmoss.engine.bridge.GraphScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The graph's input from Room (T40 P7, LK7, LK8; A478, A479), as the web's `graphInput` builds
 * it: notes coloured by their top-level folder in the lists' order, links between live notes
 * only, and where the graph opens.
 */
class GraphInputTest {
    private val folders = listOf(
        FolderEntity("projects", "Projects", null, "a", "manual"),
        FolderEntity("areas", "Areas", null, "b", "manual"),
        FolderEntity("garden", "Garden", "projects", "a", "manual"),
        FolderEntity("beds", "Beds", "garden", "a", "manual"),
    )

    private fun source(notes: List<DirectoryRow>, links: List<NoteLinkEntity> = emptyList(), mode: String = "manual") =
        GraphSource(notes, links, folders, mode)

    @Test
    fun coloursEachNoteByItsTopLevelFolderInTheListsOrder() {
        val model = GraphInput.model(
            source(
                listOf(
                    DirectoryRow("n1", "Tomatoes", "beds"),
                    DirectoryRow("n2", "  ", null),
                    DirectoryRow("n3", "Plan", "areas"),
                    DirectoryRow("n4", "Lost", "gone-folder"),
                ),
            ),
        )
        assertEquals(
            listOf(
                GraphNote("n1", "Tomatoes", "projects", emptyList()),
                GraphNote("n2", "", null, emptyList()),
                GraphNote("n3", "Plan", "areas", emptyList()),
                GraphNote("n4", "Lost", null, emptyList()),
            ),
            model.message.notes,
        )
        // Manual order: Projects before Areas, then the top level, as the lists show them.
        assertEquals(
            listOf(GraphGroup("projects", "Projects"), GraphGroup("areas", "Areas"), GraphGroup(null, "Top level")),
            model.message.groups,
        )
        // The search field names an untitled note as the lists do.
        assertEquals("Untitled", model.titleOf("n2"))
        // A–Z order follows the root's sort.
        assertEquals(
            listOf("areas", "projects", null),
            GraphInput.model(source(emptyList(), mode = "alpha")).message.groups.map { it.id },
        )
    }

    @Test
    fun sendsOnlyTheLinksBetweenNotesItShows() {
        val model = GraphInput.model(
            source(
                listOf(DirectoryRow("a", "A", null), DirectoryRow("b", "B", null)),
                listOf(
                    NoteLinkEntity("a", "b"),
                    NoteLinkEntity("a", "a"),
                    // A note in Trash or not on the phone: not in the graph.
                    NoteLinkEntity("a", "trashed"),
                    NoteLinkEntity("trashed", "b"),
                ),
            ),
        )
        assertEquals(listOf(listOf("b"), emptyList()), model.message.notes.map { it.links })
    }

    @Test
    fun aFolderCycleStopsWhereItRepeats() {
        val cycle = listOf(
            FolderEntity("x", "X", "y", "a", "manual"),
            FolderEntity("y", "Y", "x", "b", "manual"),
        )
        val top = GraphInput.topLevelOf(cycle)
        assertEquals(setOf("x", "y"), top.keys)
    }

    @Test
    fun opensAroundTheNoteAskedOrTheNewestPastFifteenHundredNotes() {
        val few = GraphInput.model(source(listOf(DirectoryRow("new", "New", null), DirectoryRow("old", "Old", null))))
        assertEquals(GraphStart(GraphScope.Global, large = false), GraphInput.start(few, null))
        assertEquals(GraphStart(GraphScope.Local("old", 2), large = false), GraphInput.start(few, "old"))
        val many = GraphInput.model(source(List(GraphInput.LARGE + 1) { DirectoryRow("n$it", "Note $it", null) }))
        assertEquals(GraphStart(GraphScope.Local("n0", 2), large = true), GraphInput.start(many, null))
        val exactly = GraphInput.model(source(List(GraphInput.LARGE) { DirectoryRow("n$it", "Note $it", null) }))
        assertEquals(GraphScope.Global, GraphInput.start(exactly, null).scope)
    }

    @Test
    fun findsNotesStartingWithWhatIsTypedFirst() {
        val model = GraphInput.model(
            source(
                listOf(
                    DirectoryRow("1", "Raised beds", null),
                    DirectoryRow("2", "Beds", null),
                    DirectoryRow("3", "Compost", null),
                    DirectoryRow("4", "beds and paths", null),
                ),
            ),
        )
        assertEquals(listOf("2", "4", "1"), GraphInput.matches(model, " BEDS ").map { it.id })
        assertEquals(emptyList<GraphEntry>(), GraphInput.matches(model, "  "))
        assertEquals(1, GraphInput.matches(model, "beds", limit = 1).size)
    }

    @Test
    fun countsInTheWebsWords() {
        assertEquals("1 note · 1 link", GraphInput.count(1, 1))
        assertEquals("6 notes · 0 links", GraphInput.count(6, 0))
    }

    @Test
    fun aBurstOfChangesSendsTheGraphOnceMoreNotOncePerChange() = runTest {
        val changes = flow {
            emit(1)
            // A sync storing pages in a row: only the last of a burst is laid out.
            repeat(5) {
                delay(10)
                emit(2 + it)
            }
            delay(1_000)
            emit(7)
        }
        assertEquals(listOf(1, 6, 7), changes.atMostEvery(GRAPH_BATCH_MS).toList())
    }
}
