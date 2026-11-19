package app.penmoss.analytics

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.LimitsPreview
import app.penmoss.ui.settings.PrivacyActions
import app.penmoss.ui.settings.PrivacyScreen
import app.penmoss.ui.settings.PrivacyUi
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Privacy → Advanced on the phone (PEN-137): every limit in Usage Record, Logs and Bug Reports,
 * each with its unit and range, the space estimates and Reset to Defaults at the foot (AC26); a
 * lowered limit that would delete events asks first, Cancel puts the old value back, and Delete
 * saves and prunes (AC40). Run with `task proof:android -- app.penmoss.analytics.LimitsSettingsTest`.
 */
@RunWith(AndroidJUnit4::class)
class LimitsSettingsTest {
    private fun show(scenario: ActivityScenario<ComponentActivity>, phone: TestAnalytics) {
        scenario.onActivity { activity ->
            activity.setContent {
                PenmossTheme {
                    val scope = rememberCoroutineScope()
                    var limits by remember { mutableStateOf(Limits.DEFAULTS) }
                    PrivacyScreen(
                        PrivacyUi(install = "0".repeat(32), limits = limits),
                        PrivacyActions(
                            preview = { next -> LimitsPreview(events = phone.store.outside(next, phone.clock)) },
                            onLimits = { next ->
                                limits = next
                                scope.launch { phone.service.setLimits(next) }
                            },
                        ),
                    )
                }
            }
        }
    }

    @Test
    fun advancedOpensInPlaceWithEveryLimit() {
        TestAnalytics().use { phone ->
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                show(scenario, phone)
                val screen = OnScreen(scenario)
                screen.tap("privacyAdvanced")
                screen.reveal(screen.tagged("privacyAdvanced"), margin = 0f)
                for (title in listOf("Usage Record", "Bug Reports")) screen.text(title)
                for (spec in Limits.SPECS) {
                    screen.tagged("limit-${spec.key}")
                    screen.text(spec.rangeLabel)
                }
                for (label in listOf("Keep Events For", "Keep at Most", "Log File Size", "Log Files Kept", "Keep Log Lines For", "Attach Logs from the Last")) screen.text(label)
                screen.text("About 1.9 MB of events at most on this phone")
                screen.text("Up to 2 MB of logs on this phone (at most 400 MB)")
                screen.text("A bug report attaches the last 24 hours, at most 300 lines and 16 KB.")
                // Reset to Defaults is at the foot, below every field.
                val tops = screen.layoutTops(Limits.SPECS.map { "limit-${it.key}" } + "limitsReset")
                assertTrue(tops.toString(), tops.dropLast(1).all { it < tops.last() })
                // Bug Reports and Reset to Defaults in sight for the proof.
                screen.reveal(screen.text("Bug Reports"), margin = 40f)
                screen.text("Attach Logs from the Last")
                screen.tagged("limitsReset")
                SystemClock.sleep(2_000)
                ProofShot.take()
            }
        }
    }

    @Test
    fun loweringALimitAsksFirstAndCancelPutsItBack() {
        TestAnalytics().use { phone ->
            // One a day for a month, and twenty from the last twenty minutes.
            phone.seed(30, EventState.LOCAL, ageMs = AnalyticsStore.DAY)
            phone.seed(20, EventState.LOCAL, ageMs = 60_000)
            val old = runBlocking { phone.store.outside(Limits.DEFAULTS.with(Limits.EVENTS_DAYS, 3), phone.clock) }
            assertTrue("$old events older than 3 days", old > 0)
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                show(scenario, phone)
                val screen = OnScreen(scenario)
                screen.tap("privacyAdvanced")
                screen.reveal("limit-events.days")
                // Out of range: refused, saying the range.
                screen.type("limit-events.days", "400")
                screen.text("Between 1 and 360")
                assertEquals(50L, runBlocking { phone.store.size() })

                screen.type("limit-events.days", "3")
                val title = "Delete ${AnalyticsFormat.number(old)} Events?"
                screen.dialogText(title)
                screen.dialogText("They’re older than 3 days. They’re deleted from this phone now, and raising the limit later won’t bring them back.")
                screen.dialogTap("Cancel")
                screen.waitFor("the old value back") {
                    if (screen.tagged("limit-events.days").config.getOrNull(SemanticsProperties.EditableText)?.text == "7") true else null
                }
                assertEquals(50L, runBlocking { phone.store.size() })

                screen.type("limit-events.days", "3")
                screen.dialogText(title)
                SystemClock.sleep(2_000)
                ProofShot.take()
                screen.dialogTap("Delete")
                screen.waitFor("the record pruned") { if (runBlocking { phone.store.size() } == 50L - old) true else null }
                assertEquals(3, runBlocking { phone.service.stateNow() }.limits.eventsDays)
            }
        }
    }
}
