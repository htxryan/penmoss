package app.penmoss.engine.git

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The JGit transport (T50 G7, A824, A870) against local bare repositories (`file://`), as the
 * engine page uses it: fetch, list, read, commit on the remote head, a fast-forward push, a
 * rejected stale push, a directory target with a colleague, shallow history deepened for
 * History, redirects refused, the clone made again past its size, and cancel.
 */
class JGitTransportTest {
    @get:Rule
    val temp = TemporaryFolder()

    init {
        GitTestRepos.ready()
    }

    private val me = GitIdentity("Ryan on the Pixel", "ryan@example.invalid")

    private fun transport(remote: File, root: String = "", branch: String = "main", clone: File = temp.newFolder(), maxStore: Long = 20L * 1024 * 1024) =
        JGitTransport(File(clone, "repo.git"), GitTestRepos.url(remote), branch, root, { me }, { null }, maxStoreBytes = maxStore, clock = { 1_761_700_000_000 })

    private fun bytes(text: String) = text.toByteArray(Charsets.UTF_8)

    @Test
    fun aNewNotebookStartsTheBranchAndEachCommitIsBuiltOnTheRemoteHead() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val git = transport(remote)
        assertNull("no branch yet", git.fetch())
        val first = git.commit(null, mapOf(".penmoss/notebook.json" to bytes("{}\n")), "Penmoss: 0 notes [skip ci]")!!
        assertEquals(PushOutcome.PUSHED, git.push(first))
        assertEquals(first, git.fetch())
        assertEquals(first, GitTestRepos.head(remote, "main"))
        assertEquals("Ryan on the Pixel", GitTestRepos.author(remote, first).name)

        val second = git.commit(first, mapOf(".penmoss/notes/01JNOTE0000000000000000000/01JWRITER00000000000000000.yjs" to byteArrayOf(1, 2, 3)), "Penmoss: 1 note [skip ci]\n\nPenmoss-Writer: 01JWRITER00000000000000000 (device \"Pixel\")\n")!!
        assertEquals(PushOutcome.PUSHED, git.push(second))
        assertEquals(listOf(1, 0), GitTestRepos.parentCounts(remote, "main"))
        assertTrue(GitTestRepos.message(remote, second).contains("Penmoss-Writer: 01JWRITER00000000000000000"))
        val files = git.list(second)
        assertEquals(setOf(".penmoss/notebook.json", ".penmoss/notes/01JNOTE0000000000000000000/01JWRITER00000000000000000.yjs"), files.keys)
        assertEquals(listOf<Byte>(1, 2, 3), git.read(second, files.keys.toList())[".penmoss/notes/01JNOTE0000000000000000000/01JWRITER00000000000000000.yjs"]!!.toList())
        assertEquals(3L, git.sizes(second, listOf(".penmoss/notes/01JNOTE0000000000000000000/01JWRITER00000000000000000.yjs")).values.single())
        assertEquals(listOf(".penmoss/notes/01JNOTE0000000000000000000/01JWRITER00000000000000000.yjs"), git.changed(first, second))
        assertNull("nothing changes: no commit", git.commit(second, mapOf(".penmoss/notebook.json" to bytes("{}\n")), "x"))
    }

    @Test
    fun aStalePushIsRejectedAndNeverMerged() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val phone = transport(remote)
        assertNull(phone.fetch())
        val base = phone.commit(null, mapOf("a.md" to bytes("a")), "base")!!
        assertEquals(PushOutcome.PUSHED, phone.push(base))
        val other = transport(remote)
        assertEquals(base, other.fetch())
        assertEquals(PushOutcome.PUSHED, other.push(other.commit(base, mapOf("b.md" to bytes("b")), "other")!!))
        // The phone has not fetched: its commit on the old head must be refused.
        val stale = phone.commit(base, mapOf("c.md" to bytes("c")), "stale")!!
        assertEquals(PushOutcome.REJECTED, phone.push(stale))
        val head = phone.fetch()!!
        val rebuilt = phone.commit(head, mapOf("c.md" to bytes("c")), "rebuilt")!!
        assertEquals(PushOutcome.PUSHED, phone.push(rebuilt))
        assertEquals(setOf("a.md", "b.md", "c.md"), GitTestRepos.paths(remote, "main").toSet())
        assertTrue("never a merge", GitTestRepos.parentCounts(remote, "main").all { it <= 1 })
    }

    @Test
    fun aDirectoryTargetTouchesOnlyItsDirectoryAndLeavesTheColleagueAlone() {
        val remote = GitTestRepos.bare(temp.newFolder("code.git"))
        GitTestRepos.colleaguePush(remote, "main", mapOf("README.md" to "# Code\n", "src/app.js" to "x()\n", "docs/notes/README.md" to "hand-made\n"))
        val git = transport(remote, root = "docs/notes/")
        val head = git.fetch()!!
        assertEquals(setOf("docs/notes/README.md"), git.list(head).keys)
        val commit = git.commit(head, mapOf("docs/notes/.penmoss/notebook.json" to bytes("{}")), "Penmoss: 0 notes [skip ci]")!!
        assertEquals(PushOutcome.PUSHED, git.push(commit))
        assertEquals("# Code\n", GitTestRepos.fileAt(remote, "main", "README.md"))
        assertEquals("x()\n", GitTestRepos.fileAt(remote, "main", "src/app.js"))
        assertEquals("hand-made\n", GitTestRepos.fileAt(remote, "main", "docs/notes/README.md"))
        val after = GitTestRepos.colleaguePush(remote, "main", mapOf("src/app.js" to "y()\n"))
        assertEquals(after, git.fetch())
        assertEquals("only the notebook's directory is diffed", emptyList<String>(), git.changed(commit, after))
        for (outside in listOf("README.md", "docs/other.md", "docs/notes/../x.md", "docs/notes/.git/config", "docs/notes//x.md")) {
            try {
                git.commit(after, mapOf(outside to bytes("no")), "x")
                fail("wrote $outside")
            } catch (expected: GitException) {
                assertEquals(GitErrorCode.GIT, expected.code)
            }
        }
    }

    @Test
    fun anUnknownCommitHasNoChangeListAndAMissingFileReadsAsNothing() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val git = transport(remote)
        git.fetch()
        val one = git.commit(null, mapOf("a.md" to bytes("a")), "one")!!
        git.push(one)
        assertNull(git.changed("0123456789abcdef0123456789abcdef01234567", one))
        assertNull(git.readAt(one, "nope.md"))
        assertEquals("a", git.readAt(one, "a.md")!!.toString(Charsets.UTF_8))
        assertTrue(git.read(one, listOf("nope.md")).isEmpty())
    }

    @Test
    fun aRewriteInTheClonesConfigIsRefusedBeforeAnythingIsSent() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val elsewhere = GitTestRepos.bare(temp.newFolder("elsewhere.git"))
        val clone = temp.newFolder()
        val git = transport(remote, clone = clone)
        git.fetch()
        val commit = git.commit(null, mapOf("a.md" to bytes("a")), "one")!!
        git.close()
        for ((section, sub, key) in listOf(Triple("url", GitTestRepos.url(elsewhere), "insteadOf"), Triple("url", GitTestRepos.url(elsewhere), "pushInsteadOf"), Triple("remote", "origin", "pushurl"))) {
            val repo = org.eclipse.jgit.storage.file.FileRepositoryBuilder().setGitDir(File(clone, "repo.git")).setBare().build()
            repo.config.load()
            val value = if (section == "url") GitTestRepos.url(remote) else GitTestRepos.url(elsewhere)
            repo.config.setString(section, sub, key, value)
            repo.config.save()
            repo.close()
            val again = transport(remote, clone = clone)
            for (call in listOf<() -> Unit>({ again.fetch() }, { again.push(commit) })) {
                try {
                    call()
                    fail("$section.$key was not refused")
                } catch (expected: GitException) {
                    assertEquals(GitErrorCode.REDIRECTED, expected.code)
                }
            }
            again.close()
            val clean = org.eclipse.jgit.storage.file.FileRepositoryBuilder().setGitDir(File(clone, "repo.git")).setBare().build()
            clean.config.load()
            clean.config.unsetSection(section, sub)
            if (section == "remote") clean.config.unset("remote", "origin", "pushurl")
            clean.config.save()
            clean.close()
        }
        assertNull("nothing reached the other repository", GitTestRepos.head(elsewhere, "main"))
        assertNull(GitTestRepos.head(remote, "main"))
    }

    @Test
    fun historyDeepensAShallowCloneAndNeverListsTheEdgeAsARoot() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val writer = transport(remote)
        writer.fetch()
        var head: String? = null
        val note = ".penmoss/notes/01JNOTE0000000000000000000/01JWRITER00000000000000000.yjs"
        for (i in 1..6) {
            val changes = if (i % 2 == 0) mapOf("other-$i.md" to bytes("$i")) else mapOf(note to bytes("v$i"))
            head = writer.commit(head, changes, "commit $i")!!
            assertEquals(PushOutcome.PUSHED, writer.push(head))
        }
        val phone = transport(remote)
        assertEquals(head, phone.fetch())
        val versions = phone.log(listOf(".penmoss/notes/01JNOTE0000000000000000000/"), 100)
        assertEquals(listOf("commit 5", "commit 3", "commit 1"), versions.map { it.message })
        assertEquals("v1", phone.readAt(versions.last().id, note)!!.toString(Charsets.UTF_8))
        assertEquals(6, phone.log(null, null).size)
    }

    @Test
    fun theCloneIsMadeAgainPastItsSizeAndSyncsOn() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val clone = temp.newFolder()
        val git = transport(remote, clone = clone, maxStore = 1)
        git.fetch()
        val one = git.commit(null, mapOf("a.md" to bytes("a")), "one")!!
        git.push(one)
        assertTrue(File(clone, "repo.git").exists())
        git.maintain()
        assertFalse("thrown away", File(clone, "repo.git").exists())
        assertEquals(one, git.fetch())
        val two = git.commit(one, mapOf("b.md" to bytes("b")), "two")!!
        assertEquals(PushOutcome.PUSHED, git.push(two))
    }

    @Test
    fun cancelStopsWhatWaitsAndLaterCallsRun() {
        val remote = GitTestRepos.bare(temp.newFolder("remote.git"))
        val git = transport(remote)
        git.fetch()
        val one = git.commit(null, mapOf("a.md" to bytes("a")), "one")!!
        // A call that waits for the lock while another runs, then a cancel: it fails as a timeout.
        val holding = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = thread {
            synchronized(lockOf(git)) {
                holding.countDown()
                release.await(5, TimeUnit.SECONDS)
            }
        }
        holding.await()
        var failure: GitException? = null
        val waiter = thread { failure = runCatching { git.push(one) }.exceptionOrNull() as? GitException }
        Thread.sleep(100)
        git.cancel()
        release.countDown()
        holder.join()
        waiter.join()
        assertNotNull(failure)
        assertEquals(GitErrorCode.TIMEOUT, failure!!.code)
        assertEquals(PushOutcome.PUSHED, git.push(one))
    }

    private fun lockOf(git: JGitTransport): Any =
        JGitTransport::class.java.getDeclaredField("lock").apply { isAccessible = true }.get(git)
}
