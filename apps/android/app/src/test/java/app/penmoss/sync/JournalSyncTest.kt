package app.penmoss.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.Attachments
import app.penmoss.editor.OpenEditors
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.sync.SyncEngine
import app.penmoss.stopScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Daily and weekly notes made offline, then synced (T40 P5): a note made on the phone files
 * through the daily intent once uploaded, lands under Journal, and marks the calendar; a
 * daily note in Trash is restored by filing it (A144). The app's real coordinator, engine,
 * Room store, filer and HTTP client against a small fake Penmoss server.
 */
@RunWith(AndroidJUnit4::class)
class JournalSyncTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val penmoss = FakePenmoss()

    /** Airplane mode: every request fails before it leaves the phone. */
    @Volatile
    private var online = true

    private val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore
    private lateinit var sync: SyncCoordinator

    @Before
    fun setUp() {
        server.dispatcher = penmoss
        server.start()
        val http = OkHttpClient.Builder()
            .addInterceptor { chain -> if (!online) throw IOException("airplane mode") else chain.proceed(chain.request()) }
            .build()
        val api = HttpPenmossApi(server.url("/").toString(), http)
        db = PenmossDatabase.inMemory(context)
        store = NoteStore(db)
        val attachments = Attachments(db.attachments(), context.cacheDir, context.filesDir, api)
        val work = PassWork(
            store,
            attachments,
            NoteFiler(store, api),
            OpenEditors(),
            trash = TrashSender(store, api),
        )
        lateinit var engine: SyncEngine
        sync = SyncCoordinator(
            scope,
            engine = { engine },
            beforePass = work::beforePass,
            afterPass = work::afterPass,
            beforeNote = work::beforeNote,
        )
        engine = SyncEngine(api, store) { sync.publish(it) }
    }

    @After
    fun tearDown() {
        // A note made here is filed only once its content is on the server (review N5).
        assertTrue(penmoss.dailyBeforeContent.toString(), penmoss.dailyBeforeContent.isEmpty())
        // Its work ends before the dispatcher and the database close (A690).
        stopScope(scope)
        thread.close()
        db.close()
        server.close()
    }

    /** One sync pass, as the app runs in front or WorkManager in the background. */
    private fun pass(): PassOutcome = runBlocking { sync.backgroundPass(prefetch = true, maxBatches = SyncEngine.MAX_BATCHES) }

    @Test
    fun todayMadeOfflineIsFiledUnderJournalOnceOnline() {
        penmoss.dailyNoteId = { _, _ -> "daily1" }
        // Airplane mode: Today makes the note here (what the editor page stores), unsent.
        online = false
        runBlocking {
            store.addPeriodicNote(PageNote("daily1", "2026-10-21", "U09VUA=="), "daily", "2026-10-21", "daily", "2026-10-21")
        }
        pass()
        assertTrue(penmoss.dailyCalls.isEmpty())
        // Online: the content uploads, then the daily intent files it with its explicit day.
        online = true
        pass()
        assertEquals(listOf("2026-10-21" to "daily"), penmoss.dailyCalls.toList())
        // The tree files it under Journal/2026/10, and the calendar marks it.
        pass()
        assertEquals("Journal/2026/10", runBlocking { store.note("daily1") }!!.folderId)
        val folders = runBlocking { store.observeFolders().first().map { it.name }.toSet() }
        assertTrue(folders.containsAll(setOf("Journal", "2026", "10")))
        assertEquals(setOf("2026-10-21"), runBlocking { store.observeJournalMarks().first().map { it.period }.toSet() })
        assertTrue(runBlocking { store.readyToFile().isEmpty() })
    }

    @Test
    fun thisWeekMadeOfflineFilesUnderTheWeeklyFolder() {
        penmoss.dailyNoteId = { _, _ -> "weekly1" }
        online = false
        runBlocking {
            store.addPeriodicNote(PageNote("weekly1", "2026-W43", "U09VUA=="), "weekly", "2026-W43", "weekly", "2026-10-19")
        }
        pass()
        online = true
        pass()
        assertEquals(listOf("2026-10-19" to "weekly"), penmoss.dailyCalls.toList())
        pass()
        assertEquals("Journal/2026/Weekly", runBlocking { store.note("weekly1") }!!.folderId)
        assertEquals(setOf("2026-W43"), runBlocking { store.observeJournalMarks().first().map { it.period }.toSet() })
    }

    @Test
    fun filingRestoresADailyNoteInTrash() {
        penmoss.edit("daily1", "U09VUA==", "2026-10-21")
        penmoss.trash("daily1")
        penmoss.dailyNoteId = { _, _ -> "daily1" }
        // Today on the phone (the page rebuilds the same note): stored here, filed next pass.
        runBlocking {
            store.addPeriodicNote(PageNote("daily1", "2026-10-21", "U09VUA=="), "daily", "2026-10-21", "daily", "2026-10-21")
        }
        pass()
        assertEquals(listOf("2026-10-21" to "daily"), penmoss.dailyCalls.toList())
        // Restored: back in the tree, out of Trash, under Journal.
        pass()
        val note = runBlocking { store.note("daily1") }!!
        assertEquals("Journal/2026/10", note.folderId)
    }

    /**
     * Today on a daily note the phone holds, moved to Trash on the web (review S3, N5): out of
     * Trash here at once, then restored on the server and filed under Journal by the pass.
     */
    @Test
    fun todayOnAHeldDailyNoteTrashedElsewhereRestoresItEverywhere() {
        penmoss.edit("daily1", "U09VUA==", "2026-10-21")
        penmoss.journal("daily1", "daily", "2026-10-21")
        penmoss.dailyNoteId = { _, _ -> "daily1" }
        pass()
        assertTrue(runBlocking { store.holds("daily1") })
        penmoss.trash("daily1")
        pass()
        assertTrue(runBlocking { store.note("daily1") }!!.deleted)
        // Offline, Today rebuilds the same note: held, so nothing is stored, but it leaves Trash here.
        online = false
        runBlocking {
            assertFalse(store.addPeriodicNote(PageNote("daily1", "2026-10-21", "U09VUA=="), "daily", "2026-10-21", "daily", "2026-10-21"))
        }
        assertFalse(runBlocking { store.note("daily1") }!!.deleted)
        assertEquals(setOf("2026-10-21"), runBlocking { store.observeJournalMarks().first().map { it.period }.toSet() })
        pass()
        assertTrue(penmoss.dailyCalls.isEmpty())
        // Online: the daily intent files it (and the restore goes too), out of Trash on the server.
        online = true
        pass()
        pass()
        assertEquals(listOf("2026-10-21" to "daily"), penmoss.dailyCalls.toList())
        val note = runBlocking { store.note("daily1") }!!
        assertFalse(note.deleted)
        assertEquals(0, note.trashChange)
        assertEquals("Journal/2026/10", note.folderId)
        assertTrue(runBlocking { store.readyToFile().isEmpty() })
    }

    /**
     * Today, a calendar day or a period neighbour on a daily note the phone lists but has not
     * fetched (a metered network, no prefetch), online (review R1): the page built bytes from this
     * phone's template, which may differ from the note's, so nothing of them is sent. The note's
     * screen fetches the note instead, and the server's content stays exactly as it was.
     */
    @Test
    fun anOnlineOpenOfAListedUnfetchedDailyNoteUploadsNoPageBytes() {
        penmoss.edit("daily1", "T0xEVEVNUExBVEVfQU5EX0VESVRT", "2026-10-21")
        penmoss.journal("daily1", "daily", "2026-10-21")
        penmoss.dailyNoteId = { _, _ -> "daily1" }
        runBlocking { sync.backgroundPass(prefetch = false, maxBatches = SyncEngine.MAX_BATCHES) }
        assertTrue(runBlocking { store.note("daily1") } != null)
        assertFalse(runBlocking { store.holds("daily1") })
        val before = penmoss.updates("daily1")
        // The page answers with bytes built from a newer template on this phone.
        val made = runBlocking {
            store.addPeriodicNote(PageNote("daily1", "2026-10-21", "TkVXVEVNUExBVEU="), "daily", "2026-10-21", "daily", "2026-10-21")
        }
        pass()
        // Nothing of the page's went: the server's note is exactly as it was, and no intent was sent.
        assertEquals(before, penmoss.updates("daily1"))
        assertTrue(penmoss.dailyCalls.isEmpty())
        assertFalse(made)
        // The note's screen fetches what it does not hold: the phone ends up with the server's content.
        runBlocking { sync.syncNote("daily1") }
        assertEquals(listOf("T0xEVEVNUExBVEVfQU5EX0VESVRT"), runBlocking { store.editorContent("daily1") }.synced.map { it.update })
        assertTrue(runBlocking { store.pendingCount("daily1") } == 0)
        assertEquals(before, penmoss.updates("daily1"))
    }

    @Test
    fun calendarMarksComeFromTheTreeAndChanges() {
        penmoss.edit("daily1", "U09VUA==", "2026-10-21")
        penmoss.journal("daily1", "daily", "2026-10-21")
        penmoss.edit("weekly1", "U09VUA==", "2026-W43")
        penmoss.journal("weekly1", "weekly", "2026-W43")
        penmoss.edit("plain1", "U09VUA==", "Plain")
        pass()
        val marks = runBlocking { store.observeJournalMarks().first() }
        assertEquals(setOf("2026-10-21"), marks.filter { it.kind == "daily" }.map { it.period }.toSet())
        assertEquals(setOf("2026-W43"), marks.filter { it.kind == "weekly" }.map { it.period }.toSet())
    }
}
