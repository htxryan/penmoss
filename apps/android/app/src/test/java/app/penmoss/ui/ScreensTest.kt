package app.penmoss.ui

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
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.onChildren
import androidx.compose.ui.test.filter
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.capture.Captures
import app.penmoss.capture.RefusedCapturesScreen
import app.penmoss.data.CapturesWaiting
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.settings.SidebarLayout
import app.penmoss.ui.screens.CenteredMessage
import app.penmoss.ui.screens.FolderScreen
import app.penmoss.ui.screens.HomeScreen
import app.penmoss.ui.screens.SLOW_SYNC_MS
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertTextEquals
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

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
                    recent = listOf(note("n1", "Groceries")),
                    folders = listOf(FolderItem("f1", "Projects")),
                    status = status,
                    statusAlert = alert,
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
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
                    recent = (1..60).map { note("n$it", "Note $it") },
                    folders = listOf(FolderItem("f1", "Projects")),
                    // Recent Notes at its longest (T53 item 8): 50 of them.
                    layout = HomeLayout(recentCount = SidebarLayout.RECENT_MAX),
                    status = status,
                    statusAlert = alert,
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
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
    fun homeListsFoldersAndRecentNotesAndOpensThem() {
        val opened = mutableListOf<String>()
        val events = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = listOf(note("n1", "Groceries", "eggs, milk"), note("n2", "Untitled")),
                    folders = listOf(FolderItem("f1", "Projects")),
                    status = "Synced at 3:42 PM",
                    syncing = false,
                    onSearch = { events += "search" },
                    onSettings = { events += "settings" },
                    onAllNotes = { events += "all" },
                    onFolder = { events += "folder:$it" },
                    onOpen = { opened += it },
                    onToday = { events += "today" },
                    onThisWeek = { events += "week" },
                    onJournal = { events += "journal" },
                    onNewNote = { events += "new" },
                    onCapture = { events += "capture" },
                    onFeedback = { events += "feedback" },
                )
            }
        }
        // The status line is a dot on the personal notes' heading, its words its name (T51, A933),
        // which is named as the web's: Personal, the default notebook, even with no notebooks.
        compose.onNodeWithTag("syncDot").assertIsDisplayed().assertContentDescriptionEquals("Synced at 3:42 PM")
        compose.onNodeWithTag("homeFoldersTitle", useUnmergedTree = true).onChildren().filter(hasText("Personal")).assertCountEquals(1)
        compose.onNodeWithText("eggs, milk").assertIsDisplayed()
        compose.onNodeWithText("Groceries").performClick()
        compose.onNodeWithText("Projects").performClick()
        // Today and This Week are icons in Home's row, named and with tooltips (T51, A932).
        compose.onNodeWithContentDescription("Today").performClick()
        compose.onNodeWithContentDescription("This Week").performClick()
        // All notes moved to the overflow menu (T40 P5, JR2).
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithText("All Notes").performClick()
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithText("Journal").performClick()
        // Quick capture inside the app (T40 P9, PL1), first in the menu.
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithText("Quick Capture").performClick()
        // Send feedback (T49, D41), last in the menu.
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("homeFeedback").performClick()
        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNodeWithContentDescription("New Note").performClick()
        assertEquals(listOf("n1"), opened)
        assertEquals(listOf("folder:f1", "today", "week", "all", "journal", "capture", "feedback", "search", "new"), events)
    }

    /** Quick Access (T51, A946): the pinned notes first on Home; with none, the section says No Notes. */
    @Test
    fun homeListsQuickAccessFirstAndShowsItEmpty() {
        var pinned by mutableStateOf(listOf(note("p1", "Garden plan"), note("p2", "Reading list")))
        val opened = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = listOf(note("n1", "Groceries")),
                    folders = emptyList(),
                    status = "Synced at 3:42 PM",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = { opened += it },
                    onToday = {},
                    onNewNote = {},
                    quickAccess = pinned,
                )
            }
        }
        compose.onNodeWithTag("homeQuickAccessTitle").assertTextEquals("Quick Access")
        compose.onNodeWithTag("homeQuickAccess-p2").performClick()
        assertEquals(listOf("p2"), opened)
        compose.onNodeWithTag("homeQuickAccessEmpty").assertDoesNotExist()
        pinned = emptyList()
        compose.onNodeWithTag("homeQuickAccessTitle").assertTextEquals("Quick Access")
        compose.onNodeWithTag("homeQuickAccessEmpty").assertTextEquals("No Notes")
        // With no folders, the personal heading still carries the dot (A933); Recent notes has none.
        compose.onAllNodes(hasTestTag("syncDot") and hasAnyAncestor(hasTestTag("homeFoldersTitle")), useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithTag("syncDot").assertContentDescriptionEquals("Synced at 3:42 PM")
    }

    @Test
    fun homeSaysWhenCapturesWaitToSyncOrWereRefused() {
        var waiting by mutableStateOf(0)
        var refused by mutableStateOf(0)
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
                    capturesWaiting = waiting,
                    capturesRefused = refused,
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
                    capturesWaiting = 1,
                    capturesRefused = 2,
                    capturesWaitingWhy = capturesWhy(CapturesWaiting(1, now - 3 * day, serverOutdated = true), now),
                    onRefusedCaptures = { events += "refused" },
                )
            }
        }
        compose.onNodeWithTag("capturesWaitingWhy").assertTextEquals("Penmoss on the server has not been updated to take captures yet.")
        compose.onNodeWithText("See Them").performClick()
        assertEquals(listOf("refused"), events)
        // Why is said only when it helps: a day old, or a server without captures (S2).
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
        compose.onNodeWithText("Discard this capture?").assertIsDisplayed()
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
        compose.onNodeWithText("Discard this capture?").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        // Cancelled: the dialog goes, the capture stays, and Discard asks again next time (A386).
        compose.onNodeWithText("Discard this capture?").assertDoesNotExist()
        compose.onNodeWithText("Too long").assertIsDisplayed()
        assertEquals(emptyList<String>(), events)
        compose.onNodeWithTag("refusedDiscard").performClick()
        compose.onNodeWithText("Discard this capture?").assertIsDisplayed()
        compose.onNodeWithTag("refusedDiscardConfirm").performClick()
        assertEquals(listOf("discard:c1"), events)
    }

    @Test
    fun homeSaysWhenEditsWaitForAConflictCopy() {
        var kept by mutableStateOf(0)
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = listOf(note("n1", "Groceries")),
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
                    keptApart = kept,
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
                    recent = emptyList(),
                    folders = emptyList(),
                    status = "Synced at 3:42 PM",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    onRefresh = {
                        asked++
                        pass.await()
                    },
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
                    recent = emptyList(),
                    folders = emptyList(),
                    status = "Synced at 3:42 PM",
                    syncing = syncing,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
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

    /**
     * Home's sections (T53 item 8, A983): in the person's order, each title's long press moving or
     * hiding it, and the ⋮ menu's Show or Hide for each, by name A to Z, after its actions.
     */
    @Test
    fun homesSectionsFollowTheLayoutAndMoveOrHideFromTheirTitles() {
        val events = mutableListOf<String>()
        var layout by mutableStateOf(HomeLayout(order = listOf("recent", "notebooks", "quickAccess", "calendar", "tags")))
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = listOf(note("n1", "Groceries")),
                    folders = listOf(FolderItem("f1", "Projects")),
                    status = "Synced",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    quickAccess = listOf(note("p1", "Garden plan")),
                    layout = layout,
                    onSectionHidden = { section, hide -> events += "${if (hide) "hide" else "show"} $section" },
                    onSectionMove = { section, index -> events += "move $section $index" },
                )
            }
        }
        // Recent Notes first, as stored: above the notebook's heading.
        val recentTop = compose.onNodeWithTag("homeRecentTitle").fetchSemanticsNode().boundsInRoot.top
        val notebookTop = compose.onNodeWithTag("homeFoldersTitle").fetchSemanticsNode().boundsInRoot.top
        assertTrue(recentTop < notebookTop)
        // The first one moves down only; Move Down puts it after the next shown one.
        compose.onNodeWithTag("homeRecentTitle").performTouchInput { longClick() }
        compose.onNodeWithTag("sectionMoveUp").assertDoesNotExist()
        compose.onNodeWithTag("sectionMoveDown").performClick()
        compose.onNodeWithTag("homeRecentTitle").performTouchInput { longClick() }
        compose.onNodeWithTag("sectionHide").assertTextEquals("Hide Recent Notes").performClick()
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("homeSection-quickAccess").assertTextEquals("Hide Quick Access")
        compose.onNodeWithTag("homeSection-recent").assertTextEquals("Hide Recent Notes").performClick()
        // Hidden: gone from Home, and Show in the menu.
        layout = layout.copy(hidden = setOf("recent"))
        compose.waitForIdle()
        compose.onNodeWithTag("homeRecentTitle").assertDoesNotExist()
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithTag("homeSection-recent").assertTextEquals("Show Recent Notes").performClick()
        assertEquals(listOf("move recent 1", "hide recent", "hide recent", "show recent"), events)
    }

    /** Quick Access on Home (T53 item 10): a long press removes or moves a pin; its notebook under it when asked. */
    @Test
    fun quickAccessRemovesAndMovesFromALongPressAndNamesTheNotebook() {
        val events = mutableListOf<String>()
        var layout by mutableStateOf(HomeLayout())
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = emptyList(),
                    folders = emptyList(),
                    status = "Synced",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    quickAccess = listOf(note("p1", "Garden plan"), note("p2", "Reading list")),
                    layout = layout,
                    quickAccessNotebooks = mapOf("p1" to "Personal", "p2" to "Work"),
                    onQuickAccessRemove = { events += "remove $it" },
                    onQuickAccessMove = { id, index -> events += "move $id $index" },
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

    /**
     * A section shown again or moved first while Home is at its top stays in view (T53 pass, B3).
     * The list keeps its first item in place by key, so without this the section came back above
     * the screen and Home looked unchanged: ⋮ → Show Quick Access, or Notebooks' Move Up.
     */
    @Test
    fun aSectionShownOrMovedFirstAtTheTopStaysInView() {
        var layout by mutableStateOf(HomeLayout(order = listOf("quickAccess", "notebooks", "recent", "calendar", "tags"), hidden = setOf("quickAccess")))
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = listOf(note("n1", "Groceries")),
                    folders = (1..40).map { FolderItem("f$it", "Folder $it") },
                    status = "Synced",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    quickAccess = listOf(note("p1", "Garden plan")),
                    layout = layout,
                )
            }
        }
        compose.onNodeWithTag("homeFoldersTitle").assertIsDisplayed()
        layout = layout.copy(hidden = emptySet())
        compose.waitForIdle()
        compose.onNodeWithTag("homeQuickAccessTitle").assertIsDisplayed()
        layout = layout.copy(order = listOf("notebooks", "quickAccess", "recent", "calendar", "tags"))
        compose.waitForIdle()
        compose.onNodeWithTag("homeFoldersTitle").assertIsDisplayed()
    }

    /** A section moved from far down Home is scrolled to, so it doesn't leave the screen (T53 pass). */
    @Test
    fun aSectionMovedFromFarDownIsFollowed() {
        var layout by mutableStateOf(HomeLayout(order = listOf("quickAccess", "notebooks", "recent", "calendar", "tags")))
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = listOf(note("n1", "Groceries")),
                    folders = (1..40).map { FolderItem("f$it", "Folder $it") },
                    status = "Synced",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    quickAccess = listOf(note("p1", "Garden plan")),
                    layout = layout,
                    onSectionMove = { section, index ->
                        layout = layout.copy(order = (layout.order - section).toMutableList().apply { add(index, section) })
                    },
                )
            }
        }
        // Recent Notes, under forty folders: scrolled to, then moved above Notebooks.
        compose.onNodeWithTag("noteList").performScrollToNode(hasTestTag("homeRecentTitle"))
        compose.onNodeWithTag("homeRecentTitle").performTouchInput { longClick() }
        compose.onNodeWithTag("sectionMoveUp").performClick()
        compose.waitForIdle()
        assertEquals(listOf("quickAccess", "recent", "notebooks", "calendar", "tags"), layout.order)
        compose.onNodeWithTag("homeRecentTitle").assertIsDisplayed()
    }
}
