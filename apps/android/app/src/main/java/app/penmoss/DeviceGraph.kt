package app.penmoss

import android.content.Context
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.SettingsStore
import app.penmoss.editor.NotePages
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.engine.settings.ThemeEdits
import app.penmoss.security.KeystoreSecretBox
import app.penmoss.security.PhoneOwnerCheck
import app.penmoss.security.ResumedActivity
import app.penmoss.security.SecretBox
import app.penmoss.ui.common.Appearance
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.coroutines.CoroutineContext

/**
 * The app's graph, one per process (architecture review A1, A1469): what belongs to the phone
 * rather than to a notebook. The device's settings (a mirror of the Journal notebook's device
 * map, A1014), the theme they resolve to, Send feedback's GitHub token, pictures from the web,
 * the git notebooks' hub, the network, and the errors this run met. It holds no notes: each git
 * notebook's screens run on its own [NotebookGraph], built beside this one by the hub.
 */
class DeviceGraph(
    context: Context,
    /**
     * The phone's own database (`penmoss.db`): the device settings' mirror and feedback that was
     * waiting before T59 only. The personal notes it kept are left untouched (A1041).
     */
    val database: PenmossDatabase = PenmossDatabase.open(context),
    box: SecretBox = KeystoreSecretBox(),
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    /** The activity on screen, which the owner check prompts over (A421). */
    val activities: ResumedActivity = ResumedActivity(),
    /** The errors this run met, for feedback's Recent errors (T49, A791): shared by every notebook's graph. */
    val errors: app.penmoss.feedback.RecentErrors = app.penmoss.feedback.RecentErrors(),
    /** What a note screen shows its note in: the editor's WebView; a stand-in in tests (T40 P7 review). */
    val notePages: NotePages = NotePages.Editor,
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
                app.penmoss.security.OwnerCheckResult.Confirmed -> app.penmoss.engine.git.OwnerAnswer.Confirmed
                is app.penmoss.security.OwnerCheckResult.Refused -> app.penmoss.engine.git.OwnerAnswer.Refused(answer.reason)
            }
        }
    },
    /** The git notebooks' hub (T50 G7): the app's own, made on first use; tests give one with stand-in pages and keys. */
    makeHub: ((DeviceGraph) -> app.penmoss.git.GitNotebookHub)? = null,
) {
    private val appContext = context.applicationContext

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(3, TimeUnit.MINUTES)
        .build()

    /**
     * The person's GitHub token for Send feedback (A1012): the device's, one for the app and every
     * git notebook's screens, sealed by the Keystore and kept across sign-out.
     */
    val githubToken: app.penmoss.feedback.GitHubTokenStore =
        app.penmoss.feedback.GitHubTokenStore(context.getSharedPreferences(app.penmoss.feedback.GitHubTokenStore.PREFS, Context.MODE_PRIVATE), box)

    /**
     * Send feedback files the issue on GitHub from the phone with that token (A1010, A1011); no
     * Penmoss server takes part. One for the app, so a submission files once.
     */
    val githubFeedback: app.penmoss.feedback.GitHubFeedbackApi = app.penmoss.feedback.GitHubFeedbackApi(
        http,
        githubFeedbackConfig,
        token = githubToken::token,
        ledger = app.penmoss.feedback.PrefsFeedbackLedger(context.getSharedPreferences(app.penmoss.feedback.PrefsFeedbackLedger.PREFS, Context.MODE_PRIVATE)),
    )

    /** Whether the network in use is metered (mobile data); true when unknown. */
    val metered: () -> Boolean = {
        context.getSystemService(android.net.ConnectivityManager::class.java)?.isActiveNetworkMetered ?: true
    }

    /**
     * Pictures from web addresses in notes (T40 P8, ED13): this phone's setting, fetched with
     * no cookies or token, public addresses only, kept in a 200 MB cache.
     */
    val webPictures = app.penmoss.editor.WebPictures(
        app.penmoss.editor.WebPictureSettings(context.getSharedPreferences(app.penmoss.editor.WebPictureSettings.PREFS, Context.MODE_PRIVATE)),
        app.penmoss.editor.RemotePictures(File(context.cacheDir, "remote")),
        metered = metered,
    )

    /** The device's settings as the screens read them: the Journal notebook's device map, laid here (A1014). */
    val store: SettingsStore = SettingsStore(database)

    /** The device's settings as the phone shows them (T40 P1, A411); the defaults until they are read. */
    val settings: StateFlow<SettingsStore.SettingsState> = store.observeSettings()
        .stateIn(scope, SharingStarted.Eagerly, SettingsStore.SettingsState())

    /**
     * The theme chosen in Settings → Appearance (A305): resolved here from the device's settings,
     * so a choice made on the phone shows at once (A412); the defaults until they are read.
     */
    val appearance: StateFlow<Appearance> = store.observeSettings().map { state ->
        Appearance.of(ThemeCatalogue.bundled.resolve(state.settings)).copy(interfaceFont = state.settings.interfaceFont)
    }.stateIn(scope, SharingStarted.Eagerly, Appearance())

    /** Changes a device setting (null: back to its default), written to the Journal notebook's device map (A1014). */
    fun changeSetting(key: String, value: JsonElement?) {
        scope.launch { setSettings(listOf(key to value)) }
    }

    /**
     * Changes device settings, each shown at once, in the Journal notebook's device map (A1014).
     * False when nothing could take them: no Journal notebook, or its settings not read yet.
     */
    private suspend fun setSettings(changes: List<Pair<String, JsonElement?>>): Boolean =
        journalSettings.value?.change(changes.toMap()) ?: false

    /** The Journal notebook's device settings (A1014): null while there is no Journal notebook, or before it is read. */
    private val journalSettings = MutableStateFlow<app.penmoss.git.JournalDeviceSettings?>(null)

    /**
     * Follows the Journal notebook's device map (A1014): read again when the Journal notebook is
     * switched or a notebook is added or removed; pulled when the app comes to the front.
     */
    fun followJournalSettings() {
        scope.launch {
            val hub = git
            combine(hub.list, hub.journalPick) { _, _ -> hub.journal() }.distinctUntilChanged().collectLatest { id ->
                journalSettings.value = null
                id ?: return@collectLatest
                val journal = app.penmoss.engine.attempt { hub.graph(id) }.getOrNull() ?: return@collectLatest
                val follower = app.penmoss.git.JournalDeviceSettings(store, journal.store.settings) { set ->
                    journal.notesServer.changeDeviceSettings(set).device
                }
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

    /**
     * Feedback that was waiting in the phone's own database (T49, A796; A1010): no notebook's
     * pass sends it, so it goes when the app comes to the front and when a GitHub token is saved.
     * New feedback waits in the notebook's graph it was sent from.
     */
    val feedbackOutbox = app.penmoss.feedback.FeedbackOutbox(
        database.feedback(),
        File(context.filesDir, "feedback/outbox"),
        githubFeedback,
        onRetry = { sendFeedbackSoon() },
    )

    init {
        // A token saved or replaced in Settings → About → GitHub Token sends what waited (A1012).
        githubToken.onChange { if (githubToken.hasToken) githubTokenSaved() }
    }

    /**
     * Starts work no screen owns (a sync, an outbox's send) on the process scope, and reports a
     * failure to [errors], which feedback's context lists (A791, review A11). Cancellation is not a
     * failure, and nor is being offline. Work a screen starts for itself belongs on the screen's
     * own scope.
     */
    fun launchReporting(context: CoroutineContext = Dispatchers.IO, block: suspend CoroutineScope.() -> Unit): Job =
        scope.launch(context) { app.penmoss.engine.attempt { block() }.onFailure(::reportUnlessOffline) }

    /** A failure for [errors], unless it is only the network being away (A791 leaves those out). */
    fun reportUnlessOffline(error: Throwable) {
        if (error !is java.io.IOException) errors.report(error)
    }

    private fun sendFeedbackSoon() {
        launchReporting { feedbackOutbox.sendDue() }
    }

    /**
     * A GitHub token was saved (A1012): every outbox on the phone, the app's and each git
     * notebook's open here, sends what waited for one.
     */
    private fun githubTokenSaved() {
        val outboxes = listOf(feedbackOutbox) + gitIfAny?.madeGraphs().orEmpty().map { it.feedbackOutbox }
        // One outbox that fails does not keep the others from sending.
        for (outbox in outboxes) launchReporting { outbox.tokenSaved() }
    }

    /**
     * Git notebooks on this phone (T50 G7, G8): the app's one hub. Made on first use, so a phone
     * without any never starts a page.
     */
    private val gitHub = lazy {
        makeHub?.invoke(this) ?: app.penmoss.git.GitNotebookHub(
            appContext,
            main = { this },
            box = KeystoreSecretBox("penmoss.git-notebooks"),
            owner = gitOwner,
        )
    }
    val git: app.penmoss.git.GitNotebookHub by gitHub

    /** The hub if this phone has, or had, a git notebook; null loads nothing of them (lists, journal). */
    val gitIfAny: app.penmoss.git.GitNotebookHub?
        get() = if (gitHub.isInitialized() || app.penmoss.git.GitNotebookHub.anyEver(appContext)) git else null

    /**
     * Whether a validated network is up, as feedback's context says it (A331). The device has
     * nothing of its own to sync when one comes back: each open notebook's screens sync every
     * minute (A825).
     */
    val onlineAgain = OnlineAgain {}

    /** The app came to the front: feedback that waited goes, and the Journal notebook pulls the device's settings. */
    fun cameToFront() {
        sendFeedbackSoon()
        // The device's settings live in the Journal notebook (A1014): pulled on focus, so another
        // device's change shows (the notebook's own screens pull it every minute while open).
        val hub = gitIfAny
        val id = hub?.journal()
        if (hub != null && id != null) launchReporting { hub.syncNow(id) }
    }

    /** The app left the screen: git notebooks sync what waits once, and a run follows soon for the rest (A825, G8). */
    fun leftScreen() {
        if (gitHub.isInitialized()) git.leftScreen()
    }
}
