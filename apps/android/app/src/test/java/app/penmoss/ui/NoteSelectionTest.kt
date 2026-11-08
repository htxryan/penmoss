package app.penmoss.ui

import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TreeNote
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.ui.screens.AllNotesScreen
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Several notes at once (T42, A570; T40 NT26, A652): a long press on a note in a list starts
 * selection mode, taps add and take out notes, and the contextual bar moves them all with one
 * folder picker or moves them to Trash with one Undo.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NoteSelectionTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db)
    }

    @After
    fun close() = db.close()

    private fun note(id: String, title: String) = NoteItem(id, title, "", "Oct 26")

    @Test
    fun aLongPressStartsSelectionAndTapsAddOrTakeOutNotes() {
        val selection = NoteSelection()
        val opened = mutableListOf<String>()
        val did = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                CompositionLocalProvider(LocalNoteSelection provides selection) {
                    androidx.compose.foundation.layout.Column {
                        if (selection.active) {
                            SelectionBar(
                                selection.picked,
                                onClose = selection::clear,
                                onMove = { did += "move ${selection.picked.map { it.id }}" },
                                onTrash = { did += "trash ${selection.picked.map { it.id }}" },
                                onRename = { did += "rename" },
                            )
                        }
                        NoteList(
                            notes = listOf(note("a", "Soup"), note("b", "Tea"), note("c", "Bread")),
                            onOpen = { opened += it },
                            onLongPress = { selection.start(it) },
                            selectable = true,
                        )
                    }
                }
            }
        }
        compose.onNodeWithText("Soup").performClick()
        assertEquals(listOf("a"), opened)
        // TalkBack names the long press for what it does here.
        compose.onNodeWithText("Soup").assert(
            SemanticsMatcher("long press named Select") { it.config.getOrElseNullable(SemanticsActions.OnLongClick) { null }?.label == "Select" },
        )
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        compose.onNodeWithTag("selectionCount").assertTextEquals("1 selected")
        // One note: Rename too, in the bar's ⋮.
        compose.onNodeWithTag("selectionMore").performClick()
        compose.onNodeWithTag("selectionRename").performClick()
        assertEquals(listOf("rename"), did)
        // Taps now choose, never open.
        compose.onNodeWithText("Bread").performClick()
        compose.onNodeWithText("Tea").performClick()
        assertEquals(listOf("a"), opened)
        compose.onNodeWithTag("selectionCount").assertTextEquals("3 selected")
        compose.onNodeWithTag("selectionMore").assertDoesNotExist()
        compose.onNodeWithText("Tea").performClick()
        compose.onNodeWithTag("selectionCount").assertTextEquals("2 selected")
        // Each row is a checkbox for TalkBack, with its state.
        compose.onNodeWithTag("noteChosen:c", useUnmergedTree = true).assertIsDisplayed()
        val row = compose.onNode(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox).and(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.Off)))
        row.assertIsDisplayed()
        compose.onNodeWithContentDescription("Move 2 notes to a folder").performClick()
        compose.onNodeWithContentDescription("Move 2 notes to Trash").performClick()
        // In the order they were chosen, as the web moves them.
        assertEquals(listOf("rename", "move [a, c]", "trash [a, c]"), did)
        compose.onNodeWithContentDescription("Cancel Selection").performClick()
        compose.onNodeWithTag("selectionBar").assertDoesNotExist()
        compose.onNodeWithText("Tea").performClick()
        assertEquals(listOf("a", "b"), opened)
    }

    @Test
    fun oneChosenNoteOffersCopyAgentReferenceInTheBarsMenu() {
        // T52 item 4: Home's long press selects; the bar's ⋮ for one note copies its reference.
        val did = mutableListOf<String>()
        var picked by mutableStateOf(listOf(Picked("a", "Soup")))
        compose.setContent {
            PenmossTheme {
                SelectionBar(picked, onClose = {}, onMove = {}, onTrash = {}, onRename = {}, onCopyAgentReference = { did += "reference ${picked.single().id}" })
            }
        }
        compose.onNodeWithTag("selectionMore").performClick()
        compose.onNodeWithTag("selectionCopyAgentReference").assertTextEquals("Copy Agent Reference").performClick()
        assertEquals(listOf("reference a"), did)
        // Two notes: no ⋮, so no reference for several at once.
        picked = listOf(Picked("a", "Soup"), Picked("b", "Tea"))
        compose.waitForIdle()
        compose.onNodeWithTag("selectionMore").assertDoesNotExist()
    }

    @Test
    fun aListWithoutASelectionKeepsItsLongPressAsBefore() {
        val pressed = mutableListOf<String>()
        compose.setContent {
            PenmossTheme { NoteList(notes = listOf(note("a", "Soup")), onOpen = {}, onLongPress = { pressed += it.id }) }
        }
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        assertEquals(listOf("a"), pressed)
    }

    private suspend fun filed() {
        store.saveTree(
            SyncTree(
                hash = "h1",
                folders = listOf(TreeFolder("garden", "Garden"), TreeFolder("kitchen", "Kitchen")),
                notes = listOf(TreeNote("a", "kitchen", "a0"), TreeNote("b", null, "a1"), TreeNote("c", "kitchen", "a2")),
            ),
        )
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("a", 1, "Soup", "", 5), ChangedNote("b", 1, "Tea", "", 4), ChangedNote("c", 1, "Bread", "", 3))))
    }

    @Test
    fun moveSendsEveryNoteToTheOneFolderPickedInTheOrderChosen() = runBlocking {
        filed()
        var syncs = 0
        assertEquals("Moved 3 notes to Garden", moveNotesAndSay(store, listOf("c", "a", "b"), "garden", "Garden") { syncs++ })
        assertEquals(1, syncs)
        val garden = store.observeList().first().filter { it.folderId == "garden" }.sortedBy { it.position }.map { it.id }
        assertEquals(listOf("c", "a", "b"), garden)
        assertEquals("Already in Garden", moveNotesAndSay(store, listOf("a", "b"), "garden", "Garden") {})
        // One the phone no longer lists stops none of the others.
        assertEquals(
            "Moved 2 of 3 notes to Kitchen; 1 could not move: it isn't on this phone any more",
            moveNotesAndSay(store, listOf("a", "gone", "b"), "kitchen", "Kitchen") {},
        )
        assertEquals("None of the 2 notes could move to Kitchen", moveNotesAndSay(store, listOf("x", "y"), "kitchen", "Kitchen") {})
        // Notes already there count as neither moved nor refused, as the web's moveSummary (review N1).
        assertEquals(
            "Moved 1 of 3 notes to Kitchen; 1 could not move: it isn't on this phone any more",
            moveNotesAndSay(store, listOf("c", "gone", "a"), "kitchen", "Kitchen") {},
        )
        assertEquals(
            "1 already in Kitchen; 1 could not move: it isn't on this phone any more",
            moveNotesAndSay(store, listOf("a", "gone"), "kitchen", "Kitchen") {},
        )
        assertEquals("Moved 1 note to Garden", moveNotesAndSay(store, listOf("b"), "garden", "Garden") {})
        assertEquals("Moved 1 note to Kitchen", moveNotesAndSay(store, listOf("c", "b"), "kitchen", "Kitchen") {})
    }

    /** Review S2: a chosen note a sync pass takes out of the list is no longer chosen. */
    @Test
    fun aChosenNoteThatLeavesTheListLeavesTheSelection() {
        val selection = NoteSelection()
        var notes by mutableStateOf(listOf(note("a", "Soup"), note("b", "Tea"), note("c", "Bread")))
        compose.setContent {
            PenmossTheme {
                CompositionLocalProvider(LocalNoteSelection provides selection) {
                    AllNotesScreen(notes, onBack = {}, onOpen = {}, onNoteLongPress = { selection.start(it) })
                }
            }
        }
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        compose.onNodeWithText("Tea").performClick()
        compose.onNodeWithText("Bread").performClick()
        assertEquals(listOf("a", "b", "c"), selection.picked.map { it.id })
        // An agent moves Tea to another folder: Move or Trash would act on a note out of sight.
        notes = listOf(note("a", "Soup"), note("c", "Bread"))
        compose.waitForIdle()
        assertEquals(listOf("a", "c"), selection.picked.map { it.id })
        // The last chosen note gone: selection mode ends, also when the list is left empty.
        notes = emptyList()
        compose.waitForIdle()
        assertFalse(selection.active)
    }

    /** Review N2: a folder is not opened while notes are chosen, so the selection is not dropped. */
    @Test
    fun foldersWaitWhileNotesAreChosen() {
        val selection = NoteSelection()
        val opened = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                CompositionLocalProvider(LocalNoteSelection provides selection) {
                    NoteList(
                        notes = listOf(note("a", "Soup")),
                        folders = listOf(FolderItem("g", "Garden")),
                        onOpen = {},
                        onFolder = { opened += it },
                        onLongPress = { selection.start(it) },
                        onFolderLongPress = { opened += "actions ${it.id}" },
                        selectable = true,
                    )
                }
            }
        }
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        compose.onNodeWithText("Garden").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Garden").performTouchInput { longClick() }
        assertEquals(emptyList<String>(), opened)
        assertEquals(listOf("a"), selection.picked.map { it.id })
        selection.clear()
        compose.onNodeWithText("Garden").assertIsEnabled().performClick()
        assertEquals(listOf("g"), opened)
    }

    @Test
    fun trashMovesEveryNoteWithOneUndoForAll() = runBlocking<Unit> {
        filed()
        val snackbar = SnackbarHostState()
        val scope = CoroutineScope(Dispatchers.Default)
        suspend fun showing(message: String) = withTimeout(5_000) {
            while (snackbar.currentSnackbarData?.visuals?.message != message) delay(5)
            snackbar.currentSnackbarData!!
        }
        var syncs = 0
        var outcome: TrashOutcome? = null
        val job = scope.moveNotesToTrashWithUndo(store, { syncs++ }, snackbar, listOf("a", "b", "gone"), undoFor = 60_000, sayFor = 60_000) { outcome = it }
        val shown = showing("Moved 2 of 3 notes to Trash; 1 could not be: not on this phone any more")
        assertEquals("Undo", shown.visuals.actionLabel)
        assertFalse(store.observeList().first().any { it.id == "a" || it.id == "b" })
        shown.performAction()
        // What Undo did is said next, then the move ends.
        showing("Restored 2 notes").dismiss()
        job.join()
        assertTrue(store.observeList().first().map { it.id }.containsAll(listOf("a", "b")))
        assertEquals("Restored 2 notes", outcome?.undone)
        assertEquals(1, syncs)

        // Not undone in time: they stay in Trash, and are sent.
        scope.moveNotesToTrashWithUndo(store, { syncs++ }, snackbar, listOf("a", "c"), undoFor = 50) { outcome = it }.join()
        assertEquals(listOf("a", "c"), store.observeTrash().first().map { it.id }.sorted())
        assertEquals(null, outcome?.undone)
        assertEquals(2, syncs)
    }

    /** #137 (review N7): only a list that takes part in selection mode says "Select". */
    @Test
    fun aListThatDoesNotTakePartKeepsItsOwnLongPressUnderASelection() {
        val selection = NoteSelection()
        val pressed = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                CompositionLocalProvider(LocalNoteSelection provides selection) {
                    NoteList(notes = listOf(note("a", "Soup")), onOpen = {}, onLongPress = { pressed += it.id })
                }
            }
        }
        compose.onNodeWithText("Soup").assert(
            SemanticsMatcher("long press named Note Actions") { it.config.getOrElseNullable(SemanticsActions.OnLongClick) { null }?.label == "Note Actions" },
        )
        compose.onNodeWithText("Soup").performTouchInput { longClick() }
        assertEquals(listOf("a"), pressed)
        // Another list's selection mode leaves this one's rows as they are: no checkbox.
        selection.start(note("b", "Tea"))
        compose.waitForIdle()
        compose.onNode(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox)).assertDoesNotExist()
    }

    /** #137 (review N1): a folder gone from the phone is named as the reason, not the notes. */
    @Test
    fun aMoveToAFolderNoLongerOnThePhoneSaysTheFolderIsGone() = runBlocking {
        filed()
        assertEquals("Kitchen isn't on this phone any more", moveNotesAndSay(store, listOf("a", "b"), "nowhere", "Kitchen") {})
        assertEquals("Kitchen isn't on this phone any more", moveNotesAndSay(store, listOf("b"), "nowhere", "Kitchen") {})
        // One note's move, from its sheet: the folder's name is gone with it.
        assertEquals("That folder isn't on this phone any more", oneMoveSaid(NoteStore.Move.NO_FOLDER, "the folder"))
        assertEquals("Moved to Kitchen", oneMoveSaid(NoteStore.Move.MOVED, "Kitchen"))
        assertEquals("Already in Kitchen", oneMoveSaid(NoteStore.Move.ALREADY_THERE, "Kitchen"))
        assertEquals("This note can't be moved", oneMoveSaid(NoteStore.Move.REFUSED, "Kitchen"))
    }

    /** #137 (review N1): when no note can go to Trash, it says so instead of nothing. */
    @Test
    fun whenNoNoteCanGoToTrashItSaysSo() = runBlocking<Unit> {
        filed()
        val snackbar = SnackbarHostState()
        val scope = CoroutineScope(Dispatchers.Default)
        suspend fun showing(message: String) = withTimeout(5_000) {
            while (snackbar.currentSnackbarData?.visuals?.message != message) delay(5)
            snackbar.currentSnackbarData!!
        }
        val several = scope.moveNotesToTrashWithUndo(store, {}, snackbar, listOf("gone", "lost"), undoFor = 60_000)
        val shown = showing("None of the 2 notes could move to Trash: they aren't on this phone any more")
        assertEquals(null, shown.visuals.actionLabel)
        shown.dismiss()
        several.join()
        val one = scope.moveNotesToTrashWithUndo(store, {}, snackbar, listOf("gone"), undoFor = 60_000)
        showing("This note can't be moved to Trash: it isn't on this phone any more").dismiss()
        one.join()
        // The one-note path (a note's sheet, Search) says it too.
        val single = scope.moveToTrashWithUndo(store, {}, snackbar, "gone", undoFor = 60_000)
        showing("This note can't be moved to Trash: it isn't on this phone any more").dismiss()
        single.join()
        assertEquals(emptyList<String>(), store.observeTrash().first().map { it.id })
    }

    /** T53 item 12: one note's ⋮ menu starts with New Note Here and New Folder Here, beside it. */
    @Test
    fun oneNotesMoreMenuMakesANoteOrFolderBesideIt() {
        val did = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                SelectionBar(
                    listOf(Picked("a", "Soup")),
                    onClose = {},
                    onMove = {},
                    onTrash = {},
                    onRename = {},
                    onNewNoteHere = { did += "note" },
                    onNewFolderHere = { did += "folder" },
                )
            }
        }
        compose.onNodeWithTag("selectionMore").performClick()
        compose.onNodeWithTag("selectionNewNote").assertTextEquals("New Note Here").performClick()
        compose.onNodeWithTag("selectionMore").performClick()
        compose.onNodeWithTag("selectionNewFolder").assertTextEquals("New Folder Here").performClick()
        assertEquals(listOf("note", "folder"), did)
    }
}
