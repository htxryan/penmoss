package app.penmoss.analytics

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
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
import org.junit.After
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
    /**
     * Privacy over [phone]'s record, as PrivacyRoute wires it: the counts follow the store live,
     * and the page records itself (the global recorder is [phone]'s for the test).
     */
    private fun show(scenario: ActivityScenario<ComponentActivity>, phone: TestAnalytics) {
        Analytics.install(phone.service)
        scenario.onActivity { activity ->
            activity.setContent {
                PenmossTheme {
                    val scope = rememberCoroutineScope()
                    var limits by remember { mutableStateOf(Limits.DEFAULTS) }
                    val counts by remember { phone.store.observeCounts() }.collectAsState(emptyMap())
                    PrivacyScreen(
                        PrivacyUi(install = "0".repeat(32), limits = limits, counts = counts),
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

    /** The app's own recorder, put back after each test, so the tests after it in this process record as the app does. */
    private val appRecorder = Analytics.service

    @After
    fun uninstall() = Analytics.install(appRecorder)

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
                screen.text("About 100 MB of events at most on this phone")
                screen.text("Up to 2 MB of logs on this phone (at most 400 MB)")
                screen.text("A bug report attaches the last 24 hours, at most 300 lines and 16 KB.")
                // Reset to Defaults is at the foot, below every field.
                val tops = screen.layoutTops(Limits.SPECS.map { "limit-${it.key}" } + "limitsReset")
                assertTrue(tops.toString(), tops.dropLast(1).all { it < tops.last() })
                // The proof holds on each part in turn: Usage Record, then the logs' space
                // estimate, then Bug Reports with Reset to Defaults at the foot.
                screen.reveal(screen.text("Usage Record"), margin = 40f)
                SystemClock.sleep(1_500)
                val logsSpace = screen.tagged("limitsSpace-logs")
                screen.reveal(logsSpace, margin = 320f)
                assertTrue(screen.has("Up to 2 MB of logs on this phone (at most 400 MB)"))
                SystemClock.sleep(1_500)
                screen.reveal(screen.text("Bug Reports"), margin = 40f)
                for (shown in listOf("Bug Reports", "Attach Logs from the Last", "A bug report attaches the last 24 hours, at most 300 lines and 16 KB.", "Reset to Defaults")) {
                    assertTrue("$shown on screen with Bug Reports", screen.has(shown))
                }
                assertTrue("Reset to Defaults in sight", onScreen(screen.tagged("limitsReset"), scenario))
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
                // The View Analytics Data row follows the record live: the fifty seeded, and
                // opening Privacy recorded as a screen.
                screen.waitFor("the record's counts on Privacy") { screen.texts().firstOrNull { it.contains("Not Shared 50") } }
                screen.waitFor("Privacy recorded") {
                    runBlocking { phone.service.flush(); phone.store.page(null, null, 100) }.firstOrNull { it.kind == "screen" && it.name == "settings.privacy" }
                }
                screen.waitFor("the screen event counted") { screen.texts().firstOrNull { it.contains("Waiting for Your Answer") && it.contains("Not Shared 50") } }
                screen.tap("privacyAdvanced")
                screen.reveal("limit-events.days")
                // Out of range: refused, saying the range.
                screen.type("limit-events.days", "400")
                screen.text("Between 1 and 360")
                assertEquals(50L, runBlocking { phone.store.counts()[EventState.LOCAL] })

                screen.type("limit-events.days", "3")
                val title = "Delete ${AnalyticsFormat.number(old)} Events?"
                screen.dialogText(title)
                screen.dialogText("They’re older than 3 days. They’re deleted from this phone now, and raising the limit later won’t bring them back.")
                screen.dialogTap("Cancel")
                screen.waitFor("the old value back") {
                    if (screen.tagged("limit-events.days").config.getOrNull(SemanticsProperties.EditableText)?.text == "7") true else null
                }
                assertEquals(50L, runBlocking { phone.store.counts()[EventState.LOCAL] })

                screen.type("limit-events.days", "3")
                screen.dialogText(title)
                SystemClock.sleep(2_000)
                ProofShot.take()
                screen.dialogTap("Delete")
                screen.waitFor("the record pruned") { if (runBlocking { phone.store.counts()[EventState.LOCAL] } == 50L - old) true else null }
                // The row behind follows at once.
                screen.reveal(screen.tagged("privacyViewData"))
                screen.waitFor("the counts after the prune") { screen.texts().firstOrNull { it.contains("Not Shared ${50L - old}") } }
                assertEquals(3, runBlocking { phone.service.stateNow() }.limits.eventsDays)
            }
        }
    }
}

/** Whether [node] lies wholly inside the window. */
internal fun onScreen(node: androidx.compose.ui.semantics.SemanticsNode, scenario: ActivityScenario<ComponentActivity>): Boolean {
    var height = 0
    scenario.onActivity { height = it.window.decorView.height }
    return node.boundsInWindow.top >= 0f && node.boundsInWindow.bottom <= height
}
