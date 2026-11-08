package app.penmoss.ui

import android.view.KeyEvent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.font.FontWeight
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.search.SearchOutcome
import app.penmoss.search.SearchResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** Search's screen (T40 P6, FD1–FD3) and the Ctrl+E switcher (FD7), on Robolectric. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SearchScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private fun answer(vararg results: SearchResult, source: SearchOutcome.Source = SearchOutcome.Source.SERVER, notice: String? = null) =
        SearchView(results.toList(), searching = false, outcome = SearchOutcome(source, results.toList(), notice))

    @Test
    fun searchSendsWhatIsTypedAndOpensAResult() {
        val queries = mutableListOf<String>()
        val opened = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                SearchScreen(
                    query = "",
                    onQuery = { queries += it },
                    view = answer(SearchResult("r", "Garden plan", "", "Tomatoes along the fence")),
                    onBack = {},
                    onOpen = { opened += it },
                )
            }
        }
        compose.onNodeWithTag("searchField").performTextInput("garden")
        compose.onNodeWithText("Tomatoes along the fence").assertIsDisplayed()
        compose.onNodeWithText("Garden plan").performClick()
        assertEquals("garden", queries.last())
        assertEquals(listOf("r"), opened)
    }

    @Test
    fun saysWhenNothingMatchesAndCountsResultsAsTheWebDoes() {
        var view by mutableStateOf(answer())
        compose.setContent { PenmossTheme { SearchScreen("zzz", {}, view, onBack = {}, onOpen = {}) } }
        compose.onNodeWithText("No notes match “zzz”").assertIsDisplayed()
        compose.onNodeWithText("No results").assertIsDisplayed()
        view = answer(SearchResult("a", "One", "", ""), SearchResult("b", "Two", "", ""), source = SearchOutcome.Source.DEVICE)
        compose.onNodeWithText("2 results on this device").assertIsDisplayed()
    }

    @Test
    fun saysWordsOnlyQuietlyWhenMeaningCouldNotAnswer() {
        val reason = app.penmoss.search.SearchService.WORDS_ONLY_OFFLINE
        compose.setContent {
            PenmossTheme {
                SearchScreen(
                    "otters",
                    {},
                    SearchView(emptyList(), outcome = SearchOutcome(SearchOutcome.Source.DEVICE, emptyList(), wordsOnly = reason)),
                    onBack = {},
                    onOpen = {},
                )
            }
        }
        // T42's wording: the label, with the reason as its description (review S1).
        compose.onNodeWithTag("searchWordsOnly").assertIsDisplayed()
        compose.onNodeWithText("Words only").assertIsDisplayed()
        compose.onNodeWithContentDescription("Words only. $reason").assertIsDisplayed()
        compose.onNodeWithTag("searchNotice").assertDoesNotExist()
    }

    @Test
    fun thereIsNoModeToPick() {
        compose.setContent { PenmossTheme { SearchScreen("", {}, SearchView(), onBack = {}, onOpen = {}) } }
        // Hybrid always (T42, A460): no Full-text, Semantic or Hybrid row.
        compose.onNodeWithTag("searchModes").assertDoesNotExist()
        compose.onNodeWithText("Semantic").assertDoesNotExist()
    }

    /** Snippets and titles paint the matched words as the web marks them (FD1). */
    @Test
    fun paintsTheMatchedWordsOfTheTitleAndSnippet() {
        compose.setContent {
            PenmossTheme {
                SearchScreen(
                    "garden",
                    {},
                    answer(SearchResult("r", "Garden plan", "\u0002Garden\u0003 plan", "…the \u0002garden\u0003 hose drips")),
                    onBack = {},
                    onOpen = {},
                )
            }
        }
        val snippet = compose.onNodeWithText("…the garden hose drips", useUnmergedTree = true).fetchSemanticsNode()
            .config[SemanticsProperties.Text].single()
        val marked = snippet.spanStyles.filter { it.item.fontWeight == FontWeight.SemiBold && it.item.background.alpha > 0f }
        assertEquals(listOf("garden"), marked.map { snippet.text.substring(it.start, it.end) })
        val title = compose.onNodeWithText("Garden plan", useUnmergedTree = true).fetchSemanticsNode()
            .config[SemanticsProperties.Text].single()
        assertEquals(listOf("Garden"), title.spanStyles.filter { it.item.background.alpha > 0f }.map { title.text.substring(it.start, it.end) })
    }

    @Test
    fun showsASemanticResultsSectionTagsAndThatItWasFoundByMeaning() {
        compose.setContent {
            PenmossTheme {
                SearchScreen(
                    "otters",
                    {},
                    answer(SearchResult("r", "River trip", "", "we saw them", heading = "Wildlife", tags = listOf("travel"), semantic = true)),
                    onBack = {},
                    onOpen = {},
                    dateOf = { "Oct 21" },
                )
            }
        }
        compose.onNodeWithText("› Wildlife  #travel", substring = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("Found by meaning").assertIsDisplayed()
    }

    @Test
    fun theFiltersAndWhatEnterAskedForOutliveARotation() {
        val scope = androidx.compose.runtime.saveable.SaverScope { true }
        val filters = SearchFilterUi(folderId = "f", folderName = "Garden", tag = "area/kitchen", range = 2, updatedAfter = 9)
        val saved = with(SearchFilterUi.Saver) { scope.save(filters) }!!
        assertEquals(filters, SearchFilterUi.Saver.restore(saved))
        val submitted = "otters" to filters
        val again = with(SearchFilterUi.SubmittedSaver) { scope.save(submitted) }!!
        assertEquals(submitted, SearchFilterUi.SubmittedSaver.restore(again))
        // Nothing asked: nothing saved, so it comes back as nothing.
        assertEquals(null, with(SearchFilterUi.SubmittedSaver) { scope.save(null) })
    }

    @Test
    fun theFiltersPickAFolderATagAndAnUpdatedRange() {
        var filters by mutableStateOf(SearchFilterUi())
        compose.setContent {
            PenmossTheme {
                SearchScreen(
                    "plan",
                    {},
                    SearchView(),
                    onBack = {},
                    onOpen = {},
                    filters = filters,
                    onFilters = { filters = it },
                    folderChoices = listOf(FolderChoice(null, "Top level", 0), FolderChoice("p", "Projects", 0), FolderChoice("pm", "Penmoss", 1, "Projects")),
                    tags = tagOptions(listOf("area/cooking", "project")),
                    now = { 10 * 86_400_000L },
                )
            }
        }
        compose.onNodeWithText("All folders").performClick()
        compose.onNodeWithText("Penmoss").performClick()
        assertEquals("pm", filters.folderId)
        compose.onNodeWithTag("folderFilter").assertIsSelected()
        compose.onNodeWithText("Penmoss").assertIsDisplayed()

        compose.onNodeWithText("Any tag").performClick()
        // Parents are offered with their nested tags, as the web's tree.
        compose.onNodeWithText("#area").assertIsDisplayed()
        compose.onNodeWithText("#area/cooking").performClick()
        assertEquals("area/cooking", filters.tag)

        compose.onNodeWithText("Any time").performClick()
        compose.onNodeWithText("Past week").performClick()
        assertEquals(2, filters.range)
        assertEquals(3 * 86_400_000L, filters.updatedAfter)
        assertEquals(app.penmoss.engine.api.SearchFilters("pm", "area/cooking", 3 * 86_400_000L), filters.filters())

        // Back to everything.
        compose.onNodeWithText("Penmoss").performClick()
        compose.onNodeWithText("All folders").performClick()
        assertNull(filters.folderId)
    }

    @Test
    fun theStatusLineFollowsTheSearch() {
        assertEquals("Type to search every note.", searchStatus("", SearchView()))
        assertEquals("Searching…", searchStatus("x", SearchView(searching = true)))
        val one = SearchResult("a", "A", "", "")
        assertEquals("1 result", searchStatus("x", answer(one)))
        // The phone's answer while typing is a preview: not "on this device" until final.
        val preview = SearchView(listOf(one), searching = true, outcome = SearchOutcome(SearchOutcome.Source.DEVICE, listOf(one), preview = true))
        assertEquals("1 result", searchStatus("x", preview))
        assertEquals("1 result on this device", searchStatus("x", answer(one, source = SearchOutcome.Source.DEVICE)))
    }

    @Test
    fun tagOptionsListParentsWithTheirNestedTags() {
        assertEquals(listOf("area", "area/cooking", "area/garden", "inbox"), tagOptions(listOf("inbox", "area/garden", "area/cooking", "inbox")))
    }

    // --- Actions (FD6) ---

    @Test
    fun listsTheActionsTheQueryFindsAboveTheNotesAndRunsOne() {
        val ran = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                SearchScreen(
                    "dark",
                    {},
                    answer(SearchResult("r", "Dark roast", "", "")),
                    onBack = {},
                    onOpen = {},
                    actions = searchActionsFor("dark", actionsFirst = false),
                    onAction = { ran += it.id },
                )
            }
        }
        compose.onNodeWithText("Actions").assertIsDisplayed()
        compose.onNodeWithText("Notes").assertIsDisplayed()
        compose.onNodeWithTag("action-theme.toggleDark").performClick()
        assertEquals(listOf("theme.toggleDark"), ran)
    }

    @Test
    fun saysNoNotesMatchOnlyWhenNoActionMatchesEither() {
        compose.setContent { PenmossTheme { SearchScreen("week", {}, answer(), onBack = {}, onOpen = {}, actions = searchActionsFor("week", false)) } }
        compose.onNodeWithText("This Week's Note").assertIsDisplayed()
        compose.onNodeWithText("No notes match “week”").assertDoesNotExist()
    }

    @Test
    fun listsEveryActionWhenCtrlKOpensSearchAndAtMostFiveOtherwise() {
        assertEquals(app.penmoss.search.SearchActions.ALL, searchActionsFor("", actionsFirst = true))
        assertTrue(searchActionsFor("", actionsFirst = false).isEmpty())
        assertTrue(searchActionsFor("e", actionsFirst = false).size <= app.penmoss.search.SearchActions.SHOWN)
        assertTrue(searchActionsFor("e", actionsFirst = true).size > app.penmoss.search.SearchActions.SHOWN)
    }

    @Test
    fun eachActionCallsTheTargetItNames() {
        val did = mutableListOf<String>()
        val targets = ActionTargets(
            open = { did += "open $it" },
            home = { did += "home" },
            newNote = { did += "new note" },
            newFolder = { did += "new folder" },
            capture = { did += "capture" },
            periodic = { did += "periodic ${it.wire}" },
            toggleDark = { did += "dark" },
            feedback = { did += "feedback" },
        )
        for (action in app.penmoss.search.SearchActions.ALL) assertTrue(action.id, runSearchAction(action.id, targets))
        assertFalse(runSearchAction("app.toggleSidebar", targets))
        assertEquals(
            listOf(
                "open settings/shortcuts", "open settings", "open settings/shortcuts", "open settings/git", "open settings/about", "feedback", "home", "open graph", "new note", "capture",
                "open trash", "periodic daily", "periodic weekly", "open journal", "open settings/daily", "new folder",
                "open settings/appearance", "open settings/display", "open settings/symbols", "open settings/appearance", "dark",
            ),
            did,
        )
    }

    // --- Ctrl+E (FD7) ---

    private fun key(code: Int, action: Int = KeyEvent.ACTION_DOWN, ctrl: Boolean = true, shift: Boolean = false): KeyEvent {
        var meta = 0
        if (ctrl) meta = meta or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        if (shift) meta = meta or KeyEvent.META_SHIFT_ON
        return KeyEvent(0, 0, action, code, 0, meta)
    }

    @Test
    fun ctrlEOpensOnTheNoteAfterTheOpenOneAndLettingGoOfCtrlOpensTheChosenOne() {
        val switch = RecentSwitch()
        assertEquals(RecentSwitch.Outcome.Handled, switch.onKey(key(KeyEvent.KEYCODE_E), 4))
        assertTrue(switch.open)
        assertEquals(1, switch.index)
        // E again moves down, wrapping; Shift+E moves up.
        switch.onKey(key(KeyEvent.KEYCODE_E), 4)
        switch.onKey(key(KeyEvent.KEYCODE_E), 4)
        switch.onKey(key(KeyEvent.KEYCODE_E), 4)
        assertEquals(0, switch.index)
        switch.onKey(key(KeyEvent.KEYCODE_E, shift = true), 4)
        assertEquals(3, switch.index)
        // The E's key-up is taken too, so the note never gets a stray letter.
        assertEquals(RecentSwitch.Outcome.Handled, switch.onKey(key(KeyEvent.KEYCODE_E, KeyEvent.ACTION_UP), 4))
        assertEquals(RecentSwitch.Outcome.Choose(3), switch.onKey(key(KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.ACTION_UP, ctrl = false), 4))
        assertFalse(switch.open)
    }

    @Test
    fun theSwitcherClosesOnEscapeOpensOnEnterAndLeavesOtherKeysAloneWhenClosed() {
        val switch = RecentSwitch()
        assertEquals(RecentSwitch.Outcome.Ignored, switch.onKey(key(KeyEvent.KEYCODE_A, ctrl = false), 3))
        assertEquals(RecentSwitch.Outcome.Ignored, switch.onKey(key(KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.ACTION_UP, ctrl = false), 3))
        switch.onKey(key(KeyEvent.KEYCODE_E), 3)
        switch.onKey(key(KeyEvent.KEYCODE_ESCAPE, ctrl = false), 3)
        assertFalse(switch.open)
        switch.onKey(key(KeyEvent.KEYCODE_E), 3)
        switch.onKey(key(KeyEvent.KEYCODE_DPAD_DOWN, ctrl = false), 3)
        assertEquals(RecentSwitch.Outcome.Choose(2), switch.onKey(key(KeyEvent.KEYCODE_ENTER, ctrl = false), 3))
        // Ctrl+Shift+E while closed is the editor's Inline code (review S7): the page gets it, key-up too.
        assertEquals(RecentSwitch.Outcome.Ignored, switch.onKey(key(KeyEvent.KEYCODE_E, shift = true), 3))
        assertEquals(RecentSwitch.Outcome.Ignored, switch.onKey(key(KeyEvent.KEYCODE_E, KeyEvent.ACTION_UP, shift = true), 3))
        assertFalse(switch.open)
        // With one note it stays on it.
        switch.onKey(key(KeyEvent.KEYCODE_E), 1)
        assertEquals(0, switch.index)
    }

    @Test
    fun theOpenNoteComesFirstThenTheMostRecentlyUsed() {
        val notes = (1..12).map { NoteItem("n$it", "Note $it", "", "") }
        val listed = recentWithCurrent(notes, current = "n5")
        assertEquals(listOf("n5", "n1", "n2", "n3", "n4", "n6", "n7", "n8", "n9"), listed.map { it.id })
        assertEquals(notes.take(9), recentWithCurrent(notes, current = null))
    }

    @Test
    fun theSwitcherListsTheNotesWithTheChosenOneSelected() {
        val opened = mutableListOf<Int>()
        compose.setContent {
            PenmossTheme {
                RecentSwitcher(listOf(NoteItem("a", "Alpha", "", ""), NoteItem("b", "Beta", "", "")), index = 1, onOpen = { opened += it }, onDismiss = {})
            }
        }
        compose.onNodeWithText("Recent notes").assertIsDisplayed()
        compose.onNodeWithTag("recent-1").assertIsSelected()
        compose.onNodeWithText("Alpha").performClick()
        assertEquals(listOf(0), opened)
    }

    /** T53 item 2: searching turns a spinner beside the status, which moves nothing; the answer stops it. */
    @Test
    fun searchingShowsASpinnerBesideTheStatusUntilTheAnswer() {
        var view by mutableStateOf(SearchView(searching = true))
        compose.setContent { PenmossTheme { SearchScreen("garden", {}, view, onBack = {}, onOpen = {}) } }
        compose.onNodeWithTag("searchSpinner", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Searching…").assertIsDisplayed()
        view = answer(SearchResult("r", "Garden plan", "", ""))
        compose.waitForIdle()
        compose.onNodeWithTag("searchSpinner", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("Garden plan").assertIsDisplayed()
    }
}
