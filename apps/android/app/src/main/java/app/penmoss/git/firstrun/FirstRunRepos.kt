package app.penmoss.git.firstrun

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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.roles
import kotlinx.coroutines.launch

/** The notebook name field. */
@Composable
internal fun NameField(value: String, tag: String, onChange: (String) -> Unit) {
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
