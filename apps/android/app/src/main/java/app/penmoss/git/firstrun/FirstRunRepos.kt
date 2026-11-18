package app.penmoss.git.firstrun

import androidx.compose.foundation.background
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
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
            if (problem != null && owners.size > 1) Plain("Change Owner", "first-run-change-owner", "users") { changing = true }
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
                Link("Use $name-2", "first-run-create-suggest", "check") {
                    repoName = "$name-2"
                    edited = true
                    taken = false
                }
                Link("Use Existing Repo", "first-run-use-existing", "folder-git-2", onUseExisting)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip("Private")
            Text("Owner ${owner.ifEmpty { "…" }}", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (owners.size > 1 && !changing) Link("Change", "first-run-create-change", "pencil") { changing = true }
        }
        if (changing) {
            Column(Modifier.selectableGroup()) {
                for (each in owners) {
                    Row(
                        Modifier.fillMaxWidth().selectable(each.login == owner, role = Role.RadioButton) {
                            owner = each.login
                            problem = null
                            taken = false
                        }.padding(vertical = 4.dp).testTag("first-run-create-owner-${each.login}"),
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
                Link("Refresh", "first-run-refresh", "refresh-cw", onRefresh)
            }
        }
    }
    if (repos.isEmpty()) {
        Frame(
            "list",
            "Pick Repository",
            step = 2,
            back = back,
            actions = { if (onCreate != null) Primary("Create New Repo", "first-run-create-instead", "plus", onClick = onCreate) },
            below = { Link("Paste a URL Instead", "first-run-url-instead", "link", onUrl) },
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
                RepoRow(repo, reads[repo.fullName], added, onRepo, onOpen)
            }
        }
        if (hub.list.more) Lead("Showing the 300 most recently pushed. Paste a URL for others.", small = true)
        Link("Paste a URL Instead", "first-run-url-instead", "link", onUrl)
    }
}

@Composable
private fun RepoRow(repo: GitHubRepo, loaded: RepoRead?, added: Set<String>, onRepo: (GitHubRepo) -> Unit, onOpen: (GitHubRepo, RepoFolder) -> Unit) {
    Column(Modifier.fillMaxWidth().testTag("first-run-repo-${repo.fullName}")) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = repo.canPush, role = Role.Button) { onRepo(repo) }
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
                else if (repo.canPush) Plain("Open", "first-run-notebook-open", "folder-open") { onOpen(repo, folder) }
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
    onOpen: (Place, String) -> Unit,
    onName: (Place) -> Unit,
    onFolder: () -> Unit,
    onUrl: () -> Unit,
    back: () -> Unit,
) {
    var branch by remember { mutableStateOf(repo.defaultBranch.ifEmpty { "main" }) }
    var dir by remember { mutableStateOf("") }
    var another by remember { mutableStateOf("") }
    var anotherProblem by remember { mutableStateOf<String?>(null) }
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
                actions = { Primary("Try Again", "first-run-retry", "refresh-cw") { read(repo, true) } },
                below = { Link("Paste a URL Instead", "first-run-url-instead", "link", onUrl) },
            ) { Problem("Couldn’t read ${repo.fullName}: ${loaded.message}", "first-run-repo-problem") }
            return
        }
        is RepoRead.Ready -> Unit
    }
    val folders = loaded.folders
    val notebooks = notebooksIn(folders)
    val branchNow = repo.defaultBranch.ifEmpty { "main" }
    val rootIsNotebook = notebooks.any { it.path.isEmpty() }
    when {
        // Empty, so the notebook starts at its root.
        folders.empty -> Frame(
            "repo-empty",
            "Empty Repository",
            step = 2,
            back = back,
            actions = {
                Primary("Continue", "first-run-continue", "arrow-right") {
                    onName(placeIn(repo, token, dir.trim().trim('/'), branch.trim().ifEmpty { "main" }))
                }
            },
        ) {
            Lead("A new notebook starts at its Root.")
            PlaceCard(repo.fullName, dir.trim(), branch.trim().ifEmpty { "main" })
            MoreOptions(branch, dir, { branch = it }, { dir = it })
        }
        // One notebook: open it, or start another in a folder beside it.
        notebooks.size == 1 -> {
            val only = notebooks.single()
            val notebook = only.notebook!!
            Frame("repo-one", "${notebook.name} Is Already Here", step = 2, back = back) {
                Lead("This repository already holds a notebook.")
                PlaceCard(repo.fullName, only.path, branchNow, notebook.name)
                if (notebook.id in added) {
                    Lead("Already Added: it is on this phone.", Modifier.testTag("first-run-already-added"), small = true)
                } else {
                    Primary("Open ${notebook.name}", "first-run-open", "folder-open") { onOpen(placeIn(repo, token, only.path), notebook.name) }
                }
                if (!rootIsNotebook) {
                    HorizontalDivider()
                    Text("Start Another Notebook in a Folder", style = MaterialTheme.roles.groupHead)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            another,
                            { another = it; anotherProblem = null },
                            Modifier.weight(1f).testTag("first-run-another"),
                            label = { Text("Folder Name") },
                            placeholder = { Text("journal") },
                            singleLine = true,
                        )
                        Plain("Make Notebook", "first-run-another-make", "folder-plus") {
                            val words = folderNameProblem(another)
                            if (words != null) anotherProblem = words else onName(placeIn(repo, token, another.trim()))
                        }
                    }
                    anotherProblem?.let { Problem(it, "first-run-another-problem") }
                }
            }
        }
        // Several notebooks: pick one.
        notebooks.size > 1 -> {
            val picked = notebooks.firstOrNull { it.path == pick } ?: notebooks.firstOrNull { it.notebook!!.id !in added } ?: notebooks.first()
            Frame(
                "repo-several",
                "Pick Notebook",
                step = 2,
                back = back,
                actions = {
                    Primary("Open ${picked.notebook!!.name}", "first-run-open", "folder-open", enabled = picked.notebook.id !in added) {
                        onOpen(placeIn(repo, token, picked.path), picked.notebook.name)
                    }
                },
            ) {
                Lead("${repo.fullName} holds ${notebooks.size} notebooks.")
                Options(
                    picked.path,
                    notebooks.map { each ->
                        val id = each.notebook!!.id
                        Option(each.path, each.notebook.name, folderWords(each.path), "first-run-pick-notebook", chip = if (id in added) "Already Added" else null, enabled = id !in added)
                    },
                ) { pick = it }
                if (!rootIsNotebook) Link("Start Another Notebook in a Folder", "first-run-start-another", "folder-plus", onFolder)
            }
        }
        // Other files: pick where the notebook goes.
        else -> FolderPick(repo, token, folders, beside = false, onName = onName, back = back, added = added, onOpen = onOpen)
    }
}

/**
 * Pick Folder (Ryan's pick, option 1 of the Pick Folder Options canvas, 18 Nov 2026; A1620): the
 * repository's folders as a tree whose levels open and close, with guide lines, a filter that keeps
 * each match's parents, and Expand All / Collapse All. A folder that holds a Penmoss notebook
 * stands out (its badge and name, Open when it isn't on the phone yet) and Notebooks (N) shows
 * only those. The root, or a folder with no notebook in it, takes the new one; New Folder makes one.
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
) {
    val made = remember { mutableStateListOf<String>() }
    val notebooks = remember(folders) { folders.folders.filter { it.notebook != null && it.path.isNotEmpty() }.associate { it.path to it.notebook!! } }
    val free = (folders.folders.filter { it.notebook == null }.map { it.path } + made).distinct()
    val all = remember(free, notebooks) { (free + notebooks.keys).filter { it.isNotEmpty() }.distinct().sorted() }
    fun parentOf(path: String) = path.substringBeforeLast('/', "")
    val children = remember(all) { all.groupBy { parentOf(it) } }
    fun ancestors(path: String): List<String> = generateSequence(parentOf(path).takeIf { path.contains('/') }) { p -> parentOf(p).takeIf { p.contains('/') } }.toList()
    var chosen by remember { mutableStateOf(free.firstOrNull { it.isEmpty() } ?: free.firstOrNull().orEmpty()) }
    // Open at first: the levels down to each notebook, so they show without a tap.
    var open by remember { mutableStateOf(notebooks.keys.flatMap { ancestors(it) }.toSet()) }
    var filter by remember { mutableStateOf("") }
    var onlyNotebooks by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val query = filter.trim()
    // With a filter (or Notebooks), the matches and their parents, every level open.
    val shown: Set<String>? = when {
        onlyNotebooks -> notebooks.keys.flatMap { ancestors(it) + it }.toSet()
        query.isNotEmpty() -> all.filter { it.substringAfterLast('/').contains(query, ignoreCase = true) }.flatMap { ancestors(it) + it }.toSet()
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
    Frame(
        "folder",
        "Pick Folder",
        step = 2,
        back = back,
        actions = { Primary("Continue", "first-run-continue", "arrow-right", enabled = chosen in free) { onName(placeIn(repo, token, chosen)) } },
    ) {
        Lead(if (beside) "Pick where the new notebook goes." else "${repo.fullName} holds other files. Pick where the notebook goes.")
        OutlinedTextField(
            filter,
            { filter = it },
            Modifier.fillMaxWidth().testTag("first-run-folder-filter"),
            label = { Text("Filter Folders") },
            leadingIcon = { LucideGlyph("search", null, 18.dp) },
            singleLine = true,
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (notebooks.isNotEmpty()) {
                androidx.compose.material3.FilterChip(
                    selected = onlyNotebooks,
                    onClick = { onlyNotebooks = !onlyNotebooks },
                    label = { Text("Notebooks (${notebooks.size})", maxLines = 1, softWrap = false) },
                    leadingIcon = { LucideGlyph("notebook", null, 16.dp) },
                    shape = androidx.compose.ui.graphics.RectangleShape,
                    modifier = Modifier.testTag("first-run-folder-notebooks"),
                )
            }
            Spacer(Modifier.weight(1f))
            val anyOpen = open.isNotEmpty()
            Plain(if (anyOpen) "Collapse All" else "Expand All", "first-run-folder-all", if (anyOpen) "chevrons-down-up" else "chevrons-up-down", enabled = shown == null) {
                open = if (anyOpen) emptySet() else children.keys.filter { it.isNotEmpty() }.toSet()
            }
        }
        Column(Modifier.selectableGroup().fillMaxWidth().testTag("first-run-folder-tree")) {
            if (shown == null && "" in free) FolderRow("", 0, "Root", "Top of the repository", chosen == "", null, false, null, null, onToggle = null) { chosen = "" }
            for ((path, depth) in rows) {
                val name = path.substringAfterLast('/')
                val notebook = notebooks[path]
                val kids = children[path].orEmpty().size
                FolderRow(
                    path,
                    depth,
                    name,
                    if (path in made) "New, made at the first sync" else null,
                    selected = chosen == path,
                    notebook = notebook,
                    alreadyAdded = notebook != null && notebook.id in added,
                    expanded = if (kids == 0) null else (shown != null || path in open),
                    highlight = query.takeIf { it.isNotEmpty() },
                    onOpen = if (notebook != null && notebook.id !in added && onOpen != null) ({ onOpen(placeIn(repo, token, path), notebook.name) }) else null,
                    onToggle = { if (shown == null) open = if (path in open) open - path else open + path },
                ) { if (notebook == null) chosen = path }
            }
            if (shown != null && rows.isEmpty()) {
                Lead(if (onlyNotebooks) "No notebooks here." else "No folder matches “$query”. Folders starting with a dot, and folders inside a notebook, aren’t listed.", Modifier.testTag("first-run-folder-none"), small = true)
            }
        }
        Lead("Notebook goes in ${folderWords(chosen)}", Modifier.testTag("first-run-folder-chosen"), small = true)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                newName,
                { newName = it; problem = null },
                Modifier.weight(1f).testTag("first-run-new-folder"),
                label = { Text("New Folder in ${folderWords(chosen)}") },
                singleLine = true,
            )
            Plain("Add", "first-run-new-folder-add", "folder-plus") {
                val words = folderNameProblem(newName)
                if (words != null) {
                    problem = words
                } else {
                    val path = if (chosen.isEmpty()) newName.trim() else "$chosen/${newName.trim()}"
                    if (path !in made) made += path
                    newName = ""
                    open = open + ancestors(path) + listOfNotNull(chosen.takeIf { it.isNotEmpty() })
                    chosen = path
                }
            }
        }
        problem?.let { Problem(it, "first-run-new-folder-problem") }
        if (folders.truncated) Lead("GitHub left some folders out of a large repository. Paste a URL with the folder for one not listed.", small = true)
    }
}

/**
 * One folder in Pick Folder's tree: guide lines for its levels, a chevron when it holds folders,
 * then a radio button, or a notebook's badge for a folder that holds one (not a place for another).
 */
@Composable
private fun FolderRow(
    path: String,
    depth: Int,
    name: String,
    line: String?,
    selected: Boolean,
    notebook: FolderNotebook?,
    alreadyAdded: Boolean,
    expanded: Boolean?,
    highlight: String?,
    onOpen: (() -> Unit)? = null,
    onToggle: (() -> Unit)?,
    onSelect: () -> Unit,
) {
    val colours = MaterialTheme.colorScheme
    val guide = colours.outlineVariant
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (notebook == null) Modifier.selectable(selected, role = Role.RadioButton, onClick = onSelect) else Modifier)
            .background(if (selected) colours.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent)
            .drawBehind {
                // A guide line down each level above this one.
                for (level in 0 until depth) {
                    val x = (20 + level * 24).dp.toPx()
                    drawLine(guide, androidx.compose.ui.geometry.Offset(x, 0f), androidx.compose.ui.geometry.Offset(x, size.height), strokeWidth = 1.dp.toPx())
                }
            }
            .padding(start = (depth * 24).dp, top = 2.dp, bottom = 2.dp)
            .testTag(if (notebook != null) "first-run-folder-notebook" else "first-run-folder-option")
            .semantics { if (expanded != null) stateDescription = if (expanded) "Expanded" else "Collapsed" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(40.dp).then(if (expanded != null && onToggle != null) Modifier.clickable(role = Role.Button, onClickLabel = if (expanded) "Collapse" else "Expand", onClick = onToggle).testTag("first-run-folder-toggle") else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            if (expanded != null) LucideGlyph(if (expanded) "chevron-down" else "chevron-right", if (expanded) "Collapse $name" else "Expand $name", 18.dp)
        }
        if (notebook == null) {
            RadioButton(selected, onClick = null)
        } else {
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.background(colours.primary).padding(4.dp)) { LucideGlyph("notebook", null, 16.dp) }
            }
        }
        Column(Modifier.weight(1f).padding(start = 8.dp)) {
            Text(highlighted(name, highlight, colours.tertiaryContainer), style = MaterialTheme.roles.rowLabel, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            when {
                notebook != null -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Chip("Notebook: ${notebook.name}", "first-run-folder-notebook-chip")
                    if (alreadyAdded) Chip("Already Added")
                }
                line != null -> Text(line, style = MaterialTheme.roles.meta, color = colours.onSurfaceVariant)
            }
        }
        if (onOpen != null) Plain("Open", "first-run-folder-open", "folder-open", onClick = onOpen)
    }
}

/** [name] with each match of [query] marked, as the filter finds it. */
private fun highlighted(name: String, query: String?, mark: androidx.compose.ui.graphics.Color) = androidx.compose.ui.text.buildAnnotatedString {
    if (query.isNullOrEmpty()) { append(name); return@buildAnnotatedString }
    var at = 0
    while (true) {
        val hit = name.indexOf(query, at, ignoreCase = true)
        if (hit < 0) { append(name.substring(at)); break }
        append(name.substring(at, hit))
        withStyle(androidx.compose.ui.text.SpanStyle(background = mark)) { append(name.substring(hit, hit + query.length)) }
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
        actions = { Primary("Make Notebook", "first-run-make", "plus", enabled = name.isNotBlank()) { onMake(name.trim()) } },
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
            .clickable(role = Role.Button, onClickLabel = "Change GitHub Account") { open = true }
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
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { open = false }, modifier = Modifier.testTag("first-run-account-sheet")) {
            Text(
                "GitHub Account",
                Modifier.padding(start = 22.dp, end = 22.dp, bottom = 8.dp),
                style = MaterialTheme.roles.help,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val sheetRow = @Composable { tag: String, selected: Boolean, onClick: () -> Unit, content: @Composable () -> Unit ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent)
                        .clickable(role = Role.Button) {
                            open = false
                            onClick()
                        }
                        .padding(horizontal = 22.dp, vertical = 12.dp)
                        .testTag(tag),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) { content() }
            }
            for (account in accounts) {
                val current = account.login == login
                sheetRow("first-run-switch-${account.login.orEmpty()}", current, { if (!current) onPick(account) }) {
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
                sheetRow("first-run-switch-add", false, add) {
                    LucideGlyph("user-plus", contentDescription = null)
                    Text("Add Another Account", style = MaterialTheme.roles.rowLabel)
                }
            }
            onManage?.let { manage ->
                sheetRow("first-run-switch-manage", false, manage) {
                    LucideGlyph("settings", contentDescription = null)
                    Text("Manage GitHub Accounts", style = MaterialTheme.roles.rowLabel)
                }
            }
            onRefresh?.let { refresh ->
                sheetRow("first-run-refresh", false, refresh) {
                    LucideGlyph("refresh-cw", contentDescription = null)
                    Text("Refresh Repositories", style = MaterialTheme.roles.rowLabel)
                }
            }
            androidx.compose.foundation.layout.Spacer(Modifier.padding(bottom = 16.dp))
        }
    }
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
