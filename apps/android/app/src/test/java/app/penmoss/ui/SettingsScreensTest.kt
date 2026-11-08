package app.penmoss.ui

import android.content.Context
import androidx.compose.foundation.layout.Column
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
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.AppGraph
import app.penmoss.auth.SecretBox
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
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** Settings on the phone (T40 P1): the home's sections, Appearance, Daily notes and Quick capture. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val cards = ThemeCatalogue.bundled.builtIns.map { themeCard(it, custom = false) }

    @Test
    fun theHomeListsEverySectionWithWhatItHoldsNow() {
        val opened = mutableListOf<String>()
        val settings = Settings(JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive("dark"), SettingKeys.CAPTURE to JsonPrimitive("inbox"))))
        compose.setContent {
            PenmossTheme {
                SettingsHome(settingsSections(settings, "Nord", "Synced at 3:42 PM", unsent = 1, version = "0.31 (build 431425)"), onOpen = { opened += it }, onBack = {})
            }
        }
        compose.onNodeWithText("Nord · Dark").assertIsDisplayed()
        // Display, right after Appearance (T42 on Android, A650).
        compose.onNodeWithText("Every shortcut on Home").assertIsDisplayed()
        // Then Symbols, its glyphs in order (T44, A747).
        compose.onNodeWithText("★ ? ! 💡 →").assertIsDisplayed()
        compose.onNodeWithTag("section-appearance").performClick()
        compose.onNodeWithTag("section-display").performClick()
        compose.onNodeWithTag("section-symbols").performClick()
        val list = compose.onNodeWithTag("settingsSections")
        // Then Git notebooks (T50 G7, A856).
        list.performScrollToNode(hasText("Notes in a private GitHub repository"))
        compose.onNodeWithTag("section-git").performClick()
        list.performScrollToNode(hasText("America/Chicago"))
        compose.onNodeWithText("America/Chicago").assertIsDisplayed()
        list.performScrollToNode(hasText("New Note in Inbox"))
        compose.onNodeWithText("New Note in Inbox").assertIsDisplayed()
        // One row lower since Display: scrolled to on the test's small screen.
        list.performScrollToNode(hasText("Synced at 3:42 PM · 1 setting to send"))
        compose.onNodeWithText("Synced at 3:42 PM · 1 setting to send").assertIsDisplayed()
        // A hardware keyboard's shortcuts (T40 P9, ST8).
        list.performScrollToNode(hasText("For a hardware keyboard"))
        compose.onNodeWithTag("section-shortcuts").performClick()
        // The Penmoss account's sections went with the server (T59, A1040).
        for (gone in listOf("notebooks", "mirror", "status", "devices", "phone")) compose.onNodeWithTag("section-$gone").assertDoesNotExist()
        // About, last (T49): the version, and Send feedback.
        list.performScrollToNode(hasText("Version 0.31 (build 431425) · Send Feedback"))
        compose.onNodeWithTag("section-about").performClick()
        assertEquals(listOf("appearance", "display", "symbols", "git", "shortcuts", "about"), opened)
    }

    /** T39 pass 3 (A902): one icon per section, the web's: Git notebooks no longer shares Git mirror's. */
    @Test
    fun eachSectionHasItsOwnIconAsOnTheWeb() {
        val sections = settingsSections(Settings(), "Penmoss", "", unsent = 0)
        val icon = sections.associate { it.id to it.icon }
        assertEquals(app.penmoss.ui.settings.SettingsIcons.Terminal, icon["git"])
        assertEquals(app.penmoss.ui.settings.SettingsIcons.Refresh, icon["sync"])
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

    @Test
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
        compose.onNodeWithText("The theme’s (52 rem)").performScrollTo().assertIsDisplayed()
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

    @Test
    fun aTemplateSavesWhenChangedAndResetToDefaultRemovesIt() {
        val saved = mutableListOf<Pair<String, String?>>()
        var daily by mutableStateOf(TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily template", "## Plan\n\n## Notes\n", custom = false))
        compose.setContent {
            PenmossTheme {
                DailyNotesScreen(
                    timeZone = "America/Chicago",
                    today = "2026-10-24",
                    templates = listOf(daily),
                    enabled = true,
                    onTimeZone = {},
                    onSave = { key, value ->
                        saved += key to value
                        daily = daily.copy(saved = value ?: "## Plan\n\n## Notes\n", custom = value != null)
                    },
                    onBack = {},
                )
            }
        }
        compose.onNodeWithText("Today is 2026-10-24 in America/Chicago. Changes sync to your other devices.").assertIsDisplayed()
        // Nothing changed, nothing custom: neither button does anything yet.
        compose.onNodeWithTag("save-template.daily").assertIsNotEnabled()
        compose.onNodeWithTag("reset-template.daily").assertIsNotEnabled()
        compose.onNodeWithTag("template-template.daily").performTextReplacement("## Today\n{{longDate}}\n")
        compose.onNodeWithTag("save-template.daily").assertIsEnabled().performClick()
        assertEquals(listOf(SettingKeys.DAILY_TEMPLATE to "## Today\n{{longDate}}\n"), saved)
        compose.onNodeWithText("Saved").assertIsDisplayed()
        compose.onNodeWithTag("reset-template.daily").assertIsEnabled().performClick()
        assertEquals(SettingKeys.DAILY_TEMPLATE to null, saved.last())
        compose.onNodeWithText("Back to the default").assertIsDisplayed()
        compose.onNodeWithTag("reset-template.daily").assertIsNotEnabled()
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
    fun quickCaptureChoosesWhereCapturesGo() {
        var destination by mutableStateOf("daily")
        compose.setContent { PenmossTheme { QuickCaptureScreen(destination, enabled = true, onChoose = { destination = it }, onBack = {}) } }
        compose.onNodeWithTag("capture-daily").assertIsSelected()
        compose.onNodeWithTag("capture-inbox").performClick()
        assertEquals("inbox", destination)
        compose.onNodeWithTag("capture-inbox").assertIsSelected()
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
    fun aTemplateOverTheServersLimitIsCountedAndCannotBeSaved() {
        val saved = mutableListOf<Pair<String, String?>>()
        compose.setContent {
            PenmossTheme {
                DailyNotesScreen(
                    timeZone = "America/Chicago",
                    today = "2026-10-24",
                    templates = listOf(TemplateField(SettingKeys.DAILY_TEMPLATE, "Daily template", "## Plan\n", custom = false)),
                    enabled = true,
                    onTimeZone = {},
                    onSave = { key, value -> saved += key to value },
                    onBack = {},
                )
            }
        }
        val field = compose.onNodeWithTag("template-${SettingKeys.DAILY_TEMPLATE}")
        compose.onNodeWithTag("count-${SettingKeys.DAILY_TEMPLATE}", useUnmergedTree = true).assertTextEquals("8 / 10,000")
        // One character over the server's limit (A410): said, and Save is off.
        field.performTextReplacement("x".repeat(SettingLimits.TEMPLATE_MAX_CHARS + 1))
        compose.onNodeWithTag("count-${SettingKeys.DAILY_TEMPLATE}", useUnmergedTree = true)
            .assertTextEquals("Too long: at most 10,000 characters (10,001 now)")
        compose.onNodeWithTag("save-${SettingKeys.DAILY_TEMPLATE}").performScrollTo().assertIsNotEnabled()
        // At the limit it can be saved.
        field.performTextReplacement("x".repeat(SettingLimits.TEMPLATE_MAX_CHARS))
        compose.onNodeWithTag("save-${SettingKeys.DAILY_TEMPLATE}").performScrollTo().assertIsEnabled().performClick()
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
                    settingsSections(Settings(), "Penmoss", "", unsent = 0),
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
                    SettingsHome(settingsSections(Settings(), "Penmoss", "", unsent = 0), onOpen = {}, onBack = {})
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
