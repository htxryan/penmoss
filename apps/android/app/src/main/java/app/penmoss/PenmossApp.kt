package app.penmoss

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class PenmossApp : Application(), Configuration.Provider {
    /** The app's graph (A1469): each git notebook's screens run on a [NotebookGraph] its hub builds. */
    lateinit var graph: DeviceGraph
        private set

    /** Robolectric tests of the activities run against a graph of their own (an in-memory database, a fake API). */
    @androidx.annotation.VisibleForTesting
    fun useGraph(replacement: DeviceGraph) {
        graph = replacement
    }

    /** WorkManager starts on demand with git notebooks' worker factory (T50 G8, A881); its default start-up is off in the manifest. */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(app.penmoss.git.GitWorkerFactory { graph.git })
            .build()

    override fun onCreate() {
        super.onCreate()
        // The app's own log (PEN-137): scrubbed, rotated and aged on this phone, whatever the answer below.
        app.penmoss.log.PenmossLog.install(this)
        // Usage analytics (PEN-137): recorded on this phone whatever the answer, sent only with it.
        val analytics = runCatching {
            app.penmoss.analytics.AnalyticsWork.create(
                this,
                okhttp3.OkHttpClient(),
                kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default),
                onLimits = app.penmoss.log.PenmossLog::applyLimits,
            )
        }.getOrNull()
        app.penmoss.analytics.Analytics.install(analytics)
        graph = DeviceGraph(this, analytics = analytics)
        analytics?.let { service ->
            app.penmoss.analytics.Analytics.record("app", "launch")
            graph.scope.launch(kotlinx.coroutines.Dispatchers.IO) {
                runCatching { service.followLimits() }
                runCatching { service.prune() }
            }
        }
        // What scrub #1 knows: the GitHub login, the notebooks' names, repositories and branches.
        graph.followLogNames()
        // What the Penmoss server's sign-in and sync left on a phone that had them (T59, A1041).
        ServerLeftovers.forget(this)
        graph.followJournalSettings()
        registerActivityLifecycleCallbacks(graph.activities)
        // Git notebooks' background runs follow the notebooks on this phone (G8); a phone that
        // never had one loads nothing of them.
        if (app.penmoss.git.GitNotebookHub.anyEver(this)) graph.git.scheduleWork()
        val connectivity = getSystemService(ConnectivityManager::class.java)
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                private var inFront: kotlinx.coroutines.Job? = null
                private var since = 0L

                override fun onStart(owner: LifecycleOwner) {
                    graph.cameToFront()
                    since = System.currentTimeMillis()
                    app.penmoss.analytics.Analytics.record("app", "foreground")
                    inFront?.cancel()
                    inFront = graph.analytics?.whileInFront()
                    runCatching {
                        connectivity ?: return@runCatching
                        val active = connectivity.activeNetwork
                        val validated = active?.let { connectivity.getNetworkCapabilities(it) }
                            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
                        graph.onlineAgain.registered(active, validated)
                        connectivity.registerDefaultNetworkCallback(graph.onlineAgain)
                    }
                }

                override fun onStop(owner: LifecycleOwner) {
                    runCatching { connectivity?.unregisterNetworkCallback(graph.onlineAgain) }
                    graph.leftScreen()
                    inFront?.cancel()
                    inFront = null
                    app.penmoss.analytics.Analytics.record(
                        "app",
                        "background",
                        mapOf("active" to app.penmoss.analytics.AnalyticsFormat.durationBucket(System.currentTimeMillis() - since)),
                    )
                    graph.analytics?.leftScreen()
                }
            },
        )
    }
}

val Context.graph: DeviceGraph get() = (applicationContext as PenmossApp).graph

/**
 * Tells the app a network came back while it is in front (A331): once the system has validated
 * it (it reaches the internet, so the pass does not fail on a captive portal or a network still
 * starting), and not the network that was already up when the app came to the front, which
 * that pass covers. Callbacks come on the system's thread; [onBack] only asks for a pass.
 */
class OnlineAgain(private val onBack: () -> Unit) : ConnectivityManager.NetworkCallback() {
    @Volatile
    private var current: Network? = null

    private val up = kotlinx.coroutines.flow.MutableStateFlow(true)

    /**
     * Whether a validated network is up, as far as the app has seen while in front (true until
     * it knows).
     */
    val online: kotlinx.coroutines.flow.StateFlow<Boolean> = up

    /** Called before registering: the network already up, if validated, is not news. */
    fun registered(active: Network?, validated: Boolean) {
        current = if (validated) active else null
        up.value = validated
    }

    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) || network == current) return
        current = network
        up.value = true
        onBack()
    }

    override fun onLost(network: Network) {
        if (network == current) {
            current = null
            up.value = false
        }
    }
}
