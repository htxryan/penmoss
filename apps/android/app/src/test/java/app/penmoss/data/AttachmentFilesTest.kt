package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.Zeros
import app.penmoss.engine.bridge.StoredFile
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File

/**
 * Files other than pictures on the phone (T40 P8, ED12): stored, checked, uploaded and fetched
 * as pictures are (A304, A311, A313), with the web's names (core's `filePath`) and the server's
 * types.
 */
@RunWith(AndroidJUnit4::class)
class AttachmentFilesTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var db: PenmossDatabase
    private lateinit var dir: File
    private lateinit var cache: File
    private val api = FakeApi()
    private lateinit var attachments: Attachments

    private val pdf = "%PDF-1.7\nhello".toByteArray()
    private val csv = "a,b\n1,2\n".toByteArray()
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
    private val pdfSha = Attachments.sha256(pdf)
    private val csvSha = Attachments.sha256(csv)

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        dir = folder.newFolder("attachments")
        cache = folder.newFolder("cache")
        attachments = Attachments(db.attachments(), dir, cache, api, now = { 1_000L })
    }

    @After
    fun close() = db.close()

    @Test
    fun namesAFileAsTheWebDoes() {
        // A picture or a PDF by its bytes; anything else by its name, lower-cased, or `bin`.
        assertEquals("pdf", Attachments.extensionFor(pdf, "report.txt"))
        assertEquals("png", Attachments.extensionFor(png, "photo.jpeg"))
        assertEquals("csv", Attachments.extensionFor(csv, "Budget.CSV"))
        assertEquals("bin", Attachments.extensionFor(csv, "Makefile"))
        assertEquals("bin", Attachments.extensionFor(csv, "archive.toolongextension"))
        // Named like a picture, but not one: kept under its name's extension, as core does.
        assertEquals("png", Attachments.extensionFor(csv, "fake.png"))
        assertEquals("application/pdf", Attachments.typeOf("pdf"))
        assertEquals("image/jpeg", Attachments.typeOf("jpg"))
        assertEquals("application/octet-stream", Attachments.typeOf("csv"))
    }

    @Test
    fun storesAPickedFileAndUploadsItWithItsExtension() = runTest {
        assertEquals("attachments/$csvSha.csv", attachments.addFile(csv.inputStream(), "Budget.CSV", "n"))
        assertEquals("attachments/$pdfSha.pdf", attachments.addFile(pdf.inputStream(), "Lease", "n"))
        assertArrayEquals(csv, File(dir, "$csvSha.csv").readBytes())
        assertEquals(2, attachments.waitingCount())

        assertEquals(2, attachments.uploadDue())
        // The server takes a PDF's extension from its bytes; any other file names its own (T13).
        assertEquals(mapOf(csvSha to "csv", pdfSha to null), api.uploadExts.toMap())
        assertEquals(listOf(csvSha to "n", pdfSha to "n"), api.uploads.sortedBy { it.first != csvSha })
    }

    @Test
    fun aPictureUploadsWithNoExtension() = runTest {
        attachments.add(png, "n")
        attachments.uploadDue()
        assertEquals(listOf(Attachments.sha256(png) to null), api.uploadExts.toList())
    }

    @Test
    fun refusesAFileOver50MegabytesSayingWhich() = runTest {
        try {
            attachments.addFile(Zeros(Attachments.MAX_BYTES + 1L), "huge.zip", "n")
            fail("stored")
        } catch (refused: PictureRefused) {
            assertEquals("“huge.zip” is over 50 MB, the largest file Penmoss stores", refused.message)
        }
        assertEquals(0, attachments.waitingCount())
    }

    @Test
    fun aPickedFileIsStreamedThroughItsHashToDiskLeavingNoPartFile() = runTest {
        // Review PS1: read a piece at a time, never as one 50 MB array.
        val input = Zeros(Attachments.MAX_BYTES.toLong())
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val piece = ByteArray(64 * 1024)
        repeat(Attachments.MAX_BYTES / piece.size) { digest.update(piece) }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        assertEquals("attachments/$sha.bin", attachments.addFile(input, "zeros", "n"))
        assertTrue(input.largestRead <= 64 * 1024)
        assertEquals(Attachments.MAX_BYTES.toLong(), File(dir, "$sha.bin").length())
        assertEquals(StoredFile(Attachments.MAX_BYTES.toLong(), "application/octet-stream"), attachments.info("attachments/$sha.bin"))
        runCatching { attachments.addFile(Zeros(Attachments.MAX_BYTES + 1L), "huge.zip", "n") }
        assertEquals(listOf("$sha.bin"), dir.list()!!.toList())
    }

    @Test
    fun anUploadCutShortCountsAsAnAttemptWhereOfflineDoesNot() = runTest {
        // Review PS2: a slow uplink's timeout is an attempt, so it is not sent again for ever.
        attachments.addFile(csv.inputStream(), "a.csv", "n")
        api.onUpload = { throw app.penmoss.engine.api.UploadInterrupted(java.io.InterruptedIOException("timeout")) }
        assertEquals(0, attachments.uploadDue())
        assertEquals(1, db.attachments().get(csvSha)!!.attempts)
        db.attachments().retry(csvSha)
        api.onUpload = { throw java.net.ConnectException("offline") }
        assertEquals(0, attachments.uploadDue())
        assertEquals(0, db.attachments().get(csvSha)!!.attempts)
    }

    @Test
    fun aLargeFileUploadsOnWiFiOnly() = runTest {
        // Review PS2: not 10 MB and more over mobile data.
        var metered = true
        val graph = Attachments(db.attachments(), dir, cache, api, now = { 1_000L }, metered = { metered })
        val large = graph.addFile(Zeros(Attachments.LARGE_UPLOAD + 1), "scan.tiff", "n").removePrefix("attachments/").substringBefore('.')
        graph.addFile(csv.inputStream(), "a.csv", "n")
        assertEquals(1, graph.uploadDue())
        assertEquals(listOf(csvSha), api.uploads.map { it.first })
        assertEquals(0, db.attachments().get(large)!!.attempts)
        metered = false
        assertEquals(1, graph.uploadDue())
        assertEquals(listOf(csvSha, large), api.uploads.map { it.first })
    }

    @Test
    fun asksTheServerOnceForTheSizeOfAFileAddedElsewhere() = runTest {
        // Review PS3: as the web's chips do, by HEAD; nothing known stays unknown.
        val elsewhere = "e".repeat(64)
        api.sizes = { if (it == elsewhere) 2048L else null }
        assertEquals(StoredFile(2048, "application/pdf"), attachments.info("attachments/$elsewhere.pdf"))
        assertEquals(StoredFile(2048, "application/pdf"), attachments.info("attachments/$elsewhere.pdf"))
        assertEquals(listOf(elsewhere), api.sizeAsks.toList())
        assertNull(attachments.info("attachments/${"f".repeat(64)}.csv"))
        // Offline: no size, and no exception.
        api.sizes = { throw java.io.IOException("offline") }
        assertNull(attachments.info("attachments/${"d".repeat(64)}.csv"))
    }

    @Test
    fun thePageIsNotTrustedToNameAFile() = runTest {
        // The path must be what the bytes and the name give.
        assertEquals("attachments/$csvSha.csv", attachments.addFileFromPage("attachments/$csvSha.csv", "a.csv", csv, "n"))
        assertNull(attachments.addFileFromPage("attachments/$csvSha.txt", "a.csv", csv, "n"))
        assertNull(attachments.addFileFromPage("attachments/${"0".repeat(64)}.csv", "a.csv", csv, "n"))
        // Bytes that are a PDF are stored as one, whatever the page called them.
        assertNull(attachments.addFileFromPage("attachments/$pdfSha.doc", "a.doc", pdf, "n"))
        assertNull(attachments.addFileFromPage("../attachments/$csvSha.csv", "a.csv", csv, "n"))
        assertEquals(listOf("$csvSha.csv"), dir.list()!!.toList())
    }

    @Test
    fun saysAFilesSizeAndTypeFromThePhonesOwnRecord() = runTest {
        attachments.addFile(pdf.inputStream(), "Lease.pdf", "n")
        assertEquals(StoredFile(pdf.size.toLong(), "application/pdf"), attachments.info("attachments/$pdfSha.pdf"))
        // Another extension is another file; one the phone never had is unknown.
        assertNull(attachments.info("attachments/$pdfSha.csv"))
        assertNull(attachments.info("attachments/$csvSha.csv"))
        assertNull(attachments.info("attachments/x.pdf"))
    }

    @Test
    fun readsAFileFromThePhoneFirstAndFetchesOnlyWhatItLacks() = runTest {
        attachments.addFile(csv.inputStream(), "a.csv", "n")
        assertArrayEquals(csv, attachments.document("attachments/$csvSha.csv")!!.readBytes())
        assertTrue(api.fetched.isEmpty())

        api.pictures = { pdf }
        val fetched = attachments.document("attachments/$pdfSha.pdf")!!
        assertArrayEquals(pdf, fetched.readBytes())
        assertEquals(listOf(pdfSha), api.fetched.toList())
        // Known from then on, and not fetched again.
        assertEquals(StoredFile(pdf.size.toLong(), "application/pdf"), attachments.info("attachments/$pdfSha.pdf"))
        attachments.document("attachments/$pdfSha.pdf")
        assertEquals(1, api.fetched.size)
    }

    @Test
    fun aFetchedFileMustBeWhatItsPathNames() = runTest {
        // Other bytes than the hash, or a "PDF" that is not one: no file, and nothing kept.
        api.pictures = { csv }
        assertNull(attachments.document("attachments/$pdfSha.pdf"))
        val sha = Attachments.sha256(csv)
        assertNull(attachments.document("attachments/$sha.pdf"))
        assertNull(attachments.document("attachments/$sha.png"))
        assertEquals(sha, Attachments.sha256(attachments.document("attachments/$sha.csv")!!.readBytes()))
        // Offline: no file, never an exception.
        api.pictures = { throw java.io.IOException("offline") }
        assertNull(attachments.document("attachments/${"9".repeat(64)}.zip"))
        assertFalse(File(cache, "$pdfSha.pdf").exists())
    }

    @Test
    fun countsTheSpaceFilesTakeOnThePhone() = runTest {
        assertEquals(0L, attachments.bytesUsed())
        attachments.addFile(csv.inputStream(), "a.csv", "n")
        api.pictures = { pdf }
        attachments.document("attachments/$pdfSha.pdf")
        assertEquals((csv.size + pdf.size).toLong(), attachments.bytesUsed())
    }
}
