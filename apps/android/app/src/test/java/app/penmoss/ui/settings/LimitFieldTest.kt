package app.penmoss.ui.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.analytics.Limits
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Keep at Most with its digits grouped, as the Mac writes them (PEN-177, O7): "200,000" by
 * default, a value typed with or without commas taken, "2,000,000" fitting the field, and the
 * field left as it was saving nothing.
 */
@RunWith(AndroidJUnit4::class)
class LimitFieldTest {
    @get:Rule
    val compose = createComposeRule()

    private val saved = mutableListOf<Limits>()

    private fun show() {
        compose.setContent {
            PenmossTheme {
                var limits by remember { mutableStateOf(Limits.DEFAULTS) }
                PrivacyScreen(
                    PrivacyUi(install = "5c0e8f6a000000000000000000007a96", limits = limits),
                    PrivacyActions(preview = { LimitsPreview() }, onLimits = { saved += it; limits = it }),
                )
            }
        }
        compose.onNodeWithTag("privacyAdvanced").performScrollTo().performClick()
    }

    private val field get() = compose.onNodeWithTag("limit-events.max").performScrollTo()

    @Test
    fun keepAtMostShowsItsDigitsGrouped() {
        show()
        field.assert(hasText("200,000"))
        compose.onNodeWithTag("limitHint-events.max", useUnmergedTree = true).assert(hasText("500–2,000,000 events"))
    }

    @Test
    fun leavingItAsItWasSavesNothing() {
        show()
        field.performImeAction()
        field.performTextReplacement("200000")
        field.performImeAction()
        compose.waitForIdle()
        assertEquals(emptyList<Limits>(), saved)
    }

    @Test
    fun aValueTypedWithOrWithoutCommasIsTaken() {
        show()
        field.performTextReplacement("2,000,000")
        field.performImeAction()
        compose.waitForIdle()
        assertEquals(2_000_000, saved.last().eventsMax)
        field.assert(hasText("2,000,000"))
        field.performTextReplacement("300000")
        field.performImeAction()
        compose.waitForIdle()
        assertEquals(300_000, saved.last().eventsMax)
        field.assert(hasText("300,000"))
    }
}
