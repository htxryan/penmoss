package app.penmoss.engine.git

import app.penmoss.engine.api.ApiException
import app.penmoss.engine.sync.ExchangeResult
import app.penmoss.engine.sync.InMemorySyncStore
import app.penmoss.engine.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
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

/**
 * Android's git notebooks against the Node engine (T50 G7, A878): Kotlin's `GitNotebooks`,
 * `JGitTransport` and `LocalGitApi`, with Room's `SyncEngine` (its in-memory store), drive the
 * engine page the APK ships, under Node; the CLI's own commands (the Mac's and the CLI's engine,
 * over system git) sync the same bare repository. Each side reads what the other wrote, both ways.
 */
class GitCrossEngineTest {
    @get:Rule
    val temp = TemporaryFolder()

    init {
        GitTestRepos.ready()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val ports = mutableListOf<NodePort>()
    private val words = mutableListOf<String>()
    private var clock = 1_761_750_000_000L
    private var confirm = true

    private val seal = object : SecretSeal {
        // The Keystore in the app; a reversible stand-in here (the tests' own data only).
        override fun seal(plain: String) = "sealed:" + plain.reversed()

        override fun unseal(sealed: String) = sealed.removePrefix("sealed:").reversed()
    }

    @After
    fun stop() {
        ports.forEach { runCatching { it.close() } }
        scope.cancel()
    }

    private inner class Phone(val dir: File = temp.newFolder(), val keys: CommitKeyStore? = null) {
        lateinit var notebooks: GitNotebooks
        val guardPort: NodePort = NodeGitRunner.guard().also { ports += it }
        val guard: PageGuard = PageGuard(guardPort, scope) { notebooks }
        val asks = OwnerAsks()

        init {
            notebooks = GitNotebooks(
                dir = File(dir, "files"),
                seal = seal,
                owner = OwnerConfirm { asked ->
                    words += asked
                    if (confirm) OwnerAnswer.Confirmed else OwnerAnswer.Refused("Not you")
                },
                guard = guard,
                identity = { GitIdentity("Ryan on the Pixel", "ryan@example.invalid") },
                now = { clock },
                signingKeys = keys,
            )
        }

        fun engine(localId: String, state: File = File(dir, "page"), wrap: (FramePort) -> FramePort = { it }): GitEngine {
            val port = NodeGitRunner.page(state).also { ports += it }
            return GitEngine(localId, wrap(port), notebooks, scope, asks)
        }
    }

    private fun bare(): File = GitTestRepos.bare(temp.newFolder("remote.git"))

    private fun cliAdd(home: File, remote: File) {
        val added = NodeGitRunner.cli(home, "notebook", "add", GitTestRepos.url(remote), "--name", "work")
        assertEquals(added.stderr, 0, added.code)
    }

    /** Room's copies from before the page's epoch (A886), as the app's Room adapter reads them. */
    private class StoreCopies(private val store: InMemorySyncStore) : OldCopies {
        private val held = setOf(InMemorySyncStore.State.SYNCED, InMemorySyncStore.State.PENDING)

        /** Copies kept aside (Room's RECOVERY rows): their rows leave the note's own. */
        val kept = linkedMapOf<String, OldCopy>()

        override suspend fun epochs() = store.notes.values.mapNotNull { it.epoch }.distinct()

        override suspend fun before(epoch: String) = store.notes.values
            .filter { it.epoch != null && it.epoch != epoch && !it.gone }
            .map { note -> OldCopy(note.id, note.title, null, store.rows.filter { it.noteId == note.id && it.state in held }.map { it.update }) }
            .filter { it.updates.isNotEmpty() } + kept.values

        override suspend fun done(copy: OldCopy) {
            if (copy.kept) {
                kept.remove(copy.noteId)
                return
            }
            store.rows.removeAll { it.noteId == copy.noteId && it.state in held }
            store.notes[copy.noteId]?.cursor = null
        }

        override suspend fun keep(copy: OldCopy) {
            if (copy.kept) return
            kept[copy.noteId] = copy.copy(kept = true)
            store.rows.removeAll { it.noteId == copy.noteId && it.state in held }
            store.notes[copy.noteId]?.cursor = null
        }
    }

    /** A page's port that loses the app's `recover` calls for one note while [dropping] (a page too slow to answer). */
    private class Dropping(private val inner: FramePort, private val noteId: String) : FramePort {
        @Volatile
        var dropping = true

        override fun send(frame: ByteArray) {
            if (dropping) {
                val header = GitFrame.decode(frame).header
                val op = (header["op"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val note = ((header["a"] as? kotlinx.serialization.json.JsonObject)?.get("noteId") as? kotlinx.serialization.json.JsonPrimitive)?.content
                if (op == "recover" && note == noteId) return
            }
            inner.send(frame)
        }

        override fun listen(listener: (ByteArray) -> Unit) = inner.listen(listener)
    }

    private val label = "Penmoss for Android (Pixel)"

    @Test
    fun clearedOfflineNothingComesBackUntilASyncFetchedTheHeadThenOnlyWhatGitLacksAndTrashStaysTrash() = runBlocking {
        val remote = bare()
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Work") as AddResult.Added
        val localId = added.notebook.localId
        val entry = phone.notebooks.entry(localId)!!
        val state = File(phone.dir, "page")
        var engine = phone.engine(localId, state)
        engine.open(entry, label, front = false)
        assertTrue("a first open is a fresh store", engine.fresh)
        // The page could not ask to be kept (no StorageManager under Node): null, as recorded.
        assertEquals(null, engine.persisted)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val store = InMemorySyncStore()
        val copies = StoreCopies(store)
        val sync = SyncEngine(api, store) { _: ExchangeResult -> }
        // On the branch: three notes made and pushed, one of them then moved to Trash (pushed too).
        val pushed = "01JBN0000000000000000000P1"
        store.addPending(pushed, NodeGitRunner.note(pushed, "Budget", "On the branch"))
        val untouched = "01JBN0000000000000000000P3"
        store.addPending(untouched, NodeGitRunner.note(untouched, "Old list", "Pushed too"))
        val thrown = "01JBN0000000000000000000P4"
        store.addPending(thrown, NodeGitRunner.note(thrown, "Old plan", "Thrown away and pushed"))
        sync.sync()
        for (id in listOf(pushed, untouched, thrown)) api.moveNote(id, null, null, null, null)
        api.trashNote(thrown, 0)
        assertEquals("synced", engine.sync().phase)
        sync.sync()
        // Taken in by the page, never pushed: a rename, a note made since, and one made and moved to Trash.
        store.addPending(pushed, NodeGitRunner.retitle(pushed, "Budget for 2027", store.updates(pushed, InMemorySyncStore.State.SYNCED)))
        val draft = "01JBN0000000000000000000P2"
        store.addPending(draft, NodeGitRunner.note(draft, "Draft", "Only on the phone"))
        val scratch = "01JBN0000000000000000000P5"
        store.addPending(scratch, NodeGitRunner.note(scratch, "Scratch", "Thrown away here"))
        sync.sync()
        api.moveNote(scratch, null, null, null, null)
        api.trashNote(scratch, 0)
        sync.sync()
        assertTrue("the page took them in", store.rows.none { it.state == InMemorySyncStore.State.PENDING })
        // Not pushed yet. Offline, Android clears the page's store: the page opens afresh.
        ports.last().kill()
        assertTrue(state.deleteRecursively())
        val away = File(remote.parentFile, "away.git")
        assertTrue(remote.renameTo(away))
        engine = phone.engine(localId, state)
        val epoch = engine.open(entry, label, front = false, roomEpochs = copies.epochs())
        assertTrue("a cleared store opens afresh", engine.fresh)
        assertTrue("with a new epoch", store.notes.getValue(pushed).epoch != epoch)
        val offline = engine.sync()
        assertTrue(offline.phase, offline.phase == "offline" || offline.phase == "stopped")
        // Nothing fetched: nothing compared, nothing brought back, every copy kept as it is.
        val recovery = GitRecovery(engine, copies)
        val first = recovery.run()!!
        assertTrue(first.later)
        assertTrue(first.recovered.isEmpty())
        // Edited meanwhile, offline, on Room's copy of the old store.
        store.addPending(untouched, NodeGitRunner.retitle(untouched, "Old list, offline", store.updates(untouched, InMemorySyncStore.State.SYNCED)))
        val rows = store.rows.map { Triple(it.id, it.state, it.update) }
        val epochs = store.notes.mapValues { it.value.epoch }
        // Room syncs meanwhile: its copies of the old store are held, untouched, never replaced
        // by a store that has nothing yet.
        sync.sync()
        assertEquals(rows, store.rows.map { Triple(it.id, it.state, it.update) })
        assertEquals(epochs, store.notes.mapValues { it.value.epoch })
        assertTrue(store.notes.values.none { it.gone })
        assertEquals(5, copies.before(epoch).size)
        // Online again: a sync fetches the head, and only what git lacks comes back.
        assertTrue(away.renameTo(remote))
        assertEquals("synced", engine.sync().phase)
        val pass = recovery.run()!!
        assertFalse(pass.later)
        assertTrue(pass.unrecovered.isEmpty())
        assertEquals(
            setOf("Budget for 2027 (recovered)", "Draft (recovered)", "Scratch (recovered)", "Old list, offline (recovered)"),
            pass.recovered.map { it.title }.toSet(),
        )
        assertEquals(setOf(pushed, draft, scratch, untouched), pass.recovered.map { it.from }.toSet())
        // In Trash it stays in Trash; the one git has in Trash already is not brought back.
        val trash = api.trash().map { it.title }.toSet()
        assertEquals(setOf("Old plan", "Scratch (recovered)"), trash)
        // Asked again: nothing left from the old store.
        assertEquals(null, recovery.run())
        // Room syncs with the new store, and the copies reach the branch.
        sync.sync()
        assertEquals("synced", engine.sync().phase)
        val home = temp.newFolder("cli")
        cliAdd(home, remote)
        val read = NodeGitRunner.cli(home, "cat", "Draft (recovered)", "--notebook", "work", "--body")
        assertEquals(read.stderr, 0, read.code)
        assertTrue(read.stdout, read.stdout.contains("Only on the phone"))
        val listed = NodeGitRunner.cli(home, "ls", "--notebook", "work")
        assertTrue(listed.stdout, listed.stdout.contains("Budget for 2027 (recovered)"))
        assertTrue(listed.stdout, Regex("Budget  ").containsMatchIn(listed.stdout))
        assertTrue(listed.stdout, listed.stdout.contains("Old list, offline (recovered)"))
        assertFalse(listed.stdout, listed.stdout.contains("Scratch (recovered)"))
        assertFalse(listed.stdout, listed.stdout.contains("Old plan (recovered)"))
    }

    @Test
    fun theMacsTagDescriptionsSurviveThePhonesSyncsAndItsOwnChanges() = runBlocking {
        // PEN-68: the Mac app keeps what each tag means in the notebook's WorkspaceDoc. The phone
        // has no Tags page and never reads them, but its engine merges the whole WorkspaceDoc, so
        // its own changes (a note filed, a folder made) push beside them and never drop them.
        val remote = bare()
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Work") as AddResult.Added
        val localId = added.notebook.localId
        val entry = phone.notebooks.entry(localId)!!
        val engine = phone.engine(localId)
        engine.open(entry, label, front = false)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val store = InMemorySyncStore()
        val sync = SyncEngine(api, store) { _: ExchangeResult -> }
        val roadmap = "01JBN0000000000000000000T1"
        store.addPending(roadmap, NodeGitRunner.note(roadmap, "Roadmap", "Plans for #project/penmoss"))
        sync.sync()
        api.moveNote(roadmap, null, null, null, null)
        assertEquals("synced", engine.sync().phase)

        // The Mac describes two tags and pushes.
        NodeGitRunner.describe(GitTestRepos.url(remote), temp.newFolder("mac"), "project", "Work with an end.", "project/penmoss", "The notes app itself.")

        // The phone pulls, files a new tagged note in a folder of its own, and pushes.
        assertEquals("synced", engine.sync().phase)
        val folder = api.createFolder("01JBN0000000000000000000F1", "Android", null)
        val phoneNote = "01JBN0000000000000000000T2"
        store.addPending(phoneNote, NodeGitRunner.note(phoneNote, "Phone build", "The #project/penmoss/android build"))
        sync.sync()
        api.moveNote(phoneNote, folder.id, null, null, null)
        assertEquals("synced", engine.sync().phase)
        assertTrue("the phone pushed its change", GitTestRepos.paths(remote, "main").any { it.contains("Phone build") })

        // An agent on a fresh clone reads both descriptions, with the phone's new tag under them.
        val read = NodeGitRunner.describe(GitTestRepos.url(remote), temp.newFolder("reader"))
        assertTrue(read, read.contains("""{"name":"project","description":"Work with an end.","notes":2,"ancestors":[]}"""))
        assertTrue(read, read.contains("""{"name":"project/penmoss","description":"The notes app itself.","notes":2,"""))
        assertTrue(
            read,
            read.contains(
                """{"name":"project/penmoss/android","description":null,"notes":1,"ancestors":[{"name":"project","description":"Work with an end."},{"name":"project/penmoss","description":"The notes app itself."}]}""",
            ),
        )
    }

    @Test
    fun aNoteDeletedForGoodNeverComesBackFromRoomsOldCopy() = runBlocking {
        // The PR #167 probe: "Passwords" is deleted for good and the purge lands; Room has not
        // pulled the tombstone yet; Android clears the page's store.
        val remote = bare()
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Work") as AddResult.Added
        val localId = added.notebook.localId
        val entry = phone.notebooks.entry(localId)!!
        val state = File(phone.dir, "page")
        var engine = phone.engine(localId, state)
        engine.open(entry, label, front = false)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val store = InMemorySyncStore()
        val copies = StoreCopies(store)
        val sync = SyncEngine(api, store) { _: ExchangeResult -> }
        val secret = "01JBN0000000000000000000S1"
        store.addPending(secret, NodeGitRunner.note(secret, "Passwords", "hunter2"))
        sync.sync()
        api.moveNote(secret, null, null, null, null)
        assertEquals("synced", engine.sync().phase)
        api.purgeNote(secret)
        assertEquals("synced", engine.sync().phase)
        assertTrue(GitTestRepos.paths(remote, "main").none { it.contains(secret) })
        assertTrue("Room still holds it", store.rows.any { it.noteId == secret })
        ports.last().kill()
        assertTrue(state.deleteRecursively())
        engine = phone.engine(localId, state)
        val epoch = engine.open(entry, label, front = false, roomEpochs = copies.epochs())
        assertTrue(engine.fresh)
        assertEquals("synced", engine.sync().phase)
        val pass = GitRecovery(engine, copies).run()!!
        assertFalse(pass.later)
        assertEquals(emptyList<RecoveredNote>(), pass.recovered)
        assertTrue(pass.unrecovered.isEmpty())
        assertTrue("dropped from Room's copies", copies.before(epoch).isEmpty())
        sync.sync()
        assertEquals("synced", engine.sync().phase)
        // Nothing of it on the branch: no file names it, none holds its text, no copy of it.
        val paths = GitTestRepos.paths(remote, "main")
        assertTrue(paths.toString(), paths.none { it.contains("Passwords") })
        assertTrue(paths.none { GitTestRepos.fileAt(remote, "main", it)?.contains("hunter2") == true })
        val home = temp.newFolder("cli")
        cliAdd(home, remote)
        val listed = NodeGitRunner.cli(home, "ls", "--notebook", "work")
        assertFalse(listed.stdout, listed.stdout.contains("Passwords"))
    }

    @Test
    fun copiesThatCannotBeBroughtBackAreKeptAndNamedAndTheNotebookOpensWhateverTheyHold() = runBlocking {
        val remote = bare()
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Work") as AddResult.Added
        val localId = added.notebook.localId
        val entry = phone.notebooks.entry(localId)!!
        val state = File(phone.dir, "page")
        var engine = phone.engine(localId, state)
        engine.open(entry, label, front = false)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val store = InMemorySyncStore()
        val copies = StoreCopies(store)
        val sync = SyncEngine(api, store) { _: ExchangeResult -> }
        // A long note (its updates far over a part), one the page will be too slow for, one Room cannot give whole.
        val long = "01JBN0000000000000000000L1"
        val longBody = (1..400).joinToString("\n") { "Line $it of the long note" }
        store.addPending(long, NodeGitRunner.note(long, "Long notes", longBody))
        val slow = "01JBN0000000000000000000L2"
        store.addPending(slow, NodeGitRunner.note(slow, "Slow one", "Waits too long"))
        val broken = "01JBN0000000000000000000L3"
        store.addPending(broken, NodeGitRunner.note(broken, "Broken", "Half of it reads"))
        sync.sync()
        for (id in listOf(long, slow, broken)) api.moveNote(id, null, null, null, null)
        assertEquals("synced", engine.sync().phase)
        for ((id, title) in listOf(long to "Long notes, edited", slow to "Slow one, edited", broken to "Broken, edited")) {
            store.addPending(id, NodeGitRunner.retitle(id, title, store.updates(id, InMemorySyncStore.State.SYNCED)))
        }
        sync.sync()
        // A row Room holds that is not an update at all.
        store.rows += InMemorySyncStore.Row(9_999, broken, "bm90IGEgeWpzIHVwZGF0ZQ==", InMemorySyncStore.State.SYNCED)
        ports.last().kill()
        assertTrue(state.deleteRecursively())
        lateinit var dropper: Dropping
        engine = phone.engine(localId, state) { port -> Dropping(port, slow).also { dropper = it } }
        val epoch = engine.open(entry, label, front = false, roomEpochs = copies.epochs())
        assertTrue(engine.fresh)
        assertEquals("synced", engine.sync().phase)
        // Run as the app runs it: after the open, in the background.
        val passes = kotlinx.coroutines.channels.Channel<RecoveryPass>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        val logged = java.util.concurrent.CopyOnWriteArrayList<String>()
        val runner = GitRecovery.Runner(
            scope,
            pass = { GitRecovery(engine, copies, partChars = 64, callMs = 2_000, log = { logged += it }).run() },
            onPass = { passes.trySend(it) },
        )
        runner.soon()
        // The notebook answers while the copies are tried: its notes server, and Room's sync.
        kotlinx.coroutines.withTimeout(1_500) { api.trash() }
        sync.sync()
        val pass = kotlinx.coroutines.withTimeout(60_000) { passes.receive() }
        assertFalse(pass.later)
        // The long one came through in parts; the slow and the broken ones are kept, and named.
        assertEquals(listOf("Long notes, edited (recovered)"), pass.recovered.map { it.title })
        assertEquals(setOf(slow, broken), pass.unrecovered.map { it.noteId }.toSet())
        assertEquals(2, logged.size)
        assertEquals(setOf(slow, broken), copies.before(epoch).filter { it.kept }.map { it.noteId }.toSet())
        val home = temp.newFolder("cli")
        cliAdd(home, remote)
        assertEquals("synced", engine.sync().phase)
        val read = NodeGitRunner.cli(home, "cat", "Long notes, edited (recovered)", "--notebook", "work", "--body")
        assertEquals(read.stderr, 0, read.code)
        assertTrue(read.stdout, read.stdout.contains("Line 400 of the long note"))
        // Save their text: what of each can be read.
        val saved = GitRecovery(engine, copies, partChars = 64).export(copies.before(epoch).filter { it.kept })
        assertTrue(saved, saved.contains("## Slow one, edited"))
        assertTrue(saved, saved.contains("Waits too long"))
        assertTrue(saved, saved.contains("## Broken, edited"))
        assertTrue(saved, saved.contains("Half of it reads"))
        // Kept copies are tried again: the slow one comes back once the page answers; the broken one stays kept.
        dropper.dropping = false
        runner.soon()
        val again = kotlinx.coroutines.withTimeout(60_000) { passes.receive() }
        assertEquals(listOf("Slow one, edited (recovered)"), again.recovered.map { it.title })
        assertEquals(listOf(broken), again.unrecovered.map { it.noteId })
        // And the notebook opens again, its store kept, whatever the copy holds.
        ports.last().kill()
        engine = phone.engine(localId, state)
        engine.open(entry, label, front = false, roomEpochs = copies.epochs())
        assertFalse(engine.fresh)
        assertEquals("synced", engine.sync().phase)
    }

    /**
     * #172 (A921): with Sign commits on, every commit the engine page makes through JGit is
     * signed with the phone's key, and system git and OpenSSH verify it; the CLI reads the notes.
     * A key the phone lost stops the sync, "Sync stopped: signing", and nothing reaches the
     * branch; turned off, the sync goes on unsigned.
     */
    @Test
    fun aPhoneThatSignsCommitsPushesCommitsGitVerifiesAndALostKeyStopsTheSync() = runBlocking {
        val remote = bare()
        val keys = SoftwareKeyStore()
        val phone = Phone(keys = keys)
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Work") as AddResult.Added
        val localId = added.notebook.localId
        assertTrue(phone.notebooks.setSignCommits(localId, true).signCommits)
        val line = phone.notebooks.signingKeyLine("Penmoss for Android (Pixel)")!!
        assertTrue(line, line.startsWith("ecdsa-sha2-nistp256 "))
        val engine = phone.engine(localId)
        engine.open(phone.notebooks.entry(localId)!!, "Penmoss for Android (Pixel)", front = false)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val store = InMemorySyncStore()
        val sync = SyncEngine(api, store)
        val note = "01JBN0000000000000000000S1"
        store.addPending(note, NodeGitRunner.note(note, "Signed", "From a signing phone"))
        sync.sync()
        api.moveNote(note, null, null, null, null)
        assertEquals("synced", engine.sync().phase)
        val commits = GitTestRepos.parentCounts(remote, "main").size
        assertTrue("the notebook's commits", commits >= 1)
        val scratch = temp.newFolder("signers")
        val head = GitTestRepos.head(remote, "main")!!
        for (sha in SignatureChecks.run(remote, "git", "rev-list", head).second.lines().filter { it.isNotBlank() }) {
            val (code, said) = SignatureChecks.verifyCommit(remote, sha, "ryan@example.invalid", line, scratch)
            assertEquals(said, 0, code)
            assertTrue(said, said.contains("Good \"git\" signature for ryan@example.invalid"))
        }
        val home = temp.newFolder("cli")
        cliAdd(home, remote)
        val read = NodeGitRunner.cli(home, "cat", "Signed", "--notebook", "work", "--body")
        assertEquals(read.stderr, 0, read.code)
        assertTrue(read.stdout.contains("From a signing phone"))

        // The Keystore lost the key: the sync stops, and the branch is as it was.
        keys.lose()
        val second = "01JBN0000000000000000000S2"
        store.addPending(second, NodeGitRunner.note(second, "Unsigned?", "Never unsigned"))
        sync.sync()
        val stopped = engine.sync()
        assertEquals("stopped", stopped.phase)
        assertTrue(stopped.detail.orEmpty(), stopped.detail.orEmpty().startsWith("Sync stopped: signing."))
        assertEquals(head, GitTestRepos.head(remote, "main"))
        // Turned off, it syncs, unsigned.
        assertFalse(phone.notebooks.setSignCommits(localId, false).signCommits)
        assertEquals("synced", engine.sync().phase)
        val after = GitTestRepos.head(remote, "main")!!
        assertTrue(after != head)
        assertFalse(SignatureChecks.run(remote, "git", "cat-file", "commit", after).second.contains("gpgsig"))
    }

    /**
     * #170 F6: a notebook's own commit name and email win over Commits from this phone, from the
     * next commit (GitHub's GH007 refuses a private one: the page's words are tested in TS).
     */
    @Test
    fun aNotebooksOwnCommitIdentityIsUsedFromTheNextCommit() = runBlocking {
        val remote = bare()
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Work") as AddResult.Added
        val localId = added.notebook.localId
        assertNull(added.notebook.author)
        val engine = phone.engine(localId)
        engine.open(phone.notebooks.entry(localId)!!, "Penmoss for Android (Pixel)", front = false)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val store = InMemorySyncStore()
        val sync = SyncEngine(api, store)
        val authorOf = { SignatureChecks.run(remote, "git", "log", "-1", "--format=%an <%ae>", "main").second.trim() }
        store.addPending("01JBN0000000000000000000A1", NodeGitRunner.note("01JBN0000000000000000000A1", "One", "one"))
        sync.sync()
        assertEquals("synced", engine.sync().phase)
        assertEquals("Ryan on the Pixel <ryan@example.invalid>", authorOf())


        val view = phone.notebooks.setAuthor(localId, "Ryan", "1234+ryan@users.noreply.github.com")
        assertEquals(GitIdentity("Ryan", "1234+ryan@users.noreply.github.com"), view.author)
        store.addPending("01JBN0000000000000000000A2", NodeGitRunner.note("01JBN0000000000000000000A2", "Two", "two"))
        sync.sync()
        assertEquals("synced", engine.sync().phase)
        assertEquals("Ryan <1234+ryan@users.noreply.github.com>", authorOf())
        // Plain text only (#174 review): no NUL, control, bidi or other format character either.
        for ((name, email) in listOf(
            "Ryan" to "not-an-email", "a\nb" to "a@b.c", "Ryan" to null,
            "Ry\u202Ean" to "a@b.c", "Ry\u200Ban" to "a@b.c", "Ryan" to "a\u0000@b.c",
            "Ryan" to "a\u202E@b.c", "Ryan" to "a@b\u2066.c",
        )) {
            try {
                phone.notebooks.setAuthor(localId, name, email)
                fail("accepted $name <$email>")
            } catch (error: GitRefusal) {
                assertEquals("invalid_request", error.code)
            }
        }
        assertNull(phone.notebooks.setAuthor(localId, null, null).author)
        store.addPending("01JBN0000000000000000000A3", NodeGitRunner.note("01JBN0000000000000000000A3", "Three", "three"))
        sync.sync()
        assertEquals("synced", engine.sync().phase)
        assertEquals("Ryan on the Pixel <ryan@example.invalid>", authorOf())
    }

    /**
     * #172 (A920): what an agent (the CLI, added with --agent) changed in the folders is in the
     * phone's Agent activity, over the same REST as the server's, read from the branch; Undo is
     * the phone's own change, which the CLI reads back after the next sync.
     */
    @Test
    fun anAgentsFolderChangeFromTheCliIsUndoneOnThePhoneAndTheCliSeesItBack() = runBlocking {
        val remote = bare()
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Work") as AddResult.Added
        val localId = added.notebook.localId
        val engine = phone.engine(localId)
        engine.open(phone.notebooks.entry(localId)!!, "Penmoss for Android (Pixel)", front = false)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        assertEquals("synced", engine.sync().phase)

        // Ryan adds the repository at the terminal; an agent's clone of it on the same machine.
        val home = temp.newFolder("agent")
        cliAdd(home, remote)
        val joined = NodeGitRunner.cli(home, "notebook", "add", GitTestRepos.url(remote), "--name", "agent", "--agent", "Claude Code")
        assertEquals(joined.stderr, 0, joined.code)
        val made = NodeGitRunner.cli(home, "mkdir", "Ideas", "--notebook", "agent")
        assertEquals(made.stderr, 0, made.code)
        assertEquals("synced", engine.sync().phase)

        val entries = api.agentActivity()
        assertEquals(listOf("Made the folder “Ideas”"), entries.map { it.summary })
        assertEquals("Claude Code", entries.single().actor.label)
        val undone = api.undoAgentActivity(entries.single().id)
        assertTrue(undone.undone)
        assertFalse(undone.alreadyUndone)
        assertEquals("synced", engine.sync().phase)
        assertEquals("Penmoss for Android (Pixel)", api.agentActivity().single().undoneBy)
        val listed = NodeGitRunner.cli(home, "ls", "--notebook", "work")
        assertEquals(listed.stderr, 0, listed.code)
        assertFalse(listed.stdout, listed.stdout.contains("Ideas"))
        // A forward change: never a merge, never a rewrite.
        assertTrue(GitTestRepos.parentCounts(remote, "main").all { it <= 1 })
    }

    @Test
    fun theDeviceSettingsInTheJournalNotebookGoThroughGitBothWays() = runBlocking {
        // A1014: with no account, a phone's settings are the Journal notebook's `device/<key>`s.
        val remote = bare()
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Journal") as AddResult.Added
        val engine = phone.engine(added.notebook.localId)
        engine.open(phone.notebooks.entry(added.notebook.localId)!!, "Penmoss for Android (Pixel)", front = false)
        val api = LocalGitApi.api(added.notebook.localId, OkHttpClient(), phone.asks) { engine }
        assertEquals("synced", engine.sync().phase)
        val pins = kotlinx.serialization.json.JsonArray(listOf(kotlinx.serialization.json.JsonPrimitive("01JBN0000000000000000000P1")))
        val changed = api.changeDeviceSettings(
            kotlinx.serialization.json.JsonObject(mapOf("theme.mode" to kotlinx.serialization.json.JsonPrimitive("dark"), "quickAccess.notes" to pins)),
        )
        assertEquals(kotlinx.serialization.json.JsonPrimitive("dark"), changed.device["theme.mode"])
        assertEquals("synced", engine.sync().phase)

        // Another device on the same repository reads them from its tree, and changes one back.
        val other = Phone()
        val joined = other.notebooks.add(GitTestRepos.url(remote), "main", "", "Journal") as AddResult.Added
        val otherEngine = other.engine(joined.notebook.localId)
        otherEngine.open(other.notebooks.entry(joined.notebook.localId)!!, "Penmoss for Android (Tablet)", front = false)
        val otherApi = LocalGitApi.api(joined.notebook.localId, OkHttpClient(), other.asks) { otherEngine }
        assertEquals("synced", otherEngine.sync().phase)
        val read = otherApi.tree(null).device!!
        assertEquals(kotlinx.serialization.json.JsonPrimitive("dark"), read["theme.mode"])
        assertEquals(pins, read["quickAccess.notes"])
        otherApi.changeDeviceSettings(kotlinx.serialization.json.JsonObject(mapOf("theme.mode" to kotlinx.serialization.json.JsonNull)))
        assertEquals("synced", otherEngine.sync().phase)

        assertEquals("synced", engine.sync().phase)
        val back = api.tree(null).device!!
        assertNull(back["theme.mode"])
        assertEquals(pins, back["quickAccess.notes"])
        assertEquals(back, api.deviceSettings().device)
    }

    @Test
    fun aNoteMadeOnThePhoneReachesTheCliAndTheCliSAnswerReachesThePhone() = runBlocking {
        val remote = bare()
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), "main", "", "Work")
        assertTrue(added is AddResult.Added)
        added as AddResult.Added
        assertTrue("a new notebook", added.created)
        // Nobody is asked about the repository (D51, D61).
        assertTrue(words.toString(), words.isEmpty())
        val localId = added.notebook.localId
        val entry = phone.notebooks.entry(localId)!!
        val engine = phone.engine(localId)
        engine.open(entry, "Penmoss for Android (Pixel)", front = false)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val store = InMemorySyncStore()
        val texts = mutableMapOf<String, String>()
        val sync = SyncEngine(api, store) { result: ExchangeResult -> result.text?.let { texts[result.noteId] = it } }

        val note = "01JBN0000000000000000000P1"
        store.addPending(note, NodeGitRunner.note(note, "Plan", "From the phone"))
        sync.sync()
        assertTrue("uploaded and confirmed", store.updates(note, InMemorySyncStore.State.PENDING).isEmpty())
        api.moveNote(note, null, null, null, null)
        assertEquals("synced", engine.sync().phase)
        val counts = GitTestRepos.parentCounts(remote, "main")
        assertTrue("never a merge", counts.all { it <= 1 })
        val head = GitTestRepos.head(remote, "main")!!
        assertTrue(GitTestRepos.message(remote, head).contains("Penmoss-Writer: "))
        assertTrue(GitTestRepos.message(remote, head).contains("(device \"Penmoss for Android (Pixel)\")"))
        assertEquals("Ryan on the Pixel", GitTestRepos.author(remote, head).name)

        // The CLI (the Mac's and the CLI's engine, over system git) reads it.
        val home = temp.newFolder("cli")
        cliAdd(home, remote)
        val read = NodeGitRunner.cli(home, "cat", "Plan", "--notebook", "work", "--body")
        assertEquals(read.stderr, 0, read.code)
        assertTrue(read.stdout, read.stdout.contains("From the phone"))

        // The CLI writes one; the phone's next pull and pass bring it, title and text.
        val made = NodeGitRunner.cli(home, "new", "Groceries", "--text", "Milk and bread", "--notebook", "work", "--json")
        assertEquals(made.stderr, 0, made.code)
        assertEquals("synced", engine.sync().phase)
        sync.sync()
        val groceries = store.notes.values.single { it.title == "Groceries" }
        assertTrue(texts[groceries.id].orEmpty(), texts[groceries.id].orEmpty().contains("Milk and bread"))

        // The phone renames it offline-style (a pending edit on its own copy); the CLI sees it.
        val renamed = NodeGitRunner.retitle(groceries.id, "Shopping", store.updates(groceries.id, InMemorySyncStore.State.SYNCED))
        store.addPending(groceries.id, renamed)
        sync.sync()
        assertEquals("synced", engine.sync().phase)
        val listed = NodeGitRunner.cli(home, "cat", "Shopping", "--notebook", "work", "--body")
        assertEquals(listed.stderr, 0, listed.code)
        assertTrue(listed.stdout.contains("Milk and bread"))
    }

    @Test
    fun deleteForGoodNamesTheNoteFromTheBranchAndAnExpiredConfirmationStopsTheSyncUntilConfirmedAgain() = runBlocking {
        val remote = bare()
        val home = temp.newFolder("cli")
        // The notebook made on the "Mac" (the CLI), joined by the phone.
        val made = NodeGitRunner.cli(home, "notebook", "add", GitTestRepos.url(remote), "--name", "work")
        assertEquals(made.stderr, 0, made.code)
        val note = NodeGitRunner.cli(home, "new", "Budget \u202Egnirts\u2069", "--text", "secret numbers", "--notebook", "work", "--json")
        assertEquals(note.stderr, 0, note.code)
        val noteId = Regex("\"id\":\\s*\"([0-9A-Z]{26})\"").find(note.stdout)!!.groupValues[1]
        val phone = Phone()
        val added = phone.notebooks.add(GitTestRepos.url(remote), null, null, null) as AddResult.Added
        assertFalse(added.created)
        val localId = added.notebook.localId
        val engine = phone.engine(localId)
        engine.open(phone.notebooks.entry(localId)!!, "Penmoss for Android (Pixel)", front = false)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val store = InMemorySyncStore()
        val sync = SyncEngine(api, store)
        engine.sync()
        sync.sync()
        assertNotNull(store.notes[noteId])

        // Refused: nothing is marked.
        confirm = false
        words.clear()
        try {
            api.purgeNote(noteId)
            fail("purged without the owner")
        } catch (error: ApiException) {
            assertEquals(403, error.status)
        }
        // The words name the note as the branch has it, isolated, its bidi controls taken out.
        val asked = words.single()
        assertTrue(asked, asked.startsWith("delete 1 note for good (git history keeps it) in the git notebook at "))
        assertTrue(asked, asked.endsWith(": [\u2068Budget gnirts\u2069]"))
        assertTrue(asked.length <= OwnerWords.MAX)

        // Confirmed, but the sync comes after the confirmation ran out: refused, nothing pushed.
        confirm = true
        api.purgeNote(noteId)
        val before = GitTestRepos.head(remote, "main")
        clock += GitNotebooks.PURGE_TTL_MS + 1
        val stopped = engine.sync()
        assertEquals("stopped", stopped.phase)
        assertEquals(stopped.detail, "purge_unconfirmed", stopped.code)
        assertEquals(before, GitTestRepos.head(remote, "main"))
        val pending = phone.notebooks.purgesToConfirm(localId)
        // Named from the branch, as it is there (Settings cleans it when it shows it).
        assertEquals(listOf(PendingPurge(noteId, "Budget \u202Egnirts\u2069", confirmedBefore = true)), pending)
        // Settings shows it cleaned and isolated, as the owner check names it.
        assertEquals("\u2068Budget gnirts\u2069", OwnerWords.title(pending.single().title))
        // A note never confirmed here can't be confirmed again: Keep note is its way out.
        try {
            phone.notebooks.confirmPurgesAgain(localId, listOf("01JBN0000000000000000000Z9"))
            fail("confirmed a note never confirmed here")
        } catch (error: GitRefusal) {
            assertEquals("never_confirmed", error.code)
        }
        phone.notebooks.confirmPurgesAgain(localId, listOf(noteId))
        assertEquals("synced", engine.sync().phase)
        assertTrue("its confirmation is spent once it landed", phone.notebooks.entry(localId)!!.purges.isEmpty())
        val gone = NodeGitRunner.cli(home, "cat", noteId, "--notebook", "work")
        assertEquals(4, gone.code)
        assertTrue(GitTestRepos.paths(remote, "main").none { it.contains(noteId) })
    }

    @Test
    fun whatAFetchBroughtReachesThePhoneAfterThePageWasKilledBeforeThePhonePulledIt() = runBlocking {
        val remote = bare()
        val home = temp.newFolder("cli")
        cliAdd(home, remote)
        assertEquals(0, NodeGitRunner.cli(home, "new", "First", "--text", "one", "--notebook", "work").code)
        val phone = Phone()
        val localId = (phone.notebooks.add(GitTestRepos.url(remote), null, null, null) as AddResult.Added).notebook.localId
        val state = temp.newFolder("page-state")
        val first = phone.engine(localId, state)
        first.open(phone.notebooks.entry(localId)!!, "Penmoss for Android (Pixel)", front = false)
        assertEquals("synced", first.sync().phase)
        // The CLI writes; the page fetches it, then Android kills the process before Room pulls.
        assertEquals(0, NodeGitRunner.cli(home, "new", "Second", "--text", "two", "--notebook", "work").code)
        assertEquals("synced", first.sync().phase)
        ports.last().kill()
        val second = phone.engine(localId, state)
        val epoch = second.open(phone.notebooks.entry(localId)!!, "Penmoss for Android (Pixel)", front = false)
        assertEquals("the same store: the same epoch", first.epoch, epoch)
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { second }
        val store = InMemorySyncStore()
        SyncEngine(api, store).sync()
        assertEquals(setOf("First", "Second"), store.notes.values.map { it.title }.toSet())
    }

    @Test
    fun aCaptureMadeOfflineGoesToTheInboxOnThePhoneAndReachesTheRepositoryOnceOnline() = runBlocking {
        val remote = bare()
        val home = temp.newFolder("cli")
        cliAdd(home, remote)
        assertEquals(0, NodeGitRunner.cli(home, "new", "First", "--text", "one", "--notebook", "work").code)
        val phone = Phone()
        val localId = (phone.notebooks.add(GitTestRepos.url(remote), null, null, null) as AddResult.Added).notebook.localId
        val engine = phone.engine(localId)
        engine.open(phone.notebooks.entry(localId)!!, "Penmoss for Android (Pixel)", front = false)
        assertEquals("synced", engine.sync().phase)
        // The repository can't be reached (the phone is offline): the capture is kept, never sent anywhere else.
        val away = File(remote.parentFile, "away.git")
        assertTrue(remote.renameTo(away))
        val api = LocalGitApi.api(localId, OkHttpClient(), phone.asks) { engine }
        val reply = api.capture(
            app.penmoss.engine.api.CaptureRequest("cap-1", "Call the plumber\nabout the boiler", app.penmoss.engine.api.CaptureRequest.INBOX, clock, timeZone = "America/Chicago"),
        )
        // Sent twice (a retry after a lost reply): one note.
        assertEquals(reply.noteId, api.capture(app.penmoss.engine.api.CaptureRequest("cap-1", "Call the plumber\nabout the boiler", app.penmoss.engine.api.CaptureRequest.INBOX, clock)).noteId)
        val offline = engine.sync()
        assertTrue(offline.phase, offline.phase == "offline" || offline.phase == "stopped")
        assertTrue(offline.pending.isNotEmpty())
        // Online again: it goes up, filed in the Inbox, and the CLI reads it.
        assertTrue(away.renameTo(remote))
        assertEquals("synced", engine.sync().phase)
        val read = NodeGitRunner.cli(home, "cat", "Call the plumber", "--notebook", "work", "--body")
        assertEquals(read.stderr, 0, read.code)
        assertTrue(read.stdout, read.stdout.contains("about the boiler"))
        val listed = NodeGitRunner.cli(home, "ls", "Inbox", "--notebook", "work")
        assertTrue(listed.stdout + listed.stderr, listed.stdout.contains("Call the plumber"))
    }

    @Test
    fun anyRepositoryIsAddedAndSyncsWithNobodyAsked() = runBlocking {
        val remote = bare()
        GitTestRepos.colleaguePush(remote, "main", mapOf("README.md" to "# hi\n"))
        val phone = Phone()
        // D51, D61: added without asking anyone (the owner check would refuse here), and it syncs.
        confirm = false
        val added = phone.notebooks.add(GitTestRepos.url(remote), null, null, "Work") as AddResult.Added
        assertTrue(words.toString(), words.isEmpty())
        val engine = phone.engine(added.notebook.localId)
        engine.open(phone.notebooks.entry(added.notebook.localId)!!, label, front = false)
        assertEquals("synced", engine.sync().phase)
    }
}
