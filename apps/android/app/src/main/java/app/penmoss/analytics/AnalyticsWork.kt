package app.penmoss.analytics

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.penmoss.BuildConfig
import kotlinx.coroutines.CoroutineScope
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Sends what waits (PEN-137): WorkManager runs it with a network, as soon as asked (every minute
 * or so while the app is in front, at 25 waiting events, when the app leaves the screen) or after
 * a backoff (a minute, doubling to an hour). Only waiting events ever go, and only while the
 * person shares.
 */
class AnalyticsSendWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val service = Analytics.service ?: return Result.success()
        // A failed send has asked for its own later run, with its backoff.
        runCatching { service.sendDue() }
        return Result.success()
    }
}

object AnalyticsWork {
    /** Sends asked for now: one at a time, a second ask while one waits is the same send. */
    const val NOW = "analytics-send"

    /** The send after a backoff. */
    const val LATER = "analytics-send-later"

    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(context: Context, delayMs: Long) {
        runCatching {
            val work = WorkManager.getInstance(context)
            val request = OneTimeWorkRequestBuilder<AnalyticsSendWorker>()
                .setConstraints(network)
                .apply { if (delayMs > 0) setInitialDelay(delayMs, TimeUnit.MILLISECONDS) }
                .build()
            if (delayMs > 0) {
                work.enqueueUniqueWork(LATER, ExistingWorkPolicy.REPLACE, request)
            } else {
                work.enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, request)
            }
        }
    }

    fun cancel(context: Context) {
        runCatching {
            val work = WorkManager.getInstance(context)
            work.cancelUniqueWork(NOW)
            work.cancelUniqueWork(LATER)
        }
    }

    /** The app's fields: its version and channel, Android's major.minor, and the window's width class. */
    fun fields(context: Context): ClientFields {
        val width = context.resources.configuration.screenWidthDp.takeIf { it != Configuration.SCREEN_WIDTH_DP_UNDEFINED }
        return ClientFields(
            version = AnalyticsFormat.eventVersion(BuildConfig.VERSION_NAME),
            channel = AnalyticsFormat.channelOf(BuildConfig.VERSION_NAME, BuildConfig.DEBUG),
            osVersion = AnalyticsFormat.majorMinor(Build.VERSION.RELEASE ?: "0"),
            sizeClass = width?.let(AnalyticsFormat::sizeClassOf),
        )
    }

    /** The app's analytics: its own database and consent file, sending to BuildConfig's endpoint. */
    fun create(context: Context, http: OkHttpClient, scope: CoroutineScope, onLimits: (Limits) -> Unit = {}): AnalyticsService {
        val app = context.applicationContext
        return AnalyticsService(
            store = AnalyticsStore(AnalyticsDatabase.open(app)),
            consent = ConsentStore.create(File(app.filesDir, "datastore"), scope),
            sender = AnalyticsSender(http, base = { BuildConfig.ANALYTICS_URL }),
            scope = scope,
            fields = { fields(app) },
            schedule = { delay -> schedule(app, delay) },
            unschedule = { cancel(app) },
            onLimits = onLimits,
        )
    }
}
