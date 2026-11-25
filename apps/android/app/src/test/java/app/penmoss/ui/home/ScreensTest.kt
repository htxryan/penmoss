package app.penmoss.ui.home

import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertIsSelected
import androidx.test.espresso.Espresso
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.capture.Captures
import app.penmoss.capture.RefusedCapturesScreen
import app.penmoss.data.CapturesWaiting
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.settings.SidebarLayout
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.NoteItem
import app.penmoss.ui.common.NoteList
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.HomeLayout

/** Compose UI tests of the native screens (T32), on Robolectric: no emulator on the worker. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private fun note(id: String, title: String, excerpt: String = "", date: String = "Oct 21") = NoteItem(id, title, excerpt, date)

    @Test
    fun homeStatusIsReadOutOnlyWhenItNeedsAttention() {
        var alert by mutableStateOf(false)
        var status by mutableStateOf("Synced at 3:42 PM")
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = listOf(note("n1", "Groceries")),
                        folders = listOf(FolderItem("f1", "Projects")),
                        status = status,
                        statusAlert = alert,
                        syncing = false,
                    ),
                    HomeActions(),
                )
            }
        }
        // "Synced at …" changes after every pass: not a live region.
        compose.onNodeWithTag("syncStatus").assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.LiveRegion))
        status = "Offline: showing what's on this phone"
        alert = true
        compose.onNodeWithTag("syncStatus")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
    }

    @Test
    fun goingOfflineIsReadOutWithHomesListScrolledDown() {
        var alert by mutableStateOf(false)
        var status by mutableStateOf("Synced at 3:42 PM")
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        page = HomePage.RECENT,
                        recent = (1..60).map { note("n$it", "Note $it") },
                        folders = listOf(FolderItem("f1", "Projects")),
                        // Recent Notes at its longest (T53 item 8): 50 of them.
                        layout = HomeLayout(recentCount = SidebarLayout.RECENT_MAX),
                        status = status,
                        statusAlert = alert,
                        syncing = false,
                    ),
                    HomeActions(),
                )
            }
        }
        // Far down the list, where the list's own header has scrolled away (A530).
        compose.onNodeWithTag("noteList").performScrollToIndex(50)
        status = "Offline: showing what's on this phone"
        alert = true
        compose.onNodeWithTag("syncStatus")
            .assertIsDisplayed()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
    }

    @Test
    fun theNotesListShowsFoldersThenNotesAndOpensThem() {
        val opened = mutableListOf<String>()
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        // The notes list (A1608): the top level's folders, then its notes.
                        notes = listOf(note("n1", "Groceries", "eggs, milk"), note("n2", "Untitled")),
                        recent = listOf(note("r1", "Not on this page")),
                        folders = listOf(FolderItem("f1", "Projects")),
                        status = "Synced at 3:42 PM",
                        syncing = false,
                        notebook = "Garden",
                    ),
                    HomeActions(
                        onSearch = { events += "search" },
                        onSettings = { events += "settings" },
                        onFolder = { events += "folder:$it" },
                        onOpen = { opened += it },
                        onToday = { events += "today" },
                        onThisWeek = { events += "week" },
                        onJournal = { events += "journal" },
                        onNewNote = { events += "new" },
                        onCapture = { events += "capture" },
                        onFeedback = { events += "feedback" },
                    ),
                )
            }
        }
        // The status line is a dot beside the title, the notebook's name (A1538, A1613), its
        // words its name (T51, A933).
        compose.onNodeWithTag("syncDot").assertIsDisplayed().assertContentDescriptionEquals("Synced at 3:42 PM")
        compose.onNodeWithTag("homeTitle", useUnmergedTree = true).assertTextEquals("Garden")
        compose.onNodeWithText("eggs, milk").assertIsDisplayed()
        compose.onNodeWithText("Not on this page").assertDoesNotExist()
        assertTrue(compose.onNodeWithText("Projects").getBoundsInRoot().top < compose.onNodeWithText("Groceries").getBoundsInRoot().top)
        compose.onNodeWithText("Groceries").performClick()
        compose.onNodeWithText("Projects").performClick()
        // Today and This Week are icons in Home's row, named and with tooltips (T51, A932).
        compose.onNodeWithContentDescription("Today").performClick()
        compose.onNodeWithContentDescription("This Week").performClick()
        // Journal and Capture are on the row too (A1613); the drawer has no places, and there is no All Notes (A1615).
        compose.onNodeWithTag("homeAllNotes").assertDoesNotExist()
        compose.onNodeWithTag("homeJournal").performScrollTo().performClick()
        compose.onNodeWithTag("homeCapture").performScrollTo().performClick()
        // Send Feedback is in the hamburger's drawer (A1604).
        compose.onNodeWithTag("homeMenu").performClick()
        compose.onNodeWithTag("homeFeedback").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Search").performScrollTo().performClick()
        compose.onNodeWithContentDescription("New Note").performClick()
        assertEquals(listOf("n1"), opened)
        assertEquals(listOf("folder:f1", "today", "week", "journal", "capture", "feedback", "search", "new"), events)
    }

    /** Quick Access (T51, A946): a page of its own (A1608); with none, it says No Notes. */
    @Test
    fun quickAccessIsAPageThatListsThePinsAndShowsItEmpty() {
        var pinned by mutableStateOf(listOf(note("p1", "Garden plan"), note("p2", "Reading list")))
        val opened = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        page = HomePage.QUICK_ACCESS,
                        recent = listOf(note("n1", "Groceries")),
                        folders = emptyList(),
                        status = "Synced at 3:42 PM",
                        syncing = false,
                        quickAccess = pinned,
                    ),
                    HomeActions(
                        onOpen = { opened += it },
                    ),
                )
            }
        }
        compose.onNodeWithTag("homeTitle").assertTextEquals("Quick Access")
        compose.onNodeWithText("Groceries").assertDoesNotExist()
        compose.onNodeWithTag("homeQuickAccess-p2").performClick()
        assertEquals(listOf("p2"), opened)
        compose.onNodeWithTag("homeQuickAccessEmpty").assertDoesNotExist()
        pinned = emptyList()
        compose.onNodeWithTag("homeQuickAccessEmpty").assertTextEquals("No Notes")
    }

    @Test
    fun homeSaysWhenCapturesWaitToSyncOrWereRefused() {
        var waiting by mutableStateOf(0)
        var refused by mutableStateOf(0)
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = emptyList(),
                        folders = emptyList(),
                        status = "",
                        syncing = false,
                        capturesWaiting = waiting,
                        capturesRefused = refused,
                    ),
                    HomeActions(),
                )
            }
        }
        compose.onNodeWithTag("capturesWaiting").assertDoesNotExist()
        waiting = 2
        compose.onNodeWithText("2 captures are saved on this phone and will be added once it syncs.").assertIsDisplayed()
        waiting = 0
        refused = 1
        compose.onNodeWithTag("capturesWaiting").assertDoesNotExist()
        compose.onNodeWithText("Penmoss refused 1 capture. It is kept on this phone.").assertIsDisplayed()
    }

    @Test
    fun homeSaysWhyCapturesWaitAndOpensTheOnesThatCannotGo() {
        val events = mutableListOf<String>()
        val day = 24 * 60 * 60_000L
        val now = 1_760_986_000_000L
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = emptyList(),
                        folders = emptyList(),
                        status = "",
                        syncing = false,
                        capturesWaiting = 1,
                        capturesRefused = 2,
                        capturesWaitingWhy = capturesWhy(CapturesWaiting(1, now - 3 * day), now),
                    ),
                    HomeActions(
                        onRefusedCaptures = { events += "refused" },
                    ),
                )
            }
        }
        compose.onNodeWithTag("capturesWaitingWhy").assertTextContains("The oldest is from ", substring = true)
        compose.onNodeWithText("See Them").performClick()
        assertEquals(listOf("refused"), events)
        // Why is said only when it helps: a day old (S2).
        assertEquals(null, capturesWhy(CapturesWaiting(0), now))
        assertEquals(null, capturesWhy(CapturesWaiting(2, now - 60_000L), now))
        assertTrue(capturesWhy(CapturesWaiting(2, now - 2 * day), now)!!.startsWith("The oldest is from "))
    }

    @Test
    fun aCaptureThatCannotGoCanBeCopiedTriedAgainSentWithoutItsPicturesOrDiscarded() {
        val events = mutableListOf<String>()
        val refused = listOf(
            Captures.Refused("c1", "The view\n\n![](attachments/a.png)", Captures.PICTURES_MISSING, 0L, CaptureRequest.DAILY, missingPictures = true),
            Captures.Refused("c2", "Too long", "text is larger than 256 KB", 0L, CaptureRequest.INBOX, missingPictures = false),
        )
        compose.setContent {
            PenmossTheme {
                RefusedCapturesScreen(
                    captures = refused,
                    dateOf = { "Oct 21" },
                    onBack = { events += "back" },
                    onCopy = { events += "copy:${it.id}" },
                    onRetry = { events += "retry:${it.id}" },
                    onWithoutPictures = { events += "without:${it.id}" },
                    onDiscard = { events += "discard:${it.id}" },
                )
            }
        }
        compose.onNodeWithText("Oct 21 · Today’s note").assertIsDisplayed()
        compose.onNodeWithText("text is larger than 256 KB").assertIsDisplayed()
        // Only a capture whose pictures would not upload can go without them.
        compose.onAllNodesWithTag("refusedWithoutPictures").assertCountEquals(1)
        compose.onAllNodesWithTag("refusedCopy")[1].performClick()
        compose.onAllNodesWithTag("refusedRetry")[0].performClick()
        compose.onNodeWithTag("refusedWithoutPictures").performClick()
        compose.onAllNodesWithTag("refusedDiscard")[1].performClick()
        // Discarding deletes the only copy: it asks first (T39, A386).
        compose.onNodeWithText("Discard This Capture?").assertIsDisplayed()
        assertEquals(listOf("copy:c2", "retry:c1", "without:c1"), events)
        compose.onNodeWithTag("refusedDiscardConfirm").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        assertEquals(listOf("copy:c2", "retry:c1", "without:c1", "discard:c2", "back"), events)
    }

    @Test
    fun discardOnARefusedCaptureCanBeCancelled() {
        val events = mutableListOf<String>()
        val refused = listOf(Captures.Refused("c1", "Too long", "text is larger than 256 KB", 0L, CaptureRequest.INBOX, missingPictures = false))
        compose.setContent {
            PenmossTheme {
                RefusedCapturesScreen(
                    captures = refused,
                    dateOf = { "Oct 21" },
                    onBack = {},
                    onCopy = { events += "copy:${it.id}" },
                    onRetry = {},
                    onWithoutPictures = {},
                    onDiscard = { events += "discard:${it.id}" },
                )
            }
        }
        compose.onNodeWithTag("refusedDiscard").performClick()
        compose.onNodeWithText("Discard This Capture?").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        // Cancelled: the dialog goes, the capture stays, and Discard asks again next time (A386).
        compose.onNodeWithText("Discard This Capture?").assertDoesNotExist()
        compose.onNodeWithText("Too long").assertIsDisplayed()
        assertEquals(emptyList<String>(), events)
        compose.onNodeWithTag("refusedDiscard").performClick()
        compose.onNodeWithText("Discard This Capture?").assertIsDisplayed()
        compose.onNodeWithTag("refusedDiscardConfirm").performClick()
        assertEquals(listOf("discard:c1"), events)
    }

    @Test
    fun homeSaysWhenEditsWaitForAConflictCopy() {
        var kept by mutableStateOf(0)
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = listOf(note("n1", "Groceries")),
                        folders = emptyList(),
                        status = "",
                        syncing = false,
                        keptApart = kept,
                    ),
                    HomeActions(),
                )
            }
        }
        compose.onNodeWithTag("keptApart").assertDoesNotExist()
        // A background pass kept edits apart (A323): Home says so until an editor makes the copies.
        kept = 2
        compose.onNodeWithTag("keptApart").assertIsDisplayed()
        compose.onNodeWithText("Edits on this phone to 2 notes", substring = true).assertIsDisplayed()
        kept = 0
        compose.onNodeWithTag("keptApart").assertDoesNotExist()
    }

    @Test
    fun aFolderShowsItsSubfoldersBeforeItsNotes() {
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                FolderScreen(
                    title = "Projects",
                    folders = listOf(FolderItem("g", "Garden")),
                    notes = listOf(note("p", "Plan")),
                    onBack = { events += "back" },
                    onFolder = { events += "folder:$it" },
                    onOpen = { events += "note:$it" },
                )
            }
        }
        compose.onNodeWithText("Garden").performClick()
        compose.onNodeWithText("Plan").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        assertEquals(listOf("folder:g", "note:p", "back"), events)
    }

    @Test
    fun anEmptyFolderSaysSo() {
        compose.setContent { PenmossTheme { FolderScreen("Empty", emptyList(), emptyList(), {}, {}, {}) } }
        compose.onNodeWithText("This folder is empty.").assertIsDisplayed()
    }

    @Test
    fun rowsAreButtons() {
        compose.setContent { PenmossTheme { NoteList(listOf(note("a", "A")), onOpen = {}) } }
        compose.onNode(hasTestTag("noteList")).assertIsDisplayed()
        compose.onNode(hasClickAction() and androidx.compose.ui.test.hasText("A")).assertIsDisplayed()
    }
    /** The minute-by-minute pass is quick: Home shows its bar only for a pass that takes a while (T39, A390). */
    @Test
    fun syncNowOnHomeAsksOnceAndIsBackWhenItsPassEnds() {
        var asked = 0
        var pass = CompletableDeferred<Unit>()
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = emptyList(),
                        folders = emptyList(),
                        status = "Synced at 3:42 PM",
                        syncing = false,
                    ),
                    HomeActions(
                        onRefresh = {
                            asked++
                            pass.await()
                        },
                    ),
                )
            }
        }
        // Pull to refresh without the gesture (T39 review), for TalkBack and Switch Access.
        compose.onNodeWithContentDescription("Sync Now").assertHasClickAction().performClick()
        compose.waitForIdle()
        assertEquals(1, asked)
        // Until its pass ends, a second tap asks nothing more.
        compose.onNodeWithContentDescription("Sync Now").assertIsNotEnabled()
        pass.complete(Unit)
        compose.onNodeWithContentDescription("Sync Now").assertIsEnabled()
        pass = CompletableDeferred()
        compose.onNodeWithContentDescription("Sync Now").performClick()
        compose.waitForIdle()
        assertEquals(2, asked)
    }

    @Test
    fun homeShowsTheSyncBarOnlyForASlowPass() {
        var syncing by mutableStateOf(false)
        compose.mainClock.autoAdvance = false
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = emptyList(),
                        folders = emptyList(),
                        status = "Synced at 3:42 PM",
                        syncing = syncing,
                    ),
                    HomeActions(),
                )
            }
        }
        // Each change is taken in (its effect started) before the clock moves: with the clock
        // paused, a coroutine started during advanceTimeBy only runs at the next idle point.
        fun sync(now: Boolean) {
            syncing = now
            compose.waitForIdle()
        }
        sync(true)
        compose.mainClock.advanceTimeBy(SLOW_SYNC_MS / 2)
        compose.onNodeWithTag("syncProgress").assertDoesNotExist()
        sync(false)
        compose.mainClock.advanceTimeBy(SLOW_SYNC_MS)
        compose.onNodeWithTag("syncProgress").assertDoesNotExist()
        sync(true)
        compose.mainClock.advanceTimeBy(SLOW_SYNC_MS + 200)
        compose.onNodeWithTag("syncProgress").assertExists()
        sync(false)
        compose.mainClock.advanceTimeBy(100)
        compose.onNodeWithTag("syncProgress").assertDoesNotExist()
    }

    @Test
    fun aMessageOffersItsAction() {
        var tried = 0
        compose.setContent { PenmossTheme { CenteredMessage("This note isn't on the phone yet.", action = "Try again" to { tried++ }) } }
        compose.onNodeWithTag("messageAction").assertTextEquals("Try again").performClick()
        assertEquals(1, tried)
    }

    /** Settings → Home → Notes in the Sidebar (A1622): each Quick Access note one tap away, no page. */
    @Test
    fun withNotesInTheSidebarTheDrawerListsQuickAccessNotesThatOpenInOneTap() {
        var opened: String? = null
        var inDrawer by mutableStateOf(true)
        var pinned by mutableStateOf(listOf(note("p1", "Garden plan"), note("p2", "Seeds")))
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        notebookId = "nb",
                        notebooks = listOf(DrawerNotebook("nb", "Garden")),
                        notebook = "Garden",
                        title = "Garden",
                        quickAccess = pinned,
                        layout = app.penmoss.ui.settings.HomeLayout(quickAccessInDrawer = inDrawer),
                        status = "Synced",
                    ),
                    HomeActions(onOpen = { opened = it }),
                )
            }
        }
        compose.onNodeWithTag("homeMenu").performClick()
        compose.onNodeWithTag("drawerQuickAccess").assertDoesNotExist()
        compose.onNodeWithTag("drawerQuickAccessNote-p2").performScrollTo().assertTextContains("Seeds").performClick()
        assertEquals("p2", opened)
        // None pinned: it says how to pin one.
        pinned = emptyList()
        compose.onNodeWithTag("homeMenu").performClick()
        compose.onNodeWithTag("drawerQuickAccessNone").assertExists()
        // Off: the Quick Access page, as before.
        inDrawer = false
        compose.onNodeWithTag("drawerQuickAccess").assertExists()
        compose.onNodeWithTag("drawerQuickAccessNote-p1").assertDoesNotExist()
    }

    /**
     * Each of the sidebar's sections is a page of its own (Ryan's Android feedback, item 11, A1608):
     * the drawer picks Quick Access, Recent Notes or this notebook's notes list, marks the one shown,
     * and Back from the others returns to the notes list.
     */
    @Test
    fun theDrawerPicksEachSectionsPageAndBackReturnsToTheNotesList() {
        var page by mutableStateOf(HomePage.RECENT)
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        page = page,
                        notebookId = "nb",
                        notebooks = listOf(DrawerNotebook("nb", "Garden")),
                        notebook = "Garden",
                        title = "Garden",
                        recent = listOf(note("n1", "Groceries")),
                        folders = listOf(FolderItem("f1", "Projects")),
                        quickAccess = listOf(note("p1", "Garden plan")),
                        status = "Synced",
                    ),
                    HomeActions(onPage = { page = it }),
                )
            }
        }
        compose.onNodeWithTag("homeTitle").assertTextEquals("Recent Notes")
        compose.onNodeWithText("Groceries").assertIsDisplayed()
        compose.onNodeWithText("Projects").assertDoesNotExist()
        // No New Folder on a page that is not the notes list.
        compose.onNodeWithTag("homeMore").assertDoesNotExist()
        compose.onNodeWithTag("homeMenu").performClick()
        compose.onNodeWithTag("drawerRecent").assertIsSelected()
        compose.onNodeWithTag("drawerQuickAccess").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("homeTitle").assertTextEquals("Quick Access")
        compose.onNodeWithText("Garden plan").assertIsDisplayed()
        compose.onNodeWithTag("homeMenu").performClick()
        // The notebooks on this phone, and no All Notebooks: that is Settings' (item 17, A1614).
        compose.onNodeWithTag("drawerAllNotebooks").assertDoesNotExist()
        compose.onNodeWithText("All Notebooks").assertDoesNotExist()
        compose.onNodeWithTag("drawerNotebook-nb").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("homeTitle").assertTextEquals("Garden")
        compose.onNodeWithText("Projects").assertIsDisplayed()
        compose.onNodeWithTag("homeMore").assertIsDisplayed()
        page = HomePage.RECENT
        compose.waitForIdle()
        Espresso.pressBack()
        compose.waitForIdle()
        assertEquals(HomePage.NOTES, page)
    }

    /** Quick Access on Home (T53 item 10): a long press removes or moves a pin; its notebook under it when asked. */
    @Test
    fun quickAccessRemovesAndMovesFromALongPressAndNamesTheNotebook() {
        val events = mutableListOf<String>()
        var layout by mutableStateOf(HomeLayout())
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        page = HomePage.QUICK_ACCESS,
                        recent = emptyList(),
                        folders = emptyList(),
                        status = "Synced",
                        syncing = false,
                        quickAccess = listOf(note("p1", "Garden plan"), note("p2", "Reading list")),
                        layout = layout,
                        quickAccessNotebooks = mapOf("p1" to "Personal", "p2" to "Work"),
                    ),
                    HomeActions(
                        onQuickAccessRemove = { events += "remove $it" },
                        onQuickAccessMove = { id, index -> events += "move $id $index" },
                    ),
                )
            }
        }
        compose.onAllNodesWithTag("quickAccessNotebook", useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithTag("homeQuickAccess-p1").performTouchInput { longClick() }
        compose.onNodeWithTag("quickAccessMoveUp").assertDoesNotExist()
        compose.onNodeWithTag("quickAccessMoveDown").performClick()
        compose.onNodeWithTag("homeQuickAccess-p2").performTouchInput { longClick() }
        compose.onNodeWithTag("quickAccessMoveDown").assertDoesNotExist()
        compose.onNodeWithTag("quickAccessRemove").assertTextEquals("Remove from Quick Access").performClick()
        assertEquals(listOf("move p1 1", "remove p2"), events)
        layout = layout.copy(quickAccessNotebook = true)
        compose.waitForIdle()
        compose.onAllNodesWithTag("quickAccessNotebook", useUnmergedTree = true).assertCountEquals(2)
        compose.onNodeWithText("Work", useUnmergedTree = true).assertExists()
    }
}
