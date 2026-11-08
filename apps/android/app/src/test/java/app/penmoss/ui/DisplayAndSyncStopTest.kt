package app.penmoss.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.settings.DisplayKeys
import app.penmoss.engine.settings.Settings
import app.penmoss.sync.SyncStop
import app.penmoss.ui.screens.HomeScreen
import app.penmoss.ui.settings.DisplayScreen
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * T42's Display and "Sync stopped" on the phone (T40 ST12, AC12; A650, A651): Home hides the
 * shortcuts Settings → Display hides, with the web's synced keys, and a stopped sync's status
 * line leads to Sync and storage, which says why and offers what resolves it.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DisplayAndSyncStopTest {
    @get:Rule
    val compose = createComposeRule()

    private fun settings(vararg values: Pair<String, Boolean>) = Settings(JsonObject(values.associate { (key, value) -> key to JsonPrimitive(value) }))

    @Test
    fun homeHidesTheShortcutsDisplayHidesAndKeepsSearch() {
        var shortcuts by mutableStateOf(HomeShortcuts())
        val ran = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = emptyList(), folders = emptyList(), status = "", syncing = false,
                    onSearch = { ran += "search" }, onSettings = {}, onAllNotes = {}, onFolder = {}, onOpen = {},
                    onToday = { ran += "today" }, onThisWeek = { ran += "week" }, onNewNote = {},
                    onGraph = { ran += "graph" }, onCommands = { ran += "commands" },
                    shortcuts = shortcuts,
                )
            }
        }
        // One row of icons (T51, A932), each named: Search, Today, This Week, Graph, Commands.
        compose.onNodeWithTag("homeToday").assertContentDescriptionEquals("Today").performClick()
        compose.onNodeWithTag("homeThisWeek").assertContentDescriptionEquals("This Week").performClick()
        compose.onNodeWithTag("homeGraph").assertContentDescriptionEquals("Graph").performClick()
        // Commands is the web's palette: Search with every action listed (FD6).
        compose.onNodeWithTag("homeCommands").assertContentDescriptionEquals("Commands").performClick()
        compose.onNodeWithTag("homeSearch").performClick()
        assertEquals(listOf("today", "week", "graph", "commands", "search"), ran)
        // Graph and Commands left Home's ⋮ menu for the row.
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithText("Graph").assertDoesNotExist()
        compose.onNodeWithText("Commands").assertDoesNotExist()
        compose.onNodeWithText("Journal").performClick()

        shortcuts = HomeShortcuts.of(settings(DisplayKeys.TODAY to false, DisplayKeys.GRAPH to false, DisplayKeys.COMMANDS to false))
        compose.onNodeWithTag("homeToday").assertDoesNotExist()
        compose.onNodeWithTag("homeThisWeek").assertIsDisplayed()
        compose.onNodeWithTag("homeGraph").assertDoesNotExist()
        compose.onNodeWithTag("homeCommands").assertDoesNotExist()
        // Search has no switch: it always shows.
        shortcuts = HomeShortcuts.of(settings(DisplayKeys.TODAY to false, DisplayKeys.THIS_WEEK to false))
        compose.onNodeWithTag("homeThisWeek").assertDoesNotExist()
        compose.onNodeWithTag("syncStatus").assertExists()
        compose.onNodeWithTag("homeSearch").assertIsDisplayed().assertContentDescriptionEquals("Search")
    }

    @Test
    fun displayHasASwitchPerShortcutThatSendsTheWebsKeys() {
        var current by mutableStateOf(Settings())
        var enabled by mutableStateOf(false)
        val changes = mutableListOf<Pair<String, Boolean>>()
        compose.setContent {
            PenmossTheme {
                DisplayScreen(displayChoices(current), enabled, onChange = { key, shown -> changes += key to shown; current = current.with(key, JsonPrimitive(shown)) }, onBack = {})
            }
        }
        // Before the first sync has sent the settings, nothing can change, and it says why.
        compose.onNodeWithTag("settingsNotice").assertIsDisplayed()
        compose.onNodeWithTag("display-${DisplayKeys.TODAY}").assertIsNotEnabled()
        enabled = true
        val today = compose.onNodeWithTag("display-${DisplayKeys.TODAY}")
        today.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch))
        today.assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.On))
        today.performClick()
        compose.onNodeWithTag("display-${DisplayKeys.TODAY}").assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.Off))
        // Shown again is stored as true, as the web stores it.
        compose.onNodeWithTag("display-${DisplayKeys.TODAY}").performClick()
        compose.onNodeWithTag("display-${DisplayKeys.COMMANDS}").performClick()
        assertEquals(listOf(DisplayKeys.TODAY to false, DisplayKeys.TODAY to true, DisplayKeys.COMMANDS to false), changes)
        assertEquals(listOf("Today", "This Week", "Graph", "Commands"), displayChoices(Settings()).map { it.label })
    }

    /** Recent Notes' − and + say what they change (T53 pass), and the notebook names switch is A984's. */
    @Test
    fun theRecentCountsButtonsAreNamedAndStepTheCount() {
        val counts = mutableListOf<Int>()
        compose.setContent {
            PenmossTheme {
                DisplayScreen(displayChoices(Settings()), enabled = true, onChange = { _, _ -> }, onBack = {}, layout = HomeLayout(recentCount = 10), onRecentCount = { counts += it })
            }
        }
        compose.onNodeWithTag("recentFewer").performScrollTo().assertContentDescriptionEquals("Fewer Notes in Recent Notes").performClick()
        compose.onNodeWithTag("recentMore").assertContentDescriptionEquals("More Notes in Recent Notes").performClick()
        assertEquals(listOf(9, 11), counts)
        // A984's and the web's words for Quick Access's notebook names.
        compose.onNodeWithTag("display-quickAccessNotebook").performScrollTo()
        compose.onNodeWithText("Show Notebook Names in Quick Access").assertExists()
    }

    @Test
    fun theSettingsHomeSaysWhatDisplayHides() {
        assertEquals("Every shortcut on Home", displaySummary(Settings()))
        assertEquals("Hidden: This Week, Graph", displaySummary(settings(DisplayKeys.THIS_WEEK to false, DisplayKeys.GRAPH to false, DisplayKeys.TODAY to true)))
        // Right after Appearance, as on the web; then Symbols (T44, A747), then Git notebooks, as
        // on the Mac (T50 G7, A856).
        val ids = settingsSections(Settings(), "Penmoss", "", 0).map { it.id }
        assertEquals(listOf("appearance", "display", "symbols", "git", "daily"), ids.take(5))
        // Appearance first, and About last (T49).
        assertEquals("about", ids.last())
    }

    @Test
    fun aStoppedSyncsStatusLineLeadsToWhatResolvesIt() {
        var stopped by mutableStateOf(false)
        var status by mutableStateOf("Synced at 3:42 PM")
        var opened = 0
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = emptyList(), folders = emptyList(), status = status, syncing = false,
                    onSearch = {}, onSettings = {}, onAllNotes = {}, onFolder = {}, onOpen = {}, onToday = {}, onNewNote = {},
                    stopped = stopped, onStatus = { opened++ },
                )
            }
        }
        // The status line is now a dot on the personal notes' title (T51, A933): a tap says its words.
        compose.onNodeWithTag("syncDot").assertContentDescriptionEquals("Synced at 3:42 PM").performClick()
        compose.onNodeWithTag("syncDotTip").assertTextEquals("Synced at 3:42 PM")
        assertEquals(0, opened)
        status = stoppedLine(SyncStop.Notes(mapOf("a" to "Read-only")))
        stopped = true
        // Still said at once, from above the list, and the dot still leads to what resolves it.
        compose.onNodeWithTag("syncStatus")
            .assertContentDescriptionEquals("Sync stopped: 1 note could not sync")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
        compose.onNodeWithTag("syncDot")
            .assertContentDescriptionEquals("Sync stopped: 1 note could not sync")
            .assertHasClickAction()
            .performClick()
        assertEquals(1, opened)
    }

    @Test
    fun eachStopIsSaidInPlainWords() {
        assertEquals("Sync stopped: 1 note could not sync", stoppedLine(SyncStop.Notes(mapOf("a" to "Read-only"))))
        assertEquals("Sync stopped: 2 notes could not sync", stoppedLine(SyncStop.Notes(mapOf("a" to "Read-only", "b" to "Invalid base64"))))
        assertEquals("Sync stopped: this phone’s storage is full or failing", stoppedLine(SyncStop.Storage("")))
    }
}
