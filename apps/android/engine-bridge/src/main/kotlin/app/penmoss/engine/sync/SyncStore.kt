package app.penmoss.engine.sync

import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree

/**
 * One stored Yjs update: opaque base64, by the store's own id for it. A pending
 * edit also carries the epoch of the copy the editor made it on (A291): an edit
 * made on a copy the server has since replaced by a restore is never uploaded.
 */
data class StoredUpdate(val id: Long, val update: String, val epoch: String? = null)

/**
 * What the engine needs to exchange one note's content (A280). The note is
 * kept as updates the server has (`syncedIds`) and edits it has not confirmed
 * (`pending`); `cursor` is the state vector the server last sent, which only
 * the server reads.
 */
data class NoteContent(
    val noteId: String,
    val cursor: String?,
    val epoch: String?,
    val syncedIds: List<Long>,
    val pending: List<StoredUpdate>,
    /** The workspace clock of the note's latest known change; content synced now covers it. */
    val clock: Long,
    /** The clock its content last synced at; -1 while never fetched. */
    val contentClock: Long = -1,
    /** The SHA-256 of the note's text in the offline index (T40 P6, FD4); null when none. */
    val textHash: String? = null,
    /**
     * Made on this device and never filed nor uploaded (T43, fix c): the folder it was made in
     * (`folderId` null: the top level), sent with its first upload so the server files it there.
     * Null when there is nothing to ask.
     */
    val fileOnUpload: app.penmoss.engine.api.InFolder? = null,
) {
    /** Unsent edits, or a change the server indexed after the content last synced. */
    val due: Boolean get() = pending.isNotEmpty() || clock > contentClock
}

/**
 * The device's store (Room in the app, a map in tests). Each call is one
 * transaction, so a reply is stored whole or not at all: a cursor is never
 * saved without the update it describes.
 */
interface SyncStore {
    /** The workspace clock `/sync/changes` last reached. */
    suspend fun changesClock(): Long

    /** The hash of the folder tree last stored, or null. */
    suspend fun treeHash(): String?

    /** Replaces the folder tree and note placements. */
    suspend fun saveTree(tree: SyncTree)

    /** Stores a page of changed notes' metadata and its clock. */
    suspend fun saveChanges(page: ChangesPage)

    /**
     * Notes whose content to exchange now, most urgent first: those with unconfirmed
     * edits, then held notes that changed since their content last synced, then (with
     * `prefetch`) live notes this device has never fetched, newest first, and held notes
     * whose text the offline index lacks (T40 P6, FD4).
     */
    suspend fun dueContent(limit: Int, prefetch: Boolean, skip: Set<String>): List<NoteContent>

    /** One note's content state (an empty one for a note never fetched). */
    suspend fun content(noteId: String): NoteContent

    /** Stores what an exchange decided, in one transaction. */
    suspend fun saveExchange(result: ExchangeResult)
}
