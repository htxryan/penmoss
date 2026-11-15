package app.penmoss.engine.git

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * What a git notebook's page and remote are never trusted with (T50 G7, A841, A855, A877): an owner
 * check the app did not start, a request off the notebook's own origin, a public repository, a
 * remote Android does not sync with.
 */
class GitTrustTest {
    @get:Rule
    val temp = TemporaryFolder()

    init {
        GitTestRepos.ready()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val asked = mutableListOf<String>()

    @After
    fun stop() = scope.cancel()

    private val seal = object : SecretSeal {
        override fun seal(plain: String) = "sealed:" + plain.reversed()

        override fun unseal(sealed: String) = sealed.removePrefix("sealed:").reversed()
    }

    private val noGuard = object : GitGuard {
        override suspend fun commitPurges(localId: String, root: String, head: String?, changes: Map<String, ByteArray?>) = CommitPurges(emptyList(), emptyList(), emptyList(), emptyList())

        override suspend fun purgedAt(localId: String, root: String, head: String?) = emptySet<String>()

        override suspend fun titles(localId: String, root: String, head: String?, ids: List<String>) = ids.associateWith { "Plan" }
    }

    private var clock = 1_761_750_000_000L

    private fun notebooks(dir: java.io.File = temp.newFolder()) = GitNotebooks(
        dir,
        seal,
        OwnerConfirm { words ->
            asked += words
            OwnerAnswer.Confirmed
        },
        noGuard,
        identity = { GitIdentity("Ryan", "ryan@example.invalid") },
        now = { clock },
    )

    /** A page as a test plays it: frames it sends, the app's answers. */
    private class LoopPort : FramePort {
        lateinit var app: (ByteArray) -> Unit
        val answers = LinkedBlockingQueue<GitFrame>()

        override fun send(frame: ByteArray) {
            answers += GitFrame.decode(frame)
        }

        override fun listen(listener: (ByteArray) -> Unit) {
            app = listener
        }

        fun call(id: Int, op: String, args: JsonObject): GitFrame {
            app(FrameBuilder().encode(JsonObject(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(id), "op" to JsonPrimitive(op), "a" to args))))
            return answers.poll(10, TimeUnit.SECONDS) ?: error("no answer to $op")
        }
    }

    /** The page hands the app a copy withheld from the push (A886), its doc as bytes. */
    private fun withhold(port: LoopPort, id: Int): GitFrame {
        val builder = FrameBuilder()
        val copy = JsonObject(
            mapOf(
                "noteId" to JsonPrimitive("01JBN0000000000000000000C1"),
                "origin" to JsonPrimitive("01JBN0000000000000000000P1"),
                "title" to JsonPrimitive("Passwords (recovered)"),
                "folderId" to kotlinx.serialization.json.JsonNull,
                "update" to builder.blob(byteArrayOf(1, 2, 3)),
            ),
        )
        val args = JsonObject(mapOf("copies" to kotlinx.serialization.json.JsonArray(listOf(copy))))
        port.app(builder.encode(JsonObject(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(id), "op" to JsonPrimitive("copy.withhold"), "a" to args))))
        return port.answers.poll(10, TimeUnit.SECONDS) ?: error("no answer")
    }

    @Test
    fun aCopyWithheldFromThePushIsKeptAsideBeforeItLeavesTheNotebookOrTheSyncStops() = runBlocking {
        val notebooks = notebooks()
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val added = notebooks.add(GitTestRepos.url(remote), null, null, "Work") as AddResult.Added
        val localId = added.notebook.localId
        // Nowhere to keep it: refused, so the page's sync stops with nothing changed or pushed.
        val bare = LoopPort()
        GitEngine(localId, bare, notebooks, scope, OwnerAsks())
        assertEquals("not_kept", withhold(bare, 1).header["e"]!!.jsonObject["code"]!!.jsonPrimitive.content)
        val kept = mutableListOf<WithheldCopy>()
        val room = object : WithheldCopies {
            override suspend fun withhold(copies: List<WithheldCopy>) {
                kept += copies
            }

            override suspend fun withheld() = kept.toList()

            override suspend fun drop(noteId: String) {
                kept.removeAll { it.noteId == noteId }
            }
        }
        val port = LoopPort()
        GitEngine(localId, port, notebooks, scope, OwnerAsks(), withheld = room)
        assertEquals("ok", withhold(port, 2).header["k"]!!.jsonPrimitive.content)
        val base64 = java.util.Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3))
        assertEquals(listOf(WithheldCopy("01JBN0000000000000000000C1", "01JBN0000000000000000000P1", "Passwords (recovered)", null, listOf(base64))), kept)
    }

    @Test
    fun aPageAsksForAnOwnerCheckOnlyWhileTheAppSOwnRequestForItRuns() = runBlocking {
        val notebooks = notebooks()
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val added = notebooks.add(GitTestRepos.url(remote), null, null, "Work") as AddResult.Added
        asked.clear()
        val port = LoopPort()
        val asks = OwnerAsks()
        GitEngine(added.notebook.localId, port, notebooks, scope, asks)
        val note = "01JBN0000000000000000000P1"
        val args = JsonObject(mapOf("noteId" to JsonPrimitive(note)))
        // On its own: refused, and nobody is asked.
        val refused = port.call(1, "owner.purge", args).header
        assertEquals("err", refused["k"]!!.jsonPrimitive.content)
        assertEquals("not_asked", refused["e"]!!.jsonObject["code"]!!.jsonPrimitive.content)
        assertTrue(asked.isEmpty())
        val restore = port.call(2, "owner.restore", JsonObject(mapOf("noteId" to JsonPrimitive(note), "version" to JsonPrimitive(3)))).header
        assertEquals("not_asked", restore["e"]!!.jsonObject["code"]!!.jsonPrimitive.content)
        assertTrue(asked.isEmpty())
        // While the app's Delete for good of that note runs: asked, in the app's words.
        asks.begin(OwnerAsks.purge(note))
        val confirmed = port.call(3, "owner.purge", args).header
        asks.end(OwnerAsks.purge(note))
        assertEquals("ok", confirmed["k"]!!.jsonPrimitive.content)
        assertTrue(asked.single(), asked.single().endsWith(": [⁨Plan⁩]"))
        // Over again: refused.
        assertEquals("not_asked", port.call(4, "owner.purge", args).header["e"]!!.jsonObject["code"]!!.jsonPrimitive.content)
        // A git call the app does not make for pages is refused too.
        assertEquals("err", port.call(5, "git.remove", JsonObject(emptyMap())).header["k"]!!.jsonPrimitive.content)
    }

    @Test
    fun aNotebookSApiNeverLeavesItsOwnOrigin() {
        val api = OkHttpClient.Builder().addInterceptor { error("reached the network") }.build()
        val client = LocalGitApi.api("01JBL0000000000000000000L1", api, OwnerAsks()) { error("no page") }
        assertEquals("https://git.invalid/01JBL0000000000000000000L1/", LocalGitApi.origin("01JBL0000000000000000000L1").toString())
        // The client inside the API is private; the interceptor is checked through a request of its own kind.
        val field = client.javaClass.getDeclaredField("client").apply { isAccessible = true }
        val http = field.get(client) as OkHttpClient
        for (url in listOf("https://penmoss.app/api/notes", "https://git.invalid/01JBL0000000000000000000L2/sync/tree", "http://git.invalid/01JBL0000000000000000000L1/sync/tree")) {
            try {
                http.newCall(Request.Builder().url(url).build()).execute().close()
                fail("reached $url")
            } catch (expected: IOException) {
                assertTrue(expected.message, expected.message!!.contains("answers only on"))
            }
        }
    }

    @Test
    fun sshPlainHttpAndCredentialsInTheUrlAreRefusedBeforeAnythingIsFetched() = runBlocking {
        val notebooks = notebooks()
        val cases = listOf(
            "git@github.com:htxryan/notes.git" to "ssh_unsupported",
            "ssh://git@github.com/htxryan/notes.git" to "ssh_unsupported",
            "http://git.example.com/notes.git" to "insecure_remote",
            "https://ghp_x@github.com/htxryan/notes" to "remote_credentials",
            "ftp://example.com/notes" to "invalid_remote",
        )
        for ((remote, code) in cases) {
            try {
                notebooks.add(remote, null, null, "Work")
                fail("added $remote")
            } catch (error: GitRefusal) {
                assertEquals(remote, code, error.code)
            }
            assertTrue(notebooks.list().isEmpty())
        }
        assertTrue("nobody was asked to confirm", asked.isEmpty())
    }

    @Test
    fun anyRepositorySyncsWithNobodyAsked() = runBlocking {
        val notebooks = notebooks()
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        // D51, D61: added and synced, and nobody is asked anything.
        val added = notebooks.add(GitTestRepos.url(remote), null, null, "Work") as AddResult.Added
        val port = LoopPort()
        GitEngine(added.notebook.localId, port, notebooks, scope)
        assertEquals("ok", port.call(1, "git.fetch", JsonObject(emptyMap())).header["k"]!!.jsonPrimitive.content)
        // A day later it still syncs: nothing is checked again.
        clock += 25 * 60 * 60_000L
        assertEquals("ok", port.call(2, "git.fetch", JsonObject(emptyMap())).header["k"]!!.jsonPrimitive.content)
        assertTrue("nobody was asked to confirm", asked.isEmpty())
    }

    @Test
    fun aRegistryWithAnOldConfirmationStillLoadsAndTheNextWriteDropsIt() = runBlocking {
        val dir = temp.newFolder()
        val localId = "01JBN00000000000000000000A"
        // Written before D51: a sealed confirmation that the repository is private.
        java.io.File(dir, "git-notebooks.json").writeText(
            """{"version":2,"notebooks":[{"localId":"$localId","notebookId":"01JBN00000000000000000000B","name":"Work","remote":"https://git.example.com/me/notes.git","confirmed":"sealed:old-confirmation"}]}""",
        )
        val notebooks = notebooks(dir)
        val view = notebooks.list().single()
        assertEquals(localId, view.localId)
        notebooks.update(localId, wifiOnly = true)
        val written = java.io.File(dir, "git-notebooks.json").readText()
        assertTrue(written, !written.contains("confirmed") && !written.contains("old-confirmation"))
        assertTrue(notebooks.list().single().wifiOnly)
    }
}
