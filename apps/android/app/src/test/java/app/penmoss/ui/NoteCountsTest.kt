package app.penmoss.ui

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.AppGraph
import app.penmoss.auth.SecretBox
import app.penmoss.data.AttachmentEntity
import app.penmoss.data.CaptureEntity
import app.penmoss.data.FolderEntity
import app.penmoss.data.NoteEntity
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.stopMainScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.io.File

/**
 * What the note's sync icon and feedback's scrub read from Room (T40 P2b, review of #93, S4):
 * the real queries against a real database, through the app's graph.
 */
@RunWith(AndroidJUnit4::class)
class NoteCountsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var graph: AppGraph
    private val db get() = graph.database

    @Before
    fun open() {
        val box = object : SecretBox {
            override fun seal(plain: ByteArray) = plain

            override fun open(sealed: ByteArray) = sealed
        }
        graph = AppGraph(context, database = PenmossDatabase.inMemory(context), box = box)
    }

    @After
    fun close() {
        // The app’s work has ended before the database closes, never against a closed pool (A610, A690).
        stopMainScope(graph.scope)
        graph.database.close()
    }

    private fun <T> Flow<T>.settlesOn(expected: T): T = runBlocking { withTimeout(5_000) { first { it == expected } } }

    private suspend fun seed() {
        db.notes().insert(NoteEntity("n1", title = "Trip to Lisbon"))
        db.notes().insert(NoteEntity("n2", toFile = true))
        db.notes().insert(NoteEntity("n3", title = "Deleted plan", deleted = true, toFile = true))
        db.notes().insert(NoteEntity("n4", title = "Old", gone = true, toFile = true))
        // Moves to Trash and restores asked here and not sent yet (T40 P3a); a sent one is not waiting.
        db.notes().insert(NoteEntity("n6", title = "Trashed here", deleted = true, trashChange = NoteEntity.TRASH_QUEUED))
        db.notes().insert(NoteEntity("n7", title = "Restored here", trashChange = NoteEntity.RESTORE_QUEUED))
        db.notes().insert(NoteEntity("n8", title = "Sent", deleted = true, trashChange = NoteEntity.TRASH_SENT))
        db.folders().insertAll(listOf(FolderEntity("f1", "Health", null, "a", "manual")))
        for (state in listOf(UpdateEntity.PENDING, UpdateEntity.PENDING, UpdateEntity.CONFLICT, UpdateEntity.KEPT, UpdateEntity.SYNCED)) {
            db.updates().insert(UpdateEntity(noteId = "n1", state = state, update = "u"))
        }
        db.updates().insert(UpdateEntity(noteId = "n5", state = UpdateEntity.PENDING, update = "u"))
        db.captures().insert(CaptureEntity("c1", "text", "daily", 0))
        db.captures().insert(CaptureEntity("c2", "text", "daily", 0, refused = "too large"))
        db.attachments().put(AttachmentEntity("a", "png", 1, "n1", local = true, uploaded = false))
        db.attachments().put(AttachmentEntity("b", "png", 1, "n1", local = true, uploaded = false, failed = true))
        db.attachments().put(AttachmentEntity("c", "png", 1, "n2", local = true, uploaded = true))
        db.attachments().put(AttachmentEntity("d", "png", 1, "n2", local = true, uploaded = false, failed = true))
        db.attachments().put(AttachmentEntity("e", "png", 1, "n2", local = false, uploaded = false))
    }

    @Test
    fun aNotesOwnCountsAreItsOwn() = runBlocking<Unit> {
        seed()
        // Pending and kept apart; kept edits are never sent, so not waiting (S2).
        graph.store.observeUnsentCount("n1").settlesOn(3)
        graph.store.observeUnsentCount("n2").settlesOn(0)
        graph.attachments.observeWaiting("n1").settlesOn(1)
        graph.attachments.observeFailed("n1").settlesOn(1)
        graph.attachments.observeFailed("n2").settlesOn(1)
        graph.attachments.observeWaiting("n2").settlesOn(0)
    }

    @Test
    fun theNamesAreEveryTitleAndFolderName() = runBlocking<Unit> {
        seed()
        assertEquals(setOf("Trip to Lisbon", "Deleted plan", "Old", "Trashed here", "Restored here", "Sent", "Health"), graph.store.names().toSet())
    }
}
