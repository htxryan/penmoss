package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.notes.TagTree
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The tags the phone holds, offline (T40 P6, TG1–TG3): each note's tags from `/sync/changes`,
 * the page's own while edits are unsent, the tree they make, a tag's notes newest first, and
 * what a rename names, waits for and shows at once.
 */
@RunWith(AndroidJUnit4::class)
class TagStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private var clock = 0L

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 5_000 })
    }

    @After
    fun close() = db.close()

    private suspend fun note(id: String, updatedAt: Long, tags: List<String>, deleted: Boolean = false) {
        clock++
        store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote(id, clock, id, "", updatedAt, deleted, tags = tags))))
    }

    /** The tag sheet's suggestions (T42 on Android, TG6, A656): every note's tags, without the note's own. */
    @Test
    fun suggestsEveryTagOnAnyNoteButTheNotesOwn() = runTest {
        note("a", 3, listOf("garden", "area/cooking"))
        note("b", 2, listOf("gardening", "garden"))
        note("c", 1, listOf("wildgarden"))
        note("gone", 1, listOf("garden-secret"), deleted = true)
        val counts = store.observeTagCounts().first().map { it.tag to it.notes }
        val own = store.observeTagsOf("a").first()
        assertEquals(listOf("area/cooking", "garden"), own.sorted())
        val known = app.penmoss.engine.notes.Tags.everyTag(counts, emptyList()).filter { it.first !in own }
        // A note in Trash lends none of its tags.
        assertEquals(listOf("gardening", "wildgarden"), app.penmoss.engine.notes.Tags.suggest("gard", known, emptyList()))
    }

    @Test
    fun buildsTheTreeFromLiveNotesAndListsATagsNotesNewestFirst() = runTest {
        note("old", 10, listOf("area/cooking"))
        note("new", 30, listOf("area", "soup"))
        note("mid", 20, listOf("area_b"))
        note("pasta", 25, listOf("area/cooking/italian"))
        note("binned", 40, listOf("area"), deleted = true)
        note("x", 5, listOf("areaxb/x"))
        val tree = TagTree.build(store.observeNoteTags().first())
        assertEquals(listOf("area" to 3, "area_b" to 1, "areaxb" to 1, "soup" to 1), tree.map { it.tag to it.count })
        assertEquals(listOf("area/cooking" to 2), tree.first().children.map { it.tag to it.count })
        // `area` and what is under it, not `area_b`; and `_` is a letter in a tag, never LIKE's wildcard.
        assertEquals(listOf("new", "pasta", "old"), store.observeTagged("area").first().map { it.id })
        assertEquals(listOf("pasta", "old"), store.observeTagged("area/cooking").first().map { it.id })
        assertEquals(emptyList<String>(), store.observeTagged("area/c").first().map { it.id })
        assertEquals(listOf("mid"), store.observeTagged("area_b").first().map { it.id })
        assertEquals(listOf("mid"), store.taggedIds("area_b"))
    }

    @Test
    fun aRenameNamesTheNotesHeldWithTheTagAndWaitsForAnyUnsentEdit() = runTest {
        note("a", 10, listOf("soup"))
        note("b", 20, listOf("soup/hot"))
        note("c", 30, listOf("souper"))
        assertEquals(listOf("a", "b"), store.taggedIds("soup"))
        assertEquals(0, store.observeUnsent().first())
        // Any note's unsent edit counts (review S4): one typed offline on "c" may add #soup.
        store.addPending("c", "EDIT", "e1")
        assertEquals(1, store.observeUnsent().first())
        store.addPending("b", "EDIT", "e1")
        assertEquals(2, store.observeUnsent().first())
    }

    /** Review R2: an edit that can never be sent never blocks a rename; a waiting capture does. */
    @Test
    fun aRenameWaitsForSendableEditsAndCapturesNeverForKeptOnes() = runTest {
        note("a", 10, listOf("soup"))
        db.updates().insert(UpdateEntity(noteId = "a", state = UpdateEntity.KEPT, update = "OLD"))
        assertEquals(0, store.observeUnsent().first())
        // Kept apart as a conflict, it goes up as a copy, the old tag with it.
        db.updates().insert(UpdateEntity(noteId = "a", state = UpdateEntity.CONFLICT, update = "C"))
        assertEquals(1, store.observeUnsent().first())
        // A capture typed offline with the old tag brings it back the same way; a refused one never goes.
        db.captures().insert(CaptureEntity("c1", "pea #soup", "inbox", 0))
        db.captures().insert(CaptureEntity("c2", "#soup", "inbox", 0, refused = "too large"))
        assertEquals(2, store.observeUnsent().first())
    }

    /** Review S5: a tag typed on this phone shows at once, until a landed row once it is sent replaces it. */
    @Test
    fun thePagesTagsShowAtOnceAndALandedRowReplacesThemOnceSent() = runTest {
        note("a", 10, listOf("soup"))
        store.addPending("a", "EDIT", "e1")
        store.savePageText("a", "soup and #stew", "", listOf("soup", "stew"))
        assertEquals(listOf("soup", "stew"), db.search().tagsOf("a"))
        assertEquals(listOf("a"), store.observeTagged("stew").first().map { it.id })
        // A row from before the server has the edit leaves the phone's own tags.
        note("a", 20, listOf("soup"))
        assertEquals(listOf("soup", "stew"), db.search().tagsOf("a"))
        // Once it is sent, the server's rows have the last word again.
        db.updates().delete(db.updates().updates("a", UpdateEntity.PENDING).map { it.id })
        note("a", 30, listOf("soup", "stew", "broth"))
        assertEquals(listOf("broth", "soup", "stew"), db.search().tagsOf("a"))
    }

    /** Review S5: a rename shows at once on the notes the server named, the tags under it too. */
    @Test
    fun aRenameShowsAtOnceOnTheNotesTheServerNamed() = runTest {
        note("a", 10, listOf("soup", "soup/hot", "souper"))
        note("b", 20, listOf("soup", "stew"))
        note("c", 30, listOf("soup"))
        store.renameTagLocally("soup", "stew", listOf("a", "b"))
        assertEquals(listOf("souper", "stew", "stew/hot"), db.search().tagsOf("a"))
        // Merged into a tag the note had: once.
        assertEquals(listOf("stew"), db.search().tagsOf("b"))
        // Not named by the server: left for its row.
        assertEquals(listOf("soup"), db.search().tagsOf("c"))
    }
}
