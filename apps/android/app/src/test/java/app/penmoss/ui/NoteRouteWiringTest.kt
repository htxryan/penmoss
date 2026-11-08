package app.penmoss.ui

import androidx.compose.ui.test.assertIsSelected
import android.content.res.Configuration
import android.os.Looper
import android.view.View
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasAnyChild
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.assertTextEquals
import androidx.room.Room
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.webkit.JavaScriptExecutionException
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewOutcomeReceiver
import app.penmoss.AppGraph
import app.penmoss.PenmossApp
import app.penmoss.TestGraphs
import app.penmoss.git.GitNotebookActivity
import app.penmoss.data.FolderEntity
import app.penmoss.data.NoteEntity
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.editor.NotePages
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.ContentState
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.stopMainScope
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The note screen's own wiring for links (T40 P7 review S7, LK4, LK5), through the app with a
 * stand-in page: what the page asks about another note is answered on its channel, and the Info
 * button counts the notes Room says link here.
 */
@RunWith(AndroidJUnit4::class)
class NoteRouteWiringTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: PenmossApp = ApplicationProvider.getApplicationContext()
    /** The app's graph, and the git notebook's that holds Garden. */
    private lateinit var main: AppGraph
    private lateinit var graph: AppGraph
    private var scenario: ActivityScenario<GitNotebookActivity>? = null

    private val garden = "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"
    private val seeds = "01JD2Z7Q8R4T6Y8W0E2R4T6YB2"

    /** The stand-in page's hooks, once the note screen has built it. */
    private var hooks: NotePages.Hooks? = null

    /** What the app sent the page. */
    private val sent = CopyOnWriteArrayList<ToEditor>()

    /** The page's end of the channel, as the WebView's reply proxy would be. */
    private val proxy = object : JavaScriptReplyProxy() {
        override fun postMessage(message: String) {
            BridgeProtocol.decodeToEditor(message)?.let(sent::add)
        }

        override fun postMessage(arrayBuffer: ByteArray) = Unit

        override fun executeJavaScript(script: String, callback: WebViewOutcomeReceiver<String, JavaScriptExecutionException>?) = Unit
    }

    /** Room's threads, so teardown can wait for what they still run (T40 P6: the CI flake). */
    private val roomQueries = Executors.newSingleThreadExecutor()
    private val roomTransactions = Executors.newSingleThreadExecutor()

    @After
    fun close() {
        scenario?.close()
        // Nothing new starts after the barriers below (review nit, A610).
        if (::main.isInitialized) stopMainScope(main.scope)
        // Whatever Room still has queued (a flow's re-query after the last write, the index's
        // triggers) runs before the database closes, never against a closed pool.
        repeat(3) {
            shadowOf(Looper.getMainLooper()).idle()
            listOf(roomQueries, roomTransactions).forEach { it.submit {}.get(5, TimeUnit.SECONDS) }
        }
        if (::graph.isInitialized) graph.database.close()
        if (::main.isInitialized) main.database.close()
        roomQueries.shutdown()
        roomTransactions.shutdown()
        TestGraphs.forgetNotebooks(app)
    }

    /** Garden open in a git notebook, offline. */
    private fun openGarden() {
        TestGraphs.forgetNotebooks(app)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, androidx.work.Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        val pages = NotePages { context, _, channel, built ->
            channel.attach(proxy)
            hooks = built
            View(context)
        }
        main = TestGraphs.app(app, pages) {
            Room.inMemoryDatabaseBuilder(app, PenmossDatabase::class.java)
                .setQueryExecutor(roomQueries).setTransactionExecutor(roomTransactions).build()
        }
        app.useGraph(main)
        val notebook = TestGraphs.addNotebook(app, main, "Notes")
        graph = main.git.graph(notebook)
        scenario = ActivityScenario.launch(TestGraphs.opening(app, notebook, note = garden))
        await { hooks != null }
    }

    private fun await(condition: () -> Boolean) = compose.waitUntil(5_000) {
        shadowOf(Looper.getMainLooper()).idle()
        condition()
    }

    private fun infoDescription() = compose.onNodeWithTag("noteInfo").fetchSemanticsNode()
        .config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString()

    @Test
    fun thePagesAskForAnotherNoteIsAnsweredOnItsChannel() {
        openGarden()
        runBlocking {
            graph.database.notes().insertIgnore(NoteEntity(seeds, clock = 1, contentClock = 1))
            graph.database.updates().insert(UpdateEntity(noteId = seeds, state = UpdateEntity.SYNCED, update = "S1"))
        }
        scenario!!.onActivity { hooks!!.onMessage(BridgeProtocol.encode(FromEditor.NoteContent(seeds))) }
        await { sent.any { it is ToEditor.NoteContent } }
        val answer = sent.filterIsInstance<ToEditor.NoteContent>().single()
        assertEquals(seeds, answer.noteId)
        assertEquals(ContentState.OK, answer.state)
        assertEquals(listOf("S1"), answer.updates.map { it.update })
    }

    @Test
    fun theInfoButtonCountsTheNotesRoomSaysLinkHere() {
        openGarden()
        await { infoDescription() == "Info" }
        // The index says Seeds links to Garden (LK5): the badge says so, offline.
        runBlocking {
            graph.store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote(seeds, 1, "Seeds", "", 10, seq = 1, links = listOf(garden)))))
        }
        runCatching { await { infoDescription() == "Info, linked from 1 note" } }
        assertEquals("Info, linked from 1 note", infoDescription())
    }

    @Test
    fun theInfoSheetSaysTheNotesLengthAsThePageCountedIt() {
        openGarden()
        // The page's counts once typing pauses (T40 P8, NT24): the sheet's Length row (NT23).
        scenario!!.onActivity {
            hooks!!.onMessage(
                """{"v":1,"type":"counts","noteId":"$garden","words":1204,"characters":6780,"minutes":5,"selection":null}""",
            )
        }
        compose.onNodeWithTag("noteInfo").performClick()
        await { compose.onAllNodes(hasTestTag("infoRow-Length")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("infoRow-Length").assert(hasAnyChild(hasText("1,204 words · 6,780 characters · 5 min read")))
        // The save status beside it, in the sync icon's words (NT24).
        val icon = compose.onNode(hasContentDescription("Sync: ", substring = true)).fetchSemanticsNode()
            .config.getOrNull(SemanticsProperties.ContentDescription)!!.single().removePrefix("Sync: ")
        compose.onNodeWithTag("infoRow-Saved").assert(hasAnyChild(hasText(icon)))
    }

    /** Review R3: the page hears the person is typing while the soft keyboard is down but a hardware one is in use. */
    @Test
    fun aHardwareKeyboardCountsAsTyping() {
        RuntimeEnvironment.setQualifiers("+keysexposed-qwerty")
        // Robolectric's qualifiers set `keyboardHidden`, not the hardware flag a phone sets
        // when a keyboard is attached.
        app.resources.configuration.hardKeyboardHidden = Configuration.HARDKEYBOARDHIDDEN_NO
        openGarden()
        scenario!!.onActivity { hooks!!.onMessage(BridgeProtocol.encode(FromEditor.Ready)) }
        await { sent.any { it is ToEditor.Ime } }
        assertEquals(ToEditor.Ime(visible = true), sent.last { it is ToEditor.Ime })
    }

    /** With neither keyboard up, a tag tapped opens (A469). */
    @Test
    fun withNoKeyboardThePageHearsNoTyping() {
        RuntimeEnvironment.setQualifiers("+keyshidden-nokeys")
        app.resources.configuration.hardKeyboardHidden = Configuration.HARDKEYBOARDHIDDEN_YES
        openGarden()
        scenario!!.onActivity { hooks!!.onMessage(BridgeProtocol.encode(FromEditor.Ready)) }
        await { sent.any { it is ToEditor.Ime } }
        assertEquals(ToEditor.Ime(visible = false), sent.last { it is ToEditor.Ime })
    }

    /**
     * The image lightbox (T51, A948): while the page shows it, the note's bars step aside and the
     * back gesture closes it, leaving the note open; the fonts reach the page too (A944).
     */
    @Test
    fun theLightboxTakesTheScreenAndBackClosesIt() {
        openGarden()
        scenario!!.onActivity { hooks!!.onMessage(BridgeProtocol.encode(FromEditor.Ready)) }
        await { sent.any { it is ToEditor.Fonts } }
        compose.onNodeWithTag("noteInfo").assertExists()
        scenario!!.onActivity { hooks!!.onMessage(BridgeProtocol.encode(FromEditor.Lightbox(open = true))) }
        await { runCatching { compose.onNodeWithTag("noteInfo").assertDoesNotExist() }.isSuccess }
        scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        await { sent.any { it == ToEditor.CloseLightbox } }
        // Still the note: back closed only the lightbox.
        scenario!!.onActivity { hooks!!.onMessage(BridgeProtocol.encode(FromEditor.Lightbox(open = false))) }
        await { runCatching { compose.onNodeWithTag("noteInfo").assertExists() }.isSuccess }
    }

    /**
     * The Metadata tab as the web's panel (A502, T43): the note's inline `#tags` under Tags, "In
     * the text", not "No tags yet."; and a Notebook row naming the notebook it is in.
     */
    @Test
    fun theMetadataTabListsInlineTagsAndNoNotebookRowInAGitNotebook() {
        openGarden()
        runBlocking {
            graph.database.folders().put(FolderEntity("01JD2Z7Q8R4T6Y8W0E2R4T6YN1", "Work", null, "a", "manual", notebook = true))
            // The server's index: its tags, frontmatter and inline; the page's: no frontmatter tags.
            graph.store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote(garden, 1, "Garden", "", 10, seq = 1, tags = listOf("t51test")))))
        }
        scenario!!.onActivity { hooks!!.onMessage(BridgeProtocol.encode(FromEditor.Tags(garden, emptyList()))) }
        compose.onNodeWithTag("noteInfo").performClick()
        await { compose.onAllNodes(hasTestTag("infoInlineTags")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("infoInlineTags").assert(hasText("In the text: #t51test"))
        compose.onNodeWithTag("infoTags").assert(hasAnyChild(hasText("No tags yet.")).not())
        // A git notebook is the notebook: no Notebook row, even beside a folder marked as one (A912).
        compose.onNodeWithTag("infoRow-Notebook").assertDoesNotExist()
        runBlocking { graph.database.notes().place(garden, "01JD2Z7Q8R4T6Y8W0E2R4T6YN1", "a") }
        compose.onNodeWithTag("infoRow-Notebook").assertDoesNotExist()
    }

    /**
     * The note panel as vertical tabs (T53 item 9, A985): Comments left the bar for the ⋮ menu;
     * Info and the menu open the panel on their tab, its name at the top and the tabs down its
     * right edge, the open one closing it; no tab row along its top.
     */
    @Test
    fun infoAndTheMenuOpenTheNotePanelOnTheirTabsAndItsStripChangesThem() {
        openGarden()
        compose.onNodeWithTag("noteCommentsButton").assertDoesNotExist()
        compose.onNodeWithTag("noteMore").performClick()
        compose.onNodeWithTag("noteComments").performClick()
        await { runCatching { compose.onNodeWithTag("notePanel").assertExists() }.isSuccess }
        compose.onNodeWithTag("panelComments").assertIsSelected()
        compose.onNodeWithTag("panelTitle").assertTextEquals("COMMENTS")
        compose.onNodeWithTag("commentsSheet").assertExists()
        compose.onNode(hasTestTag("panelGraph") and hasAnyAncestor(hasTestTag("panelStrip"))).performClick()
        await { runCatching { compose.onNodeWithTag("panelLocalGraph").assertExists() }.isSuccess }
        compose.onNodeWithTag("panelTitle").assertTextEquals("LOCAL GRAPH")
        // The open tab's icon closes the panel, as the web's strip does.
        compose.onNodeWithTag("panelGraph").performClick()
        compose.onNodeWithTag("notePanel").assertDoesNotExist()
        compose.onNodeWithTag("noteInfo").performClick()
        compose.onNodeWithTag("panelMetadata").assertIsSelected()
        compose.onNodeWithTag("infoSheet").assertExists()
        compose.onNodeWithTag("panelClose").performClick()
        compose.onNodeWithTag("notePanel").assertDoesNotExist()
        compose.onNodeWithTag("noteInfo").performClick()
        await { runCatching { compose.onNodeWithTag("notePanel").assertExists() }.isSuccess }
        // Back closes the panel, not the note.
        scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        await { runCatching { compose.onNodeWithTag("notePanel").assertDoesNotExist() }.isSuccess }
        compose.onNodeWithTag("noteInfo").assertExists()
    }
}
