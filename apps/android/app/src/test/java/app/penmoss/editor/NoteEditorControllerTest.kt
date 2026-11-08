package app.penmoss.editor

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PictureRefused
import app.penmoss.data.PictureStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.Compacted
import app.penmoss.engine.bridge.FormatCommand
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.stopScope
import app.penmoss.sync.NoteSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import androidx.room.Room
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.sync.Exchange
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

/**
 * The app's side of an open note (T32, A282), with the page played by the
 * test: what the app sends it, and what it does with what the page sends.
 */
@RunWith(AndroidJUnit4::class)
class NoteEditorControllerTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    /** One thread, as the app's main thread: the page's messages and the controller's work interleave there. */
    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private val sent = CopyOnWriteArrayList<ToEditor>()
    private val sync = FakeSync()

    class FakeSync : NoteSync {
        override val exchanges = MutableSharedFlow<ExchangeResult>(extraBufferCapacity = 16)
        override val foreground = MutableStateFlow(true)
        val synced = CopyOnWriteArrayList<String>()
        val refreshed = CopyOnWriteArrayList<String>()
        val edited = CopyOnWriteArrayList<String>()
        var onSync: suspend (String) -> Unit = {}

        override suspend fun syncNote(noteId: String): ExchangeResult? {
            synced += noteId
            onSync(noteId)
            return null
        }

        override suspend fun refreshNote(noteId: String): ExchangeResult? {
            refreshed += noteId
            return null
        }

        override fun noteEdited(noteId: String) {
            edited += noteId
        }
    }

    /** Holds every Room transaction while closed: a read the test wants something to happen during. */
    @Volatile
    private var gate: CountDownLatch? = null
    private val transactions = Executors.newSingleThreadExecutor()

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), PenmossDatabase::class.java)
            .setTransactionExecutor { task -> transactions.execute { gate?.await(); task.run() } }
            .build()
        store = NoteStore(db)
    }

    @After
    fun close() {
        gate?.countDown()
        // Its work ends before the dispatcher and the database close (A690).
        stopScope(scope)
        thread.close()
        db.close()
        transactions.shutdown()
    }

    private val editors = OpenEditors()

    private fun controller(id: String = "n", pictures: PictureStore? = null, pollMs: Long = 60_000, onCommentSent: () -> Unit = {}) = NoteEditorController(
        id,
        store,
        sync,
        scope,
        send = { sent += BridgeProtocol.decodeToEditor(it)!! },
        onOpenNote = { opened += it },
        pollMs = pollMs,
        pictures = pictures,
        openEditors = editors,
        onPageError = { pageErrors += it },
        onOpenTag = { tagsOpened += it },
        onCommentSent = onCommentSent,
    )

    private val tagsOpened = CopyOnWriteArrayList<String>()

    private val pageErrors = CopyOnWriteArrayList<String>()

    private val opened = CopyOnWriteArrayList<String>()

    private fun page(controller: NoteEditorController, message: FromEditor) = runBlocking(thread) {
        controller.onPageMessage(BridgeProtocol.encode(message))
    }

    private fun waitFor(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) { while (!condition()) kotlinx.coroutines.delay(10) }
    }

    @Test
    fun opensTheStoredNoteOnceThePageIsReady() {
        runBlocking {
            db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1"))
            db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.PENDING, update = "P1"))
        }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        val open = sent.filterIsInstance<ToEditor.Open>().single()
        assertEquals(listOf("S1"), open.synced.map { it.update })
        assertEquals(listOf("P1"), open.pending.map { it.update })
        assertTrue(open.editable)
        // Held already: nothing fetched before opening.
        assertEquals(emptyList<String>(), sync.synced)
    }

    @Test
    fun fetchesANoteThePhoneDoesNotHoldBeforeOpeningIt() {
        sync.onSync = { db.updates().insert(UpdateEntity(noteId = it, state = UpdateEntity.SYNCED, update = "FETCHED")) }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        assertEquals(listOf("n"), sync.synced.take(1))
        assertEquals(listOf("FETCHED"), (sent.filterIsInstance<ToEditor.Open>().single()).synced.map { it.update })
    }

    @Test
    fun saysSoWhenTheNoteCannotBeFetched() {
        val controller = controller()
        waitFor { controller.state.value.phase == EditorUiState.Phase.UNAVAILABLE }
        assertTrue(controller.state.value.message!!.contains("isn't on the phone"))
    }

    @Test
    fun aNoteThatCouldNotBeFetchedOpensOnceTriedAgainOnline() {
        val controller = controller()
        waitFor { controller.state.value.phase == EditorUiState.Phase.UNAVAILABLE }
        // Back online (T39): Try again fetches it and the note opens, without leaving the screen.
        sync.onSync = { db.updates().insert(UpdateEntity(noteId = it, state = UpdateEntity.SYNCED, update = "FETCHED")) }
        runBlocking(thread) { controller.retry() }
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        assertEquals(listOf("FETCHED"), (sent.filterIsInstance<ToEditor.Open>().single()).synced.map { it.update })
        assertEquals(EditorUiState.Phase.LOADING, controller.state.value.phase)
        assertEquals(null, controller.state.value.message)
    }

    @Test
    fun aNoteThatCouldNotBeFetchedOpensWhenSyncBringsIt() {
        val controller = controller()
        waitFor { controller.state.value.phase == EditorUiState.Phase.UNAVAILABLE }
        // A pass in front fetched it meanwhile (T39): the screen opens it by itself.
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "FETCHED")) }
        runBlocking { sync.exchanges.emit(ExchangeResult("n", ExchangeResult.Kind.APPLIED)) }
        waitFor { controller.state.value.phase == EditorUiState.Phase.LOADING }
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        assertEquals(listOf("FETCHED"), (sent.filterIsInstance<ToEditor.Open>().single()).synced.map { it.update })
    }

    @Test
    fun aPageReadyBeforeTheFetchFailedGetsTheNoteOnceTriedAgain() {
        // As on a phone (T39 review): the page loads while the fetch is failing, and stays.
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { controller.state.value.phase == EditorUiState.Phase.UNAVAILABLE }
        assertEquals(emptyList<ToEditor>(), sent.toList())
        sync.onSync = { db.updates().insert(UpdateEntity(noteId = it, state = UpdateEntity.SYNCED, update = "FETCHED")) }
        runBlocking(thread) { controller.retry() }
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "Fetched", null, null))
        assertEquals(EditorUiState.Phase.READY, controller.state.value.phase)
        // Exactly one open, to the one page there is, with the fetched note (plus the period asked of it, T40 P5).
        assertEquals(listOf("FETCHED"), sent.filterIsInstance<ToEditor.Open>().single().synced.map { it.update })
        assertEquals(1, sent.filterIsInstance<ToEditor.Open>().size)
    }

    @Test
    fun aPageReadyBeforeTheFetchFailedGetsTheNoteOnceSyncBringsIt() {
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { controller.state.value.phase == EditorUiState.Phase.UNAVAILABLE }
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "FETCHED")) }
        runBlocking { sync.exchanges.emit(ExchangeResult("n", ExchangeResult.Kind.APPLIED)) }
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "Fetched", null, null))
        assertEquals(EditorUiState.Phase.READY, controller.state.value.phase)
        assertEquals(listOf("FETCHED"), sent.filterIsInstance<ToEditor.Open>().single().synced.map { it.update })
        // The open, plus the period asked of it (T40 P5).
        assertEquals(1, sent.filterIsInstance<ToEditor.Open>().size)
    }

    @Test
    fun aPageThatLoadsAgainGetsTheNoteAgain() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        // Each page gets what is sent once it has spoken, as through EditorWebView.Channel.
        val pages = listOf(CopyOnWriteArrayList<ToEditor>(), CopyOnWriteArrayList<ToEditor>())
        var current = 0
        val controller = NoteEditorController(
            "n",
            store,
            sync,
            scope,
            send = { pages[current] += BridgeProtocol.decodeToEditor(it)!! },
            onOpenNote = {},
            pollMs = 60_000,
            openEditors = editors,
        )
        page(controller, FromEditor.Ready)
        waitFor { pages[0].isNotEmpty() }
        // The first page never answers; a new page in its place says ready: it must not stay blank.
        current = 1
        page(controller, FromEditor.Ready)
        waitFor { pages[1].isNotEmpty() }
        assertEquals(listOf("S1"), (pages[1].single() as ToEditor.Open).synced.map { it.update })
        page(controller, FromEditor.Opened("n", "Note", null, null))
        assertEquals(EditorUiState.Phase.READY, controller.state.value.phase)
        assertEquals(1, pages[0].size)
    }

    @Test
    fun storesEditsAsPendingAndAsksForASync() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Update("n", "EDIT"))
        page(controller, FromEditor.Title("n", "New title"))
        waitFor { sync.edited.isNotEmpty() }
        runBlocking {
            assertEquals(listOf("EDIT"), db.updates().updates("n", UpdateEntity.PENDING).map { it.update })
        }
        waitFor { runBlocking { store.note("n")?.title } == "New title" }
        assertEquals("New title", controller.state.value.title)
    }

    /**
     * Send to… (T60, A1078): the page posts the thread's update, then `commentSent`; the notebook
     * syncs at once, but only once that update is stored, so the sync carries the target.
     */
    @Test
    fun aThreadSentToASessionSyncsOnceItsUpdateIsStored() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val synced = java.util.concurrent.atomic.AtomicInteger()
        val controller = controller(onCommentSent = { synced.incrementAndGet() })
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        gate = CountDownLatch(1)
        page(controller, FromEditor.Update("n", "TARGET"))
        page(controller, app.penmoss.engine.bridge.CommentFromEditor.Sent("n", "T1"))
        // Room has not stored it yet: no sync.
        Thread.sleep(300)
        assertEquals(0, synced.get())
        gate!!.countDown()
        waitFor { synced.get() == 1 }
        runBlocking {
            assertEquals(listOf("TARGET"), db.updates().updates("n", UpdateEntity.PENDING).map { it.update })
        }
        // Another note's word is not this one's.
        page(controller, app.penmoss.engine.bridge.CommentFromEditor.Sent("other", "T1"))
        runBlocking(thread) {}
        Thread.sleep(100)
        assertEquals(1, synced.get())
    }

    @Test
    fun appliesThePagesCompaction() {
        val ids = runBlocking {
            listOf("S1", "S2").map { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = it)) }
        }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "Title", Compacted(ids, "S12"), null))
        waitFor { runBlocking { db.updates().updates("n", UpdateEntity.SYNCED).map { it.update } } == listOf("S12") }
        assertEquals(EditorUiState.Phase.READY, controller.state.value.phase)
    }

    @Test
    fun passesWhatTheServerSentToThePage() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        runBlocking {
            sync.exchanges.emit(ExchangeResult("other", ExchangeResult.Kind.APPLIED, append = "NOT-THIS"))
            sync.exchanges.emit(ExchangeResult("n", ExchangeResult.Kind.APPLIED, append = "DIFF"))
        }
        waitFor { sent.size == 2 }
        assertEquals(ToEditor.Remote("n", "DIFF"), sent.last())
    }

    @Test
    fun closingWaitsForThePagesLastEdits() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        val closing = scope.async { controller.close() }
        waitFor { sent.lastOrNull() is ToEditor.Close }
        page(controller, FromEditor.Update("n", "LAST"))
        page(controller, FromEditor.Closed("n"))
        runBlocking { closing.await() }
        waitFor { runBlocking { db.updates().updates("n", UpdateEntity.PENDING).isNotEmpty() } }
    }

    /** History actions (T40 P3b, NT18–NT20) flush first: the wait ends once the last edits are stored. */
    @Test
    fun flushAndWaitStoresThePagesLastEditsBeforeReturning() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        val waiting = scope.async { controller.flushAndWait() }
        waitFor { sent.lastOrNull() is ToEditor.Flush }
        page(controller, FromEditor.Update("n", "LAST"))
        runBlocking { waiting.await() }
        waitFor { runBlocking { stored(UpdateEntity.PENDING).contains("LAST") } }
    }

    @Test
    fun flushAndWaitSendsNothingWhenTheNoteIsNotOpen() {
        val controller = controller()
        runBlocking { controller.flushAndWait() }
        assertTrue(sent.none { it is ToEditor.Flush })
    }

    /** History actions (T40 P3b fixup): a slow page's Update still lands before the wait ends. */
    @Test
    fun flushAndWaitWaitsForAnUpdateThatArrivesLate() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        val waiting = scope.async { controller.flushAndWait() }
        waitFor { sent.lastOrNull() is ToEditor.Flush }
        // The page is slow: its Update lands ~200 ms after the Flush.
        Thread.sleep(200)
        assertFalse(waiting.isCompleted)
        page(controller, FromEditor.Update("n", "LATE"))
        runBlocking { waiting.await() }
        waitFor { stored(UpdateEntity.PENDING).contains("LATE") }
    }

    @Test
    fun followsWikilinksThroughTheApp() {
        val controller = controller()
        page(controller, FromEditor.OpenNote("other-note"))
        assertEquals(listOf("other-note"), opened)
    }

    @Test
    fun opensATagTappedInTheNoteAndNoneForAnotherNote() {
        val controller = controller()
        page(controller, FromEditor.OpenTag("n", "area/cooking"))
        page(controller, FromEditor.OpenTag("other-note", "soup"))
        assertEquals(listOf("area/cooking"), tagsOpened)
    }

    private fun syncedAt(epoch: String, update: String) = runBlocking {
        val content = store.content("n")
        store.saveExchange(Exchange.decide(content, Exchange.entry(content), BatchNoteReply("n", epoch, update, "SV-$update", null)))
    }

    private fun stored(state: Int) = runBlocking { db.updates().updates("n", state).map { it.update } }

    @Test
    fun anUpdateTheServerSendsWhileTheNoteIsOpeningStillReachesThePage() {
        syncedAt("e1", "S1")
        val controller = controller()
        waitFor { controller.isContentReady }
        // The open's read of the stored note is held; an exchange lands meanwhile (S7).
        gate = CountDownLatch(1)
        page(controller, FromEditor.Ready)
        waitFor { controller.isOpening }
        runBlocking { sync.exchanges.emit(ExchangeResult("n", ExchangeResult.Kind.APPLIED, append = "RACED")) }
        // Everything queued on the main thread before this has run: the exchange was handled.
        runBlocking(thread) {}
        assertEquals(emptyList<ToEditor>(), sent.toList())
        gate!!.countDown()
        waitFor { sent.size == 2 }
        assertTrue(sent[0] is ToEditor.Open)
        assertEquals(ToEditor.Remote("n", "RACED"), sent[1])
    }

    @Test
    fun theOpenNoteChecksForChangesOnlyWhileTheAppIsInFront() {
        syncedAt("e1", "S1")
        val controller = controller(pollMs = 20)
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "T", null, null))
        waitFor { sync.refreshed.size >= 2 }
        // The app leaves the screen with the note open (A327): no more checks, on any network.
        sync.foreground.value = false
        Thread.sleep(100)
        val left = sync.refreshed.size
        Thread.sleep(400)
        assertEquals(left, sync.refreshed.size)
        // Back in front, the checks go on.
        sync.foreground.value = true
        waitFor { sync.refreshed.size > left }
    }

    @Test
    fun editsOfTheCopyARestoreReplacedAreKeptApartWhileThePageReopens() {
        syncedAt("e1", "S1")
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "T", null, null))
        page(controller, FromEditor.Update("n", "BEFORE"))
        waitFor { stored(UpdateEntity.PENDING) == listOf("BEFORE") }

        // The server was restored: the exchange stores its copy (e2) and the page reopens on it (S3).
        runBlocking {
            val content = store.content("n")
            val reset = Exchange.decide(content, Exchange.entry(content), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch"))
            store.saveExchange(reset)
            sync.exchanges.emit(reset)
        }
        waitFor { sent.count { it is ToEditor.Open } == 2 }
        assertEquals(listOf("RESTORED"), (sent.last { it is ToEditor.Open } as ToEditor.Open).synced.map { it.update })
        // The page's last edits of the old copy come as it closes it, before it says `opened`.
        page(controller, FromEditor.Update("n", "FLUSHED"))
        page(controller, FromEditor.Opened("n", "T", null, null))
        page(controller, FromEditor.Update("n", "AFTER"))
        waitFor { stored(UpdateEntity.PENDING).isNotEmpty() && stored(UpdateEntity.CONFLICT).size == 2 }
        assertEquals(listOf("BEFORE", "FLUSHED"), stored(UpdateEntity.CONFLICT))
        assertEquals(listOf("AFTER"), stored(UpdateEntity.PENDING))
    }

    @Test
    fun hasThePageMergeALongRunOfPendingEdits() {
        syncedAt("e1", "S1")
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "T", null, null))
        repeat(NoteEditorController.COMPACT_AT) { page(controller, FromEditor.Update("n", "E$it")) }
        waitFor { sent.lastOrNull() is ToEditor.Compact }
        val compact = sent.last() as ToEditor.Compact
        assertEquals(NoteEditorController.COMPACT_AT, compact.updates.size)
        page(controller, FromEditor.Merged("n", Compacted(compact.updates.map { it.id }, "MERGED")))
        waitFor { stored(UpdateEntity.PENDING) == listOf("MERGED") }
        assertEquals(1, sent.count { it is ToEditor.Compact })
    }

    @Test
    fun aCrashedEditorSaysSoAndKeepsTheStoredEdits() {
        syncedAt("e1", "S1")
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Update("n", "KEPT"))
        waitFor { stored(UpdateEntity.PENDING) == listOf("KEPT") }
        runBlocking(thread) { controller.pageGone() }
        assertEquals(EditorUiState.Phase.UNAVAILABLE, controller.state.value.phase)
        assertTrue(controller.state.value.message!!.contains("stopped"))
        assertEquals(listOf("KEPT"), stored(UpdateEntity.PENDING))
    }

    // --- the writing screen (T33) ---

    /** Pictures as [app.penmoss.data.Attachments] takes them, without files. */
    class FakePictures : PictureStore {
        val added = CopyOnWriteArrayList<Pair<Int, String?>>()
        val fromPage = CopyOnWriteArrayList<Pair<String, Int>>()
        var accept = true

        override suspend fun add(bytes: ByteArray, noteId: String?): String {
            if (bytes.isEmpty()) throw PictureRefused("Only PNG, JPEG, GIF, WebP and AVIF pictures can be added")
            added += bytes.size to noteId
            return "attachments/${"a".repeat(64)}.png"
        }

        override suspend fun addFromPage(path: String, bytes: ByteArray, noteId: String): String? {
            fromPage += path to bytes.size
            return path.takeIf { accept }
        }
    }

    private fun openedController(pictures: PictureStore? = null): NoteEditorController {
        syncedAt("e1", "S1")
        val controller = controller(pictures = pictures)
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "T", null, null))
        sent.clear()
        return controller
    }

    @Test
    fun theBarsButtonsReachThePageOnlyOnceTheNoteIsOpen() {
        syncedAt("e1", "S1")
        val controller = controller()
        controller.format(FormatCommand.BOLD)
        controller.toggleSymbol(0)
        controller.dismissMenu()
        controller.refocus()
        assertEquals(emptyList<ToEditor>(), sent.toList())
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "T", null, null))
        sent.clear()
        controller.format(FormatCommand.BOLD)
        controller.format(FormatCommand.LINK, "penmoss.app")
        controller.format(FormatCommand.LINK)
        // The Symbol menu's toggle (T44, A747).
        controller.toggleSymbol(2)
        controller.dismissMenu()
        controller.refocus()
        assertEquals(
            listOf(
                ToEditor.Format("n", FormatCommand.BOLD),
                ToEditor.Format("n", FormatCommand.LINK, "penmoss.app"),
                ToEditor.Format("n", FormatCommand.LINK, ""),
                ToEditor.Symbol("n", 2),
                ToEditor.Dismiss("n"),
                ToEditor.Focus("n"),
            ),
            sent.toList(),
        )
    }

    /** The page's text goes to the offline index; opening marks the note recent (T40 P6, FD4, FD7). */
    @Test
    fun thePagesTextIsIndexedAndOpeningMarksTheNoteRecent() {
        val controller = openedController()
        waitFor { runBlocking { store.note("n")!!.openedAt > 0 } }
        page(controller, FromEditor.Text("n", "typed here about otters"))
        page(controller, FromEditor.Text("other", "not this note"))
        val search = app.penmoss.data.OfflineSearch(db)
        waitFor { runBlocking { search.search("otters").isNotEmpty() } }
        assertEquals(listOf("n"), runBlocking { search.search("otters").map { it.noteId } })
        assertEquals(emptyList<String>(), runBlocking { search.search("this").map { it.noteId } })
    }

    @Test
    fun theBarShowsWhatThePageReports() {
        val controller = openedController()
        page(controller, FromEditor.State("n", listOf(FormatCommand.BOLD, FormatCommand.LINK), true, false, true, false, "https://penmoss.app", true))
        assertEquals(
            FormatState(setOf(FormatCommand.BOLD, FormatCommand.LINK), canUndo = true, canIndent = true, href = "https://penmoss.app", menu = true),
            controller.format.value,
        )
        // Another note's state is not this one's.
        page(controller, FromEditor.State("other", emptyList(), false, false, false, false, null, false))
        assertTrue(controller.format.value.menu)
    }

    @Test
    fun aPastedPicturesBytesAreStoredUnderThePathThatCameBefore() {
        val pictures = FakePictures()
        val controller = openedController(pictures)
        val path = "attachments/${"b".repeat(64)}.png"
        // Bytes with no message before them, or of another size, are dropped.
        runBlocking(thread) { controller.onPageBytes(ByteArray(3)) }
        page(controller, FromEditor.Attachment("n", path, 5))
        runBlocking(thread) { controller.onPageBytes(ByteArray(4)) }
        page(controller, FromEditor.Attachment("n", path, 5))
        runBlocking(thread) { controller.onPageBytes(ByteArray(5)) }
        waitFor { pictures.fromPage.isNotEmpty() }
        waitFor { sent.count { it is ToEditor.AttachmentStored } == 2 }
        assertEquals(listOf(path to 5), pictures.fromPage.toList())
        // The page inserts the picture only on the app's answer (A311): no for the bytes of the
        // wrong size, yes once stored.
        assertEquals(
            listOf(ToEditor.AttachmentStored("n", path, ok = false), ToEditor.AttachmentStored("n", path, ok = true)),
            sent.filterIsInstance<ToEditor.AttachmentStored>(),
        )
    }

    @Test
    fun saysSoWhenAPastedPictureCannotBeStored() {
        val pictures = FakePictures().apply { accept = false }
        val controller = openedController(pictures)
        val notices = CopyOnWriteArrayList<String>()
        val listening = scope.async { controller.notices.collect { notices += it } }
        runBlocking(thread) {}
        val path = "attachments/${"c".repeat(64)}.png"
        page(controller, FromEditor.Attachment("n", path, 2))
        runBlocking(thread) { controller.onPageBytes(ByteArray(2)) }
        // The page leaves the picture out and says so itself.
        waitFor { sent.any { it is ToEditor.AttachmentStored } }
        assertEquals(ToEditor.AttachmentStored("n", path, ok = false), sent.single { it is ToEditor.AttachmentStored })
        page(controller, FromEditor.Notice("n", "The picture could not be stored on this phone"))
        waitFor { notices.size == 1 }
        assertEquals(listOf("The picture could not be stored on this phone"), notices.toList())
        listening.cancel()
    }

    @Test
    fun picturesFromThePickerAreStoredFirstThenInserted() {
        val pictures = FakePictures()
        val controller = openedController(pictures)
        val notices = CopyOnWriteArrayList<String>()
        val listening = scope.async { controller.notices.collect { notices += it } }
        runBlocking(thread) {}
        runBlocking(thread) { controller.insertPictures(listOf(ByteArray(10), ByteArray(0))) }
        assertEquals(listOf(10 to "n"), pictures.added.toList())
        assertEquals(listOf(ToEditor.InsertImages("n", listOf("attachments/${"a".repeat(64)}.png"))), sent.toList())
        waitFor { notices.isNotEmpty() }
        assertTrue(notices.single().startsWith("Only PNG"))
        // Nothing stored: nothing inserted.
        sent.clear()
        runBlocking(thread) { controller.insertPictures(listOf(ByteArray(0))) }
        assertEquals(emptyList<ToEditor>(), sent.toList())
        listening.cancel()
    }

    @Test
    fun aNoteALinkMadeIsStoredBesideTheNoteAndSynced() {
        val controller = openedController()
        runBlocking { db.notes().place("n", "folder", "a0") }
        page(controller, FromEditor.NewNote("n", PageNote("made", "Plans", "WHOLE")))
        waitFor { sync.edited.contains("made") }
        val made = runBlocking { store.note("made") }!!
        assertEquals("folder", made.fileIn)
        assertTrue(made.toFile)
        assertEquals(listOf("WHOLE"), runBlocking { db.updates().updates("made", UpdateEntity.PENDING).map { it.update } })
        // The same note again (the page retried): stored once, synced once.
        page(controller, FromEditor.NewNote("n", PageNote("made", "Plans", "OTHER")))
        runBlocking(thread) {}
        runBlocking { assertEquals(listOf("WHOLE"), db.updates().updates("made", UpdateEntity.PENDING).map { it.update }) }
        assertFalse(sync.edited.count { it == "made" } > 1)
    }

    // --- review fixes ---

    @Test
    fun saysWhichCopiesItMayStillSendEditsOf() {
        syncedAt("e1", "S1")
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        waitFor { editors.holds("n", "e1") }
        page(controller, FromEditor.Opened("n", "T", null, null))
        assertTrue(editors.holds("n", "e1"))
        // A restore: the page reopens on e2, and holds e1 until it says `opened`.
        runBlocking {
            val content = store.content("n")
            val reset = Exchange.decide(content, Exchange.entry(content), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch"))
            store.saveExchange(reset)
            sync.exchanges.emit(reset)
        }
        waitFor { sent.count { it is ToEditor.Open } == 2 }
        assertTrue(editors.holds("n", "e1"))
        assertTrue(editors.holds("n", "e2"))
        page(controller, FromEditor.Update("n", "FLUSHED"))
        page(controller, FromEditor.Opened("n", "T", null, null))
        waitFor { !editors.holds("n", "e1") }
        // Let go only once the last edit of e1 was stored.
        assertEquals(listOf("FLUSHED"), stored(UpdateEntity.CONFLICT))
        assertTrue(editors.holds("n", "e2"))
        runBlocking { scope.async { controller.close() }.await() }
        assertFalse(editors.holds("n", "e2"))
    }

    @Test
    fun anOpenThePageCouldNotDoLeavesNoEpochBehind() {
        syncedAt("e1", "S1")
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "T", null, null))
        runBlocking {
            val content = store.content("n")
            val reset = Exchange.decide(content, Exchange.entry(content), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch"))
            store.saveExchange(reset)
            sync.exchanges.emit(reset)
        }
        waitFor { sent.count { it is ToEditor.Open } == 2 }
        // The page could not open e2 (no `opened`); an open after it must not be taken for e2's.
        page(controller, FromEditor.Error("n", "The note could not be opened"))
        assertFalse(editors.holds("n", "e2"))
        // And it is reported to the recent errors (A427).
        assertEquals(listOf("The note could not be opened"), pageErrors.toList())
    }

    @Test
    fun picturesPickedWhileThePageIsReopeningAreInsertedOnceItIsOpen() {
        val pictures = FakePictures()
        syncedAt("e1", "S1")
        val controller = controller(pictures = pictures)
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        sent.clear()
        // `open` sent, `opened` not yet.
        runBlocking(thread) { controller.insertPictures(listOf(ByteArray(10))) }
        assertEquals(emptyList<ToEditor>(), sent.filterIsInstance<ToEditor.InsertImages>())
        page(controller, FromEditor.Opened("n", "T", null, null))
        assertEquals(
            listOf(ToEditor.InsertImages("n", listOf("attachments/${"a".repeat(64)}.png"))),
            sent.filterIsInstance<ToEditor.InsertImages>(),
        )
    }

    @Test
    fun aNoteOpenedBeforeItHadAnEpochTakesTheOneTheServerNames() {
        // A link's new note, made on the phone: no epoch until its first exchange.
        runBlocking { store.addLocalNote(PageNote("n", "New", "WHOLE"), null) }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "New", null, null))
        runBlocking { sync.exchanges.emit(ExchangeResult("n", ExchangeResult.Kind.APPLIED, epoch = "e1")) }
        waitFor { editors.holds("n", "e1") }
        page(controller, FromEditor.Update("n", "TYPED"))
        waitFor { runBlocking { db.updates().updates("n", UpdateEntity.PENDING).any { it.update == "TYPED" } } }
        assertEquals("e1", runBlocking { db.updates().updates("n", UpdateEntity.PENDING).single { it.update == "TYPED" }.epoch })
    }

    @Test
    fun aLinksNewNoteGoesWhereItsUnfiledSourceWillBeFiled() {
        runBlocking { store.addLocalNote(PageNote("n", "Made here", "WHOLE"), "projects") }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        page(controller, FromEditor.Opened("n", "Made here", null, null))
        page(controller, FromEditor.NewNote("n", PageNote("child", "Child", "C")))
        waitFor { runBlocking { store.note("child") } != null }
        assertEquals("projects", runBlocking { store.note("child") }!!.fileIn)
    }

    /** A daily or weekly note's screen (T40 P5): the controller's periodic side. */
    private val made = CopyOnWriteArrayList<String>()

    private fun periodicController(
        kind: ToEditor.PeriodKind = ToEditor.PeriodKind.DAILY,
        day: String? = null,
        waitMs: Long = 60_000,
    ) = NoteEditorController(
        "periodic",
        store,
        sync,
        scope,
        send = { sent += BridgeProtocol.decodeToEditor(it)!! },
        onOpenNote = { opened += it },
        pollMs = 60_000,
        openEditors = editors,
        periodic = PeriodicNoteRequest(kind, day),
        onPeriodicMade = { made += it },
        onPageError = { pageErrors += it },
        periodicWaitMs = waitMs,
    )

    private fun seedSettings() = runBlocking {
        // The settings channel first (T40 P1): the tree carries what the server holds.
        store.saveTree(
            SyncTree(
                "h",
                settings = kotlinx.serialization.json.buildJsonObject {
                    put("timeZone", kotlinx.serialization.json.JsonPrimitive("Pacific/Auckland"))
                    put("template.daily", kotlinx.serialization.json.JsonPrimitive("## Day\n"))
                },
            ),
        )
    }

    @Test
    fun asksThePageForThePeriodsNoteWithTheSyncedTimeZoneAndTemplate() {
        seedSettings()
        val before = System.currentTimeMillis()
        val controller = periodicController(day = "2026-10-21")
        page(controller, FromEditor.Ready)
        waitFor { sent.filterIsInstance<ToEditor.CreatePeriodic>().isNotEmpty() }
        val asked = sent.filterIsInstance<ToEditor.CreatePeriodic>().single()
        assertEquals(ToEditor.PeriodKind.DAILY, asked.kind)
        assertEquals("2026-10-21", asked.day)
        // The synced zone and template, never the phone's zone; `at` is about now.
        assertEquals("Pacific/Auckland", asked.timeZone)
        assertEquals("## Day\n", asked.template)
        assertTrue(asked.at in before..System.currentTimeMillis())
        // Asked again when the page reloads first.
        page(controller, FromEditor.Ready)
        waitFor { sent.filterIsInstance<ToEditor.CreatePeriodic>().size == 2 }
    }

    @Test
    fun storesThePeriodsNoteFilesItThroughTheDailyIntentAndOpensIt() {
        val controller = periodicController()
        page(controller, FromEditor.Ready)
        waitFor { sent.filterIsInstance<ToEditor.CreatePeriodic>().isNotEmpty() }
        page(
            controller,
            FromEditor.CreatedPeriodic(PageNote("d1", "2026-10-21", "U1"), ToEditor.PeriodKind.DAILY, "2026-10-21", "2026-10-21"),
        )
        waitFor { made.isNotEmpty() }
        assertEquals(listOf("d1"), made.toList())
        val note = runBlocking { store.note("d1") }!!
        assertEquals("daily", note.kind)
        assertEquals("2026-10-21", note.period)
        assertEquals("daily", note.fileKind)
        assertEquals("2026-10-21", note.fileDate)
        assertEquals(listOf("d1"), sync.edited.toList())
        // A rebuild of the same note is answered once: nothing is stored or opened twice.
        page(
            controller,
            FromEditor.CreatedPeriodic(PageNote("d1", "2026-10-21", "U1"), ToEditor.PeriodKind.DAILY, "2026-10-21", "2026-10-21"),
        )
        assertEquals(1, runBlocking { db.updates().updates("d1", UpdateEntity.PENDING).size })
    }

    @Test
    fun saysSoWhenThePageCannotMakeThePeriodsNote() {
        val controller = periodicController()
        page(controller, FromEditor.Ready)
        waitFor { sent.filterIsInstance<ToEditor.CreatePeriodic>().isNotEmpty() }
        val request = sent.filterIsInstance<ToEditor.CreatePeriodic>().single().request
        assertNotNull(request)
        page(controller, FromEditor.Error(null, "The daily note could not be made: RangeError: Not a day", request))
        waitFor { controller.state.value.phase == EditorUiState.Phase.UNAVAILABLE }
        assertTrue(controller.state.value.message!!.contains("could not be made"))
        assertEquals(listOf("The daily note could not be made: RangeError: Not a day"), pageErrors.toList())
    }

    /** T40 P9 (P5 review N7): another error, with no note id, does not end a waiting Today. */
    @Test
    fun keepsWaitingThroughAnErrorThatIsNotItsRequests() {
        val controller = periodicController()
        page(controller, FromEditor.Ready)
        waitFor { sent.filterIsInstance<ToEditor.CreatePeriodic>().isNotEmpty() }
        val request = sent.filterIsInstance<ToEditor.CreatePeriodic>().single().request!!
        // A message the page could not read, and an earlier request's error: neither is this one.
        page(controller, FromEditor.Error(null, "The app sent a message this editor cannot read"))
        page(controller, FromEditor.Error(null, "The daily note could not be made", "p-0"))
        page(controller, FromEditor.Error("other", "The note could not be opened"))
        assertEquals(EditorUiState.Phase.LOADING, controller.state.value.phase)
        // Each is still reported to the recent errors.
        assertEquals(3, pageErrors.size)
        // The page then answers the request: the note is made and opens.
        page(
            controller,
            FromEditor.CreatedPeriodic(PageNote("d1", "2026-10-21", "U1"), ToEditor.PeriodKind.DAILY, "2026-10-21", "2026-10-21"),
        )
        waitFor { made.isNotEmpty() }
        assertEquals(listOf("d1"), made.toList())
        assertTrue(request.isNotEmpty())
    }

    /** T40 P9 review S8: a page that never answers (it could not read the request) ends the wait. */
    @Test
    fun saysSoWhenThePageNeverAnswersToday() {
        val controller = periodicController(waitMs = 200)
        page(controller, FromEditor.Ready)
        waitFor { sent.filterIsInstance<ToEditor.CreatePeriodic>().isNotEmpty() }
        page(controller, FromEditor.Error(null, "The app sent a message this editor cannot read"))
        assertEquals(EditorUiState.Phase.LOADING, controller.state.value.phase)
        waitFor { controller.state.value.phase == EditorUiState.Phase.UNAVAILABLE }
        assertEquals("The note could not be made.", controller.state.value.message)
        assertTrue(made.isEmpty())
    }

    /** The wait ends once: a note made in time is not then said to have failed. */
    @Test
    fun aNoteMadeInTimeIsNotThenSaidToHaveFailed() {
        val controller = periodicController(waitMs = 300)
        page(controller, FromEditor.Ready)
        waitFor { sent.filterIsInstance<ToEditor.CreatePeriodic>().isNotEmpty() }
        page(
            controller,
            FromEditor.CreatedPeriodic(PageNote("d1", "2026-10-21", "U1"), ToEditor.PeriodKind.DAILY, "2026-10-21", "2026-10-21"),
        )
        waitFor { made.isNotEmpty() }
        Thread.sleep(600)
        assertTrue(controller.state.value.phase != EditorUiState.Phase.UNAVAILABLE)
    }

    @Test
    fun asksThePageWhatPeriodTheOpenNoteIsOnce() {
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
        val controller = controller()
        page(controller, FromEditor.Ready)
        waitFor { sent.filterIsInstance<ToEditor.Open>().isNotEmpty() }
        page(controller, FromEditor.Opened("n", "T", null, null))
        waitFor { sent.filterIsInstance<ToEditor.PeriodicNav>().isNotEmpty() }
        assertEquals(listOf(ToEditor.PeriodicNav("n")), sent.filterIsInstance<ToEditor.PeriodicNav>())
        val nav = FromEditor.PeriodicNavData(
            ToEditor.PeriodKind.DAILY, "2026-10-21", "Wednesday 21 October 2026",
            FromEditor.NavTarget("2026-10-20", "2026-10-20", "Tuesday 20 October 2026", "2026-10-20"),
            FromEditor.NavTarget("2026-10-22", "2026-10-22", "Thursday 22 October 2026", "2026-10-22"),
            FromEditor.NavTarget("2026-10-19", "Week 2026-W43", "Week of Monday 19 October 2026", "2026-W43"),
            null,
        )
        page(controller, FromEditor.PeriodicNav("n", nav))
        assertEquals(nav, controller.periodicNav.value)
        // Another open does not ask again: a note's period never changes.
        page(controller, FromEditor.Opened("n", "T", null, null))
        assertEquals(1, sent.filterIsInstance<ToEditor.PeriodicNav>().size)
    }

    /** T40 P9 (PL9, A493): the page dispatches with the synced bindings and runs the app's commands here. */
    @Test
    fun givesThePageTheBindingsAndRunsOnlyTheCommandsItSent() {
        val controller = controller()
        val ran = CopyOnWriteArrayList<String>()
        controller.onCommand = { ran += it }
        // Before the page is ready nothing is sent; once it is, the keys go with it.
        controller.keys(mapOf("app.search" to listOf("Mod+J")), listOf("note.history", "app.search"))
        assertTrue(sent.filterIsInstance<ToEditor.Keys>().isEmpty())
        page(controller, FromEditor.Ready)
        assertEquals(
            listOf(ToEditor.Keys(mapOf("app.search" to listOf("Mod+J")), listOf("app.search", "note.history"))),
            sent.filterIsInstance<ToEditor.Keys>(),
        )
        // The same again sends nothing; a change goes at once.
        controller.keys(mapOf("app.search" to listOf("Mod+J")), listOf("app.search", "note.history"))
        controller.keys(emptyMap(), listOf("app.search"))
        assertEquals(2, sent.filterIsInstance<ToEditor.Keys>().size)
        page(controller, FromEditor.Command("n", "app.search"))
        // Not a command this screen sent, or another note's: nothing runs.
        page(controller, FromEditor.Command("n", "note.history"))
        page(controller, FromEditor.Command("other", "app.search"))
        page(controller, FromEditor.Command(null, "app.search"))
        assertEquals(listOf("app.search", "app.search"), ran.toList())
        // A reloaded page gets them again.
        page(controller, FromEditor.Ready)
        assertEquals(3, sent.filterIsInstance<ToEditor.Keys>().size)
    }
}
