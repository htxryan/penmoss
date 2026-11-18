package app.penmoss.git.firstrun

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import app.penmoss.R
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.GitEngineStatus
import app.penmoss.engine.git.GitRefusal
import app.penmoss.feedback.GitHubDeviceSignIn
import app.penmoss.ui.common.roles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * What the flow needs from the phone: GitHub's API, the GitHub sign-in (Settings → GitHub, A1012),
 * the git notebooks hub's Add and each notebook's sync. The app's are [FirstRunDeps.of]; tests
 * give fakes.
 */
class FirstRunDeps(
    val browse: GitHubBrowse,
    /** The phone's GitHub token (Sign In with GitHub's or a typed one), or null. */
    val token: () -> String?,
    val login: () -> String?,
    /** Keeps a token typed here as the phone's GitHub sign-in. */
    val saveToken: (token: String, login: String?) -> Unit,
    /** Every GitHub account on the phone, the primary first (A1616). */
    val accounts: () -> List<app.penmoss.feedback.GitHubAccount> = { if (token() != null) listOf(app.penmoss.feedback.GitHubAccount(login(), primary = true)) else emptyList() },
    /** One account's token, by its login. */
    val tokenFor: (login: String?) -> String? = { token() },
    /** Sign In with GitHub (the device code); null where this build can't. */
    val signIn: GitHubDeviceSignIn?,
    /** Adds the notebook at [Place] (made when [name] is given and the place holds none). */
    val add: suspend (place: Place, name: String?) -> AddResult,
    /** The notebook ids on this phone already: shown Already Added. */
    val added: () -> Set<String>,
    val statuses: StateFlow<Map<String, GitEngineStatus>>,
    val syncNow: suspend (localId: String) -> Unit,
    val openUrl: (String) -> Unit,
    val copy: (String) -> Unit,
    /**
     * Settings → GitHub's page, opened from Use a Different GitHub Account (Ryan, 17 Nov 2026):
     * add or sign out of accounts without leaving Add Notebook. Null hides the link.
     */
    val accountsPage: (@Composable (onBack: () -> Unit) -> Unit)? = null,
) {
    companion object {
        fun of(graph: app.penmoss.DeviceGraph, context: android.content.Context): FirstRunDeps {
            val hub = graph.git
            return FirstRunDeps(
                browse = graph.githubBrowse,
                token = graph.githubToken::token,
                login = graph.githubToken::login,
                saveToken = graph.githubToken::save,
                accounts = graph.githubToken::accounts,
                tokenFor = graph.githubToken::tokenFor,
                signIn = graph.githubSignIn.takeIf { it.available },
                add = { place, name -> hub.add(place.remote, place.branch, place.dir, name, place.token) },
                added = { hub.list.value.map { it.notebookId }.toSet() },
                statuses = hub.statuses,
                syncNow = { hub.syncNow(it) },
                openUrl = { url ->
                    runCatching {
                        context.startActivity(
                            android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                },
                copy = { text ->
                    context.getSystemService(android.content.ClipboardManager::class.java)
                        ?.setPrimaryClip(android.content.ClipData.newPlainText("GitHub code", text))
                },
                accountsPage = { onBack ->
                    var typing by remember { mutableStateOf(false) }
                    if (typing) {
                        BackHandler { typing = false }
                        app.penmoss.feedback.GitHubTokenRoute(graph, onBack = { typing = false })
                    } else {
                        app.penmoss.feedback.GitHubAccountsRoute(graph, onToken = { typing = true }, onBack = onBack)
                    }
                },
            )
        }
    }
}

/**
 * The first run (A1404, now on Android too; amends A1040's single form) and Add Notebook (A1562):
 * one flow, as a stack of screens. Each step goes on to the next, Back goes to the one before.
 * The first run starts at the welcome; Add Notebook at Create or Open Notebook, with Cancel in
 * Back's place. [onHold] keeps the first run on screen while a notebook is set up, past the moment
 * the list has it, until its first sync; [onDone] ends the flow on the notebook (null: it went).
 */
@Composable
fun NotebookSteps(
    deps: FirstRunDeps,
    firstRun: Boolean,
    onDone: (localId: String?) -> Unit,
    onHold: (Boolean) -> Unit = {},
    onCancel: (() -> Unit)? = null,
) {
    var stack by remember { mutableStateOf(listOf(if (firstRun) Screen.Welcome else Screen.Goal)) }
    var goal by remember { mutableStateOf(Goal.NEW) }
    var way by remember { mutableStateOf(Way.CREATE) }
    var hub by remember { mutableStateOf<Hub?>(null) }
    val reads = remember { mutableStateMapOf<String, RepoRead>() }
    val added = remember { deps.added() }
    val scope = rememberCoroutineScope()
    val screen = stack.last()
    fun go(next: Screen) {
        stack = stack + next
    }
    fun replace(next: Screen) {
        stack = stack.dropLast(1) + next
    }
    fun back() {
        if (stack.size > 1) stack = stack.dropLast(1)
    }
    BackHandler(enabled = stack.size > 1 && screen !is Screen.SetUp) { back() }

    /** The account the repositories are listed for, among the phone's (A1616). */
    fun listed(): app.penmoss.feedback.GitHubAccount? = deps.accounts().firstOrNull { it.login == hub?.login }
    /** GitHub's step again, for [then]: as [account], or Add Another Account. */
    fun githubAgain(then: AfterGitHub, account: app.penmoss.feedback.GitHubAccount? = null, add: Boolean = false) {
        reads.clear()
        hub = null
        replace(Screen.GitHub(then, account = account, add = add))
    }
    /** Refresh: the same account's repositories again, without asking which. */
    val refresh = { githubAgain(AfterGitHub.LIST, listed()) }
    /**
     * Whose repositories these are, as a control (Ryan's pick, option 2, 17 Nov 2026; A1616): each
     * account, Add Another Account, Manage GitHub Accounts (Settings → GitHub's page) and Refresh.
     */
    val switcher = @Composable { then: AfterGitHub, onRefresh: (() -> Unit)? ->
        AccountSwitcher(
            login = hub?.login,
            accounts = remember(hub) { deps.accounts() },
            onPick = { githubAgain(then, it) },
            onAdd = { githubAgain(then, add = true) },
            onManage = deps.accountsPage?.let { { go(Screen.Accounts(then)) } },
            onRefresh = onRefresh,
        )
    }

    /** The hub's Add, holding the first run while it works and after it adds (until the first sync). */
    val add: suspend (Place, String?) -> AddResult = { place, name ->
        onHold(true)
        try {
            deps.add(place, name).also { if (it !is AddResult.Added) onHold(false) }
        } catch (error: Throwable) {
            onHold(false)
            throw error
        }
    }

    /** One repository's folders, read once (again on Try Again). */
    fun read(repo: GitHubRepo, again: Boolean) {
        val now = hub ?: return
        if (!again && reads.containsKey(repo.fullName)) return
        reads[repo.fullName] = RepoRead.Loading
        scope.launch {
            reads[repo.fullName] = when (val answer = deps.browse.folders(now.token, repo.fullName, repo.defaultBranch.ifEmpty { "main" })) {
                is BrowseResult.Ok -> RepoRead.Ready(answer.value)
                is BrowseResult.Failed -> RepoRead.Failed(answer.error.message)
            }
        }
    }

    /** GitHub's sign-in first when the flow has none yet, then [then]. */
    fun viaGitHub(then: AfterGitHub) = go(if (hub != null) (if (then == AfterGitHub.CREATE) Screen.Create else Screen.List) else Screen.GitHub(then))

    key(stack.size) {
        when (screen) {
            Screen.Welcome -> Frame(
                "welcome",
                "Welcome to Penmoss",
                centered = true,
                above = {
                    Image(
                        painterResource(R.drawable.ic_launcher_monochrome),
                        contentDescription = null,
                        Modifier.size(144.dp),
                        colorFilter = ColorFilter.tint(MaterialTheme.colorScheme.primary),
                    )
                },
                start = { Link("Learn More", "first-run-learn", "book-open") { deps.openUrl(FIRST_RUN_DOCS) } },
                actions = { Primary("Get Started", "first-run-start", "arrow-right") { go(Screen.Goal) } },
            ) {
                Lead("Notes in a git repository you own. Three short steps and you’re writing.", centered = true)
            }
            Screen.Goal -> Frame(
                "goal",
                "Create or Open Notebook",
                step = 1,
                back = if (firstRun) ::back else null,
                cancel = onCancel,
                actions = {
                    Primary("Continue", "first-run-continue", "arrow-right") {
                        if (goal == Goal.NEW) go(Screen.Way) else viaGitHub(AfterGitHub.LIST)
                    }
                },
            ) {
                Options(
                    goal,
                    listOf(
                        Option(Goal.NEW, "Start a New Notebook", if (firstRun) "Your first Penmoss notebook" else "A new, empty notebook", "first-run-new"),
                        Option(Goal.EXISTING, "Open an Existing Notebook", "From a repository with Penmoss notes", "first-run-existing"),
                    ),
                ) { goal = it }
            }
            Screen.Way -> Frame(
                "way",
                "Pick Repository",
                step = 2,
                back = ::back,
                actions = {
                    Primary("Continue", "first-run-continue", "arrow-right") {
                        when (way) {
                            Way.URL -> go(Screen.Url)
                            Way.CREATE -> viaGitHub(AfterGitHub.CREATE)
                            Way.EXISTING -> viaGitHub(AfterGitHub.LIST)
                        }
                    }
                },
            ) {
                Options(
                    way,
                    listOf(
                        Option(Way.CREATE, "Create New Repo", "On GitHub, private", "first-run-way-create", chip = "Recommended"),
                        Option(Way.EXISTING, "Use Existing Repo", "An empty one you made", "first-run-way-existing"),
                        Option(Way.URL, "Paste a URL", "Any HTTPS git repository", "first-run-way-url"),
                    ),
                ) { way = it }
            }
            is Screen.GitHub -> GitHubAccess(
                deps,
                onReady = { answer ->
                    hub = answer
                    reads.clear()
                    replace(if (screen.then == AfterGitHub.CREATE) Screen.Create else Screen.List)
                },
                choose = screen.choose,
                account = screen.account,
                add = screen.add,
                onUrl = { replace(Screen.Url) },
                back = ::back,
            )
            // Settings → GitHub's page inside the flow (Use a Different GitHub Account): back from it,
            // the GitHub step reads the accounts again, asking which with two or more (A1616).
            is Screen.Accounts -> {
                val leave = {
                    reads.clear()
                    hub = null
                    stack = stack.dropLast(2) + Screen.GitHub(screen.then, choose = deps.accounts().size > 1)
                }
                BackHandler(onBack = leave)
                deps.accountsPage?.invoke(leave)
            }
            Screen.Create -> hub?.let { now ->
                CreateRepo(
                    deps,
                    now,
                    onCreated = { place, name -> go(Screen.SetUp(Setup.Create(place, name))) },
                    onUseExisting = { replace(Screen.List) },
                    switcher = { switcher(AfterGitHub.CREATE, null) },
                    back = ::back,
                )
            }
            Screen.List -> hub?.let { now ->
                RepoTree(
                    now,
                    goal,
                    added,
                    reads,
                    ::read,
                    onRepo = { go(Screen.Repo(it)) },
                    onOpen = { repo, folder -> go(Screen.SetUp(Setup.Open(placeIn(repo, now.token, folder.path), folder.notebook?.name ?: repo.name))) },
                    onUrl = { go(Screen.Url) },
                    onCreate = if (goal == Goal.NEW) ({ replace(Screen.Create) }) else null,
                    onRefresh = refresh,
                    // Another GitHub account's repositories (A1616): the switcher, option 2.
                    switcher = { switcher(AfterGitHub.LIST, refresh) },
                    back = ::back,
                )
            }
            is Screen.Repo -> hub?.let { now ->
                RepoPicked(
                    screen.repo,
                    now.token,
                    added,
                    reads[screen.repo.fullName],
                    ::read,
                    onOpen = { place, name -> go(Screen.SetUp(Setup.Open(place, name))) },
                    onName = { go(Screen.Name(it)) },
                    onFolder = { go(Screen.Folder(screen.repo)) },
                    onUrl = { go(Screen.Url) },
                    back = ::back,
                )
            }
            is Screen.Folder -> {
                val now = hub
                val loaded = reads[screen.repo.fullName]
                if (now != null && loaded is RepoRead.Ready) {
                    FolderPick(screen.repo, now.token, loaded.folders, beside = true, onName = { go(Screen.Name(it)) }, back = ::back)
                }
            }
            Screen.Url -> PasteUrl(
                deps,
                add,
                onAdded = { go(Screen.SetUp(it)) },
                onName = { go(Screen.Name(it)) },
                back = ::back,
            )
            is Screen.Name -> NameNotebook(screen.place, onMake = { go(Screen.SetUp(Setup.Make(screen.place, it))) }, back = ::back)
            is Screen.SetUp -> SettingUp(
                deps,
                screen.setup,
                add,
                onDone = { localId ->
                    onHold(false)
                    onDone(localId)
                },
                onNeedsName = { replace(Screen.Name(it)) },
                back = ::back,
            )
        }
    }
}

/** Setting Up's steps, as each shows. */
private enum class Mark { DONE, DOING, FAILED, TODO }

private sealed interface Phase {
    data object Adding : Phase
    data class AddFailed(val message: String) : Phase
    data class Syncing(val localId: String) : Phase
    data class SyncFailed(val localId: String, val message: String) : Phase
}

/**
 * Setting Up (A1406): the notebook is added (or made), then its first sync runs while the screen
 * says so, step by step. Once it syncs the flow ends on it. A failed first sync says why, with
 * Retry and Open Anyway; Open Now shows after 15 s so a slow sync never traps anyone.
 */
@Composable
private fun SettingUp(deps: FirstRunDeps, setup: Setup, add: suspend (Place, String?) -> AddResult, onDone: (String?) -> Unit, onNeedsName: (Place) -> Unit, back: () -> Unit) {
    var phase by remember { mutableStateOf<Phase>(Phase.Adding) }
    var attempt by remember { mutableIntStateOf(0) }
    var slow by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val place = setup.place
    LaunchedEffect(attempt) {
        phase = Phase.Adding
        if (setup is Setup.Added) {
            phase = Phase.Syncing(setup.localId)
            return@LaunchedEffect
        }
        try {
            when (val result = add(place, if (setup is Setup.Open) null else setup.name)) {
                AddResult.NeedsName -> onNeedsName(place)
                is AddResult.Added -> phase = Phase.Syncing(result.notebook.localId)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: GitRefusal) {
            phase = Phase.AddFailed(error.message ?: "Penmoss could not add the notebook.")
        } catch (error: Exception) {
            phase = Phase.AddFailed(error.message ?: "Penmoss could not add the notebook.")
        }
    }
    val syncing = (phase as? Phase.Syncing)?.localId ?: (phase as? Phase.SyncFailed)?.localId
    val statuses by deps.statuses.collectAsState()
    val status = syncing?.let { statuses[it] }
    LaunchedEffect(syncing, status?.phase, status?.lastSyncAt) {
        if (syncing == null || status == null) return@LaunchedEffect
        when (status.phase) {
            "synced" -> onDone(syncing)
            "offline", "stopped" -> phase = Phase.SyncFailed(syncing, status.detail ?: if (status.phase == "offline") "this phone is offline" else "it stopped")
            else -> if (phase !is Phase.SyncFailed) phase = Phase.Syncing(syncing)
        }
    }
    LaunchedEffect(syncing != null) {
        if (syncing == null) return@LaunchedEffect
        delay(SLOW_MS)
        slow = true
    }

    val clones = setup is Setup.Open || setup is Setup.Added
    val steps = buildList {
        if (setup is Setup.Create) add(Mark.DONE to "Created ${place.label}")
        when (val now = phase) {
            Phase.Adding -> add(Mark.DOING to if (clones) "Cloning ${place.label}…" else "Setting up the notebook…")
            is Phase.AddFailed -> add(Mark.FAILED to "${if (clones) "Couldn’t clone ${place.label}" else "Couldn’t set up the notebook"}: ${now.message}")
            else -> add(Mark.DONE to if (clones) "Cloned ${place.label}" else "Set up the notebook")
        }
        add(
            when (val now = phase) {
                is Phase.Syncing -> Mark.DOING to "First sync…"
                is Phase.SyncFailed -> Mark.FAILED to "First sync failed: ${now.message}"
                else -> Mark.TODO to "First sync"
            },
        )
    }
    val failed = phase is Phase.AddFailed || phase is Phase.SyncFailed
    val footer: @Composable RowScope.() -> Unit = {
        when (val now = phase) {
            is Phase.AddFailed -> Primary("Retry", "first-run-retry", "refresh-cw") { attempt++ }
            is Phase.SyncFailed -> {
                Plain("Open Anyway", "first-run-open-anyway", "folder-open") { onDone(now.localId) }
                Primary("Retry", "first-run-retry", "refresh-cw") {
                    phase = Phase.Syncing(now.localId)
                    scope.launch { runCatching { deps.syncNow(now.localId) } }
                }
            }
            is Phase.Syncing -> Plain("Open Now", "first-run-open-now", "folder-open") { onDone(now.localId) }
            Phase.Adding -> Unit
        }
    }
    Frame(
        "setup",
        when {
            failed -> "Couldn’t Finish Setting Up"
            clones -> "Opening ${setup.name}"
            else -> "Making ${setup.name}"
        },
        back = if (phase is Phase.AddFailed) back else null,
        actions = footer.takeIf { failed || (phase is Phase.Syncing && slow) },
    ) {
        Column(Modifier.testTag("first-run-steps"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            for ((mark, words) in steps) {
                Row(Modifier.testTag("first-run-step"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                        when (mark) {
                            Mark.DOING -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            Mark.DONE -> Text("✓", style = MaterialTheme.roles.rowLabel, color = MaterialTheme.colorScheme.primary)
                            Mark.FAILED -> Text("✕", style = MaterialTheme.roles.rowLabel, color = MaterialTheme.colorScheme.error)
                            Mark.TODO -> Text("○", style = MaterialTheme.roles.rowLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Text(
                        words,
                        style = MaterialTheme.roles.body,
                        color = if (mark == Mark.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
        if (phase is Phase.SyncFailed) Lead("The notebook is on this phone. Nothing is lost.")
    }
}

/** Opens Add Notebook's flow from Settings or the home (A1562): its context's deps, once. */
@Composable
fun rememberFirstRunDeps(graph: app.penmoss.DeviceGraph): FirstRunDeps {
    val context = LocalContext.current.applicationContext
    return remember(graph) { FirstRunDeps.of(graph, context) }
}
