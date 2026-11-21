package app.penmoss.analytics

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.git.firstrun.ConsentStep
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.PrivacyActions
import app.penmoss.ui.settings.PrivacyScreen
import app.penmoss.ui.settings.PrivacyUi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The phone says what the Mac says (PEN-137, AC4, AC5, AC41): every string of the analytics
 * screens is core's Android text from `apps/android/contract/analytics-copy-v1.json`, and the
 * consent question and Privacy show those words, the Mac's CLI and MCP line left out.
 */
@RunWith(AndroidJUnit4::class)
class AnalyticsCopyContractTest {
    @get:Rule
    val compose = createComposeRule()

    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("analytics-copy-v1.json") }
            ?: File("../contract/analytics-copy-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val android: Map<String, String> = contract.getValue("copy").jsonObject.mapValues { it.value.jsonObject.getValue("android").jsonPrimitive.content }

    private fun text(key: String) = android.getValue(key)

    @Test
    fun everyStringIsCoresAndroidText() {
        assertEquals(android, AnalyticsCopy.TEXT)
        assertEquals(android.keys.toList(), AnalyticsCopy.TEXT.keys.toList())
        // The Title Case keys say "ID", never "Id".
        val titles = contract.getValue("titleKeys").jsonArray.map { it.jsonPrimitive.content }
        assertTrue(titles.isNotEmpty())
        for (key in titles) assertTrue(key, !Regex("\\bId\\b").containsMatchIn(text(key)))
        assertEquals("", text("consent.recorded.4"))
        assertEquals("Share Log File", text("privacy.logs.button"))
        // The viewer's state names are the record's.
        for (state in EventState.entries) assertEquals(text("state.${state.wire}"), state.label)
    }

    @Test
    fun theQuestionShowsTheSameWordsLessTheMacsLine() {
        val answers = mutableListOf<ConsentAnswer>()
        compose.setContent { PenmossTheme { ConsentStep(lastStep = true, onAnswer = { answers += it }, openUrl = {}) } }
        val keys = listOf(
            "consent.title", "consent.lastStep.label", "consent.body", "consent.recorded.title", "consent.recorded.1", "consent.recorded.2",
            "consent.recorded.3", "consent.recorded.5", "consent.never.title", "consent.never.1", "consent.never.2", "consent.never.3", "consent.later",
            "consent.policy.label",
        )
        for (key in keys) compose.onNodeWithText(text(key), useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        // The answers stay in view below the words.
        for (key in listOf("consent.share.button", "consent.dontShare.button")) compose.onNodeWithText(text(key), useUnmergedTree = true).assertIsDisplayed()
        val mac = contract.getValue("copy").jsonObject.getValue("consent.recorded.4").jsonObject.getValue("mac").jsonPrimitive.content
        assertEquals(0, compose.onAllNodes(hasText(mac)).fetchSemanticsNodes().size)
        compose.onNodeWithTag("consent-dont-share").performClick()
        compose.onNodeWithTag("consent-share").performClick()
        assertEquals(listOf(ConsentAnswer.NO, ConsentAnswer.YES), answers)
    }

    @Test
    fun privacyShowsTheSameWords() {
        compose.setContent { PenmossTheme { PrivacyScreen(PrivacyUi(install = "0".repeat(32)), PrivacyActions()) } }
        val keys = listOf(
            "privacy.lead", "privacy.share.label", "privacy.share.hint", "privacy.viewData.label", "privacy.id.label",
            "privacy.id.hint", "privacy.resetId.button", "privacy.forget.button", "privacy.logs.label", "privacy.logs.button",
            "privacy.advanced.label", "privacy.advanced.hint", "privacy.policy.label",
        )
        for (key in keys) compose.onNodeWithText(text(key), useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        // The title, in the top bar (drawn large and small).
        assertTrue(compose.onAllNodes(hasText(text("privacy.title")), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithText(text("privacy.logs.hint").replace("{days}", "7"), useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("privacyAdvanced").performScrollTo().performClick()
        for (key in listOf("privacy.advanced.intro", "limits.usage.title", "limits.report.title", "limits.reset.button")) {
            compose.onNodeWithText(text(key), useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        }
        for (key in listOf("limits.events.days.label", "limits.events.max.label", "limits.logs.fileKb.label", "limits.logs.files.label", "limits.logs.days.label", "limits.report.hours.label")) {
            compose.onNodeWithText(text(key), useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        }
    }
}
