package app.penmoss.engine.git

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Delete for good while the person takes their time (T50 G7, A877, A887; PR #167 review): the
 * request's own time does not run while BiometricPrompt is up, so a slow confirmation still
 * deletes and the app says so; a request that runs out first is withdrawn, so a confirmation
 * after it does nothing, and the app says nothing was done. What the app reports is what happens.
 */
class GitAskTimeTest {
    @get:Rule
    val temp = TemporaryFolder()

    init {
        GitTestRepos.ready()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After
    fun stop() = scope.cancel()

    private val seal = object : SecretSeal {
        override fun seal(plain: String) = "sealed:" + plain.reversed()

        override fun unseal(sealed: String) = sealed.removePrefix("sealed:").reversed()
    }

    private val guard = object : GitGuard {
        override suspend fun commitPurges(localId: String, root: String, head: String?, changes: Map<String, ByteArray?>) =
            CommitPurges(emptyList(), emptyList(), emptyList(), emptyList(), raced, undoneMarks = marks)

        override suspend fun purgedAt(localId: String, root: String, head: String?) = emptySet<String>()

        override suspend fun titles(localId: String, root: String, head: String?, ids: List<String>): Map<String, String> {
            delay(titlesMs)
            return ids.associateWith { "Plan" }
        }
    }

    /** Copies the commit check finds a commit adds although their original is deleted for good (A886). */
    @Volatile
    private var raced = emptyList<String>()

    /** Undo marks (`agentUndone`) the commit check finds a commit adds or changes (#174 delta review). */
    @Volatile
    private var marks = emptyList<String>()

    /** How long the branch takes to name the note (before the prompt). */
    @Volatile
    private var titlesMs = 0L

    /** How long the person takes to confirm. */
    @Volatile
    private var promptMs = 0L
    private val asked = CopyOnWriteArrayList<String>()

    private fun notebooks() = GitNotebooks(
        temp.newFolder(),
        seal,
        OwnerConfirm { words ->
            asked += words
            delay(promptMs)
            OwnerAnswer.Confirmed
        },
        guard,
        identity = { GitIdentity("Ryan", "ryan@example.invalid") },
    )

    /**
     * The engine page's side of a Delete for good, as `server.ts` does it: the owner check first
     * (the app's `owner.purge`), then the mark, and 204; a refused check is the request's error.
     */
    private class PurgingPage : FramePort {
        private lateinit var app: (ByteArray) -> Unit
        private val fromApp = LinkedBlockingQueue<GitFrame>()
        val marked = CopyOnWriteArrayList<String>()

        override fun send(frame: ByteArray) {
            fromApp += GitFrame.decode(frame)
        }

        override fun listen(listener: (ByteArray) -> Unit) {
            app = listener
            thread(isDaemon = true, name = "purging-page") { run() }
        }

        private fun frame(header: Map<String, kotlinx.serialization.json.JsonElement>) = FrameBuilder().encode(JsonObject(header))

        private fun run() {
            val answers = LinkedBlockingQueue<GitFrame>()
            while (true) {
                val call = fromApp.poll(30, TimeUnit.SECONDS) ?: return
                val header = call.header
                if (header["k"]!!.jsonPrimitive.content != "call") {
                    answers += call
                    continue
                }
                val id = header["id"]!!.jsonPrimitive.longOrNull!!
                val path = header["a"]!!.jsonObject["path"]!!.jsonPrimitive.content
                val noteId = path.removePrefix("/api/notes/")
                thread(isDaemon = true) {
                    app(frame(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(id + 1000), "op" to JsonPrimitive("owner.purge"), "a" to JsonObject(mapOf("noteId" to JsonPrimitive(noteId))))))
                    val owner = answers.poll(30, TimeUnit.SECONDS) ?: return@thread
                    val ok = owner.header["k"]!!.jsonPrimitive.content == "ok"
                    if (ok) marked += noteId
                    val status = if (ok) 204 else 403
                    app(frame(mapOf("k" to JsonPrimitive("ok"), "id" to JsonPrimitive(id), "v" to JsonObject(mapOf("status" to JsonPrimitive(status), "headers" to JsonObject(emptyMap()), "body" to JsonNull)))))
                }
            }
        }
    }

    private suspend fun setUp(limits: LocalGitApi.Limits): Triple<GitNotebooks, PurgingPage, app.penmoss.engine.api.HttpPenmossApi> {
        val notebooks = notebooks()
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val added = notebooks.add(GitTestRepos.url(remote), null, null, "Work") as AddResult.Added
        asked.clear()
        val page = PurgingPage()
        val asks = OwnerAsks()
        val engine = GitEngine(added.notebook.localId, page, notebooks, scope, asks)
        val api = LocalGitApi.api(added.notebook.localId, OkHttpClient(), asks, limits) { engine }
        return Triple(notebooks, page, api)
    }

    private val note = "01JBN0000000000000000000P1"

    @Test
    fun aConfirmationSlowerThanTheRequestStillDeletesAndTheAppSaysItDid() = runBlocking {
        val (notebooks, page, api) = setUp(LocalGitApi.Limits(requestMs = 300, askedMs = 10_000, afterMs = 5_000, stepMs = 20))
        promptMs = 1_200
        api.purgeNote(note)
        assertEquals(1, asked.size)
        assertEquals(listOf(note), page.marked)
        assertEquals(listOf(note), notebooks.entries().single().purges.map { it.id })
    }

    @Test
    fun aRequestThatRunsOutBeforeTheConfirmationIsWithdrawnAndTheLateConfirmationDoesNothing() = runBlocking {
        val (notebooks, page, api) = setUp(LocalGitApi.Limits(requestMs = 300, askedMs = 700, afterMs = 5_000, stepMs = 20))
        promptMs = 1_500
        try {
            api.purgeNote(note)
            fail("reported as done")
        } catch (expected: Exception) {
            // The app says it failed.
        }
        // The person confirms after: nothing is kept, nothing marked.
        delay(promptMs + 500)
        assertEquals(1, asked.size)
        assertTrue(page.marked.isEmpty())
        assertTrue(notebooks.entries().single().purges.isEmpty())
    }

    @Test
    fun aRequestThatRunsOutBeforeItsPromptNeverShowsOne() = runBlocking {
        val (notebooks, page, api) = setUp(LocalGitApi.Limits(requestMs = 300, askedMs = 10_000, afterMs = 5_000, stepMs = 20))
        // Naming the note from the branch takes longer than the request may.
        titlesMs = 1_000
        try {
            api.purgeNote(note)
            fail("reported as done")
        } catch (expected: Exception) {
            // The app says it failed.
        }
        delay(titlesMs + 500)
        // No prompt was shown for a request already withdrawn; nothing marked, nothing kept.
        assertTrue(asked.toString(), asked.isEmpty())
        assertTrue(page.marked.isEmpty())
        assertTrue(notebooks.entries().single().purges.isEmpty())
    }

    @Test
    fun theOwnerCheckIsAskedAgainRightBeforeThePromptShows() = runBlocking {
        val shown = mutableListOf<String>()
        val check = OwnerConfirm { words ->
            shown += words
            OwnerAnswer.Confirmed
        }
        assertEquals(OwnerAnswer.Confirmed, check.confirm("delete it") { true })
        assertEquals(OwnerAnswer.Refused(OwnerAsks.WITHDRAWN), check.confirm("delete it") { false })
        assertEquals(listOf("delete it"), shown)
    }

    @Test
    fun removeNamesRoomsOldCopiesItWouldLose() = runBlocking {
        // Room's copies from before the store was cleared (A886, PR #167 delta check), with the changes not pushed.
        val (notebooks, _, _) = setUp(LocalGitApi.Limits())
        val localId = notebooks.entries().single().localId
        notebooks.remove(localId, unpushed = 2, oldCopies = 3)
        assertTrue(asked.single(), asked.single().endsWith(" from this phone and lose 2 changes never pushed and 3 notes from before its storage was cleared"))
    }

    @Test
    fun aCommitAddingACopyOfANoteDeletedForGoodIsRefused() = runBlocking {
        // A page script sends one past the engine (A886): the commit check names it, and the app refuses it.
        val (notebooks, _, _) = setUp(LocalGitApi.Limits())
        val localId = notebooks.entries().single().localId
        raced = listOf("01JBN0000000000000000000C1")
        val args = kotlinx.serialization.json.JsonArray(listOf(JsonNull, kotlinx.serialization.json.JsonArray(emptyList()), JsonPrimitive("A copy of a secret")))
        val frame = GitFrame.decode(FrameBuilder().encode(JsonObject(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(1), "op" to JsonPrimitive("git.commit"), "a" to args))))
        try {
            notebooks.op(localId, "commit", GitCall(args, frame), FrameBuilder())
            fail("committed a copy of a note deleted for good")
        } catch (refused: GitRefusal) {
            assertEquals("purge_raced", refused.code)
        }
    }

    @Test
    fun anAgentWritersCommitThatMarksAChangeUndoneIsRefusedAPersonsIsNot() = runBlocking {
        // #174 delta review: only a person's writer marks an agent's change undone.
        val (notebooks, _, _) = setUp(LocalGitApi.Limits())
        val localId = notebooks.entries().single().localId
        marks = listOf("4b825dc642cb6eb9a060e54bf8d69288fbee4904")
        val agent = "Penmoss: 1 note\n\nPenmoss-Writer: 01JBN0000000000000000000W1 (agent \"Claude Code\")\n"
        assertEquals("agent_undone", refusedCode { commitOne(notebooks, localId, null, agent, "by-agent") })
        val person = "Penmoss: 1 note\n\nPenmoss-Writer: 01JBN0000000000000000000W2 (device \"Penmoss for Android\")\n"
        assertEquals(null, refusedCode { commitOne(notebooks, localId, null, person, "by-person") })
        // An agent's commit that leaves the marks alone goes through.
        marks = emptyList()
        assertEquals(null, refusedCode { commitOne(notebooks, localId, null, agent, "by-agent-again") })
    }

    /** A commit of one file on [head] through the app's checks, as the page sends one. */
    private suspend fun commitOne(notebooks: GitNotebooks, localId: String, head: String?, message: String, file: String = message): String? {
        val builder = FrameBuilder()
        val change = kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive("notes/$file.txt"), builder.blob(message.toByteArray())))
        val args = kotlinx.serialization.json.JsonArray(listOf(head?.let(::JsonPrimitive) ?: JsonNull, kotlinx.serialization.json.JsonArray(listOf(change)), JsonPrimitive(message)))
        val frame = GitFrame.decode(builder.encode(JsonObject(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(1), "op" to JsonPrimitive("git.commit"), "a" to args))))
        return (notebooks.op(localId, "commit", GitCall(args, frame), FrameBuilder()) as? JsonPrimitive)?.content
    }

    private suspend fun refusedCode(run: suspend () -> Unit): String? = try {
        run()
        null
    } catch (refused: GitRefusal) {
        refused.code
    }

    @Test
    fun keepAndSyncConfirmedLetsThatCopyThroughOnceAndNoOther() = runBlocking {
        // A copy withheld from the push (A886): only the person's confirmation for that copy lets a
        // commit add it, and the confirmation is spent once its push lands.
        val (notebooks, _, _) = setUp(LocalGitApi.Limits())
        val localId = notebooks.entries().single().localId
        val copy = "01JBN0000000000000000000C1"
        val other = "01JBN0000000000000000000C2"
        raced = listOf(copy)
        assertEquals("purge_raced", refusedCode { commitOne(notebooks, localId, null, "unconfirmed") })
        notebooks.confirmKeepCopy(localId, copy, "Passwords NEWEDIT (recovered)")
        val words = asked.single()
        assertTrue(words, words.contains("Passwords NEWEDIT (recovered)") && words.contains("deleted for good on another device"))
        assertEquals(listOf(copy), notebooks.entries().single().keeps.map { it.id })
        // It names one copy: a commit that adds another as well is still refused.
        raced = listOf(copy, other)
        assertEquals("purge_raced", refusedCode { commitOne(notebooks, localId, null, "two-copies") })
        raced = listOf(copy)
        val commit = commitOne(notebooks, localId, null, "the-confirmed-copy") ?: error("no commit")
        val builder = FrameBuilder()
        val pushArgs = kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive(commit)))
        val pushFrame = GitFrame.decode(builder.encode(JsonObject(mapOf("k" to JsonPrimitive("call"), "id" to JsonPrimitive(2), "op" to JsonPrimitive("git.push"), "a" to pushArgs))))
        assertEquals("pushed", (notebooks.op(localId, "push", GitCall(pushArgs, pushFrame), FrameBuilder()) as JsonPrimitive).content)
        // Landed: the confirmation is spent, and nothing more gets through on it.
        assertTrue(notebooks.entries().single().keeps.isEmpty())
        assertEquals("purge_raced", refusedCode { commitOne(notebooks, localId, commit, "again") })
    }
}
