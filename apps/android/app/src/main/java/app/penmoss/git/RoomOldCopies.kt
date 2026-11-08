package app.penmoss.git

import androidx.room.withTransaction
import app.penmoss.data.NoteEntity
import app.penmoss.data.PenmossDatabase
import app.penmoss.data.UpdateEntity
import app.penmoss.engine.git.OldCopies
import app.penmoss.engine.git.OldCopy
import app.penmoss.engine.git.WithheldCopies
import app.penmoss.engine.git.WithheldCopy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A git notebook's Room copies from before its page's epoch (A886): what [app.penmoss.engine.git.GitRecovery]
 * gives the page to bring back when Android cleared the page's store. Room's updates stay opaque
 * here (A11); only rows the page took in or has not yet (synced, pending) are a note's copy, and
 * one the page could not bring back is kept aside as [UpdateEntity.RECOVERY] rows. A copy withheld
 * from the push (its original deleted for good on another device first) is kept aside as
 * [UpdateEntity.WITHHELD] rows, with its title on its note row, out of every list.
 */
class RoomOldCopies(private val db: PenmossDatabase) : OldCopies, WithheldCopies {
    private val held = "${UpdateEntity.SYNCED}, ${UpdateEntity.PENDING}"

    override suspend fun epochs(): List<String> = withContext(Dispatchers.IO) {
        val out = mutableListOf<String>()
        db.openHelper.readableDatabase.query("SELECT DISTINCT epoch FROM notes WHERE epoch IS NOT NULL").use { rows ->
            while (rows.moveToNext()) out += rows.getString(0)
        }
        out
    }

    /** How many notes' copies wait (from another epoch than [epoch]) and how many are kept aside. */
    suspend fun counts(epoch: String): Pair<Int, Int> = withContext(Dispatchers.IO) {
        val sql = db.openHelper.readableDatabase
        fun count(query: String, args: Array<Any?>) = sql.query(query, args).use { if (it.moveToFirst()) it.getInt(0) else 0 }
        val waiting = count(
            "SELECT COUNT(DISTINCT n.id) FROM notes n JOIN updates u ON u.noteId = n.id WHERE n.epoch IS NOT NULL AND n.epoch != ? AND n.gone = 0 AND u.state IN ($held)",
            arrayOf(epoch),
        )
        val kept = count("SELECT COUNT(DISTINCT noteId) FROM updates WHERE state = ${UpdateEntity.RECOVERY}", emptyArray())
        waiting to kept
    }

    override suspend fun before(epoch: String): List<OldCopy> = withContext(Dispatchers.IO) {
        val sql = db.openHelper.readableDatabase
        fun rowsOf(noteId: String, states: String): List<String> {
            val updates = mutableListOf<String>()
            sql.query("SELECT data FROM updates WHERE noteId = ? AND state IN ($states) ORDER BY id", arrayOf<Any?>(noteId)).use { rows ->
                while (rows.moveToNext()) updates += rows.getString(0)
            }
            return updates
        }
        val notes = mutableListOf<Triple<String, String, String?>>()
        sql.query("SELECT id, title, folderId FROM notes WHERE epoch IS NOT NULL AND epoch != ? AND gone = 0 ORDER BY id", arrayOf<Any?>(epoch)).use { rows ->
            while (rows.moveToNext()) notes += Triple(rows.getString(0), rows.getString(1).orEmpty(), if (rows.isNull(2)) null else rows.getString(2))
        }
        val old = notes.mapNotNull { (id, title, folderId) ->
            rowsOf(id, held).takeIf { it.isNotEmpty() }?.let { OldCopy(id, title, folderId, it) }
        }
        val keptIds = mutableListOf<Triple<String, String, String?>>()
        sql.query(
            // From the rows: kept even once the note itself has left Room (gone from git).
            "SELECT DISTINCT u.noteId, n.title, n.folderId FROM updates u LEFT JOIN notes n ON n.id = u.noteId WHERE u.state = ${UpdateEntity.RECOVERY}",
        ).use { rows ->
            while (rows.moveToNext()) keptIds += Triple(rows.getString(0), rows.getString(1).orEmpty(), if (rows.isNull(2)) null else rows.getString(2))
        }
        old + keptIds.map { (id, title, folderId) -> OldCopy(id, title, folderId, rowsOf(id, "${UpdateEntity.RECOVERY}"), kept = true) }
    }

    override suspend fun done(copy: OldCopy) = withContext(Dispatchers.IO) {
        val sql = db.openHelper.writableDatabase
        if (copy.kept) {
            sql.execSQL("DELETE FROM updates WHERE noteId = ? AND state = ${UpdateEntity.RECOVERY}", arrayOf<Any?>(copy.noteId))
        } else {
            // Its whole copy again from the new store at the next pass: replaced by git's, or gone.
            sql.execSQL("DELETE FROM updates WHERE noteId = ? AND state IN ($held)", arrayOf<Any?>(copy.noteId))
            sql.execSQL("UPDATE notes SET cursor = NULL WHERE id = ?", arrayOf<Any?>(copy.noteId))
        }
    }

    override suspend fun withhold(copies: List<WithheldCopy>) = db.withTransaction {
        val sql = db.openHelper.writableDatabase
        for (copy in copies) {
            // Every row Room has of it (what the editor typed and has not sent too) and the page's
            // whole copy: never sent, never brought back by a pass, never made a conflict copy.
            sql.execSQL(
                "UPDATE updates SET state = ${UpdateEntity.WITHHELD}, copiedTo = ? WHERE noteId = ? AND state IN (0, 1, 2, 3, 4, 5)",
                arrayOf<Any?>(copy.origin, copy.noteId),
            )
            for (update in copy.updates) {
                sql.execSQL(
                    "INSERT INTO updates (noteId, state, data, copiedTo) VALUES (?, ${UpdateEntity.WITHHELD}, ?, ?)",
                    arrayOf<Any?>(copy.noteId, update, copy.origin),
                )
            }
            db.notes().insertIgnore(NoteEntity(copy.noteId))
            sql.execSQL("UPDATE notes SET title = ?, folderId = ?, gone = 1 WHERE id = ?", arrayOf<Any?>(copy.title, copy.folderId, copy.noteId))
        }
    }

    /** How many copies are withheld from the push (A886): Remove loses them. */
    suspend fun withheldCount(): Int = withContext(Dispatchers.IO) {
        db.openHelper.readableDatabase.query("SELECT COUNT(DISTINCT noteId) FROM updates WHERE state = ${UpdateEntity.WITHHELD}").use { if (it.moveToFirst()) it.getInt(0) else 0 }
    }

    override suspend fun withheld(): List<WithheldCopy> = withContext(Dispatchers.IO) {
        val sql = db.openHelper.readableDatabase
        val out = mutableListOf<WithheldCopy>()
        val ids = mutableListOf<String>()
        sql.query("SELECT DISTINCT noteId FROM updates WHERE state = ${UpdateEntity.WITHHELD} ORDER BY noteId").use { rows ->
            while (rows.moveToNext()) ids += rows.getString(0)
        }
        for (id in ids) {
            val updates = mutableListOf<String>()
            var origin = ""
            sql.query("SELECT data, copiedTo FROM updates WHERE noteId = ? AND state = ${UpdateEntity.WITHHELD} ORDER BY id", arrayOf<Any?>(id)).use { rows ->
                while (rows.moveToNext()) {
                    updates += rows.getString(0)
                    if (origin.isEmpty() && !rows.isNull(1)) origin = rows.getString(1)
                }
            }
            var title = ""
            var folderId: String? = null
            sql.query("SELECT title, folderId FROM notes WHERE id = ?", arrayOf<Any?>(id)).use { rows ->
                if (rows.moveToFirst()) {
                    title = rows.getString(0).orEmpty()
                    folderId = if (rows.isNull(1)) null else rows.getString(1)
                }
            }
            out += WithheldCopy(id, origin, title, folderId, updates)
        }
        out
    }

    override suspend fun drop(noteId: String) = withContext(Dispatchers.IO) {
        val sql = db.openHelper.writableDatabase
        sql.beginTransaction()
        try {
            sql.execSQL("DELETE FROM updates WHERE noteId = ? AND state = ${UpdateEntity.WITHHELD}", arrayOf<Any?>(noteId))
            // Its row too, once nothing else of it is left: the page lists it afresh if it comes back.
            sql.execSQL("DELETE FROM notes WHERE id = ? AND gone = 1 AND NOT EXISTS (SELECT 1 FROM updates WHERE noteId = ?)", arrayOf<Any?>(noteId, noteId))
            sql.setTransactionSuccessful()
        } finally {
            sql.endTransaction()
        }
    }

    override suspend fun keep(copy: OldCopy) = withContext(Dispatchers.IO) {
        if (copy.kept) return@withContext
        val sql = db.openHelper.writableDatabase
        sql.beginTransaction()
        try {
            sql.execSQL("UPDATE updates SET state = ${UpdateEntity.RECOVERY} WHERE noteId = ? AND state IN ($held)", arrayOf<Any?>(copy.noteId))
            sql.execSQL("UPDATE notes SET cursor = NULL WHERE id = ?", arrayOf<Any?>(copy.noteId))
            sql.setTransactionSuccessful()
        } finally {
            sql.endTransaction()
        }
    }
}
