package app.penmoss.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.RawQuery
import androidx.room.Upsert
import androidx.sqlite.db.SupportSQLiteQuery
import kotlinx.coroutines.flow.Flow

/** The offline index and each note's tags (T40 P6, FD3, FD4). */
@Dao
interface SearchDao {
    @Upsert
    suspend fun putText(text: NoteTextEntity)

    @Query("SELECT * FROM note_texts WHERE noteId = :noteId")
    suspend fun text(noteId: String): NoteTextEntity?

    @Query("DELETE FROM note_texts WHERE noteId = :noteId")
    suspend fun deleteText(noteId: String)

    @Query("SELECT tag FROM note_tags WHERE noteId = :noteId ORDER BY tag")
    suspend fun tagsOf(noteId: String): List<String>

    @Query("DELETE FROM note_tags WHERE noteId = :noteId")
    suspend fun clearTags(noteId: String)

    @androidx.room.Insert(onConflict = androidx.room.OnConflictStrategy.IGNORE)
    suspend fun addTags(tags: List<NoteTagEntity>)

    /** Every tag on a live note, with how many carry it, A–Z. */
    @Query(
        "SELECT t.tag AS tag, COUNT(*) AS notes FROM note_tags t JOIN notes n ON n.id = t.noteId " +
            "WHERE n.deleted = 0 AND n.gone = 0 GROUP BY t.tag ORDER BY t.tag",
    )
    fun observeTagCounts(): Flow<List<TagCountRow>>

    /** One note's tags as the phone has them, frontmatter and inline (T42 on Android, TG6, A656). */
    @Query("SELECT tag FROM note_tags WHERE noteId = :noteId")
    fun observeTagsOf(noteId: String): Flow<List<String>>

    /** Each live note's tags (T40 P6, TG1): what the tag browser builds its tree from. */
    @Query("SELECT t.noteId AS noteId, t.tag AS tag FROM note_tags t JOIN notes n ON n.id = t.noteId WHERE n.deleted = 0 AND n.gone = 0")
    fun observeNoteTags(): Flow<List<NoteTagEntity>>

    /** [observeNoteTags] without the notes filed in [hidden]: closed notebooks' (T43, A752). */
    @Query(
        "SELECT t.noteId AS noteId, t.tag AS tag FROM note_tags t JOIN notes n ON n.id = t.noteId " +
            "WHERE n.deleted = 0 AND n.gone = 0 AND (n.folderId IS NULL OR n.folderId NOT IN (:hidden))",
    )
    fun observeNoteTagsOutside(hidden: List<String>): Flow<List<NoteTagEntity>>

    /** [observeTagCounts] without the notes filed in [hidden] (T43, A752). */
    @Query(
        "SELECT t.tag AS tag, COUNT(*) AS notes FROM note_tags t JOIN notes n ON n.id = t.noteId " +
            "WHERE n.deleted = 0 AND n.gone = 0 AND (n.folderId IS NULL OR n.folderId NOT IN (:hidden)) GROUP BY t.tag ORDER BY t.tag",
    )
    fun observeTagCountsOutside(hidden: List<String>): Flow<List<TagCountRow>>

    /** [observeTagged] without the notes filed in [hidden] (T43, A752). */
    @Query(
        "SELECT id, title, excerpt, updatedAt, folderId, position FROM notes WHERE deleted = 0 AND gone = 0 " +
            "AND (folderId IS NULL OR folderId NOT IN (:hidden)) AND id IN " +
            "(SELECT noteId FROM note_tags WHERE tag = :tag OR substr(tag, 1, length(:tag) + 1) = :tag || '/') " +
            "ORDER BY updatedAt DESC, id",
    )
    fun observeTaggedOutside(tag: String, hidden: List<String>): Flow<List<NoteListRow>>

    /**
     * The live notes tagged [tag] or a tag nested under it (TG2), newest first. `substr` rather
     * than LIKE: `_` is a letter in a tag and a wildcard in LIKE.
     */
    @Query(
        "SELECT id, title, excerpt, updatedAt, folderId, position FROM notes WHERE deleted = 0 AND gone = 0 AND id IN " +
            "(SELECT noteId FROM note_tags WHERE tag = :tag OR substr(tag, 1, length(:tag) + 1) = :tag || '/') " +
            "ORDER BY updatedAt DESC, id",
    )
    fun observeTagged(tag: String): Flow<List<NoteListRow>>

    /** Every note held here with [tag] or a tag under it (TG3): what a rename names. */
    @Query("SELECT DISTINCT noteId FROM note_tags WHERE tag = :tag OR substr(tag, 1, length(:tag) + 1) = :tag || '/' ORDER BY noteId")
    suspend fun taggedIds(tag: String): List<String>

    /**
     * What this phone has still to send that could bring a tag back (TG3, A468, review S4, R2):
     * pending edits and edits kept apart (which go up as a conflict copy), to any note, and quick
     * captures waiting to send. An edit that typed the old tag offline is on a note no tag list
     * here names yet. Never edits kept with no copy possible (5): they are never sent, so they
     * would block every rename for good.
     */
    @Query(
        "SELECT (SELECT COUNT(*) FROM updates WHERE state IN (1, 2)) + " +
            "(SELECT COUNT(*) FROM captures WHERE refused IS NULL)",
    )
    fun observeUnsent(): Flow<Int>

    /** The tags of [noteIds] (an optimistic rename, S5). */
    @Query("SELECT * FROM note_tags WHERE noteId IN (:noteIds)")
    suspend fun tagsOfNotes(noteIds: List<String>): List<NoteTagEntity>

    /** How many live notes the index holds and their words in all (bm25's statistics). */
    @Query("SELECT COUNT(*) AS notes, TOTAL(t.tokens) AS tokens FROM note_texts t JOIN notes n ON n.id = t.noteId WHERE n.deleted = 0 AND n.gone = 0")
    suspend fun stats(): FtsStatsRow

    /** A count (the live notes a clause matches, for its idf). */
    @RawQuery
    suspend fun count(query: SupportSQLiteQuery): Int

    /** Matches, with `matchinfo` for ranking, under the filters [OfflineSearch] builds. */
    @RawQuery
    suspend fun matches(query: SupportSQLiteQuery): List<FtsMatchRow>

    /** Note ids only (exclusions, counts). */
    @RawQuery
    suspend fun ids(query: SupportSQLiteQuery): List<String>

    /** The original columns and FTS4's `offsets()` of the notes shown, for their marks. */
    @RawQuery
    suspend fun offsets(query: SupportSQLiteQuery): List<FtsOffsetsRow>

    /** Words as written, in order (a prefix's range in `note_word_terms`, A680). */
    @RawQuery
    suspend fun words(query: SupportSQLiteQuery): List<String>

    /** Titles and excerpts of notes the index has no text for yet (never fetched), newest first. */
    @RawQuery
    suspend fun unindexed(query: SupportSQLiteQuery): List<NoteListRow>
}
