package app.penmoss.git.firstrun

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.semantics.stateDescription
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.rememberLucideIcons
import androidx.compose.material3.Icon
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.typedLength
import app.penmoss.ui.common.roles

/* The first run, after a repository: Pick Branch and Pick Folder; split from FirstRunRepos.kt (PEN-186). */

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
