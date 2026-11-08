package app.penmoss.git

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.core.content.edit
import app.penmoss.AppGraph
import app.penmoss.forGit
import app.penmoss.gitPrefs
import app.penmoss.auth.SecretBox
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.CommitPurges
import app.penmoss.engine.git.GitEngine
import app.penmoss.engine.git.GitEngineStatus
import app.penmoss.engine.git.GitGuard
import app.penmoss.engine.git.GitIdentity
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.engine.git.GitNotebooks
import app.penmoss.engine.git.GitRecovery
import app.penmoss.engine.git.GitRefusal
import app.penmoss.engine.git.LocalGitApi
import app.penmoss.engine.git.OwnerAsks
import app.penmoss.engine.git.OwnerConfirm
import app.penmoss.engine.git.PageGuard
import app.penmoss.engine.git.PendingPurge
import app.penmoss.engine.git.SecretSeal
import app.penmoss.sync.PassOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import java.io.File
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/**
 * Git notebooks on this phone (T50 G7, G8; A870–A889): the registry and its checks
 * ([GitNotebooks], with JGit), each open notebook's engine page and its own [AppGraph] (its own
 * Room database, its notes server through [LocalGitApi]), the commit check page, and the runs the
 * app and WorkManager make.
 *
 * The page is trusted with nothing the app checks: git calls go through [GitNotebooks.op], the
 * owner checks are Kotlin's words through [OwnerConfirm] (BiometricPrompt, device credential
 * allowed), and a page may ask for one only while the app's own request for it runs (A877).
 */
class GitNotebookHub(
    private val context: Context,
    /** The app's graph: every notebook's graph is built beside it, and the main one is told of changes. */
    private val main: () -> AppGraph,
    box: SecretBox,
    owner: OwnerConfirm,
    /** This phone's git notebook choices: the git identity, the Journal notebook (not secret). */
    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE),
    /** The pages: WebViews in the app; tests give their own. */
    private val pages: Pages = Pages.WebViews(context),
    private val scheduler: GitScheduler = GitScheduler.of(context),
    /** This phone's commit-signing key (#172, A921): the Keystore's; tests give a software one. */
    private val signingKeys: app.penmoss.engine.git.CommitKeyStore? = KeystoreCommitKeys(),
    /**
     * Builds a notebook's graph from its local id, notebook id and name; null builds the app's
     * own (its database file, its page's notes server). Tests give one in memory and offline.
     */
    private val makeGraph: ((localId: String, notebookId: String, name: String) -> AppGraph)? = null,
) : GitBackgroundHost {
    /** Makes the engine and guard pages: the app's WebViews, or a test's stand-in. */
    fun interface Pages {
        fun open(role: String, onGone: () -> Unit): app.penmoss.engine.git.FramePort

        class WebViews(private val context: Context) : Pages {
            override fun open(role: String, onGone: () -> Unit) = GitPages.open(context, role, onGone)
        }
    }

    /**
     * The hub's work and its pages' calls. A failure in one (a page gone mid-answer, a sync that
     * threw) is logged and stays there: the supervisor keeps the others, and the handler keeps it
     * from the thread's uncaught handler, which would end the app.
     */
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO + LOGGED)
    val label: String = deviceLabel(Build.MODEL ?: "")

    /** The token and writer secrets, sealed with a Keystore key of their own (A857). */
    private val seal = object : SecretSeal {
        override fun seal(plain: String): String? = runCatching { Base64.getEncoder().encodeToString(box.seal(plain.toByteArray())) }.getOrNull()

        override fun unseal(sealed: String): String? = runCatching { String(box.open(Base64.getMimeDecoder().decode(sealed))) }.getOrNull()
    }

    private val guard = HubGuard()

    val notebooks: GitNotebooks = GitNotebooks(
        dir = File(context.filesDir, "git-notebooks"),
        seal = seal,
        owner = owner,
        guard = guard,
        identity = ::identity,
        signingKeys = signingKeys,
    )

    private val listed = MutableStateFlow<List<GitNotebookView>>(emptyList())

    /** The notebooks on this phone, as Settings and Home list them. */
    val list: StateFlow<List<GitNotebookView>> = listed.asStateFlow()

    private val sources = ConcurrentHashMap<String, Source>()

    private val statusMap = MutableStateFlow<Map<String, GitEngineStatus>>(emptyMap())

    /** Each open notebook's sync status, by local id (Settings and Home). */
    val statuses: StateFlow<Map<String, GitEngineStatus>> = statusMap.asStateFlow()

    private val recoveryMap = MutableStateFlow(readRecoveries())

    /**
     * Notes brought back after Android cleared a notebook's engine store (A886), by local id,
     * until the person dismisses the notice: Settings and the notebook's Sync say so.
     */
    val recoveries: StateFlow<Map<String, GitRecoveryNotice>> = recoveryMap.asStateFlow()

    private val keptMap = MutableStateFlow<Map<String, Boolean?>>(emptyMap())

    /** Whether each open notebook's store is kept under low storage (`navigator.storage.persist()`, A886). */
    val storageKept: StateFlow<Map<String, Boolean?>> = keptMap.asStateFlow()

    private val oldCopiesMap = MutableStateFlow<Map<String, GitOldCopies>>(emptyMap())

    /** Room's copies from before each notebook's store was cleared, waiting or kept (A886). */
    val oldCopies: StateFlow<Map<String, GitOldCopies>> = oldCopiesMap.asStateFlow()

    private val withheldMap = MutableStateFlow<Map<String, List<WithheldView>>>(emptyMap())

    /**
     * Copies withheld from the push (A886), by local id: brought back, their original then deleted
     * for good on another device. Kept on this phone only until the person saves their text,
     * deletes them for good or keeps and syncs them (Settings and the notebook's Sync).
     */
    val withheld: StateFlow<Map<String, List<WithheldView>>> = withheldMap.asStateFlow()

    /** Reads the withheld copies of [localId] again, for Settings and Sync. */
    suspend fun readWithheld(localId: String) {
        val source = sources[localId] ?: return
        val copies = runCatching { RoomOldCopies(source.graph.database).withheld() }.getOrNull() ?: return
        val views = copies.map { WithheldView(it.noteId, it.title) }
        withheldMap.update { if (views.isEmpty()) it - localId else it + (localId to views) }
    }

    private suspend fun withheldCopy(localId: String, noteId: String): Pair<Source, app.penmoss.engine.git.WithheldCopy> {
        val source = source(localId)
        val copy = RoomOldCopies(source.graph.database).withheld().firstOrNull { it.noteId == noteId }
            ?: throw GitRefusal("not_found", "That copy is no longer kept on this phone.")
        return source to copy
    }

    /** Save their text (A886): every withheld copy, what was typed on it included, as markdown into [out]. */
    suspend fun saveWithheld(localId: String, out: java.io.OutputStream) {
        val source = source(localId)
        val engine = source.engine()
        val copies = RoomOldCopies(source.graph.database).withheld()
        out.write(GitRecovery(engine, RoomOldCopies(source.graph.database)).exportWithheld(copies).toByteArray(Charsets.UTF_8))
    }

    /**
     * Delete for good of a withheld copy (A886): the owner check names it; then it is gone from the
     * phone. It was never pushed, so nothing goes to git.
     */
    suspend fun dropWithheld(localId: String, noteId: String) {
        val (source, copy) = withheldCopy(localId, noteId)
        notebooks.confirmDropCopy(localId, noteId, copy.title)
        RoomOldCopies(source.graph.database).drop(noteId)
        runCatching { source.opened()?.forgetCopy(noteId) }
        readWithheld(localId)
    }

    /**
     * Keep and sync (A886): the owner check names the copy; then it goes back in the notebook with
     * everything typed on it, and the next sync pushes it as a new note, which the commit check
     * lets through for that copy only.
     */
    suspend fun keepWithheld(localId: String, noteId: String) {
        val (source, copy) = withheldCopy(localId, noteId)
        notebooks.confirmKeepCopy(localId, noteId, copy.title)
        source.engine().keepCopy(copy)
        // The page has it whole now: Room's rows of it go, and Room lists it afresh.
        RoomOldCopies(source.graph.database).drop(noteId)
        readWithheld(localId)
        io.launch { runCatching { source.syncNow() } }
    }

    private fun readRecoveries(): Map<String, GitRecoveryNotice> =
        prefs.all.filterKeys { it.startsWith(RECOVERED) }.mapNotNull { (key, value) ->
            val notice = (value as? String)?.let { runCatching { GitRecoveryNotice.decode(it) }.getOrNull() } ?: return@mapNotNull null
            key.removePrefix(RECOVERED) to notice
        }.toMap()

    private fun notice(localId: String, change: (GitRecoveryNotice) -> GitRecoveryNotice?) {
        synchronized(recoveryMap) {
            val next = change(recoveryMap.value[localId] ?: GitRecoveryNotice(System.currentTimeMillis(), emptyList()))
            if (next == null || (next.titles.isEmpty() && next.unrecovered.isEmpty())) {
                prefs.edit { remove(RECOVERED + localId) }
                recoveryMap.update { it - localId }
            } else {
                prefs.edit { putString(RECOVERED + localId, next.encode()) }
                recoveryMap.update { it + (localId to next) }
            }
        }
    }

    /** One more note brought back (A886), kept with the notebook's notice. */
    private fun recovered(localId: String, title: String) = notice(localId) { it.copy(titles = it.titles + title, quiet = false) }

    /** The copies a pass could not bring back (A886): the notice names them, again if they changed. */
    private fun unrecovered(localId: String, titles: List<String>) = notice(localId) {
        if (it.unrecovered == titles) it else it.copy(unrecovered = titles, quiet = false)
    }

    /** The person read the notice: copies still kept stay named, quietly, until something changes. */
    fun dismissRecovery(localId: String) = notice(localId) { if (it.unrecovered.isEmpty()) null else it.copy(titles = emptyList(), quiet = true) }

    /**
     * Save their text (A886): what can be read of each of Room's old copies, waiting for a sync or
     * kept after they could not be brought back, as markdown into [out]. The copies stay in Room.
     */
    suspend fun saveUnrecovered(localId: String, out: java.io.OutputStream) {
        val source = source(localId)
        val engine = source.engine()
        val copies = RoomOldCopies(source.graph.database)
        val old = copies.before(engine.epoch ?: throw GitRefusal("not_open", "The notebook is not open."))
        val recovery = GitRecovery(engine, copies)
        out.write(recovery.export(old).toByteArray(Charsets.UTF_8))
        // And the copies kept on this phone only (A886): Remove loses them too.
        val withheld = copies.withheld()
        if (withheld.isNotEmpty()) out.write(("\n" + recovery.exportWithheld(withheld)).toByteArray(Charsets.UTF_8))
    }

    init {
        notebooks.onChange { refresh() }
        io.launch { refresh() }
    }

    private fun refresh() {
        listed.value = runCatching { notebooks.list() }.getOrDefault(emptyList())
    }

    // --- this phone's choices ---

    /** Who commits from this phone (A825): Settings → Git notebooks, or the device's name. */
    fun identity(): GitIdentity {
        val name = prefs.getString(NAME, null)?.trim().orEmpty()
        val email = prefs.getString(EMAIL, null)?.trim().orEmpty()
        return if (name.isNotEmpty() && email.isNotEmpty()) GitIdentity(name, email) else GitIdentity.fallback(label)
    }

    fun identitySet(): Pair<String, String> = prefs.getString(NAME, "").orEmpty() to prefs.getString(EMAIL, "").orEmpty()

    fun setIdentity(name: String, email: String) {
        val cleanName = name.trim().take(200)
        val cleanEmail = email.trim().take(200)
        require(cleanEmail.isEmpty() || EMAIL_SHAPE.matches(cleanEmail)) { "That is not an email address git takes." }
        require(cleanName.none { it.isISOControl() || it == '<' || it == '>' }) { "A name can't hold < or >." }
        prefs.edit {
            putString(NAME, cleanName)
            putString(EMAIL, cleanEmail)
        }
    }

    /**
     * The Journal notebook (A827): where Today, This week and captures go on this phone. The one
     * the person picked, else the first git notebook; null with none (A1040). A pick of the
     * personal notes, kept from before T59, counts as no pick.
     */
    fun journal(): String? {
        val picked = prefs.getString(JOURNAL, null)
        // From the registry itself: a capture sheet may ask before the list is first read.
        val ids = notebooks.entries().map { it.localId }
        return picked?.takeIf { it in ids } ?: ids.firstOrNull()
    }

    /**
     * The notebook to open [noteId] in, for a `penmoss://note/<id>` link (A1040): the one whose
     * notes include it, else the Journal notebook; null with no notebook.
     */
    suspend fun notebookOfNote(noteId: String): String? {
        val ids = notebooks.entries().map { it.localId }
        return ids.firstOrNull { id -> holds(id, noteId) } ?: journal()
    }

    /** Whether the notebook's Room cache has [noteId]: its graph's if made, else its file read once (no page, no sync). */
    private suspend fun holds(localId: String, noteId: String): Boolean = runCatching {
        val made = sources[localId]?.madeGraph
        if (made != null) return@runCatching made.store.note(noteId) != null
        if (!context.getDatabasePath(databaseName(localId)).exists()) return@runCatching false
        val db = PenmossDatabase.open(context, databaseName(localId))
        try {
            db.notes().note(noteId) != null
        } finally {
            db.close()
        }
    }.getOrDefault(false)

    /** The Journal notebook as the person picked it: a git notebook's id, or null (never picked). */
    fun journalPicked(): String? = prefs.getString(JOURNAL, null)

    fun setJournal(localId: String) {
        prefs.edit { putString(JOURNAL, localId) }
        journalPicks.value = localId
    }

    private val journalPicks = MutableStateFlow(prefs.getString(JOURNAL, null))

    /** The Journal notebook as picked, as it changes: the device's settings are read again (A1014). */
    val journalPick: StateFlow<String?> = journalPicks.asStateFlow()

    // --- the registry, through GitNotebooks' checks ---

    suspend fun add(remote: String, branch: String?, dir: String?, name: String?, token: String?): AddResult {
        val result = notebooks.add(remote, branch, dir, name, token)
        refresh()
        if (result is AddResult.Added) {
            io.launch { runCatching { source(result.notebook.localId).syncNow() } }
            scheduleWork()
        }
        return result
    }

    /**
     * Remove (A856): the owner check names how many changes are lost (A855's "Remove warns about
     * unpushed edits"); the clone, the page's store, the notebook's database and secrets go.
     */
    suspend fun remove(localId: String) {
        val source = sources[localId]
        val notebookId = notebooks.remove(localId, source?.unpushed(), source?.oldCopyCount() ?: 0)
        (sources.remove(localId) ?: Source(localId)).close(notebookId)
        statusMap.update { it - localId }
        notice(localId) { null }
        oldCopiesMap.update { it - localId }
        withheldMap.update { it - localId }
        keptMap.update { it - localId }
        refresh()
        scheduleWork()
        if (prefs.getString(JOURNAL, null) == localId) prefs.edit { remove(JOURNAL) }
    }

    /** What Remove would lose (A856, A913): the engine's changes and Room's; null while unknown. */
    suspend fun unpushed(localId: String): Int? = sources[localId]?.unpushed()

    /** The notebook's sync now: git, then its notes into Room. */
    suspend fun syncNow(localId: String): GitEngineStatus = source(localId).syncNow()

    suspend fun purgesToConfirm(localId: String): List<PendingPurge> = notebooks.purgesToConfirm(localId)

    /** Confirm Delete for good again (only notes confirmed here once; A855), then sync. */
    suspend fun confirmPurgesAgain(localId: String, ids: List<String>) {
        notebooks.confirmPurgesAgain(localId, ids)
        io.launch { runCatching { source(localId).syncNow() } }
    }

    /**
     * Delete for good of a note never confirmed on this phone (A855, A913): the phone's own check,
     * naming the note as the branch has it (the engine asks), then the sync goes on.
     */
    suspend fun confirmPurge(localId: String, noteId: String) {
        notebooks.confirmPurge(localId, noteId)
        io.launch { runCatching { source(localId).syncNow() } }
    }

    /**
     * Keep note (A855): a Delete for good nobody confirmed here, taken back before it lands. A
     * purge that landed is for good: refused. Nothing is deleted, so no owner check.
     */
    suspend fun keepNote(localId: String, noteId: String, keep: Boolean = true): String? {
        if (keep && notebooks.purgesToConfirm(localId, listOf(noteId)).none { it.id == noteId }) {
            return "This note is already deleted for good in the repository, so Keep note did nothing."
        }
        source(localId).engine().keep(noteId, keep)
        io.launch { runCatching { source(localId).syncNow() } }
        return null
    }

    /** Settings → cadence and Wi-Fi only; the open page follows at once. */
    suspend fun update(localId: String, pushDelayS: Int? = null, pullEveryMin: Int? = null, wifiOnly: Boolean? = null) {
        val view = notebooks.update(localId, pushDelayS, pullEveryMin, wifiOnly)
        sources[localId]?.opened()?.setCadence(view.pushDelayS, view.pullEveryMin)
        scheduleWork()
    }

    /** Sign commits, per notebook (#172, A921): on makes this phone's key first if it has none. */
    suspend fun setSignCommits(localId: String, on: Boolean) {
        notebooks.setSignCommits(localId, on)
        refresh()
    }

    /** This notebook's own commit name and email (#170 F6); null for both is this phone's. */
    suspend fun setAuthor(localId: String, name: String?, email: String?): GitNotebookView {
        val view = notebooks.setAuthor(localId, name, email)
        refresh()
        return view
    }

    /** The public half of this phone's signing key, for GitHub; null until one is made. */
    fun signingKey(): String? = notebooks.signingKeyLine(label)

    /**
     * Makes a new signing key of [type], replacing this phone's: commits are signed with it from
     * now on. A kind the Keystore cannot make is refused, and the key before it stays.
     */
    suspend fun newSigningKey(type: app.penmoss.engine.git.CommitKeyType = app.penmoss.engine.git.CommitKeyType.P256) {
        val keys = signingKeys ?: throw GitRefusal("signing", "Sync stopped: signing. This phone cannot keep a signing key.")
        kotlinx.coroutines.withContext(Dispatchers.IO) { keys.create(type) }
        refresh()
    }

    /** One notebook's source: made on first use, kept while the process lives. */
    fun source(localId: String): Source {
        if (notebooks.entry(localId) == null) throw GitRefusal("not_found", "No such git notebook.")
        return sources.getOrPut(localId) { Source(localId) }
    }

    /** The graph of a notebook, for its screens and captures. */
    fun graph(localId: String): AppGraph = source(localId).graph

    /** The titles and folder names of the notebooks whose screens were opened, for error reports (A826). */
    suspend fun openedNames(): Collection<String> = sources.values.flatMap { it.names() }

    /** Whether the notebook's page is open now (Settings shows its status only then). */
    fun opened(localId: String): Source? = sources[localId]

    /** The git notebooks' graphs made in this process (their screens, outboxes and stores). */
    fun madeGraphs(): List<AppGraph> = sources.values.mapNotNull { it.madeGraph }

    // --- runs ---

    /**
     * A background run (G8, A881): each notebook in turn, bounded; Wi-Fi only ones are skipped on a
     * metered network. Its Room pass first (a capture or an edit made offline reaches the engine),
     * then git, then Room again (what the fetch brought).
     */
    suspend fun background(metered: Boolean, budgetMs: Long): List<Pair<String, String>> {
        val outcomes = mutableListOf<Pair<String, String>>()
        val started = System.currentTimeMillis()
        for (entry in notebooks.entries()) {
            val left = budgetMs - (System.currentTimeMillis() - started)
            if (left < 20_000) {
                outcomes += entry.localId to "deferred"
                continue
            }
            if (entry.wifiOnly && metered) {
                outcomes += entry.localId to "wifi-only"
                continue
            }
            val outcome = runCatching { source(entry.localId).background(metered, minOf(left - 10_000, BACKGROUND_SYNC_MS)) }
                .getOrElse { "failed: ${it.message}" }
            outcomes += entry.localId to outcome
        }
        prefs.edit { putLong(LAST_RUN, System.currentTimeMillis()) }
        return outcomes
    }

    /** The periodic run while there are notebooks (A881), off the main thread. */
    fun scheduleWork() {
        val entries = notebooks.entries()
        // A phone that never had a git notebook never touches WorkManager for them.
        if (entries.isEmpty() && !prefs.getBoolean(SCHEDULED, false)) return
        io.launch {
            runCatching { scheduler.schedule(entries) }
            prefs.edit { putBoolean(SCHEDULED, entries.isNotEmpty()) }
        }
    }

    override fun conditions(network: android.net.Network?) = app.penmoss.sync.DeviceConditions.read(context, network)

    override suspend fun run(metered: Boolean, budgetMs: Long) = background(metered, budgetMs)

    override fun any(): Boolean = notebooks.entries().isNotEmpty()

    /** When the next periodic run may come, for Settings (G8): WorkManager's own estimate. */
    fun nextRun(): Long? = runCatching {
        androidx.work.WorkManager.getInstance(context).getWorkInfosForUniqueWork(GitScheduler.PERIODIC).get()
            .firstOrNull { it.state == androidx.work.WorkInfo.State.ENQUEUED }?.nextScheduleTimeMillis?.takeIf { it in 1 until Long.MAX_VALUE }
    }.getOrNull()

    /** When the last background run ended, for Settings (G8). */
    fun lastBackgroundRun(): Long? = prefs.getLong(LAST_RUN, 0).takeIf { it > 0 }

    /** The app left the screen: one short sync of what waits (A825), and a run soon if more waits. */
    fun leftScreen() {
        io.launch {
            var waiting = false
            for (source in sources.values) {
                runCatching { source.opened()?.let { it.setFront(false); it.close(leaving = true) } }
                if (runCatching { source.pending().isNotEmpty() }.getOrDefault(false)) waiting = true
            }
            if (waiting) scheduler.pushSoon()
        }
    }

    /** Something was stored for a notebook (a capture): a run soon, even if the app closes now. */
    fun storedForLater() = scheduler.pushSoon()

    /**
     * One git notebook on this phone: its engine page (made again if its renderer goes), its own
     * graph and Room database, and its status.
     */
    inner class Source internal constructor(val localId: String) {
        private val lock = Mutex()
        @Volatile
        private var current: Pair<GitEngine, app.penmoss.engine.git.FramePort>? = null
        private val shown = MutableStateFlow(GitEngineStatus())
        private val asks = OwnerAsks()
        @Volatile
        private var made: AppGraph? = null

        /** Room still holds copies from before the page's epoch (A886): tried again after each sync. */
        @Volatile
        private var recoveryDue = false

        /** Bringing back what Android cleared (A886): after the open, in the background, never holding it up. */
        private val recovery = GitRecovery.Runner(
            io,
            pass = {
                opened()?.let { engine ->
                    try {
                        GitRecovery(engine, RoomOldCopies(graph.database), log = { runCatching { android.util.Log.w("PenmossGit", it) } })
                            .run { note -> recovered(localId, note.title) }
                            .also { pass -> if (pass == null || !pass.later) recoveryDue = false }
                    } finally {
                        // What waits, said in Settings, never held silently.
                        runCatching { countOldCopies(engine) }
                    }
                }
            },
            onPass = { pass -> if (!pass.later) unrecovered(localId, pass.unrecovered.map { it.title }) },
            log = { runCatching { android.util.Log.w("PenmossGit", it) } },
        )

        /** The page's sync status, through page restarts. */
        val status: StateFlow<GitEngineStatus> = shown.asStateFlow()

        /** Its graph if made already; null makes nothing. */
        val madeGraph: AppGraph? get() = made

        /** The notebook's own graph: its Room database, its notes server, its sync loop. */
        val graph: AppGraph
            get() = made ?: synchronized(this) {
                made ?: run {
                    val entry = notebooks.entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
                    (
                        makeGraph?.invoke(localId, entry.notebookId, entry.name) ?: run {
                            val api = LocalGitApi.api(localId, OkHttpClient(), asks) { engine() }
                            AppGraph.forGit(context, main(), PenmossDatabase.open(context, databaseName(localId)), localId, entry.notebookId, entry.name, api)
                        }
                    ).also { graph ->
                            graph.sync.start()
                            made = graph
                        }
                }
            }

        /** A page: made on the main thread by [GitPages.open] itself, so callable from any thread. */
        private fun page(onGone: () -> Unit) = pages.open("engine", onGone)

        /** The engine page, opened: made now if there is none, or its renderer went. */
        suspend fun engine(): GitEngine = lock.withLock {
            current?.let { return@withLock it.first }
            val entry = notebooks.entry(localId) ?: throw GitRefusal("not_found", "No such git notebook.")
            lateinit var engine: GitEngine
            val port = page {
                engine.closed("The notebook's page stopped")
                current = null
            }
            engine = GitEngine(localId, port, notebooks, io, asks, withheld = RoomOldCopies(graph.database))
            engine.onChanged = { made?.sync?.requestSync() }
            io.launch {
                var phase: String? = null
                engine.status.collect { status ->
                    shown.value = status
                    statusMap.update { it + (localId to status) }
                    // A sync landed: git's notes and Delete for good marks are known (A886).
                    if (recoveryDue && status.phase == "synced") recovery.soon()
                    // A sync may have withheld a copy (A886): Settings and Sync say so at once.
                    if (status.phase != phase && status.phase != "syncing") runCatching { readWithheld(localId) }
                    phase = status.phase
                }
            }
            // Android may have cleared the page's store (A886): the page holds Room's notes of
            // another epoch than its own, so Room keeps them until they have been tried.
            val epochs = runCatching { RoomOldCopies(graph.database).epochs() }.getOrDefault(emptyList())
            try {
                engine.open(entry, label, front = false, roomEpochs = epochs)
                keptMap.update { it + (localId to engine.persisted) }
            } catch (error: Exception) {
                runCatching { port.close() }
                throw error
            }
            current = engine to port
            recoveryDue = true
            recovery.soon()
            io.launch { runCatching { readWithheld(localId) } }
            engine
        }

        fun opened(): GitEngine? = current?.first

        private suspend fun countOldCopies(engine: GitEngine) {
            val epoch = engine.epoch ?: return
            val room = RoomOldCopies(graph.database)
            val counts = room.counts(epoch).let { (waiting, kept) -> GitOldCopies(waiting, kept, room.withheldCount()) }
            oldCopiesMap.update { if (counts.total == 0) it - localId else it + (localId to counts) }
        }

        /** Room's old copies Remove would lose (A886): waiting for a sync, or kept. */
        suspend fun oldCopyCount(): Int {
            val engine = opened() ?: return oldCopiesMap.value[localId]?.total ?: 0
            return runCatching { countOldCopies(engine); oldCopiesMap.value[localId]?.total ?: 0 }.getOrDefault(oldCopiesMap.value[localId]?.total ?: 0)
        }

        /** Its titles and folder names, once its graph is made; its id too (A826). */
        suspend fun names(): Collection<String> = (made?.store?.names().orEmpty()) + localId

        suspend fun pending(): List<String> = opened()?.pending().orEmpty()

        /**
         * How many changes Remove would lose (A856): known only while its page and screens are
         * open (the engine's and Room's own); null otherwise, and the words say changes may be lost.
         */
        suspend fun unpushed(): Int? {
            val engine = opened() ?: return null
            val graph = made ?: return null
            val inEngine = runCatching { withTimeoutOrNull(5_000) { engine.pending().size } }.getOrNull() ?: return null
            val inRoom = runCatching { graph.store.unsentCount() }.getOrNull() ?: return null
            return inEngine + inRoom
        }

        /**
         * In front (its activity resumed): pull now and on its interval; Room every minute. Out
         * of front, what waits is pushed; [leaving] (the screen finishing) may stop a push still
         * running at the time limit, a plain pause never (#174 delta review).
         */
        suspend fun front(value: Boolean, leaving: Boolean = false) {
            graph.sync.setForeground(value)
            engine().setFront(value)
            if (!value) runCatching { engine().close(leaving) }
        }

        suspend fun syncNow(): GitEngineStatus {
            graph.sync.syncNow()
            val status = engine().sync()
            graph.sync.syncNow()
            return status
        }

        suspend fun background(metered: Boolean, limitMs: Long): String {
            val batches = if (metered) 2 else app.penmoss.engine.sync.SyncEngine.MAX_BATCHES
            val first = graph.sync.backgroundPass(prefetch = !metered, maxBatches = batches)
            val status = engine().sync(limitMs, background = true)
            val second = graph.sync.backgroundPass(prefetch = !metered, maxBatches = batches)
            val room = if (first == PassOutcome.FAILED || second == PassOutcome.FAILED) "room failed" else null
            return listOfNotNull(status.phase, status.code, room).joinToString(" ")
        }

        /** Removed: the page's store, the database and the notebook's preferences go. */
        internal suspend fun close(notebookId: String) {
            val held = current
            current = null
            val (engine, port) = held ?: run {
                // No page open: one without a notebook, only to delete its store.
                val bare = page {}
                GitEngine(localId, bare, notebooks, io, asks) to bare
            }
            // The page's store goes on its own time: the notebook is gone from the phone already.
            io.launch {
                if (held != null) runCatching { withTimeoutOrNull(5_000) { engine.stop() } }
                runCatching { withTimeoutOrNull(15_000) { engine.forget(notebookId) } }
                runCatching { port.close() }
            }
            made?.let { graph ->
                runCatching { withTimeoutOrNull(10_000) { graph.sync.quiesce() } }
                runCatching { graph.database.close() }
            }
            made = null
            context.deleteDatabase(databaseName(localId))
            for (name in AppGraph.gitPrefs(localId)) context.deleteSharedPreferences(name)
        }
    }

    /** The commit check page (A876), made again when its renderer goes. */
    private inner class HubGuard : GitGuard {
        private val lock = Mutex()
        private var current: PageGuard? = null

        private suspend fun guard(): PageGuard = lock.withLock {
            current?.let { return@withLock it }
            lateinit var made: PageGuard
            val port = pages.open("guard") {
                made.closed("The commit check stopped")
                current = null
            }
            made = PageGuard(port, io) { notebooks }
            current = made
            made
        }

        override suspend fun commitPurges(localId: String, root: String, head: String?, changes: Map<String, ByteArray?>): CommitPurges =
            guard().commitPurges(localId, root, head, changes)

        override suspend fun purgedAt(localId: String, root: String, head: String?): Set<String> = guard().purgedAt(localId, root, head)

        override suspend fun titles(localId: String, root: String, head: String?, ids: List<String>): Map<String, String> =
            guard().titles(localId, root, head, ids)
    }

    companion object {
        /** Logs what a coroutine of the hub's threw, instead of ending the app. */
        val LOGGED = kotlinx.coroutines.CoroutineExceptionHandler { _, error ->
            runCatching { android.util.Log.w("PenmossGit", "A git notebook task failed", error) }
        }

        const val PREFS = "penmoss.git"
        private const val RECOVERED = "recovered."
        private const val NAME = "identity.name"
        private const val EMAIL = "identity.email"
        private const val JOURNAL = "journalNotebook"
        private const val LAST_RUN = "background.lastRun"
        private const val SCHEDULED = "background.scheduled"
        private val EMAIL_SHAPE = Regex("^[^\\s<>@]+@[^\\s<>@]+$")

        /** A background run's git sync, per notebook: the page's own limit in front (A859). */
        const val BACKGROUND_SYNC_MS = 90_000L

        fun databaseName(localId: String) = "git-$localId.db"

        /** What a commit's writer and the notebook's page call this phone: `Penmoss for Android (<model>)`. */
        fun deviceLabel(model: String): String {
            val name = model.trim()
            return if (name.isEmpty()) "Penmoss for Android" else "Penmoss for Android ($name)".take(80)
        }

        /** Whether this phone has held a git notebook (its registry exists). */
        fun anyEver(context: Context): Boolean = File(context.filesDir, "git-notebooks/git-notebooks.json").exists()
    }
}
