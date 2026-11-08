package app.penmoss.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.TreeNote
import app.penmoss.engine.api.SyncTree
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * A phone's T32 database (schema 2) opened by T33 (schema 3, A308), T34 (schema 4, A337) and T38
 * (schema 5, A359), and up to schema 8 (T40 P3a, A430, A431), and on to 18 (T43): every row
 * survives, the new columns take their defaults, and edits a T32 build kept
 * apart, with no base rows, are kept rather than copied onto nothing (A309).
 * The schema-2 tables are made from the schema Room exported for that version.
 */
@RunWith(AndroidJUnit4::class)
class MigrationTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val name = "migration-test.db"

    @After
    fun delete() {
        context.deleteDatabase(name)
    }

    private fun createVersion2() = createVersion(2) { db ->
        db.execSQL(
            "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, folderId, position, contentClock, cursor, epoch, gone) " +
                "VALUES ('n', 'Trip', 'eggs', 5, 3, 0, NULL, 'a0', 3, 'SV', 'e2', 0)",
        )
        db.execSQL("INSERT INTO updates (noteId, state, data, epoch) VALUES ('n', 0, 'SERVER', NULL)")
        db.execSQL("INSERT INTO updates (noteId, state, data, epoch) VALUES ('n', 1, 'PENDING', 'e2')")
        // Kept apart by a T32 build after a restore: made on e1, whose base was never kept.
        db.execSQL("INSERT INTO updates (noteId, state, data, epoch) VALUES ('n', 2, 'T32-CONFLICT', 'e1')")
    }

    /** The FTS content-sync triggers Room makes for [version]'s schema. */
    private fun contentSyncTriggers(version: Int): List<String> {
        val schema = Json.parseToJsonElement(File("schemas/app.penmoss.data.PenmossDatabase/$version.json").readText()) as JsonObject
        return ((schema["database"] as JsonObject)["entities"] as JsonArray).flatMap { entity ->
            ((entity as JsonObject)["contentSyncTriggers"] as? JsonArray).orEmpty().map { (it as JsonPrimitive).content }
        }
    }

    /** A database as a build of [version] made it, from the schema Room exported, with [rows]. */
    private fun createVersion(version: Int, rows: (SQLiteDatabase) -> Unit) {
        val schema = Json.parseToJsonElement(File("schemas/app.penmoss.data.PenmossDatabase/$version.json").readText()) as JsonObject
        val database = schema["database"] as JsonObject
        val file = context.getDatabasePath(name).apply { parentFile?.mkdirs() }
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            for (entity in database["entities"] as JsonArray) {
                entity as JsonObject
                val table = (entity["tableName"] as JsonPrimitive).content
                db.execSQL((entity["createSql"] as JsonPrimitive).content.replace("\${TABLE_NAME}", table))
                for (index in (entity["indices"] as? JsonArray).orEmpty()) {
                    db.execSQL(((index as JsonObject)["createSql"] as JsonPrimitive).content.replace("\${TABLE_NAME}", table))
                }
            }
            for (query in database["setupQueries"] as JsonArray) db.execSQL((query as JsonPrimitive).content)
            rows(db)
            db.version = version
        }
    }

    @Test
    fun aT32DatabaseOpensWithEveryRowAndKeepsItsKeptApartEdits() = runTest {
        createVersion2()
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            val note = store.note("n")!!
            assertEquals("Trip", note.title)
            assertEquals("e2", note.epoch)
            assertFalse(note.toFile)
            assertNull(note.fileIn)
            assertEquals(listOf("SERVER"), db.updates().updates("n", UpdateEntity.SYNCED).map { it.update })
            assertEquals(listOf("PENDING"), db.updates().updates("n", UpdateEntity.PENDING).map { it.update })
            assertEquals(listOf<String?>(null), db.updates().updates("n", UpdateEntity.SYNCED).map { it.copiedTo })
            assertEquals(2, store.unsentCount())
            assertEquals(0, db.attachments().waitingCount())
            // Schema 4 (T34): the captures table, empty.
            assertEquals(0, db.captures().count())
            // Schema 5 (T38, A359): no move made here, so nothing to check it against.
            assertFalse(note.checkFrom)
            assertNull(note.movedFrom)

            // No base for e1 on this phone: the edit is offered with nothing made up for it,
            // and the page (which refuses such a copy) leaves it kept.
            val set = store.conflictSet("n")!!
            assertEquals(listOf("T32-CONFLICT"), set.edits.map { it.update })
            assertTrue(set.base.isEmpty())
            assertTrue(store.saveNoCopy("n", set.edits.map { it.id }, NoteStore.NoCopy.INCOMPLETE))
            assertEquals(1, store.observeKeptCount().first())
            assertEquals(2, store.unsentCount())
        } finally {
            db.close()
        }
    }

    @Test
    fun aNoteWaitingToBeFiledByAT34BuildIsStillFiledWithNothingToCheck() = runTest {
        // A link's new note made by a T33/T34 build, uploaded, not filed yet.
        createVersion(4) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, folderId, position, contentClock, cursor, epoch, gone, toFile, fileIn) " +
                    "VALUES ('made', 'Linked', '', 5, 0, 0, NULL, '', 4, 'SV', 'e1', 0, 1, 'garden')",
            )
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            val note = store.note("made")!!
            assertTrue(note.toFile)
            assertEquals("garden", note.fileIn)
            assertFalse(note.checkFrom)
            assertEquals(listOf("made"), store.readyToFile().map { it.id })
        } finally {
            db.close()
        }
    }

    @Test
    fun aT39DatabaseOpensWithItsSettingsAndNoSettingChangesToSend() = runTest {
        // A T38/T39 build's database (schema 5) holding the theme the last pass brought (A305).
        createVersion(5) { db ->
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('appearance', '{\"mode\":\"dark\"}')")
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('captureDestination', 'inbox')")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            // Schema 6 (T40 P1, A411): the pending_settings table, empty.
            assertEquals(0, db.pendingSettings().count())
            assertEquals(0, store.unsentCount())
            assertEquals("inbox", store.captureDestination())
            // Until a tree with settings comes, nothing is known to change.
            assertFalse(store.settingsNow().known)
            assertEquals("{\"mode\":\"dark\"}", store.observeAppearance().first())
        } finally {
            db.close()
        }
    }

    @Test
    fun aT40P2DatabaseOpensWithItsTrashAndNothingToSendForIt() = runTest {
        // A T40 P2 build's database (schema 6): one note in Trash (deleted elsewhere), one listed.
        createVersion(6) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, folderId, position, contentClock, cursor, epoch, gone, toFile, fileIn, checkFrom, movedFrom) " +
                    "VALUES ('old', 'Old plan', '', 5, 3, 1, NULL, '', 3, 'SV', 'e1', 0, 0, NULL, 0, NULL), " +
                    "('soup', 'Soup', '', 6, 4, 0, NULL, '', 4, 'SV', 'e1', 0, 0, NULL, 0, NULL)",
            )
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('changesClock', '9')")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            // Schema 7 (T40 P3a, A430): no move to Trash or restore asked here.
            assertEquals(0, store.note("old")!!.trashChange)
            assertEquals(0, store.trashChangesWaiting())
            assertEquals(0, store.unsentCount())
            assertEquals(listOf("old"), store.observeTrash().first().map { it.id })
            assertTrue(store.moveToTrash("soup"))
            assertEquals(1, store.unsentCount())
            // Schema 8 (A431): the next pass reads every index row again, so each note's seq is
            // filled, not left at 0 for a note unchanged since.
            assertEquals(0, store.changesClock())
        } finally {
            db.close()
        }
    }

    @Test
    fun aT40P3aBuildsSchema7OpensAndItsNotesSeqsAreFilledByTheNextPass() = runTest {
        // The first P3a build's database (5b85fea, schema 7): a move to Trash queued, a note
        // read up to changes clock 9, and no seqs yet.
        createVersion(7) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, folderId, position, contentClock, cursor, epoch, gone, toFile, fileIn, checkFrom, movedFrom, trashChange, trashChangeAt) " +
                    "VALUES ('old', 'Old plan', '', 5, 3, 1, NULL, '', 3, 'SV', 'e1', 0, 0, NULL, 0, NULL, 1, 7), " +
                    "('soup', 'Soup', '', 6, 4, 0, NULL, '', 4, 'SV', 'e1', 0, 0, NULL, 0, NULL, 0, 0)",
            )
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('changesClock', '9')")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            // Its queued move to Trash is kept, never tried; nothing to say.
            val old = store.note("old")!!
            assertEquals(NoteEntity.TRASH_QUEUED, old.trashChange)
            assertFalse(old.trashTried)
            assertEquals(0, store.observeTrashNotices().first().size)
            assertEquals(1, store.trashChangesWaiting())
            // Read from the start again: the rows the server sends fill every seq, the
            // unchanged note's too.
            assertEquals(0, store.changesClock())
            assertEquals(0, store.note("soup")!!.seq)
            store.saveChanges(
                ChangesPage(
                    9,
                    notes = listOf(
                        ChangedNote("old", 3, "Old plan", "", 5, deleted = false, seq = 12),
                        ChangedNote("soup", 4, "Soup", "", 6, seq = 15),
                    ),
                ),
            )
            assertEquals(15, store.note("soup")!!.seq)
            assertEquals(12, store.note("old")!!.seq)
            // The move asked before the upgrade still holds the note in Trash here.
            assertTrue(store.note("old")!!.deleted)
            assertEquals(9, store.changesClock())
        } finally {
            db.close()
        }
    }

    /** A P3a database (schema 8) opens at 9 (T40 P3b, A435): the version-list cache starts empty. */
    @Test
    fun aT40P3aBuildsSchema8OpensAndCachesAVersionList() = runTest {
        createVersion(8) { }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            assertNull(store.cachedHistory("n"))
            store.cacheHistory("n", """{"versions":[],"unversioned":null}""")
            assertEquals("""{"versions":[],"unversioned":null}""", store.cachedHistory("n")!!.json)
        } finally {
            db.close()
        }
    }

    /** A P3b database (schema 9) opens at 10 (T40 P4, A443): no folder changes wait, and none are said. */
    @Test
    fun aT40P3bBuildsSchema9OpensWithEmptyFolderOps() = runTest {
        createVersion(9) { }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            assertEquals(0, store.folderOpsWaiting())
            assertTrue(store.observeFolderNotices().first().isEmpty())
        } finally {
            db.close()
        }
    }

    /** A P4 database (schema 10) opens at 11 (T40 P4 review B3): its folder changes start untried. */
    @Test
    fun aT40P4BuildsSchema10OpensWithUntriedFolderOps() = runTest {
        createVersion(10) { db ->
            db.execSQL(
                "INSERT INTO folder_ops (folderId, kind, name, parentId, label) " +
                    "VALUES ('f1', 'CREATE', 'Projects', NULL, 'Projects')",
            )
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            val ops = store.folderOpsDue()
            assertEquals(1, ops.size)
            assertEquals(FolderOpEntity.CREATE, ops[0].kind)
            assertFalse(ops[0].tried)
            assertEquals(1, store.folderOpsWaiting())
        } finally {
            db.close()
        }
    }

    /** A T40 P4 database (schema 11) opens at 12 (T40 P5): notes default to kind `note`, with no daily intent. */
    @Test
    fun aT40P4BuildsSchema11OpensWithNotesAndNoDailyIntents() = runTest {
        createVersion(11) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone) " +
                    "VALUES ('n1', 'Plain', '', 10, 0, 0, '', -1, 0), ('d1', '2026-10-21', '', 11, 2, 0, '', -1, 0)",
            )
            // The tree read before the upgrade (its hash covers kinds the old build ignored).
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('treeHash', 'h-with-kinds'), ('changesClock', '9')")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            val note = store.note("n1")!!
            assertEquals("note", note.kind)
            assertNull(note.period)
            assertNull(note.fileKind)
            assertNull(note.fileDate)
            assertTrue(store.readyToFile().isEmpty())
            assertTrue(store.observeJournalMarks().first().isEmpty())
            // The whole tree is read again, so the journal notes it lists are marked (review S1).
            // Schema 12 left the changes cursor standing; schema 14 (T40 P7, A473), which this
            // database also passes through, starts it again so every row's links are read.
            assertNull(store.treeHash())
            assertEquals(0, store.changesClock())
            store.saveTree(SyncTree("h-with-kinds", notes = listOf(TreeNote("n1", null, "a0"), TreeNote("d1", null, "a1", kind = "daily", period = "2026-10-21"))))
            assertEquals(listOf("2026-10-21"), store.observeJournalMarks().first().map { it.period })
        } finally {
            db.close()
        }
    }

    /** A T40 P5 database (schema 12) opens at 13 (T40 P8): notes keep their place, no toggles are kept yet. */
    @Test
    fun aT40P5BuildsSchema12OpensWithNoTogglesKept() = runTest {
        createVersion(12) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone, kind) " +
                    "VALUES ('n1', 'Plain', '', 10, 0, 0, '', -1, 0, 'note')",
            )
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            assertEquals("Plain", NoteStore(db).note("n1")!!.title)
            val folds = FoldStore(db.folds())
            assertTrue(folds.folds("n1").isEmpty())
            folds.save("n1", mapOf("note|Details|0" to true))
            assertEquals(mapOf("note|Details|0" to true), folds.folds("n1"))
            // None left: the row goes.
            folds.save("n1", emptyMap())
            assertNull(db.folds().get("n1"))
        } finally {
            db.close()
        }
    }

    /**
     * A T40 P8 database (schema 13) opens at 14 (T40 P7, A473): no note links anywhere yet, so
     * the next pass reads every `/sync/changes` row again from the start, and their links fill
     * the table, the unchanged note's too.
     */
    @Test
    fun aT40P8BuildsSchema13OpensAndReadsEveryNotesLinksAgain() = runTest {
        createVersion(13) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone, kind) " +
                    "VALUES ('a', 'Garden', '', 10, 4, 0, '', 4, 0, 'note'), ('b', 'Review', '', 11, 5, 0, '', 5, 0, 'note')",
            )
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('changesClock', '9')")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            assertEquals(0, store.changesClock())
            assertTrue(store.observeBacklinkSources("a").first().isEmpty())
            assertNull(store.cachedBacklinks("a"))
            store.saveChanges(
                ChangesPage(
                    9,
                    notes = listOf(
                        ChangedNote("a", 4, "Garden", "", 10, links = emptyList()),
                        ChangedNote("b", 5, "Review", "", 11, links = listOf("a")),
                    ),
                ),
            )
            assertEquals(listOf("b"), store.observeBacklinkSources("a").first().map { it.id })
            assertEquals(9, store.changesClock())
        } finally {
            db.close()
        }
    }

    /**
     * A T40 P5 database (schema 12) opens at 15 (T40 P6): held notes are due for their text, never
     * opened here, and `/sync/changes` is read again from the start for each note's tags.
     */
    @Test
    fun aT40P5BuildsSchema12OpensWithTextDueAndChangesReadAgain() = runTest {
        createVersion(12) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone, kind) " +
                    "VALUES ('n1', 'Held', 'first line', 10, 4, 0, '', 4, 0, 'note')",
            )
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('changesClock', '4')")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            val note = store.note("n1")!!
            assertTrue(note.textDue)
            assertNull(note.textHash)
            assertEquals(0L, note.openedAt)
            assertEquals(0L, store.changesClock())
            // Due for its text on the next pass that may prefetch, not on a metered one.
            assertEquals(listOf("n1"), store.dueContent(10, prefetch = true, skip = emptySet()).map { it.noteId })
            assertTrue(store.dueContent(10, prefetch = false, skip = emptySet()).isEmpty())
            // Until then its title and first line are found; the new index works.
            assertEquals(listOf("n1"), OfflineSearch(db).search("first").map { it.noteId })
            store.savePageText("n1", "a body word")
            assertEquals(listOf("n1"), OfflineSearch(db).search("body").map { it.noteId })
        } finally {
            db.close()
        }
    }

    /**
     * A T40 P7 database (schema 14) opens at 15 (T40 P6, review R1): its links and toggles stay,
     * its notes' text is due, and `/sync/changes` is read again from the start for tags.
     */
    @Test
    fun aT40P7BuildsSchema14OpensWithLinksKeptTextDueAndChangesReadAgain() = runTest {
        createVersion(14) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone, kind) " +
                    "VALUES ('a', 'Garden', 'first line', 10, 4, 0, '', 4, 0, 'note'), ('b', 'Review', '', 11, 5, 0, '', 5, 0, 'note')",
            )
            db.execSQL("INSERT INTO note_links (sourceId, targetId) VALUES ('b', 'a')")
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('changesClock', '9')")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            assertEquals(listOf("b"), store.observeBacklinkSources("a").first().map { it.id })
            assertTrue(store.note("a")!!.textDue)
            assertEquals(0L, store.changesClock())
            val folds = FoldStore(db.folds())
            folds.save("a", mapOf("note|Details|0" to true))
            assertEquals(mapOf("note|Details|0" to true), folds.folds("a"))
            store.savePageText("a", "a body word")
            assertEquals(listOf("a"), OfflineSearch(db).search("body").map { it.noteId })
        } finally {
            db.close()
        }
    }

    /**
     * A T40 P6 database (schema 15) opens at 16 (#120, A680): the text it already holds lists its
     * words as written, so a word typed past its stem finds the note at once, with no new pass.
     */
    @Test
    fun aT40P6BuildsSchema15OpensWithItsNotesWordsListed() = runTest {
        createVersion(15) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone, kind, textDue) " +
                    "VALUES ('joy', 'Happiness', 'notes on', 10, 4, 0, '', 4, 0, 'note', 0)",
            )
            // The row and its FTS4 entry as a schema-15 build wrote them (folded and stemmed).
            db.execSQL(
                "INSERT INTO note_texts (noteId, title, body, tags, headings, ftitle, fbody, ftags, fheadings, tokens) " +
                    "VALUES ('joy', 'Happiness', 'Notes on happiness', '', '', 'happi', 'note on happi', '', '', 4)",
            )
            // A body past a CursorWindow (2 MB): the migration reads it in slices (review S3).
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone, kind, textDue) " +
                    "VALUES ('big', 'Log', '', 10, 5, 0, '', 5, 0, 'note', 0)",
            )
            db.execSQL(
                "INSERT INTO note_texts (noteId, title, body, tags, headings, ftitle, fbody, ftags, fheadings, tokens) " +
                    "VALUES ('big', 'Log', ?, '', '', 'log', '', '', '', 1)",
                arrayOf("ab ".repeat(1_100_000) + "zebrafish"),
            )
            db.execSQL("INSERT INTO note_text_fts (docid, ftitle, fbody, ftags, fheadings) SELECT rowid, ftitle, fbody, ftags, fheadings FROM note_texts")
            // Room's sync triggers, as a schema-15 build made them.
            for (sql in contentSyncTriggers(15)) db.execSQL(sql)
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val search = OfflineSearch(db)
            assertEquals(listOf("joy"), search.search("happin").map { it.noteId })
            assertTrue(search.unfinished("happin"))
            assertEquals("happiness notes on", db.search().text("joy")!!.fwords)
            // Still found by its stems, and kept current as the text changes.
            assertEquals(listOf("joy"), search.search("happiness", prefixLast = false).map { it.noteId })
            NoteStore(db).savePageText("joy", "Conditioning")
            assertEquals(listOf("joy"), search.search("conditio").map { it.noteId })
            assertEquals("happiness conditioning", db.search().text("joy")!!.fwords)
            val raw = db.openHelper.readableDatabase
            raw.query("SELECT fwords FROM note_texts WHERE noteId = 'big'").use { cursor ->
                cursor.moveToNext()
                assertEquals("log ab zebrafish", cursor.getString(0))
            }
            // The update triggers set aside during the migration are back, and Room's new ones made.
            raw.query("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'note_texts' AND name LIKE '%UPDATE'").use { cursor ->
                cursor.moveToNext()
                assertEquals(4, cursor.getInt(0))
            }
        } finally {
            db.close()
        }
    }

    /**
     * A #120 database (schema 16) opens at 17 (T49, A802): its notes kept, and the feedback
     * outbox there, empty, taking a submission and refusing a second with the same id.
     */
    @Test
    fun anA680BuildsSchema16OpensWithAnEmptyFeedbackOutbox() = runTest {
        createVersion(16) { db ->
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone, kind, textDue) " +
                    "VALUES ('kept', 'Trip', '', 10, 4, 0, '', 4, 0, 'note', 0)",
            )
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            assertEquals("Trip", NoteStore(db).note("kept")!!.title)
            val outbox = db.feedback()
            assertEquals(0, outbox.count())
            assertEquals(1L, outbox.insert(app.penmoss.feedback.FeedbackOutboxEntity("01JBXYZ0000000000000000001", "{}", "Sync broke", createdAt = 5)))
            assertEquals(-1L, outbox.insert(app.penmoss.feedback.FeedbackOutboxEntity("01JBXYZ0000000000000000001", "{}", "again")))
            val row = outbox.get("01JBXYZ0000000000000000001")!!
            assertEquals(app.penmoss.feedback.FeedbackOutboxEntity.QUEUED, row.state)
            assertEquals(0, row.attempts)
            assertNull(row.lastStatus)
            assertEquals(1, outbox.waitingCount())
        } finally {
            db.close()
        }
    }

    /**
     * A T49 database (schema 17) opens at 18 (T43, A750): its folders and their queued changes
     * kept, each folder not a notebook until the tree says so, which the next pass reads whole
     * again (its hash forgotten), and a notebook change queued after the upgrade.
     */
    @Test
    fun aT49BuildsSchema17OpensAt18WithEveryFolderReadAgainForItsNotebookFlag() = runTest {
        createVersion(17) { db ->
            db.execSQL("INSERT INTO folders (id, name, parentId, position, sortMode) VALUES ('w', 'Work', NULL, 'a0', 'manual')")
            db.execSQL("INSERT INTO folder_ops (folderId, kind, name, parentId, label) VALUES ('w', 'RENAME', 'Work', NULL, 'Work')")
            db.execSQL("INSERT INTO settings (`key`, value) VALUES ('treeHash', 'h17')")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            val folder = db.folders().get("w")!!
            assertEquals("Work", folder.name)
            assertEquals(false, folder.notebook)
            val ops = db.folderOps().all()
            assertEquals(listOf(FolderOpEntity.RENAME), ops.map { it.kind })
            assertEquals(false, ops.single().notebook)
            assertNull(store.treeHash())
            assertEquals(Notebooks.DEFAULT_NAME, store.defaultNotebookName())
            assertEquals(true, store.setNotebook("w", true).changed)
            assertEquals(true, db.folders().get("w")!!.notebook)
            assertEquals(listOf(FolderOpEntity.RENAME, FolderOpEntity.NOTEBOOK), db.folderOps().all().map { it.kind })
        } finally {
            db.close()
        }
    }

    /**
     * A schema 18 database opens at 19 (T43, fix c): a note waiting to be filed and a folder move
     * waiting to be sent are kept, neither with a notebook recorded, so the senders name the
     * notebook the phone sees now; a move queued after the upgrade records the one it saw.
     */
    @Test
    fun aSchema18OpensAt19WithQueuedMovesKeptAndNoNotebookRecordedForThem() = runTest {
        createVersion(18) { db ->
            db.execSQL("INSERT INTO folders (id, name, parentId, position, sortMode, notebook) VALUES ('w', 'Work', NULL, 'a0', 'manual', 1)")
            db.execSQL("INSERT INTO folders (id, name, parentId, position, sortMode, notebook) VALUES ('p', 'Plans', 'w', 'a0', 'manual', 0)")
            db.execSQL("INSERT INTO folders (id, name, parentId, position, sortMode, notebook) VALUES ('q', 'Ideas', 'w', 'a1', 'manual', 0)")
            db.execSQL(
                "INSERT INTO notes (id, title, excerpt, updatedAt, clock, deleted, position, contentClock, gone, kind, textDue, folderId, toFile, fileIn) " +
                    "VALUES ('kept', 'Trip', '', 10, 4, 0, '', 4, 0, 'note', 0, 'p', 1, 'p')",
            )
            db.execSQL("INSERT INTO folder_ops (folderId, kind, name, parentId, label, notebook) VALUES ('p', 'MOVE', 'Plans', NULL, 'Plans', 0)")
        }
        val db = Room.databaseBuilder(context, PenmossDatabase::class.java, name).build()
        try {
            val store = NoteStore(db)
            val note = store.note("kept")!!
            assertEquals(true, note.toFile)
            assertNull(note.moveNotebook)
            assertNull(db.folderOps().all().single().fromNotebook)
            assertEquals("w", store.notebookOfFolder("p"))
            assertEquals(Notebooks.DEFAULT, store.notebookOfFolder(null))
            assertEquals(NoteStore.FolderMove.MOVED, store.moveFolder("p", "q"))
            assertEquals(listOf(null, "w"), db.folderOps().all().map { it.fromNotebook })
        } finally {
            db.close()
        }
    }
}
