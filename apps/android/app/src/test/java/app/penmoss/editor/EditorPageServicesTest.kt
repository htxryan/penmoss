package app.penmoss.editor

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.CopyFailure
import app.penmoss.engine.bridge.DirectoryEntry
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** What the editor page gets beyond the open note (T33): the theme, the phone's notes, conflict copies. */
@RunWith(AndroidJUnit4::class)
class EditorPageServicesTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private val sent = CopyOnWriteArrayList<ToEditor>()
    private val copied = CopyOnWriteArrayList<PageNote>()
    private val merges = CopyOnWriteArrayList<Boolean>()

    /** The note whose edits each copy keeps (T40 P3a, NT21: its own screen says so). */
    private val sources = CopyOnWriteArrayList<String>()
    private val editors = OpenEditors()
    private lateinit var services: EditorPageServices

    private val nord = ToEditor.Theme(buildJsonObject { put("id", JsonPrimitive("nord")) }, "dark")

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db)
        services = EditorPageServices(
            store,
            scope,
            send = { sent += BridgeProtocol.decodeToEditor(it)!! },
            onCopied = { source, copy, merged ->
                sources += source
                copied += copy
                merges += merged
            },
            openEditors = editors,
            directoryEveryMs = 10,
            copyTimeoutMs = 2_000,
        )
    }

    @After
    fun close() {
        // Waits for the cancelled work to end: a Room query still running would otherwise fail on the
        // closed database after this test, and be reported against whichever test runs next.
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }
        thread.close()
        db.close()
    }

    private fun page(message: FromEditor) = runBlocking(thread) { services.onPageMessage(BridgeProtocol.encode(message)) }

    private fun waitFor(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) { while (!condition()) kotlinx.coroutines.delay(10) }
    }

    @Test
    fun theThemeWaitsForThePageAndFollowsChanges() {
        runBlocking(thread) { services.setTheme(nord) }
        assertEquals(emptyList<ToEditor>(), sent.toList())
        page(FromEditor.Ready)
        waitFor { sent.isNotEmpty() }
        assertEquals(nord, sent.first())
        val light = nord.copy(variant = "light")
        runBlocking(thread) {
            services.setTheme(light)
            // The same again: not sent twice.
            services.setTheme(light)
        }
        assertEquals(1, sent.count { it == light })
    }

    @Test
    fun theNoteWidthWaitsForThePageAndFollowsTheSetting() {
        runBlocking(thread) { services.setWidth(ToEditor.Width(full = true)) }
        assertEquals(emptyList<ToEditor>(), sent.toList())
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Width } }
        assertEquals(ToEditor.Width(full = true), sent.first { it is ToEditor.Width })
        runBlocking(thread) {
            services.setWidth(ToEditor.Width(full = false))
            services.setWidth(ToEditor.Width(full = false))
        }
        assertEquals(1, sent.count { it == ToEditor.Width(full = false) })
    }

    @Test
    fun theFontsWaitForThePageComeAfterTheThemeAndFollowTheSettings() {
        // T51 (A944): the note's font and size, laid over the theme, so sent after it.
        val serif = ToEditor.Fonts("system", "serif", 20)
        runBlocking(thread) {
            services.setFonts(serif)
            services.setTheme(nord)
        }
        assertEquals(emptyList<ToEditor>(), sent.toList())
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Fonts } }
        assertEquals(serif, sent.first { it is ToEditor.Fonts })
        assertTrue(sent.indexOf(nord) < sent.indexOf(serif))
        val bigger = ToEditor.Fonts("system", "serif", 24)
        runBlocking(thread) {
            services.setFonts(bigger)
            services.setFonts(bigger)
        }
        assertEquals(1, sent.count { it == bigger })
    }

    @Test
    fun theLineSymbolsWaitForThePageAndFollowTheSetting() {
        // T44 (A747): the person's list, sent once the page is ready and again on each change.
        val mine = ToEditor.Symbols(listOf(app.penmoss.engine.settings.LineSymbol("✓", "Done", "success")))
        runBlocking(thread) { services.setSymbols(mine) }
        assertEquals(emptyList<ToEditor>(), sent.toList())
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Symbols } }
        assertEquals(mine, sent.first { it is ToEditor.Symbols })
        runBlocking(thread) {
            services.setSymbols(ToEditor.Symbols(emptyList()))
            services.setSymbols(ToEditor.Symbols(emptyList()))
        }
        assertEquals(1, sent.count { it == ToEditor.Symbols(emptyList()) })
    }

    @Test
    fun theKeyboardsStateWaitsForThePageAndFollowsIt() {
        runBlocking(thread) { services.setIme(ToEditor.Ime(visible = false)) }
        assertEquals(emptyList<ToEditor>(), sent.toList())
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Ime } }
        assertEquals(ToEditor.Ime(visible = false), sent.first { it is ToEditor.Ime })
        runBlocking(thread) {
            services.setIme(ToEditor.Ime(visible = true))
            services.setIme(ToEditor.Ime(visible = true))
        }
        assertEquals(1, sent.count { it == ToEditor.Ime(visible = true) })
    }

    @Test
    fun thePageGetsThePhonesNotesAndTheirChanges() {
        runBlocking { store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("a", 1, "Alpha", "", 1)))) }
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Directory } }
        assertEquals(ToEditor.Directory(listOf(DirectoryEntry("a", "Alpha"))), sent.first { it is ToEditor.Directory })
        runBlocking { store.saveChanges(ChangesPage(2, notes = listOf(ChangedNote("b", 2, "Beta", "", 2)))) }
        waitFor { sent.count { it is ToEditor.Directory } == 2 }
        assertEquals(listOf("b", "a"), (sent.last { it is ToEditor.Directory } as ToEditor.Directory).notes.map { it.id })
        // Gone with the page.
        runBlocking(thread) { services.stop() }
        runBlocking { store.saveChanges(ChangesPage(3, notes = listOf(ChangedNote("c", 3, "Gamma", "", 3)))) }
        Thread.sleep(100)
        assertEquals(2, sent.count { it is ToEditor.Directory })
    }

    private fun restoredWithAnEdit(noteId: String) = runBlocking {
        val first = store.content(noteId)
        store.saveExchange(Exchange.decide(first, Exchange.entry(first), BatchNoteReply(noteId, "e1", "OLD", "SV1", null)))
        store.addPending(noteId, "EDIT", "e1")
        val sent = store.content(noteId)
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply(noteId, "e2", "RESTORED", "SV9", "Epoch mismatch")))
    }

    @Test
    fun editsKeptApartBecomeACopyThePageBuilds() {
        restoredWithAnEdit("n")
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.CopyConflicts } }
        val ask = sent.first { it is ToEditor.CopyConflicts } as ToEditor.CopyConflicts
        assertEquals("n", ask.noteId)
        assertEquals(listOf("OLD"), ask.base.map { it.update })
        assertEquals(listOf("EDIT"), ask.edits.map { it.update })
        // The copy's notebook record, for a note that has none of its own (T43, A766, fix c).
        assertEquals(app.penmoss.data.Notebooks.DEFAULT, ask.notebook)
        val copy = PageNote("copy", "Note (conflict copy)", "COPY")
        page(FromEditor.ConflictCopy("n", copy, ask.edits.map { it.id }))
        waitFor { copied.isNotEmpty() }
        assertEquals(listOf(copy), copied.toList())
        assertEquals(listOf("n"), sources.toList())
        assertEquals(listOf(false), merges.toList())
        runBlocking {
            assertEquals(listOf("COPY"), db.updates().updates("copy", UpdateEntity.PENDING).map { it.update })
            assertEquals(0, db.updates().updates("n", UpdateEntity.CONFLICT).size)
            assertEquals(listOf("EDIT"), db.updates().updates("n", UpdateEntity.COPIED).map { it.update })
        }
        // Done: asked once.
        Thread.sleep(100)
        assertEquals(1, sent.count { it is ToEditor.CopyConflicts })
    }

    @Test
    fun aCopyThePageRefusesKeepsTheEditsAndAnnouncesNothing() {
        restoredWithAnEdit("n")
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.CopyConflicts } }
        val ask = sent.first { it is ToEditor.CopyConflicts } as ToEditor.CopyConflicts
        page(FromEditor.CopyFailed("n", CopyFailure.INCOMPLETE, ask.edits.map { it.id }))
        waitFor { runBlocking { db.updates().updates("n", UpdateEntity.KEPT).isNotEmpty() } }
        assertEquals(emptyList<PageNote>(), copied.toList())
        runBlocking {
            assertEquals(listOf("EDIT"), db.updates().updates("n", UpdateEntity.KEPT).map { it.update })
            assertNull(store.conflictSet("n"))
        }
        // Not asked again.
        Thread.sleep(100)
        assertEquals(1, sent.count { it is ToEditor.CopyConflicts })
    }

    @Test
    fun aCopyThatWouldHoldNothingIsNeitherStoredNorAnnounced() {
        restoredWithAnEdit("n")
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.CopyConflicts } }
        val ask = sent.first { it is ToEditor.CopyConflicts } as ToEditor.CopyConflicts
        page(FromEditor.CopyFailed("n", CopyFailure.EMPTY, ask.edits.map { it.id }))
        waitFor { runBlocking { db.updates().updates("n", UpdateEntity.COPIED).isNotEmpty() } }
        assertEquals(emptyList<PageNote>(), copied.toList())
        runBlocking { assertEquals(0, store.unsentCount()) }
    }

    @Test
    fun editsOfACopyAnEditorStillHoldsWaitForItToLetGo() {
        // The open note's page is reopening on the restored copy and may flush its last edits of e1.
        val owner = Any()
        editors.set(owner, "n", setOf("e1", "e2"))
        restoredWithAnEdit("n")
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Directory } }
        Thread.sleep(150)
        assertEquals(0, sent.count { it is ToEditor.CopyConflicts })
        // Those last edits arrive, then the page says `opened`: one copy holds them all.
        runBlocking { store.addPending("n", "FLUSHED", "e1") }
        editors.set(owner, "n", setOf("e2"))
        waitFor { sent.any { it is ToEditor.CopyConflicts } }
        val ask = sent.first { it is ToEditor.CopyConflicts } as ToEditor.CopyConflicts
        assertEquals(listOf("EDIT", "FLUSHED"), ask.edits.map { it.update })
        assertEquals(listOf("OLD"), ask.base.map { it.update })
    }

    @Test
    fun twoGroupsTheServerRefusedInARowMakeCompleteCopies() {
        runBlocking {
            val first = store.content("n")
            store.saveExchange(Exchange.decide(first, Exchange.entry(first), BatchNoteReply("n", "e1", "SERVER", "SV1", null)))
            db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.CONFLICT, update = "REFUSED1", epoch = "e1"))
        }
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.CopyConflicts } }
        val ask = sent.first { it is ToEditor.CopyConflicts } as ToEditor.CopyConflicts
        assertEquals(listOf("SERVER"), ask.base.map { it.update })
        page(FromEditor.ConflictCopy("n", PageNote("c1", "T", "C1"), ask.edits.map { it.id }))
        waitFor { copied.size == 1 }
        // The next refusal builds on the first: sent with it, and merged into its copy. (Updates
        // here are base64 strings, as the bridge requires.)
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.CONFLICT, update = "REFUSED2", epoch = "e1")) }
        waitFor { sent.count { it is ToEditor.CopyConflicts } == 2 }
        val again = sent.last { it is ToEditor.CopyConflicts } as ToEditor.CopyConflicts
        assertEquals(listOf("SERVER", "REFUSED1"), again.base.map { it.update })
        assertEquals(listOf("REFUSED2"), again.edits.map { it.update })
        assertEquals("c1", again.into?.noteId)
        assertEquals(listOf("C1"), again.into?.updates?.map { it.update })
        page(FromEditor.ConflictCopy("n", PageNote("c1", "T", "C1MORE"), again.edits.map { it.id }, merged = true))
        waitFor { copied.size == 2 }
        assertEquals(listOf(false, true), merges.toList())
        runBlocking { assertEquals(listOf("C1", "C1MORE"), db.updates().updates("c1", UpdateEntity.PENDING).map { it.update }) }
    }

    @Test
    fun aCopyForAnotherNoteOrRowsNoLongerKeptApartIsNotStored() {
        restoredWithAnEdit("n")
        page(FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.CopyConflicts } }
        val ask = sent.first { it is ToEditor.CopyConflicts } as ToEditor.CopyConflicts
        page(FromEditor.ConflictCopy("other", PageNote("x", "X", "X"), ask.edits.map { it.id }))
        page(FromEditor.ConflictCopy("n", PageNote("copy", "C", "C"), ask.base.map { it.id }))
        Thread.sleep(100)
        assertEquals(emptyList<PageNote>(), copied.toList())
        runBlocking { assertNull(store.note("copy")) }
        assertTrue(runBlocking { store.note("x") } == null)
    }
}
