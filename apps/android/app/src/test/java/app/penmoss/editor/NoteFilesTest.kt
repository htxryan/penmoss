package app.penmoss.editor

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.Zeros
import app.penmoss.data.Attachments
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.FileAction
import app.penmoss.engine.bridge.FileRef
import app.penmoss.engine.bridge.FromEditor
import app.penmoss.engine.bridge.ParityFromEditor
import app.penmoss.engine.bridge.ParityToEditor
import app.penmoss.engine.bridge.StoredFile
import app.penmoss.engine.bridge.ToEditor
import app.penmoss.engine.bridge.WebPictureMode
import app.penmoss.stopScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Files in the open note from the app's side (T40 P8, ED12), with the page played by the test:
 * a pasted file and its bytes, a chip's size and type, Open and Save a copy, the document
 * picker's files; and how pictures from web addresses show (ED13), sent before each open.
 */
@RunWith(AndroidJUnit4::class)
class NoteFilesTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var attachments: Attachments
    private val api = FakeApi()
    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private val sent = CopyOnWriteArrayList<ToEditor>()
    private val sync = NoteEditorControllerTest.FakeSync()
    private var mode = WebPictureMode.WAIT

    private val csv = "a,b\n1,2\n".toByteArray()
    private val csvPath = "attachments/${Attachments.sha256(csv)}.csv"
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), PenmossDatabase::class.java).build()
        store = NoteStore(db)
        attachments = Attachments(db.attachments(), folder.newFolder("files"), folder.newFolder("cache"), api)
        runBlocking { db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "S1")) }
    }

    @After
    fun close() {
        // Its work ends before the dispatcher and the database close (A690).
        stopScope(scope)
        thread.close()
        db.close()
    }

    private fun controller(withFiles: Boolean = true) = NoteEditorController(
        "n",
        store,
        sync,
        scope,
        send = { sent += BridgeProtocol.decodeToEditor(it)!! },
        onOpenNote = {},
        pollMs = 60_000,
        pictures = attachments,
        files = if (withFiles) attachments else null,
        webPictures = if (withFiles) ({ mode }) else null,
    )

    private fun page(controller: NoteEditorController, message: FromEditor) = runBlocking(thread) {
        controller.onPageMessage(BridgeProtocol.encode(message))
    }

    private fun bytes(controller: NoteEditorController, bytes: ByteArray) = runBlocking(thread) { controller.onPageBytes(bytes) }

    private fun waitFor(condition: () -> Boolean) = runBlocking {
        withTimeout(5_000) { while (!condition()) kotlinx.coroutines.delay(10) }
    }

    private fun opened(withFiles: Boolean = true): NoteEditorController {
        val controller = controller(withFiles)
        page(controller, FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Open } }
        runBlocking(thread) {}
        page(controller, FromEditor.Opened("n", "Note", null, null))
        return controller
    }

    @Test
    fun tellsThePageHowWebPicturesShowRightBeforeEachOpen() {
        val controller = opened()
        val open = sent.indexOfFirst { it is ToEditor.Open }
        assertEquals(ParityToEditor.WebPictures("n", WebPictureMode.WAIT), sent[open - 1])
        // On Wi-Fi now: the next open says so.
        mode = WebPictureMode.ON
        sent.clear()
        page(controller, FromEditor.Ready)
        waitFor { sent.any { it is ToEditor.Open } }
        assertEquals(ParityToEditor.WebPictures("n", WebPictureMode.ON), sent.first { it is ParityToEditor.WebPictures })
    }

    @Test
    fun sendsNothingAboutWebPicturesWithoutTheSetting() {
        opened(withFiles = false)
        assertTrue(sent.none { it is ParityToEditor.WebPictures })
    }

    @Test
    fun storesAPastedFileAndItsBytesBeforeThePageInsertsIt() {
        val controller = opened()
        page(controller, ParityFromEditor.File("n", csvPath, "Budget.csv", csv.size.toLong()))
        bytes(controller, csv)
        waitFor { sent.any { it is ParityToEditor.FileStored } }
        assertEquals(ParityToEditor.FileStored("n", csvPath, true), sent.filterIsInstance<ParityToEditor.FileStored>().single())
        assertEquals(StoredFile(csv.size.toLong(), "application/octet-stream"), runBlocking { attachments.info(csvPath) })
        // A picture's bytes after a file's message are still a picture's.
        val pngPath = "attachments/${Attachments.sha256(png)}.png"
        page(controller, FromEditor.Attachment("n", pngPath, png.size.toLong()))
        bytes(controller, png)
        waitFor { sent.any { it is ToEditor.AttachmentStored } }
        assertEquals(ToEditor.AttachmentStored("n", pngPath, true), sent.filterIsInstance<ToEditor.AttachmentStored>().single())
    }

    @Test
    fun refusesBytesThatAreNotWhatTheFilesMessageSaid() {
        val controller = opened()
        page(controller, ParityFromEditor.File("n", csvPath, "Budget.csv", csv.size + 1L))
        bytes(controller, csv)
        page(controller, ParityFromEditor.File("n", "attachments/${"0".repeat(64)}.csv", "Budget.csv", csv.size.toLong()))
        bytes(controller, csv)
        waitFor { sent.count { it is ParityToEditor.FileStored } == 2 }
        assertTrue(sent.filterIsInstance<ParityToEditor.FileStored>().none { it.ok })
        assertNull(runBlocking { attachments.info(csvPath) })
        // Without file storage, the file is refused at once.
        val bare = opened(withFiles = false)
        sent.clear()
        page(bare, ParityFromEditor.File("n", csvPath, "Budget.csv", csv.size.toLong()))
        bytes(bare, csv)
        assertEquals(listOf(ParityToEditor.FileStored("n", csvPath, false)), sent.filterIsInstance<ParityToEditor.FileStored>())
    }

    @Test
    fun answersAChipsSizeAndTypeFromThePhone() {
        val controller = opened()
        runBlocking { attachments.addFile(csv.inputStream(), "a.csv", "n") }
        page(controller, ParityFromEditor.FileInfo("n", csvPath))
        page(controller, ParityFromEditor.FileInfo("n", "attachments/${"1".repeat(64)}.pdf"))
        waitFor { sent.count { it is ParityToEditor.FileInfo } == 2 }
        // Each is answered as soon as it is known, in either order.
        assertEquals(
            setOf(
                ParityToEditor.FileInfo("n", csvPath, StoredFile(csv.size.toLong(), "application/octet-stream")),
                ParityToEditor.FileInfo("n", "attachments/${"1".repeat(64)}.pdf", null),
            ),
            sent.filterIsInstance<ParityToEditor.FileInfo>().toSet(),
        )
    }

    @Test
    fun handsAChipsOpenAndSaveACopyToTheScreen() {
        val controller = opened()
        val requests = scope.async(start = CoroutineStart.UNDISPATCHED) { controller.files.requests.first() }
        page(controller, ParityFromEditor.OpenFile("n", csvPath, "Budget.csv", FileAction.SAVE))
        assertEquals(FileRequest(csvPath, "Budget.csv", FileAction.SAVE), runBlocking { requests.await() })
        // Another note's chip is not this note's.
        val other = scope.async(start = CoroutineStart.UNDISPATCHED) { withTimeout(200) { controller.files.requests.first() } }
        page(controller, ParityFromEditor.OpenFile("other", csvPath, "x", FileAction.OPEN))
        assertTrue(runCatching { runBlocking { other.await() } }.isFailure)
    }

    @Test
    fun storesPickedFilesFirstThenInsertsThem() {
        val controller = opened()
        runBlocking {
            controller.files.insertPicked(listOf(PickedFile("Budget.csv") { csv.inputStream() }, PickedFile("photo.png") { png.inputStream() }, PickedFile("huge.zip") { Zeros(Attachments.MAX_BYTES + 1L) }))
        }
        val pngPath = "attachments/${Attachments.sha256(png)}.png"
        assertEquals(
            listOf(ParityToEditor.InsertFiles("n", listOf(FileRef(csvPath, "Budget.csv"), FileRef(pngPath, "photo.png")))),
            sent.filterIsInstance<ParityToEditor.InsertFiles>(),
        )
        assertArrayEquals(csv, runBlocking { attachments.document(csvPath) }!!.readBytes())
        val notices = scope.async(start = CoroutineStart.UNDISPATCHED) { controller.notices.first() }
        runBlocking { controller.files.insertPicked(listOf(PickedFile("huge.zip") { Zeros(Attachments.MAX_BYTES + 1L) })) }
        assertEquals("“huge.zip” is over 50 MB, the largest file Penmoss stores", runBlocking { notices.await() })
    }

    @Test
    fun readsPickedFilesOneAtATimeEachStoredBeforeTheNextIsOpened() {
        // Review PS1: never every picked file in memory at once.
        val controller = opened()
        val opens = mutableListOf<String>()
        val csvFile = java.io.File(folder.root, "files/${Attachments.sha256(csv)}.csv")
        runBlocking {
            controller.files.insertPicked(
                listOf(
                    PickedFile("Budget.csv") { opens += "csv"; csv.inputStream() },
                    PickedFile("photo.png") {
                        // The file before is stored already when this one is opened.
                        opens += if (csvFile.isFile) "png after csv stored" else "png before csv stored"
                        png.inputStream()
                    },
                    PickedFile("gone.pdf") { null },
                ),
            )
        }
        assertEquals(listOf("csv", "png after csv stored"), opens)
        assertEquals(2, sent.filterIsInstance<ParityToEditor.InsertFiles>().single().files.size)
    }

    @Test
    fun saysWhichPickedFileCouldNotBeRead() {
        val controller = opened()
        val notices = scope.async(start = CoroutineStart.UNDISPATCHED) { controller.notices.first() }
        runBlocking { controller.files.insertPicked(listOf(PickedFile("gone.pdf") { throw SecurityException("no grant") })) }
        assertEquals("“gone.pdf” could not be read.", runBlocking { notices.await() })
        assertTrue(sent.none { it is ParityToEditor.InsertFiles })
    }

    @Test
    fun filesPickedWhileThePageReloadsGoInOnceTheNoteShows() {
        val controller = opened()
        page(controller, FromEditor.Ready)
        runBlocking { controller.files.insertPicked(listOf(PickedFile("Budget.csv") { csv.inputStream() })) }
        waitFor { sent.count { it is ToEditor.Open } == 2 }
        runBlocking(thread) {}
        assertTrue(sent.none { it is ParityToEditor.InsertFiles })
        page(controller, FromEditor.Opened("n", "Note", null, null))
        assertEquals(listOf(ParityToEditor.InsertFiles("n", listOf(FileRef(csvPath, "Budget.csv")))), sent.filterIsInstance<ParityToEditor.InsertFiles>())
    }
}
