package app.penmoss.feedback

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

/**
 * A feedback submission waiting to be sent, or refused (T49, A796, A802): one row per form sent,
 * named by its ULID `submissionId`, so a retry or a replay files one issue. Its screenshots are
 * files under `filesDir/feedback/outbox/<id>/`, ready to upload. A row is removed once Penmoss
 * has filed it; a refusal that will not pass by itself stays, `failed`, until the person retries
 * or discards it.
 */
@Entity(tableName = "feedback_outbox")
data class FeedbackOutboxEntity(
    @PrimaryKey val id: String,
    /** The `payload` part as sent: JSON. */
    val payload: String,
    /** The form's title, for Settings → About's list. */
    val title: String,
    /** The screenshots' file names in its folder, in order, newline-separated. */
    val screenshots: String = "",
    /** [QUEUED], [SENDING] or [FAILED]. */
    val state: String = QUEUED,
    val attempts: Int = 0,
    /** Epoch ms: not tried again before then. */
    val nextAttemptAt: Long = 0,
    /** The last answer that was not a success: its status (null: no answer), and what it said. */
    val lastStatus: Int? = null,
    val lastError: String? = null,
    val createdAt: Long = 0,
) {
    companion object {
        const val QUEUED = "queued"
        const val SENDING = "sending"
        const val FAILED = "failed"
    }
}

@Dao
interface FeedbackDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(row: FeedbackOutboxEntity): Long

    @Query("SELECT * FROM feedback_outbox WHERE id = :id")
    suspend fun get(id: String): FeedbackOutboxEntity?

    /** Rows that may be sent now, oldest first: a `sending` row left by a run that stopped is due too. */
    @Query("SELECT * FROM feedback_outbox WHERE state != 'failed' AND nextAttemptAt <= :now ORDER BY createdAt, id LIMIT :limit")
    suspend fun due(now: Long, limit: Int): List<FeedbackOutboxEntity>

    @Query("UPDATE feedback_outbox SET state = 'sending' WHERE id = :id")
    suspend fun sending(id: String)

    /** Waits to be tried again at [next]; [counted] adds an attempt (not for being offline). */
    @Query(
        "UPDATE feedback_outbox SET state = 'queued', attempts = attempts + :counted, nextAttemptAt = :next, " +
            "lastStatus = :status, lastError = :error WHERE id = :id",
    )
    suspend fun waiting(id: String, next: Long, counted: Int, status: Int?, error: String?)

    @Query("UPDATE feedback_outbox SET state = 'failed', attempts = attempts + 1, lastStatus = :status, lastError = :error WHERE id = :id")
    suspend fun failed(id: String, status: Int?, error: String)

    /** Sent again from the start: the person asked. */
    @Query("UPDATE feedback_outbox SET state = 'queued', attempts = 0, nextAttemptAt = 0, lastStatus = NULL, lastError = NULL WHERE id = :id")
    suspend fun retry(id: String)

    @Query("DELETE FROM feedback_outbox WHERE id = :id")
    suspend fun delete(id: String)

    @Query("SELECT * FROM feedback_outbox ORDER BY createdAt, id")
    fun observeAll(): Flow<List<FeedbackOutboxEntity>>

    @Query("SELECT * FROM feedback_outbox ORDER BY createdAt, id")
    suspend fun all(): List<FeedbackOutboxEntity>

    /** Waiting to be sent (not refused): leaving the app asks for a run while there are some (A330). */
    @Query("SELECT COUNT(*) FROM feedback_outbox WHERE state != 'failed'")
    suspend fun waitingCount(): Int

    @Query("SELECT COUNT(*) FROM feedback_outbox")
    suspend fun count(): Int

    // --- the captured context's counts (T49, A791): numbers only, from the cache's own tables ---

    /** Notes with edits not sent yet (UpdateEntity.PENDING). */
    @Query("SELECT COUNT(DISTINCT noteId) FROM updates WHERE state = 1")
    suspend fun unsyncedNotes(): Int

    @Query("SELECT COUNT(*) FROM note_links WHERE targetId = :noteId AND sourceId != :noteId")
    suspend fun backlinks(noteId: String): Int

    @Query("SELECT COUNT(*) FROM note_links WHERE sourceId = :noteId")
    suspend fun outgoingLinks(noteId: String): Int

    @Query("SELECT tag FROM note_tags WHERE noteId = :noteId ORDER BY tag")
    suspend fun tags(noteId: String): List<String>

    /** Pictures and files first added to the note (AttachmentEntity.noteId). */
    @Query("SELECT COUNT(*) FROM attachments WHERE noteId = :noteId")
    suspend fun attachments(noteId: String): Int

    @Query("SELECT COUNT(*) FROM updates WHERE noteId = :noteId AND state = 1")
    suspend fun pendingOf(noteId: String): Int

    /** The note's text as the offline index holds it: read only to count it and to drop errors quoting it. */
    @Query("SELECT body FROM note_texts WHERE noteId = :noteId")
    suspend fun text(noteId: String): String?
}
