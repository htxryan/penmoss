package app.penmoss.ui

import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.ui.screens.HomeScreen
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** Trash's screens (T40 P3a, NT12–NT15, NT21), on Robolectric. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TrashScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val events = mutableListOf<String>()

    private val sent = TrashEntryUi("old", "Old plan", "Deleted Mon · goes for good in 20 days", 10, waiting = false)
    private val waiting = TrashEntryUi("soup", "Soup", "Moved to Trash on this phone · not sent yet", 20, waiting = true)

    private fun trash(ui: TrashUi) = compose.setContent {
        PenmossTheme {
            TrashScreen(
                ui = ui,
                onRestore = { events += "restore:${it.id}" },
                onDeleteForGood = { events += "delete:${it.id}" },
                onOpen = { events += "open:$it" },
                onMessageShown = { events += "shown" },
                onRefresh = { events += "refresh" },
                onBack = { events += "back" },
            )
        }
    }

    @Test
    fun trashListsEachNoteWithWhenItGoesAndItsActions() {
        trash(TrashUi(entries = listOf(waiting, sent)))
        compose.onNodeWithText("Deleted Mon · goes for good in 20 days").assertIsDisplayed()
        compose.onNodeWithText("Moved to Trash on this phone · not sent yet").assertIsDisplayed()
        // A move not sent yet can be restored (cancelled) but not deleted for good yet.
        compose.onNodeWithTag("deleteForGood-soup").assertIsNotEnabled()
        compose.onNodeWithTag("deleteForGood-old").assertIsEnabled()
        compose.onNodeWithTag("restore-soup").performClick()
        compose.onNodeWithTag("trashEmpty").assertDoesNotExist()
        assertEquals(listOf("restore:soup"), events)
    }

    @Test
    fun aServerWithoutTheRouteIsSaidAboveTheWaitingMoves() {
        trash(TrashUi(entries = listOf(waiting, sent), routeMissing = true))
        compose.onNodeWithTag("trashRouteMissing").assertIsDisplayed()
        compose.onNodeWithTag("restore-soup").assertIsEnabled()
    }

    @Test
    fun deleteForGoodAsksFirstAndCancelSendsNothing() {
        trash(TrashUi(entries = listOf(sent)))
        compose.onNodeWithTag("deleteForGood-old").performClick()
        compose.onNodeWithText("Delete “Old plan” for good?").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(events.isEmpty())
        compose.onNodeWithTag("deleteForGood-old").performClick()
        compose.onNodeWithTag("confirmDeleteForGood").performClick()
        assertEquals(listOf("delete:old"), events)
        compose.onNodeWithTag("confirmDeleteForGood").assertDoesNotExist()
    }

    /** No sign-in to manage Penmoss since T59 (A1040): Delete for good needs nothing more. */
    @Test
    fun deleteForGoodNeedsNoSignIn() {
        trash(TrashUi(entries = listOf(sent)))
        compose.onNodeWithTag("deleteForGood-old").assertIsEnabled()
        compose.onNodeWithTag("restore-old").assertIsEnabled()
        compose.onNodeWithTag("trashSignInAgain").assertDoesNotExist()
    }

    @Test
    fun anEmptyTrashSaysSoAndOfflineSaysWhatItShows() {
        trash(TrashUi(problem = "Offline: these are the notes this phone holds in Trash."))
        compose.onNodeWithTag("trashEmpty").assertIsDisplayed()
        // The web's words (T39 pass 3, A895).
        compose.onNodeWithText("Trash is empty. Nothing has been deleted lately.").assertIsDisplayed()
        compose.onNodeWithTag("trashProblem").assertIsDisplayed()
        compose.onNodeWithText("Offline: these are the notes this phone holds in Trash.").assertIsDisplayed()
    }

    @Test
    fun aRestoreSaysSoAndOffersToOpenTheNote() {
        var ui by mutableStateOf(TrashUi(entries = listOf(sent)))
        compose.setContent {
            PenmossTheme {
                // As the model does: the message cleared when the screen says it was shown.
                TrashScreen(ui, {}, {}, onOpen = { events += "open:$it" }, onMessageShown = {
                    events += "shown"
                    ui = ui.copy(message = null, restored = null)
                }, onRefresh = {}, onBack = {})
            }
        }
        ui = TrashUi(message = "Restored “Old plan”.", restored = "old")
        compose.onNodeWithText("Restored “Old plan”.").assertIsDisplayed()
        compose.onNodeWithText("Open").performClick()
        compose.waitUntil(5_000) { "open:old" in events }
        assertEquals(listOf("shown", "open:old"), events)
    }

    @Test
    fun aLongPressSheetOffersMoveRenameAndTrash() {
        compose.setContent {
            PenmossTheme { NoteActionsSheet("", onRename = { events += "rename" }, onMove = { events += "move" }, onTrash = { events += "trash" }, onDismiss = { events += "dismiss" }) }
        }
        compose.onNodeWithText("Untitled").assertIsDisplayed()
        compose.onNodeWithTag("noteAction-move").performClick()
        compose.onNodeWithTag("noteAction-rename").performClick()
        compose.onNodeWithTag("noteAction-trash").performClick()
        assertEquals(listOf("move", "rename", "trash"), events)
    }

    @Test
    fun aLongPressSheetOffersCopyAgentReferenceAfterRename() {
        // T52 item 4: Search's results keep their one-note sheet, with the reference in it.
        compose.setContent {
            PenmossTheme {
                NoteActionsSheet("Soup", onRename = {}, onMove = {}, onTrash = {}, onDismiss = {}, onCopyAgentReference = { events += "reference" })
            }
        }
        compose.onNodeWithTag("noteAction-copyAgentReference").assertTextEquals("Copy Agent Reference").performClick()
        assertEquals(listOf("reference"), events)
    }

    @Test
    fun homesOverflowOpensTrash() {
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = emptyList(),
                    folders = emptyList(),
                    status = "",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    onTrash = { events += "trash" },
                )
            }
        }
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("openTrash").performClick()
        assertEquals(listOf("trash"), events)
    }

    @Test
    fun theCopyNoticeNamesTheCopyAndOpensOrDismisses() {
        compose.setContent {
            PenmossTheme { CopyNotice("Soup (conflict, Pixel)", onOpen = { events += "open" }, onDismiss = { events += "dismiss" }) }
        }
        compose.onNodeWithText(
            "This note was restored or replaced on the server. What this phone had that it lacks is kept in a conflict copy, “Soup (conflict, Pixel)”.",
        ).assertIsDisplayed()
        compose.onNodeWithTag("openCopy").performClick()
        compose.onNodeWithTag("dismissCopyNotice").performClick()
        assertEquals(listOf("open", "dismiss"), events)
    }

    @Test
    fun undoWithinItsTimeCancelsTheMoveAndOtherwiseItStays() = runBlocking<Unit> {
        assertEquals(5_000L, UNDO_MS)
        val db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        try {
            val store = NoteStore(db)
            store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("soup", 1, "Soup", "", 5), ChangedNote("tea", 1, "", "", 4))))
            var syncs = 0
            val snackbar = SnackbarHostState()
            val scope = CoroutineScope(Dispatchers.Default)
            val undo = scope.moveToTrashWithUndo(store, { syncs++ }, snackbar, "soup")
            val shown = withTimeout(5_000) {
                while (snackbar.currentSnackbarData == null) delay(5)
                snackbar.currentSnackbarData!!
            }
            assertEquals("Moved “Soup” to Trash", shown.visuals.message)
            assertEquals("Undo", shown.visuals.actionLabel)
            assertFalse(store.observeList().first().any { it.id == "soup" })
            shown.performAction()
            undo.join()
            assertTrue(store.observeList().first().any { it.id == "soup" })
            assertEquals(0, store.unsentCount())
            assertEquals(1, syncs)

            // Not undone in time: it stays in Trash, and is sent.
            scope.moveToTrashWithUndo(store, { syncs++ }, snackbar, "tea", undoFor = 50).join()
            assertTrue(store.observeTrash().first().any { it.id == "tea" })
            assertEquals(null, snackbar.currentSnackbarData)
            assertEquals(1, store.unsentCount())
            assertEquals(2, syncs)
        } finally {
            db.close()
        }
    }

    @Test
    fun aSecondMoveToTrashGetsItsOwnUndoTimeAtOnce() = runBlocking<Unit> {
        val db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        try {
            val store = NoteStore(db)
            store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("a", 1, "A", "", 5), ChangedNote("b", 1, "B", "", 4))))
            val snackbar = SnackbarHostState()
            val scope = CoroutineScope(Dispatchers.Default)
            suspend fun showing(message: String) = withTimeout(5_000) {
                while (snackbar.currentSnackbarData?.visuals?.message != message) delay(5)
                snackbar.currentSnackbarData!!
            }
            val first = scope.moveToTrashWithUndo(store, {}, snackbar, "a", undoFor = 60_000)
            showing("Moved “A” to Trash")
            // B right after: its snackbar shows at once, rather than when A's time runs out, and
            // A's move simply stays.
            val second = scope.moveToTrashWithUndo(store, {}, snackbar, "b", undoFor = 60_000)
            val shownB = showing("Moved “B” to Trash")
            first.join()
            assertTrue(store.observeTrash().first().any { it.id == "a" })
            shownB.performAction()
            second.join()
            assertTrue(store.observeList().first().any { it.id == "b" })
        } finally {
            db.close()
        }
    }

    /** #137 (review N5): TalkBack hears "(agent)" where a row shows ✦. */
    @Test
    fun anAgentsMarkIsSpokenAsAgent() {
        val byAgent = TrashEntryUi("a", "Plan", "Deleted Mon by Claude Code ✦ · goes for good in 20 days", 10, waiting = false, spoken = "Deleted Mon by Claude Code (agent) · goes for good in 20 days")
        trash(TrashUi(entries = listOf(byAgent, sent)))
        compose.onNodeWithContentDescription("Deleted Mon by Claude Code (agent) · goes for good in 20 days").assertIsDisplayed()
        // A row with no agent reads as it shows.
        compose.onNodeWithText("Deleted Mon · goes for good in 20 days").assertIsDisplayed()
    }

    @Test
    fun aLongPressSheetOffersNewNoteAndNewFolderHereFirst() {
        // T53 item 12: beside the note, in its folder.
        compose.setContent {
            PenmossTheme {
                NoteActionsSheet(
                    "Soup",
                    onRename = {},
                    onMove = {},
                    onTrash = {},
                    onDismiss = {},
                    onNewNoteHere = { events += "note" },
                    onNewFolderHere = { events += "folder" },
                )
            }
        }
        compose.onNodeWithTag("noteAction-newNote").assertTextEquals("New Note Here").performClick()
        compose.onNodeWithTag("noteAction-newFolder").assertTextEquals("New Folder Here").performClick()
        assertEquals(listOf("note", "folder"), events)
    }
}
