package app.penmoss.data

import androidx.room.withTransaction
import app.penmoss.engine.bridge.DirectoryEntry
import app.penmoss.engine.bridge.PageNote
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine

/**
 * Notes the editor makes here (A303, T40 P5): a wikilink's new note, and daily and weekly notes,
 * with the directory a wikilink is picked from and the Journal calendar's marks.
 */
class PeriodicNotes(
    private val db: PenmossDatabase,
    private val now: () -> Long,
    private val placement: NotePlacement,
) {
    private val notes = db.notes()
    private val updates = db.updates()

    // --- wikilinks (A303) ---

    /** The phone's notes, newest first, each with its folder's name. */
    fun observeDirectory(): Flow<List<DirectoryEntry>> =
        combine(notes.observeDirectory(), db.folders().observeAll()) { rows, folders ->
            val names = folders.associate { it.id to it.name }
            rows.map { DirectoryEntry(it.id, it.title, it.folderId?.let(names::get)) }
        }

    /**
     * Stores a daily or weekly note the editor made (T40 P5): its whole content as one pending
     * edit, filed through the daily intent once uploaded. True when the note was stored here.
     *
     * - A note the phone lists is just opened, whether or not it holds the content: Today twice
     *   offline makes one note, and a note listed but not fetched yet is fetched by its screen
     *   (offline: unavailable), never rebuilt from this phone's template (review R1).
     * - A note in Trash is restored here at once, as the web's Today does, and filed through the
     *   daily intent, so it lands under Journal (A144, review S3); a move made here and still
     *   to file is kept instead.
     * - A note deleted for good is made afresh: its row and synced edits go, its kept-apart
     *   edits stay for their conflict copy, as a purge leaves them.
     */
    suspend fun addPeriodicNote(note: PageNote, kind: String, period: String, fileKind: String, fileDate: String): Boolean =
        db.withTransaction {
            val existing = notes.note(note.id)
            if (existing != null && !existing.gone) {
                if (existing.kind == "note" || existing.period == null) {
                    notes.updateKindPeriod(note.id, kind, period)
                }
                if (existing.deleted) {
                    // Cancels a move to Trash never tried, or queues a restore (A430).
                    notes.restoreHere(note.id, now())
                    // Then filed under Journal, unless a move made here waits to be filed first
                    // (moved, then trashed, A430): that choice stands (review R-N1).
                    val moveWaiting = existing.toFile && existing.fileKind == null
                    if (!moveWaiting) notes.fileDaily(note.id, fileKind, fileDate)
                }
                // Listed: the server has the note, so nothing is stored here, held or not. The
                // note's screen fetches what it does not hold, as the web's `ensurePeriodic`
                // leaves a listed note to the normal open; offline, it says the note is
                // unavailable. The page's bytes match the server's only for the same template
                // and codec, so storing them could add a second body to the note (A4, review R1).
                return@withTransaction false
            }
            if (existing != null) {
                updates.deleteSynced(note.id)
                notes.delete(note.id)
            }
            notes.insert(NoteEntity(note.id, title = note.title, updatedAt = now(), kind = kind, period = period, toFile = true))
            updates.insert(UpdateEntity(noteId = note.id, state = UpdateEntity.PENDING, update = note.update))
            notes.fileDaily(note.id, fileKind, fileDate)
            // Listed at the top level at once, offline too; the tree files it under Journal (T40 P5).
            placement.placeAtEnd(note.id, null)
            true
        }

    /** Every daily or weekly note's kind and period, for the Journal calendar's marks (T40 P5). */
    fun observeJournalMarks(): Flow<List<JournalMark>> = notes.observeJournalMarks()

    /**
     * Stores a note the editor made (a link's new note, A303): its whole content as one
     * pending edit, filed in `fileIn` once uploaded. A note already stored is left alone.
     */
    suspend fun addLocalNote(note: PageNote, fileIn: String?): Boolean = db.withTransaction {
        if (notes.note(note.id) != null) return@withTransaction false
        notes.insert(NoteEntity(note.id, title = note.title, updatedAt = now(), toFile = true, fileIn = fileIn, moveNotebook = placement.notebookOfFolder(fileIn)))
        updates.insert(UpdateEntity(noteId = note.id, state = UpdateEntity.PENDING, update = note.update))
        // Listed in its folder at once, offline too (T38); the tree says so once it is filed.
        placement.placeAtEnd(note.id, fileIn?.takeIf { placement.folderExists(it) })
        true
    }
}
