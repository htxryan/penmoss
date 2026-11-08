package app.penmoss

import android.content.Context
import android.content.Intent
import androidx.work.WorkManager
import app.penmoss.auth.SecretBox
import app.penmoss.data.PenmossDatabase
import app.penmoss.editor.NotePages
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.FramePort
import app.penmoss.engine.git.OwnerAnswer
import app.penmoss.engine.git.OwnerConfirm
import app.penmoss.git.GitNotebookActivity
import app.penmoss.git.GitNotebookHub
import app.penmoss.git.GitScheduler
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import java.io.File

/**
 * The graphs the app's screens are tested on since T59 (A1040): the app's own graph, with no
 * notes, and a git notebook's beside it, offline (its notes server unreachable, as a phone in
 * airplane mode). A hub with stand-in pages (no WebView in a JVM test) adds notebooks from bare
 * repositories on the machine.
 */
object TestGraphs {
    /** A reversible box: the Keystore stands in. */
    val box = object : SecretBox {
        override fun seal(plain: ByteArray) = plain

        override fun open(sealed: ByteArray) = sealed
    }

    /** A page that never answers: nothing in these tests waits on one. */
    private val pages = GitNotebookHub.Pages { _, _ ->
        object : FramePort {
            override fun send(frame: ByteArray) = Unit

            override fun listen(listener: (ByteArray) -> Unit) = Unit
        }
    }

    private val owner = OwnerConfirm { OwnerAnswer.Confirmed }

    /** Forgets the git notebooks an earlier test added: their registry, choices and databases. */
    fun forgetNotebooks(context: Context) {
        File(context.filesDir, "git-notebooks").deleteRecursively()
        context.getSharedPreferences(GitNotebookHub.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }

    /**
     * The app's own graph: an in-memory database, the stand-in box, and a hub of stand-in pages
     * whose notebooks' graphs are offline, each on a database from [notebookDatabase].
     */
    fun app(
        context: Context,
        notePages: NotePages = NotePages.Editor,
        notebookDatabase: () -> PenmossDatabase = { PenmossDatabase.inMemory(context) },
    ): AppGraph = AppGraph(
        context,
        database = PenmossDatabase.inMemory(context),
        box = box,
        notePages = notePages,
        gitOwner = owner,
        makeHub = { main ->
            GitNotebookHub(
                context,
                main = { main },
                box = box,
                owner = owner,
                pages = pages,
                scheduler = GitScheduler { WorkManager.getInstance(context) },
                signingKeys = null,
                makeGraph = { localId, notebookId, name ->
                    AppGraph.forGit(context, main, notebookDatabase(), localId, notebookId, name, offline())
                },
            )
        },
    )

    /** A git notebook's graph beside [main], offline, with a database of its own in memory. */
    fun notebook(context: Context, main: AppGraph, name: String = "Notes"): AppGraph = AppGraph.forGit(
        context,
        main,
        PenmossDatabase.inMemory(context),
        localId = "local-test",
        notebookId = "01JBN00000000000000000TEST",
        name = name,
        api = offline(),
    )

    /** A notes server nothing answers at, as a phone in airplane mode. */
    private fun offline() = HttpPenmossApi("http://127.0.0.1:9/", OkHttpClient())

    /** The intent that opens notebook [localId]'s screens, with [note] to open in it. */
    fun opening(context: Context, localId: String, note: String? = null): Intent =
        Intent(context, GitNotebookActivity::class.java)
            .putExtra(GitNotebookActivity.EXTRA_LOCAL_ID, localId)
            .apply { if (note != null) putExtra(GitNotebookActivity.EXTRA_NOTE, note) }

    /** Adds a git notebook named [name] to [main]'s hub, from a new bare repository; its local id. */
    fun addNotebook(context: Context, main: AppGraph, name: String): String = runBlocking {
        val dir = File(context.cacheDir, "remote-${System.nanoTime()}.git")
        val made = ProcessBuilder("git", "init", "--bare", "--initial-branch=main", dir.absolutePath).redirectErrorStream(true).start()
        assertEquals(made.inputStream.readBytes().toString(Charsets.UTF_8), 0, made.waitFor())
        (main.git.add("file://${dir.absolutePath}", null, null, name, null) as AddResult.Added).notebook.localId
    }
}
