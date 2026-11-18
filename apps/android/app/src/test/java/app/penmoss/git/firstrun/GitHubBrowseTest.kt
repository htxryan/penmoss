package app.penmoss.git.firstrun

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** The first run's GitHub browsing (A1404, A1405), against a fake GitHub: what it asks and reads. */
class GitHubBrowseTest {
    private data class Asked(val method: String, val url: String, val headers: Map<String, String>, val body: String?)

    private class Fake(private val answer: (Asked) -> BrowseResponse) : BrowseHttp {
        val asked = mutableListOf<Asked>()
        override suspend fun call(method: String, url: String, headers: Map<String, String>, body: String?): BrowseResponse {
            val call = Asked(method, url, headers, body)
            asked += call
            return answer(call)
        }
    }

    private fun ok(body: String, headers: Map<String, String> = emptyMap()) = BrowseResponse(200, headers, body)

    private fun repo(name: String, size: Int = 10, push: Boolean = true, private: Boolean = true) =
        """{"full_name":"ryan/$name","name":"$name","owner":{"login":"ryan"},"private":$private,"default_branch":"main",
           "clone_url":"https://github.com/ryan/$name.git","pushed_at":"2026-11-15T00:00:00Z","size":$size,"permissions":{"push":$push}}"""

    @Test
    fun branchesFollowGitHubsPagesWithTheDefaultFirst() = runBlocking {
        val fake = Fake { call ->
            if ("page=2" in call.url) ok("""[{"name":"Zeta"},{"name":"main"}]""")
            else ok("""[{"name":"drafts"},{"name":"alpha"}]""", mapOf("link" to "<https://api.github.com/repos/ryan/notes/branches?per_page=100&page=2>; rel=\"next\""))
        }
        val answer = GitHubBrowse(fake).branches("tok", "ryan/notes", "main") as BrowseResult.Ok
        assertEquals(listOf("main", "alpha", "drafts", "Zeta"), answer.value)
        assertTrue(fake.asked.all { it.url.startsWith("https://api.github.com/repos/ryan/notes/branches") })
        // Not a repository name: GitHub is never asked.
        assertTrue(GitHubBrowse(Fake { error("asked") }).branches("tok", "not a repo", "main") is BrowseResult.Failed)
    }

    @Test
    fun reposFollowsGitHubsPagesWithTheTokenOnlyToTheApi() = runBlocking {
        val fake = Fake { call ->
            if ("page=2" in call.url) ok("[${repo("b", size = 0, push = false, private = false)}]")
            else ok("[${repo("a")}]", mapOf("link" to "<https://api.github.com/user/repos?page=2>; rel=\"next\""))
        }
        val answer = GitHubBrowse(fake).repos("tok") as BrowseResult.Ok
        assertEquals(listOf("ryan/a", "ryan/b"), answer.value.repos.map { it.fullName })
        assertFalse(answer.value.more)
        val b = answer.value.repos[1]
        assertTrue(b.empty)
        assertFalse(b.canPush)
        assertEquals(RepoVisibility.PUBLIC, b.visibility)
        assertTrue(fake.asked.all { it.headers["Authorization"] == "Bearer tok" && it.url.startsWith("https://api.github.com/") })
    }

    @Test
    fun aNextPageOnAnotherHostIsNeverAskedWithTheToken() = runBlocking {
        val fake = Fake { ok("[${repo("a")}]", mapOf("link" to "<https://evil.example/user/repos?page=2>; rel=\"next\"")) }
        val answer = GitHubBrowse(fake).repos("tok")
        assertTrue(answer is BrowseResult.Failed)
        assertEquals(1, fake.asked.size)
    }

    @Test
    fun refusalsSayWhy() = runBlocking {
        fun said(status: Int, body: String = "{}", headers: Map<String, String> = emptyMap()) =
            (runBlocking { GitHubBrowse(Fake { BrowseResponse(status, headers, body) }).repos("tok") } as BrowseResult.Failed).error.reason
        assertEquals(BrowseReason.UNAUTHORIZED, said(401))
        assertEquals(BrowseReason.RATE_LIMITED, said(403, headers = mapOf("x-ratelimit-remaining" to "0")))
        assertEquals(BrowseReason.FORBIDDEN, said(403, """{"message":"SSO"}"""))
        val offline = GitHubBrowse(BrowseHttp { _, _, _, _ -> throw java.io.IOException("no network") }).repos("tok") as BrowseResult.Failed
        assertEquals(BrowseReason.OFFLINE, offline.error.reason)
    }

    @Test
    fun foldersListTheNotebooksAndHideDotFoldersAndANotebooksOwn() = runBlocking {
        val json = Base64.getEncoder().encodeToString("""{"id":"01NB","name":"Work"}""".toByteArray())
        val fake = Fake { call ->
            when {
                "/git/trees/" in call.url -> ok(
                    """{"tree":[{"path":"docs","type":"tree"},{"path":"docs/work","type":"tree"},{"path":"docs/work/inside","type":"tree"},
                       {"path":"docs/work/.penmoss/notebook.json","type":"blob","sha":"abc"},{"path":".github","type":"tree"}],"truncated":false}""",
                )
                "/git/blobs/abc" in call.url -> ok("""{"content":"$json"}""")
                else -> BrowseResponse(404, emptyMap(), "{}")
            }
        }
        val folders = (GitHubBrowse(fake).folders("tok", "ryan/notes", "main") as BrowseResult.Ok).value
        assertFalse(folders.empty)
        assertEquals(listOf("", "docs", "docs/work"), folders.folders.map { it.path })
        assertEquals(FolderNotebook("01NB", "Work"), folders.folders.last().notebook)
        assertNull(folders.folders.first().notebook)
    }

    @Test
    fun anEmptyRepositoryIsItsRootAlone() = runBlocking {
        val folders = (GitHubBrowse(Fake { BrowseResponse(409, emptyMap(), """{"message":"Git Repository is empty."}""") }).folders("tok", "ryan/notes", "main") as BrowseResult.Ok).value
        assertTrue(folders.empty)
        assertEquals(listOf(RepoFolder("", null)), folders.folders)
    }

    @Test
    fun createRepoMakesAnEmptyPrivateOneAndSaysWhenTheNameIsTaken() = runBlocking {
        val fake = Fake { call ->
            if (call.url.endsWith("/orgs/acme/repos")) BrowseResponse(422, emptyMap(), """{"message":"Validation Failed","errors":[{"message":"name already exists on this account"}]}""")
            else BrowseResponse(201, emptyMap(), repo("field-notes", size = 0))
        }
        val made = (GitHubBrowse(fake).createRepo("tok", GitHubOwner("ryan", org = false), "field-notes") as BrowseResult.Ok).value
        assertEquals("https://github.com/ryan/field-notes.git", made.cloneUrl)
        assertTrue(made.canPush && made.empty)
        val asked = fake.asked.single()
        assertEquals("POST", asked.method)
        assertTrue(asked.url.endsWith("/user/repos"))
        assertTrue(asked.body!!.contains("\"private\":true"))
        val taken = GitHubBrowse(fake).createRepo("tok", GitHubOwner("acme", org = true), "field-notes") as BrowseResult.Failed
        assertEquals(BrowseReason.EXISTS, taken.error.reason)
        val bad = GitHubBrowse(fake).createRepo("tok", GitHubOwner("ryan", org = false), "no/slash") as BrowseResult.Failed
        assertEquals(BrowseReason.INVALID, bad.error.reason)
    }

    @Test
    fun theFlowsWords() {
        assertEquals("Field Notes", nameFromRepo("field-notes.git"))
        assertEquals("notes", repoNameOf("https://github.com/me/notes.git/"))
        assertEquals("work-log-notes", defaultRepoName("Work Log"))
        assertEquals("notes", defaultRepoName("  "))
        assertEquals("Root", folderWords(""))
        assertEquals("docs/notes/", folderWords("docs/notes"))
        assertEquals("One folder at a time: no slashes.", folderNameProblem("a/b"))
        assertEquals("Folders starting with a dot are hidden: choose another name.", folderNameProblem(".x"))
        assertNull(folderNameProblem("journal"))
        assertTrue(isGitHub("https://github.com/me/notes"))
        assertFalse(isGitHub("https://gitlab.com/me/notes"))
        assertFalse(GitHubBrowse.branchNameOk("a..b"))
        assertTrue(GitHubBrowse.branchNameOk("feature/notes"))
    }
}
