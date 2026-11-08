package app.penmoss.git

import android.content.Context
import android.net.Network
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.workDataOf
import app.penmoss.engine.git.GitNotebookEntry
import app.penmoss.sync.DeviceConditions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * Git notebooks in the background (T50 G8, A881): what a run does under the phone's conditions,
 * and the work WorkManager holds: every 15 minutes while there are notebooks, Wi-Fi only when
 * every one is, none once they are gone, and one soon (expedited) after the app leaves with
 * changes or a capture is stored.
 */
@RunWith(AndroidJUnit4::class)
class GitBackgroundTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var workManager: WorkManager
    private val scheduler get() = GitScheduler { workManager }

    private class Host(var conditions: DeviceConditions, var notebooks: Boolean = true) : GitBackgroundHost {
        val runs = mutableListOf<Pair<Boolean, Long>>()

        override fun conditions(network: Network?) = conditions

        override suspend fun run(metered: Boolean, budgetMs: Long): List<Pair<String, String>> {
            runs += metered to budgetMs
            return listOf("01JBL0000000000000000000L1" to "synced", "01JBL0000000000000000000L2" to "wifi-only")
        }

        override fun any() = notebooks
    }

    private val wifi = DeviceConditions(powerSave = false, metered = false, dataSaver = false)
    private val mobile = DeviceConditions(powerSave = false, metered = true, dataSaver = false)

    private fun entry(id: String, wifiOnly: Boolean = false) =
        GitNotebookEntry(localId = id, notebookId = "01JBN0000000000000000000N1", name = "Work", remote = "https://github.com/htxryan/notes", wifiOnly = wifiOnly)

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(context, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        workManager = WorkManager.getInstance(context)
    }

    private fun run(host: GitBackgroundHost): ListenableWorker.Result = runBlocking {
        TestListenableWorkerBuilder<GitSyncWorker>(context).setWorkerFactory(GitWorkerFactory { host }).build().doWork()
    }

    @Test
    fun aRunSyncsEveryNotebookWithinItsTimeAndSaysWhatEachDid() {
        val host = Host(wifi)
        assertEquals(ListenableWorker.Result.success(workDataOf(GitSyncWorker.OUTCOME to "0000L1: synced; 0000L2: wifi-only")), run(host))
        assertEquals(listOf(false to GitSyncWorker.RUN_BUDGET_MS), host.runs)
        // Inside the 10 minutes WorkManager gives a run, so no foreground service is needed.
        assertTrue(GitSyncWorker.RUN_BUDGET_MS < TimeUnit.MINUTES.toMillis(10))
        // On mobile data the run says so, and Wi-Fi only notebooks wait.
        val metered = Host(mobile)
        run(metered)
        assertEquals(listOf(true to GitSyncWorker.RUN_BUDGET_MS), metered.runs)
    }

    @Test
    fun batterySaverDataSaverOnMobileAndNoNotebooksSkipTheRun() {
        assertEquals(GitPlan.Skip("battery saver"), GitPlan.decide(wifi.copy(powerSave = true)))
        assertEquals(GitPlan.Skip("data saver"), GitPlan.decide(mobile.copy(dataSaver = true)))
        assertEquals(GitPlan.Run(false), GitPlan.decide(wifi.copy(dataSaver = true)))
        val saver = Host(wifi.copy(powerSave = true))
        assertEquals(ListenableWorker.Result.success(workDataOf(GitSyncWorker.OUTCOME to "skipped: battery saver")), run(saver))
        assertTrue(saver.runs.isEmpty())
        val none = Host(wifi, notebooks = false)
        assertEquals(ListenableWorker.Result.success(workDataOf(GitSyncWorker.OUTCOME to "no git notebooks")), run(none))
        assertTrue(none.runs.isEmpty())
    }

    @Test
    fun theWorkRunsEveryFifteenMinutesWhileThereAreNotebooksAndStopsWithThem() {
        scheduler.schedule(listOf(entry("01JBL0000000000000000000L1"), entry("01JBL0000000000000000000L2", wifiOnly = true)))
        val periodic = workManager.getWorkInfosForUniqueWork(GitScheduler.PERIODIC).get().single()
        assertEquals(WorkInfo.State.ENQUEUED, periodic.state)
        assertEquals(TimeUnit.MINUTES.toMillis(15), periodic.periodicityInfo!!.repeatIntervalMillis)
        assertEquals(NetworkType.CONNECTED, periodic.constraints.requiredNetworkType)
        assertTrue(periodic.constraints.requiresBatteryNotLow())
        // Scheduled again at each start, it is kept as it is: the run that started the process stays.
        scheduler.schedule(listOf(entry("01JBL0000000000000000000L1")))
        assertEquals(periodic.id, workManager.getWorkInfosForUniqueWork(GitScheduler.PERIODIC).get().single().id)
        // Every notebook Wi-Fi only: the work waits for an unmetered network.
        scheduler.schedule(listOf(entry("01JBL0000000000000000000L1", wifiOnly = true)))
        val unmetered = workManager.getWorkInfosForUniqueWork(GitScheduler.PERIODIC).get().single { it.state == WorkInfo.State.ENQUEUED }
        assertEquals(NetworkType.UNMETERED, unmetered.constraints.requiredNetworkType)
        // None left: nothing runs.
        scheduler.schedule(emptyList())
        assertTrue(workManager.getWorkInfosForUniqueWork(GitScheduler.PERIODIC).get().all { it.state == WorkInfo.State.CANCELLED })
    }

    @Test
    fun soonIsExpeditedWhereTheQuotaAllowsAndWaitsForANetwork() {
        val request = GitScheduler.soonRequest()
        assertTrue(request.workSpec.expedited)
        assertEquals(androidx.work.OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST, request.workSpec.outOfQuotaPolicy)
        assertEquals(NetworkType.CONNECTED, request.workSpec.constraints.requiredNetworkType)
        scheduler.pushSoon()
        scheduler.pushSoon()
        // One waits at a time: a second replaces the first.
        assertEquals(1, workManager.getWorkInfosForUniqueWork(GitScheduler.SOON).get().count { it.state != WorkInfo.State.CANCELLED })
    }
}
