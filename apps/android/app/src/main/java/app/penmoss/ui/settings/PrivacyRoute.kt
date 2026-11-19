package app.penmoss.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.cachedIn
import androidx.paging.compose.collectAsLazyPagingItems
import app.penmoss.BuildConfig
import app.penmoss.DeviceGraph
import app.penmoss.analytics.AnalyticsCopy
import app.penmoss.analytics.AnalyticsService
import app.penmoss.analytics.AnalyticsStore
import app.penmoss.analytics.ConsentAnswer
import app.penmoss.analytics.EventState
import app.penmoss.analytics.ForgetOutcome
import app.penmoss.analytics.Limits
import app.penmoss.git.firstrun.PRIVACY_POLICY_URL
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/** The Settings row's line for Privacy (AC47), as it changes; null while there is no analytics. */
@Composable
internal fun rememberPrivacySummary(device: DeviceGraph): String? {
    val analytics = device.analytics ?: return null
    val state by analytics.state.collectAsStateWithLifecycle()
    val counts by remember(analytics) { analytics.store.observeCounts() }.collectAsStateWithLifecycle(null)
    return privacySummary(state?.let { if (it.answered) it.sharing else null }, counts?.values?.sum())
}

/** Settings → Privacy (PEN-137): the page over the phone's analytics. */
@Composable
internal fun PrivacyRoute(device: DeviceGraph, onViewData: () -> Unit, onBack: () -> Unit) {
    val analytics = device.analytics
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by (analytics?.state ?: remember { kotlinx.coroutines.flow.MutableStateFlow(null) }).collectAsStateWithLifecycle()
    val counts by remember(analytics) { analytics?.store?.observeCounts() ?: flowOf(emptyMap()) }.collectAsStateWithLifecycle(emptyMap())
    var notice by remember { mutableStateOf<String?>(null) }
    var forgetting by remember { mutableStateOf(false) }
    val now = state
    PrivacyScreen(
        PrivacyUi(
            known = now != null && analytics != null,
            sharing = now?.sharing == true,
            counts = counts,
            install = now?.install.orEmpty(),
            limits = now?.limits ?: Limits.DEFAULTS,
            notice = notice,
            forgetting = forgetting,
        ),
        PrivacyActions(
            onShare = { on ->
                notice = null
                app.penmoss.analytics.Analytics.setting("privacy.share", on)
                scope.launch { analytics?.answer(if (on) ConsentAnswer.YES else ConsentAnswer.NO, BuildConfig.VERSION_NAME) }
            },
            onViewData = onViewData,
            onResetId = {
                scope.launch {
                    analytics ?: return@launch
                    app.penmoss.analytics.Analytics.record("setting", "privacy.reset", mapOf("changed" to true))
                    analytics.resetId()
                    notice = AnalyticsCopy.text("privacy.resetId.done")
                }
            },
            onForget = {
                scope.launch {
                    analytics ?: return@launch
                    forgetting = true
                    notice = when (analytics.forget()) {
                        ForgetOutcome.OK -> {
                            app.penmoss.analytics.Analytics.record("setting", "privacy.forget", mapOf("changed" to true))
                            AnalyticsCopy.text("forget.done")
                        }
                        ForgetOutcome.OFFLINE -> AnalyticsCopy.text("forget.offline")
                        ForgetOutcome.FAILED -> AnalyticsCopy.text("forget.failed")
                    }
                    forgetting = false
                }
            },
            onShareLog = { scope.launch { PrivacyLogs.share(context, device) } },
            preview = { next ->
                val service = analytics
                LimitsPreview(
                    events = service?.store?.outside(next, System.currentTimeMillis()) ?: 0,
                    logBytes = PrivacyLogs.outside(next),
                )
            },
            onLimits = { next -> scope.launch { analytics?.setLimits(next) } },
            onPolicy = {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_POLICY_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            },
            onBack = onBack,
        ),
    )
}

/** Analytics Data (AC6): the record's pages, newest first, filtered by state. */
@Composable
internal fun AnalyticsDataRoute(device: DeviceGraph, onBack: () -> Unit) {
    val analytics: AnalyticsService = device.analytics ?: return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by analytics.state.collectAsStateWithLifecycle()
    val counts by remember(analytics) { analytics.store.observeCounts() }.collectAsStateWithLifecycle(emptyMap())
    var filter by remember { mutableStateOf<EventState?>(null) }
    val pages = remember(analytics, filter) {
        Pager(PagingConfig(pageSize = AnalyticsStore.PAGE, initialLoadSize = AnalyticsStore.PAGE, enablePlaceholders = false)) {
            analytics.store.pagingSource(filter)
        }.flow.cachedIn(scope)
    }
    val events = pages.collectAsLazyPagingItems()
    val now = state
    AnalyticsDataScreen(
        summary = viewerSummary(
            now?.limits?.eventsDays ?: Limits.DEFAULTS.eventsDays,
            now?.install.orEmpty(),
            now?.let { if (it.answered) it.sharing else null },
            now?.sharingSince,
        ),
        counts = counts,
        filter = filter,
        onFilter = { filter = it },
        events = events,
        onCopyJson = {
            scope.launch {
                // The exact body of the last batch sent, or the events on the screen.
                val text = analytics.store.meta(AnalyticsStore.LAST_BATCH)
                    ?: kotlinx.serialization.json.JsonArray(events.itemSnapshotList.items.map { it.event().wire() }).toString()
                context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(AnalyticsCopy.text("viewer.title"), text))
            }
        },
        onBack = onBack,
    )
}
