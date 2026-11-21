package app.penmoss.ui.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.analytics.EventState
import app.penmoss.analytics.Limits
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Settings → Privacy on the phone (PEN-137, AC5, AC26, AC38, AC40, AC47, AC48), the JVM twin of
 * the instrumented PrivacySettingsTest and LimitsSettingsTest: its place in Settings, its rows in
 * the Mac's order and words, Delete My Shared Data and a lowered limit asking first, a value out
 * of range refused, and Search Settings' rows.
 */
@RunWith(AndroidJUnit4::class)
class PrivacyScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val install = "5c0e8f6a00000000000000000000" + "7a96"

    @Test
    fun privacyIsTheLastOfThisPhoneWithItsSummary() {
        val groups = settingsGroups(Settings(), "Penmoss", privacy = privacySummary(true, 255))
        val phone = groups.single { it.title == "This Phone" }
        assertEquals(listOf("storage", "github", "whatsnew", "privacy"), phone.sections.map { it.id })
        val privacy = phone.sections.last()
        assertEquals("Privacy", privacy.title)
        assertEquals("Sharing · 255 Events", privacy.summary)
        assertEquals(SettingsIcons.Shield, privacy.icon)
        assertEquals(SettingsRoutes.PRIVACY, privacy.route)
        assertEquals("Not Sharing · 1 Event", privacySummary(false, 1))
        assertEquals("Not Answered Yet · 0 Events", privacySummary(null, 0))
        // Without analytics (a test's graph), no row.
        assertTrue(settingsGroups(Settings(), "Penmoss").flatMap { it.sections }.none { it.id == "privacy" })
    }

    private var forgot = 0
    private val saved = mutableListOf<Limits>()

    private fun show(ui: PrivacyUi, preview: LimitsPreview = LimitsPreview(), mark: SettingMark = SettingMark()) {
        compose.setContent {
            CompositionLocalProvider(LocalSettingMark provides mark) {
                PenmossTheme {
                    var limits by remember { mutableStateOf(ui.limits) }
                    PrivacyScreen(
                        ui.copy(limits = limits),
                        PrivacyActions(
                            onForget = { forgot++ },
                            preview = { preview },
                            onLimits = {
                                saved += it
                                limits = it
                            },
                        ),
                    )
                }
            }
        }
    }

    @Test
    fun theRowsComeInTheMacsOrderWithItsWords() {
        show(PrivacyUi(sharing = true, counts = mapOf(EventState.WAITING to 2L, EventState.SENT to 41L, EventState.LOCAL to 212L), install = install))
        val labels = listOf("Share Usage Data", "View Analytics Data", "Analytics ID", "Reset My Analytics ID", "Delete My Shared Data", "Logs", "Advanced")
        val shown = compose.onAllNodes(
            SemanticsMatcher("a row's label") { node -> node.config.getOrNull(SemanticsProperties.Text)?.any { it.text in labels } == true },
            useUnmergedTree = true,
        ).fetchSemanticsNodes().map { node -> node.config[SemanticsProperties.Text].joinToString { it.text } }
        assertEquals(labels, shown)
        compose.onNodeWithText("Share Log File").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("privacyShare").assertIsOn()
        compose.onNodeWithText("Waiting to Send 2 · Sent 41 · Not Shared 212").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("5c0e8f6a…7a96").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Penmoss records what you do in it, by name, on this phone, and never anything you write or name.").performScrollTo().assertIsDisplayed()
        // Advanced is closed until opened, a disclosure with its hint and a down chevron.
        assertEquals(0, compose.onAllNodes(hasTestTag("privacyLimits")).fetchSemanticsNodes().size)
        compose.onNodeWithText("How long and how much Penmoss keeps on this phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("privacyAdvanced").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Closed"))
        compose.onNodeWithTag("privacyAdvanced").performClick()
        compose.onNodeWithTag("privacyAdvanced").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Open"))
        compose.onNodeWithTag("privacyLimits").assertExists()
        // Reset My Analytics ID and Delete My Shared Data are buttons in the ID's row, side by side.
        val reset = compose.onNodeWithTag("privacyResetId").fetchSemanticsNode().boundsInRoot
        val forget = compose.onNodeWithTag("privacyForget").fetchSemanticsNode().boundsInRoot
        assertTrue("$reset $forget", forget.left >= reset.right || forget.top >= reset.bottom)
        assertEquals(Role.Button, compose.onNodeWithTag("privacyForget").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Role))
        compose.onNodeWithText("Privacy Policy").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun deleteMySharedDataAsksFirstAndOnlyDeleteAsksTheServer() {
        show(PrivacyUi(sharing = true, install = install))
        compose.onNodeWithTag("privacyForget").performScrollTo().performClick()
        compose.onNodeWithText("Delete Your Shared Data?").assertIsDisplayed()
        compose.onNodeWithText(
            "Penmoss’s server deletes everything this phone shared under ID 5c0e8f6a…7a96, and this phone gets a new ID. The record on this phone stays.",
        ).assertIsDisplayed()
        compose.onNodeWithTag("cancelForget").performClick()
        assertEquals(0, forgot)
        compose.onNodeWithTag("privacyForget").performClick()
        compose.onNodeWithTag("confirmForget").assertIsDisplayed().performClick()
        assertEquals(1, forgot)
    }

    @Test
    fun advancedListsEveryLimitAndRefusesAValueOutOfRange() {
        show(PrivacyUi(install = install))
        compose.onNodeWithTag("privacyAdvanced").performScrollTo().performClick()
        for (title in listOf("Usage Record", "Bug Reports")) compose.onNodeWithText(title).performScrollTo().assertIsDisplayed()
        for (spec in Limits.SPECS) compose.onNodeWithTag("limit-${spec.key}").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("About 95 MB of events at most on this phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Up to 2 MB of logs on this phone (at most 400 MB)").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("A bug report attaches the last 24 hours, at most 300 lines and 16 KB.").performScrollTo().assertIsDisplayed()

        compose.onNodeWithTag("limit-events.days").performScrollTo().performTextReplacement("400")
        compose.onNodeWithTag("limit-events.days").performImeAction()
        compose.onNodeWithTag("limitHint-events.days", useUnmergedTree = true).assert(hasText("Between 1 and 360"))
        assertEquals(emptyList<Limits>(), saved)

        // Raising deletes nothing: saved at once, with its default said beside it.
        compose.onNodeWithTag("limit-report.lines").performScrollTo().performTextReplacement("50")
        compose.onNodeWithTag("limit-report.lines").performImeAction()
        compose.waitForIdle()
        assertEquals(50, saved.single().reportLines)
        compose.onNodeWithTag("limitHint-report.lines", useUnmergedTree = true).assert(hasText("50–2,000 lines · Default: 300"))
    }

    @Test
    fun loweringALimitThatDeletesAsksFirstAndCancelPutsItBack() {
        show(PrivacyUi(install = install), preview = LimitsPreview(events = 41_206))
        compose.onNodeWithTag("privacyAdvanced").performScrollTo().performClick()
        compose.onNodeWithTag("limit-events.days").performScrollTo().performTextReplacement("3")
        compose.onNodeWithTag("limit-events.days").performImeAction()
        compose.onNodeWithText("Delete 41,206 Events?").assertIsDisplayed()
        compose.onNodeWithText("They’re older than 3 days. They’re deleted from this phone now, and raising the limit later won’t bring them back.").assertIsDisplayed()
        compose.onNodeWithTag("cancelPrune").performClick()
        compose.waitForIdle()
        assertEquals(emptyList<Limits>(), saved)
        compose.onNodeWithTag("limit-events.days").assert(hasText("7"))

        compose.onNodeWithTag("limit-events.days").performTextReplacement("3")
        compose.onNodeWithTag("limit-events.days").performImeAction()
        compose.onNodeWithTag("confirmPrune").performClick()
        compose.waitForIdle()
        assertEquals(3, saved.single().eventsDays)
    }

    @Test
    fun resetToDefaultsAsksWhenItWouldDelete() {
        show(PrivacyUi(install = install, limits = Limits.DEFAULTS.with(Limits.EVENTS_MAX, 9000)), preview = LimitsPreview(logBytes = 38L * 1024 * 1024))
        compose.onNodeWithTag("privacyAdvanced").performScrollTo().performClick()
        compose.onNodeWithTag("limitsReset").performScrollTo().performClick()
        compose.onNodeWithText("Delete 38 MB of Logs?").assertIsDisplayed()
        compose.onNodeWithTag("confirmPrune").performClick()
        compose.waitForIdle()
        assertEquals(Limits.DEFAULTS, saved.single())
    }

    @Test
    fun aSearchResultForALimitOpensAdvancedAtItsRow() {
        val mark = SettingMark()
        mark.request("report-at-most-kb")
        show(PrivacyUi(install = install), mark = mark)
        compose.onNodeWithTag("privacyLimits").assertExists()
        compose.onNodeWithTag("limit-report.kb").assertIsDisplayed()
    }

    @Test
    fun searchFindsEveryPrivacyRowWithTheMacsIdsAndAliases() {
        val privacy = SETTINGS_INDEX.filter { it.route == SettingsRoutes.PRIVACY }
        val expected = mapOf(
            "share-usage-data" to listOf("analytics", "telemetry", "tracking", "usage", "usage data", "statistics", "opt out", "consent"),
            "view-analytics-data" to listOf("analytics", "telemetry", "tracking", "events", "what is recorded", "usage"),
            "analytics-id" to listOf("analytics", "telemetry", "install id", "identifier"),
            "reset-my-analytics-id" to listOf("analytics", "telemetry", "new id", "reset"),
            "delete-my-shared-data" to listOf("analytics", "telemetry", "tracking", "forget", "erase", "gdpr", "delete data"),
            "logs" to listOf("logs", "log file", "diagnostics", "debug", "crash", "share logs"),
            "advanced" to listOf("analytics", "telemetry", "limits", "storage", "retention", "diagnostics"),
            "keep-events-for" to listOf("analytics", "telemetry", "usage", "retention", "history", "limit"),
            "keep-at-most" to listOf("analytics", "telemetry", "usage", "retention", "history", "limit"),
            "log-file-size" to listOf("logs", "diagnostics", "disk space", "retention"),
            "log-files-kept" to listOf("logs", "diagnostics", "disk space", "retention"),
            "keep-log-lines-for" to listOf("logs", "diagnostics", "disk space", "retention"),
            "attach-logs-from-the-last" to listOf("logs", "diagnostics", "bug report", "feedback"),
            "report-at-most-lines" to listOf("logs", "diagnostics", "bug report", "feedback"),
            "report-at-most-kb" to listOf("logs", "diagnostics", "bug report", "feedback"),
        )
        assertEquals(expected, privacy.associate { it.id to it.aliases })
        // The rows inside Advanced are placed there; their ids are the fields' rows.
        assertEquals(LIMIT_ROW_IDS.values.toSet(), privacy.filter { it.section == "Privacy › Advanced" }.map { it.id }.toSet())
        assertTrue(privacy.filter { it.id in LIMIT_ROW_IDS.values }.all { it.section == "Privacy › Advanced" })
        for (word in listOf("analytics", "telemetry", "tracking", "usage", "diagnostics", "logs")) {
            assertTrue(word, searchSettings(SETTINGS_INDEX, word).any { it.route == SettingsRoutes.PRIVACY })
        }
        assertEquals(privacy.size, searchSettings(SETTINGS_INDEX, "privacy").count { it.route == SettingsRoutes.PRIVACY })
    }

    @Test
    fun theSwitchSaysWhetherTheRecordIsShared() {
        show(PrivacyUi(sharing = false, install = install))
        compose.onNodeWithTag("privacyShare").assertIsOff()
    }
}
