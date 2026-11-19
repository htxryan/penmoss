package app.penmoss.analytics

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.git.firstrun.ConsentGate
import app.penmoss.git.firstrun.ConsentStep
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The usage question on the phone (PEN-137): the first run's last step (AC4), and once before Home
 * on a phone that had notebooks before it existed (AC9). The Mac's words less its CLI and MCP
 * line; Share Usage Data and Don't Share equal. Run with
 * `task proof:android -- app.penmoss.analytics.ConsentScreenTest`.
 */
@RunWith(AndroidJUnit4::class)
class ConsentScreenTest {
    @Test
    fun theFirstRunsLastStepAsksWithEqualAnswers() {
        TestAnalytics().use { phone ->
            // The first run's own events wait for the answer.
            phone.seed(6, EventState.PENDING)
            var answered by mutableStateOf<ConsentAnswer?>(null)
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.setContent {
                        PenmossTheme {
                            ConsentStep(
                                lastStep = true,
                                onAnswer = { answer -> phone.scope.launch { phone.service.answer(answer, "0.4.2") }.invokeOnCompletion { answered = answer } },
                                openUrl = {},
                            )
                        }
                    }
                }
                val screen = OnScreen(scenario)
                screen.text(AnalyticsCopy.text("consent.title"))
                for (key in listOf("consent.lastStep.label", "consent.body", "consent.recorded.title", "consent.never.title", "consent.share.button", "consent.dontShare.button")) {
                    screen.text(AnalyticsCopy.text(key))
                }
                assertFalse("the Mac's CLI and MCP line shows on the phone", screen.has("CLI commands and agents’ MCP calls, by name"))
                assertFalse("“Step 3 of 3” shows in place of Last Step", screen.texts().any { it.startsWith("Step ") })

                // Equal: the same size, side by side in weight, neither the filled one.
                val share = screen.tagged("consent-share")
                val dontShare = screen.tagged("consent-dont-share")
                assertEquals(share.boundsInWindow.width, dontShare.boundsInWindow.width, 1f)
                assertEquals(share.boundsInWindow.height, dontShare.boundsInWindow.height, 1f)

                screen.tap(share)
                screen.waitFor("the answer kept") { answered }
                val counts = runBlocking { phone.store.counts() }
                assertEquals(6L, counts[EventState.WAITING])
                assertEquals(0L, counts[EventState.PENDING])
                assertTrue(screen.has(AnalyticsCopy.text("consent.title")))
                SystemClock.sleep(2_000)
                ProofShot.take()
            }
        }
    }

    @Test
    fun aPhoneWithNotebooksIsAskedBeforeHome() {
        TestAnalytics().use { phone ->
            phone.seed(3, EventState.PENDING)
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.setContent { PenmossTheme { ConsentGate(phone.service, openUrl = {}) { Text("Home of Notebooks") } } }
                }
                val screen = OnScreen(scenario)
                screen.text(AnalyticsCopy.text("consent.title"))
                screen.text(AnalyticsCopy.text("consent.share.button"))
                screen.text(AnalyticsCopy.text("consent.dontShare.button"))
                assertFalse("Home shows before the answer", screen.has("Home of Notebooks"))
                // Not the first run: no step bar.
                assertFalse(screen.has(AnalyticsCopy.text("consent.lastStep.label")))
                SystemClock.sleep(2_000)
                ProofShot.take()
            }
        }
    }

    @Test
    fun answeredOnceHomeFollowsAndItIsNotAskedAgain() {
        TestAnalytics().use { phone ->
            phone.seed(3, EventState.PENDING)
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.setContent { PenmossTheme { ConsentGate(phone.service, openUrl = {}) { Text("Home of Notebooks") } } }
                }
                val screen = OnScreen(scenario)
                screen.tap("consent-dont-share")
                screen.text("Home of Notebooks")
                assertEquals(3L, runBlocking { phone.store.counts()[EventState.LOCAL] })
                // The next time the app opens: straight to Home.
                scenario.onActivity { activity ->
                    activity.setContent { PenmossTheme { ConsentGate(phone.service, openUrl = {}) { Text("Home of Notebooks Again") } } }
                }
                screen.text("Home of Notebooks Again")
                assertFalse(screen.has(AnalyticsCopy.text("consent.title")))
                SystemClock.sleep(2_000)
                ProofShot.take()
            }
        }
    }
}
