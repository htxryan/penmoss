package app.penmoss.capture

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.FakeApi
import app.penmoss.data.Attachments
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.editor.OpenEditors
import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.BatchEntry
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.BatchReply
import app.penmoss.engine.api.CaptureRequest
import app.penmoss.engine.api.CaptureSetting
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.sync.SyncEngine
import app.penmoss.sync.NoteFiler
import app.penmoss.sync.PassWork
import app.penmoss.sync.SyncCoordinator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Captures on the phone (T34, A335–A338): saved in Room at once, offline too;
 * sent after their pictures, before the pass reads what changed; the same id
 * on every try; refused ones kept.
 */
@RunWith(AndroidJUnit4::class)
class CapturesTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val calls = CopyOnWriteArrayList<String>()
    private var clock = 1_760_986_000_000L
    private var ids = 0
    private val api = object : FakeApi() {
        override suspend fun tree(since: String?) = SyncTree(hash = "h").also { calls += "tree" }

        override suspend fun changes(since: Long) = ChangesPage(1).also { calls += "changes" }

        override suspend fun batch(notes: List<BatchEntry>): BatchReply {
            calls += "batch"
            return BatchReply(notes.map { BatchNoteReply(it.id, "e1", "", "SV", null) })
        }
    }
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var pictures: Attachments
    private lateinit var captures: Captures
    private var saved = 0

    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7)
    private val png2 = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8)

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db)
        api.onUpload = { calls += "picture" }
        api.onCapture = { calls += "capture:${it.id}"; app.penmoss.engine.api.CaptureReply(it.id, "n", it.destination, true) }
        pictures = Attachments(db.attachments(), folder.newFolder("a"), folder.newFolder("c"), api, now = { clock })
        captures = Captures(db.captures(), store, pictures, api, onSaved = { saved++ }, now = { clock }, newId = { "c${++ids}" }, zone = { "Europe/Paris" })
    }

    @After
    fun close() = db.close()

    @Test
    fun savingStoresTheCaptureOnThePhoneWithoutTheNetwork() = runBlocking {
        // A server that never answers: saving must not wait for it.
        api.onCapture = { throw AssertionError("saving must not send") }
        val result = captures.save("  Penmoss for Android\n<https://penmoss.app>  ", emptyList(), CaptureRequest.DAILY)!!
        assertEquals(Captures.Saved("c1", CaptureRequest.DAILY, 0), result)
        val row = db.captures().all().single()
        assertEquals("Penmoss for Android\n<https://penmoss.app>", row.text)
        assertEquals(clock, row.capturedAt)
        assertEquals(false, row.remember)
        assertEquals(1, saved)
        assertEquals(1, captures.observeWaiting().first())
        // Signing out keeps a phone with captures not sent yet (A284).
        assertEquals(1, store.unsentCount())
        assertEquals(emptyList<String>(), calls.toList())
    }

    @Test
    fun nothingToSaveIsNotSaved() = runBlocking {
        assertNull(captures.save("   ", emptyList(), CaptureRequest.DAILY))
        assertEquals(0, db.captures().count())
    }

    @Test
    fun picturesAreStoredFirstAndNamedInTheCapture() = runBlocking {
        val bytes = listOf(png, png2, byteArrayOf(1, 2, 3))
        val result = captures.save("The view", bytes, CaptureRequest.INBOX)!!
        // The third is not a picture the server takes.
        assertEquals(1, result.refusedPictures)
        val row = db.captures().all().single()
        val names = row.pictures.split(' ')
        assertEquals(2, names.size)
        assertEquals("The view\n\n![](attachments/${names[0]})\n\n![](attachments/${names[1]})", row.text)
        for (name in names) assertEquals(Attachments.Upload.WAITING, pictures.upload(name.substringBefore('.')))
    }

    @Test
    fun aCaptureGoesAfterItsPicturesAndBeforeThePassReadsWhatChanged() = runBlocking {
        captures.save("The view", listOf(png), CaptureRequest.DAILY)
        val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val scope = CoroutineScope(SupervisorJob() + thread)
        try {
            val work = PassWork(store, pictures, NoteFiler(store, api), OpenEditors(), captures)
            val engine = SyncEngine(api, store) {}
            val sync = SyncCoordinator(scope, { engine }, beforePass = work::beforePass, afterPass = work::afterPass)
            sync.start()
            sync.setForeground(true)
            withTimeout(5_000) { while ("changes" !in calls) delay(10) }
            assertEquals(listOf("picture", "capture:c1", "tree", "changes"), calls.toList().take(4))
            assertEquals(0, db.captures().count())
        } finally {
            // The pass in flight ends before the database closes (@After).
            withTimeout(5_000) { scope.coroutineContext.job.cancelAndJoin() }
            thread.close()
        }
    }

    @Test
    fun aCaptureWaitsWhileItsPictureCannotUpload() = runBlocking {
        captures.save("The view", listOf(png), CaptureRequest.DAILY)
        api.onUpload = { throw IOException("offline") }
        pictures.uploadDue()
        assertEquals(0, captures.sendDue())
        assertEquals(emptyList<CaptureRequest>(), api.captures.toList())
        // Online again: the picture first, then the capture naming it.
        api.onUpload = {}
        clock += Captures.MAX_BACKOFF_MS
        pictures.uploadDue()
        assertEquals(1, captures.sendDue())
        assertTrue(api.captures.single().text.contains("![](attachments/"))
    }

    @Test
    fun aPictureRefusedForGoodKeepsItsCaptureBackUntilThePersonDecides() = runBlocking {
        captures.save("The view", listOf(png, png2), CaptureRequest.DAILY)
        val names = db.captures().all().single().pictures.split(' ')
        // The server turns the first picture away for good.
        api.onUpload = { sha -> if (sha == names[0].substringBefore('.')) throw ApiException(415, "unsupported_type", "No") }
        pictures.uploadDue()
        // Never sent with a picture cut out of it unasked (A348): kept, with the reason, in Home's list.
        assertEquals(0, captures.sendDue())
        assertEquals(emptyList<CaptureRequest>(), api.captures.toList())
        val listed = captures.observeRefusedList().first().single()
        assertEquals(Captures.PICTURES_MISSING, listed.reason)
        assertTrue(listed.missingPictures)
        assertEquals("The view\n\n![](attachments/${names[0]})\n\n![](attachments/${names[1]})", listed.text)
        // The person sends it without that picture.
        captures.sendWithoutMissingPictures(listed.id)
        assertEquals(1, captures.sendDue())
        assertEquals("The view\n\n![](attachments/${names[1]})", api.captures.single().text)
    }

    @Test
    fun aPictureThatFailedOnlyOnBusyAnswersIsTriedAgainWithItsCaptureWhenAsked() = runBlocking {
        captures.save("The view", listOf(png), CaptureRequest.DAILY)
        val name = db.captures().all().single().pictures
        // A long outage: every try answers 503 until the picture's tries run out.
        api.onUpload = { throw ApiException(503, "unavailable", "Busy") }
        repeat(Attachments.MAX_ATTEMPTS + 1) {
            clock += 2 * Captures.MAX_BACKOFF_MS
            pictures.uploadDue()
        }
        assertEquals(Attachments.Upload.REFUSED, pictures.upload(name.substringBefore('.')))
        assertEquals(0, captures.sendDue())
        // Not cut: the capture still names its picture, and waits in the list (S8).
        val listed = captures.observeRefusedList().first().single()
        assertTrue(listed.text.contains("![](attachments/$name)"))
        // The server is back; the person taps Try again: the picture goes first, then the capture.
        api.onUpload = { calls += "picture" }
        captures.retry(listed.id)
        pictures.uploadDue()
        assertEquals(1, captures.sendDue())
        assertTrue(api.captures.single().text.contains("![](attachments/$name)"))
        assertEquals(listOf("picture", "capture:c1"), calls.toList())
    }

    @Test
    fun aRefusedCaptureCanBeDiscardedAndRefusedOnesDoNotKeepTheCacheAtSignOut() = runBlocking {
        captures.save("Too much", emptyList(), CaptureRequest.DAILY)
        api.onCapture = { throw ApiException(413, "too_large", "text is larger than 256 KB") }
        assertEquals(0, captures.sendDue())
        val listed = captures.observeRefusedList().first().single()
        assertEquals("text is larger than 256 KB", listed.reason)
        // Signing out does not keep the whole cache for it (A345); the sign-out dialog warns first.
        assertEquals(0, store.unsentCount())
        captures.discard(listed.id)
        assertEquals(emptyList<Captures.Refused>(), captures.observeRefusedList().first())
    }

    @Test
    fun aNoteBeingDeletedForGoodOrATimeoutIsAWaitNotARefusal() = runBlocking {
        captures.save("First", emptyList(), CaptureRequest.DAILY)
        captures.save("Second", emptyList(), CaptureRequest.DAILY)
        // Today's note is being purged (409 gone, S4); the second times out on a slow link (N7).
        api.onCapture = {
            if (it.id == "c1") throw ApiException(409, "gone", "This note is being deleted for good") else throw java.net.SocketTimeoutException("timeout")
        }
        assertEquals(0, captures.sendDue())
        val rows = db.captures().all()
        assertEquals(listOf(null, null), rows.map { it.refused })
        assertEquals(listOf(1, 1), rows.map { it.attempts })
        assertEquals(409, rows[0].lastStatus)
        // Both were tried: the timeout did not stop the pass at the first.
        assertEquals(listOf("c1", "c2"), api.captures.map { it.id })
        api.onCapture = { app.penmoss.engine.api.CaptureReply(it.id, "n", it.destination, true) }
        clock += Captures.FIRST_BACKOFF_MS
        assertEquals(2, captures.sendDue())
    }

    @Test
    fun aCaptureIsCutToWhatTheServerTakesByItsUtf8Bytes() = runBlocking {
        // 100,000 CJK characters are 300 KB of UTF-8: over the server's 256 KB (S3).
        val long = "漢".repeat(100_000)
        val saved = captures.save(long, listOf(png), CaptureRequest.DAILY)!!
        assertTrue(saved.cut)
        val row = db.captures().all().single()
        assertTrue(Utf8.size(row.text) <= Captures.MAX_CAPTURE_BYTES)
        // The picture is kept whole after the cut text.
        assertTrue(row.text.endsWith("![](attachments/${row.pictures})"))
        // No half of a pair at the cut.
        val emoji = captures.save("😀".repeat(70_000), emptyList(), CaptureRequest.DAILY)!!
        assertTrue(emoji.cut)
        val text = db.captures().all().last().text
        assertTrue(text.isNotEmpty() && !Character.isHighSurrogate(text.last()))
    }

    @Test
    fun picturesAreReadOneAtATimeEachStoredBeforeTheNextIsRead() = runBlocking {
        val bytes = (1..5).map { byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, it.toByte()) }
        val read = mutableListOf<Int>()
        val sources = bytes.mapIndexed { i, picture ->
            suspend {
                // Everything read before is already stored: only this one is held (S7).
                assertEquals(i, db.attachments().waitingCount())
                read += i
                picture
            }
        }
        val saved = captures.save("c-pictures", "Five", sources, CaptureRequest.DAILY)!!
        assertEquals(listOf(0, 1, 2, 3, 4), read)
        assertEquals(0, saved.refusedPictures)
        assertEquals(5, db.captures().all().single().pictures.split(' ').size)
    }

    @Test
    fun aSheetSavesItsCaptureOnceHoweverOftenItAsks() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val slow: suspend () -> ByteArray? = {
            gate.await()
            png
        }
        val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        try {
            val first = async(thread) { captures.saveDraft("draft-1", "Once", listOf(slow), CaptureRequest.DAILY) }
            withTimeout(5_000) { while (captures.saveState("draft-1").value != Captures.SaveState.Saving) delay(5) }
            // The sheet was made again (rotation) and Save tapped again: nothing more is saved (S6).
            assertNull(captures.saveDraft("draft-1", "Once", emptyList(), CaptureRequest.DAILY))
            gate.complete(Unit)
            assertEquals("draft-1", first.await()!!.id)
            assertNull(captures.saveDraft("draft-1", "Once", emptyList(), CaptureRequest.DAILY))
            // And a second save under the same id, however it came, stores no second capture.
            assertEquals("draft-1", captures.save("draft-1", "Once", emptyList(), CaptureRequest.DAILY)!!.id)
            assertEquals(1, db.captures().count())
            assertEquals(1, saved)
        } finally {
            thread.close()
        }
    }

    @Test
    fun aCaptureCarriesTheTimeZoneItWasMadeIn() = runBlocking {
        // Before any pass brought the synced zone: the phone's own.
        captures.save("Early", emptyList(), CaptureRequest.DAILY)
        store.saveTree(SyncTree(hash = "h", capture = CaptureSetting(CaptureRequest.DAILY, "Asia/Tokyo")))
        captures.save("Later", emptyList(), CaptureRequest.DAILY)
        assertEquals(listOf("Europe/Paris", "Asia/Tokyo"), db.captures().all().map { it.timeZone })
        captures.sendDue()
        assertEquals(listOf("Europe/Paris", "Asia/Tokyo"), api.captures.map { it.timeZone })
    }

    /** Quick Capture's default is a setting (T51, A947): a capture to the other one changes nothing. */
    @Test
    fun aCaptureToTheOtherDestinationLeavesTheDefaultAlone() = runBlocking {
        api.onCapture = { throw IOException("offline") }
        captures.save("To the Inbox", emptyList(), CaptureRequest.INBOX)
        assertEquals(CaptureRequest.DAILY, captures.destination())
        assertEquals(0, store.pendingSettingsCount())
        // The tree's word stands while the capture waits.
        store.saveTree(SyncTree(hash = "h", capture = CaptureSetting(CaptureRequest.INBOX)))
        assertEquals(CaptureRequest.INBOX, captures.destination())
        api.onCapture = { app.penmoss.engine.api.CaptureReply(it.id, "n", it.destination, true) }
        captures.sendDue()
        assertEquals(listOf(false), api.captures.map { it.remember })
    }

    @Test
    fun theSameIdGoesWithEveryTryUntilTheServerAnswers() = runBlocking {
        captures.save("Buy stamps", emptyList(), CaptureRequest.DAILY)
        api.onCapture = { throw IOException("offline") }
        assertEquals(0, captures.sendDue())
        // Offline is not the server's answer: no wait is added.
        assertEquals(0, db.captures().all().single().attempts)
        api.onCapture = { throw ApiException(503, "unavailable", "Busy") }
        assertEquals(0, captures.sendDue())
        assertEquals(1, db.captures().all().single().attempts)
        // Not again before its wait is over.
        api.onCapture = { app.penmoss.engine.api.CaptureReply(it.id, "n", it.destination, true) }
        assertEquals(0, captures.sendDue())
        clock += Captures.FIRST_BACKOFF_MS
        assertEquals(1, captures.sendDue())
        assertEquals(listOf("c1", "c1", "c1"), api.captures.map { it.id })
        assertEquals(0, captures.observeWaiting().first())
    }

    @Test
    fun aCaptureTheServerRefusesIsKeptAndListed() = runBlocking {
        captures.save("Buy stamps", emptyList(), CaptureRequest.DAILY)
        captures.save("Call Sam", emptyList(), CaptureRequest.DAILY)
        api.onCapture = {
            if (it.id == "c1") throw ApiException(400, "invalid_request", "Invalid capture") else app.penmoss.engine.api.CaptureReply(it.id, "n", it.destination, true)
        }
        // One refused capture does not hold the next back.
        assertEquals(1, captures.sendDue())
        assertEquals("Invalid capture", db.captures().all().single().refused)
        assertEquals(1, captures.observeRefused().first())
        assertEquals(0, captures.observeWaiting().first())
        // Never sent again, never dropped.
        clock += Captures.MAX_BACKOFF_MS
        assertEquals(0, captures.sendDue())
        assertEquals(listOf("c1", "c2"), api.captures.map { it.id })
        // Not counted as unsent: it would keep the whole cache at every sign-out (A345).
        assertEquals(0, store.unsentCount())
        assertEquals(1, captures.observeRefusedList().first().size)
    }

    @Test
    fun aServerWithoutCapturesYetKeepsThemWaitingNotRefused() = runBlocking {
        captures.save("Buy stamps", emptyList(), CaptureRequest.DAILY)
        // The APK is installed before the server half is deployed (A342).
        api.onCapture = { throw ApiException(404, "not_found", "Not found") }
        assertEquals(0, captures.sendDue())
        assertNull(db.captures().all().single().refused)
        assertEquals(1, captures.observeWaiting().first())
        // Deployed: the next try after the wait goes through.
        api.onCapture = { app.penmoss.engine.api.CaptureReply(it.id, "n", it.destination, true) }
        clock += Captures.FIRST_BACKOFF_MS
        assertEquals(1, captures.sendDue())
    }

    @Test
    fun aRefusedTokenStopsSendingAndSignsTheUserOut() = runBlocking {
        captures.save("Buy stamps", emptyList(), CaptureRequest.DAILY)
        api.onCapture = { throw ApiException(401, "unauthorized", "Signed out") }
        val error = runCatching { captures.sendDue() }.exceptionOrNull() as ApiException
        assertTrue(error.unauthorized)
        assertNull(db.captures().all().single().refused)
    }

    @Test
    fun theDestinationStartsOnTheSettingAndPickingTheOtherIsForThatCaptureOnly() = runBlocking {
        assertEquals(CaptureRequest.DAILY, captures.destination())
        // The web app's choice, as the tree brings it (A336).
        store.saveTree(SyncTree(hash = "h", capture = CaptureSetting(CaptureRequest.INBOX)))
        assertEquals(CaptureRequest.INBOX, captures.destination())
        captures.save("In the Inbox", emptyList(), CaptureRequest.INBOX)
        captures.save("Today instead", emptyList(), CaptureRequest.DAILY)
        captures.save("Today again", emptyList(), CaptureRequest.DAILY)
        // Not remembered (T51, A947): the next sheet starts on Settings' choice again.
        assertEquals(listOf(false, false, false), db.captures().all().map { it.remember })
        assertEquals(CaptureRequest.INBOX, captures.destination())
        captures.sendDue()
        assertEquals(listOf(CaptureRequest.INBOX, CaptureRequest.DAILY, CaptureRequest.DAILY), api.captures.map { it.destination })
        assertEquals(listOf(false, false, false), api.captures.map { it.remember })
    }

    @Test
    fun sendingTwiceAtOnceSendsEachCaptureOnce() = runBlocking {
        captures.save("Buy stamps", emptyList(), CaptureRequest.DAILY)
        val gate = CompletableDeferred<Unit>()
        api.onCapture = {
            runBlocking { gate.await() }
            app.penmoss.engine.api.CaptureReply(it.id, "n", it.destination, true)
        }
        val thread = Executors.newFixedThreadPool(2).asCoroutineDispatcher()
        try {
            val scope = CoroutineScope(thread)
            val first = scope.async { captures.sendDue() }
            val second = scope.async { captures.sendDue() }
            delay(100)
            gate.complete(Unit)
            assertEquals(1, first.await() + second.await())
            assertEquals(1, api.captures.size)
        } finally {
            thread.close()
        }
    }
}
