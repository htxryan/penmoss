package app.penmoss.git.firstrun

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.rememberLucideIcons
import androidx.compose.material3.Icon
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.typedLength
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.GitRefusal
import app.penmoss.ui.common.roles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** The notebook name field. */
@Composable
private fun NameField(value: String, tag: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value,
        onChange,
        Modifier.fillMaxWidth().testTag(tag),
        label = { Text("Notebook Name") },
        placeholder = { Text("Field Notes") },
        singleLine = true,
    )
}

/**
 * Create New Repo (A1404; the Mac's 3.x): the notebook's name, the repository's (from the name
 * until edited, D62), always private, under the account or an organisation. Make Notebook makes
 * the repository on GitHub, then Setting Up makes the notebook at its root.
 */
@Composable
internal fun CreateRepo(
    deps: FirstRunDeps,
    hub: Hub,
    onCreated: (Place, String) -> Unit,
    onUseExisting: () -> Unit,
    back: () -> Unit,
    /** The account switcher (option 2, A1616), at the top. */
    switcher: (@Composable () -> Unit)? = null,
) {
    val owners = hub.owners.orEmpty()
    var notebook by remember { mutableStateOf("") }
    var repoName by remember { mutableStateOf("notes") }
    var edited by remember { mutableStateOf(false) }
    var owner by remember { mutableStateOf(owners.firstOrNull()?.login.orEmpty()) }
    var changing by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var taken by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val name = repoName.trim()
    val ready = notebook.isNotBlank() && name.isNotEmpty() && owner.isNotEmpty()
    fun create() {
        val chosen = owners.firstOrNull { it.login == owner } ?: return
        if (!ready || busy) return
        busy = true
        taken = false
        problem = null
        scope.launch {
            when (val answer = deps.browse.createRepo(hub.token, chosen, name)) {
                is BrowseResult.Ok -> onCreated(placeIn(answer.value, hub.token), notebook.trim())
                is BrowseResult.Failed -> if (answer.error.reason == BrowseReason.EXISTS) taken = true else problem = answer.error.message
            }
            busy = false
        }
    }
    Frame(
        "create",
        "Create New Repo",
        step = 2,
        back = back,
        actions = {
            if (problem != null && owners.size > 1) Plain("Change Owner", "first-run-change-owner", "users", event = "firstrun.create.change-owner") { changing = true }
            Primary(
                when {
                    busy -> "Creating…"
                    problem != null -> "Try Again"
                    else -> "Make Notebook"
                },
                "first-run-create-submit", "plus",
                enabled = ready,
                busy = busy,
                onClick = ::create,
                event = "firstrun.create.make-notebook",
            )
        },
    ) {
        switcher?.invoke()
        NameField(notebook, "first-run-create-notebook") {
            notebook = it
            if (!edited) repoName = defaultRepoName(it)
        }
        OutlinedTextField(
            repoName,
            {
                repoName = it
                edited = true
                taken = false
                problem = null
            },
            Modifier.fillMaxWidth().testTag("first-run-create-repo"),
            label = { Text("Repository") },
            prefix = { Text("${owner.ifEmpty { "…" }} / ") },
            isError = taken,
            singleLine = true,
        )
        if (taken) {
            Problem("$owner/$name already exists.", "first-run-create-taken")
            Row {
                Link("Use $name-2", "first-run-create-suggest", "check", event = "firstrun.create.use-suggestion") {
                    repoName = "$name-2"
                    edited = true
                    taken = false
                }
                Link("Use Existing Repo", "first-run-use-existing", "folder-git-2", event = "firstrun.create.use-existing-repo", onClick = onUseExisting)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip("Private")
            Text("Owner ${owner.ifEmpty { "…" }}", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (owners.size > 1 && !changing) Link("Change", "first-run-create-change", "pencil", event = "firstrun.create.change") { changing = true }
        }
        if (changing) {
            Column(Modifier.selectableGroup()) {
                for (each in owners) {
                    Row(
                        Modifier.fillMaxWidth().selectable(each.login == owner, role = Role.RadioButton, onClick = trackedClick("firstrun.owner") {
                            owner = each.login
                            problem = null
                            taken = false
                        }).padding(vertical = 4.dp).testTag("first-run-create-owner-${each.login}"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(each.login == owner, onClick = null)
                        Text(if (each.org) each.login else "${each.login} (you)", Modifier.padding(start = 8.dp), style = MaterialTheme.roles.rowLabel)
                    }
                }
            }
        }
        if (owners.isEmpty()) Problem("GitHub didn’t say where a repository can be made. Go back and try again.", "first-run-create-problem")
        problem?.let { Problem(it, "first-run-create-problem") }
        // Made in another GitHub account, such as a work one (A1616): Settings → GitHub's page.
    }
}

/**
 * Use Existing Repo (A1405): the repositories the sign-in reaches, most recently pushed first, with
 * a filter. The top few are read at once for the notebooks in them, which show beneath with Open;
 * a repository opens on its own screen.
 */
@Composable
internal fun RepoTree(
    hub: Hub,
    goal: Goal,
    added: Set<String>,
    reads: Map<String, RepoRead>,
    read: (GitHubRepo, Boolean) -> Unit,
    onRepo: (GitHubRepo) -> Unit,
    onOpen: (GitHubRepo, RepoFolder) -> Unit,
    onUrl: () -> Unit,
    onCreate: (() -> Unit)?,
    onRefresh: () -> Unit,
    back: () -> Unit,
    /** The account switcher (option 2, A1616): whose repositories these are, and the others. */
    switcher: (@Composable () -> Unit)? = null,
) {
    val repos = hub.list.repos
    var filter by remember { mutableStateOf("") }
    LaunchedEffect(repos) {
        repos.filter { !it.empty }.take(READ_AT_ONCE).forEach { read(it, false) }
    }
    // Whose repositories these are, as a control (option 2, A1616): every account, Add Another
    // Account, Manage GitHub Accounts and Refresh.
    val signedIn = @Composable {
        if (switcher != null) {
            switcher()
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    hub.login?.let { "Signed in as $it" } ?: "Signed in to GitHub",
                    Modifier.testTag("first-run-via"),
                    style = MaterialTheme.roles.help,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Link("Refresh", "first-run-refresh", "refresh-cw", event = "firstrun.list.refresh", onClick = onRefresh)
            }
        }
    }
    if (repos.isEmpty()) {
        Frame(
            "list",
            "Pick Repository",
            step = 2,
            back = back,
            actions = { if (onCreate != null) Primary("Create New Repo", "first-run-create-instead", "plus", onClick = onCreate, event = "firstrun.list.create-new-repo") },
            below = { Link("Paste a URL Instead", "first-run-url-instead", "link", event = "firstrun.list.paste-a-url-instead", onClick = onUrl) },
        ) {
            Lead("GitHub lists no repository ${hub.login?.let { "for $it" } ?: "for this sign-in"}.", Modifier.testTag("first-run-no-repos"))
            signedIn()
        }
        return
    }
    val query = filter.trim().lowercase()
    val shown = if (query.isEmpty()) repos else repos.filter { it.fullName.lowercase().contains(query) }
    Frame("list", "Pick Repository", step = 2, back = back) {
        Lead(if (goal == Goal.NEW) "Pick an empty repository, or one to add a notebook to." else "Pick the repository that holds your notebook.")
        // Whose repositories these are, and Use a Different GitHub Account, above the list (Ryan, 17 Nov 2026).
        signedIn()
        OutlinedTextField(filter, { filter = it }, Modifier.fillMaxWidth().testTag("first-run-filter"), label = { Text("Filter") }, singleLine = true)
        Text(
            if (query.isEmpty()) "${repos.size} ${if (repos.size == 1) "repository" else "repositories"}." else "${shown.size} of ${repos.size} match.",
            Modifier.testTag("first-run-filter-count"),
            style = MaterialTheme.roles.meta,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            for ((at, repo) in shown.withIndex()) {
                if (at > 0) HorizontalDivider()
                RepoRow(repo, reads[readKey(repo, repo.defaultBranch.ifEmpty { "main" })], added, onRepo, onOpen)
            }
        }
        if (hub.list.more) Lead("Showing the 300 most recently pushed. Paste a URL for others.", small = true)
        Link("Paste a URL Instead", "first-run-url-instead", "link", event = "firstrun.list.paste-a-url-instead", onClick = onUrl)
    }
}

@Composable
private fun RepoRow(repo: GitHubRepo, loaded: RepoRead?, added: Set<String>, onRepo: (GitHubRepo) -> Unit, onOpen: (GitHubRepo, RepoFolder) -> Unit) {
    Column(Modifier.fillMaxWidth().testTag("first-run-repo-${repo.fullName}")) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = repo.canPush, role = Role.Button, onClick = trackedClick("firstrun.repo") { onRepo(repo) })
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(repo.fullName, style = MaterialTheme.roles.rowLabel, color = if (repo.canPush) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                Text(repo.visibility.words, style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (repo.empty) Chip("Empty")
            if (!repo.canPush) Chip("Read Only")
            if (repo.canPush) Text("›", style = MaterialTheme.roles.rowLabel)
        }
        val notebooks = (loaded as? RepoRead.Ready)?.let { notebooksIn(it.folders) }.orEmpty()
        if (loaded == RepoRead.Loading) {
            Text("Looking for notebooks…", Modifier.padding(start = 24.dp, bottom = 8.dp), style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        for (folder in notebooks) {
            val notebook = folder.notebook!!
            Row(
                Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, bottom = 8.dp).testTag("first-run-notebook-${repo.fullName}/${folder.path}"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(notebook.name, style = MaterialTheme.roles.rowLabel)
                    Text(folderWords(folder.path), style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (notebook.id in added) Chip("Already Added", "first-run-already-added")
                else if (repo.canPush) Plain("Open", "first-run-notebook-open", "folder-open", event = "firstrun.list.open") { onOpen(repo, folder) }
            }
        }
    }
}

/**
 * One repository picked (A1405): empty, it starts at the root; holding a notebook, it opens (never
 * a second one silently); holding several, pick one; holding other files, pick a folder.
 */
@Composable
internal fun RepoPicked(
    repo: GitHubRepo,
    token: String,
    added: Set<String>,
    loaded: RepoRead?,
    read: (GitHubRepo, Boolean) -> Unit,
    /** The branch Pick Branch chose: its folders are the ones shown, and the notebook syncs it. */
    branch: String = repo.defaultBranch.ifEmpty { "main" },
    onOpen: (Place, String) -> Unit,
    onName: (Place) -> Unit,
    onFolder: () -> Unit,
    onUrl: () -> Unit,
    back: () -> Unit,
) {
    val picked = branch
    var branch by remember { mutableStateOf(picked) }
    var dir by remember { mutableStateOf("") }
    var pick by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(loaded == null) { if (loaded == null) read(repo, false) }
    when (loaded) {
        null, RepoRead.Loading -> {
            Frame("repo", "Pick Repository", step = 2, back = back) { Working("Reading ${repo.fullName}…") }
            return
        }
        is RepoRead.Failed -> {
            Frame(
                "repo",
                "Pick Repository",
                step = 2,
                back = back,
                actions = { Primary("Try Again", "first-run-retry", "refresh-cw", event = "firstrun.repo.try-again") { read(repo, true) } },
                below = { Link("Paste a URL Instead", "first-run-url-instead", "link", event = "firstrun.repo.paste-a-url-instead", onClick = onUrl) },
            ) { Problem("Couldn’t read ${repo.fullName}: ${loaded.message}", "first-run-repo-problem") }
            return
        }
        is RepoRead.Ready -> Unit
    }
    val folders = loaded.folders
    val notebooks = notebooksIn(folders)
    val branchNow = picked
    val rootIsNotebook = notebooks.any { it.path.isEmpty() }
    when {
        // Empty, so the notebook starts at its root.
        folders.empty -> Frame(
            "repo-empty",
            "Empty Repository",
            step = 2,
            back = back,
            actions = {
                Primary("Continue", "first-run-continue", "arrow-right", event = "firstrun.continue") {
                    onName(placeIn(repo, token, dir.trim().trim('/'), branch.trim().ifEmpty { "main" }))
                }
            },
        ) {
            Lead("A new notebook starts at its Root.")
            PlaceCard(repo.fullName, dir.trim(), branch.trim().ifEmpty { "main" })
            MoreOptions(branch, dir, { branch = it }, { dir = it })
        }
        // One notebook, already on the phone: nothing to open, so straight to the folders to
        // start another, the notebook's own folder marked Already Added (Ryan, 18 Nov 2026; A1623).
        notebooks.size == 1 && notebooks.single().notebook!!.id in added && !rootIsNotebook ->
            FolderPick(
                repo, token, folders, beside = true, onName = onName, back = back, added = added, onOpen = onOpen, branch = picked,
                lead = "${notebooks.single().notebook!!.name} is already on this phone. Pick a folder for a new notebook.",
            )
        // One notebook: open it, or browse the folders to start another beside it.
        notebooks.size == 1 -> {
            val only = notebooks.single()
            val notebook = only.notebook!!
            Frame("repo-one", "${notebook.name} Is Already Here", step = 2, back = back) {
                Lead("This repository already holds a notebook.")
                PlaceCard(repo.fullName, only.path, branchNow, notebook.name)
                if (notebook.id in added) {
                    Lead("Already Added: it is on this phone.", Modifier.testTag("first-run-already-added"), small = true)
                } else {
                    Primary("Open ${notebook.name}", "first-run-open", "folder-open", event = "firstrun.repo.open") { onOpen(placeIn(repo, token, only.path, picked), notebook.name) }
                }
                if (!rootIsNotebook) Link("Start Another Notebook in a Folder", "first-run-start-another", "folder-plus", event = "firstrun.repo.start-another", onClick = onFolder)
            }
        }
        // Several notebooks: pick one.
        notebooks.size > 1 -> {
            val chosen = notebooks.firstOrNull { it.path == pick } ?: notebooks.firstOrNull { it.notebook!!.id !in added } ?: notebooks.first()
            Frame(
                "repo-several",
                "Pick Notebook",
                step = 2,
                back = back,
                actions = {
                    Primary("Open ${chosen.notebook!!.name}", "first-run-open", "folder-open", enabled = chosen.notebook.id !in added, event = "firstrun.repo.open") {
                        onOpen(placeIn(repo, token, chosen.path, branchNow), chosen.notebook.name)
                    }
                },
            ) {
                Lead("${repo.fullName} holds ${notebooks.size} notebooks.")
                Options(
                    chosen.path,
                    notebooks.map { each ->
                        val id = each.notebook!!.id
                        Option(each.path, each.notebook.name, folderWords(each.path), "first-run-pick-notebook", chip = if (id in added) "Already Added" else null, enabled = id !in added, event = "firstrun.notebook")
                    },
                ) { pick = it }
                if (!rootIsNotebook) Link("Start Another Notebook in a Folder", "first-run-start-another", "folder-plus", event = "firstrun.repo.start-another", onClick = onFolder)
            }
        }
        // Other files: pick where the notebook goes.
        else -> FolderPick(repo, token, folders, beside = false, onName = onName, back = back, added = added, onOpen = onOpen, branch = picked)
    }
}

/** Where one repository's folders on one branch are kept while the flow is open. */
internal fun readKey(repo: GitHubRepo, branch: String) = "${repo.fullName}@$branch"

/** What Pick Branch has of a repository's branches. */
private sealed interface BranchRead {
    data object Loading : BranchRead
    data class Ready(val names: List<String>) : BranchRead
    data class Failed(val message: String) : BranchRead
}

/**
 * Pick Branch (Ryan, 18 Nov 2026; A1621): after the repository and before its folders, since each
 * branch can hold other folders. The default branch first, marked Default and picked; a filter
 * once there are more than [BRANCH_FILTER_AT]. With one branch (or an empty repository, none yet)
 * there is nothing to pick, so it goes straight on with [onOnly].
 */
@Composable
internal fun BranchPick(
    repo: GitHubRepo,
    branches: suspend () -> BrowseResult<List<String>>,
    onOnly: (String) -> Unit,
    onPick: (String) -> Unit,
    back: () -> Unit,
) {
    val default = repo.defaultBranch.ifEmpty { "main" }
    var read by remember { mutableStateOf<BranchRead>(BranchRead.Loading) }
    var attempt by remember { mutableStateOf(0) }
    var pick by rememberSaveable { mutableStateOf(default) }
    var filter by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(attempt) {
        read = BranchRead.Loading
        read = when (val answer = branches()) {
            is BrowseResult.Ok -> if (answer.value.size <= 1) {
                onOnly(answer.value.firstOrNull() ?: default)
                BranchRead.Loading
            } else BranchRead.Ready(answer.value)
            is BrowseResult.Failed -> BranchRead.Failed(answer.error.message)
        }
    }
    when (val now = read) {
        BranchRead.Loading -> Frame("branch", "Pick Branch", step = 2, back = back) { Working("Reading ${repo.fullName}’s branches…") }
        is BranchRead.Failed -> Frame(
            "branch",
            "Pick Branch",
            step = 2,
            back = back,
            actions = { Primary("Try Again", "first-run-retry", "refresh-cw", event = "firstrun.branch.try-again") { attempt += 1 } },
            below = { Link("Use $default", "first-run-branch-default", "git-branch", event = "firstrun.branch.use-default") { onPick(default) } },
        ) { Problem("Couldn’t read ${repo.fullName}’s branches: ${now.message}", "first-run-branch-problem") }
        is BranchRead.Ready -> {
            val query = filter.trim()
            val shown = if (query.isEmpty()) now.names else now.names.filter { it.contains(query, ignoreCase = true) }
            Frame(
                "branch",
                "Pick Branch",
                step = 2,
                back = back,
                actions = { Primary("Continue", "first-run-continue", "arrow-right", enabled = pick in now.names, event = "firstrun.continue") { onPick(pick) } },
            ) {
                Lead("${repo.fullName} has ${now.names.size} branches. Each can hold other folders, and the notebook syncs the one you pick.")
                if (now.names.size > BRANCH_FILTER_AT) {
                    OutlinedTextField(
                        filter,
                        { filter = it },
                        Modifier.fillMaxWidth().testTag("first-run-branch-filter"),
                        placeholder = { Text("Filter Branches") },
                        leadingIcon = { rememberLucideIcons()?.icon("search")?.let { Icon(LucideAssets.vector(it), contentDescription = null, Modifier.size(18.dp)) } },
                        singleLine = true,
                    )
                }
                Options(
                    pick,
                    shown.map { name ->
                        Option(name, name, if (name == default) "The repository’s default branch" else "", "first-run-pick-branch", chip = if (name == default) "Default" else null, event = "firstrun.branch")
                    },
                ) { pick = it }
                if (shown.isEmpty()) Lead("No branch matches “$query”.", small = true)
            }
        }
    }
}

/** More branches than this and Pick Branch has a filter. */
private const val BRANCH_FILTER_AT = 8

/**
 * Pick Folder (Ryan's pick, option 1 of the Pick Folder Options canvas, "Tree With Filter", 18 Nov
 * 2026; A1620), drawn as the canvas draws it. Under the title, Filter Folders and one square
 * Collapse All / Expand All button; then the tree, which scrolls on its own: guide lines for each
 * level (the chosen folder's own line in the accent), a chevron where a folder holds folders, its
 * folder icon and name, how many it holds while closed, and a tick on the chosen one. A filter
 * keeps each match's parents and marks the match. A folder that holds a Penmoss notebook stands
 * out (Ryan's ask): its notebook icon and name, Already Added or Open, and Notebooks (N) shows only
 * those. Above the footer, Notebook Goes In names the folder, with New Folder….
 */
@Composable
internal fun FolderPick(
    repo: GitHubRepo,
    token: String,
    folders: RepoFolders,
    beside: Boolean,
    onName: (Place) -> Unit,
    back: () -> Unit,
    added: Set<String> = emptySet(),
    onOpen: ((Place, String) -> Unit)? = null,
    /** The branch these folders are on (Pick Branch). */
    branch: String = repo.defaultBranch.ifEmpty { "main" },
    /** The line under the title, when the screen before says why the folders are here. */
    lead: String? = null,
) {
    val made = remember { mutableStateListOf<String>() }
    val notebooks = remember(folders) { folders.folders.filter { it.notebook != null && it.path.isNotEmpty() }.associate { it.path to it.notebook!! } }
    val free = (folders.folders.filter { it.notebook == null }.map { it.path } + made).distinct()
    val all = (free + notebooks.keys).filter { it.isNotEmpty() }.distinct().sorted()
    fun parentOf(path: String) = path.substringBeforeLast('/', "")
    val children = all.groupBy { parentOf(it) }
    fun ancestors(path: String): List<String> = generateSequence(parentOf(path).takeIf { path.contains('/') }) { p -> parentOf(p).takeIf { p.contains('/') } }.toList()
    var chosen by remember { mutableStateOf(free.firstOrNull { it.isEmpty() } ?: free.firstOrNull().orEmpty()) }
    // Open at first: the levels down to each notebook, so they show without a tap.
    var open by remember { mutableStateOf(notebooks.keys.flatMap { ancestors(it) }.toSet()) }
    var filter by remember { mutableStateOf("") }
    var onlyNotebooks by remember { mutableStateOf(false) }
    var making by remember { mutableStateOf(false) }
    val query = filter.trim()
    val matches = if (query.isEmpty()) emptySet() else all.filter { it.substringAfterLast('/').contains(query, ignoreCase = true) }.toSet()
    // With a filter (or Notebooks), the matches and their parents, every level open.
    val shown: Set<String>? = when {
        onlyNotebooks -> notebooks.keys.flatMap { ancestors(it) + it }.toSet()
        query.isNotEmpty() -> matches.flatMap { ancestors(it) + it }.toSet()
        else -> null
    }
    val rows = buildList {
        fun walk(parent: String, depth: Int) {
            for (path in children[parent].orEmpty()) {
                if (shown != null && path !in shown) continue
                add(path to depth)
                if (shown != null || path in open) walk(path, depth + 1)
            }
        }
        walk("", 0)
    }
    // The chosen folder and the folders above it: their icons and guide lines in the accent.
    val line = if (chosen.isEmpty()) emptySet() else (ancestors(chosen) + chosen).toSet()
    val colours = MaterialTheme.colorScheme
    Frame(
        "folder",
        "Pick Folder",
        step = 2,
        back = back,
        fill = true,
        strip = {
            Column(Modifier.weight(1f)) {
                Text("Notebook Goes In", style = MaterialTheme.roles.meta, color = colours.onSurfaceVariant)
                Text(
                    if (chosen.isEmpty()) "Root (${repo.fullName})" else "$chosen/",
                    Modifier.testTag("first-run-folder-chosen"),
                    style = MaterialTheme.roles.help.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                )
            }
            Link("New Folder…", "first-run-new-folder-open", "folder-plus", event = "firstrun.folder.new-folder") { making = true }
        },
        actions = { Primary("Continue", "first-run-continue", "arrow-right", enabled = chosen in free, event = "firstrun.continue") { onName(placeIn(repo, token, chosen, branch)) } },
    ) {
        Lead(lead ?: if (beside) "Pick where the new notebook goes." else "${repo.fullName} holds other files. Pick where the notebook goes.")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                filter,
                { filter = it },
                Modifier.weight(1f).testTag("first-run-folder-filter"),
                placeholder = { Text("Filter Folders") },
                leadingIcon = { LucideGlyph("search", null, 20.dp) },
                trailingIcon = if (filter.isEmpty()) null else ({
                    Box(Modifier.size(44.dp).clickable(role = Role.Button, onClickLabel = "Clear Filter", onClick = trackedClick("firstrun.folder.clear-filter") { filter = "" }).testTag("first-run-folder-clear"), contentAlignment = Alignment.Center) {
                        LucideGlyph("x", "Clear Filter", 20.dp)
                    }
                }),
                singleLine = true,
            )
            val anyOpen = open.isNotEmpty()
            Box(
                Modifier
                    .size(56.dp)
                    .border(1.dp, colours.outlineVariant)
                    .clickable(enabled = shown == null, role = Role.Button, onClickLabel = if (anyOpen) "Collapse All" else "Expand All", onClick = trackedClick("firstrun.folder.expand-all") {
                        open = if (anyOpen) emptySet() else children.keys.filter { it.isNotEmpty() }.toSet()
                    })
                    .testTag("first-run-folder-all"),
                contentAlignment = Alignment.Center,
            ) { LucideGlyph(if (anyOpen) "chevrons-down-up" else "chevrons-up-down", if (anyOpen) "Collapse All" else "Expand All", 20.dp) }
        }
        if (notebooks.isNotEmpty()) {
            androidx.compose.material3.FilterChip(
                selected = onlyNotebooks,
                onClick = trackedClick("firstrun.folder.only-notebooks") { onlyNotebooks = !onlyNotebooks },
                label = { Text("Notebooks (${notebooks.size})", maxLines = 1, softWrap = false) },
                leadingIcon = { LucideGlyph("notebook", null, 16.dp) },
                shape = androidx.compose.ui.graphics.RectangleShape,
                modifier = Modifier.testTag("first-run-folder-notebooks"),
            )
        }
        androidx.compose.foundation.lazy.LazyColumn(Modifier.weight(1f).fillMaxWidth().selectableGroup().testTag("first-run-folder-tree")) {
            if (shown == null && "" in free) {
                item(key = "") { RootRow(repo.fullName, chosen == "") { chosen = "" } }
            }
            items(rows.size, key = { rows[it].first }) { index ->
                val (path, depth) = rows[index]
                val notebook = notebooks[path]
                val kids = children[path].orEmpty().size
                val expanded = if (kids == 0) null else (shown != null || path in open)
                FolderRow(
                    name = path.substringAfterLast('/'),
                    guides = (0 until depth).map { level -> line.contains(path.split('/').take(level + 1).joinToString("/")) && path in line },
                    selected = chosen == path,
                    onLine = path in line,
                    dim = shown != null && query.isNotEmpty() && path !in matches,
                    count = if (expanded == false) kids else null,
                    notebook = notebook,
                    alreadyAdded = notebook != null && notebook.id in added,
                    made = path in made,
                    expanded = expanded,
                    highlight = query.takeIf { it.isNotEmpty() },
                    onOpen = if (notebook != null && notebook.id !in added && onOpen != null) ({ onOpen(placeIn(repo, token, path, branch), notebook.name) }) else null,
                    onToggle = { if (shown == null) open = if (path in open) open - path else open + path },
                ) { if (notebook == null) chosen = path }
            }
            if (shown != null && rows.isEmpty()) {
                item {
                    Column(Modifier.padding(vertical = 24.dp).testTag("first-run-folder-none"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (onlyNotebooks) "No Notebooks Here" else "No Folder Matches “$query”", style = MaterialTheme.roles.rowLabel)
                        Lead("Folders starting with a dot, and folders inside a notebook, aren’t listed.", small = true)
                    }
                }
            }
            if (folders.truncated) {
                item { Lead("GitHub left some folders out of a large repository. Paste a URL with the folder for one not listed.", Modifier.padding(top = 8.dp), small = true) }
            }
        }
    }
    if (making) {
        NewFolderDialog(chosen, onDismiss = { making = false }) { name ->
            val path = if (chosen.isEmpty()) name else "$chosen/$name"
            if (path !in made) made += path
            open = open + ancestors(path) + listOfNotNull(chosen.takeIf { it.isNotEmpty() })
            chosen = path
            filter = ""
            onlyNotebooks = false
            making = false
        }
    }
}

/** New Folder…: its name, made inside the chosen folder at the first sync. */
@Composable
private fun NewFolderDialog(inside: String, onDismiss: () -> Unit, onMake: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val tracked = rememberTrackedDialog("newFolder")
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New Folder in ${folderWords(inside)}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it; problem = null }, Modifier.fillMaxWidth().testTag("first-run-new-folder").typedLength("newFolder", "name", name), label = { Text("Folder Name") }, singleLine = true)
                problem?.let { Problem(it, "first-run-new-folder-problem") }
                Lead("Made at the first sync.", small = true)
            }
        },
        confirmButton = {
            Plain("Add Folder", "first-run-new-folder-add", "folder-plus", event = "firstrun.folder.add-folder") {
                val words = folderNameProblem(name)
                if (words != null) {
                    problem = words
                } else {
                    tracked.done()
                    onMake(name.trim())
                }
            }
        },
        dismissButton = { Plain("Cancel", "first-run-new-folder-cancel", "x", onClick = onDismiss, event = "firstrun.folder.cancel") },
        shape = androidx.compose.ui.graphics.RectangleShape,
    )
}

/** Pick Folder's first row: the top of the repository. */
@Composable
private fun RootRow(repo: String, selected: Boolean, onSelect: () -> Unit) {
    val colours = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .height(44.dp)
            .selectable(selected, role = Role.RadioButton, onClick = trackedClick("firstrun.folder", onSelect))
            .background(if (selected) colours.primary.copy(alpha = 0.18f) else androidx.compose.ui.graphics.Color.Transparent)
            .padding(start = 8.dp, end = 10.dp)
            .testTag("first-run-folder-option"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides colours.primary) { LucideGlyph("book", null, 20.dp) }
        Text("Root", style = MaterialTheme.roles.rowLabel.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium))
        Text("Top of the repository", Modifier.weight(1f), style = MaterialTheme.roles.help, color = colours.onSurfaceVariant, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        if (selected) androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides colours.primary) { LucideGlyph("check", "Chosen", 20.dp) }
    }
}

/**
 * One folder in Pick Folder's tree, as the canvas draws it: a guide line for each level above
 * (the accent on the chosen folder's own line), a chevron when it holds folders, then the row
 * itself: its folder icon, name, count while closed, and a tick when chosen. A folder holding a
 * notebook has the notebook's icon and name instead, and isn't a place for another.
 */
@Composable
private fun FolderRow(
    name: String,
    guides: List<Boolean>,
    selected: Boolean,
    onLine: Boolean,
    dim: Boolean,
    count: Int?,
    notebook: FolderNotebook?,
    alreadyAdded: Boolean,
    made: Boolean,
    expanded: Boolean?,
    highlight: String?,
    onOpen: (() -> Unit)?,
    onToggle: () -> Unit,
    onSelect: () -> Unit,
) {
    val colours = MaterialTheme.colorScheme
    val accent = colours.primary
    Row(Modifier.fillMaxWidth().height(if (notebook != null) 56.dp else 44.dp), verticalAlignment = Alignment.CenterVertically) {
        for (lit in guides) {
            Box(Modifier.width(18.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
                Box(Modifier.width(1.dp).fillMaxHeight().background(if (lit) accent.copy(alpha = 0.55f) else colours.outlineVariant))
            }
        }
        Box(
            Modifier.width(30.dp).fillMaxHeight().then(
                if (expanded != null) Modifier.clickable(role = Role.Button, onClickLabel = if (expanded) "Collapse" else "Expand", onClick = trackedClick("firstrun.folder.toggle", onToggle)).testTag("first-run-folder-toggle") else Modifier,
            ),
            contentAlignment = Alignment.Center,
        ) {
            if (expanded != null) {
                androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides colours.onSurfaceVariant) {
                    LucideGlyph(if (expanded) "chevron-down" else "chevron-right", if (expanded) "Collapse $name" else "Expand $name", 20.dp)
                }
            }
        }
        Row(
            Modifier
                .weight(1f)
                .fillMaxHeight()
                .then(if (notebook == null) Modifier.selectable(selected, role = Role.RadioButton, onClick = trackedClick("firstrun.folder", onSelect)) else Modifier)
                .background(if (selected) accent.copy(alpha = 0.18f) else androidx.compose.ui.graphics.Color.Transparent)
                .padding(start = 4.dp, end = 10.dp)
                .testTag(if (notebook != null) "first-run-folder-notebook" else "first-run-folder-option")
                .semantics { if (expanded != null) stateDescription = if (expanded) "Expanded" else "Collapsed" },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            androidx.compose.runtime.CompositionLocalProvider(
                androidx.compose.material3.LocalContentColor provides if (notebook != null || selected || onLine) accent else colours.onSurfaceVariant,
            ) { LucideGlyph(if (notebook != null) "notebook" else "folder", null, 20.dp) }
            Column(Modifier.weight(1f)) {
                Text(
                    highlighted(name, highlight, accent),
                    style = MaterialTheme.roles.rowLabel.copy(fontWeight = if (selected) androidx.compose.ui.text.font.FontWeight.Medium else androidx.compose.ui.text.font.FontWeight.Normal),
                    color = if (dim) colours.onSurfaceVariant else colours.onSurface,
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                when {
                    notebook != null -> Text(
                        if (alreadyAdded) "Notebook: ${notebook.name} · Already Added" else "Notebook: ${notebook.name}",
                        Modifier.testTag("first-run-folder-notebook-chip"),
                        style = MaterialTheme.roles.meta,
                        color = accent,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    )
                    made -> Text("New, made at the first sync", style = MaterialTheme.roles.meta, color = colours.onSurfaceVariant)
                }
            }
            if (count != null) {
                Text(
                    "$count",
                    Modifier.background(colours.surfaceContainerHigh, androidx.compose.foundation.shape.RoundedCornerShape(10.dp)).padding(horizontal = 6.dp),
                    style = MaterialTheme.roles.meta,
                    color = colours.onSurfaceVariant,
                )
            }
            if (selected) androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides accent) { LucideGlyph("check", "Chosen", 20.dp) }
            if (onOpen != null) Plain("Open", "first-run-folder-open", "folder-open", onClick = onOpen, event = "firstrun.folder.open")
        }
    }
}

/** [name] with each match of [query] in the accent and bold, as the filter finds it. */
private fun highlighted(name: String, query: String?, mark: androidx.compose.ui.graphics.Color) = androidx.compose.ui.text.buildAnnotatedString {
    if (query.isNullOrEmpty()) { append(name); return@buildAnnotatedString }
    var at = 0
    while (true) {
        val hit = name.indexOf(query, at, ignoreCase = true)
        if (hit < 0) { append(name.substring(at)); break }
        append(name.substring(at, hit))
        withStyle(androidx.compose.ui.text.SpanStyle(color = mark, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)) { append(name.substring(hit, hit + query.length)) }
        at = hit + query.length
    }
}

/**
 * Paste a URL: any HTTPS git repository. A github.com address uses the phone's GitHub sign-in
 * when it has one, else a token typed here. Added without a name, it opens the notebook the
 * address holds, or asks for a name when it holds none.
 */
@Composable
internal fun PasteUrl(deps: FirstRunDeps, add: suspend (Place, String?) -> AddResult, onAdded: (Setup) -> Unit, onName: (Place) -> Unit, back: () -> Unit) {
    var remote by remember { mutableStateOf("") }
    var branch by remember { mutableStateOf("main") }
    var dir by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val signedIn = remember { deps.token() }
    val github = isGitHub(remote)
    val usesSignIn = github && signedIn != null && token.isBlank()
    fun check() {
        if (busy || remote.isBlank()) return
        busy = true
        problem = null
        val address = remote.trim()
        val folder = dir.trim().trim('/')
        val place = Place(
            remote = address,
            branch = branch.trim().ifEmpty { "main" },
            dir = folder,
            label = address.removePrefix("https://").removeSuffix(".git"),
            token = token.trim().ifEmpty { if (github) signedIn else null },
            suggested = nameFromRepo(if (folder.isNotEmpty()) folder.substringAfterLast('/') else repoNameOf(address)),
        )
        scope.launch {
            try {
                when (val result = add(place, null)) {
                    AddResult.NeedsName -> onName(place)
                    is AddResult.Added -> onAdded(Setup.Added(place, result.notebook.name, result.notebook.localId))
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: GitRefusal) {
                problem = error.message
            } catch (error: Exception) {
                problem = error.message ?: "Penmoss could not add the notebook."
            } finally {
                busy = false
            }
        }
    }
    Frame(
        "url",
        "Paste a URL",
        step = 2,
        back = back,
        actions = {
            Primary(
                when {
                    busy -> "Checking…"
                    problem != null -> "Try Again"
                    else -> "Continue"
                },
                "first-run-continue", "arrow-right",
                enabled = remote.isNotBlank(),
                busy = busy,
                onClick = ::check,
                event = "firstrun.continue",
            )
        },
    ) {
        OutlinedTextField(
            remote,
            { remote = it; problem = null },
            Modifier.fillMaxWidth().testTag("first-run-url-input"),
            label = { Text("Repository URL") },
            placeholder = { Text("https://github.com/you/notes") },
            isError = problem != null,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        Lead("The https:// address of a git repository. Android syncs over HTTPS only.", small = true)
        OutlinedTextField(
            token,
            { token = it; problem = null },
            Modifier.fillMaxWidth().testTag("first-run-url-token"),
            label = { Text(if (github && signedIn != null) "Personal Access Token (Optional)" else "Personal Access Token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        Lead(
            if (usesSignIn) {
                "Uses your GitHub sign-in${deps.login()?.let { " ($it)" }.orEmpty()}."
            } else {
                "GitHub: a fine-grained token with Contents read and write and Metadata read on that repository. Kept with the Android Keystore."
            },
            Modifier.testTag("first-run-url-token-help"),
            small = true,
        )
        MoreOptions(branch, dir, { branch = it }, { dir = it })
        if (busy) Working("Asking the repository…")
        problem?.let { Problem(it, "first-run-url-problem") }
    }
}

/** Name Your Notebook: a new notebook's name, offered from the repository's. */
@Composable
internal fun NameNotebook(place: Place, onMake: (String) -> Unit, back: () -> Unit) {
    var name by remember { mutableStateOf(place.suggested) }
    Frame(
        "name",
        "Name Your Notebook",
        step = 3,
        back = back,
        actions = { Primary("Make Notebook", "first-run-make", "plus", enabled = name.isNotBlank(), event = "firstrun.name.make-notebook") { onMake(name.trim()) } },
    ) {
        Lead("It shows in your list of notebooks.")
        NameField(name, "first-run-name-input") { name = it }
        PlaceCard(place.label, place.dir, place.branch)
    }
}

/**
 * Whose repositories these are, as a control (Ryan's pick of option 2 in the account designs,
 * 17 Nov 2026; A1616): the account, then a sheet of every account, Add Another Account, Manage
 * GitHub Accounts (Settings → GitHub's page inside the flow) and Refresh.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun AccountSwitcher(
    login: String?,
    accounts: List<app.penmoss.feedback.GitHubAccount>,
    onPick: (app.penmoss.feedback.GitHubAccount) -> Unit,
    onAdd: (() -> Unit)?,
    onManage: (() -> Unit)?,
    onRefresh: (() -> Unit)?,
) {
    var open by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant)
            .background(MaterialTheme.colorScheme.surfaceBright)
            .clickable(role = Role.Button, onClickLabel = "Change GitHub Account", onClick = trackedClick("firstrun.account.open") { open = true })
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .testTag("first-run-account-switcher"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AccountInitial(login)
        Column(Modifier.weight(1f)) {
            Text(login ?: "GitHub", Modifier.testTag("first-run-via"), style = MaterialTheme.roles.rowLabel)
            Text("Listing this account’s repositories", style = MaterialTheme.roles.help, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LucideGlyph("chevron-down", contentDescription = null, size = 20.dp)
    }
    if (open) {
        val tracked = rememberTrackedDialog("accounts")
        // A row picked: the sheet did its job, and closes.
        val close = {
            tracked.done()
            open = false
        }
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { open = false }, modifier = Modifier.testTag("first-run-account-sheet")) {
            Text(
                "GitHub Account",
                Modifier.padding(start = 22.dp, end = 22.dp, bottom = 8.dp),
                style = MaterialTheme.roles.help,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            for (account in accounts) {
                val current = account.login == login
                SheetRow("first-run-switch-${account.login.orEmpty()}", current, event = "firstrun.account", onClose = close, onClick = { if (!current) onPick(account) }) {
                    AccountInitial(account.login)
                    Column(Modifier.weight(1f)) {
                        Text(account.login ?: "Token (Account Not Named)", style = MaterialTheme.roles.rowLabel)
                        Text(
                            if (account.primary) "Send Feedback uses it" else "Signed in on this phone",
                            style = MaterialTheme.roles.help,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (current) LucideGlyph("check", contentDescription = "Listed now", size = 20.dp)
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            onAdd?.let { add ->
                SheetRow("first-run-switch-add", false, event = "firstrun.account.add", onClose = close, onClick = add) {
                    LucideGlyph("user-plus", contentDescription = null)
                    Text("Add Another Account", style = MaterialTheme.roles.rowLabel)
                }
            }
            onManage?.let { manage ->
                SheetRow("first-run-switch-manage", false, event = "firstrun.account.manage", onClose = close, onClick = manage) {
                    LucideGlyph("settings", contentDescription = null)
                    Text("Manage GitHub Accounts", style = MaterialTheme.roles.rowLabel)
                }
            }
            onRefresh?.let { refresh ->
                SheetRow("first-run-refresh", false, event = "firstrun.account.refresh", onClose = close, onClick = refresh) {
                    LucideGlyph("refresh-cw", contentDescription = null)
                    Text("Refresh Repositories", style = MaterialTheme.roles.rowLabel)
                }
            }
            androidx.compose.foundation.layout.Spacer(Modifier.padding(bottom = 16.dp))
        }
    }
}

/** One row of the account sheet: [onClose] closes the sheet, then [onClick] runs; counted as [event]. */
@Composable
private fun SheetRow(tag: String, selected: Boolean, event: String, onClose: () -> Unit, onClick: () -> Unit, content: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(role = Role.Button, onClick = trackedClick(event) {
                onClose()
                onClick()
            })
            .padding(horizontal = 22.dp, vertical = 12.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) { content() }
}

/** An account's first letter on a square of colour, so two accounts tell apart at a glance. */
@Composable
private fun AccountInitial(login: String?) {
    val shades = listOf(0xFF2F5E86, 0xFF7A5A2F, 0xFF3F7A4A, 0xFF7A3F6B, 0xFF5A4F8C)
    val shade = androidx.compose.ui.graphics.Color(shades[Math.floorMod((login ?: "").hashCode(), shades.size)])
    androidx.compose.foundation.layout.Box(
        Modifier.size(36.dp).background(shade),
        contentAlignment = Alignment.Center,
    ) {
        Text((login?.firstOrNull() ?: 'G').uppercaseChar().toString(), color = androidx.compose.ui.graphics.Color.White, style = MaterialTheme.roles.rowLabel)
    }
}
