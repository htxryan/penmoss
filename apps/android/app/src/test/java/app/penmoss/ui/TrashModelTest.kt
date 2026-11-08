package app.penmoss.ui

import app.penmoss.stopScope
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.api.TrashListed
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * Trash's state (T40 P3a, NT13–NT15) through the real client against a fake notes server: the
 * phone's rows merged with the server's list, Restore at once offline, and Delete for good with
 * no owner check since T59 (A1040).
 */
@RunWith(AndroidJUnit4::class)
class TrashModelTest {
    private val server = MockWebServer()
    private var syncs = 0
    private lateinit var api: HttpPenmossApi
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private val day = TimeUnit.DAYS.toMillis(1)
    private val now = 100 * day

    @Before
    fun start() {
        server.start()
        api = HttpPenmossApi(server.url("/").toString(), OkHttpClient())
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { now })
    }

    @After
    fun stop() {
        db.close()
        server.close()
    }

    private fun respond(body: String = "{}", code: Int = 200) =
        server.enqueue(MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build())

    private fun error(code: Int, name: String, message: String) =
        respond("""{"error":{"code":"$name","message":"$message"}}""", code)

    /** A model whose work runs in this test, cancelled at its end; [until] waits for its state. */
    private fun withModel(git: Boolean = false, block: suspend Scope.() -> Unit) = runBlocking {
        val job = SupervisorJob()
        val model = TrashModel(
            store,
            api,
            api,
            requestSync = { syncs++ },
            scope = CoroutineScope(coroutineContext + job),
            now = { now },
            git = git,
        )
        try {
            Scope(model).block()
        } finally {
            // Joined (A690): Trash's flows (observeTrash, the settings row) otherwise outlived
            // the database and failed a later class, AndroidCommandsTest (T39 pass 3).
            job.cancelAndJoin()
        }
    }

    class Scope(val model: TrashModel) {
        suspend fun until(what: (TrashUi) -> Boolean): TrashUi = withTimeout(5_000) { model.ui.first(what) }

        /** The screen showed the message: gone from the state before the next one. */
        suspend fun shown() {
            model.messageShown()
            until { it.message == null }
        }
    }

    private suspend fun inTrash(id: String, deletedAt: Long, title: String = id) =
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote(id, 1, title, "", deletedAt, deleted = true))))

    private suspend fun listedHere(id: String) = store.observeList().first().any { it.id == id }

    @Test
    fun theListMergesThePhonesRowsWithTheServersNewestFirst() = withModel {
        inTrash("old", now - 10 * day, "Old")
        store.saveChanges(ChangesPage(2, notes = listOf(ChangedNote("soup", 2, "Soup", "", now - 20 * day))))
        store.moveToTrash("soup")
        respond("""{"notes":[{"id":"old","title":"Old","deletedAt":${now - 10 * day}},{"id":"far","title":"From the Mac","deletedAt":${now - 29 * day - 1}}]}""")
        model.load()
        val ui = until { it.entries.size == 3 && !it.loading }
        assertEquals(listOf("soup", "old", "far"), ui.entries.map { it.id })
        assertEquals(listOf(true, false, false), ui.entries.map { it.waiting })
        assertEquals("Moved to Trash on this phone · not sent yet", ui.entries[0].detail)
        assertTrue(ui.entries[1].detail, ui.entries[1].detail.endsWith("goes for good in 20 days"))
        assertTrue(ui.entries[2].detail, ui.entries[2].detail.endsWith("goes for good in 1 day"))
        assertNull(ui.problem)
        assertEquals("/api/trash", server.takeRequest().target)
    }

    /** T42 (A574; T40 NT30, A655): who moved each note there, from `/api/trash`'s `deletedBy`. */
    @Test
    fun eachNoteSaysWhoMovedItToTrashAnAgentWithItsMark() = withModel {
        inTrash("old", now - 10 * day, "Old")
        respond(
            """{"notes":[""" +
                """{"id":"old","title":"Old","deletedAt":${now - 10 * day},"deletedBy":{"label":"Pixel 9","kind":"device"}},""" +
                """{"id":"agent","title":"Agent's","deletedAt":${now - 2 * day},"deletedBy":{"label":"Claude Code","kind":"agent"}},""" +
                """{"id":"fake","title":"Fake","deletedAt":${now - 3 * day},"deletedBy":{"label":"Claude ✦","kind":"device"}},""" +
                """{"id":"odd","title":"Odd","deletedAt":${now - 4 * day},"deletedBy":{"kind":"robot"}},""" +
                """{"id":"none","title":"Before T42","deletedAt":${now - 5 * day}}]}""",
        )
        model.load()
        val ui = until { it.entries.size == 5 && !it.loading }
        val detail = ui.entries.associate { it.id to it.detail }
        assertTrue(detail["agent"], detail.getValue("agent").contains(" by Claude Code ✦ · goes for good in 28 days"))
        // This phone's own copy takes the server's answer.
        assertTrue(detail["old"], detail.getValue("old").contains(" by Pixel 9 · "))
        // ✦ marks agents only: a device that names itself with it does not pass for one (review N8).
        assertTrue(detail["fake"], detail.getValue("fake").contains(" by Claude · "))
        // A malformed one, or an older server's list, names no one.
        assertTrue(detail["odd"], !detail.getValue("odd").contains(" by "))
        assertTrue(detail["none"], !detail.getValue("none").contains(" by "))
    }

    /**
     * #137 (review N5): a name that is only ✦ is "a device" or "an agent", never a lone ✦ that reads
     * as an agent; TalkBack hears "(agent)" where the screen shows ✦, not the star's name.
     */
    @Test
    fun aNameThatIsOnlyTheMarkNamesADeviceOrAnAgentAndTalkBackHearsAgent() = withModel {
        respond(
            """{"notes":[""" +
                """{"id":"star","title":"Star","deletedAt":${now - 2 * day},"deletedBy":{"label":" ✦ ","kind":"device"}},""" +
                """{"id":"agentStar","title":"Agent star","deletedAt":${now - 2 * day},"deletedBy":{"label":"✦✦","kind":"agent"}},""" +
                """{"id":"agent","title":"Agent's","deletedAt":${now - 2 * day},"deletedBy":{"label":"Claude Code","kind":"agent"}},""" +
                """{"id":"device","title":"Device's","deletedAt":${now - 2 * day},"deletedBy":{"label":"Pixel 9","kind":"device"}}]}""",
        )
        model.load()
        val ui = until { it.entries.size == 4 && !it.loading }
        val shown = ui.entries.associate { it.id to it.detail }
        val spoken = ui.entries.associate { it.id to it.spoken }
        assertTrue(shown["star"], shown.getValue("star").contains(" by a device · "))
        assertTrue(shown["agentStar"], shown.getValue("agentStar").contains(" by an agent ✦ · "))
        assertTrue(shown["agent"], shown.getValue("agent").contains(" by Claude Code ✦ · "))
        assertTrue(spoken["agent"], spoken.getValue("agent").contains(" by Claude Code (agent) · "))
        // An agent with no name of its own is said once: "an agent", not "an agent (agent)".
        assertTrue(spoken["agentStar"], spoken.getValue("agentStar").contains(" by an agent · "))
        assertEquals(shown["device"], spoken["device"])
        assertEquals(shown["star"], spoken["star"])
    }

    /** Review N4: an odd `deletedBy` names no one and never costs the rest of the list, as the web's `parseDeletedBy`. */
    @Test
    fun aDeletedByThatIsNoObjectNamesNoOneAndKeepsTheList() = withModel {
        respond(
            """{"notes":[""" +
                """{"id":"text","title":"Text","deletedAt":${now - day},"deletedBy":"Pixel 9"},""" +
                """{"id":"number","title":"Number","deletedAt":${now - day},"deletedBy":7},""" +
                """{"id":"list","title":"List","deletedAt":${now - day},"deletedBy":["Pixel 9"]},""" +
                """{"id":"label","title":"Label","deletedAt":${now - day},"deletedBy":{"label":42,"kind":"agent"}},""" +
                """{"id":"nokind","title":"No kind","deletedAt":${now - day},"deletedBy":{"label":"Pixel 9"}},""" +
                """{"id":"null","title":"Null","deletedAt":${now - day},"deletedBy":null},""" +
                """{"id":"good","title":"Good","deletedAt":${now - day},"deletedBy":{"label":" Claude Code ","kind":"agent"}}]}""",
        )
        model.load()
        val ui = until { it.entries.size == 7 && !it.loading }
        assertNull(ui.problem)
        val detail = ui.entries.associate { it.id to it.detail }
        listOf("text", "number", "list", "label", "nokind", "null").forEach { id ->
            assertTrue("$id: ${detail[id]}", !detail.getValue(id).contains(" by "))
        }
        assertTrue(detail["good"], detail.getValue("good").contains(" by Claude Code ✦ · "))
    }

    @Test
    fun offlineItListsThePhonesRowsAndSaysSo() = withModel {
        inTrash("old", now - day, "Old")
        server.close()
        model.load()
        val ui = until { it.problem != null && !it.loading }
        assertEquals(listOf("old"), ui.entries.map { it.id })
        assertEquals("Offline: these are the notes this phone holds in Trash.", ui.problem)
    }

    @Test
    fun restoringAMoveNotSentYetCancelsItWithoutAskingTheServer() = withModel {
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("soup", 1, "Soup", "", 5))))
        store.moveToTrash("soup")
        val entry = until { it.entries.isNotEmpty() }.entries.single()
        model.restore(entry)
        val ui = until { it.message != null }
        assertEquals("Restored “Soup”.", ui.message)
        assertEquals("soup", ui.restored)
        until { it.entries.isEmpty() }
        assertTrue(listedHere("soup"))
        assertEquals(0, syncs)
        assertEquals(0, store.unsentCount())
        model.messageShown()
        assertNull(until { it.message == null }.restored)
    }

    @Test
    fun restoringANoteOnlyTheServerListsQueuesItAndSyncs() = withModel {
        respond("""{"notes":[{"id":"far","title":"From the Mac","deletedAt":${now - day}}]}""")
        model.load()
        val entry = until { it.entries.isNotEmpty() && !it.loading }.entries.single()
        model.restore(entry)
        val ui = until { it.message != null }
        assertEquals("Restored “From the Mac”. It goes back where it was with the next sync.", ui.message)
        until { it.entries.isEmpty() }
        assertEquals(1, syncs)
        assertEquals(listOf("far"), store.restoresDue().map { it.id })
        assertTrue(listedHere("far"))
    }

    @Test
    fun deleteForGoodAsksTheServerAndDropsTheCopy() = withModel {
        inTrash("old", now - day, "Old")
        val entry = until { it.entries.isNotEmpty() }.entries.single()
        server.enqueue(MockResponse.Builder().code(204).build())
        model.deleteForGood(entry)
        val ui = until { it.message != null && !it.busy }
        assertEquals("Deleted “Old” for good.", ui.message)
        val sent = server.takeRequest()
        assertEquals("DELETE", sent.method)
        assertEquals("/api/notes/old", sent.target)
        assertNull(store.note("old"))
        assertTrue(until { it.entries.isEmpty() }.entries.isEmpty())
    }

    @Test
    fun aGitNotebooksDeleteForGoodSaysItsGitHistoryStillKeepsTheNote() = withModel(git = true) {
        // #170 F13: the same words as the Mac's (trashed.test.ts), the title cleaned and isolated.
        inTrash("old", now - day, "Old\u202e plan [x]")
        val entry = until { it.entries.isNotEmpty() }.entries.single()
        server.enqueue(MockResponse.Builder().code(204).build())
        model.deleteForGood(entry)
        assertEquals(
            "Deleted “\u2068Old plan x\u2069” for good. The repository’s git history still keeps it.",
            until { it.message != null && !it.busy }.message,
        )
        assertNull(store.note("old"))
        assertEquals("Deleted an untitled note for good. The repository’s git history still keeps it.", deletedForGoodMessage("\u202e\u200b ", git = true))
        assertEquals("Deleted “Old” for good.", deletedForGoodMessage("Old", git = false))
    }

    @Test
    fun aMoveNotSentYetCannotBeDeletedForGoodAndIsSentFirst() = withModel {
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("soup", 1, "Soup", "", 5))))
        store.moveToTrash("soup")
        model.deleteForGood(until { it.entries.isNotEmpty() }.entries.single())
        assertEquals("Its move to Trash hasn’t reached Penmoss yet. Try again once the phone has synced.", until { it.message != null }.message)
        assertEquals(1, syncs)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun aServerWithoutTheTrashRouteIsSaidWithTheWayOut() = withModel {
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("soup", 1, "Soup", "", 5))))
        store.moveToTrash("soup")
        store.setTrashRouteMissing(true)
        val ui = until { it.routeMissing && it.entries.isNotEmpty() }
        assertEquals("Moved to Trash on this phone · Penmoss can’t take it until its server is updated", ui.entries.single().detail)
        model.deleteForGood(ui.entries.single())
        assertEquals(
            "Penmoss can’t take moves to Trash until its server is updated, so “Soup” can’t be deleted for good yet. Restore it to keep it on this phone.",
            until { it.message != null }.message,
        )
        // Nothing to sync for: it would not help.
        assertEquals(0, syncs)
        assertEquals(0, server.requestCount)
        assertEquals("“Soup” was restored on another device, so it was left out of Trash.", trashRefusedMessage("Soup"))
    }

    @Test
    fun theServersAnswersSayWhatHappened() = withModel {
        inTrash("old", now - day, "Old")
        inTrash("gone", now - 2 * day, "Gone")
        val entries = until { it.entries.size == 2 }.entries
        // Not in the server's Trash yet (restored there meanwhile, say): 409, the copy stays.
        error(409, "conflict", "Move the note to Trash before deleting it for good")
        model.deleteForGood(entries.first { it.id == "old" })
        assertEquals("Penmoss doesn’t have “Old” in Trash yet. Try again in a moment.", until { it.message != null && !it.busy }.message)
        assertNotNull(store.note("old"))
        shown()
        // A 404 that does not say the note is gone (a proxy's page, not JSON): the copy stays.
        respond("<html>Not Found</html>", 404)
        model.deleteForGood(entries.first { it.id == "gone" })
        assertEquals("Not done: HTTP 404.", until { it.message != null && !it.busy }.message)
        assertNotNull(store.note("gone"))
        shown()
        // Gone from the server already: only this copy was left.
        error(404, "not_found", "No such note")
        model.deleteForGood(entries.first { it.id == "gone" })
        assertEquals("Deleted “Gone” for good.", until { it.message != null && !it.busy }.message)
        assertNull(store.note("gone"))
        shown()
        // Any other refusal: the notebook's words, and the copy stays.
        error(403, "forbidden", "Not allowed")
        model.deleteForGood(entries.first { it.id == "old" })
        assertEquals("Not done: Not allowed.", until { it.message != null && !it.busy }.message)
        assertNotNull(store.note("old"))
    }

    @Test
    fun leavingANoteWhileItClosesForTrashKeepsTheMove() = runBlocking {
        // Move to Trash from the note: it closes first (up to a second), then moves. Back
        // meanwhile ends the screen's own work; the move, on the app's scope, still happens.
        val app = CoroutineScope(SupervisorJob())
        val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
        val said = java.util.concurrent.CopyOnWriteArrayList<String>()
        val screen = launch { app.trashAfterClosing(close = { said += "closing"; closed.await(); said += "closed" }, onTrash = { said += "trash" }) }
        withTimeout(5_000) { while ("closing" !in said) kotlinx.coroutines.yield() }
        screen.cancel()
        closed.complete(Unit)
        withTimeout(5_000) { while ("trash" !in said) kotlinx.coroutines.delay(10) }
        assertEquals(listOf("closing", "closed", "trash"), said.toList())
        stopScope(app)
    }

    @Test
    fun trashEntriesCountTheDaysLeftAndPreferTheServersTime() {
        val local = listOf(app.penmoss.data.TrashRow("a", "", now - day, 2, now - 3 * day))
        val remote = listOf(TrashListed("a", "A from the server", now - 2 * day), TrashListed("b", "B", now - 31 * day))
        val entries = trashEntries(local, remote, now)
        assertEquals(listOf("a", "b"), entries.map { it.id })
        assertEquals("A from the server", entries[0].title)
        assertEquals(now - 2 * day, entries[0].deletedAt)
        assertTrue(entries[0].detail, entries[0].detail.endsWith("goes for good in 28 days"))
        assertTrue(entries[1].detail, entries[1].detail.endsWith("goes for good today"))
        assertEquals("Untitled", trashEntries(listOf(app.penmoss.data.TrashRow("c", "", 0, 0, 0)), emptyList(), now).single().title)
    }

    // --- a restore the server could not place (T43, A757: fail closed) ---

    /** A restore the server answered 409 `restore_needs_folder`: back in Trash here, the question kept. */
    private suspend fun refusedRestore(id: String, title: String, notebook: String?) {
        inTrash(id, now - day, title)
        store.restoreFromTrash(id)
        assertTrue(store.restoreSending(id))
        store.restoreNeedsFolder(id, notebook, notebook?.let { "Work" }, "The note was in the notebook “Work”, which is in Trash")
    }

    private suspend fun Scope.asked(what: (RestoreAskUi?) -> Boolean): RestoreAskUi? = withTimeout(5_000) { model.asking.first(what) }

    @Test
    fun aRestoreWithNoSafePlaceOffersToRestoreItsNotebookFirst() {
        runBlocking { refusedRestore("soup", "Soup", "w") }
        // Trash's folders, read once the question names a notebook; then the notebook's restore.
        respond("""{"folders":[{"id":"w","name":"Work","notebook":true,"notes":2,"deletedAt":${now - day}}]}""")
        respond("""{"id":"w","restored":true,"notebook":true,"notes":2}""")
        withModel {
            val ask = asked { it?.notebook != null }!!
            assertEquals("Soup", ask.title)
            assertEquals(NotebookInTrash("w", "Work"), ask.notebook)
            assertEquals("The note was in the notebook “Work”, which is in Trash.", ask.message)
            assertEquals("/api/folders/trash", server.takeRequest().target)
            model.restoreNotebookFirst(ask)
            val ui = until { it.message != null }
            assertEquals("Restored the notebook “Work”. “Soup” goes back where it was with the next sync.", ui.message)
            assertEquals("/api/folders/w/restore", server.takeRequest().url.encodedPath)
            asked { it == null }
            // The note's restore is queued again, sent with the next pass (no folder named).
            assertEquals(app.penmoss.data.NoteEntity.RESTORE_QUEUED, store.note("soup")!!.trashChange)
            assertTrue(listedHere("soup"))
            assertEquals(1, syncs)
        }
    }

    @Test
    fun aRestoreWithNoSafePlaceGoesToTheFolderThePersonChooses() {
        runBlocking {
            store.saveTree(app.penmoss.engine.api.SyncTree("h1", folders = listOf(app.penmoss.engine.api.TreeFolder("p", "Projects"))))
            refusedRestore("soup", "Soup", null)
        }
        respond("""{"folderId":"p","restored":true,"seq":7}""")
        withModel {
            val ask = asked { it != null }!!
            // Trash no longer knows its notebook: nothing to restore first, and nothing read for it.
            assertNull(ask.notebook)
            assertFalse(listedHere("soup"))
            model.restoreInto(ask, "p", "Projects")
            assertEquals("Restored “Soup” to Projects.", until { it.message != null }.message)
            val sent = server.takeRequest()
            assertEquals("/api/notes/soup/restore", sent.url.encodedPath)
            assertEquals("""{"folderId":"p"}""", sent.body!!.utf8())
            asked { it == null }
            val note = store.note("soup")!!
            assertFalse(note.deleted)
            // Filed there by the next pass, as any restore is.
            assertTrue(note.toFile)
            assertEquals("p", note.fileIn)
            assertEquals(app.penmoss.data.NoteEntity.RESTORE_SENT, note.trashChange)
            assertEquals(1, syncs)
        }
    }

    @Test
    fun aRestoreWithNoSafePlaceCanBeLeftInTrashAndOfflineTheQuestionStays() {
        runBlocking { refusedRestore("soup", "Soup", null) }
        withModel {
            val ask = asked { it != null }!!
            // Offline: nothing changes, and it is still asked.
            server.close()
            model.restoreInto(ask, null, Items.TOP_LEVEL)
            assertEquals("Offline: restoring “Soup” needs Penmoss. Try again once the phone is online.", until { it.message != null }.message)
            shown()
            assertEquals("soup", model.asking.value?.noteId)
            model.leaveInTrash(ask)
            assertEquals("“Soup” stays in Trash.", until { it.message != null }.message)
            asked { it == null }
            assertTrue(store.note("soup")!!.deleted)
            assertEquals(0, syncs)
        }
    }
}
