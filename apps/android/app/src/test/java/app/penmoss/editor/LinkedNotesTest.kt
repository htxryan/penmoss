package app.penmoss.editor

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.ContentState
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.InfoField
import app.penmoss.engine.bridge.ToEditor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Other notes for the editor page's links and embeds (T40 P7, LK2–LK4; A470, A471), and the
 * open note's heading and details: the app answers with what Room stores, never reading it,
 * fetching a note it lacks, and says when a watched note changes.
 */
@RunWith(AndroidJUnit4::class)
class LinkedNotesTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private val sent = CopyOnWriteArrayList<ToEditor>()
    private val sync = NoteEditorControllerTest.FakeSync()

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db)
    }

    @After
    fun close() {
        // Waits for the controllers' and watches' work to stop before the database closes: a
        // query still running would fail on the closed database in a later test's runTest.
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }
        thread.close()
        db.close()
    }

    private fun linked(maxChars: Int = BridgeProtocol.MAX_CONTENT_CHARS) =
        LinkedNotes(store, sync, scope, { sent += BridgeProtocol.decodeToEditor(it)!! }, maxChars)

    private fun page(linked: LinkedNotes, message: FromEditor) = runBlocking(thread) {
        linked.onPageMessage(BridgeProtocol.encode(message))
    }

    private fun waitFor(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) { while (!condition()) kotlinx.coroutines.delay(10) }
    }

    private fun stored(noteId: String, state: Int, update: String, epoch: String? = null) = runBlocking {
        db.notes().insertIgnore(NoteEntity(noteId))
        db.updates().insert(UpdateEntity(noteId = noteId, state = state, update = update, epoch = epoch))
    }

    private fun answers() = sent.filterIsInstance<ToEditor.NoteContent>()

    @Test
    fun answersWithTheStoredUpdatesAnOpenWouldSend() {
        stored("garden", UpdateEntity.SYNCED, "S1")
        stored("garden", UpdateEntity.PENDING, "P1")
        // Kept apart from an older copy (A291): never part of what the page reads.
        stored("garden", UpdateEntity.CONFLICT, "C1")
        val linked = linked()
        page(linked, FromEditor.NoteContent("garden"))
        waitFor { answers().isNotEmpty() }
        val answer = answers().single()
        assertEquals(ContentState.OK, answer.state)
        assertEquals(listOf("S1", "P1"), answer.updates.map { it.update })
        // Held already: nothing fetched.
        assertTrue(sync.synced.isEmpty())
    }

    @Test
    fun fetchesANoteThePhoneLacksAsOpeningItWould() {
        sync.onSync = { id -> stored(id, UpdateEntity.SYNCED, "FETCHED") }
        val linked = linked()
        page(linked, FromEditor.NoteContent("garden"))
        waitFor { answers().isNotEmpty() }
        assertEquals(listOf("garden"), sync.synced.toList())
        assertEquals(listOf("FETCHED"), answers().single().updates.map { it.update })
    }

    @Test
    fun saysMissingWhenTheNoteCannotBeFetched() {
        val linked = linked()
        page(linked, FromEditor.NoteContent("garden"))
        waitFor { answers().isNotEmpty() }
        assertEquals(ToEditor.NoteContent("garden", ContentState.MISSING, emptyList()), answers().single())
    }

    @Test
    fun refusesANoteTooLargeToHandThePage() {
        stored("big", UpdateEntity.SYNCED, "A".repeat(40))
        stored("big", UpdateEntity.PENDING, "B".repeat(40))
        val linked = linked(maxChars = 64)
        page(linked, FromEditor.NoteContent("big"))
        waitFor { answers().isNotEmpty() }
        assertEquals(ToEditor.NoteContent("big", ContentState.TOO_LARGE, emptyList()), answers().single())
    }

    @Test
    fun saysWhenAWatchedNoteChangesAndStopsWhenUnwatched() {
        stored("garden", UpdateEntity.SYNCED, "S1")
        val linked = linked()
        page(linked, FromEditor.WatchNote("garden", on = true))
        waitFor { "garden" in linked.watched }
        Thread.sleep(200)
        // What it read already is not a change.
        assertTrue(sent.filterIsInstance<ToEditor.NoteChanged>().isEmpty())
        // A sync stores another device's edit: the page renders the embed again.
        stored("garden", UpdateEntity.SYNCED, "S2")
        waitFor { sent.filterIsInstance<ToEditor.NoteChanged>().isNotEmpty() }
        assertEquals(ToEditor.NoteChanged("garden"), sent.filterIsInstance<ToEditor.NoteChanged>().single())
        page(linked, FromEditor.WatchNote("garden", on = false))
        waitFor { linked.watched.isEmpty() }
        stored("garden", UpdateEntity.SYNCED, "S3")
        Thread.sleep(200)
        assertEquals(1, sent.filterIsInstance<ToEditor.NoteChanged>().size)
    }

    @Test
    fun aChangeBetweenTheAnswerAndTheWatchIsStillSaid() {
        stored("garden", UpdateEntity.SYNCED, "S1")
        val linked = linked()
        page(linked, FromEditor.NoteContent("garden"))
        waitFor { answers().isNotEmpty() }
        // Stored after the page was answered, before its watch began (review N7).
        stored("garden", UpdateEntity.SYNCED, "S2")
        page(linked, FromEditor.WatchNote("garden", on = true))
        waitFor { sent.filterIsInstance<ToEditor.NoteChanged>().isNotEmpty() }
        assertEquals(ToEditor.NoteChanged("garden"), sent.filterIsInstance<ToEditor.NoteChanged>().single())
    }

    @Test
    fun aWatchOfWhatThePageWasJustAnsweredSaysNothing() {
        stored("garden", UpdateEntity.SYNCED, "S1")
        val linked = linked()
        page(linked, FromEditor.NoteContent("garden"))
        waitFor { answers().isNotEmpty() }
        page(linked, FromEditor.WatchNote("garden", on = true))
        waitFor { "garden" in linked.watched }
        Thread.sleep(200)
        assertTrue(sent.filterIsInstance<ToEditor.NoteChanged>().isEmpty())
    }

    @Test
    fun fetchesAWatchedNoteTheServerChangedWhileTheAppIsInFront() {
        runBlocking {
            db.notes().insertIgnore(NoteEntity("garden", clock = 5, contentClock = 5))
            db.updates().insert(UpdateEntity(noteId = "garden", state = UpdateEntity.SYNCED, update = "S1"))
        }
        val linked = linked()
        page(linked, FromEditor.WatchNote("garden", on = true))
        waitFor { "garden" in linked.watched }
        Thread.sleep(100)
        assertTrue(sync.synced.isEmpty())
        // The open note's poll read /sync/changes: the garden changed on the server.
        runBlocking { db.notes().updateMetadata("garden", "Garden", "", 9, 7, false, 7, "note", null) }
        waitFor { sync.synced.isNotEmpty() }
        assertEquals(listOf("garden"), sync.synced.toList())
    }

    @Test
    fun followsAtMostEightNotesAndTheNextWaitsForATurn() {
        val linked = linked()
        for (i in 1..9) page(linked, FromEditor.WatchNote("n$i", on = true))
        waitFor { linked.watched.size == LinkedNotes.MAX_WATCHED }
        assertEquals((1..8).map { "n$it" }.toSet(), linked.watched)
        page(linked, FromEditor.WatchNote("n1", on = false))
        waitFor { "n9" in linked.watched }
        assertEquals(LinkedNotes.MAX_WATCHED, linked.watched.size)
    }

    @Test
    fun aReloadedPageStartsWithNothingWatched() {
        val linked = linked()
        page(linked, FromEditor.WatchNote("garden", on = true))
        waitFor { "garden" in linked.watched }
        page(linked, FromEditor.Ready)
        waitFor { linked.watched.isEmpty() }
    }

    // --- the open note's side (NoteEditorController) ---

    private val openedAt = CopyOnWriteArrayList<Pair<String, String?>>()

    private fun controller(heading: String? = null) = NoteEditorController(
        "n",
        store,
        sync,
        scope,
        send = { sent += BridgeProtocol.decodeToEditor(it)!! },
        onOpenNote = { openedAt += it to null },
        pollMs = 60_000,
        onOpenAt = { id, at -> openedAt += id to at },
        heading = heading,
    )

    private fun page(controller: NoteEditorController, message: FromEditor) = runBlocking(thread) {
        controller.onPageMessage(BridgeProtocol.encode(message))
    }

    @Test
    fun opensALinkAtTheHeadingItNames() {
        stored("n", UpdateEntity.SYNCED, "S1")
        val controller = controller()
        page(controller, FromEditor.OpenNote("garden", "Beds"))
        page(controller, FromEditor.OpenNote("beds"))
        assertEquals(listOf("garden" to "Beds", "beds" to null), openedAt.toList())
    }

    @Test
    fun aHeadingLinkToTheOpenNoteScrollsThereInsteadOfOpeningItAgain() {
        stored("n", UpdateEntity.SYNCED, "S1")
        val controller = controller()
        page(controller, FromEditor.Ready)
        page(controller, FromEditor.Opened("n", "Garden", null, null))
        // `[[#Beds]]` or `[[Garden#Beds]]` in Garden itself: the web's NoteView just scrolls.
        page(controller, FromEditor.OpenNote("n", "Beds"))
        page(controller, FromEditor.OpenNote("n", "Paths"))
        waitFor { sent.filterIsInstance<ToEditor.ShowHeading>().size == 2 }
        assertEquals(
            listOf(ToEditor.ShowHeading("n", "Beds"), ToEditor.ShowHeading("n", "Paths")),
            sent.filterIsInstance<ToEditor.ShowHeading>(),
        )
        // A link to the note itself with no heading goes nowhere; neither opens a second copy.
        page(controller, FromEditor.OpenNote("n"))
        assertTrue(openedAt.isEmpty())
        // Another note still opens.
        page(controller, FromEditor.OpenNote("garden", "Beds"))
        assertEquals(listOf("garden" to "Beds"), openedAt.toList())
    }

    @Test
    fun scrollsToTheHeadingItWasOpenedAtOnceTheNoteShows() {
        stored("n", UpdateEntity.SYNCED, "S1")
        val controller = controller(heading = "Beds")
        page(controller, FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Open } }
        assertTrue(sent.none { it is ToEditor.ShowHeading })
        page(controller, FromEditor.Opened("n", "Garden", null, null))
        waitFor { sent.any { it is ToEditor.ShowHeading } }
        assertEquals(ToEditor.ShowHeading("n", "Beds"), sent.filterIsInstance<ToEditor.ShowHeading>().single())
        // Reopened (a restore): the place is kept, not jumped back to.
        page(controller, FromEditor.Opened("n", "Garden", null, null))
        Thread.sleep(100)
        assertEquals(1, sent.filterIsInstance<ToEditor.ShowHeading>().size)
    }

    @Test
    fun keepsTheNotesDetailsAndItsOwnLinks() {
        stored("n", UpdateEntity.SYNCED, "S1")
        val controller = controller()
        val info = FromEditor.NoteInfo("n", "2026-10-23T10:00:00-05:00", "note", null, listOf(InfoField("id", "n")), listOf("garden"))
        page(controller, info)
        assertEquals(info, controller.info.value)
        waitFor { runBlocking { store.linksOf("n") } == listOf("garden") }
        // Another note's details are not this screen's.
        page(controller, info.copy(noteId = "other", links = listOf("beds")))
        assertEquals(info, controller.info.value)
    }
}
