package app.penmoss.git

import android.content.Context
import android.net.Network
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.penmoss.engine.git.GitNotebookEntry
import app.penmoss.sync.DeviceConditions
import java.time.Duration

/*
 * Git notebooks in the background (T50 G8, A881). WorkManager runs each notebook's engine page in
 * its WebView (Kotlin never reads Yjs, A11): every 15 minutes, the platform's least (a periodic job
 * the system batches into its maintenance windows, deferred in Doze and by the app's standby
 * bucket), and soon after the app leaves the screen with something unpushed, or a capture is
 * stored (expedited, falling back to ordinary work when the app's quota is spent). Each run is
 * bounded (each notebook's sync at 90 s, the run well inside WorkManager's 10 minutes), so no
 * foreground-service notification is needed.
 */

/** What a git run needs from the app: the hub's run, and the phone's conditions. */
interface GitBackgroundHost {
    fun conditions(network: Network?): DeviceConditions

    /** One run over every notebook; per notebook, what it did. */
    suspend fun run(metered: Boolean, budgetMs: Long): List<Pair<String, String>>

    /** Whether any git notebook is on this phone: none, and the work stops. */
    fun any(): Boolean
}

/** What a run does under the phone's conditions (A881, as A322 was for the personal notes). */
sealed interface GitPlan {
    data class Skip(val why: String) : GitPlan

    data class Run(val metered: Boolean) : GitPlan

    companion object {
        fun decide(conditions: DeviceConditions): GitPlan = when {
            conditions.powerSave -> Skip("battery saver")
            conditions.metered && conditions.dataSaver -> Skip("data saver")
            else -> Run(conditions.metered)
        }
    }
}

class GitSyncWorker(
    context: Context,
    params: WorkerParameters,
    private val host: GitBackgroundHost,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (!host.any()) return Result.success(workDataOf(OUTCOME to "no git notebooks"))
        val plan = GitPlan.decide(host.conditions(network))
        if (plan is GitPlan.Skip) return Result.success(workDataOf(OUTCOME to "skipped: ${plan.why}"))
        plan as GitPlan.Run
        val outcomes = host.run(plan.metered, RUN_BUDGET_MS)
        val summary = outcomes.joinToString("; ") { (id, outcome) -> "${id.takeLast(6)}: $outcome" }
        // Offline is not a failure: the next run (or the network coming back) syncs.
        return Result.success(workDataOf(OUTCOME to summary.ifEmpty { "nothing to do" }))
    }

    companion object {
        const val OUTCOME = "outcome"

        /** A run's time for every notebook: well inside the 10 minutes WorkManager gives one. */
        const val RUN_BUDGET_MS = 8 * 60_000L
    }
}

/** Builds [GitSyncWorker]s with the app's host. */
class GitWorkerFactory(private val host: () -> GitBackgroundHost) : WorkerFactory() {
    override fun createWorker(appContext: Context, workerClassName: String, workerParameters: WorkerParameters): ListenableWorker? =
        if (workerClassName == GitSyncWorker::class.java.name) GitSyncWorker(appContext, workerParameters, host()) else null
}

/** Schedules the git runs (A881): the periodic one while there are notebooks, and one soon. */
class GitScheduler(private val workManager: () -> WorkManager) {
    /**
     * Every 15 minutes while a git notebook is on this phone, on any network (Wi-Fi only when
     * every notebook is Wi-Fi only); none once there are none. Kept as it is when it exists, so a
     * start never drops the run that started the process; updated when its network changes.
     */
    fun schedule(entries: List<GitNotebookEntry>) {
        if (entries.isEmpty()) {
            workManager().cancelUniqueWork(PERIODIC)
            workManager().cancelUniqueWork(SOON)
            return
        }
        val network = networkFor(entries)
        val existing = runCatching { workManager().getWorkInfosForUniqueWork(PERIODIC).get() }.getOrDefault(emptyList())
        val same = existing.any { info ->
            info.state != WorkInfo.State.CANCELLED && info.tags.contains(network.tag())
        }
        val policy = if (same) ExistingPeriodicWorkPolicy.KEEP else ExistingPeriodicWorkPolicy.UPDATE
        workManager().enqueueUniquePeriodicWork(PERIODIC, policy, periodicRequest(network))
    }

    /** One run soon: the app left the screen with something unpushed, or a capture was stored. */
    fun pushSoon() {
        workManager().enqueueUniqueWork(SOON, ExistingWorkPolicy.REPLACE, soonRequest())
    }

    companion object {
        const val PERIODIC = "penmoss.git.periodic"
        const val SOON = "penmoss.git.soon"
        const val TAG = "penmoss.git"

        /** Android's least period for periodic work, which Settings states (A825, #156). */
        val PERIOD: Duration = Duration.ofMinutes(15)
        val FLEX: Duration = Duration.ofMinutes(5)
        val BACKOFF: Duration = Duration.ofSeconds(30)

        fun of(context: Context) = GitScheduler { WorkManager.getInstance(context.applicationContext) }

        fun networkFor(entries: List<GitNotebookEntry>): NetworkType =
            if (entries.isNotEmpty() && entries.all { it.wifiOnly }) NetworkType.UNMETERED else NetworkType.CONNECTED

        private fun NetworkType.tag() = "$TAG.network.${name.lowercase()}"

        fun constraints(network: NetworkType): Constraints = Constraints.Builder()
            .setRequiredNetworkType(network)
            .setRequiresBatteryNotLow(true)
            .build()

        fun periodicRequest(network: NetworkType = NetworkType.CONNECTED): PeriodicWorkRequest =
            PeriodicWorkRequestBuilder<GitSyncWorker>(PERIOD, FLEX)
                .setConstraints(constraints(network))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF)
                .addTag(TAG)
                .addTag(network.tag())
                .build()

        /** Expedited where the quota allows; ordinary work otherwise (A881). Any network: a capture waits for one. */
        fun soonRequest(): OneTimeWorkRequest = OneTimeWorkRequestBuilder<GitSyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF)
            .addTag(TAG)
            .build()
    }
}
