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
import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.cachedIn
import androidx.paging.compose.collectAsLazyPagingItems
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.settings.Settings
import app.penmoss.proof.ProofShot
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.settings.AnalyticsDataScreen
import app.penmoss.ui.settings.PrivacyActions
import app.penmoss.ui.settings.PrivacyScreen
import app.penmoss.ui.settings.PrivacyUi
import app.penmoss.ui.settings.SettingsHome
import app.penmoss.ui.settings.eventTime
import app.penmoss.ui.settings.privacySummary
import app.penmoss.ui.settings.settingsGroups
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Settings → Privacy on the phone (PEN-137): its row last in This Phone with its summary (AC47),
 * its rows in the Mac's order and words with Share Log File (AC5), Analytics Data with a back
 * arrow, newest first, a page at a time, filtered by state (AC6), and Delete My Shared Data asking
 * first in an AlertDialog (AC38). Run with
 * `task proof:android -- app.penmoss.analytics.PrivacySettingsTest`.
 */
@RunWith(AndroidJUnit4::class)
class PrivacySettingsTest {
    private val install = "5c0e8f6a" + "0".repeat(20) + "7a96"

    @Test
    fun privacyIsLastInThisPhoneWithItsSummary() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        SettingsHome(settingsGroups(Settings(), "Penmoss", storage = "79 MB", github = "Not Signed In", privacy = privacySummary(true, 255)), onOpen = {}, onBack = {})
                    }
                }
            }
            val screen = OnScreen(scenario)
            // This Phone from its first row, so all four are laid out below it (Writing grew with
            // AI Descriptions, PEN-161).
            screen.reveal(screen.tagged("section-storage"), margin = 160f)
            val tags = listOf("section-storage", "section-github", "section-whatsnew", "section-privacy")
            val tops = screen.layoutTops(tags)
            assertEquals(tops.toString(), tops.sorted(), tops)
            screen.text("Privacy")
            screen.text("Sharing · 255 Events")
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    @Test
    fun privacysRowsComeInTheMacsOrderWithShareLogFile() {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PenmossTheme {
                        PrivacyScreen(
                            PrivacyUi(sharing = true, counts = mapOf(EventState.WAITING to 2L, EventState.SENT to 41L, EventState.LOCAL to 212L), install = install),
                            PrivacyActions(),
                        )
                    }
                }
            }
            val screen = OnScreen(scenario)
            val labels = listOf("Share Usage Data", "View Analytics Data", "Analytics ID", "Reset My Analytics ID", "Delete My Shared Data", "Logs", "Advanced")
            val nodes = labels.map { screen.text(it) }
            assertEquals(labels, nodes.sortedBy { it.boundsInWindow.top }.map { it.texts().single() })
            screen.text("Share Log File")
            screen.text("Waiting to Send 2 · Sent 41 · Not Shared 212")
            screen.text("5c0e8f6a…7a96")
            // The ID's two buttons in one row: Reset outlined, Delete My Shared Data beside it.
            val reset = screen.tagged("privacyResetId").boundsInWindow
            val forget = screen.tagged("privacyForget").boundsInWindow
            assertTrue("$reset $forget", forget.left >= reset.right || forget.top >= reset.bottom)
            // Advanced is closed: a disclosure with its hint, not a row that goes somewhere.
            screen.text("How long and how much Penmoss keeps on this phone")
            assertEquals("Closed", screen.tagged("privacyAdvanced").config.getOrNull(SemanticsProperties.StateDescription))
            assertFalse(screen.has(AnalyticsCopy.text("limits.usage.title")))
            // Share Log File is outlined like Reset My Analytics ID above it, as the Mac's
            // bordered Show Log File: the shot holds both.
            screen.reveal(screen.tagged("privacyShareLog"), margin = 200f)
            assertTrue(screen.tagged("privacyResetId").boundsInWindow.top < screen.tagged("privacyShareLog").boundsInWindow.top)
            SystemClock.sleep(2_000)
            ProofShot.take()
        }
    }

    @Test
    fun analyticsDataPagesNewestFirstAndFiltersByState() {
        TestAnalytics().use { phone ->
            phone.seed(230, EventState.SENT)
            phone.seed(12, EventState.LOCAL, name = "privacy.share-log-file", ageMs = 1)
            var backs = 0
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.setContent {
                        PenmossTheme {
                            val scope = rememberCoroutineScope()
                            var filter by remember { mutableStateOf<EventState?>(null) }
                            val pages = remember(filter) {
                                Pager(PagingConfig(pageSize = 100, initialLoadSize = 100, enablePlaceholders = false)) { phone.store.pagingSource(filter) }.flow.cachedIn(scope)
                            }
                            val counts by remember { phone.store.observeCounts() }.collectAsState(emptyMap())
                            AnalyticsDataScreen(
                                summary = "On this phone, kept 7 days. ID 5c0e8f6a…7a96. Sharing since 19 Nov 2026.",
                                counts = counts,
                                filter = filter,
                                onFilter = { filter = it },
                                events = pages.collectAsLazyPagingItems(),
                                onCopyJson = null,
                                onBack = { backs++ },
                            )
                        }
                    }
                }
                val screen = OnScreen(scenario)
                screen.text(AnalyticsCopy.text("viewer.title"))
                screen.text("Sent 230 · Not Shared 12")
                // Newest first: the twelve recorded last, then the older ones.
                val first = screen.waitFor("the first event") { screen.nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == "viewerEvent" } }
                val newest = runBlocking { phone.store.page(null, null, 1).single() }
                assertTrue(first.toString(), screen.has(eventTime(newest.at)))
                // Each state a tinted chip: Not Shared neutral, Sent green.
                screen.tagged("viewerState-local")
                screen.text("Not Shared")
                screen.tap("viewerFilter-sent")
                screen.waitFor("only Sent rows") { if (!screen.has("click · privacy.share-log-file")) true else null }
                assertTrue(screen.has("click · privacy.view-data"))
                screen.tagged("viewerState-sent")
                SystemClock.sleep(1_500)
                screen.tap("viewerFilter-all")
                // The counts line under the summary, as the Mac's, held in the shot.
                val top = screen.tagged("viewerCounts")
                screen.reveal(top, margin = 400f)
                screen.text("Sent 230 · Not Shared 12")
                screen.tap("viewerFilter-local")
                screen.text("click · privacy.share-log-file")
                assertFalse(screen.has("click · privacy.view-data"))
                screen.text("Sent 230 · Not Shared 12")
                // Its own screen, with a way back.
                val back = screen.waitFor("Back") { screen.nodes().firstOrNull { it.config.getOrNull(SemanticsProperties.ContentDescription)?.contains("Back") == true } }
                SystemClock.sleep(2_000)
                ProofShot.take()
                screen.tap(back)
                assertEquals(1, backs)
            }
        }
    }

    @Test
    fun deleteMySharedDataAsksFirstInADialog() {
        var forgot = 0
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent { PenmossTheme { PrivacyScreen(PrivacyUi(sharing = true, install = install), PrivacyActions(onForget = { forgot++ })) } }
            }
            val screen = OnScreen(scenario)
            screen.tap("privacyForget")
            screen.dialogText("Delete Your Shared Data?")
            screen.dialogText("Penmoss’s server deletes everything this phone shared under ID 5c0e8f6a…7a96, and this phone gets a new ID. The record on this phone stays.")
            screen.dialogTap("Cancel")
            screen.waitFor("the dialog gone") { if (screen.anywhere("Delete Your Shared Data?").isEmpty()) true else null }
            assertEquals(0, forgot)
            screen.tap("privacyForget")
            screen.dialogText("Delete Your Shared Data?")
            screen.dialogText("Cancel")
            screen.dialogText("Delete")
            assertEquals(0, forgot)
            SystemClock.sleep(2_000)
            ProofShot.take()
            screen.dialogTap("Delete")
            screen.waitFor("Delete asked") { if (forgot == 1) true else null }
            assertEquals(1, forgot)
        }
    }
}
