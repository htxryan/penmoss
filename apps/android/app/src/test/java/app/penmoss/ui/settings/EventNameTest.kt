package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Analytics Data's row heading (PEN-177): an event's kind and name each stay whole, as the Mac's
 * Name cell does. Where the row is too narrow for both, the name goes under the kind; it never
 * breaks mid-word ("tree · ope/n"), and it still reads as one text, "kind · name".
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EventNameTest {
    @get:Rule
    val compose = createComposeRule()

    private fun height(tag: String): Float = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot.height

    @Test
    fun theNameStaysWholeAndGoesUnderTheKindWhenTheRowIsNarrow() {
        compose.setContent {
            PenmossTheme {
                Column {
                    Box(Modifier.width(400.dp).testTag("wide")) { EventName("tree", "collapse") }
                    Box(Modifier.width(90.dp).testTag("narrow")) { EventName("tree", "collapse") }
                    Box(Modifier.width(120.dp).testTag("long")) { EventName("click", "privacy.data.filter-client") }
                }
            }
        }
        // One text each, as the tests and TalkBack read it.
        compose.onNodeWithTag("wide").assertExists()
        assertEquals(2, compose.onAllNodesWithText("tree · collapse").size)
        compose.onNodeWithText("click · privacy.data.filter-client").assertExists()
        val line = height("wide")
        // Too narrow for both: the name on a line of its own, whole, so two lines and no more.
        assertEquals(2f, height("narrow") / line, 0.25f)
        assertEquals(2f, height("long") / line, 0.25f)
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithText(text: String) =
        onAllNodes(androidx.compose.ui.test.hasText(text)).fetchSemanticsNodes()
}
