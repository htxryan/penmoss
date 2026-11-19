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
            val row = screen.tagged("section-privacy")
            screen.reveal(row, margin = 400f)
            val rows = listOf("section-storage", "section-github", "section-whatsnew", "section-privacy").map { screen.tagged(it) }
            assertEquals(rows.sortedBy { it.boundsInWindow.top }, rows)
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
            // Advanced is closed.
            assertFalse(screen.has(AnalyticsCopy.text("limits.usage.title")))
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
                            AnalyticsDataScreen(
                                summary = "On this phone, kept 7 days. ID 5c0e8f6a…7a96. Sharing since 19 Nov 2026.",
                                counts = mapOf(EventState.SENT to 230L, EventState.LOCAL to 12L),
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
                assertTrue(first.toString(), screen.has("${eventTime(newest.at)} · Not Shared"))
                screen.tap("viewerFilter-sent")
                screen.waitFor("only Sent rows") { if (!screen.has("click · privacy.share-log-file")) true else null }
                assertTrue(screen.has("click · privacy.view-data"))
                screen.tap("viewerFilter-local")
                screen.text("click · privacy.share-log-file")
                assertFalse(screen.has("click · privacy.view-data"))
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
