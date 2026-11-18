package app.penmoss.ui.settings

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.filter
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.onChildren
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.NotebookGraph
import app.penmoss.security.SecretBox
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.SettingLimits
import app.penmoss.engine.settings.Settings
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.stopMainScope
import app.penmoss.ui.settings.AppearanceScreen
import app.penmoss.ui.settings.DailyNotesScreen
import app.penmoss.ui.settings.QuickCaptureScreen
import app.penmoss.ui.settings.SETTINGS_WAIT
import app.penmoss.ui.settings.SettingsHome
import app.penmoss.ui.settings.TemplateField
import app.penmoss.ui.settings.TimeZonePicker
import app.penmoss.ui.settings.matchingZones
import app.penmoss.ui.settings.regionTimeZones
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.onRoot
import org.robolectric.annotation.Config
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import app.penmoss.ui.common.PenmossTheme

/** Settings on the phone (T40 P1; PEN-146): the list's groups and search, Appearance, Daily Notes and Quick Capture. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val cards = ThemeCatalogue.bundled.builtIns.map { themeCard(it, custom = false) }

    /** PEN-146: five captioned groups, each row with what it holds now (A415), the version once. */
    @Test
    fun theHomeListsEveryGroupWithWhatEachRowHoldsNow() {
        val opened = mutableListOf<String>()
        val settings = Settings(JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive("dark"), SettingKeys.CAPTURE to JsonPrimitive("inbox"))))
        val notebooks = listOf(
            NotebookEntry("n1", "Personal", primary = true, status = "Synced at 4:12 PM", dot = app.penmoss.ui.common.DotState.SYNCED),
            NotebookEntry("n2", "Quanta", primary = false, status = "Synced at 4:09 PM", dot = app.penmoss.ui.common.DotState.OFFLINE),
        )
        compose.setContent {
            PenmossTheme {
                SettingsHome(
                    settingsGroups(settings, "Nord", notebooks = notebooks, storage = "79 MB", github = "htxryan", version = "0.9.3"),
                    onOpen = { opened += it },
                    onBack = {},
                )
            }
        }
        val list = compose.onNodeWithTag("settingsSections")
        compose.onNodeWithText("Look and Feel").assertIsDisplayed()
        compose.onNodeWithText("Nord · Dark").assertIsDisplayed()
        compose.onNodeWithText("Every shortcut on Home").assertIsDisplayed()
        compose.onNodeWithText("★ ? ! 💡 →").assertIsDisplayed()
        compose.onNodeWithTag("section-appearance").performClick()
        compose.onNodeWithTag("section-home").performClick()
        compose.onNodeWithTag("section-symbols").performClick()
        list.performScrollToNode(hasText("Writing"))
        list.performScrollToNode(hasText("America/Chicago"))
        list.performScrollToNode(hasText("New Note in Inbox"))
        list.performScrollToNode(hasText("For a hardware keyboard"))
        compose.onNodeWithTag("section-shortcuts").performClick()
        // Each notebook with its dot, the primary first, then All Notebooks.
        list.performScrollToNode(hasText("Primary · synced at 4:12 PM"))
        compose.onNodeWithTag("section-notebook-n1").performClick()
        list.performScrollToNode(hasText("Add, Primary Notebook, Between Notebooks"))
        compose.onNodeWithTag("section-git").performClick()
        list.performScrollToNode(hasText("What agents changed, with Undo"))
        compose.onNodeWithTag("section-agent-activity").performClick()
        list.performScrollToNode(hasText("79 MB"))
        list.performScrollToNode(hasText("htxryan"))
        compose.onNodeWithTag("section-github").performClick()
        // The version once, on What's New; About and Sync and Storage are gone.
        list.performScrollToNode(hasText("0.9.3"))
        assertEquals(1, compose.onAllNodesWithText("0.9.3", substring = true).fetchSemanticsNodes().size)
        for (gone in listOf("about", "sync", "display")) compose.onNodeWithTag("section-$gone").assertDoesNotExist()
        assertEquals(
            listOf(
                SettingsRoutes.APPEARANCE, SettingsRoutes.DISPLAY, SettingsRoutes.SYMBOLS, app.penmoss.ui.keys.CommandRoutes.SHORTCUTS,
                "settings/git/n1", app.penmoss.ui.keys.CommandRoutes.GIT_NOTEBOOKS, SettingsRoutes.AGENT_ACTIVITY, SettingsRoutes.GITHUB,
            ),
            opened,
        )
    }

    @Test
    fun theGroupsAreTheFiveOfTheDesignInOrder() {
        val groups = settingsGroups(Settings(), "Penmoss")
        assertEquals(listOf("Look and Feel", "Writing", "Notebooks", "Agents", "This Phone"), groups.map { it.title })
        assertEquals(listOf("appearance", "home", "symbols"), groups[0].sections.map { it.id })
        assertEquals(listOf("daily", "capture", "shortcuts"), groups[1].sections.map { it.id })
        assertEquals(listOf("git"), groups[2].sections.map { it.id })
        assertEquals(listOf("agent-activity"), groups[3].sections.map { it.id })
        assertEquals(listOf("storage", "github", "whatsnew"), groups[4].sections.map { it.id })
    }

    /** PEN-146: Search Settings finds a setting by its label, its help or another word, and opens its screen. */
    @Test
    fun searchSettingsFindsASettingAndOpensItsScreen() {
        val opened = mutableListOf<String>()
        compose.setContent { PenmossTheme { SettingsHome(settingsGroups(Settings(), "Penmoss"), onOpen = { opened += it }, onBack = {}) } }
        compose.onNodeWithTag("settingsSearch").performTextInput("dark")
        compose.onNodeWithTag("found-mode").assertIsDisplayed().performClick()
        assertEquals(listOf(SettingsRoutes.APPEARANCE), opened)
        compose.onNodeWithTag("section-appearance").assertDoesNotExist()
        compose.onNodeWithTag("settingsSearch").performTextReplacement("zzzz")
        compose.onNodeWithTag("settingsSearchNone").assertIsDisplayed()
        compose.onNodeWithTag("settingsSearch").performTextReplacement("")
        compose.onNodeWithTag("section-appearance").assertIsDisplayed()
    }

    @Test
    fun theSearchMatchesEveryWordAndPutsLabelsFirst() {
        assertEquals("time-zone", searchSettings(SETTINGS_INDEX, "zone").first().id)
        assertTrue(searchSettings(SETTINGS_INDEX, "personal access token").any { it.id == "github-token" })
        assertTrue(searchSettings(SETTINGS_INDEX, "token").first().label.contains("Token"))
        assertEquals(emptyList<SettingEntry>(), searchSettings(SETTINGS_INDEX, "   "))
        assertTrue(searchSettings(SETTINGS_INDEX, "hotkey").any { it.route == app.penmoss.ui.keys.CommandRoutes.SHORTCUTS })
        // Every id is unique, and every route is one of Settings' own.
        assertEquals(SETTINGS_INDEX.size, SETTINGS_INDEX.map { it.id }.toSet().size)
        assertTrue(SETTINGS_INDEX.all { it.route.startsWith("settings") })
    }

    /** T39 pass 3 (A902): one icon per screen row, each its own. */
    @Test
    fun eachSectionHasItsOwnIconAsOnTheWeb() {
        val sections = settingsGroups(Settings(), "Penmoss").flatMap { it.sections }
        val icon = sections.associate { it.id to it.icon }
        assertEquals(app.penmoss.ui.settings.SettingsIcons.Terminal, icon["git"])
        assertEquals(sections.size, sections.map { it.icon }.toSet().size)
    }

    @Test
    fun theModeButtonsChooseAndSayWhatEachMeans() {
        var mode by mutableStateOf("system")
        compose.setContent {
            PenmossTheme {
                AppearanceScreen(mode, systemDark = true, themes = cards, chosen = "penmoss", fullWidth = false, editorWidth = 52, enabled = true, onMode = { mode = it }, onTheme = {}, onFullWidth = {}, onBack = {})
            }
        }
        compose.onNodeWithTag("mode-system").assertIsSelected()
        compose.onNodeWithText("System follows this phone’s setting: dark right now.").assertIsDisplayed()
        compose.onNodeWithTag("mode-light").performClick()
        assertEquals("light", mode)
        compose.onNodeWithTag("mode-light").assertIsSelected()
        compose.onNodeWithTag("mode-system").assertIsNotSelected()
        compose.onNodeWithText("Always light, whatever the phone’s setting.").assertIsDisplayed()
    }

    /** PEN-156, A1605: the phone marks Appearance's Theme group, kept for the phones apart from the Macs. */
    @Test
    fun theThemeCarriesTheLaptopMarkAndSaysItIsKeptOnThisPhone() {
        compose.setContent {
            PenmossTheme {
                AppearanceScreen("system", systemDark = false, themes = cards, chosen = "penmoss", fullWidth = false, editorWidth = 52, enabled = true, onMode = {}, onTheme = {}, onFullWidth = {}, onBack = {})
            }
        }
        // Unmerged, as BetweenNotebooksScreenTest finds the laptop: the mark is inside its row's semantics.
        compose.onAllNodesWithTag("deviceOnly", useUnmergedTree = true).onFirst().assertContentDescriptionEquals(app.penmoss.ui.settings.DEVICE_ONLY_GROUP_TIP)
        // The phone mark (the phones apart from the Macs, A1605) is the keyboard shortcuts' alone.
        compose.onAllNodesWithTag("platformOnly", useUnmergedTree = true).assertCountEquals(0)
    }

    /** A1582, A1619: on the Preview tab, the interface's text at its real size, labelled, and the note's font and size. */
    @Test
    fun appearanceShowsTheFontsAtTheirRealSizeAndFollowsAChange() {
        var fonts by mutableStateOf(FontsUi("theme", "theme", 16, {}, {}, {}))
        compose.setContent {
            PenmossTheme {
                AppearanceScreen(
                    "system", systemDark = false, themes = cards, chosen = "penmoss", fullWidth = false, editorWidth = 52,
                    enabled = true, onMode = {}, onTheme = {}, onFullWidth = {}, onBack = {}, fonts = fonts,
                )
            }
        }
        // On the Preview tab, under the preview (A1619).
        compose.onNodeWithTag("fontsAtSize").assertDoesNotExist()
        compose.onNodeWithTag("appearancePreviewTab").performClick()
        compose.onNodeWithTag("fontsAtSize").assertIsDisplayed()
        compose.onNodeWithText("Setting · Theme Default · 16 sp").assertExists()
        compose.onNodeWithText("Page Title · Theme Default · 24 sp").assertExists()
        compose.onNodeWithText("Note · Theme Default · 16 px: the note in the preview is at its real size.").assertExists()
        fonts = FontsUi("serif", "mono", 20, {}, {}, {})
        compose.onNodeWithText("Setting · Serif · 16 sp").assertExists()
        compose.onNodeWithText("Note · Monospace · 20 px: the note in the preview is at its real size.").assertExists()
    }

    /** A1564: the preview is the app itself (Home's own shortcut row and the note page), inert. */
    @Test
    fun thePreviewIsItsOwnTabTheAppItselfAndTakesNoTouchOrFocus() {
        var touched = false
        compose.setContent {
            PenmossTheme {
                AppearanceScreen(
                    "system", systemDark = false, themes = cards, chosen = "penmoss", fullWidth = false, editorWidth = 52,
                    enabled = true, onMode = {}, onTheme = {}, onFullWidth = {}, onBack = {},
                    notePreview = { modifier -> Box(modifier.clickable { touched = true }.testTag("previewNote")) },
                    homeShortcuts = HomeShortcuts(graph = false),
                )
            }
        }
        // A1619 (option 3): Settings first, with only the controls; the preview is on its own tab.
        compose.onNodeWithTag("appearanceSettingsTab").assertIsSelected()
        compose.onNodeWithTag("appearancePreviewApp").assertDoesNotExist()
        compose.onNodeWithTag("themeGrid").assertExists()
        compose.onNodeWithTag("appearancePreviewTab").performClick()
        compose.onNodeWithTag("appearancePreviewApp").assertIsDisplayed()
        compose.onNodeWithTag("themeGrid").assertDoesNotExist()
        compose.onNodeWithTag("appearancePreviewCaption").assertTextEquals("Penmoss, light, as the app draws it. Change it on Settings.")
        // Its buttons and its note are drawn but out of reach: TalkBack and a test find none.
        compose.onNodeWithTag("homeShortcuts").assertDoesNotExist()
        compose.onNodeWithTag("homeSearch").assertDoesNotExist()
        compose.onNodeWithTag("previewNote").assertDoesNotExist()
        compose.onNodeWithTag("appearancePreviewApp").performTouchInput { click(center) }
        compose.waitForIdle()
        assertFalse(touched)
        compose.onNodeWithTag("appearanceSettingsTab").performClick()
        compose.onNodeWithTag("themeGrid").assertExists()
    }

    @Test
    // A phone's height: the tabs hold still and the Settings tab scrolls under them (A1619).
    @org.robolectric.annotation.Config(qualifiers = "w411dp-h900dp")
    fun theThemeGridShowsEveryBuiltInAndChoosesOne() {
        var chosen by mutableStateOf("penmoss")
        var full by mutableStateOf(false)
        compose.setContent {
            PenmossTheme {
                AppearanceScreen("system", systemDark = false, themes = cards, chosen = chosen, fullWidth = full, editorWidth = 52, enabled = true, onMode = {}, onTheme = { chosen = it }, onFullWidth = { full = it }, onBack = {})
            }
        }
        for (id in listOf("penmoss", "paper", "slate", "nord", "solarized", "gruvbox", "rose-pine", "high-contrast")) {
            compose.onNodeWithTag("theme-$id").performScrollTo().assertIsDisplayed()
        }
        compose.onNodeWithTag("theme-penmoss").performScrollTo().assertIsSelected()
        compose.onNodeWithTag("theme-nord").performScrollTo().performClick()
        assertEquals("nord", chosen)
        compose.onNodeWithTag("theme-nord").assertIsSelected()
        compose.onNodeWithTag("theme-penmoss").assertIsNotSelected()
        // Note width: the theme's, or the whole screen (ST11).
        compose.onNodeWithText("The Theme’s Width").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("appearanceTabs").assertExists()
        compose.onNodeWithTag("width-full").performScrollTo().performClick()
        assertTrue(full)
        compose.onNodeWithTag("width-full").assertIsSelected()
    }

    @Test
    fun beforeTheServerSendsSettingsNothingCanBeChangedAndTheScreenSaysWhy() {
        compose.setContent {
            PenmossTheme {
                AppearanceScreen("system", systemDark = false, themes = cards, chosen = "penmoss", fullWidth = false, editorWidth = 52, enabled = false, onMode = {}, onTheme = {}, onFullWidth = {}, onBack = {})
            }
        }
        compose.onNodeWithText(SETTINGS_WAIT).assertIsDisplayed()
        compose.onNodeWithTag("mode-dark").assertIsNotEnabled()
        compose.onNodeWithTag("theme-nord").performScrollTo().assertIsNotEnabled()
    }

    /** PEN-146 option B: the template saves itself once typing rests, says Saved, and Use the Default removes it. */
    @Test
    fun aTemplateSavesAsYouTypeAndUseTheDefaultRemovesIt() {
        val saved = mutableListOf<Pair<String, String?>>()
        var daily by mutableStateOf(TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily Template", "## Plan\n\n## Notes\n", custom = false))
        compose.setContent {
            PenmossTheme {
                DailyNotesScreen(
                    timeZone = "America/Chicago",
                    today = java.time.LocalDate.of(2026, 11, 15),
                    templates = listOf(daily, TemplateField(SettingKeys.WEEKLY_TEMPLATE, "Weekly Template", "## Goals\n", custom = false)),
                    enabled = true,
                    onTimeZone = {},
                    onSave = { key, value ->
                        saved += key to value
                        if (key == SettingKeys.DAILY_TEMPLATE) daily = daily.copy(saved = value ?: "## Plan\n\n## Notes\n", custom = value != null)
                    },
                    onBack = {},
                    phoneZone = "Europe/London",
                )
            }
        }
        compose.onNodeWithText("America/Chicago · today is Sunday 15 November").assertIsDisplayed()
        compose.onNodeWithTag("dailyUsePhoneZone").assertIsDisplayed()
        // Nothing custom: Use the Default does nothing yet.
        compose.onNodeWithTag("reset-template.daily").performScrollTo().assertIsNotEnabled()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("template-template.daily").performTextReplacement("# {{longDate}}\n## Plan\n")
        // Not until typing rests.
        compose.mainClock.advanceTimeBy(TEMPLATE_SAVE_MS / 2)
        assertTrue(saved.isEmpty())
        compose.mainClock.advanceTimeBy(TEMPLATE_SAVE_MS)
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertEquals(listOf(SettingKeys.DAILY_TEMPLATE to "# {{longDate}}\n## Plan\n"), saved)
        compose.onNodeWithTag("templateStatus", useUnmergedTree = true).assertTextEquals("✓ Saved")
        // Preview: today's note, as the template makes it, drawn (A1612), in place of the field.
        compose.onNodeWithTag("templatePreviewTab").performScrollTo().performClick()
        compose.onNodeWithTag("template-template.daily").assertDoesNotExist()
        compose.onNodeWithText("Sunday 15 November 2026").assertIsDisplayed()
        compose.onNodeWithText("Plan").assertIsDisplayed()
        compose.onNodeWithText("# Sunday 15 November 2026", substring = true).assertDoesNotExist()
        compose.onNodeWithTag("templateWriteTab").performScrollTo().performClick()
        compose.onNodeWithTag("reset-template.daily").performScrollTo().assertIsEnabled().performClick()
        assertEquals(SettingKeys.DAILY_TEMPLATE to null, saved.last())
        compose.onNodeWithText("Back to the default").assertIsDisplayed()
        // The weekly template is the other tab, over the same editor.
        compose.onNodeWithTag("tab-template.weekly").performClick()
        compose.onNodeWithTag("template-template.weekly").assertExists()
        compose.onNodeWithTag("template-template.daily").assertDoesNotExist()
    }

    @Test
    fun aPlaceholderGoesInAtTheCursor() {
        val saved = mutableListOf<Pair<String, String?>>()
        compose.setContent {
            PenmossTheme {
                DailyNotesScreen(
                    timeZone = "UTC",
                    today = java.time.LocalDate.of(2026, 10, 21),
                    templates = listOf(TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily Template", "", custom = false)),
                    enabled = true,
                    onTimeZone = {},
                    onSave = { key, value -> saved += key to value },
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("placeholder-template.daily").performScrollTo().performClick()
        compose.onNodeWithTag("insert-{{weekday}}").performClick()
        compose.waitUntil(3_000) { saved.isNotEmpty() }
        assertEquals(SettingKeys.DAILY_TEMPLATE to "{{weekday}}", saved.last())
        compose.onNodeWithTag("templatePreviewTab").performScrollTo().performClick()
        compose.onNodeWithText("Wednesday").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "w411dp-h914dp")
    fun theTemplateFillsThePagesSpareHeightAndThePageHoldsStill() {
        compose.setContent {
            PenmossTheme {
                DailyNotesScreen(
                    timeZone = "UTC",
                    today = java.time.LocalDate.of(2026, 10, 21),
                    templates = listOf(TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily Template", "## Plan\n", custom = false)),
                    enabled = true,
                    onTimeZone = {},
                    onSave = { _, _ -> },
                    onBack = {},
                    notebook = "Personal",
                )
            }
        }
        val root = compose.onRoot().getUnclippedBoundsInRoot()
        val field = compose.onNodeWithTag("template-template.daily").getUnclippedBoundsInRoot()
        val help = compose.onNodeWithText("These belong to Personal", substring = true).assertIsDisplayed().getUnclippedBoundsInRoot()
        // The field takes what the rest leave: tall, and the help still on the page under it.
        assertTrue("field ${field.height}", field.height > 300.dp)
        assertTrue(help.bottom <= root.bottom)
        assertTrue(help.top > field.bottom)
        // Preview takes the same frame.
        compose.onNodeWithTag("templatePreviewTab").performScrollTo().performClick()
        val preview = compose.onNodeWithTag("templatePreview").getUnclippedBoundsInRoot()
        assertTrue("preview ${preview.height}", preview.height > 300.dp)
    }

    @Test
    fun aTemplateFillsAsCoresFillTemplateDoes() {
        val day = java.time.LocalDate.of(2026, 10, 21)
        assertEquals(
            "2026-10-21 Wednesday 21 October 2026 Wednesday 2026-W43 2026 10 {{other}}",
            fillTemplate("{{date}} {{longDate}} {{weekday}} {{week}} {{year}} {{month}} {{other}}", weekly = false, date = day),
        )
        // A week's from its Monday; its year is the ISO week's.
        assertEquals("2026-10-19 2026-W43", fillTemplate("{{date}} {{ week }}", weekly = true, date = day))
        assertEquals("2026-W53 2026", fillTemplate("{{week}} {{year}}", weekly = true, date = java.time.LocalDate.of(2027, 1, 1)))
    }

    @Test
    fun theTimeZoneSearchFindsZonesByAnyWordAndOffersThePhonesOwn() {
        val picked = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                TimeZonePicker(current = "America/Chicago", phoneZone = "Europe/London", zones = regionTimeZones(), onPick = { picked += it }, onBack = {})
            }
        }
        compose.onNodeWithTag("zone-America/Chicago").assertIsSelected()
        compose.onNodeWithTag("usePhoneZone").performClick()
        assertEquals(listOf("Europe/London"), picked)
        compose.onNodeWithTag("zoneSearch").performTextInput("new york")
        compose.onNodeWithTag("zone-America/New_York").assertIsDisplayed().performClick()
        compose.onNodeWithTag("zone-America/Chicago").assertDoesNotExist()
        compose.onNodeWithTag("usePhoneZone").assertDoesNotExist()
        assertEquals(listOf("Europe/London", "America/New_York"), picked)
    }

    @Test
    fun theZoneListIsTheRegionZonesAndUtc() {
        val zones = regionTimeZones(setOf("America/Chicago", "Asia/Tokyo", "SystemV/AST4", "EST5EDT", "Etc/GMT+1", "UTC", "Europe/London"))
        assertEquals(listOf("America/Chicago", "Asia/Tokyo", "Europe/London", "UTC"), zones)
        assertEquals(listOf("Asia/Tokyo"), matchingZones(zones, " tok "))
        assertEquals(listOf("America/Chicago"), matchingZones(zones, "america chi"))
        assertTrue(regionTimeZones().containsAll(listOf("America/Chicago", "Australia/Lord_Howe", "UTC")))
    }

    @Test
    fun quickCaptureChoosesWhereCapturesGoAndNamesTheNotebook() {
        var destination by mutableStateOf("daily")
        var notebooks = 0
        compose.setContent {
            PenmossTheme { QuickCaptureScreen(destination, enabled = true, onChoose = { destination = it }, onBack = {}, notebook = "Personal", onNotebook = { notebooks++ }) }
        }
        compose.onNodeWithText("Saves To").assertIsDisplayed()
        compose.onNodeWithTag("capture-daily").assertIsSelected()
        compose.onNodeWithTag("capture-inbox").performClick()
        assertEquals("inbox", destination)
        compose.onNodeWithTag("capture-inbox").assertIsSelected()
        compose.onNodeWithText("Your primary notebook · change it on All Notebooks").assertIsDisplayed()
        compose.onNodeWithTag("captureNotebook").performClick()
        assertEquals(1, notebooks)
    }

    private fun await(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) {
            while (!condition()) {
                compose.waitForIdle()
                delay(10)
            }
        }
    }

    @Test
    fun aTemplateOverTheLimitIsCountedAndNeverSaved() {
        val saved = mutableListOf<Pair<String, String?>>()
        compose.setContent {
            PenmossTheme {
                DailyNotesScreen(
                    timeZone = "America/Chicago",
                    today = java.time.LocalDate.of(2026, 10, 24),
                    templates = listOf(TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily Template", "## Plan\n", custom = false)),
                    enabled = true,
                    onTimeZone = {},
                    onSave = { key, value -> saved += key to value },
                    onBack = {},
                )
            }
        }
        val field = compose.onNodeWithTag("template-${SettingKeys.DAILY_TEMPLATE}")
        compose.onNodeWithTag("count-${SettingKeys.DAILY_TEMPLATE}", useUnmergedTree = true).assertTextEquals("8 / 10,000")
        // One character over the limit (A410): said, and nothing is saved.
        field.performTextReplacement("x".repeat(SettingLimits.TEMPLATE_MAX_CHARS + 1))
        compose.onNodeWithTag("count-${SettingKeys.DAILY_TEMPLATE}", useUnmergedTree = true)
            .assertTextEquals("Too long: at most 10,000 characters (10,001 now)")
        compose.mainClock.advanceTimeBy(TEMPLATE_SAVE_MS * 2)
        assertTrue(saved.isEmpty())
        // At the limit it saves.
        field.performTextReplacement("x".repeat(SettingLimits.TEMPLATE_MAX_CHARS))
        compose.waitUntil(3_000) { saved.isNotEmpty() }
        assertEquals(listOf(SettingKeys.DAILY_TEMPLATE to "x".repeat(SettingLimits.TEMPLATE_MAX_CHARS)), saved)
    }

    @Test
    fun aRefusedChangeIsSaidOnTheHomeUntilDismissed() {
        var refusal by mutableStateOf<String?>(
            refusalText(NoteStore.SettingsRefusal(listOf(SettingKeys.DAILY_TEMPLATE), "The request body is too large")),
        )
        compose.setContent {
            PenmossTheme {
                SettingsHome(
                    settingsGroups(Settings(), "Penmoss"),
                    onOpen = {},
                    onBack = {},
                    refusal = refusal,
                    onDismissRefusal = { refusal = null },
                )
            }
        }
        compose.onNodeWithText("Penmoss didn’t take your change to Daily template, so it was undone: The request body is too large.")
            .assertIsDisplayed()
        compose.onNodeWithTag("dismissRefused").performClick()
        compose.onNodeWithTag("settingsRefused").assertDoesNotExist()
    }

    @Test
    fun rowsThatOpenAScreenAreButtonsNotUnselectedChoices() {
        compose.setContent {
            PenmossTheme {
                Column {
                    SettingsHome(settingsGroups(Settings(), "Penmoss"), onOpen = {}, onBack = {})
                }
            }
        }
        compose.onNodeWithTag("section-appearance")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Selected))
    }

    @Test
    fun useThisPhonesZoneIsAButtonOutsideTheListOfZones() {
        compose.setContent {
            PenmossTheme {
                TimeZonePicker(current = "America/Chicago", phoneZone = "Europe/London", zones = listOf("America/Chicago", "Europe/London"), onPick = {}, onBack = {})
            }
        }
        compose.onNodeWithTag("usePhoneZone")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Selected))
        // Only the zones are the radio group's choices.
        compose.onNodeWithTag("zones").onChildren().filter(SemanticsMatcher.keyIsDefined(SemanticsProperties.Selected)).assertCountEquals(2)
        compose.onNodeWithTag("zones").onChildren().filter(hasTestTag("usePhoneZone")).assertCountEquals(0)
    }
}
