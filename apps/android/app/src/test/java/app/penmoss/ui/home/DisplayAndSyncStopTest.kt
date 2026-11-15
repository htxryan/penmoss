package app.penmoss.ui.home

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
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.HomeLayout
import app.penmoss.ui.settings.HomeShortcuts
import app.penmoss.ui.settings.displayChoices
import app.penmoss.ui.settings.displaySummary
import app.penmoss.ui.settings.settingsGroups
import androidx.compose.ui.test.performTouchInput

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
                    HomeUi(
                        recent = emptyList(),
                        folders = emptyList(),
                        status = "",
                        syncing = false,
                        shortcuts = shortcuts,
                    ),
                    HomeActions(
                        onSearch = { ran += "search" },
                        onToday = { ran += "today" },
                        onThisWeek = { ran += "week" },
                        onGraph = { ran += "graph" },
                        onCommands = { ran += "commands" },
                        onTags = { ran += "tags" },
                    ),
                )
            }
        }
        // One row of icons (T51, A932), each named: Search, Tags (A1438), Today, This Week, Graph, Commands.
        compose.onNodeWithTag("homeTagsShortcut").assertContentDescriptionEquals("Tags").performClick()
        compose.onNodeWithTag("homeToday").assertContentDescriptionEquals("Today").performClick()
        compose.onNodeWithTag("homeThisWeek").assertContentDescriptionEquals("This Week").performClick()
        compose.onNodeWithTag("homeGraph").assertContentDescriptionEquals("Graph").performClick()
        // Commands is the web's palette: Search with every action listed (FD6).
        compose.onNodeWithTag("homeCommands").assertContentDescriptionEquals("Commands").performClick()
        compose.onNodeWithTag("homeSearch").performClick()
        assertEquals(listOf("tags", "today", "week", "graph", "commands", "search"), ran)
        // Graph and Commands left Home's ⋮ menu for the row.
        compose.onNodeWithTag("homeMore").performClick()
        compose.onNodeWithText("Graph").assertDoesNotExist()
        compose.onNodeWithText("Commands").assertDoesNotExist()
        compose.onNodeWithText("Journal").performClick()

        shortcuts = HomeShortcuts.of(settings(DisplayKeys.TODAY to false, DisplayKeys.GRAPH to false, DisplayKeys.COMMANDS to false, DisplayKeys.TAGS to false))
        compose.onNodeWithTag("homeTagsShortcut").assertDoesNotExist()
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
        // Under the large top app bar (A1560), below the screen's fold.
        compose.onNodeWithTag("display-${DisplayKeys.COMMANDS}").performScrollTo().performClick()
        assertEquals(listOf(DisplayKeys.TODAY to false, DisplayKeys.TODAY to true, DisplayKeys.COMMANDS to false), changes)
        assertEquals(listOf("Tags", "Today", "This Week", "Graph", "Commands"), displayChoices(Settings()).map { it.label })
        // Android's Home has only what Home has (PEN-146): no "on the web and the Mac" words or rows.
        compose.onNodeWithText("on the web and the Mac", substring = true).assertDoesNotExist()
        compose.onNodeWithTag("display-section-calendar").assertDoesNotExist()
        compose.onNodeWithTag("display-section-tags").assertDoesNotExist()
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
        compose.onNodeWithText("Show Notebook Names").assertExists()
        compose.onNodeWithText("Shows 10").assertExists()
    }

    @Test
    fun theSettingsListSaysWhatHomeHides() {
        assertEquals("Every shortcut on Home", displaySummary(Settings()))
        assertEquals("Hidden: This Week, Graph", displaySummary(settings(DisplayKeys.THIS_WEEK to false, DisplayKeys.GRAPH to false, DisplayKeys.TODAY to true)))
        assertEquals("Hidden: Tags", displaySummary(settings(DisplayKeys.TAGS to false)))
        // Look and Feel: Appearance, Home, Symbols (PEN-146).
        assertEquals(listOf("appearance", "home", "symbols"), settingsGroups(Settings(), "Penmoss").first().sections.map { it.id })
    }

    /** PEN-146: Home's sections move by dragging their handle, or by TalkBack's Move Up and Move Down. */
    @Test
    fun homesSectionsMoveByDragAndByTheirActions() {
        val orders = mutableListOf<List<String>>()
        val hidden = mutableListOf<Pair<String, Boolean>>()
        compose.setContent {
            PenmossTheme {
                DisplayScreen(
                    displayChoices(Settings()), enabled = true, onChange = { _, _ -> }, onBack = {},
                    layout = HomeLayout(),
                    onSectionOrder = { orders += it },
                    onSectionHidden = { section, hide -> hidden += section to hide },
                )
            }
        }
        // The default order on Home: Quick Access, Recent Notes, Notebooks.
        compose.onNodeWithTag("display-section-recent").performScrollTo()
        compose.onNodeWithTag("drag-quickAccess", useUnmergedTree = true).performScrollTo().performTouchInput {
            down(center)
            moveBy(androidx.compose.ui.geometry.Offset(0f, 20f))
            moveBy(androidx.compose.ui.geometry.Offset(0f, 2_000f))
            up()
        }
        assertEquals(listOf("recent", "notebooks", "quickAccess"), orders.last())
        compose.onNodeWithTag("display-section-notebooks").performScrollTo().performClick()
        assertEquals(listOf("notebooks" to true), hidden)
        // The Mac's Calendar and Tags keep their places among the sections.
        assertEquals(
            listOf("recent", "notebooks", "calendar", "quickAccess", "tags"),
            app.penmoss.ui.settings.withHomeOrder(listOf("quickAccess", "recent", "calendar", "notebooks", "tags"), listOf("recent", "notebooks", "quickAccess")),
        )
        assertEquals(1, app.penmoss.ui.settings.dropIndex(0, 130f, listOf(100, 100, 100)))
        assertEquals(2, app.penmoss.ui.settings.dropIndex(0, 160f, listOf(100, 100, 100)))
        assertEquals(0, app.penmoss.ui.settings.dropIndex(2, -160f, listOf(100, 100, 100)))
        assertEquals(1, app.penmoss.ui.settings.dropIndex(1, 40f, listOf(100, 100, 100)))
    }

    @Test
    fun aStoppedSyncsStatusLineLeadsToWhatResolvesIt() {
        var stopped by mutableStateOf(false)
        var status by mutableStateOf("Synced at 3:42 PM")
        var opened = 0
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    HomeUi(
                        recent = emptyList(),
                        folders = emptyList(),
                        status = status,
                        syncing = false,
                        stopped = stopped,
                    ),
                    HomeActions(
                        onStatus = { opened++ },
                    ),
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
