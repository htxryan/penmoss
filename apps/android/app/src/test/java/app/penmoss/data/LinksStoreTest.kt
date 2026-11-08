package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Which notes link to which, on the phone (T40 P7, LK5, A473): filled from `/sync/changes`
 * `links` (D1's index), and from the editor page for a note with edits not sent yet, so the
 * Info sheet's backlinks and the graph work offline and follow the phone's own edits.
 */
@RunWith(AndroidJUnit4::class)
class LinksStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1_000 })
    }

    @After
    fun close() = db.close()

    private fun row(id: String, clock: Long, links: List<String>?, updatedAt: Long = clock, deleted: Boolean = false) =
        ChangedNote(id, clock, id.replaceFirstChar { it.uppercase() }, "", updatedAt, deleted = deleted, seq = clock, links = links)

    private suspend fun linkingHere(id: String) = store.observeBacklinkSources(id).first().map { it.id }

    @Test
    fun theIndexsLinksFillTheTableAndALaterRowReplacesThem() = runTest {
        store.saveChanges(ChangesPage(3, notes = listOf(row("garden", 1, emptyList()), row("beds", 2, emptyList()), row("review", 3, listOf("beds", "garden")))))
        assertEquals(listOf("review"), linkingHere("garden"))
        assertEquals(listOf("beds", "garden"), store.linksOf("review"))
        // The review was edited elsewhere: its link to the garden went.
        store.saveChanges(ChangesPage(4, notes = listOf(row("review", 4, listOf("beds")))))
        assertTrue(linkingHere("garden").isEmpty())
        assertEquals(listOf("review"), linkingHere("beds"))
    }

    @Test
    fun anOlderServerSendsNoLinksAndLeavesWhatThePhoneHas() = runTest {
        store.saveChanges(ChangesPage(2, notes = listOf(row("garden", 1, emptyList()), row("review", 2, listOf("garden")))))
        store.saveChanges(ChangesPage(3, notes = listOf(row("review", 3, links = null))))
        assertEquals(listOf("review"), linkingHere("garden"))
    }

    @Test
    fun aNoteWithEditsNotSentKeepsTheLinksThePageReported() = runTest {
        store.saveChanges(ChangesPage(2, notes = listOf(row("garden", 1, emptyList()), row("review", 2, emptyList()))))
        // Typed here, offline: the page reports the new link, and it shows at once.
        store.addPending("review", "AAA=", null)
        store.setOwnLinks("review", listOf("garden", "review"))
        assertEquals(listOf("review"), linkingHere("garden"))
        assertEquals(listOf("garden"), store.linksOf("review"))
        // An index row from before those edits does not take the link away.
        store.saveChanges(ChangesPage(3, notes = listOf(row("review", 3, emptyList()))))
        assertEquals(listOf("review"), linkingHere("garden"))
    }

    @Test
    fun linkingNotesAreListedMostRecentlyEditedFirstAndOnlyWhileLive() = runTest {
        store.saveChanges(
            ChangesPage(
                4,
                notes = listOf(
                    row("garden", 1, listOf("garden")),
                    row("old", 2, listOf("garden"), updatedAt = 10),
                    row("new", 3, listOf("garden"), updatedAt = 30),
                    row("bin", 4, listOf("garden"), updatedAt = 20),
                ),
            ),
        )
        // A note never links to itself here; newest first.
        assertEquals(listOf("new", "bin", "old"), linkingHere("garden"))
        // Moved to Trash: the server sends it with no links, and it leaves the list.
        store.saveChanges(ChangesPage(5, notes = listOf(row("bin", 5, emptyList(), updatedAt = 20, deleted = true))))
        assertEquals(listOf("new", "old"), linkingHere("garden"))
    }

    @Test
    fun aPurgedNoteLinksNowhereAndItsBacklinksReadGo() = runTest {
        store.saveChanges(ChangesPage(2, notes = listOf(row("garden", 1, emptyList()), row("review", 2, listOf("garden")))))
        store.cacheBacklinks("review", """{"title":"Review"}""")
        store.saveChanges(ChangesPage(3, notes = listOf(ChangedNote("review", 3, purged = true, deleted = true))))
        assertTrue(linkingHere("garden").isEmpty())
        assertTrue(store.linksOf("review").isEmpty())
        assertNull(store.cachedBacklinks("review"))
    }

    @Test
    fun aPurgedNoteIsLinkedFromNowhere() = runTest {
        // The server turns links to a purged note back into unresolved ones without moving the
        // sources' clocks (review N2): the phone drops them itself, so a daily note made again
        // under the same id shows no backlinks the server no longer resolves.
        store.saveChanges(ChangesPage(2, notes = listOf(row("garden", 1, emptyList()), row("review", 2, listOf("garden")))))
        store.saveChanges(ChangesPage(3, notes = listOf(ChangedNote("garden", 3, purged = true, deleted = true))))
        assertTrue(store.linksOf("review").isEmpty())
    }

    @Test
    fun theBacklinksReadAreKeptForOfflineAndReplacedOnEachLoad() = runTest {
        assertNull(store.cachedBacklinks("garden"))
        store.cacheBacklinks("garden", "first")
        store.cacheBacklinks("garden", "second")
        val cached = store.cachedBacklinks("garden")!!
        assertEquals("second", cached.json)
        assertEquals(1_000, cached.fetchedAt)
    }

    @Test
    fun theContentStampMovesWithWhatThePageReads() = runTest {
        val before = store.observeContentStamp("garden").first()
        store.addPending("garden", "AAA=", null)
        val after = store.observeContentStamp("garden").first()
        assertTrue(before != after)
    }
}
