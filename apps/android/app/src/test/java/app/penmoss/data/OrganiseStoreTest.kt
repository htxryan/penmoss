package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TagCount
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TreeNote
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Moving notes and filing new ones on the phone (T38): the lists show a note where it is going at
 * once, offline too, and the move waits in Room until the server can be asked (A303's queue).
 */
@RunWith(AndroidJUnit4::class)
class OrganiseStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1_000 })
    }

    @After
    fun close() = db.close()

    private val tree = SyncTree(
        hash = "h1",
        rootSortMode = "manual",
        folders = listOf(TreeFolder("home", "Home", position = "a0"), TreeFolder("garden", "Garden", "home", "a0")),
        notes = listOf(TreeNote("soup", "home", "a0"), TreeNote("plan", "garden", "a0"), TreeNote("loose", null, "a0")),
    )

    /** Notes the server has: indexed, in the tree. */
    private suspend fun synced() {
        store.saveChanges(
            ChangesPage(
                3,
                notes = listOf(ChangedNote("soup", 1, "Soup", "", 10), ChangedNote("plan", 2, "Plan", "", 20), ChangedNote("loose", 3, "Loose", "", 30)),
            ),
        )
        store.saveTree(tree)
    }

    private suspend fun listedIn(folderId: String?) = store.observeList().first().filter { it.folderId == folderId }.map { it.id }

    @Test
    fun aMoveShowsAtOnceAndWaitsToBeFiled() = runTest {
        synced()
        assertEquals(NoteStore.Move.MOVED, store.moveNote("soup", "garden"))
        // Listed in its new folder at once, after the notes already there.
        assertEquals(listOf("plan", "soup"), store.observeList().first().filter { it.folderId == "garden" }.sortedBy { it.position }.map { it.id })
        assertEquals(emptyList<String>(), listedIn("home"))
        assertEquals("garden", store.folderOf("soup"))
        // The server has the note, so the move can be filed whenever the phone is online.
        assertEquals(listOf("soup" to "garden"), store.readyToFile().map { it.id to it.fileIn })
    }

    @Test
    fun aMoveToTheTopLevelIsAMoveToo() = runTest {
        synced()
        assertEquals(NoteStore.Move.MOVED, store.moveNote("plan", null))
        assertTrue("plan" in listedIn(null))
        assertEquals(listOf("plan" to null), store.readyToFile().map { it.id to it.fileIn })
    }

    @Test
    fun aTreeFromBeforeTheMoveDoesNotMoveTheNoteBack() = runTest {
        synced()
        store.moveNote("soup", "garden")
        // The next pass brings the tree as the server still has it (the move is not filed yet).
        store.saveTree(tree.copy(hash = "h2"))
        assertEquals("garden", store.note("soup")!!.folderId)
        // Once filed, the server's tree has the last word.
        store.markFiled("soup", "garden")
        store.saveTree(tree.copy(hash = "h3", notes = listOf(TreeNote("soup", "garden", "a1"), TreeNote("plan", "garden", "a0"))))
        assertEquals("a1", store.note("soup")!!.position)
        assertFalse(store.note("soup")!!.toFile)
    }

    @Test
    fun aMoveToAFolderDeletedElsewhereShowsAtTheTopLevelAsFilingWill() = runTest {
        synced()
        store.moveNote("soup", "garden")
        store.saveTree(tree.copy(hash = "h2", folders = tree.folders.filter { it.id != "garden" }, notes = listOf(TreeNote("soup", "home", "a0"))))
        assertEquals(null, store.note("soup")!!.folderId)
        // The filer is still asked for the folder chosen, and falls back to the top level (A303).
        assertEquals(listOf("garden"), store.readyToFile().map { it.fileIn })
        // The picker ticks where the lists show it: the top level, not a folder it no longer has.
        assertEquals(null, store.folderOf("soup"))
    }

    @Test
    fun aMoveRemembersWhereTheTreeHadTheNoteOnceForAllTheMovesBeforeItIsFiled() = runTest {
        synced()
        store.moveNote("soup", "garden")
        assertEquals(true to "home", store.note("soup")!!.let { it.checkFrom to it.movedFrom })
        // Moved again before the first was filed: still checked against where the tree had it.
        store.moveNote("soup", null)
        assertEquals(true to "home", store.note("soup")!!.let { it.checkFrom to it.movedFrom })
        // A note made here has no place in the tree to check against.
        store.addLocalNote(PageNote("new", "", "WHOLE"), fileIn = "garden")
        store.moveNote("new", "home")
        assertFalse(store.note("new")!!.checkFrom)
    }

    @Test
    fun aTreeThatShowsTheNoteMovedElsewhereSinceDropsTheMoveMadeHere() = runTest {
        synced()
        // Offline, Ryan moves Soup from Home to Garden on the phone...
        store.moveNote("soup", "garden")
        // ...then files it at the top level on the Mac. The phone's next tree says so.
        store.saveTree(tree.copy(hash = "h2", notes = listOf(TreeNote("soup", null, "a5"), TreeNote("plan", "garden", "a0"))))
        // The newer move stands: the phone shows it there and has nothing to file (A359).
        assertEquals(null, store.note("soup")!!.folderId)
        assertTrue(store.readyToFile().isEmpty())
        assertFalse(store.note("soup")!!.toFile)
        // A tree that still shows it where it was moved from keeps the move.
        store.moveNote("plan", "home")
        store.saveTree(tree.copy(hash = "h3", notes = listOf(TreeNote("soup", null, "a5"), TreeNote("plan", "garden", "a0"))))
        assertEquals("home", store.note("plan")!!.folderId)
        assertEquals(listOf("plan"), store.readyToFile().map { it.id })
    }

    @Test
    fun movesAndNotesStillToFileCountAsUnsentOnceEach() = runTest {
        synced()
        assertEquals(0, store.unsentCount())
        store.moveNote("soup", "garden")
        assertEquals(1, store.unsentCount())
        // A new note's content counts as an edit; its filing is not counted again.
        store.addLocalNote(PageNote("new", "", "WHOLE"), fileIn = "garden")
        assertEquals(2, store.unsentCount())
        // Uploaded but not filed yet (a busy server): still unsent.
        val sent = store.content("new")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("new", "e", "", "SV", null)))
        assertEquals(2, store.unsentCount())
        store.markFiled("soup", "garden")
        store.markFiled("new", "garden")
        assertEquals(0, store.unsentCount())
    }

    @Test
    fun aMoveMadeWhileTheLastWasBeingFiledIsFiledNext() = runTest {
        synced()
        store.moveNote("soup", "garden")
        val filing = store.readyToFile().single()
        // Moved again while the filer's request was out.
        store.moveNote("soup", null)
        store.markFiled(filing.id, filing.fileIn)
        assertEquals(listOf("soup" to null), store.readyToFile().map { it.id to it.fileIn })
    }

    @Test
    fun movingWhereANoteAlreadyIsDoesNothing() = runTest {
        synced()
        assertEquals(NoteStore.Move.ALREADY_THERE, store.moveNote("soup", "home"))
        assertEquals(NoteStore.Move.ALREADY_THERE, store.moveNote("loose", null))
        assertTrue(store.readyToFile().isEmpty())
    }

    @Test
    fun aNoteInTrashGoneOrUnknownAndAFolderNotOnThePhoneAreRefused() = runTest {
        synced()
        store.saveChanges(ChangesPage(4, notes = listOf(ChangedNote("loose", 4, "Loose", "", 40, deleted = true))))
        assertEquals(NoteStore.Move.REFUSED, store.moveNote("loose", "home"))
        assertEquals(NoteStore.Move.REFUSED, store.moveNote("nobody", "home"))
        // A folder gone is told apart from a note gone (#137): the message names it.
        assertEquals(NoteStore.Move.NO_FOLDER, store.moveNote("soup", "no-such-folder"))
        assertEquals(NoteStore.Move.NO_FOLDER, store.moveNote("nobody", "no-such-folder"))
        assertTrue(store.readyToFile().isEmpty())
    }

    @Test
    fun aNoteTrashedElsewhereLosesItsMoveSoARestoreDoesNotMoveIt() = runTest {
        synced()
        store.moveNote("soup", "garden")
        store.saveChanges(ChangesPage(5, notes = listOf(ChangedNote("soup", 5, "Soup", "", 50, deleted = true))))
        assertTrue(store.readyToFile().isEmpty())
        // Restored on the web: it comes back where the web files it, not where the phone moved it.
        store.saveChanges(ChangesPage(6, notes = listOf(ChangedNote("soup", 6, "Soup", "", 60))))
        assertTrue(store.readyToFile().isEmpty())
    }

    @Test
    fun aMovedNoteWithEditsStillToSendIsFiledAnyway() = runTest {
        synced()
        store.addPending("soup", "EDIT", null)
        store.moveNote("soup", "garden")
        // The server has the note itself (it is indexed), so the move need not wait for the edit.
        assertEquals(listOf("soup"), store.readyToFile().map { it.id })
    }

    @Test
    fun aNewNoteIsListedInItsFolderAtOnceAndFiledOnceUploaded() = runTest {
        synced()
        assertTrue(store.addLocalNote(PageNote("new", "", "WHOLE"), fileIn = "garden"))
        assertTrue("new" in listedIn("garden"))
        assertEquals("garden", store.folderOf("new"))
        // Not filed before the server has its content.
        assertTrue(store.readyToFile().isEmpty())
        // Moved before it ever uploaded: it is filed in the new folder instead.
        assertEquals(NoteStore.Move.MOVED, store.moveNote("new", "home"))
        assertTrue("new" in listedIn("home"))
        val sent = store.content("new")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("new", "e", "", "SV", null)))
        assertEquals(listOf("new" to "home"), store.readyToFile().map { it.id to it.fileIn })
        // A tree from before the upload does not move it out of its folder.
        store.saveTree(tree.copy(hash = "h2"))
        assertTrue("new" in listedIn("home"))
    }

    @Test
    fun aNewNoteForAFolderThePhoneDoesNotKnowIsListedAtTheTopLevel() = runTest {
        synced()
        store.addLocalNote(PageNote("new", "", "WHOLE"), fileIn = "unknown")
        assertTrue("new" in listedIn(null))
        assertEquals("unknown", store.note("new")!!.fileIn)
    }

    @Test
    fun tagSuggestionsAreKeptForOfflineAndFollowTagsAddedHere() = runTest {
        assertEquals(emptyList<TagCount>(), store.observeTagList().first())
        store.saveTagList(listOf(TagCount("inbox", 4), TagCount("area/cooking", 2)))
        assertEquals(listOf("inbox", "area/cooking"), store.observeTagList().first().map { it.name })
        store.rememberTag("soup")
        store.rememberTag("inbox")
        assertEquals(listOf("inbox" to 4, "area/cooking" to 2, "soup" to 1), store.observeTagList().first().map { it.name to it.notes })
    }
}
