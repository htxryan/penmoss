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
import app.penmoss.auth.KeystoreSecretBox
import app.penmoss.auth.SecretBox
import app.penmoss.capture.Captures
import app.penmoss.data.Attachments
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.auth.PhoneOwnerCheck
import app.penmoss.auth.ResumedActivity
import app.penmoss.engine.api.PenmossApi
import app.penmoss.editor.NotePages
import app.penmoss.editor.OpenEditors
import app.penmoss.engine.sync.SyncEngine
import app.penmoss.sync.FolderSender
import app.penmoss.sync.NoteFiler
import app.penmoss.sync.PassWork
import app.penmoss.sync.SyncCoordinator
import app.penmoss.sync.SettingsSender
import app.penmoss.sync.TrashSender
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.engine.settings.ThemeEdits
import app.penmoss.ui.Appearance
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** Everything the screens share, built once per process. */
class AppGraph(
    context: Context,
    val database: PenmossDatabase = PenmossDatabase.open(context),
    box: SecretBox = KeystoreSecretBox(),
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    /** The activity on screen, which the owner check prompts over (A421). */
    val activities: ResumedActivity = ResumedActivity(),
    /** The errors this run met, for feedback's Recent errors (T49, A791): the app's, shared by every notebook's graph. */
    val errors: app.penmoss.feedback.RecentErrors = app.penmoss.feedback.RecentErrors(),
    /** What a note screen shows its note in: the editor's WebView; a stand-in in tests (T40 P7 review). */
    val notePages: NotePages = NotePages.Editor,
    /** No notes (the app's own graph), or one git notebook's (T50 G7, A880; T59, A1040). */
    val source: app.penmoss.git.GraphSource = app.penmoss.git.GraphSource.Device,
    /**
     * Where Send feedback files the issue (A1010): GitHub itself, a debug build's override, or a
     * fake GitHub in tests.
     */
    githubFeedbackConfig: app.penmoss.feedback.GitHubFeedbackConfig =
        app.penmoss.feedback.GitHubFeedbackConfig.forBuild(BuildConfig.DEBUG, BuildConfig.GITHUB_API, BuildConfig.GITHUB_UPLOADS),
    /** Git notebooks' owner check (A855, A877): BiometricPrompt with Kotlin's own words; a fake in tests. */
    gitOwner: app.penmoss.engine.git.OwnerConfirm = PhoneOwnerCheck.system(activities).let { check ->
        object : app.penmoss.engine.git.OwnerConfirm {
            override suspend fun confirm(words: String) = confirm(words) { true }

            // The request's own check, as late as the prompt allows (A887).
            override suspend fun confirm(words: String, live: () -> Boolean) = when (val answer = check.confirmWords(words, live)) {
                app.penmoss.auth.OwnerCheckResult.Confirmed -> app.penmoss.engine.git.OwnerAnswer.Confirmed
                is app.penmoss.auth.OwnerCheckResult.Refused -> app.penmoss.engine.git.OwnerAnswer.Refused(answer.reason)
            }
        }
    },
    /** The git notebooks' hub (T50 G7): the app's own, made on first use; tests give one with stand-in pages and keys. */
    makeHub: ((AppGraph) -> app.penmoss.git.GitNotebookHub)? = null,
) {
    /** A git notebook's graph: the app's graph it was built beside (T50 G7, A880); null for the app's own. */
    val main: AppGraph? = (source as? app.penmoss.git.GraphSource.Git)?.main

    /** The graph whose settings are the device's (Appearance and the rest; A827): the app's. */
    val device: AppGraph get() = main ?: this

    val isGit: Boolean get() = source is app.penmoss.git.GraphSource.Git

    companion object {}

    /** A git notebook's preferences and files are its own (A826): under its local id. */
    private val prefsPrefix = (source as? app.penmoss.git.GraphSource.Git)?.let { "git.${it.localId}." } ?: ""
    private val prefsOf: (String) -> android.content.SharedPreferences = { name -> context.getSharedPreferences(prefsPrefix + name, Context.MODE_PRIVATE) }
    private val filesRoot: File = (source as? app.penmoss.git.GraphSource.Git)?.let { File(context.filesDir, "git-graphs/${it.localId}") } ?: context.filesDir
    private val cacheRoot: File = (source as? app.penmoss.git.GraphSource.Git)?.let { File(context.cacheDir, "git-graphs/${it.localId}") } ?: context.cacheDir

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        // A whole request, however slowly its bytes trickle (A329): well inside the 10 minutes
        // WorkManager gives a run, so a slow uplink fails and retries instead of being killed.
        .callTimeout(3, TimeUnit.MINUTES)
        .build()

    /**
     * A git notebook's notes server on the phone (A874). The app's own graph has none (T59, A1040):
     * its API answers every request with an IOException, and its sync never starts.
     */
    private val httpApi = (source as? app.penmoss.git.GraphSource.Git)?.api ?: noNotesServer()

    /**
     * The person's GitHub token for Send feedback (A1012): the device's, one for the app and every
     * git notebook's screens, sealed by the Keystore and kept across sign-out.
     */
    val githubToken: app.penmoss.feedback.GitHubTokenStore = main?.githubToken
        ?: app.penmoss.feedback.GitHubTokenStore(context.getSharedPreferences(app.penmoss.feedback.GitHubTokenStore.PREFS, Context.MODE_PRIVATE), box)

    /**
     * Send feedback files the issue on GitHub from the phone with that token (A1010, A1011); no
     * Penmoss server takes part. One for the app, so a submission files once.
     */
    val githubFeedback: app.penmoss.feedback.GitHubFeedbackApi = main?.githubFeedback ?: app.penmoss.feedback.GitHubFeedbackApi(
        http,
        githubFeedbackConfig,
        token = githubToken::token,
        ledger = app.penmoss.feedback.PrefsFeedbackLedger(context.getSharedPreferences(app.penmoss.feedback.PrefsFeedbackLedger.PREFS, Context.MODE_PRIVATE)),
    )

    val api: PenmossApi = httpApi

    /** Send to…'s sessions (T60, A1076): the notebook's WorkspaceDoc, through its notes server. */
    val comments: app.penmoss.engine.api.PenmossCommentsApi = httpApi

    /** Delete for good (T40 P3a): in a git notebook the page asks the person first (A877). */
    val purge: app.penmoss.engine.api.PenmossPurgeApi = httpApi

    /** The notebooks closed on this phone (T43, A752): none in a git notebook (A912). */
    val closedNotebooks: app.penmoss.data.ClosedNotebooks = app.penmoss.data.ClosedNotebooks(
        prefsOf(app.penmoss.data.ClosedNotebooks.PREFS),
        workspace = { (source as? app.penmoss.git.GraphSource.Git)?.notebookId },
        inGitNotebook = isGit,
    )

    /** Each note's toggles as this phone left them (T40 P8, ED8): cleared with the cache. */
    val folds = app.penmoss.data.FoldStore(database.folds())

    /** Whether the network in use is metered (mobile data); true when unknown. */
    private val metered: () -> Boolean = {
        context.getSystemService(android.net.ConnectivityManager::class.java)?.isActiveNetworkMetered ?: true
    }

    /** The editor's pictures (A304): added here and waiting to upload, or fetched to show. */
    val attachments = Attachments(
        database.attachments(),
        dir = File(filesRoot, "attachments"),
        cache = File(cacheRoot, "attachments"),
        api = api,
        onAdded = { sync.requestSync() },
        metered = metered,
    )

    /**
     * Pictures from web addresses in notes (T40 P8, ED13): this phone's setting, fetched with
     * no cookies or token, public addresses only, kept in a 200 MB cache.
     */
    val webPictures = app.penmoss.editor.WebPictures(
        app.penmoss.editor.WebPictureSettings(context.getSharedPreferences(app.penmoss.editor.WebPictureSettings.PREFS, Context.MODE_PRIVATE)),
        app.penmoss.editor.RemotePictures(File(context.cacheDir, "remote")),
        metered = metered,
    )

    val store: NoteStore = NoteStore(database)

    /** The folders of the notebooks closed here (T43, A752): what the lists leave out. */
    val hiddenFolders: kotlinx.coroutines.flow.Flow<Set<String>> = store.observeHiddenFolders(closedNotebooks.closed)

    /** What a search covers with the notebooks closed here (T43, A752). */
    suspend fun notebookScope(): app.penmoss.data.NotebookScope = store.notebookScope(closedNotebooks.closed.value)

    init {
        // A token saved or replaced in Settings → About → GitHub Token sends what waited (A1012).
        if (main == null) githubToken.onChange { if (githubToken.hasToken) githubTokenSaved() }
    }

    /**
     * The synced settings as the phone shows them (T40 P1, A411): the last tree's, with the
     * changes made here and not sent yet laid over them.
     */
    val settings: StateFlow<NoteStore.SettingsState> = store.observeSettings()
        .stateIn(scope, SharingStarted.Eagerly, NoteStore.SettingsState())

    /**
     * The theme chosen in Settings → Appearance (A305): resolved here from the settings, so a
     * choice made on the phone shows at once (A412); from a server without the settings channel,
     * as the last pass brought it.
     */
    val appearance: StateFlow<Appearance> = main?.appearance ?: combine(store.observeAppearance(), store.observeSettings()) { stored, state ->
        if (state.known) {
            Appearance.of(ThemeCatalogue.bundled.resolve(state.settings)).copy(interfaceFont = state.settings.interfaceFont)
        } else {
            Appearance.parse(stored)
        }
    }.stateIn(scope, SharingStarted.Eagerly, Appearance())

    /**
     * Changes a setting (null: back to its default): on the app's graph a device setting, written
     * to the Journal notebook's device map (A1014); on a git notebook's, one of the notebook's own
     * (Daily notes), which the next pass sends to its notes server (A411).
     */
    fun changeSetting(key: String, value: JsonElement?) {
        scope.launch { setSettings(listOf(key to value)) }
    }

    /**
     * Changes settings in order, each shown at once: the device's to the Journal notebook's device
     * map (A1014), a notebook's to its own store, sent by the next pass. False when nothing could
     * take them (no Journal notebook, or its settings not read yet).
     */
    private suspend fun setSettings(changes: List<Pair<String, JsonElement?>>): Boolean {
        // Not read from the Journal notebook yet, or none: nothing changes.
        if (main == null) return journalSettings.value?.change(changes.toMap()) ?: false
        var any = false
        for ((key, value) in changes) {
            if (!store.changeSetting(key, value)) return any.also { if (it) sync.requestSync() }
            any = true
        }
        if (any) sync.requestSync()
        return any
    }

    /** The Journal notebook's device settings (A1014): null while there is no Journal notebook, or before it is read. */
    private val journalSettings = kotlinx.coroutines.flow.MutableStateFlow<app.penmoss.git.JournalDeviceSettings?>(null)

    /**
     * Follows the Journal notebook's device map (A1014): read again when the Journal notebook is
     * switched or a notebook is added or removed; pulled when the app comes to the front. The
     * app's graph only.
     */
    fun followJournalSettings() {
        if (main != null) return
        scope.launch {
            val hub = git
            combine(hub.list, hub.journalPick) { _, _ -> hub.journal() }.distinctUntilChanged().collectLatest { id ->
                journalSettings.value = null
                id ?: return@collectLatest
                val journal = runCatching { hub.graph(id) }.getOrNull() ?: return@collectLatest
                val api = (journal.source as? app.penmoss.git.GraphSource.Git)?.api ?: return@collectLatest
                val follower = app.penmoss.git.JournalDeviceSettings(store, journal.store) { set -> api.changeDeviceSettings(set).device }
                journalSettings.value = follower
                // Its tree carries the device map: a pass now reads it.
                journal.sync.requestSync()
                follower.follow()
            }
        }
    }

    /**
     * Duplicates [source] as a new custom theme of the user's and chooses it, as the web's
     * Duplicate does (T40 P1b, A417); returns its id, or null before the settings are read.
     */
    suspend fun duplicateTheme(source: JsonObject): String? {
        val catalogue = ThemeCatalogue.bundled
        val names = catalogue.all(store.settingsNow().settings).mapNotNull { (it["name"] as? JsonPrimitive)?.content }
        val id = ThemeEdits.newId()
        val name = ThemeEdits.copyName((source["name"] as? JsonPrimitive)?.content ?: "Theme", names)
        val theme = ThemeEdits.duplicate(source, id, name, catalogue)
        if (!setSettings(listOf(ThemeEdits.key(id) to theme, SettingKeys.THEME to JsonPrimitive(id)))) return null
        return id
    }

    /** Saves the theme editor's changes to a custom theme (A416). */
    fun saveTheme(theme: JsonObject) {
        val id = (theme["id"] as? JsonPrimitive)?.content ?: return
        changeSetting(ThemeEdits.key(id), theme)
    }

    /** Deletes a custom theme everywhere; if it is chosen, its base is chosen instead, as on the web. */
    fun deleteTheme(theme: JsonObject) {
        val id = (theme["id"] as? JsonPrimitive)?.content ?: return
        val deletion = ThemeEdits.deletion(theme, ThemeCatalogue.bundled)
        scope.launch {
            val chosen = store.settingsNow().settings.themeId == id
            setSettings(listOfNotNull(ThemeEdits.key(id) to deletion, (SettingKeys.THEME to deletion["base"]).takeIf { chosen }))
        }
    }

    /** Settings has said which changes the notes server refused; the person has read it. */
    fun dismissSettingsRefusal() {
        scope.launch { store.dismissSettingsRefusal() }
    }

    private val filer = NoteFiler(store, api)

    /** The copies of notes open editors may still send edits of (A309). */
    val openEditors = OpenEditors()

    /** Quick captures (T34): stored here, sent by each pass after the pictures they name. */
    val captures = Captures(database.captures(), store, attachments, api, onSaved = {
        sync.requestSync()
        // Into a git notebook (G8): a run soon, even if the app closes now; none goes to the server.
        if (main != null) git.storedForLater()
    })

    /**
     * Feedback waiting to be sent, or refused (T49, A796): sent at Send, after each pass, when the
     * app comes to the front, and as soon as a GitHub token is saved (A1012).
     */
    val feedbackOutbox = app.penmoss.feedback.FeedbackOutbox(
        database.feedback(),
        File(filesRoot, "feedback/outbox"),
        githubFeedback,
        onRetry = { sync.requestSync(); sendFeedbackSoon() },
    )

    /** Sends what feedback is due now, outside a sync pass (the app's own graph has none). */
    private fun sendFeedbackSoon() {
        scope.launch(Dispatchers.IO) { runCatching { feedbackOutbox.sendDue() } }
    }

    /**
     * A GitHub token was saved (A1012): every outbox on the phone, the app's and each git
     * notebook's open here, sends what waited for one.
     */
    private fun githubTokenSaved() {
        val graphs = listOf(this) + (gitIfAny?.madeGraphs().orEmpty())
        scope.launch(Dispatchers.IO) { for (graph in graphs) runCatching { graph.feedbackOutbox.tokenSaved() } }
    }

    private val work = PassWork(store, attachments, filer, openEditors, captures, SettingsSender(store, api), FolderSender(store, api), TrashSender(store, api), feedback = feedbackOutbox)

    /** Full-text search on the phone, offline too (T40 P6, FD4). */
    val offlineSearch = app.penmoss.data.OfflineSearch(database)

    val sync: SyncCoordinator = SyncCoordinator(
        scope = scope,
        engine = { engine },
        beforePass = work::beforePass,
        afterPass = work::afterPass,
        beforeNote = work::beforeNote,
        onFailure = { errors.report(it) },
    )

    private val engine = SyncEngine(api, store) { sync.publish(it) }

    private val appContext = context.applicationContext

    /**
     * Git notebooks on this phone (T50 G7, G8): the app's one hub; a git notebook's graph uses
     * the app's. Made on first use, so a phone without any never starts a page.
     */
    private val gitHub = lazy {
        main?.git ?: makeHub?.invoke(this) ?: app.penmoss.git.GitNotebookHub(
            appContext,
            main = { this },
            box = KeystoreSecretBox("penmoss.git-notebooks"),
            owner = gitOwner,
        )
    }
    val git: app.penmoss.git.GitNotebookHub by gitHub

    /** The hub if this phone has, or had, a git notebook; null loads nothing of them (lists, journal). */
    val gitIfAny: app.penmoss.git.GitNotebookHub?
        get() = if (main != null || gitHub.isInitialized() || app.penmoss.git.GitNotebookHub.anyEver(appContext)) git else null

    /**
     * Where Today, This week and captures go on this phone (A827): this git notebook's graph, or
     * from the app's, the git notebook picked as the Journal notebook (else the first one); null
     * with no git notebook on the phone.
     */
    fun journalGraph(): AppGraph? {
        if (main != null) return this
        val hub = gitIfAny ?: return null
        val id = runCatching { hub.journal() }.getOrNull() ?: return null
        return runCatching { hub.graph(id) }.getOrNull()
    }

    /** While the app is in front, a network coming back syncs at once (A321, A331). */
    val onlineAgain = OnlineAgain { sync.requestSync() }

    /** When a pass last ended well, for feedback's Sync group (T49). */
    private val lastSynced = java.util.concurrent.atomic.AtomicLong(0)

    /**
     * In-app feedback (T49, D41): the form's context, capture, draft and outbox. Its context
     * reads the app's state at the moment the form opens (A791).
     */
    val feedback: app.penmoss.feedback.FeedbackService = app.penmoss.feedback.FeedbackService(
        outbox = feedbackOutbox,
        drafts = app.penmoss.feedback.FeedbackDrafts(File(filesRoot, "feedback/draft")) { app.penmoss.engine.notes.Ulid.next() },
        collector = app.penmoss.feedback.FeedbackCollector(
            database,
            errors,
            names = store::names,
            app = {
                val shown = appearance.value
                app.penmoss.feedback.FeedbackAppFacts.of(
                    appContext,
                    feedbackVersion,
                    themeName = (shown.theme?.get("name") as? JsonPrimitive)?.content ?: "Penmoss",
                    mode = shown.mode,
                    dark = shown.isDark(app.penmoss.feedback.FeedbackAppFacts.systemDark(appContext)),
                )
            },
            sync = { feedbackSync() },
            gitNotebook = isGit,
        ),
        captures = File(cacheRoot, "feedback/capture"),
        version = feedbackVersion,
        scope = scope,
    )

    private val feedbackVersion: String get() = app.penmoss.feedback.FeedbackService.version(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)

    /** Sync as feedback's context says it (T49, A791): states and counts, no note's text. */
    private suspend fun feedbackSync(): app.penmoss.feedback.SyncFacts {
        val status = sync.status.value
        if (status is app.penmoss.sync.SyncStatus.Synced) lastSynced.set(status.at)
        val stop = sync.stop.value
        val state = when {
            stop != null -> "stopped (${stop::class.simpleName?.lowercase()})"
            status is app.penmoss.sync.SyncStatus.Idle -> "not synced yet"
            status is app.penmoss.sync.SyncStatus.Syncing -> "syncing"
            status is app.penmoss.sync.SyncStatus.Synced -> "synced"
            status is app.penmoss.sync.SyncStatus.Offline && status.serverError -> "server error"
            else -> "offline"
        }
        val failure = sync.lastFailure
        return app.penmoss.feedback.SyncFacts(
            online = onlineAgain.online.value,
            sync = state,
            socket = "none (git notebooks pull and push, A825)",
            lastSynced = lastSynced.get().takeIf { it > 0 },
            unsyncedNotes = database.feedback().unsyncedNotes(),
            outbox = attachments.waitingCount() + captures.waitingCount(),
            feedbackOutbox = feedbackOutbox.waitingCount(),
            // The kind and the API's code only: a message can quote anything.
            lastError = when (failure) {
                null -> "none"
                is app.penmoss.engine.api.ApiException -> listOfNotNull("HTTP ${failure.status}", failure.code).joinToString(" ")
                else -> failure::class.java.simpleName.ifEmpty { "error" }
            },
        )
    }

    /** Keeps the last good pass's time for feedback's context (T49). */
    fun followSyncTimes() {
        scope.launch { sync.status.collect { if (it is app.penmoss.sync.SyncStatus.Synced) lastSynced.set(it.at) } }
    }

    /** The app came to the front: each open notebook's own loop syncs now and every minute. */
    fun cameToFront() {
        sync.setForeground(true)
        // No pass runs on the app's own graph: feedback waiting since goes now (A1010).
        if (main == null) sendFeedbackSoon()
        // The device's settings live in the Journal notebook (A1014): pulled on focus, so another
        // device's change shows (the notebook's own screens pull it every minute while open).
        val hub = gitIfAny
        val id = hub?.journal()
        if (hub != null && id != null) scope.launch(Dispatchers.IO) { runCatching { hub.syncNow(id) } }
    }

    /**
     * A thread was just sent to an agent session (T60, A1078): this notebook syncs now (Room's
     * pass, then the engine's commit, push and pull), with no push delay. None for the app's own graph.
     */
    fun syncNotebookNow() {
        val notebook = source as? app.penmoss.git.GraphSource.Git ?: return
        val hub = main?.git ?: return
        scope.launch(Dispatchers.IO) { runCatching { hub.syncNow(notebook.localId) } }
    }

    /** The app left the screen: git notebooks sync what waits once, and a run follows soon for the rest (A825, G8). */
    fun leftScreen() {
        sync.setForeground(false)
        if (gitHub.isInitialized()) git.leftScreen()
    }

    /** No notes server, for the app's own graph (A1040): every request fails at once, on the phone. */
    private fun noNotesServer(): HttpPenmossApi = HttpPenmossApi(
        "https://device.invalid/",
        http.newBuilder().addInterceptor { throw java.io.IOException("The app's own graph has no notes server") }.build(),
    )
}

/** A git notebook's own graph and the names of what it keeps (T50 G7, A880). */
fun AppGraph.Companion.forGit(
    context: Context,
    main: AppGraph,
    database: PenmossDatabase,
    localId: String,
    notebookId: String,
    name: String,
    api: HttpPenmossApi,
): AppGraph = AppGraph(
    context,
    database = database,
    scope = main.scope,
    activities = main.activities,
    errors = main.errors,
    notePages = main.notePages,
    source = app.penmoss.git.GraphSource.Git(localId, notebookId, name, main, api),
)

/**
 * A git notebook graph's preference files, deleted with it: its closed notebooks, and those an
 * older version made for it (its sign-in, mirror and background files, never used).
 */
fun AppGraph.Companion.gitPrefs(localId: String): List<String> =
    listOf("penmoss.vault", "penmoss.mirror", app.penmoss.data.ClosedNotebooks.PREFS, "penmoss.session", "penmoss.background").map { "git.$localId.$it" }

class PenmossApp : Application(), Configuration.Provider {
    lateinit var graph: AppGraph
        private set

    /** Robolectric tests of the activities run against a graph of their own (an in-memory database, a fake API). */
    @androidx.annotation.VisibleForTesting
    fun useGraph(replacement: AppGraph) {
        graph = replacement
    }

    /** WorkManager starts on demand with git notebooks' worker factory (T50 G8, A881); its default start-up is off in the manifest. */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(app.penmoss.git.GitWorkerFactory { graph.git })
            .build()

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        // What the Penmoss server's sign-in and sync left on a phone that had them (T59, A1041).
        ServerLeftovers.forget(this)
        graph.followSyncTimes()
        graph.followJournalSettings()
        registerActivityLifecycleCallbacks(graph.activities)
        // Git notebooks' background runs follow the notebooks on this phone (G8); a phone that
        // never had one loads nothing of them.
        if (app.penmoss.git.GitNotebookHub.anyEver(this)) graph.git.scheduleWork()
        val connectivity = getSystemService(ConnectivityManager::class.java)
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    graph.cameToFront()
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
                }
            },
        )
    }
}

val Context.graph: AppGraph get() = (applicationContext as PenmossApp).graph

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
     * it knows): Search skips its pause offline (T40 P6, review nit).
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
