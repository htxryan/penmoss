package app.penmoss.git.firstrun

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    private val github = GitHubBrowse(BrowseHttp { _, url, _, _ ->
        when {
            url.contains("/user/repos") -> BrowseResponse(200, emptyMap(), "[${repoJson("notes", 0)}]")
            url.endsWith("/user") -> BrowseResponse(200, emptyMap(), """{"login":"ryan"}""")
            url.contains("/user/orgs") -> BrowseResponse(200, emptyMap(), "[]")
            url.contains("/git/trees/") -> BrowseResponse(409, emptyMap(), "{}")
            else -> BrowseResponse(404, emptyMap(), "{}")
        }
    })

    private fun deps(token: String?, answer: (Place, String?) -> AddResult) = FirstRunDeps(
        browse = github,
        token = { token },
        login = { "ryan" },
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
    )

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
        compose.onNodeWithText("Signed in as ryan").assertExists()
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
