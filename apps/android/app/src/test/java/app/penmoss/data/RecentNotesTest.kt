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

/** Recent notes (T40 P6, FD7): opened here or edited anywhere, whichever is later, as the web ranks them. */
@RunWith(AndroidJUnit4::class)
class RecentNotesTest {
    private lateinit var db: PenmossDatabase
    private var now = 0L
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { now })
    }

    @After
    fun close() = db.close()

    @Test
    fun aNoteOpenedHereRisesAboveNotesEditedBeforeIt() = runTest {
        store.saveChanges(
            ChangesPage(
                3,
                notes = listOf(
                    ChangedNote("old", 1, "Old", "", updatedAt = 100),
                    ChangedNote("mid", 2, "Mid", "", updatedAt = 200),
                    ChangedNote("new", 3, "New", "", updatedAt = 300),
                ),
            ),
        )
        assertEquals(listOf("new", "mid", "old"), store.observeRecent(10).first().map { it.id })
        // Opened here, never edited: it comes first.
        now = 400
        store.markOpened("old")
        assertEquals(listOf("old", "new", "mid"), store.observeRecent(10).first().map { it.id })
        // Edited elsewhere later still: that edit wins.
        store.saveChanges(ChangesPage(4, notes = listOf(ChangedNote("mid", 4, "Mid", "", updatedAt = 500))))
        assertEquals(listOf("mid", "old", "new"), store.observeRecent(10).first().map { it.id })
        // An older open never moves a note back; the limit holds.
        now = 50
        store.markOpened("mid")
        assertEquals(500L, maxOf(store.note("mid")!!.openedAt, store.note("mid")!!.updatedAt))
        assertEquals(listOf("mid", "old"), store.observeRecent(2).first().map { it.id })
    }

    @Test
    fun notesInTrashAreNotRecent() = runTest {
        store.saveChanges(ChangesPage(2, notes = listOf(ChangedNote("a", 1, "A", "", 100), ChangedNote("b", 2, "B", "", 200, deleted = true))))
        now = 900
        store.markOpened("b")
        assertEquals(listOf("a"), store.observeRecent(10).first().map { it.id })
    }
}
