package app.penmoss.ui.settings

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.analytics.AnalyticsCopy
import app.penmoss.analytics.EventState
import app.penmoss.analytics.OnScreen
import app.penmoss.analytics.texts
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A1674's Android proof: a Settings page has no sentence under its title. Privacy's lead ("Penmoss
 * records what you do in it…") is gone from the page, so its first row, Share Usage Data, comes
 * straight after the title; the lead stays only as Settings search's help for the row. Run with
 * `task proof:android -- app.penmoss.ui.settings.SettingsNoSubtitleInstrumentedTest`.
 */
@RunWith(AndroidJUnit4::class)
class SettingsNoSubtitleInstrumentedTest {
    @Test
    fun privacyHasNoSubtitleUnderItsTitle() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        PrivacyScreen(PrivacyUi(sharing = true, counts = mapOf(EventState.SENT to 41L, EventState.LOCAL to 212L)), PrivacyActions())
                    }
                }
            }
            val screen = OnScreen(scenario)
            val title = screen.text(AnalyticsCopy.text("privacy.title"))
            val first = screen.text(AnalyticsCopy.text("privacy.share.label"))
            assertFalse(screen.has(AnalyticsCopy.text("privacy.lead")))
            // Nothing between the title and the first row: every other text sits below that row.
            val between = screen.nodes()
                .filter { it.texts().isNotEmpty() && it.texts() != listOf(AnalyticsCopy.text("privacy.title")) }
                .filter { it.boundsInWindow.top >= title.boundsInWindow.bottom && it.boundsInWindow.bottom <= first.boundsInWindow.top }
                .flatMap { it.texts() }
            assertEquals(emptyList<String>(), between)
            // Held before the shot: proof.sh ends the video 0.5 s after ProofShot (A1279).
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }
}
