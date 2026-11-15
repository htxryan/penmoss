package app.penmoss

import android.content.Context
import app.penmoss.capture.Captures
import app.penmoss.data.Attachments
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.api.PenmossApi
import app.penmoss.editor.OpenEditors
import app.penmoss.engine.sync.SyncEngine
import app.penmoss.sync.FolderSender
import app.penmoss.sync.NoteFiler
import app.penmoss.sync.PassWork
import app.penmoss.sync.SettingsSender
import app.penmoss.sync.SyncCoordinator
import app.penmoss.sync.TrashSender
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import kotlin.coroutines.CoroutineContext

/**
 * One git notebook's graph (T50 G7, A880; architecture review A1, A1469): its own Room database,
 * files and notes server on the phone (the engine page's `LocalServer`, A874), so nothing
 * crosses notebooks (A826), and everything its screens use. It is built by the hub beside the
 * [device] graph, whose settings, hub, network and errors it shares.
 */
class NotebookGraph(
    context: Context,
    /** The app's graph: device settings (Appearance and the rest), the hub, recent errors. */
    val device: DeviceGraph,
    val database: PenmossDatabase,
    /** This notebook on the phone (its registry's id): its files are kept under it. */
    val localId: String,
    /** The notebook's own id, the same on every device. */
    val notebookId: String,
    val name: String,
    /** Its notes server on the phone. */
    internal val notesServer: HttpPenmossApi,
) {
    companion object {
        /**
         * A notebook graph's preference files, deleted with it: those an older version made for it
         * (its sign-in, mirror, closed notebooks and background files, never used).
         */
        fun gitPrefs(localId: String): List<String> =
            listOf("penmoss.vault", "penmoss.mirror", "penmoss.notebooks", "penmoss.session", "penmoss.background").map { "git.$localId.$it" }
    }

    // The device's, shared by every notebook's screens.
    val scope: CoroutineScope get() = device.scope
    val activities get() = device.activities
    val errors get() = device.errors
    val notePages get() = device.notePages
    val githubToken get() = device.githubToken
    val githubFeedback get() = device.githubFeedback
    val webPictures get() = device.webPictures
    val appearance get() = device.appearance
    val git get() = device.git
    val onlineAgain get() = device.onlineAgain

    /** As the device's: work no screen owns, its failure reported (A1467). */
    fun launchReporting(context: CoroutineContext = Dispatchers.IO, block: suspend CoroutineScope.() -> Unit) =
        device.launchReporting(context, block)

    /** A git notebook's files are its own (A826): under its local id. */
    private val filesRoot: File = File(context.filesDir, "git-graphs/$localId")
    private val cacheRoot: File = File(context.cacheDir, "git-graphs/$localId")

    private val appContext = context.applicationContext

    val api: PenmossApi = notesServer

    /** Send to…'s sessions (T60, A1076): the notebook's WorkspaceDoc, through its notes server. */
    val comments: app.penmoss.engine.api.PenmossCommentsApi = notesServer

    /** Delete for good (T40 P3a): the page asks the person first (A877). */
    val purge: app.penmoss.engine.api.PenmossPurgeApi = notesServer

    /** Each note's toggles as this phone left them (T40 P8, ED8): cleared with the cache. */
    val folds = app.penmoss.data.FoldStore(database.folds())

    /** The editor's pictures (A304): added here and waiting to upload, or fetched to show. */
    val attachments = Attachments(
        database.attachments(),
        dir = File(filesRoot, "attachments"),
        cache = File(cacheRoot, "attachments"),
        api = api,
        onAdded = { sync.requestSync() },
        metered = device.metered,
    )

    val store: NoteStore = NoteStore(database)

    /**
     * The notebook's own settings (Daily notes' templates and time zone) as the phone shows them
     * (T40 P1, A411): the last tree's, with the changes made here and not sent yet laid over them.
     * The device's are [DeviceGraph.settings].
     */
    val settings: StateFlow<NoteStore.SettingsState> = store.observeSettings()
        .stateIn(scope, SharingStarted.Eagerly, NoteStore.SettingsState())

    /** Changes one of the notebook's own settings (null: back to its default), sent by the next pass (A411). */
    fun changeSetting(key: String, value: JsonElement?) {
        scope.launch { if (store.changeSetting(key, value)) sync.requestSync() }
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
        // A run soon, even if the app closes now (G8).
        git.storedForLater()
    })

    /**
     * Feedback waiting to be sent, or refused (T49, A796): sent at Send, after each pass, when it
     * is retried, and as soon as a GitHub token is saved (A1012).
     */
    val feedbackOutbox: app.penmoss.feedback.FeedbackOutbox = app.penmoss.feedback.FeedbackOutbox(
        database.feedback(),
        File(filesRoot, "feedback/outbox"),
        device.githubFeedback,
        onRetry = {
            sync.requestSync()
            launchReporting { feedbackOutbox.sendDue() }
        },
    )

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
            gitNotebook = true,
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
            // The device's: only the app's graph hears the network (A331).
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

    /**
     * A thread was just sent to an agent session (T60, A1078): this notebook syncs now (Room's
     * pass, then the engine's commit, push and pull), with no push delay.
     */
    fun syncNotebookNow() {
        launchReporting { git.syncNow(localId) }
    }
}
