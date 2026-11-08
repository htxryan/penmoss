package app.penmoss.editor

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.FoldStore
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.bridge.BlockAction
import app.penmoss.engine.bridge.BlockEntry
import app.penmoss.engine.bridge.BlockPurpose
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.ClipFormat
import app.penmoss.engine.bridge.CopyFormat
import app.penmoss.engine.bridge.CopyScope
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ParityFromEditor
import app.penmoss.engine.bridge.ParityToEditor
import app.penmoss.engine.bridge.TextCounts
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.stopScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
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

/**
 * The editor's parity tools from the app's side (T40 P8), with the page played by the test:
 * toggles kept in Room and sent before each open (ED8), the copies (ED9), paste as plain text
 * (ED11), the source (ED17), the + sheet and the Block menu (ED4, ED5), and the counts (NT24).
 */
@RunWith(AndroidJUnit4::class)
class NoteToolsTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var folds: FoldStore
    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private val sent = CopyOnWriteArrayList<ToEditor>()
    private val sync = NoteEditorControllerTest.FakeSync()

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), PenmossDatabase::class.java).build()
        store = NoteStore(db)
        folds = FoldStore(db.folds())
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
    }

    @After
    fun close() {
        // Its work ends before the dispatcher and the database close (A690).
        stopScope(scope)
        thread.close()
        db.close()
    }

    private fun controller(withFolds: Boolean = true) = NoteEditorController(
        "n",
        store,
        sync,
        scope,
        send = { sent += BridgeProtocol.decodeToEditor(it)!! },
        onOpenNote = {},
        pollMs = 60_000,
        folds = if (withFolds) folds else null,
    )

    private fun page(controller: NoteEditorController, message: FromEditor) = runBlocking(thread) {
        controller.onPageMessage(BridgeProtocol.encode(message))
    }

    private fun waitFor(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) { while (!condition()) kotlinx.coroutines.delay(10) }
    }

    /** A controller with the note open on the page. */
    private fun opened(withFolds: Boolean = true): NoteEditorController {
        val controller = controller(withFolds)
        page(controller, FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Open } }
        page(controller, FromEditor.Opened("n", "Note", null, null))
        return controller
    }

    @Test
    fun sendsTheNotesTogglesRightBeforeItOpensAndKeepsEachChange() {
        runBlocking { folds.save("n", mapOf("note|Details|0" to true)) }
        val controller = opened()
        val open = sent.indexOfFirst { it is ToEditor.Open }
        assertEquals(ParityToEditor.Folds("n", mapOf("note|Details|0" to true)), sent[open - 1])

        page(controller, ParityFromEditor.Folds("n", mapOf("note|Details|0" to false, "tip||0" to true)))
        waitFor { runBlocking { folds.folds("n") }.size == 2 }
        assertEquals(mapOf("note|Details|0" to false, "tip||0" to true), runBlocking { folds.folds("n") })
        // Another note's are not this one's.
        page(controller, ParityFromEditor.Folds("other", mapOf("x||0" to true)))
        assertEquals(emptyMap<String, Boolean>(), runBlocking { folds.folds("other") })
    }

    @Test
    fun sendsNoTogglesWhenNoneAreKept() {
        opened()
        assertTrue(sent.none { it is ParityToEditor.Folds })
    }

    @Test
    fun aReloadedPageGetsTheTogglesItReportedAgain() {
        // Without Room (tests), the toggles the page reported go back with the next open.
        val controller = opened(withFolds = false)
        page(controller, ParityFromEditor.Folds("n", mapOf("note|More|0" to true)))
        sent.clear()
        page(controller, FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Open } }
        assertEquals(ParityToEditor.Folds("n", mapOf("note|More|0" to true)), sent.first())
    }

    @Test
    fun forgetsAnUnreadableRowRatherThanFailingToOpen() {
        runBlocking { db.folds().put(app.penmoss.data.FoldsEntity("n", "not json")) }
        opened()
        assertTrue(sent.any { it is ToEditor.Open })
        assertTrue(sent.none { it is ParityToEditor.Folds })
    }

    @Test
    fun copiesAndPastesOnlyOnceTheNoteShows() {
        val controller = controller()
        val notices = CopyOnWriteArrayList<String>()
        val collecting = scope.async(start = CoroutineStart.UNDISPATCHED) { controller.notices.collect { notices += it } }
        controller.tools.copy(CopyFormat.MARKDOWN, CopyScope.NOTE)
        waitFor { notices.isNotEmpty() }
        assertTrue(sent.none { it is ParityToEditor.Copy })

        page(controller, FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Open } }
        // The open's coroutine runs on the one thread: once this has run, it has finished.
        runBlocking(thread) {}
        controller.tools.copy(CopyFormat.RICH, CopyScope.SELECTION)
        controller.tools.pastePlain("# plain")
        controller.tools.pastePlain("x".repeat(NoteTools.MAX_PLAIN_CHARS + 5))
        controller.tools.pastePlain(null)
        assertEquals(ParityToEditor.Copy("n", CopyFormat.RICH, CopyScope.SELECTION), sent.filterIsInstance<ParityToEditor.Copy>().single())
        val pasted = sent.filterIsInstance<ParityToEditor.InsertPlain>()
        assertEquals(listOf("# plain".length, NoteTools.MAX_PLAIN_CHARS), pasted.map { it.text.length })
        waitFor { notices.any { it.contains("no text on the clipboard") } }
        collecting.cancel()
    }

    @Test
    fun passesWhatThePageCopiesToTheScreen() {
        val controller = opened()
        // Subscribed at once, before the page's message: the screen collects for as long as it shows.
        val clip = scope.async(start = CoroutineStart.UNDISPATCHED) { controller.tools.clips.first() }
        page(controller, ParityFromEditor.Clipboard("n", ClipFormat.RICH, "Bold", "<strong>Bold</strong>"))
        assertEquals(ParityFromEditor.Clipboard("n", ClipFormat.RICH, "Bold", "<strong>Bold</strong>"), runBlocking { clip.await() })
    }

    @Test
    fun showsTheSourceAndShowsTheNoteAgainAfterTheReload() {
        val controller = opened()
        controller.tools.setSource(true)
        assertTrue(controller.tools.source.value)
        assertEquals(ParityToEditor.Source("n", true), sent.last())
        // A reloaded page shows the note: so does the menu.
        page(controller, FromEditor.Ready)
        assertFalse(controller.tools.source.value)
    }

    @Test
    fun asksForBlocksAndRunsTheBlockMenu() {
        val controller = opened()
        controller.tools.requestBlocks(BlockPurpose.INSERT, "t".repeat(150))
        controller.tools.insert("table")
        controller.tools.turnInto("heading2")
        controller.tools.block(BlockAction.DUPLICATE)
        assertEquals(
            listOf(
                ParityToEditor.Blocks("n", BlockPurpose.INSERT, "t".repeat(100)),
                ParityToEditor.Insert("n", "table"),
                ParityToEditor.TurnInto("n", "heading2"),
                ParityToEditor.Block("n", BlockAction.DUPLICATE),
            ),
            sent.filterIsInstance<ParityToEditor>().filter { it !is ParityToEditor.Folds },
        )
        val items = listOf(BlockEntry("table", "Table", "▦", "| a | b |"))
        page(controller, ParityFromEditor.Blocks("n", BlockPurpose.INSERT, "tab", items))
        assertEquals(BlockChoices(BlockPurpose.INSERT, "tab", items), controller.tools.choices.value)
    }

    /** A folds table whose first write is slow, as a busy disk's can be (review S1). */
    private class SlowFirstWrite : app.penmoss.data.FoldsDao {
        val rows = java.util.concurrent.ConcurrentHashMap<String, String>()
        private var writes = 0

        override suspend fun get(noteId: String): String? = rows[noteId]

        override suspend fun put(folds: app.penmoss.data.FoldsEntity) {
            if (writes++ == 0) kotlinx.coroutines.delay(300)
            rows[folds.noteId] = folds.folds
        }

        override suspend fun delete(noteId: String) {
            rows.remove(noteId)
        }
    }

    @Test
    fun theNewestTogglesAreKeptWhenSavesOverlap() {
        val dao = SlowFirstWrite()
        val pool = CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.IO)
        try {
            val tools = NoteTools("n", send = {}, scope = pool, folds = FoldStore(dao), showing = { true }, notify = {})
            tools.onMessage(ParityFromEditor.Folds("n", mapOf("note|A|0" to true)))
            Thread.sleep(50)
            tools.onMessage(ParityFromEditor.Folds("n", mapOf("note|A|0" to false)))
            waitFor { runBlocking { FoldStore(dao).folds("n") } == mapOf("note|A|0" to false) }
            Thread.sleep(400)
            // The slow first save never lands after the newer one.
            assertEquals(mapOf("note|A|0" to false), runBlocking { FoldStore(dao).folds("n") })
        } finally {
            pool.cancel()
        }
    }

    @Test
    fun aReadRightAfterAChangeSendsTheChangeNotRoomsOlderRow() {
        runBlocking { folds.save("n", mapOf("note|A|0" to true)) }
        val controller = opened()
        page(controller, ParityFromEditor.Folds("n", mapOf("note|A|0" to false)))
        sent.clear()
        page(controller, FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Open } }
        assertEquals(ParityToEditor.Folds("n", mapOf("note|A|0" to false)), sent.first())
    }

    @Test
    fun saysWhenAPasteWasCutShortAndNeverSplitsACharacter() {
        val controller = opened()
        val notices = CopyOnWriteArrayList<String>()
        val collecting = scope.async(start = CoroutineStart.UNDISPATCHED) { controller.notices.collect { notices += it } }
        // An emoji (two UTF-16 units) straddling the cap.
        val text = "x".repeat(NoteTools.MAX_PLAIN_CHARS - 1) + "😀" + "tail"
        controller.tools.pastePlain(text)
        val pasted = sent.filterIsInstance<ParityToEditor.InsertPlain>().single().text
        assertEquals(NoteTools.MAX_PLAIN_CHARS - 1, pasted.length)
        assertFalse(Character.isHighSurrogate(pasted.last()))
        waitFor { NoteTools.TRUNCATED in notices }
        collecting.cancel()
    }

    @Test
    fun followsWhatThePageSaysShowsAndOffersUndoForADeletedBlock() {
        val controller = opened()
        controller.tools.setSource(true)
        // The page could not show it: the menu and bar follow the page (review S6).
        page(controller, ParityFromEditor.Source("n", false))
        assertFalse(controller.tools.source.value)
        val deleted = scope.async(start = CoroutineStart.UNDISPATCHED) { controller.tools.deleted.first() }
        page(controller, ParityFromEditor.BlockDeleted("n", "List"))
        assertEquals("List", runBlocking { deleted.await() })
    }

    @Test
    fun keepsTheSelectionOnlyWhileTheNoteShows() {
        val controller = controller()
        controller.tools.capture()
        assertTrue(sent.none { it is ParityToEditor.CaptureSelection })
        page(controller, FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Open } }
        runBlocking(thread) {}
        controller.tools.capture()
        assertEquals(ParityToEditor.CaptureSelection("n"), sent.last())
    }

    @Test
    fun theSnackbarsUndoAsksThePageToUndoTheDeleteNotTheNewestEdit() {
        val controller = opened()
        page(controller, ParityFromEditor.BlockDeleted("n", "List"))
        controller.tools.undoDelete()
        assertEquals(ParityToEditor.UndoDelete("n"), sent.last())
        assertTrue(sent.none { it is ToEditor.Format })
    }

    @Test
    fun keepsTheCountsInTheWebsWords() {
        val controller = opened()
        assertNull(controller.tools.counts.value)
        page(controller, ParityFromEditor.Counts("n", 1204, 6780, 5, TextCounts(1, 9)))
        val counts = controller.tools.counts.value!!
        assertEquals("1,204 words · 6,780 characters · 5 min read", counts.label)
        assertEquals("1 word and 9 characters selected", counts.selectionLabel)
        page(controller, ParityFromEditor.Counts("n", 0, 0, 0, null))
        assertEquals("0 words · 0 characters", controller.tools.counts.value!!.label)
        assertNull(controller.tools.counts.value!!.selectionLabel)
    }

    @Test
    fun theBarStateCarriesTheTableCodeAndBlockFields() {
        val controller = opened()
        page(
            controller,
            FromEditor.State("n", emptyList(), false, false, true, true, null, false, inTable = true, inCode = false, canMoveUp = false, canMoveDown = true, canTurnInto = false),
        )
        val state = controller.format.value
        assertTrue(state.inTable)
        assertFalse(state.inCode)
        assertFalse(state.canMoveUp)
        assertTrue(state.canMoveDown)
        assertFalse(state.canTurnInto)
    }
}
