package app.penmoss.git.firstrun

/**
 * The first run's flow on Android (A1404's "One Step per Screen", which Android now has too): what
 * each screen is, where a new notebook goes, and the words the screens share. The Mac's is
 * `apps/web/src/sources/first-run-flow.ts`; the screens are FirstRunScreens.kt beside this.
 */

/** Start a new notebook, or open one that exists. */
enum class Goal { NEW, EXISTING }

/** Pick Repository's three ways. */
enum class Way { CREATE, EXISTING, URL }

/**
 * Where a notebook is added: a repository, its branch and folder ("" for the root), and the token
 * its git uses on this phone (Android syncs over HTTPS with a token only).
 */
data class Place(
    val remote: String,
    val branch: String,
    val dir: String,
    /** `owner/name` for a GitHub repository, or the address as typed. */
    val label: String,
    val token: String?,
    /** The name a new notebook here is offered: the repository's, in words. */
    val suggested: String,
)

/** What the last screen does. */
sealed interface Setup {
    val place: Place
    val name: String

    /** A repository Create New Repo just made: make the notebook at its root. */
    data class Create(override val place: Place, override val name: String) : Setup

    /** A new notebook in a repository or folder that holds none. */
    data class Make(override val place: Place, override val name: String) : Setup

    /** A notebook the repository holds already. */
    data class Open(override val place: Place, override val name: String) : Setup

    /** Paste a URL added it already (the address held a notebook): only the first sync is left. */
    data class Added(override val place: Place, override val name: String, val localId: String) : Setup
}

/** Which screen comes after GitHub Access. */
enum class AfterGitHub { CREATE, LIST }

sealed interface Screen {
    data object Welcome : Screen
    data object Goal : Screen
    data object Way : Screen
    /** GitHub Access: never asks which account; the switcher changes it (A1618). */
    data class GitHub(
        val then: AfterGitHub,
        /** An account picked in the switcher (option 2, A1618): read it without asking. */
        val account: app.penmoss.feedback.GitHubAccount? = null,
        /** Add Another Account from the switcher: straight to the sign-in. */
        val add: Boolean = false,
    ) : Screen
    /** Settings → GitHub's accounts, opened from the repositories or Create New Repo; then [then]. */
    data class Accounts(val then: AfterGitHub) : Screen
    data object Create : Screen
    data object List : Screen
    data class Repo(val repo: GitHubRepo) : Screen
    data class Folder(val repo: GitHubRepo) : Screen
    data object Url : Screen
    data class Name(val place: Place) : Screen
    data class SetUp(val setup: Setup) : Screen
}

/** GitHub as the flow knows it once a sign-in answered. */
data class Hub(
    val list: RepoList,
    /** Whose sign-in it is, when known. */
    val login: String?,
    /** Where Create New Repo can make one; null when GitHub would not say. */
    val owners: List<GitHubOwner>?,
    /** The sign-in's token: GitHub's API reads with it, and the notebook's git pushes with it. */
    val token: String,
)

/** One repository's folders, as the list and its screens read them. */
sealed interface RepoRead {
    data object Loading : RepoRead
    data class Ready(val folders: RepoFolders) : RepoRead
    data class Failed(val message: String) : RepoRead
}

/** Asks GitHub for the repositories and owners with [token]. */
suspend fun readHub(github: GitHubBrowse, token: String, login: String?): Pair<Hub?, BrowseError?> {
    val answer = github.repos(token)
    if (answer is BrowseResult.Failed) return null to answer.error
    val owners = (github.owners(token) as? BrowseResult.Ok)?.value
    val who = owners?.firstOrNull { !it.org }?.login ?: login
    return Hub((answer as BrowseResult.Ok).value, who, owners, token) to null
}

/** `field-notes` → `Field Notes`: a repository's name as a notebook's. */
fun nameFromRepo(name: String): String = name
    .removeSuffix(".git")
    .split(Regex("[-_.\\s]+"))
    .filter { it.isNotEmpty() }
    .joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
    .take(80)

/** The repository name at the end of an address (`https://github.com/me/notes.git` → `notes`). */
fun repoNameOf(address: String): String = address.trim().trimEnd('/').split('/', ':').last().removeSuffix(".git")

/**
 * A new repository's name from the notebook's (D62): kebab case plus `-notes` ("Work Log" gives
 * `work-log-notes`); no name yet gives `notes`.
 */
fun defaultRepoName(notebookName: String): String {
    val kebab = notebookName.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
    return if (kebab.isEmpty()) "notes" else "$kebab-notes".take(100)
}

/** A GitHub repository picked from the list, at a folder. */
fun placeIn(repo: GitHubRepo, token: String, dir: String = "", branch: String? = null) = Place(
    remote = repo.cloneUrl,
    branch = branch ?: repo.defaultBranch.ifEmpty { "main" },
    dir = dir,
    label = repo.fullName,
    token = token,
    suggested = nameFromRepo(if (dir.isNotEmpty()) dir.substringAfterLast('/') else repo.name),
)

/** Where a folder is, as the cards and rows show it: Root, or `docs/notes/`. */
fun folderWords(dir: String) = if (dir.isEmpty()) "Root" else "$dir/"

/** Why a new folder's name won't do, or null when it will. */
fun folderNameProblem(name: String): String? {
    val trimmed = name.trim()
    return when {
        trimmed.isEmpty() -> "Name the folder."
        '/' in trimmed || '\\' in trimmed -> "One folder at a time: no slashes."
        trimmed == "." || trimmed == ".." || trimmed == ".git" -> "That name is not a folder git takes."
        trimmed.startsWith('.') -> "Folders starting with a dot are hidden: choose another name."
        trimmed.any { it.code < 0x20 || it.code == 0x7f } || trimmed.length > 100 -> "That name is not a folder git takes."
        else -> null
    }
}

/** The folders of [folders] that hold a notebook. */
fun notebooksIn(folders: RepoFolders) = folders.folders.filter { it.notebook != null }

/** The repository the address names on github.com, or null for any other host. */
fun isGitHub(address: String) = Regex("^https://(www\\.)?github\\.com/", RegexOption.IGNORE_CASE).containsMatchIn(address.trim())

/** The user docs page for the first run (the welcome's Learn More). */
const val FIRST_RUN_DOCS = "https://penmoss.app/docs/first-notebook/"

/** How long the first sync runs before Open Now is offered (a large notebook takes a while). */
const val SLOW_MS = 15_000L

/** How many repositories at the top of the list are read for their notebooks at once (A1405). */
const val READ_AT_ONCE = 8
