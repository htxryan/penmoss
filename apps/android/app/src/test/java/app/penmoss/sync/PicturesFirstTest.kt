package app.penmoss.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.data.Attachments
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.editor.OpenEditors
import app.penmoss.engine.api.BatchEntry
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.BatchReply
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * A note's pictures reach the server before the note that names them (review
 * S3, A313), on a whole pass and on a note's own exchange after an edit, with
 * the app's own sync wiring ([PassWork]).
 */
@RunWith(AndroidJUnit4::class)
class PicturesFirstTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val calls = CopyOnWriteArrayList<String>()
    private val api = object : FakeApi() {
        override suspend fun tree(since: String?) = SyncTree(hash = "h").also { calls += "tree" }

        override suspend fun changes(since: Long) = ChangesPage(1).also { calls += "changes" }

        override suspend fun batch(notes: List<BatchEntry>): BatchReply {
            calls += "batch:" + notes.joinToString(",") { it.id }
            return BatchReply(notes.map { BatchNoteReply(it.id, "e1", "", "SV", null) })
        }
    }
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var attachments: Attachments
    private lateinit var sync: SyncCoordinator
    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)

    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7)

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db)
        api.onUpload = { calls += "picture" }
        attachments = Attachments(db.attachments(), folder.newFolder("a"), folder.newFolder("c"), api)
        val work = PassWork(store, attachments, NoteFiler(store, api), OpenEditors())
        val engine = SyncEngine(api, store) {}
        sync = SyncCoordinator(
            scope,
            engine = { engine },
            beforePass = work::beforePass,
            afterPass = work::afterPass,
            beforeNote = work::beforeNote,
        )
    }

    @After
    fun close() {
        // Whatever the scope still runs ends before the database closes.
        runBlocking { withTimeout(5_000) { scope.coroutineContext.job.cancelAndJoin() } }
        thread.close()
        db.close()
    }

    @Test
    fun aNotesOwnExchangeSendsItsPictureFirst() = runBlocking {
        attachments.add(png, "n")
        store.addPending("n", "EDIT-NAMING-THE-PICTURE", null)
        sync.syncNote("n")
        assertEquals(listOf("picture", "batch:n"), calls.toList())
    }

    @Test
    fun aPassSendsPicturesBeforeAnyNote() = runBlocking {
        attachments.add(png, "n")
        store.addPending("n", "EDIT-NAMING-THE-PICTURE", null)
        sync.start()
        sync.setForeground(true)
        withTimeout(5_000) { while (calls.none { it.startsWith("batch") }) delay(10) }
        assertEquals(listOf("picture", "tree", "changes", "batch:n"), calls.toList())
    }
}
