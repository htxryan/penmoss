package app.penmoss.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.data.NoteStore
import app.penmoss.data.Notebooks
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.BatchFiled
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.DailyNoteRef
import app.penmoss.engine.api.InFolder
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TreeNote
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Notes made on the phone join the workspace's tree once the server has them (T33, A303, A306). */
@RunWith(AndroidJUnit4::class)
class NoteFilerTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private val api = FakeApi()
    private lateinit var filer: NoteFiler

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db)
        filer = NoteFiler(store, api)
    }

    @After
    fun close() = db.close()

    private suspend fun made(id: String, folder: String?, uploaded: Boolean = true) {
        store.addLocalNote(PageNote(id, "Title", "WHOLE"), folder)
        if (!uploaded) return
        val sent = store.content(id)
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply(id, "e", "", "SV", null)))
    }

    @Test
    fun filesUploadedNotesWhereTheyBelongOnce() = runTest {
        made("link", "f")
        made("copy", null)
        made("waiting", "f", uploaded = false)
        assertEquals(2, filer.fileDue())
        assertEquals(setOf("link" to "f", "copy" to null), api.moves.toSet())
        assertEquals(0, filer.fileDue())
        // Not uploaded yet: still to file.
        assertTrue(store.note("waiting")!!.toFile)
        assertTrue(store.readyToFile().isEmpty())
    }

    /**
     * A folder gone since is the server's to place (T43, A757: fail closed): the nearest live folder
     * above it within its notebook, which it answers. The phone takes that as where the note
     * landed, and never asks for the top level, which is the default notebook.
     */
    @Test
    fun aFolderThatWentIsFiledWhereTheServerPlacedItNeverAtTheTopLevel() = runTest {
        made("n", "gone-folder")
        api.filedIn = { _, folder -> if (folder == "gone-folder") "work" else folder }
        assertEquals(1, filer.fileDue())
        assertEquals(listOf("n" to "gone-folder"), api.moves.toList())
        // Filed: the next tree shows it in the folder the server chose.
        assertTrue(store.readyToFile().isEmpty())
        assertEquals(0, filer.fileDue())
    }

    /** A note already filed whose new folder went with no safe place (422): it stays where it is. */
    @Test
    fun aFiledNotesMoveIntoAFolderGoneWithNoSafePlaceIsDroppedNotSentToTheTopLevel() = runTest {
        synced()
        store.moveNote("soup", "garden")
        api.onMove = { _, _ -> throw ApiException(422, "folder_not_found", "No such folder") }
        assertEquals(1, filer.fileDue())
        assertEquals(listOf("soup" to "garden"), api.moves.toList())
        assertTrue(store.readyToFile().isEmpty())
        assertFalse(store.note("soup")!!.toFile)
        // Nothing more is sent: the next tree shows it where the server has it.
        assertEquals(0, filer.fileDue())
        assertEquals(1, api.moves.size)
    }

    @Test
    fun aNoteTheServerLacksYetIsTriedAgainAndARefusalIsNot() = runTest {
        made("later", null)
        made("refused", null)
        api.onMove = { id, _ ->
            if (id == "later") throw ApiException(404, "note_not_found", "Not yet")
            else throw ApiException(400, "invalid", "No")
        }
        assertEquals(1, filer.fileDue())
        assertEquals(listOf("later"), store.readyToFile().map { it.id })
        api.onMove = { _, _ -> }
        assertEquals(1, filer.fileDue())
        assertTrue(store.readyToFile().isEmpty())
    }

    @Test
    fun aBusyServerWhileFilingIntoAGoneFolderLeavesItForTheNextPass() = runTest {
        made("n", "gone-folder")
        made("other", null)
        api.onMove = { id, _ -> if (id == "n") throw ApiException(503, "unavailable", "Down") }
        // Neither thrown out of the pass nor stopping the notes after it, nor tried at the top level.
        assertEquals(1, filer.fileDue())
        assertEquals(listOf("n"), store.readyToFile().map { it.id })
        assertTrue(api.moves.contains("other" to null))
        assertFalse(api.moves.contains("n" to null))
    }

    @Test
    fun aMoveMadeOfflineIsFiledOnceThePhoneIsOnline() = runTest {
        // A note the server has (indexed, in the tree), moved on the phone in airplane mode (T38).
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("soup", 1, "Soup", "", 10))))
        store.saveTree(SyncTree("h", folders = listOf(TreeFolder("garden", "Garden")), notes = listOf(TreeNote("soup", null, "a0"))))
        store.moveNote("soup", "garden")
        api.onMove = { _, _ -> throw java.io.IOException("airplane mode") }
        assertEquals(0, filer.fileDue())
        assertEquals(listOf("soup"), store.readyToFile().map { it.id })
        // Online: filed where it was moved to, once.
        api.onMove = { _, _ -> }
        assertEquals(1, filer.fileDue())
        assertEquals(listOf("soup" to "garden", "soup" to "garden"), api.moves.toList())
        assertTrue(store.readyToFile().isEmpty())
    }

    /** A note the server has, at the top level, beside a Garden folder. */
    private suspend fun synced(id: String = "soup") {
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote(id, 1, "Soup", "", 10))))
        store.saveTree(
            SyncTree("h", folders = listOf(TreeFolder("garden", "Garden"), TreeFolder("home", "Home")), notes = listOf(TreeNote(id, null, "a0"))),
        )
    }

    @Test
    fun aMoveSaysWhereTheNoteWasAndANoteMadeHereDoesNot() = runTest {
        synced()
        store.moveNote("soup", "garden")
        made("new", "home")
        assertEquals(2, filer.fileDue())
        // Moved from the top level (A359); the new note was never anywhere, so nothing to check.
        assertEquals(mapOf("soup" to InFolder(null), "new" to null), api.moves.map { it.first }.zip(api.froms).toMap())
    }

    /**
     * A move names the notebook the phone saw the note in (T43, A766, fix c), the same on every
     * try; a move queued before schema 19 is named from where the phone has the note now.
     */
    @Test
    fun aMoveNamesTheNotebookThePhoneSawItInOnEveryTry() = runTest {
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("soup", 1, "Soup", "", 10), ChangedNote("plan", 2, "Plan", "", 20))))
        store.saveTree(
            SyncTree(
                "h",
                folders = listOf(TreeFolder("w", "Work", notebook = true), TreeFolder("garden", "Garden")),
                notes = listOf(TreeNote("soup", null, "a0"), TreeNote("plan", "w", "a0")),
            ),
        )
        store.moveNote("soup", "w")
        api.onMove = { _, _ -> throw java.io.IOException("airplane mode") }
        assertEquals(0, filer.fileDue())
        api.onMove = { _, _ -> }
        assertEquals(1, filer.fileDue())
        assertEquals(listOf(Notebooks.DEFAULT, Notebooks.DEFAULT), api.fromNotebooks.toList())

        made("new", "w")
        store.moveNote("plan", "garden")
        db.openHelper.writableDatabase.execSQL("UPDATE notes SET moveNotebook = NULL WHERE id = 'plan'")
        api.fromNotebooks.clear()
        api.moves.clear()
        assertEquals(2, filer.fileDue())
        assertEquals(mapOf("new" to "w", "plan" to "w"), api.moves.map { it.first }.zip(api.fromNotebooks).toMap())
    }

    /**
     * A note made here names its folder on its first upload (T43, fix c), so the server files it
     * there at once: one it answers `filed` for is never moved again; for one it does not (an
     * older server), the filer moves it as before.
     */
    @Test
    fun aNoteItsUploadFiledIsNotMovedAgainAndOneItDidNotIs() = runTest {
        store.saveTree(SyncTree("h", folders = listOf(TreeFolder("w", "Work", notebook = true), TreeFolder("plans", "Plans", "w"))))
        store.addLocalNote(PageNote("a", "A", "WHOLE"), "plans")
        store.addLocalNote(PageNote("b", "B", "WHOLE"), "plans")
        val a = store.content("a")
        assertEquals(InFolder("plans"), a.fileOnUpload)
        val entry = Exchange.entry(a)
        assertEquals(JsonPrimitive("plans"), entry.folderId)
        // The server placed it in the nearest folder above, Plans gone there since.
        store.saveExchange(Exchange.decide(a, entry, BatchNoteReply("a", "e", "", "SV", null, applied = 1, filed = BatchFiled("w"))))
        val b = store.content("b")
        store.saveExchange(Exchange.decide(b, Exchange.entry(b), BatchNoteReply("b", "e", "", "SV", null, applied = 1)))
        // Filed; the next tree lists it where the server put it, as after a move.
        assertFalse(store.note("a")!!.toFile)
        assertEquals(1, filer.fileDue())
        assertEquals(listOf("b" to "plans"), api.moves.toList())
        // Uploaded: nothing more to file with the next upload.
        assertEquals(null, store.content("b").fileOnUpload)
    }

    @Test
    fun aNoteTrashedElsewhereSinceIsNotFiledAndStaysInTrash() = runTest {
        synced()
        store.moveNote("soup", "garden")
        // Trashed on the Mac after this pass's /sync/changes: the server refuses (A358).
        api.onMove = { _, _ -> throw ApiException(409, "in_trash", "The note is in Trash") }
        assertEquals(1, filer.fileDue())
        assertTrue(store.readyToFile().isEmpty())
        assertFalse(store.note("soup")!!.toFile)
        // Nothing here brings it back: the next /sync/changes says it is deleted.
        assertEquals(1, api.moves.size)
        assertEquals(0, filer.fileDue())
    }

    @Test
    fun aMoveOvertakenByOneMadeElsewhereIsDropped() = runTest {
        synced()
        store.moveNote("soup", "garden")
        api.onMove = { _, _ -> throw ApiException(409, "note_moved", "Moved since") }
        assertEquals(1, filer.fileDue())
        assertTrue(store.readyToFile().isEmpty())
        // The next tree places it where the other device put it, and nothing is sent again.
        store.saveTree(SyncTree("h2", folders = listOf(TreeFolder("garden", "Garden"), TreeFolder("home", "Home")), notes = listOf(TreeNote("soup", "home", "a5"))))
        assertEquals("home", store.folderOf("soup"))
        assertEquals(0, filer.fileDue())
        assertEquals(1, api.moves.size)
    }

    @Test
    fun aMoveMadeWhileAnotherWasFiledIsCheckedAgainstWhereThatOnePutIt() = runTest {
        synced()
        store.moveNote("soup", "garden")
        // Moved again on the phone while the first request is out.
        api.onMove = { _, _ -> kotlinx.coroutines.runBlocking { store.moveNote("soup", "home") } }
        assertEquals(1, filer.fileDue())
        api.onMove = { _, _ -> }
        assertEquals(1, filer.fileDue())
        assertEquals(listOf("soup" to "garden", "soup" to "home"), api.moves.toList())
        assertEquals(listOf(InFolder(null), InFolder("garden")), api.froms.toList())
    }

    @Test
    fun aMoveToAFolderThatWentIsCheckedAgainstWhereTheServerPlacedItNext() = runTest {
        synced()
        store.moveNote("soup", "garden")
        // The folder went, so the server filed the note in the nearest folder above (A757); a move
        // made meanwhile starts from there.
        api.filedIn = { _, folder -> if (folder == "garden") "home" else folder }
        api.onMove = { _, folder ->
            if (folder == "garden") kotlinx.coroutines.runBlocking { store.moveNote("soup", null) }
        }
        assertEquals(1, filer.fileDue())
        api.onMove = { _, _ -> }
        assertEquals(1, filer.fileDue())
        assertEquals(listOf("soup" to "garden", "soup" to null), api.moves.toList())
        assertEquals(listOf(InFolder(null), InFolder("home")), api.froms.toList())
    }

    @Test
    fun aRevokedTokenStopsThePass() = runTest {
        made("n", null)
        api.onMove = { _, _ -> throw ApiException(401, "unauthorized", "Signed out") }
        try {
            filer.fileDue()
            fail("A revoked token must reach the sync coordinator")
        } catch (error: ApiException) {
            assertTrue(error.unauthorized)
        }
        assertEquals(listOf("n"), store.readyToFile().map { it.id })
    }

    /** A periodic note made here files through the daily intent, not the move route (T40 P5). */
    private suspend fun madePeriodic(id: String, kind: String, period: String, date: String) {
        store.addPeriodicNote(PageNote(id, period, "WHOLE"), kind, period, kind, date)
        val sent = store.content(id)
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply(id, "e", "", "SV", null)))
    }

    @Test
    fun aPeriodsNoteFilesThroughTheDailyIntentWithItsExplicitDay() = runTest {
        madePeriodic("daily1", "daily", "2026-10-21", "2026-10-21")
        madePeriodic("weekly1", "weekly", "2026-W43", "2026-10-19")
        assertEquals(2, filer.fileDue())
        assertEquals(listOf("2026-10-21" to "daily", "2026-10-19" to "weekly"), api.dailyCalls.toList())
        // No move filed for either.
        assertTrue(api.moves.isEmpty())
        assertTrue(store.readyToFile().isEmpty())
    }

    @Test
    fun aDailyIntentTriedOfflineIsSentOnTheNextPass() = runTest {
        madePeriodic("daily1", "daily", "2026-10-21", "2026-10-21")
        api.onDaily = { _, _ -> throw java.io.IOException("airplane mode") }
        assertEquals(0, filer.fileDue())
        assertEquals(listOf("daily1"), store.readyToFile().map { it.id })
        api.onDaily = { _, _ -> DailyNoteRef("daily1", created = true) }
        assertEquals(1, filer.fileDue())
        // The offline attempt and the filing, in order.
        assertEquals(listOf("2026-10-21" to "daily", "2026-10-21" to "daily"), api.dailyCalls.toList())
        assertTrue(store.readyToFile().isEmpty())
    }

    @Test
    fun aDailyIntentRefusedForGoodIsDropped() = runTest {
        madePeriodic("daily1", "daily", "2026-10-21", "2026-10-21")
        api.onDaily = { _, _ -> throw ApiException(400, "invalid_request", "No") }
        assertEquals(1, filer.fileDue())
        assertTrue(store.readyToFile().isEmpty())
    }

    /** A 404 never clears by waiting (review N1): dropped, not tried on every pass for ever. */
    @Test
    fun aDailyIntentAnsweredNotFoundIsDropped() = runTest {
        madePeriodic("daily1", "daily", "2026-10-21", "2026-10-21")
        api.onDaily = { _, _ -> throw ApiException(404, "not_found", "No") }
        assertEquals(1, filer.fileDue())
        assertTrue(store.readyToFile().isEmpty())
        assertEquals(0, filer.fileDue())
        assertEquals(1, api.dailyCalls.size)
    }
}
