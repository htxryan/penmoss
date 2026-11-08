package app.penmoss.editor

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.Notebooks
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.editor.NoteEditorController.TagChange
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.bridge.ToEditor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * New note on the phone and the open note's tags (T38), with the page played by the test: the
 * page makes the note and changes its tags; the app stores what it sends, as any edit.
 */
@RunWith(AndroidJUnit4::class)
class OrganiseControllerTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private val sent = CopyOnWriteArrayList<ToEditor>()
    private val sync = NoteEditorControllerTest.FakeSync()
    private val created = AtomicInteger()

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db)
        runBlocking { store.saveTree(SyncTree("h", folders = listOf(TreeFolder("garden", "Garden")))) }
    }

    @After
    fun close() {
        // Waits for the cancelled work to end: a Room query still running would otherwise fail on the
        // closed database after this test, and be reported against whichever test runs next.
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }
        thread.close()
        db.close()
    }

    private fun controller(id: String = "n", create: NewNoteRequest? = null) = NoteEditorController(
        id,
        store,
        sync,
        scope,
        send = { sent += BridgeProtocol.decodeToEditor(it)!! },
        onOpenNote = {},
        pollMs = 60_000,
        create = create,
        onCreated = { created.incrementAndGet() },
    )

    private fun page(controller: NoteEditorController, message: FromEditor) = runBlocking(thread) {
        controller.onPageMessage(BridgeProtocol.encode(message))
    }

    private fun waitFor(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) { while (!condition()) kotlinx.coroutines.delay(10) }
    }

    private fun pending(id: String) = runBlocking { db.updates().updates(id, UpdateEntity.PENDING).map { it.update } }

    @Test
    fun newNoteIsMadeByThePageStoredOfflineAndOpened() {
        val controller = controller("new", NewNoteRequest("garden"))
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        // The page makes it: no request to the server, which may be out of reach.
        assertEquals(listOf<ToEditor>(ToEditor.Create("new", Notebooks.DEFAULT)), sent.toList())
        page(controller, FromEditor.Created("new", PageNote("new", "", "WHOLE")))
        waitFor { sent.size == 2 }
        val open = sent[1] as ToEditor.Open
        assertEquals(listOf("WHOLE"), open.pending.map { it.update })
        assertTrue(open.editable)
        // Stored to upload and file in the folder chosen, and listed there at once.
        assertEquals(listOf("WHOLE"), pending("new"))
        val note = runBlocking { store.note("new")!! }
        assertTrue(note.toFile)
        assertEquals("garden", note.fileIn)
        assertEquals("garden", note.folderId)
        assertEquals(listOf("new"), sync.edited.toList())
        assertEquals(1, created.get())
        assertEquals(emptyList<String>(), sync.synced.toList())
    }

    /**
     * A note made in a notebook's folder records that notebook (T43, A766, fix c): the page is told
     * it with the create, and again with the note when it opens, for the notes its links make.
     */
    @Test
    fun aNewNoteInANotebookIsToldItsNotebook() {
        runBlocking {
            store.saveTree(SyncTree("h2", folders = listOf(TreeFolder("w", "Work", notebook = true), TreeFolder("plans", "Plans", "w"))))
        }
        val controller = controller("new", NewNoteRequest("plans"))
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        assertEquals(ToEditor.Create("new", "w"), sent.single())
        page(controller, FromEditor.Created("new", PageNote("new", "", "WHOLE")))
        waitFor { sent.size == 2 }
        assertEquals("w", (sent[1] as ToEditor.Open).notebook)
        assertEquals("w", runBlocking { store.note("new")!!.moveNotebook })
    }

    @Test
    fun aPageThatReloadsBeforeMakingTheNoteIsAskedAgain() {
        val controller = controller("new", NewNoteRequest(null))
        page(controller, FromEditor.Ready)
        waitFor { sent.size == 1 }
        controller.pageGone()
        page(controller, FromEditor.Ready)
        waitFor { sent.size == 2 }
        assertEquals(ToEditor.Create("new", Notebooks.DEFAULT), sent[1])
        page(controller, FromEditor.Created("new", PageNote("new", "", "WHOLE")))
        waitFor { sent.any { it is ToEditor.Open } }
        // A late answer from the first page changes nothing: the note is stored once.
        page(controller, FromEditor.Created("new", PageNote("new", "", "OTHER")))
        runBlocking(thread) {}
        assertEquals(listOf("WHOLE"), pending("new"))
        assertEquals(1, created.get())
    }

    @Test
    fun aNewNoteAlreadyStoredOpensAsItIs() {
        // The screen was rebuilt (the process came back) after the note was made.
        runBlocking { store.addLocalNote(PageNote("new", "Draft", "WHOLE"), "garden") }
        val controller = controller("new", NewNoteRequest("garden"))
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        assertTrue(sent.single() is ToEditor.Open)
        assertEquals(0, created.get())
    }

    @Test
    fun aNoteTheServerMadeIsNeverMadeAgain() {
        // Only a new note's screen asks the page to make one.
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller("n")
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Created("n", PageNote("n", "", "FORGED")))
        runBlocking(thread) {}
        assertEquals(emptyList<String>(), pending("n"))
        assertFalse(sent.any { it is ToEditor.Create })
    }

    private fun openedNote(): NoteEditorController {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller("n")
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "Soup", null, null))
        return controller
    }

    @Test
    fun followsTheTagsThePageReads() {
        val controller = openedNote()
        assertNull(controller.tags.value)
        page(controller, FromEditor.Tags("n", listOf("area/cooking", "soup")))
        assertEquals(listOf("area/cooking", "soup"), controller.tags.value)
        // Another note's tags are not this one's.
        page(controller, FromEditor.Tags("other", listOf("x")))
        assertEquals(listOf("area/cooking", "soup"), runBlocking { controller.tags.first() })
    }

    @Test
    fun aTagChangeGoesToThePageAndComesBackAsAnEditStoredToUpload() {
        val controller = openedNote()
        assertEquals(TagChange.SENT, controller.setTag("dinner", on = true))
        assertEquals(ToEditor.SetTag("n", "dinner", true), sent.last())
        assertEquals(TagChange.SENT, controller.setTag("soup", on = false))
        assertEquals(ToEditor.SetTag("n", "soup", false), sent.last())
        // The page changed the document: its edit is stored as pending, offline or not, and synced.
        page(controller, FromEditor.Update("n", "TAGGED"))
        waitFor { sync.edited.isNotEmpty() }
        assertEquals(listOf("TAGGED"), pending("n"))
    }

    @Test
    fun noTagChangeBeforeTheNoteIsOpenOrWhenItIsReadOnly() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller("n")
        // Still opening (or the page reloading): said so, not "can't be changed" (T38 review).
        assertEquals(TagChange.OPENING, controller.setTag("dinner", on = true))
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "Soup", null, null))
        // Content a newer Penmoss wrote: shown read-only (A158), and its tags with it.
        page(controller, FromEditor.Unsupported("n", listOf("database")))
        assertEquals(TagChange.READ_ONLY, controller.setTag("dinner", on = true))
        assertFalse(sent.any { it is ToEditor.SetTag })
    }

    @Test
    fun aTagJoinsTheSuggestionsOnlyOnceThePageHasSetIt() {
        val controller = openedNote()
        controller.setTag("dinner", on = true)
        controller.setTag("refused", on = true)
        // The page set one and refused the other (a rule the phone missed, or read-only by now).
        page(controller, FromEditor.Tags("n", listOf("dinner")))
        waitFor { runBlocking { store.observeTagList().first() }.isNotEmpty() }
        runBlocking(thread) {}
        assertEquals(listOf("dinner"), runBlocking { store.observeTagList().first() }.map { it.name })
    }

    @Test
    fun aNewNoteWhoseIdIsTakenByARowWithNoContentIsNotOpenedEmpty() {
        // A row left without content under this id (deleted for good with edits kept apart).
        runBlocking {
            store.addLocalNote(PageNote("new", "", "WHOLE"), null)
            db.updates().deleteSynced("new")
            db.updates().keepPendingApart("new", null)
        }
        assertFalse(runBlocking { store.holds("new") })
        val controller = controller("new", NewNoteRequest(null))
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Created("new", PageNote("new", "", "OTHER")))
        waitFor { controller.state.value.phase == EditorUiState.Phase.UNAVAILABLE }
        assertFalse(sent.any { it is ToEditor.Open })
        assertEquals(0, created.get())
    }
}
