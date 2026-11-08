package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The graph's source in Room (T40 P7, LK7, A478): live notes newest first, their links, the
 * folders. A note in Trash is not drawn (the server sends it with no links, A473).
 */
@RunWith(AndroidJUnit4::class)
class GraphStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1_000 })
    }

    @After
    fun close() = db.close()

    private fun row(id: String, clock: Long, links: List<String>, deleted: Boolean = false) =
        ChangedNote(id, clock, id.replaceFirstChar { it.uppercase() }, "", clock, deleted = deleted, seq = clock, links = links)

    @Test
    fun readsTheLiveNotesTheirLinksAndTheFoldersOffline() = runTest {
        db.folders().put(FolderEntity("f1", "Projects", null, "a", "manual"))
        store.saveChanges(
            ChangesPage(
                3,
                notes = listOf(row("garden", 1, listOf("beds")), row("beds", 2, emptyList()), row("bin", 3, emptyList(), deleted = true)),
            ),
        )
        val source = store.observeGraph().first()
        assertEquals(listOf("beds", "garden"), source.notes.map { it.id })
        assertEquals(listOf(NoteLinkEntity("garden", "beds")), source.links)
        assertEquals(listOf("f1"), source.folders.map { it.id })
        assertEquals("manual", source.rootSortMode)
    }
}
