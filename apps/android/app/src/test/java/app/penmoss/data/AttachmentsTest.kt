package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.engine.api.ApiException
import kotlinx.coroutines.flow.first
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
import java.io.IOException

/** Pictures on the phone (T33, A304): stored by their hash, shown offline, uploaded as the web client does. */
@RunWith(AndroidJUnit4::class)
class AttachmentsTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var db: PenmossDatabase
    private lateinit var dir: File
    private lateinit var cache: File
    private val api = FakeApi()
    private var clock = 1_000L
    private var added = 0
    private lateinit var attachments: Attachments

    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
    private val jpg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 9)
    private val pngSha = Attachments.sha256(png)

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        dir = folder.newFolder("attachments")
        cache = folder.newFolder("cache")
        attachments = Attachments(db.attachments(), dir, cache, api, onAdded = { added++ }, now = { clock })
    }

    @After
    fun close() = db.close()

    @Test
    fun aPictureAddedHereIsStoredByItsHashAndQueued() = runTest {
        val path = attachments.add(png, "n")
        assertEquals("attachments/$pngSha.png", path)
        assertArrayEquals(png, File(dir, "$pngSha.png").readBytes())
        val row = db.attachments().get(pngSha)!!
        assertEquals("n", row.noteId)
        assertTrue(row.local)
        assertFalse(row.uploaded)
        assertEquals(1, added)
        assertEquals(1, attachments.waitingCount())
        // The same bytes again: one file, one row.
        attachments.add(png, "other")
        assertEquals("n", db.attachments().get(pngSha)!!.noteId)
        assertEquals(listOf("$pngSha.png"), dir.list()!!.toList())
    }

    @Test
    fun onlyPicturesOfTheServersTypesAreTaken() = runTest {
        try {
            attachments.add("plain text".toByteArray(), "n")
            fail("Text is not a picture")
        } catch (refused: PictureRefused) {
            assertTrue(refused.message!!.startsWith("Only PNG"))
        }
        assertEquals(0, dir.list()!!.size)
    }

    @Test
    fun thePageIsNotTrustedToNameTheBytes() = runTest {
        assertNull(attachments.addFromPage("attachments/${"0".repeat(64)}.png", png, "n"))
        assertNull(attachments.addFromPage("attachments/$pngSha.jpg", png, "n"))
        assertNull(attachments.addFromPage("../$pngSha.png", png, "n"))
        assertNull(attachments.addFromPage("attachments/$pngSha.svg", png, "n"))
        assertEquals(0, dir.list()!!.size)
        assertEquals("attachments/$pngSha.png", attachments.addFromPage("attachments/$pngSha.png", png, "n"))
        assertTrue(File(dir, "$pngSha.png").isFile)
    }

    @Test
    fun sniffsTheSameTypesAsCore() {
        assertEquals("png", Attachments.sniff(png))
        assertEquals("jpg", Attachments.sniff(jpg))
        assertEquals("gif", Attachments.sniff("GIF89a....".toByteArray()))
        assertEquals("webp", Attachments.sniff("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1)))
        val avif = byteArrayOf(0, 0, 0, 0x18) + "ftypmif1\u0000\u0000\u0000\u0000mif1avif".toByteArray(Charsets.ISO_8859_1)
        assertEquals("avif", Attachments.sniff(avif))
        assertNull(Attachments.sniff("<svg xmlns=".toByteArray()))
        assertNull(Attachments.sniff(ByteArray(0)))
    }

    @Test
    fun showsAPictureFromThePhoneFirstAndFetchesOnlyWhatItLacks() = runTest {
        attachments.add(png, "n")
        assertEquals(File(dir, "$pngSha.png"), attachments.fileFor(pngSha, "png"))
        assertEquals(emptyList<String>(), api.fetched.toList())

        val jpgSha = Attachments.sha256(jpg)
        api.pictures = { jpg }
        val fetched = attachments.fileFor(jpgSha, "jpg")!!
        assertEquals(File(cache, "$jpgSha.jpg"), fetched)
        assertArrayEquals(jpg, fetched.readBytes())
        // Cached: not fetched again.
        attachments.fileFor(jpgSha, "jpg")
        assertEquals(listOf(jpgSha), api.fetched.toList())
    }

    @Test
    fun aPictureThatCannotBeHadIsNotShown() = runTest {
        // Offline.
        assertNull(attachments.fileFor("1".repeat(64), "png"))
        // Bytes that are not what was asked for.
        api.pictures = { png }
        assertNull(attachments.fileFor("2".repeat(64), "png"))
        // Not a picture name at all: never asked.
        assertNull(attachments.fileFor("../etc", "png"))
        assertNull(attachments.fileFor(pngSha, "pdf"))
        assertNull(attachments.fileFor(pngSha, "excalidraw"))
        assertEquals(listOf("1".repeat(64), "2".repeat(64)), api.fetched.toList())
        assertEquals(0, cache.list()!!.size)
    }

    @Test
    fun aDrawingsSvgIsFetchedAndShownOnlyIfItIsAnSvg() = runTest {
        // PEN-28: the note shows a drawing's SVG as a picture.
        val svg = "<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>".toByteArray()
        val svgSha = Attachments.sha256(svg)
        api.pictures = { svg }
        val fetched = attachments.fileFor(svgSha, "svg")!!
        assertEquals(File(cache, "$svgSha.svg"), fetched)
        assertArrayEquals(svg, fetched.readBytes())
        // A PNG asked for as an SVG, and an SVG asked for as a PNG, are neither shown.
        api.pictures = { png }
        assertNull(attachments.fileFor(pngSha, "svg"))
        api.pictures = { svg }
        assertNull(attachments.fileFor(svgSha, "png"))
        assertTrue(Attachments.isSvg("\uFEFF  <svg viewBox=\"0 0 1 1\"/>".toByteArray()))
        assertTrue(Attachments.isSvg("<!-- made by Excalidraw --><svg/>".toByteArray()))
        assertFalse(Attachments.isSvg("<html><svg/></html>".toByteArray()))
        assertFalse(Attachments.isSvg(png))
    }

    @Test
    fun uploadsWhatIsWaitingAndKeepsTheFile() = runTest {
        attachments.add(png, "n")
        assertEquals(1, attachments.uploadDue())
        assertEquals(listOf(pngSha to "n"), api.uploads.toList())
        assertTrue(db.attachments().get(pngSha)!!.uploaded)
        assertEquals(0, attachments.waitingCount())
        // Kept: the note shows it offline.
        assertTrue(File(dir, "$pngSha.png").isFile)
        assertEquals(0, attachments.uploadDue())
    }

    @Test
    fun aRefusalForGoodIsNotRetriedAndABusyServerIsLater() = runTest {
        attachments.add(png, "n")
        attachments.add(jpg, "n")
        val jpgSha = Attachments.sha256(jpg)
        api.onUpload = { sha ->
            if (sha == pngSha) throw ApiException(413, "too_large", "Too large")
            else throw ApiException(429, "rate_limited", "Slow down")
        }
        assertEquals(0, attachments.uploadDue())
        assertTrue(db.attachments().get(pngSha)!!.failed)
        val busy = db.attachments().get(jpgSha)!!
        assertFalse(busy.failed)
        assertTrue(busy.nextAttemptAt > clock)
        // Not due again until its time.
        api.onUpload = {}
        assertEquals(0, attachments.uploadDue())
        clock = busy.nextAttemptAt
        assertEquals(1, attachments.uploadDue())
        assertEquals(listOf(pngSha, jpgSha, jpgSha), api.uploads.map { it.first })
    }

    @Test
    fun aNotFoundIsForGoodSinceTheUploadNeedsNoNoteOnTheServer() = runTest {
        // A device token never gets 404 from PUT /api/attachments (A313): it means the wrong server.
        attachments.add(png, "n")
        api.onUpload = { throw ApiException(404, "not_found", "Not found") }
        assertEquals(0, attachments.uploadDue())
        assertTrue(db.attachments().get(pngSha)!!.failed)
        clock += 86_400_000
        assertEquals(0, attachments.uploadDue())
        assertEquals(1, api.uploads.size)
    }

    @Test
    fun aPictureTheServerKeepsTurningAwayIsGivenUpAfterSomeTries() = runTest {
        attachments.add(png, "n")
        api.onUpload = { throw ApiException(503, "unavailable", "Down") }
        repeat(Attachments.MAX_ATTEMPTS + 5) {
            attachments.uploadDue()
            clock += 3_600_000
        }
        assertEquals(Attachments.MAX_ATTEMPTS, api.uploads.size)
        assertTrue(db.attachments().get(pngSha)!!.failed)
    }

    @Test
    fun aPictureGivenUpOnIsCountedAndRetryStartsItsTriesAgain() = runTest {
        attachments.add(png, "n")
        assertEquals(1, attachments.observeWaiting().first())
        assertEquals(1, attachments.observeWaiting("n").first())
        api.onUpload = { throw ApiException(503, "unavailable", "Down") }
        repeat(Attachments.MAX_ATTEMPTS + 1) {
            attachments.uploadDue()
            clock += 3_600_000
        }
        assertEquals(0, attachments.observeWaiting().first())
        assertEquals(1, attachments.observeFailed().first())
        assertEquals(1, attachments.observeFailed("n").first())
        assertEquals(0, attachments.observeFailed("other").first())

        // Retry (AC8, A428): its tries start again, and the next run uploads it.
        assertEquals(1, attachments.retryFailed())
        assertEquals(0, attachments.observeFailed().first())
        assertEquals(0, db.attachments().get(pngSha)!!.attempts)
        api.onUpload = {}
        assertEquals(1, attachments.uploadDue())
        assertEquals(0, attachments.observeWaiting().first())
    }

    @Test
    fun beingOfflineNeverCountsAgainstAPicture() = runTest {
        attachments.add(png, "n")
        api.onUpload = { throw IOException("offline") }
        repeat(Attachments.MAX_ATTEMPTS + 5) {
            attachments.uploadDue()
            clock += 3_600_000
        }
        val row = db.attachments().get(pngSha)!!
        assertFalse(row.failed)
        assertEquals(0, row.attempts)
        api.onUpload = {}
        assertEquals(1, attachments.uploadDue())
    }

    @Test
    fun showingAPictureNeverThrowsWhenItCannotBeStored() = runTest {
        api.pictures = { jpg }
        // The cache cannot take files (a full disk, or a file where its folder should be).
        cache.deleteRecursively()
        cache.writeText("not a folder")
        assertNull(attachments.fileFor(Attachments.sha256(jpg), "jpg"))
        // And a server that answers with an error.
        api.pictures = { throw ApiException(500, "internal", "Broken") }
        assertNull(attachments.fileFor("3".repeat(64), "png"))
    }

    @Test
    fun twoRequestsForOnePictureFetchItOnce() = runTest {
        val jpgSha = Attachments.sha256(jpg)
        val started = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        api.pictures = {
            started.countDown()
            release.await()
            jpg
        }
        val pool = java.util.concurrent.Executors.newFixedThreadPool(2)
        try {
            val first = pool.submit<File?> { attachments.fileFor(jpgSha, "jpg") }
            started.await()
            val second = pool.submit<File?> { attachments.fileFor(jpgSha, "jpg") }
            Thread.sleep(50)
            release.countDown()
            assertEquals(File(cache, "$jpgSha.jpg"), first.get())
            assertEquals(File(cache, "$jpgSha.jpg"), second.get())
        } finally {
            pool.shutdown()
        }
        assertEquals(listOf(jpgSha), api.fetched.toList())
        // No partial files left behind.
        assertEquals(listOf("$jpgSha.jpg"), cache.list()!!.toList())
    }

    @Test
    fun offlineStopsThePassAndASignedOutDeviceSaysSo() = runTest {
        attachments.add(png, "n")
        clock++
        attachments.add(jpg, "n")
        api.onUpload = { throw IOException("offline") }
        assertEquals(0, attachments.uploadDue())
        assertEquals(1, api.uploads.size)
        clock += 3_600_000
        api.onUpload = { throw ApiException(401, "unauthorized", "Signed out") }
        try {
            attachments.uploadDue()
            fail("A revoked token must reach the sync coordinator")
        } catch (error: ApiException) {
            assertTrue(error.unauthorized)
        }
    }

    @Test
    fun aPictureWhoseFileWentIsNotUploaded() = runTest {
        attachments.add(png, "n")
        File(dir, "$pngSha.png").delete()
        assertEquals(0, attachments.uploadDue())
        assertTrue(db.attachments().get(pngSha)!!.failed)
        assertEquals(emptyList<Pair<String, String?>>(), api.uploads.toList())
    }

    @Test
    fun forgetsEveryFileWhenTheCacheIsCleared() = runTest {
        attachments.add(png, "n")
        api.pictures = { jpg }
        attachments.fileFor(Attachments.sha256(jpg), "jpg")
        attachments.clearFiles()
        assertFalse(dir.exists())
        assertFalse(cache.exists())
        // And works again after.
        attachments.add(jpg, "n")
        assertTrue(File(dir, "${Attachments.sha256(jpg)}.jpg").isFile)
    }
}
