package app.penmoss.git.firstrun

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.GitEngineStatus
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.ui.common.PenmossTheme
import kotlinx.coroutines.flow.MutableStateFlow
import androidx.compose.ui.platform.testTag
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The first run on Android (A1404 on Android, A1406, A1562): one step per screen, from the welcome
 * to Setting Up, which holds until the first sync and ends on the notebook.
 */
@RunWith(AndroidJUnit4::class)
class FirstRunScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val localId = "01JBL0000000000000000000L1"

    private fun view(name: String) = GitNotebookView(
        localId = localId,
        notebookId = "01JBN0000000000000000000N1",
        name = name,
        create = true,
        remote = "https://github.com/ryan/notes.git",
        repository = "github.com/ryan/notes",
        host = "github.com",
        branch = "main",
        dir = "",
        pushDelayS = 60,
        pullEveryMin = 2,
        wifiOnly = false,
        hasToken = true,
    )

    private class Added(val place: Place, val name: String?)

    private val statuses = MutableStateFlow<Map<String, GitEngineStatus>>(emptyMap())
    private val adds = mutableListOf<Added>()
    private val holds = mutableListOf<Boolean>()
    private var done: String? = "none"

    private fun repoJson(name: String, size: Int) =
        """{"full_name":"ryan/$name","name":"$name","owner":{"login":"ryan"},"private":true,"default_branch":"main",
           "clone_url":"https://github.com/ryan/$name.git","size":$size,"permissions":{"push":true}}"""

    /** GitHub with one empty repository, `ryan/notes`. */
    private val github = GitHubBrowse(BrowseHttp { _, url, headers, _ ->
        when {
            url.contains("/user/repos") -> BrowseResponse(200, emptyMap(), "[${repoJson("notes", 0)}]")
            // The work token is the work account's.
            url.endsWith("/user") && headers.values.any { it.endsWith("tok-work") } -> BrowseResponse(200, emptyMap(), """{"login":"ryan-work"}""")
            url.endsWith("/user") -> BrowseResponse(200, emptyMap(), """{"login":"ryan"}""")
            url.contains("/user/orgs") -> BrowseResponse(200, emptyMap(), "[]")
            url.contains("/git/trees/") -> BrowseResponse(409, emptyMap(), "{}")
            else -> BrowseResponse(404, emptyMap(), "{}")
        }
    })

    private fun deps(
        token: String?,
        accounts: (() -> List<app.penmoss.feedback.GitHubAccount>)? = null,
        tokens: Map<String?, String> = emptyMap(),
        addToken: (suspend (String) -> app.penmoss.feedback.GitHubTokenModel.Saved)? = null,
        answer: (Place, String?) -> AddResult,
    ) = FirstRunDeps(
        browse = github,
        token = { token },
        login = { "ryan" },
        accounts = { accounts?.invoke() ?: if (token != null) listOf(app.penmoss.feedback.GitHubAccount("ryan", primary = true)) else emptyList() },
        tokenFor = { login -> tokens[login] ?: token },
        saveToken = { _, _ -> },
        signIn = null,
        add = { place, name ->
            adds += Added(place, name)
            answer(place, name)
        },
        added = { emptySet() },
        statuses = statuses,
        syncNow = {},
        openUrl = {},
        copy = {},
        accountsPage = { back ->
            pages++
            androidx.compose.material3.TextButton(onClick = back, modifier = androidx.compose.ui.Modifier.testTag("fake-accounts-back")) {
                androidx.compose.material3.Text("Settings → GitHub")
            }
        },
        addToken = addToken,
        feedbackRepo = "htxryan/penmoss",
    )
    private var pages = 0

    private fun show(deps: FirstRunDeps, firstRun: Boolean = true) {
        compose.setContent {
            PenmossTheme {
                NotebookSteps(deps, firstRun, onDone = { done = it }, onHold = { holds += it }, onCancel = if (firstRun) null else ({ done = "cancelled" }))
            }
        }
    }

    private fun tap(tag: String) {
        val node = compose.onNodeWithTag(tag)
        // The footer's buttons are outside the screen's scroll; the rest scroll into view first.
        runCatching { node.performScrollTo() }
        node.performClick()
        compose.waitForIdle()
    }

    private fun waitFor(tag: String) = compose.waitUntil(5_000) {
        compose.onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitForText(text: String) = compose.waitUntil(5_000) {
        compose.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty()
    }

    @Test
    fun aNewNotebookInAnEmptyRepositoryGoesStepByStepAndHoldsUntilTheFirstSync() {
        show(deps("tok") { _, name -> if (name == null) AddResult.NeedsName else AddResult.Added(view(name), created = true) })
        compose.onNodeWithText("Welcome to Penmoss").assertExists()
        tap("first-run-start")
        compose.onNodeWithText("Step 1 of 3").assertExists()
        tap("first-run-continue") // Start a New Notebook
        compose.onNodeWithText("Pick Repository").assertExists()
        tap("first-run-way-existing")
        tap("first-run-continue")
        // The phone's GitHub sign-in answers, so GitHub Access goes straight on to the list.
        waitFor("first-run-repo-ryan/notes")
        compose.onNodeWithTag("first-run-via", useUnmergedTree = true).assertTextEquals("ryan")
        compose.onNodeWithText("1 repository.").assertExists()
        tap("first-run-repo-ryan/notes")
        waitFor("first-run-repo-empty")
        compose.onNodeWithText("Empty Repository").assertExists()
        tap("first-run-continue")
        compose.onNodeWithText("Step 3 of 3").assertExists()
        compose.onNodeWithTag("first-run-name-input").performTextClearance()
        compose.onNodeWithTag("first-run-name-input").performTextInput("Field Notes")
        tap("first-run-make")
        waitFor("first-run-setup")
        compose.waitUntil(5_000) { adds.isNotEmpty() }
        val add = adds.single()
        assertEquals("https://github.com/ryan/notes.git", add.place.remote)
        assertEquals("tok", add.place.token)
        assertEquals("Field Notes", add.name)
        assertEquals(listOf(true), holds)
        // Setting Up waits for the first sync, then ends on the notebook.
        assertEquals("none", done)
        waitForText("First sync…")
        statuses.value = mapOf(localId to GitEngineStatus(phase = "synced", lastSyncAt = 1L))
        compose.waitUntil(5_000) { done != "none" }
        assertEquals(localId, done)
        assertEquals(listOf(true, false), holds)
    }

    @Test
    fun withNoGitHubSignInPasteAUrlAsksTheRepositoryAndForATokenThenANameWhenItHoldsNone() {
        show(deps(null) { _, name -> if (name == null) AddResult.NeedsName else AddResult.Added(view(name), created = true) })
        tap("first-run-start")
        tap("first-run-continue")
        tap("first-run-way-create")
        tap("first-run-continue")
        // No sign-in on the phone, and this build can't sign in: Paste a URL goes on without GitHub.
        waitFor("first-run-url-instead")
        compose.onNodeWithText("Sign In to GitHub").assertExists()
        tap("first-run-url-instead")
        compose.onNodeWithTag("first-run-continue").assertIsNotEnabled()
        compose.onNodeWithTag("first-run-url-input").performTextInput("https://github.com/ryan/field-notes")
        compose.onNodeWithTag("first-run-url-token").performTextInput("ghp_typed")
        tap("first-run-continue")
        waitFor("first-run-name")
        compose.onNodeWithTag("first-run-name-input").assert(hasText("Field Notes"))
        // Asked without a name first, which held the first run and let it go.
        assertNull(adds.single().name)
        assertEquals("ghp_typed", adds.single().place.token)
        assertEquals(listOf(true, false), holds)
        tap("first-run-make")
        compose.waitUntil(5_000) { adds.size == 2 }
        assertEquals("Field Notes", adds[1].name)
        // A failed first sync offers Open Anyway; the notebook is on the phone already.
        statuses.value = mapOf(localId to GitEngineStatus(phase = "stopped", detail = "GitHub refused the token."))
        waitFor("first-run-open-anyway")
        compose.onNodeWithText("Couldn’t Finish Setting Up").assertExists()
        tap("first-run-open-anyway")
        assertEquals(localId, done)
    }

    /** Two GitHub accounts (A1618): Add Notebook never asks which; the first account's repositories, with the switcher to change. */
    @Test
    fun withTwoAccountsAddNotebookListsTheFirstAndTheSwitcherChangesIt() {
        val accounts = listOf(app.penmoss.feedback.GitHubAccount("ryan", primary = true), app.penmoss.feedback.GitHubAccount("ryan-work", primary = false))
        show(deps("tok", { accounts }, mapOf("ryan" to "tok", "ryan-work" to "tok-work")) { _, name -> if (name == null) AddResult.NeedsName else AddResult.Added(view(name), created = true) }, firstRun = false)
        tap("first-run-continue") // Start a New Notebook
        tap("first-run-way-existing")
        tap("first-run-continue")
        // Straight to the first account's repositories: no Pick GitHub Account (Ryan, 18 Nov 2026).
        waitFor("first-run-repo-ryan/notes")
        compose.onNodeWithText("Pick GitHub Account").assertDoesNotExist()
        compose.onNodeWithTag("first-run-via", useUnmergedTree = true).assertTextEquals("ryan")
        // The switcher above the list (option 2): a sheet of every account; the work one's repositories.
        tap("first-run-account-switcher")
        waitFor("first-run-switch-ryan-work")
        tap("first-run-switch-ryan-work")
        waitFor("first-run-repo-ryan/notes")
        compose.onNodeWithTag("first-run-via", useUnmergedTree = true).assertTextEquals("ryan-work")
        // Add Another Account: the sign-in, with its hint; Back, the work account's list again.
        tap("first-run-account-switcher")
        waitFor("first-run-switch-add")
        tap("first-run-switch-add")
        waitFor("first-run-add-account-hint")
        compose.onNodeWithText("Add GitHub Account").assertExists()
        tap("first-run-back")
        waitFor("first-run-repo-ryan/notes")
        compose.onNodeWithTag("first-run-via", useUnmergedTree = true).assertTextEquals("ryan-work")
        // Manage GitHub Accounts opens Settings → GitHub's page; back from it, the same account's list.
        tap("first-run-account-switcher")
        waitFor("first-run-switch-manage")
        tap("first-run-switch-manage")
        waitFor("fake-accounts-back")
        tap("fake-accounts-back")
        waitFor("first-run-repo-ryan/notes")
        compose.onNodeWithTag("first-run-via", useUnmergedTree = true).assertTextEquals("ryan-work")
        tap("first-run-repo-ryan/notes")
        waitFor("first-run-repo-empty")
        tap("first-run-continue")
        compose.onNodeWithTag("first-run-name-input").performTextInput("Work")
        tap("first-run-make")
        compose.waitUntil(5_000) { adds.isNotEmpty() }
        assertEquals("tok-work", adds.last().place.token)
    }

    /** With one account, the switcher is above the list; an account added in Manage GitHub Accounts is in it after, not asked for. */
    @Test
    fun manageGitHubAccountsAddsOneToTheSwitcherWithoutAsking() {
        var accounts = listOf(app.penmoss.feedback.GitHubAccount("ryan", primary = true))
        show(deps("tok", { accounts }, mapOf("ryan" to "tok", "ryan-work" to "tok-work")) { _, _ -> AddResult.NeedsName }, firstRun = false)
        tap("first-run-continue")
        tap("first-run-way-existing")
        tap("first-run-continue")
        // One account: straight to its repositories, with the switcher above them.
        waitFor("first-run-repo-ryan/notes")
        compose.onNodeWithText("Listing this account’s repositories").assertExists()
        // Add Another Account stays on the sign-in, even with one account; Back, the list again.
        tap("first-run-account-switcher")
        waitFor("first-run-switch-add")
        tap("first-run-switch-add")
        waitFor("first-run-add-account-hint")
        compose.waitForIdle()
        compose.onNodeWithTag("first-run-add-account-hint").assertExists()
        tap("first-run-back")
        waitFor("first-run-repo-ryan/notes")
        tap("first-run-account-switcher")
        waitFor("first-run-switch-manage")
        tap("first-run-switch-manage")
        waitFor("fake-accounts-back")
        assertTrue(pages > 0)
        // The work account is added on that page; back, the same list, and the switcher has it.
        accounts = accounts + app.penmoss.feedback.GitHubAccount("ryan-work", primary = false)
        tap("fake-accounts-back")
        waitFor("first-run-repo-ryan/notes")
        compose.onNodeWithText("Pick GitHub Account").assertDoesNotExist()
        tap("first-run-account-switcher")
        waitFor("first-run-switch-ryan-work")
    }

    /** Add with a Token is Settings → GitHub's token page (one page, not two; Ryan, 18 Nov 2026), and lists the account it adds. */
    @Test
    fun addWithATokenIsSettingsTokenPageAndListsTheAccountItAdds() {
        var accounts = listOf(app.penmoss.feedback.GitHubAccount("ryan", primary = true))
        val saved = mutableListOf<String>()
        val addToken: suspend (String) -> app.penmoss.feedback.GitHubTokenModel.Saved = { typed ->
            saved += typed
            accounts = accounts + app.penmoss.feedback.GitHubAccount("ryan-work", primary = false)
            app.penmoss.feedback.GitHubTokenModel.Saved(true, "Added @ryan-work.", "ryan-work")
        }
        show(deps("tok", { accounts }, mapOf("ryan" to "tok", "ryan-work" to "tok-work"), addToken) { _, _ -> AddResult.NeedsName }, firstRun = false)
        tap("first-run-continue")
        tap("first-run-way-existing")
        tap("first-run-continue")
        waitFor("first-run-repo-ryan/notes")
        tap("first-run-account-switcher")
        waitFor("first-run-switch-add")
        tap("first-run-switch-add")
        waitFor("first-run-use-token")
        compose.onNodeWithText("Add with a Token").assertExists()
        tap("first-run-use-token")
        waitFor("githubTokenField")
        compose.onNodeWithText("Add Account with a Token").assertExists()
        compose.onNodeWithTag("githubTokenLead").assert(hasText("beside @ryan;", substring = true))
        compose.onNodeWithTag("githubTokenField").performTextInput("tok-work")
        tap("githubTokenSave")
        waitFor("first-run-repo-ryan/notes")
        compose.onNodeWithTag("first-run-via", useUnmergedTree = true).assertTextEquals("ryan-work")
        assertEquals(listOf("tok-work"), saved)
    }

    /** The token page says why a token was refused, and keeps it to fix. */
    @Test
    fun theTokenPageSaysWhyATokenWasRefused() {
        compose.setContent {
            PenmossTheme(dark = true) {
                app.penmoss.feedback.GitHubTokenForm({ emptyList() }, "htxryan/penmoss", { app.penmoss.feedback.GitHubTokenModel.Saved(false, "GitHub refused the token. It was not saved.") })
            }
        }
        compose.onNodeWithTag("githubTokenScopes").assert(hasText("Send Feedback files issues in htxryan/penmoss", substring = true))
        compose.onNodeWithTag("githubTokenField").performTextInput("ghp_bad")
        tap("githubTokenSave")
        waitFor("githubTokenMessage")
        compose.onNodeWithTag("githubTokenMessage").assertTextEquals("GitHub refused the token. It was not saved.")
        compose.onNodeWithTag("githubTokenSave").assertIsEnabled()
    }

    @Test
    fun addNotebookStartsAtCreateOrOpenWithCancel() {
        show(deps("tok") { _, _ -> AddResult.NeedsName }, firstRun = false)
        compose.onNodeWithText("Create or Open Notebook").assertExists()
        compose.onNodeWithText("A new, empty notebook").assertExists()
        compose.onNodeWithTag("first-run-back").assertDoesNotExist()
        tap("first-run-cancel")
        assertEquals("cancelled", done)
    }

    /** On a dark theme the words are light (Ryan, on his phone): the frame gives its text the colour on its background. */
    @Test
    fun theFramesWordsTakeTheColourOnItsBackgroundInDark() {
        var words: androidx.compose.ui.graphics.Color? = null
        var on: androidx.compose.ui.graphics.Color? = null
        compose.setContent {
            PenmossTheme(dark = true) {
                on = androidx.compose.material3.MaterialTheme.colorScheme.onBackground
                Frame("test", "Create or Open Notebook") {
                    words = androidx.compose.material3.LocalContentColor.current
                }
            }
        }
        compose.waitForIdle()
        assertEquals(on, words)
    }
}
