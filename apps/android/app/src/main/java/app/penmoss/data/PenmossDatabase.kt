package app.penmoss.data

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.AutoMigrationSpec
import androidx.sqlite.db.SupportSQLiteDatabase

/** The device's cache (T32): note metadata, the folder tree, and each note's opaque updates. */
@Database(
    entities = [NoteEntity::class, FolderEntity::class, FolderOpEntity::class, UpdateEntity::class, SettingEntity::class, AttachmentEntity::class, CaptureEntity::class, PendingSettingEntity::class, HistoryCacheEntity::class, FoldsEntity::class, NoteLinkEntity::class, BacklinksCacheEntity::class, NoteTextEntity::class, NoteTextFts::class, NoteTagEntity::class, NoteWordFts::class, app.penmoss.feedback.FeedbackOutboxEntity::class],
    version = 19,
    exportSchema = true,
    // 2: each pending edit's epoch (A291). 3: pictures (A304) and notes made on the phone to file (A303).
    // 4: quick captures waiting to be sent (A337). 5: where a note moved here was moved from (A359).
    // 6: settings changed here and not sent yet (A411). 7: Trash and restores asked here (A430).
    // 8: index seqs, requests tried with no answer, and refusals to say (A430, A431).
    // 9: the last version list read for each note, so history reads offline (A435).
    // 10: folder changes made here to send (A443, T40 P4), and reorder anchors on filed notes.
    // 11: folder changes tried with no answer, so a delete sends the delete (T40 P4 review B3).
    // 12: each note's kind and period for the Journal calendar, and periodic notes' daily
    // filing intent (T40 P5). 13: each note's toggles as this phone left them (T40 P8, ED8).
    // 14: which notes link to which, for offline backlinks and the graph, and the last backlinks
    // read for each note (T40 P7, A473, A474).
    // 15: the offline full-text index, each note's tags, when this phone last opened each note,
    // and whether its text is due (T40 P6); `/sync/changes` is read again for the tags.
    // 16: each note's words as written, to complete a partly typed word (#120, A680).
    // 17: feedback waiting to be sent, or refused (T49, A796, A802).
    // 18: notebooks (T43): each folder's notebook flag, and notebook changes made here to send;
    // the tree is read again so the flags fill in (A750).
    // 19: the notebook the phone saw a note or folder in when it was moved, sent with the move
    // (T43, A766).
    autoMigrations = [
        AutoMigration(from = 1, to = 2),
        AutoMigration(from = 2, to = 3),
        AutoMigration(from = 3, to = 4),
        AutoMigration(from = 4, to = 5),
        AutoMigration(from = 5, to = 6),
        AutoMigration(from = 6, to = 7),
        AutoMigration(from = 7, to = 8, spec = PenmossDatabase.ReadChangesAgain::class),
        AutoMigration(from = 8, to = 9),
        AutoMigration(from = 9, to = 10),
        AutoMigration(from = 10, to = 11),
        AutoMigration(from = 11, to = 12, spec = PenmossDatabase.ReadTreeAgain::class),
        AutoMigration(from = 12, to = 13),
        AutoMigration(from = 13, to = 14, spec = PenmossDatabase.ReadLinksAgain::class),
        AutoMigration(from = 14, to = 15, spec = PenmossDatabase.ReadChangesAgain::class),
        AutoMigration(from = 15, to = 16, spec = PenmossDatabase.ListWords::class),
        AutoMigration(from = 16, to = 17),
        AutoMigration(from = 17, to = 18, spec = PenmossDatabase.ReadTreeAgain::class),
        AutoMigration(from = 18, to = 19),
    ],
)
abstract class PenmossDatabase : RoomDatabase() {
    /**
     * Schema 8 adds each note's index seq, which only `/sync/changes` rows bring: a note
     * unchanged since would keep 0, and its moves to Trash would be refused over any restore the
     * phone saw before (A431). So the next pass reads every row again from the start, filling
     * them (second review of #94). Schema 15 reads them again for each note's tags (T40 P6).
     */
    class ReadChangesAgain : AutoMigrationSpec {
        override fun onPostMigrate(db: SupportSQLiteDatabase) {
            // NoteStore's CHANGES_CLOCK: where the next pass reads `/sync/changes` from.
            db.execSQL("DELETE FROM settings WHERE `key` = 'changesClock'")
        }
    }

    /**
     * Schema 12 adds each note's kind and period, which the tree brings for every journal note
     * (T40 P5). A phone that stored the tree's hash before upgrading would be told `unchanged`
     * and never learn them, so the next pass reads the whole tree again (T40 P5 review S1).
     * Schema 18 reads it again for each folder's notebook flag and the default notebook's name
     * (T43, A750).
     */
    class ReadTreeAgain : AutoMigrationSpec {
        override fun onPostMigrate(db: SupportSQLiteDatabase) {
            // NoteStore's TREE_HASH: the `since` the next `/sync/tree` read sends.
            db.execSQL("DELETE FROM settings WHERE `key` = 'treeHash'")
        }
    }

    /**
     * Schema 14 adds which notes link to which, which only `/sync/changes` rows bring (T40 P7,
     * A473): a note unchanged since would never link anywhere. So the next pass reads every row
     * again from the start, filling them, as schema 8 did for seqs.
     */
    class ReadLinksAgain : AutoMigrationSpec {
        override fun onPostMigrate(db: SupportSQLiteDatabase) {
            db.execSQL("DELETE FROM settings WHERE `key` = 'changesClock'")
        }
    }

    /**
     * Schema 16 lists each held note's words as written (#120, A680): the text already here is
     * read once more and its words written beside it, and their index built, so a partly typed
     * word finds it without waiting for the note to change (A683). The update triggers on
     * `note_texts` are set aside meanwhile: `fwords` is the only change, so `note_text_fts` needs
     * nothing, and `note_word_fts` is rebuilt once at the end. Each body is read in slices, so a
     * row larger than a CursorWindow (2 MB) never fails the migration (review S3).
     */
    class ListWords : AutoMigrationSpec {
        override fun onPostMigrate(db: SupportSQLiteDatabase) {
            val triggers = ArrayList<Pair<String, String>>()
            db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'note_texts' AND name LIKE '%UPDATE'").use { cursor ->
                while (cursor.moveToNext()) triggers += cursor.getString(0) to cursor.getString(1)
            }
            for ((name, _) in triggers) db.execSQL("DROP TRIGGER IF EXISTS `$name`")
            val rowids = ArrayList<Long>()
            db.query("SELECT rowid FROM note_texts").use { cursor -> while (cursor.moveToNext()) rowids += cursor.getLong(0) }
            for (rowid in rowids) {
                val columns = listOf("title", "body", "tags", "headings").map { column -> NoteTextEntity.searchText(read(db, column, rowid)) }
                db.execSQL("UPDATE note_texts SET fwords = ? WHERE rowid = ?", arrayOf<Any>(SearchCompletions.words(columns), rowid))
            }
            for ((_, sql) in triggers) db.execSQL(sql)
            // The words' index from the rows as they now are.
            db.execSQL("INSERT INTO note_word_fts(note_word_fts) VALUES ('rebuild')")
        }

        /** One column of one row, [SLICE] characters at a time. */
        private fun read(db: SupportSQLiteDatabase, column: String, rowid: Long): String {
            val out = StringBuilder()
            var from = 1L
            while (true) {
                val part = db.query("SELECT substr($column, ?, $SLICE) FROM note_texts WHERE rowid = ?", arrayOf<Any>(from, rowid)).use { cursor ->
                    if (cursor.moveToNext()) cursor.getString(0).orEmpty() else ""
                }
                out.append(part)
                if (part.length < SLICE) return out.toString()
                from += SLICE
            }
        }

        private companion object {
            /** Characters per read: at most 1 MB of UTF-8 (a CursorWindow holds 2 MB). */
            const val SLICE = 262_144
        }
    }

    abstract fun notes(): NoteDao

    abstract fun folders(): FolderDao

    abstract fun folderOps(): FolderOpDao

    abstract fun updates(): UpdateDao

    abstract fun settings(): SettingDao

    abstract fun attachments(): AttachmentDao

    abstract fun captures(): CaptureDao

    abstract fun pendingSettings(): PendingSettingDao

    abstract fun historyCache(): HistoryCacheDao

    abstract fun folds(): FoldsDao
    abstract fun search(): SearchDao

    abstract fun noteLinks(): NoteLinkDao

    abstract fun backlinksCache(): BacklinksCacheDao

    /** Feedback's outbox (T49, A796) and the counts its captured context reads. */
    abstract fun feedback(): app.penmoss.feedback.FeedbackDao

    companion object {
        /**
         * The app's own database (device settings since T59, A1041), or ([name]) a git notebook's own (T50 G7, A880): the same
         * schema in a file of its own, so nothing crosses sources (A826) and no key needs a source.
         */
        fun open(context: Context, name: String = "penmoss.db"): PenmossDatabase =
            Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()

        fun inMemory(context: Context): PenmossDatabase =
            Room.inMemoryDatabaseBuilder(context, PenmossDatabase::class.java).build()
    }
}
