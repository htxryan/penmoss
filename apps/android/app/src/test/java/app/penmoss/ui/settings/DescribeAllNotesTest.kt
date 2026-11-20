package app.penmoss.ui.settings

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ai.AiKeyState
import app.penmoss.ai.AiKeys
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Settings → AI Descriptions → Describe All Notes on the phone: the Mac's row, in its place after
 * Describe a Note, waiting for a provider, then each notebook's Describe Notes Now and how many go.
 */
@RunWith(AndroidJUnit4::class)
class DescribeAllNotesTest {
    @get:Rule
    val compose = createComposeRule()

    private var asked = 0

    private fun show(provider: String, answer: Int?) {
        compose.setContent {
            PenmossTheme {
                AiDescriptionsScreen(
                    enabled = true,
                    global = true,
                    whenToDescribe = "pause",
                    pauseS = AiKeys.DEFAULT_PAUSE,
                    provider = provider,
                    key = AiKeyState(saved = true, refused = false),
                    model = AiKeys.MODELS.first().first,
                    prompt = null,
                    onGlobal = {},
                    onWhen = {},
                    onPause = {},
                    onProvider = {},
                    onModel = {},
                    onPrompt = {},
                    onSaveKey = { _, _ -> },
                    onTestKey = {},
                    onRemoveKey = {},
                    onDescribeAll = {
                        asked++
                        answer
                    },
                    onBack = {},
                )
            }
        }
    }

    @Test
    fun waitsForAProvider() {
        show(AiKeys.NONE, 3)
        compose.onNodeWithText("Describe All Notes").performScrollTo()
        compose.onNodeWithText("Pick an AI provider below first.").performScrollTo()
        compose.onNodeWithTag("aiDescribeAll").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun describesEveryNotebooksNotesAndSaysHowMany() {
        show(AiKeys.ANTHROPIC, 5)
        compose.onNodeWithTag("aiDescribeAll").performScrollTo().assertIsEnabled().performClick()
        compose.waitForIdle()
        assertEquals(1, asked)
        compose.onNodeWithTag("aiDescribeAllSaid").performScrollTo().assertTextEquals("Describing 5 notes in the background.")
    }

    @Test
    fun saysWhyNoneWent() {
        assertEquals("Nothing to describe: every note that’s On has a description.", describeAllWords(0))
        assertEquals("Describing 1 note in the background.", describeAllWords(1))
        assertEquals("Couldn’t start describing. Try again once a notebook is open.", describeAllWords(null))
    }
}
