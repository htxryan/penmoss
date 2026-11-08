package app.penmoss.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface NoteDao {
    /** Every title this phone holds: what an error report is scrubbed of (A427). */
    @Query("SELECT DISTINCT title FROM notes WHERE title != ''")
    suspend fun titles(): List<String>

    @Query("SELECT * FROM notes WHERE id = :id")
    suspend fun note(id: String): NoteEntity?

    @Query("SELECT * FROM notes WHERE id = :id")
    fun observe(id: String): Flow<NoteEntity?>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(note: NoteEntity)

    /**
     * Never moves a note back to older metadata (two catch-ups may finish out of order). While a
     * move to Trash or a restore asked here is under way (A430), the note stays as asked. [seq]
     * is the index row's seq, the newest this phone has seen (sent with a move to Trash, A431).
     * [kind] and [period] are a daily or weekly note's identity from the index (T40 P5).
     */
    @Query(
        "UPDATE notes SET title = :title, excerpt = :excerpt, updatedAt = :updatedAt, clock = :clock, " +
            "kind = :kind, period = :period, " +
            "seq = CASE WHEN :seq > seq THEN :seq ELSE seq END, " +
            // 7: in Trash with a notebook deleted here (T43, A755), held as a sent move (2) is.
            "deleted = CASE WHEN trashChange IN (1, 2, 5, 7) THEN 1 WHEN trashChange IN (3, 4, 6) THEN 0 ELSE :deleted END " +
            "WHERE id = :id AND clock <= :clock",
    )
    suspend fun updateMetadata(id: String, title: String, excerpt: String, updatedAt: Long, clock: Long, deleted: Boolean, seq: Long, kind: String, period: String?)

    /** A daily or weekly note's identity, from `/sync/tree` (T40 P5): the calendar marks on it. */
    @Query("UPDATE notes SET kind = :kind, period = :period WHERE id = :id")
    suspend fun updateKindPeriod(id: String, kind: String, period: String?)

    /** Every daily or weekly note's kind and period, for the Journal calendar's marks (T40 P5). */
    @Query("SELECT kind, period FROM notes WHERE kind != 'note' AND period IS NOT NULL AND deleted = 0 AND gone = 0")
    fun observeJournalMarks(): Flow<List<JournalMark>>

    @Query("UPDATE notes SET title = :title WHERE id = :id")
    suspend fun updateTitle(id: String, title: String)

    @Query("UPDATE notes SET folderId = NULL, position = ''")
    suspend fun clearPlacements()

    @Query("UPDATE notes SET folderId = :folderId, position = :position WHERE id = :id")
    suspend fun place(id: String, folderId: String?, position: String)

    @Query("DELETE FROM notes WHERE id = :id")
    suspend fun delete(id: String)

    /** The server no longer has the note (purged): it leaves every list, and its row stays as a tombstone. */
    @Query("UPDATE notes SET gone = 1 WHERE id = :id")
    suspend fun markGone(id: String)

    @Query(
        "UPDATE notes SET cursor = :cursor, epoch = :epoch, contentClock = :contentClock, gone = :gone WHERE id = :id",
    )
    suspend fun updateContentState(id: String, cursor: String?, epoch: String?, contentClock: Long, gone: Boolean)

    @Query(
        "SELECT id, title, excerpt, updatedAt, folderId, position FROM notes " +
            "WHERE deleted = 0 AND gone = 0 ORDER BY updatedAt DESC, id",
    )
    fun observeList(): Flow<List<NoteListRow>>

    /** The live notes of [ids] (T51, A946: Quick Access), in no order; trashed and unknown ones left out. */
    @Query(
        "SELECT id, title, excerpt, updatedAt, folderId, position FROM notes " +
            "WHERE deleted = 0 AND gone = 0 AND id IN (:ids)",
    )
    fun observeListOf(ids: List<String>): Flow<List<NoteListRow>>

    /** Held notes whose metadata moved past their content. */
    @Query("SELECT * FROM notes WHERE contentClock >= 0 AND clock > contentClock AND gone = 0 ORDER BY updatedAt DESC LIMIT :limit")
    suspend fun stale(limit: Int): List<NoteEntity>

    /** Held live notes whose text the offline index lacks (T40 P6, FD4), newest first. */
    @Query("SELECT * FROM notes WHERE contentClock >= 0 AND textDue = 1 AND deleted = 0 AND gone = 0 ORDER BY updatedAt DESC LIMIT :limit")
    suspend fun textMissing(limit: Int): List<NoteEntity>

    /** The offline index holds this text (by its SHA-256), current or not due ([due]). */
    @Query("UPDATE notes SET textHash = :hash, textDue = :due WHERE id = :id")
    suspend fun setText(id: String, hash: String?, due: Boolean)

    @Query("UPDATE notes SET textDue = :due WHERE id = :id")
    suspend fun setTextDue(id: String, due: Boolean)

    /** This phone opened the note (T40 P6, FD7). */
    @Query("UPDATE notes SET openedAt = :at WHERE id = :id AND openedAt < :at")
    suspend fun markOpened(id: String, at: Long)

    /** Live notes most recently used first: opened here or edited anywhere, whichever is later (FD7). */
    @Query(
        "SELECT id, title, excerpt, updatedAt, folderId, position FROM notes " +
            "WHERE deleted = 0 AND gone = 0 ORDER BY MAX(openedAt, updatedAt) DESC, id DESC LIMIT :limit",
    )
    fun observeRecent(limit: Int): Flow<List<NoteListRow>>

    /** [observeRecent] without the notes filed in [hidden]: the folders of notebooks closed here (T43, A752). */
    @Query(
        "SELECT id, title, excerpt, updatedAt, folderId, position FROM notes " +
            "WHERE deleted = 0 AND gone = 0 AND (folderId IS NULL OR folderId NOT IN (:hidden)) " +
            "ORDER BY MAX(openedAt, updatedAt) DESC, id DESC LIMIT :limit",
    )
    fun observeRecentOutside(limit: Int, hidden: List<String>): Flow<List<NoteListRow>>

    /**
     * Notes that went to Trash with a notebook deleted here (T43, A755): out of every list at once,
     * with nothing to send (the server's delete trashes them), held as a sent move is until an
     * index row after what this phone had seen says so ([NoteEntity.TRASH_WITH_NOTEBOOK]).
     */
    @Query(
        "UPDATE notes SET deleted = 1, trashChange = 7, trashChangeAt = :at, trashSeq = seq " +
            "WHERE id IN (:ids) AND deleted = 0 AND gone = 0",
    )
    suspend fun trashWithNotebook(ids: List<String>, at: Long)

    /** Live notes this device has never fetched, newest first. */
    @Query("SELECT * FROM notes WHERE contentClock < 0 AND deleted = 0 AND gone = 0 ORDER BY updatedAt DESC LIMIT :limit")
    suspend fun missing(limit: Int): List<NoteEntity>

    @Query("SELECT COUNT(*) FROM notes WHERE deleted = 0 AND gone = 0")
    suspend fun liveCount(): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(note: NoteEntity)

    /**
     * Notes to file that the server has (A303, T38): one it has indexed (a note moved on this
     * phone, or one made here that has since synced), or one made here whose content it now holds.
     * Never a note in Trash, unless this phone is moving it there (filed first, so the server
     * records the folder, A430) or it is a periodic note (filed through the daily intent, which
     * restores it under Journal, T40 P5, A144): filing would otherwise put it back in the tree.
     * A note moved to Trash here and not sent yet is filed first, so the server records the
     * folder this phone had it in (A430).
     */
    @Query(
        "SELECT * FROM notes WHERE toFile = 1 AND gone = 0 AND (deleted = 0 OR trashChange = 1 OR fileKind IS NOT NULL) AND (clock > 0 OR (contentClock >= 0 " +
            "AND NOT EXISTS (SELECT 1 FROM updates u WHERE u.noteId = notes.id AND u.state = 1)))",
    )
    suspend fun readyToFile(): List<NoteEntity>

    /**
     * Filed where it was to go, or that move dropped (A358, A359); a move made meanwhile (another
     * [fileIn]) is still to file. A periodic note's daily intent is done too (T40 P5).
     */
    @Query("UPDATE notes SET toFile = 0, checkFrom = 0, filePlaceBefore = NULL, filePlaceAfter = NULL, fileKind = NULL, fileDate = NULL WHERE id = :id AND fileIn IS :fileIn")
    suspend fun filed(id: String, fileIn: String?)

    /**
     * A move filed while another was made here: the server now has the note in [landed], so the
     * next move is checked against that, not against where it was before both (A359).
     */
    @Query("UPDATE notes SET movedFrom = :landed WHERE id = :id AND toFile = 1 AND checkFrom = 1")
    suspend fun nowIn(id: String, landed: String?)

    /** Notes made or moved here that the server has not filed yet: signing out keeps them (S1). */
    @Query(
        "SELECT COUNT(*) FROM notes WHERE toFile = 1 AND gone = 0 AND deleted = 0 " +
            "AND NOT EXISTS (SELECT 1 FROM updates u WHERE u.noteId = notes.id AND u.state IN (1, 2, 5))",
    )
    suspend fun unfiledCount(): Int

    /** Notes waiting to be filed: the tree shows them where they are going, not where they were (T38). */
    @Query("SELECT * FROM notes WHERE toFile = 1 AND gone = 0")
    suspend fun waitingToFile(): List<NoteEntity>

    /** Live notes filed in a folder, oldest position first (T40 P4, NT7): what a reorder anchors on. */
    @Query("SELECT * FROM notes WHERE folderId IS :folderId AND deleted = 0 AND gone = 0")
    suspend fun inFolder(folderId: String?): List<NoteEntity>

    /** Live notes filed in any of these folders (T40 P4, NT4): what a folder delete moves up. */
    @Query("SELECT * FROM notes WHERE folderId IN (:ids) AND deleted = 0 AND gone = 0")
    suspend fun inFolders(ids: List<String>): List<NoteEntity>

    /**
     * A manual reorder's anchor (T40 P4, NT7): filed with `place` (see [fileReorder]).
     * Nulls clear it (filed, or a move made since).
     */
    @Query("UPDATE notes SET filePlaceBefore = :before, filePlaceAfter = :after WHERE id = :id")
    suspend fun setPlace(id: String, before: String?, after: String?)

    /**
     * Files a note in [folderId] (null: the top level) once the server can be asked (T38). The
     * first move remembers where the tree showed the note (A359); a later one, made before that
     * was filed, keeps it, as does a note made here (nothing to check). [notebook] is the
     * notebook the phone sees it in now (T43, A766), kept the same way for the move's `fromNotebook`.
     */
    @Query(
        "UPDATE notes SET checkFrom = CASE WHEN toFile = 1 THEN checkFrom ELSE 1 END, " +
            "movedFrom = CASE WHEN toFile = 1 THEN movedFrom ELSE folderId END, " +
            "moveNotebook = CASE WHEN toFile = 1 AND moveNotebook IS NOT NULL THEN moveNotebook ELSE :notebook END, " +
            "toFile = 1, fileIn = :folderId, fileKind = NULL, fileDate = NULL, filePlaceBefore = NULL, filePlaceAfter = NULL WHERE id = :id",
    )
    suspend fun fileLater(id: String, folderId: String?, notebook: String?)

    /**
     * Files a periodic note made here through `POST /api/daily` (T40 P5): [fileKind] is `daily`
     * or `weekly`, [fileDate] the explicit calendar day it was made for. Nothing to check: the
     * server files it under Journal with A144 merge semantics.
     */
    @Query(
        "UPDATE notes SET checkFrom = 0, movedFrom = NULL, toFile = 1, fileIn = NULL, " +
            "fileKind = :fileKind, fileDate = :fileDate, filePlaceBefore = NULL, filePlaceAfter = NULL WHERE id = :id",
    )
    suspend fun fileDaily(id: String, fileKind: String, fileDate: String)

    /**
     * A manual reorder made here (T40 P4, NT7): filed in the same folder with `place`
     * immediately before [before] or after [after] (exactly one non-null).
     */
    @Query("UPDATE notes SET toFile = 1, fileIn = :folderId, filePlaceBefore = :before, filePlaceAfter = :after WHERE id = :id")
    suspend fun fileReorder(id: String, folderId: String?, before: String?, after: String?)

    /**
     * A note in Trash is not filed: its move is dropped, so restoring it later does not move it.
     * Not one this phone is moving to Trash: its move is filed first (A430). Never a periodic
     * note's daily intent (T40 P5): filing it restores the note under Journal (A144).
     */
    @Query("UPDATE notes SET toFile = 0, checkFrom = 0 WHERE id = :id AND deleted = 1 AND fileKind IS NULL AND trashChange NOT IN (1, 5)")
    suspend fun dropMoveIfDeleted(id: String)

    /** The last position among a folder's notes, so a note filed here shows at its end. */
    @Query("SELECT MAX(position) FROM notes WHERE folderId IS :folderId AND deleted = 0 AND gone = 0")
    suspend fun lastPosition(folderId: String?): String?

    // --- Trash (T40 P3a, A430) ---

    /**
     * Moves a note to Trash here: it leaves every list at once. A restore never tried is
     * cancelled instead (the server still has it in Trash); otherwise, a restore tried with no
     * answer (`trashTried`: the server may have it) among them, the request is queued,
     * with what this phone had seen of the note when it was asked ([seq] into `trashSeq`): a
     * restore elsewhere seen only later still wins (A431).
     */
    @Query(
        "UPDATE notes SET deleted = 1, " +
            "trashChange = CASE WHEN trashChange = 3 AND trashTried = 0 THEN 0 ELSE 1 END, trashChangeAt = :at, trashSeq = seq WHERE id = :id",
    )
    suspend fun trashHere(id: String, at: Long)

    /**
     * Takes a note out of Trash here: a move to Trash never tried is cancelled (the server never
     * had it there); otherwise, one tried with no answer among them, a restore is queued. It is
     * back in the lists at once.
     */
    @Query(
        "UPDATE notes SET deleted = 0, " +
            "trashChange = CASE WHEN trashChange = 1 AND trashTried = 0 THEN 0 ELSE 3 END, trashChangeAt = :at WHERE id = :id",
    )
    suspend fun restoreHere(id: String, at: Long)

    /**
     * Moves to Trash to send: those whose own edits, and a move to file, have all gone first
     * (NT12, A430).
     */
    @Query(
        "SELECT * FROM notes WHERE trashChange = 1 AND gone = 0 AND toFile = 0 " +
            "AND NOT EXISTS (SELECT 1 FROM updates u WHERE u.noteId = notes.id AND u.state = 1) ORDER BY trashChangeAt",
    )
    suspend fun trashesDue(): List<NoteEntity>

    @Query("SELECT * FROM notes WHERE trashChange = 3 AND gone = 0 ORDER BY trashChangeAt")
    suspend fun restoresDue(): List<NoteEntity>

    /**
     * [from] became [to] (in flight, back to queued, or settled), only if nothing else was asked
     * meanwhile. In flight (5 or 6) marks it tried; back to queued keeps that, as the server may
     * have applied it; settled (0) clears it.
     */
    @Query(
        "UPDATE notes SET trashChange = :to, " +
            "trashTried = CASE WHEN :to IN (5, 6) THEN 1 WHEN :to = 0 THEN 0 ELSE trashTried END " +
            "WHERE id = :id AND trashChange = :from",
    )
    suspend fun trashChanged(id: String, from: Int, to: Int): Int

    /**
     * The server has the change in flight ([from], 5 or 6) and answered: sent ([to], 2 or 4),
     * shown in index rows after [seq]; [at], when for a move to Trash (the server's time, shown).
     * Nothing if Undo or Restore changed it while in flight: that request is queued instead, and
     * stays tried. Answered: what the server has is known again.
     */
    @Query(
        "UPDATE notes SET trashChange = :to, trashSeq = :seq, trashChangeAt = :at, trashTried = 0 " +
            "WHERE id = :id AND trashChange = :from",
    )
    suspend fun trashConfirmed(id: String, from: Int, to: Int, seq: Long, at: Long): Int

    /** This phone's view of the note includes index seq [seq] (its own restore, A431). */
    @Query("UPDATE notes SET seq = :seq WHERE id = :id AND seq < :seq")
    suspend fun seenSeq(id: String, seq: Long)

    /** A pass that stopped with a change in flight (the process ended): queued again, still tried. */
    @Query("UPDATE notes SET trashChange = CASE trashChange WHEN 5 THEN 1 ELSE 3 END WHERE trashChange IN (5, 6)")
    suspend fun requeueInFlight(): Int

    /**
     * The server restored it on another device since this phone last saw it (409
     * `restored_since`): the request is dropped, and so is an Undo made while it was in flight;
     * the person is told once ([observeTrashNotices]).
     */
    @Query(
        "UPDATE notes SET trashChange = 0, deleted = 0, trashTried = 0, trashNotice = 1 " +
            "WHERE id = :id AND trashChange IN (3, 5)",
    )
    suspend fun trashRefused(id: String): Int

    /**
     * The server restored nothing (409 `restore_needs_folder`, T43 A757): the note's folder is gone
     * and no place for it is safe. It is back in Trash as the server has it, sent, nothing to send;
     * only if nothing was asked while the restore was in flight (a move to Trash then is sent).
     */
    @Query("UPDATE notes SET deleted = 1, trashChange = 2, trashTried = 0 WHERE id = :id AND trashChange = 6")
    suspend fun restoreRefused(id: String): Int

    /** Moves to Trash refused since they were last said, oldest first. */
    @Query("SELECT id, title FROM notes WHERE trashNotice = 1 AND gone = 0 ORDER BY trashChangeAt, id")
    fun observeTrashNotices(): Flow<List<TrashNotice>>

    @Query("UPDATE notes SET trashNotice = 0 WHERE id = :id")
    suspend fun trashNoticeShown(id: String)

    /**
     * Restored by the server: back in the tree once filed where it was deleted from (A430), with
     * nothing to check (the tree no longer has it anywhere), and listed there meanwhile.
     */
    @Query("UPDATE notes SET toFile = 1, fileIn = :folderId, checkFrom = 0, movedFrom = NULL, moveNotebook = :notebook WHERE id = :id")
    suspend fun fileRestored(id: String, folderId: String?, notebook: String?)

    /** Moves to Trash and restores asked here and not sent yet: signing out keeps them. */
    @Query("SELECT COUNT(*) FROM notes WHERE trashChange IN (1, 3, 5, 6) AND gone = 0")
    suspend fun trashChangesWaiting(): Int

    /** Trash as this phone knows it: every note it holds in Trash, newest first. */
    @Query(
        "SELECT id, title, updatedAt, trashChange, trashChangeAt FROM notes WHERE deleted = 1 AND gone = 0 " +
            "ORDER BY CASE WHEN trashChange IN (1, 2, 5) THEN trashChangeAt ELSE updatedAt END DESC, id",
    )
    fun observeTrash(): Flow<List<TrashRow>>

    /** The phone's notes for wikilinks (A303), newest first. */
    @Query("SELECT id, title, folderId FROM notes WHERE deleted = 0 AND gone = 0 ORDER BY updatedAt DESC, id")
    fun observeDirectory(): Flow<List<DirectoryRow>>
}

@Dao
interface FolderDao {
    /** Every folder name: what an error report is scrubbed of (A427). */
    @Query("SELECT DISTINCT name FROM folders")
    suspend fun names(): List<String>

    @Query("SELECT * FROM folders")
    fun observeAll(): Flow<List<FolderEntity>>

    @Query("SELECT * FROM folders WHERE id = :id")
    suspend fun get(id: String): FolderEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(folder: FolderEntity)

    @Query("DELETE FROM folders WHERE id = :id")
    suspend fun delete(id: String)

    @Query("UPDATE folders SET name = :name WHERE id = :id")
    suspend fun rename(id: String, name: String)

    @Query("UPDATE folders SET parentId = :parentId, position = :position WHERE id = :id")
    suspend fun move(id: String, parentId: String?, position: String)

    @Query("UPDATE folders SET sortMode = :mode WHERE id = :id")
    suspend fun setSortMode(id: String, mode: String)

    @Query("UPDATE folders SET position = :position WHERE id = :id")
    suspend fun setPosition(id: String, position: String)

    /** The last position among a folder's subfolders, so a folder made here shows at its end. */
    @Query("SELECT MAX(position) FROM folders WHERE parentId IS :parentId")
    suspend fun lastPosition(parentId: String?): String?

    /** A folder's subfolders (T40 P4, NT7): what a folder reorder anchors on. */
    @Query("SELECT * FROM folders WHERE parentId IS :parentId")
    suspend fun children(parentId: String?): List<FolderEntity>

    @Query("SELECT * FROM folders")
    suspend fun all(): List<FolderEntity>

    @Query("DELETE FROM folders")
    suspend fun clear()

    @Query("SELECT EXISTS (SELECT 1 FROM folders WHERE id = :id)")
    suspend fun exists(id: String): Boolean

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(folders: List<FolderEntity>)
}

@Dao
interface UpdateDao {
    /**
     * What the editor page reads of a note, as a stamp that moves whenever it changes (T40 P7,
     * A471): its rows the server has and those made here, by count and newest id. An embed of
     * the note renders again when it moves; a compaction moves it too, harmlessly.
     */
    @Query("SELECT COUNT(*) || ':' || IFNULL(MAX(id), 0) FROM updates WHERE noteId = :noteId AND state IN (0, 1)")
    fun observeContentStamp(noteId: String): Flow<String>

    /** The notes with edits not sent yet (T40 P7 review S3): their links are Room's own. */
    @Query("SELECT DISTINCT noteId FROM updates WHERE state = 1")
    fun observePendingNoteIds(): Flow<List<String>>

    /**
     * One note's edits on their way to the server (PL10, A429): pending, or kept apart for the
     * editor to merge. Kept edits (5) are never sent, so they are not waiting (review of #93).
     */
    @Query("SELECT COUNT(*) FROM updates WHERE noteId = :noteId AND state IN (1, 2)")
    fun observeUnsentCount(noteId: String): Flow<Int>

    @Query("SELECT * FROM updates WHERE noteId = :noteId AND state = :state ORDER BY id")
    suspend fun updates(noteId: String, state: Int): List<UpdateEntity>

    @Query("SELECT id FROM updates WHERE noteId = :noteId AND state = :state ORDER BY id")
    suspend fun ids(noteId: String, state: Int): List<Long>

    @Query("SELECT DISTINCT noteId FROM updates WHERE state = 1 LIMIT :limit")
    suspend fun notesWithPending(limit: Int): List<String>

    @Insert
    suspend fun insert(update: UpdateEntity): Long

    @Query("DELETE FROM updates WHERE noteId = :noteId AND state = 0")
    suspend fun deleteSynced(noteId: String)

    @Query("DELETE FROM updates WHERE id IN (:ids)")
    suspend fun delete(ids: List<Long>)

    /** Keeps edits apart; one stored without its copy's epoch is stamped with [epoch], the copy it was made on. */
    @Query("UPDATE updates SET state = 2, epoch = COALESCE(epoch, :epoch) WHERE id IN (:ids)")
    suspend fun markConflict(ids: List<Long>, epoch: String?)

    @Query("SELECT COUNT(*) FROM updates WHERE id IN (:ids) AND noteId = :noteId AND state = :state")
    suspend fun count(noteId: String, ids: List<Long>, state: Int): Int

    @Query("SELECT COUNT(*) FROM updates WHERE noteId = :noteId AND state = 0")
    suspend fun syncedCount(noteId: String): Int

    /**
     * Edits the server never got and no copy holds: pending, kept apart, or kept with no copy
     * possible (not base rows, which it had, nor edits a conflict copy holds).
     */
    @Query("SELECT COUNT(*) FROM updates WHERE state IN (1, 2, 5)")
    suspend fun unsentCount(): Int

    @Query("SELECT COUNT(*) FROM updates WHERE noteId = :noteId AND state IN (1, 2, 5)")
    suspend fun unsentCount(noteId: String): Int

    /** Edits waiting to be sent: what a sync after leaving the app is for (A330). */
    @Query("SELECT COUNT(*) FROM updates WHERE state = 1")
    suspend fun pendingCount(): Int

    @Query("SELECT COUNT(*) FROM updates WHERE noteId = :noteId AND state = :state")
    suspend fun count(noteId: String, state: Int): Int

    /**
     * A copy withheld from the push (A886): every other row of it joins its [UpdateEntity.WITHHELD]
     * rows, never sent, never kept apart as a conflict (which would make a new note of it).
     */
    @Query(
        "UPDATE updates SET state = 7, copiedTo = (SELECT w.copiedTo FROM updates w WHERE w.noteId = :noteId AND w.state = 7 LIMIT 1) " +
            "WHERE noteId = :noteId AND state IN (0, 1, 2, 3, 4, 5)",
    )
    suspend fun withholdRest(noteId: String)

    /** Pending edits made on a copy the server has replaced (A291): kept apart, never sent. */
    @Query("UPDATE updates SET state = 2 WHERE noteId = :noteId AND state = 1 AND epoch IS NOT NULL AND epoch != :epoch")
    suspend fun markStale(noteId: String, epoch: String)

    @Query("SELECT DISTINCT epoch FROM updates WHERE id IN (:ids)")
    suspend fun epochsOf(ids: List<Long>): List<String?>

    /** Keeps what the server had of a replaced copy as [UpdateEntity.BASE] rows of its epoch (A306). */
    @Query("UPDATE updates SET state = 3, epoch = :epoch WHERE noteId = :noteId AND state = 0")
    suspend fun keepAsBase(noteId: String, epoch: String?)

    @Query("SELECT * FROM updates WHERE id IN (:ids)")
    suspend fun byIds(ids: List<Long>): List<UpdateEntity>

    /** Notes holding edits kept apart, oldest first. */
    @Query("SELECT noteId FROM updates WHERE state = 2 GROUP BY noteId ORDER BY MIN(id) LIMIT :limit")
    suspend fun notesWithConflicts(limit: Int): List<String>

    /**
     * Base and copied rows no edit can need any more: no pending or kept-apart edit of that note
     * is of their epoch (or of no known epoch). Each as (id, noteId, epoch), for the caller to
     * leave those of a copy an open editor still holds (A309).
     */
    @Query(
        "SELECT id, noteId, epoch FROM updates WHERE state IN (3, 4) AND NOT EXISTS (SELECT 1 FROM updates c " +
            "WHERE c.noteId = updates.noteId AND c.state IN (1, 2) AND (c.epoch IS updates.epoch OR c.epoch IS NULL))",
    )
    suspend fun unneededBases(): List<BaseRow>

    @Query("UPDATE updates SET state = 4, copiedTo = :copiedTo WHERE id IN (:ids)")
    suspend fun markCopied(ids: List<Long>, copiedTo: String?)

    @Query("UPDATE updates SET state = 5 WHERE id IN (:ids)")
    suspend fun markKept(ids: List<Long>)

    @Query("SELECT COUNT(*) FROM updates WHERE state = 5")
    fun observeKeptCount(): Flow<Int>

    @Query("SELECT * FROM updates WHERE noteId = :noteId AND state IN (0, 1) ORDER BY id")
    suspend fun stored(noteId: String): List<UpdateEntity>

    /** Pending edits of a note the server no longer has: kept apart, stamped with the copy they were made on. */
    @Query("UPDATE updates SET state = 2, epoch = COALESCE(epoch, :epoch) WHERE noteId = :noteId AND state = 1")
    suspend fun keepPendingApart(noteId: String, epoch: String?)

    @Query("SELECT COUNT(*) FROM updates WHERE state = 2")
    fun observeConflictCount(): Flow<Int>

    /** Notes holding edits kept apart that no conflict copy holds yet (A323). */
    @Query("SELECT COUNT(DISTINCT noteId) FROM updates WHERE state = 2")
    fun observeConflictNotes(): Flow<Int>
}

@Dao
interface AttachmentDao {
    /** Pictures added here still to upload, as Sync and storage watches them (AC8). */
    @Query("SELECT COUNT(*) FROM attachments WHERE local = 1 AND uploaded = 0 AND failed = 0")
    fun observeWaiting(): Flow<Int>

    /** Pictures added here the server refused, or that were given up after [Attachments.MAX_ATTEMPTS] tries (AC8). */
    @Query("SELECT COUNT(*) FROM attachments WHERE local = 1 AND uploaded = 0 AND failed = 1")
    fun observeFailed(): Flow<Int>

    /** One note's pictures still to upload (PL10). */
    @Query("SELECT COUNT(*) FROM attachments WHERE noteId = :noteId AND local = 1 AND uploaded = 0 AND failed = 0")
    fun observeWaiting(noteId: String): Flow<Int>

    /** One note's pictures given up on: the note says so once (AC8). */
    @Query("SELECT COUNT(*) FROM attachments WHERE noteId = :noteId AND local = 1 AND uploaded = 0 AND failed = 1")
    fun observeFailed(noteId: String): Flow<Int>

    /** Retry: every picture given up on is tried again from the start (AC8). */
    @Query("UPDATE attachments SET failed = 0, attempts = 0, nextAttemptAt = 0 WHERE local = 1 AND uploaded = 0 AND failed = 1")
    suspend fun retryFailed(): Int

    @Query("SELECT * FROM attachments WHERE sha256 = :sha256")
    suspend fun get(sha256: String): AttachmentEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(attachment: AttachmentEntity)

    /** Pictures added here that the server lacks, due now, oldest first. */
    @Query("SELECT * FROM attachments WHERE local = 1 AND uploaded = 0 AND failed = 0 AND nextAttemptAt <= :now ORDER BY createdAt LIMIT :limit")
    suspend fun dueUploads(now: Long, limit: Int): List<AttachmentEntity>

    @Query("UPDATE attachments SET uploaded = 1 WHERE sha256 = :sha256")
    suspend fun uploaded(sha256: String)

    @Query("UPDATE attachments SET attempts = attempts + 1, nextAttemptAt = :next, failed = :failed WHERE sha256 = :sha256")
    suspend fun attempted(sha256: String, next: Long, failed: Boolean)

    @Query("UPDATE attachments SET nextAttemptAt = :next WHERE sha256 = :sha256")
    suspend fun postpone(sha256: String, next: Long)

    /** Uploaded again from the start: the person asked, for a capture naming it (A348). */
    @Query("UPDATE attachments SET failed = 0, attempts = 0, nextAttemptAt = 0 WHERE sha256 = :sha256 AND uploaded = 0")
    suspend fun retry(sha256: String)

    @Query("SELECT COUNT(*) FROM attachments WHERE local = 1 AND uploaded = 0 AND failed = 0")
    suspend fun waitingCount(): Int
}

@Dao
interface CaptureDao {
    /** -1 when a capture with this id is stored already: a save is never made twice (A348). */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(capture: CaptureEntity): Long

    @Query("SELECT * FROM captures WHERE id = :id")
    suspend fun get(id: String): CaptureEntity?

    /** Captures that may be sent now, oldest first. */
    @Query("SELECT * FROM captures WHERE refused IS NULL AND nextAttemptAt <= :now ORDER BY capturedAt, id LIMIT :limit")
    suspend fun due(now: Long, limit: Int): List<CaptureEntity>

    @Query("SELECT * FROM captures ORDER BY capturedAt, id")
    suspend fun all(): List<CaptureEntity>

    @Query("DELETE FROM captures WHERE id = :id")
    suspend fun delete(id: String)

    @Query("UPDATE captures SET attempts = attempts + 1, nextAttemptAt = :next, lastStatus = :status WHERE id = :id")
    suspend fun attempted(id: String, next: Long, status: Int?)

    /** Sent again from the start: the person asked (A345). */
    @Query("UPDATE captures SET refused = NULL, attempts = 0, nextAttemptAt = 0, lastStatus = NULL WHERE id = :id")
    suspend fun retry(id: String)

    @Query("SELECT * FROM captures WHERE refused IS NOT NULL ORDER BY capturedAt, id")
    fun observeRefusedList(): Flow<List<CaptureEntity>>

    @Query(
        "SELECT COUNT(*) AS count, MIN(capturedAt) AS oldest, COALESCE(MAX(lastStatus = 404), 0) AS serverOutdated " +
            "FROM captures WHERE refused IS NULL",
    )
    fun observeWaitingSummary(): Flow<CapturesWaiting>

    /**
     * The destination was chosen in Settings since these were saved: they no longer change it
     * when sent, so the choice made later stands (A411).
     */
    @Query("UPDATE captures SET remember = 0 WHERE remember = 1 AND refused IS NULL")
    suspend fun forgetDestination()

    /** Captures that will set the destination for every app once sent (A346). */
    @Query("SELECT COUNT(*) FROM captures WHERE remember = 1 AND refused IS NULL")
    suspend fun rememberingCount(): Int

    @Query("UPDATE captures SET refused = :why WHERE id = :id")
    suspend fun refuse(id: String, why: String)

    @Query("UPDATE captures SET text = :text, pictures = :pictures WHERE id = :id")
    suspend fun rewrite(id: String, text: String, pictures: String)

    @Query("SELECT COUNT(*) FROM captures WHERE refused IS NULL")
    fun observeWaiting(): Flow<Int>

    @Query("SELECT COUNT(*) FROM captures WHERE refused IS NOT NULL")
    fun observeRefused(): Flow<Int>

    @Query("SELECT COUNT(*) FROM captures")
    suspend fun count(): Int

    @Query("SELECT COUNT(*) FROM captures WHERE refused IS NULL")
    suspend fun waitingCount(): Int
}

@Dao
interface FolderOpDao {
    @Query("SELECT * FROM folder_ops ORDER BY rowId")
    suspend fun all(): List<FolderOpEntity>

    @Query("SELECT COUNT(*) FROM folder_ops")
    suspend fun count(): Int

    @Insert
    suspend fun insert(op: FolderOpEntity): Long

    @Query("DELETE FROM folder_ops WHERE rowId = :rowId")
    suspend fun delete(rowId: Long)

    /** Every queued change of a folder (a create and its delete cancel out, T40 P4). */
    @Query("DELETE FROM folder_ops WHERE folderId IS :folderId")
    suspend fun deleteFor(folderId: String?)

    /**
     * A request for this change went out and its answer never came: the server may hold it,
     * so deleting its folder queues the delete instead of cancelling both (T40 P4 review B3).
     */
    @Query("UPDATE folder_ops SET tried = 1 WHERE rowId = :rowId")
    suspend fun markTried(rowId: Long)

    /** Re-choosing a sort mode replaces the choice not sent yet (T40 P4, NT6): last write wins. */
    @Query("DELETE FROM folder_ops WHERE folderId IS :folderId AND kind = :kind")
    suspend fun deleteKind(folderId: String?, kind: String)
}

@Dao
interface PendingSettingDao {
    @Query("SELECT * FROM pending_settings ORDER BY `key`")
    suspend fun all(): List<PendingSettingEntity>

    @Query("SELECT * FROM pending_settings ORDER BY `key`")
    fun observeAll(): Flow<List<PendingSettingEntity>>

    @Query("SELECT * FROM pending_settings WHERE `key` = :key")
    suspend fun get(key: String): PendingSettingEntity?

    @Query("SELECT COUNT(*) FROM pending_settings")
    suspend fun count(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(setting: PendingSettingEntity)

    @Query("DELETE FROM pending_settings WHERE `key` = :key")
    suspend fun delete(key: String)
}

@Dao
interface SettingDao {
    @Query("SELECT value FROM settings WHERE `key` = :key")
    suspend fun get(key: String): String?

    @Query("SELECT value FROM settings WHERE `key` = :key")
    fun observe(key: String): Flow<String?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(setting: SettingEntity)

    @Query("DELETE FROM settings WHERE `key` = :key")
    suspend fun delete(key: String)

    @Query("DELETE FROM settings")
    suspend fun clear()
}

@Dao
interface HistoryCacheDao {
    @Query("SELECT * FROM history_cache WHERE noteId = :noteId")
    suspend fun get(noteId: String): HistoryCacheEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: HistoryCacheEntity)

    @Query("DELETE FROM history_cache WHERE noteId = :noteId")
    suspend fun delete(noteId: String)
}

/** Which notes link to which (T40 P7, A473): the offline backlinks and graph. */
@Dao
interface NoteLinkDao {
    @Query("DELETE FROM note_links WHERE sourceId = :sourceId")
    suspend fun clearFrom(sourceId: String)

    @Query("DELETE FROM note_links WHERE targetId = :targetId")
    suspend fun clearTo(targetId: String)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(links: List<NoteLinkEntity>)

    @Query("SELECT targetId FROM note_links WHERE sourceId = :sourceId ORDER BY targetId")
    suspend fun targetsOf(sourceId: String): List<String>

    /** Every link the phone knows, for the graph (T40 P7, LK7). */
    @Query("SELECT * FROM note_links ORDER BY sourceId, targetId")
    fun observeAll(): Flow<List<NoteLinkEntity>>

    /** The live notes linking to [targetId], most recently edited first, as the web lists them. */
    @Query(
        "SELECT n.id AS id, n.title AS title, n.excerpt AS excerpt, n.updatedAt AS updatedAt " +
            "FROM note_links l JOIN notes n ON n.id = l.sourceId " +
            "WHERE l.targetId = :targetId AND n.id != :targetId AND n.deleted = 0 AND n.gone = 0 " +
            "ORDER BY n.updatedAt DESC, n.id",
    )
    fun observeSources(targetId: String): Flow<List<BacklinkSource>>
}

@Dao
interface BacklinksCacheDao {
    @Query("SELECT * FROM backlinks_cache WHERE noteId = :noteId")
    suspend fun get(noteId: String): BacklinksCacheEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: BacklinksCacheEntity)

    @Query("DELETE FROM backlinks_cache WHERE noteId = :noteId")
    suspend fun delete(noteId: String)
}

