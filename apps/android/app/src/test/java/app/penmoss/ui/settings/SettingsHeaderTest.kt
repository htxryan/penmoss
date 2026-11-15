package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Settings' header on the phone (A1560): a section's title large in a collapsing top app bar,
 * which shrinks as the screen scrolls, and the (i) with where settings are kept.
 */
@RunWith(AndroidJUnit4::class)
class SettingsHeaderTest {
    @get:Rule
    val compose = createComposeRule()

    private fun screen(name: String? = "Personal", info: Boolean = true) {
        compose.setContent {
            PenmossTheme {
                CompositionLocalProvider(LocalPrimaryNotebookName provides name) {
                    SectionScreen("Appearance", onBack = {}, info = info) {
                        Text("First row", Modifier.testTag("firstRow"))
                        Spacer(Modifier.height(3000.dp))
                    }
                }
            }
        }
    }

    @Test
    fun theTitleBarCollapsesAsTheScreenScrolls() {
        screen()
        val before = compose.onNodeWithTag("sectionTopBar").getUnclippedBoundsInRoot().let { it.bottom - it.top }
        // A finger dragging the content up, as far as the screen goes.
        compose.onNode(hasScrollAction()).performTouchInput { swipeUp(startY = bottom - 10f, endY = top + 10f, durationMillis = 600) }
        compose.waitForIdle()
        val after = compose.onNodeWithTag("sectionTopBar").getUnclippedBoundsInRoot().let { it.bottom - it.top }
        assertTrue("the large bar shrinks: $before → $after", after < before)
        // One title in the tree whichever row shows it.
        compose.onNodeWithText("Appearance").assertExists()
    }

    @Test
    fun theInfoButtonSaysWhereSettingsAreKept() {
        screen()
        compose.onNodeWithContentDescription("About Settings").performClick()
        compose.onNodeWithTag("settingsInfoText").assertContentDescriptionEquals(
            "Settings are synced through your primary notebook, Personal. Those marked with a laptop stay on this phone only.",
        )
        compose.onNodeWithTag("settingsInfoOk").performClick()
        compose.onNodeWithTag("settingsInfoText").assertDoesNotExist()
    }

    @Test
    fun theWordsReadWithoutANameWhenThereIsNoNotebook() {
        assertEquals(
            "Settings are synced through your primary notebook. Those marked ⁠laptop⁠ stay on this phone only.",
            settingsInfoText(null),
        )
    }

    @Test
    fun aScreenThatIsNotSettingsHasNoInfo() {
        screen(info = false)
        compose.onNodeWithContentDescription("About Settings").assertDoesNotExist()
    }
}
