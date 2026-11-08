package app.penmoss.git

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import app.penmoss.auth.SecretBox
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.FramePort
import app.penmoss.engine.git.GitRefusal
import app.penmoss.engine.git.OwnerAnswer
import app.penmoss.engine.git.OwnerConfirm
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The app's git notebooks (T50 G7, G8; A827, A855, A856): adding one asks the person (a
 * repository on this phone can't be checked), sealing what is secret; the Journal notebook;
 * Remove asks first and leaves nothing behind; a capture stored schedules a run.
 */
@RunWith(AndroidJUnit4::class)
class GitNotebookHubTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val asked = mutableListOf<String>()
    private var confirm = true
    private val opened = mutableListOf<String>()
    private lateinit var workManager: WorkManager

    /** The Keystore stands in as a reversible box; what is sealed must not be the plain text. */
    private val box = object : SecretBox {
        override fun seal(plain: ByteArray) = plain.reversedArray() + byteArrayOf(7)

        override fun open(sealed: ByteArray) = sealed.copyOf(sealed.size - 1).reversedArray()
    }

    private val owner = OwnerConfirm { words ->
        asked += words
        if (confirm) OwnerAnswer.Confirmed else OwnerAnswer.Refused("this phone did not confirm it was you.")
    }

    /** No WebView in a JVM test: a page that never answers (its calls time out; none is awaited here). */
    private val pages = GitNotebookHub.Pages { role, _ ->
        opened += role
        object : FramePort {
            override fun send(frame: ByteArray) = Unit

            override fun listen(listener: (ByteArray) -> Unit) = Unit
        }
    }

    private lateinit var hub: GitNotebookHub

    @Before
    fun setUp() {
        File(context.filesDir, "git-notebooks").deleteRecursively()
        context.getSharedPreferences(GitNotebookHub.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        workManager = WorkManager.getInstance(context)
        hub = GitNotebookHub(
            context,
            main = { error("no graph in this test") },
            box = box,
            owner = owner,
            pages = pages,
            scheduler = GitScheduler { workManager },
        )
    }

    @After
    fun tearDown() {
        File(context.filesDir, "git-notebooks").deleteRecursively()
    }

    private fun bare(): File {
        val dir = File(context.cacheDir, "remote-${System.nanoTime()}.git")
        val made = ProcessBuilder("git", "init", "--bare", "--initial-branch=main", dir.absolutePath).redirectErrorStream(true).start()
        assertEquals(made.inputStream.readBytes().toString(Charsets.UTF_8), 0, made.waitFor())
        return dir
    }

    @Test
    fun aRepositoryOnThisPhoneIsAddedWithoutAskingAnyoneAndItsTokenIsSealed() = runBlocking {
        val remote = bare()
        val url = "file://${remote.absolutePath}"
        assertFalse(GitNotebookHub.anyEver(context) && hub.notebooks.entries().isNotEmpty())
        // D51, D61: nobody is asked to confirm the repository private (the owner check would
        // refuse here).
        confirm = false
        val added = hub.add(url, null, null, "Work", "ghp_example_token_1234567890") as AddResult.Added
        assertTrue(added.created)
        assertTrue(asked.toString(), asked.isEmpty())
        confirm = true
        // Written sealed, never as typed (A857).
        val files = File(context.filesDir, "git-notebooks").walkTopDown().filter { it.isFile && it.extension == "json" }.toList()
        assertTrue(files.isNotEmpty())
        for (file in files) assertFalse(file.name, file.readText().contains("ghp_example_token_1234567890"))
        assertTrue(hub.list.value.isEmpty() || hub.list.value.single().hasToken)
        assertTrue(GitNotebookHub.anyEver(context))
        // The background runs start with the first notebook.
        hub.scheduleWork()
        waitFor { workManager.getWorkInfosForUniqueWork(GitScheduler.PERIODIC).get().any { it.state == WorkInfo.State.ENQUEUED } }
    }

    @Test
    fun theJournalNotebookIsTheFirstGitNotebookUnlessPicked() = runBlocking {
        // None on the phone: no Journal notebook (A1040).
        assertNull(hub.journal())
        val first = (hub.add("file://${bare().absolutePath}", null, null, "Work", null) as AddResult.Added).notebook.localId
        val second = (hub.add("file://${bare().absolutePath}", null, null, "Home", null) as AddResult.Added).notebook.localId
        assertEquals(first, hub.journal())
        hub.setJournal(second)
        assertEquals(second, hub.journal())
        assertEquals(second, hub.journalPicked())
        // A pick of the personal notes, kept from before T59: the first git notebook (A1040).
        context.getSharedPreferences(GitNotebookHub.PREFS, Context.MODE_PRIVATE).edit().putString("journalNotebook", "personal").commit()
        assertEquals(first, hub.journal())
    }

    @Test
    fun aNoteLinkOpensInTheNotebookThatHoldsTheNoteElseTheJournalNotebook() = runBlocking {
        val note = "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"
        assertNull(hub.notebookOfNote(note))
        val first = (hub.add("file://${bare().absolutePath}", null, null, "Work", null) as AddResult.Added).notebook.localId
        val second = (hub.add("file://${bare().absolutePath}", null, null, "Home", null) as AddResult.Added).notebook.localId
        // In no notebook yet: the Journal notebook.
        assertEquals(first, hub.notebookOfNote(note))
        // In the second's Room cache, its graph not made: read from its file.
        val db = app.penmoss.data.PenmossDatabase.open(context, GitNotebookHub.databaseName(second))
        db.notes().insert(app.penmoss.data.NoteEntity(note, title = "Garden"))
        db.close()
        assertEquals(second, hub.notebookOfNote(note))
    }

    @Test
    fun whatACommitAndThePageCallThisPhone() {
        assertEquals("Penmoss for Android (Pixel 9)", GitNotebookHub.deviceLabel(" Pixel 9 "))
        assertEquals("Penmoss for Android", GitNotebookHub.deviceLabel(""))
        assertEquals(80, GitNotebookHub.deviceLabel("x".repeat(200)).length)
    }

    @Test
    fun removeAsksFirstSaysChangesMayBeLostAndLeavesNothingBehind() = runBlocking {
        val id = (hub.add("file://${bare().absolutePath}", null, null, "Work", "ghp_example_token_1234567890") as AddResult.Added).notebook.localId
        context.getSharedPreferences("git.$id.penmoss.session", Context.MODE_PRIVATE).edit().putString("x", "y").commit()
        confirm = false
        try {
            hub.remove(id)
            fail("removed without the person")
        } catch (refused: GitRefusal) {
            assertEquals("not_confirmed", refused.code)
        }
        assertEquals(listOf(id), hub.notebooks.entries().map { it.localId })
        confirm = true
        asked.clear()
        hub.remove(id)
        assertTrue(asked.single(), asked.single().startsWith("remove the git notebook at "))
        assertTrue(asked.single(), asked.single().endsWith(" from this phone and lose any changes not pushed yet"))
        assertTrue(hub.notebooks.entries().isEmpty())
        assertFalse(hub.notebooks.cloneDir(id).exists())
        assertFalse(context.getDatabasePath(GitNotebookHub.databaseName(id)).exists())
        assertTrue(context.getSharedPreferences("git.$id.penmoss.session", Context.MODE_PRIVATE).all.isEmpty())
        // Its page was opened only to delete its store.
        assertEquals(listOf("engine"), opened.filter { it == "engine" }.distinct())
    }

    @Test
    fun aGitIdentityIsCheckedAndTheDevicesNameStandsInWithoutOne() {
        assertTrue(hub.identity().name.startsWith("Penmoss for Android"))
        hub.setIdentity("Ryan Henderson", "ryan@example.invalid")
        assertEquals("Ryan Henderson", hub.identity().name)
        assertEquals("ryan@example.invalid", hub.identity().email)
        for ((name, email) in listOf("Ryan" to "not an email", "Ryan <x>" to "ryan@example.invalid")) {
            try {
                hub.setIdentity(name, email)
                fail("took $name / $email")
            } catch (expected: IllegalArgumentException) {
                // Refused.
            }
        }
        assertNotEquals("Ryan <x>", hub.identity().name)
    }

    @Test
    fun aCaptureStoredForAGitNotebookSchedulesARunSoon() {
        hub.storedForLater()
        val soon = workManager.getWorkInfosForUniqueWork(GitScheduler.SOON).get()
        assertEquals(1, soon.size)
        assertTrue(soon.single().tags.contains(GitScheduler.TAG))
    }

    private fun waitFor(condition: () -> Boolean) {
        val until = System.currentTimeMillis() + 10_000
        while (!condition()) {
            if (System.currentTimeMillis() > until) fail("never happened")
            Thread.sleep(20)
        }
    }
}
