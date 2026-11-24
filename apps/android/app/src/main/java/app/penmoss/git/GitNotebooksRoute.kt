package app.penmoss.git

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.GitRefusal
import app.penmoss.engine.git.PendingPurge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/* The notebooks over the hub: the state and actions All Notebooks, Home and a notebook page share, and their routes; split from GitNotebooksScreen.kt (PEN-186). */

/**
 * The notebooks' state and actions over the hub (T50 G7; PEN-146), shared by All Notebooks, the
 * app's home and a notebook's page. [onOpen] opens a notebook's screens.
 */
@Composable
internal fun rememberGitNotebooks(
    hub: GitNotebookHub,
    onOpen: (String) -> Unit,
    home: Boolean = false,
    onPage: (String) -> Unit = {},
    copyTags: Boolean? = null,
    onCopyTags: (Boolean) -> Unit = {},
): Pair<GitNotebooksUi, GitNotebooksActions> {
    val views by hub.list.collectAsStateWithLifecycle()
    val inStep by hub.settingsInStep.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var needsName by remember { mutableStateOf(false) }
    val purges = remember { mutableStateMapOf<String, List<PendingPurge>>() }
    val keptNotes = remember { mutableStateMapOf<String, List<PendingPurge>>() }
    var tick by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        // The statuses and background times, read again every few seconds while shown.
        while (true) {
            delay(3_000)
            tick++
        }
    }
    val shownStatuses by hub.statuses.collectAsStateWithLifecycle()
    val recoveries by hub.recoveries.collectAsStateWithLifecycle()
    val kept by hub.storageKept.collectAsStateWithLifecycle()
    val oldCopies by hub.oldCopies.collectAsStateWithLifecycle()
    val withheld by hub.withheld.collectAsStateWithLifecycle()
    val badges by hub.badges.collectAsStateWithLifecycle(emptyMap())
    val saveUnrecovered = rememberSaveUnrecovered(hub) { message = it }
    val saveWithheld = rememberSaveUnrecovered(hub, withheld = true) { message = it }
    val (name, email) = remember(tick) { hub.identitySet() }
    val runs = remember(tick) { hub.lastBackgroundRun() to null as Long? }
    var next by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(tick / 10) { next = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { hub.nextRun() } }
    fun run(what: String, block: suspend () -> Unit) {
        busy = what
        scope.launch {
            try {
                block()
            } catch (error: GitRefusal) {
                message = error.message
            } catch (error: IllegalArgumentException) {
                message = error.message
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                message = error.message ?: "That did not work."
            } finally {
                busy = null
            }
        }
    }
    val ui = GitNotebooksUi(
        rows = views.map { view ->
            val row = GitRow(view, shownStatuses[view.localId], purges[view.localId], recoveries[view.localId], kept[view.localId], oldCopies[view.localId], withheld[view.localId].orEmpty(), keptNotes[view.localId].orEmpty())
            badges[view.localId]?.let { row.copy(badge = it) } ?: row
        },
        identityName = name,
        identityEmail = email,
        journal = hub.journal(),
        home = home,
        lastRun = runs.first,
        nextRun = next,
        busy = busy,
        message = message,
        needsName = needsName,
        signingKey = remember(tick, views) { runCatching { hub.signingKey() }.getOrNull() },
        copyTags = copyTags,
        inStep = inStep,
    )
    val clipboard = androidx.compose.ui.platform.LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)
    val actions = GitNotebooksActions(
        onOpen = onOpen,
        onAdd = { form ->
            run("add") {
                when (hub.add(form.remote, form.branch, form.dir, form.name.ifBlank { null }, form.token.ifBlank { null })) {
                    is AddResult.Added -> needsName = false
                    AddResult.NeedsName -> needsName = true
                }
            }
        },
        onSyncNow = { id -> run(id) { hub.syncNow(id) } },
        onRemove = { id -> run(id) { hub.remove(id) } },
        onToken = { id, token -> run(id) { hub.notebooks.setToken(id, token) } },
        onWifiOnly = { id, on -> run(id) { hub.update(id, wifiOnly = on) } },
        onSignCommits = { id, on ->
            run(id) {
                hub.setSignCommits(id, on)
                message = if (on) "Commits from this phone are signed. Add its signing key to GitHub as a signing key." else "Commits from this phone are not signed."
                tick++
            }
        },
        onAuthor = { id, name, email ->
            run(id) {
                val view = hub.setAuthor(id, name.ifBlank { null }, email.ifBlank { null })
                message = view.author?.let { "This notebook commits as ${it.name} <${it.email}> from the next commit." }
                    ?: "This notebook commits as Commits from this phone says, from the next commit."
            }
        },
        onCopySigningKey = { key ->
            clipboard?.setPrimaryClip(android.content.ClipData.newPlainText("Penmoss signing key", key))
            message = "Copied the signing key."
        },
        onNewSigningKey = { type ->
            run("key") {
                hub.newSigningKey(type)
                message = "A new signing key: add it to GitHub as a signing key. Commits are signed with it from now on."
                tick++
            }
        },
        onCadence = { id, push, pull -> run(id) { hub.update(id, pushDelayS = push, pullEveryMin = pull) } },
        onShowPurges = { id -> scope.launch { purges[id] = app.penmoss.engine.attempt { hub.purgesToConfirm(id) }.getOrDefault(emptyList()) } },
        onConfirmPurges = { id, ids -> run(id) { hub.confirmPurgesAgain(id, ids); purges.remove(id) } },
        onDismissRecovery = hub::dismissRecovery,
        onSaveUnrecovered = saveUnrecovered,
        onSaveWithheld = saveWithheld,
        onDropWithheld = { id, note -> run(id) { hub.dropWithheld(id, note) } },
        onKeepWithheld = { id, note -> run(id) { hub.keepWithheld(id, note) } },
        onKeep = { id, note ->
            run(id) {
                val refused = hub.keepNote(id, note)
                if (refused != null) {
                    message = refused
                } else {
                    purges[id]?.firstOrNull { it.id == note }?.let { keptNotes[id] = keptNotes[id].orEmpty() + it }
                }
                purges[id] = hub.purgesToConfirm(id)
            }
        },
        onUndoKeep = { id, note ->
            run(id) {
                hub.keepNote(id, note, keep = false)
                keptNotes[id] = keptNotes[id].orEmpty().filterNot { it.id == note }
                purges[id] = hub.purgesToConfirm(id)
            }
        },
        unpushed = { id -> hub.unpushed(id) },
        aiSetting = { id -> runCatching { hub.graph(id).api.aiSetting(null) }.getOrNull() },
        onAiSetting = { id, value -> runCatching { hub.graph(id).api.setAiSetting(null, value) }.getOrNull() },
        onDescribeAll = { id -> runCatching { hub.graph(id).api.describeAll(null) }.getOrNull() },
        onConfirmPurge = { id, note ->
            run(id) {
                hub.confirmPurge(id, note)
                message = "Confirmed: Delete for Good goes at this sync."
                purges[id] = hub.purgesToConfirm(id)
            }
        },
        onIdentity = { n, e -> run("identity") { hub.setIdentity(n, e); tick++ } },
        onJournal = { id -> hub.setJournal(id); tick++ },
        onDismissMessage = { message = null },
        onCopyTags = onCopyTags,
        onPage = onPage,
        onInStep = hub::setSettingsInStep,
        onBadge = { id, key, value -> runCatching { hub.setBadge(id, key, value) }.onFailure { message = it.message } },
        onCopySettings = { from, to ->
            fun name(id: String) = views.firstOrNull { it.localId == id }?.name ?: "the notebook"
            try {
                copiedWords(name(from), to?.let(::name), hub.copySettings(from, to))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                error.message ?: "Penmoss could not copy the settings."
            }
        },
    )
    return ui to actions
}

/**
 * Settings → All Notebooks, over the hub (T50 G7; PEN-146), and the app's home ([home], A1040)
 * with Settings in its bar ([onSettings]). A row opens the notebook's page ([onPage]), or on the
 * home the notebook itself ([onOpen]).
 */
@Composable
fun GitNotebooksRoute(
    hub: GitNotebookHub,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
    /** The app's home (A1040), not Settings. */
    home: Boolean = false,
    onSettings: (() -> Unit)? = null,
    onPage: (String) -> Unit = {},
    copyTags: Boolean? = null,
    onCopyTags: (Boolean) -> Unit = {},
    onAddNotebook: (() -> Unit)? = null,
) {
    val (ui, actions) = rememberGitNotebooks(hub, onOpen, home, onPage, copyTags, onCopyTags)
    GitNotebooksScreen(ui, actions, onBack, onSettings, onAddNotebook)
}

/** A notebook's page in Settings (PEN-146), over the hub: [tab] is overview, sync or git. */
@Composable
fun NotebookPageRoute(
    hub: GitNotebookHub,
    localId: String,
    tab: String?,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
    /** The notebook's own Room sync, when its screens are the ones Settings opened over. */
    passText: String? = null,
) {
    val (ui, actions) = rememberGitNotebooks(hub, onOpen)
    // Its settings read and a change sent at once while the page shows (its badge, A1579), as the
    // primary's are (rememberPrimary); its own screens, when open, sync it already.
    androidx.compose.runtime.DisposableEffect(localId) {
        val release = runCatching { hub.graph(localId).sync.watch() }.getOrNull()
        onDispose { release?.invoke() }
    }
    // Removed: nothing to show, so the page goes.
    val row = ui.rows.firstOrNull { it.view.localId == localId }
    LaunchedEffect(row == null, ui.rows.isEmpty()) { if (row == null && hub.list.value.none { it.localId == localId }) onBack() }
    // Its notes on this phone (PEN-148), counted again every few seconds while shown.
    var notes by remember(localId) { mutableStateOf<Int?>(null) }
    LaunchedEffect(localId) {
        while (true) {
            notes = hub.noteCount(localId)
            delay(5_000)
        }
    }
    if (row == null) return
    NotebookPage(row, ui, actions, tab ?: NotebookTab.OVERVIEW, onBack, passText = passText, notes = notes)
}

/**
 * Save their text (A886): the person picks a file, and what can be read of each copy that could
 * not be brought back goes into it, as markdown. [said] hears how it went.
 */
@Composable
fun rememberSaveUnrecovered(hub: GitNotebookHub, withheld: Boolean = false, said: (String) -> Unit): (String) -> Unit {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var target by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf<String?>(null) }
    val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("text/markdown"),
    ) { uri ->
        val localId = target
        target = null
        if (uri == null || localId == null) return@rememberLauncherForActivityResult
        scope.launch {
            said(
                try {
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        val out = context.contentResolver.openOutputStream(uri) ?: throw java.io.IOException("the file could not be opened")
                        out.use { if (withheld) hub.saveWithheld(localId, it) else hub.saveUnrecovered(localId, it) }
                    }
                    "Saved what can be read of them."
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    "Penmoss could not save them: ${error.message ?: "that did not work"}."
                },
            )
        }
    }
    return { localId ->
        target = localId
        launcher.launch(if (withheld) "Penmoss notes kept on this phone.md" else "Penmoss notes not brought back.md")
    }
}
