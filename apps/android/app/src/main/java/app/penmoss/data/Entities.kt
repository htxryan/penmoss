package app.penmoss.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A note's metadata from the API (`/sync/changes`, `/sync/tree`) and its sync
 * state (T32, A11): the Room cache the native screens read. Content lives in
 * [UpdateEntity] rows as opaque Yjs updates; nothing here is derived from them.
 */
@Entity(tableName = "notes", indices = [Index("folderId"), Index("updatedAt")])
data class NoteEntity(
    @PrimaryKey val id: String,
    val title: String = "",
    val excerpt: String = "",
    /** Epoch ms of the last change the server indexed. */
    val updatedAt: Long = 0,
    /** The workspace clock of that change (`/sync/changes`). */
    val clock: Long = 0,
    /** In Trash. */
    val deleted: Boolean = false,
    /** The folder the tree shows it in (null: the top level). */
    val folderId: String? = null,
    val position: String = "",
    /** The workspace clock its content last synced at; -1 while it has never been fetched. */
    val contentClock: Long = -1,
    /** The server's state vector after the last exchange: an opaque cursor (A280). */
    val cursor: String? = null,
    val epoch: String? = null,
    /** The server no longer has it (deleted for good). */
    val gone: Boolean = false,
    /**
     * Made on this phone (a link's new note, a conflict copy, A303, A306): once its content is
     * uploaded it is filed in [fileIn] (null: the top level), and this is cleared.
     */
    @ColumnInfo(defaultValue = "0") val toFile: Boolean = false,
    val fileIn: String? = null,
    /**
     * A move made on this phone (T38, A359): the folder the tree showed the note in when it was
     * moved ([movedFrom], null: the top level). The server files the move only if the note is
     * still there, so a move made elsewhere since wins. False for notes made here (A303), which
     * the tree has never placed.
     */
    @ColumnInfo(defaultValue = "0") val checkFrom: Boolean = false,
    val movedFrom: String? = null,
    /**
     * A move to Trash or a restore asked on this phone (T40 P3a, A430), as [TRASH_QUEUED] and
     * the rest; 0 when none. While one is under way, [deleted] shows what was asked, whatever
     * an older `/sync/changes` says, so the note never flickers back.
     */
    @ColumnInfo(defaultValue = "0") val trashChange: Int = 0,
    /**
     * When [trashChange] was asked (queued: this phone's clock) or when the server moved it to
     * Trash (sent: the server's), for display and order only: never compared across clocks.
     */
    @ColumnInfo(defaultValue = "0") val trashChangeAt: Long = 0,
    /**
     * The newest index seq this phone has seen for the note (`seq` in `/sync/changes`, or after
     * its own restore): a move to Trash sends it, and the server refuses it only for a restore
     * made elsewhere that this phone has not seen (A431).
     */
    @ColumnInfo(defaultValue = "0") val seq: Long = 0,
    /**
     * For a move to Trash asked here: the [seq] this phone had seen when it was asked, sent as
     * `knownSeq`. For a sent change: the index seq the server made it after; rows with a higher
     * seq show it.
     */
    @ColumnInfo(defaultValue = "0") val trashSeq: Long = 0,
    /**
     * A request for this note ([TRASH_SENDING] or [RESTORE_SENDING]) went out and its answer
     * never came (offline mid-request, a server error, the app stopped): the server may have
     * applied it. Until an answer settles it, Undo or Restore queues the opposite request
     * rather than cancelling, both routes being idempotent (second review of #94, A430).
     */
    @ColumnInfo(defaultValue = "0") val trashTried: Boolean = false,
    /**
     * A move to Trash a restore on another device overruled (409 `restored_since`, A430), to
     * say so once: kept here, so a refusal met by a background pass is still said.
     */
    @ColumnInfo(defaultValue = "0") val trashNotice: Boolean = false,
    /**
     * A reorder made here (T40 P4, NT7): the manual-order anchor among the note's folder,
     * immediately before [filePlaceBefore] or after [filePlaceAfter] (exactly one set). Sent
     * with the filing as `place`, computed authoritatively by the server; a missing anchor
     * means the end of the list.
     */
    val filePlaceBefore: String? = null,
    val filePlaceAfter: String? = null,
    /**
     * A daily or weekly note's kind and period (T40 P5): what the calendar marks, from
     * `/sync/changes` and `/sync/tree` (identity the server indexed). Regular notes hold kind
     * `note` and no period. Never derived from the note's bytes here (A11).
     */
    @ColumnInfo(defaultValue = "'note'")
    val kind: String = "note",
    val period: String? = null,
    /**
     * A periodic note made here (T40 P5) files through `POST /api/daily` instead of the move
     * route: [fileKind] is `daily` or `weekly`, [fileDate] the explicit calendar day it was
     * made for (never null, so a midnight between making and filing still files the same note).
     */
    val fileKind: String? = null,
    val fileDate: String? = null,
    /**
     * When this phone last opened the note (T40 P6, FD7), its own clock, never synced: Home's
     * Recent and the Ctrl+E switcher rank by the later of this and [updatedAt], as the web does.
     */
    @ColumnInfo(defaultValue = "0") val openedAt: Long = 0,
    /**
     * The offline index lacks the note's current text (T40 P6, FD4): its content changed on a
     * pass that asked for no text (metered, A328), or it was fetched before the index existed.
     * The next pass that may prefetch asks for it.
     */
    @ColumnInfo(defaultValue = "1") val textDue: Boolean = true,
    /** The SHA-256 of the text in the offline index, sent so the server sends text only when it differs. */
    val textHash: String? = null,
    /**
     * The notebook the phone saw the note in when the move waiting to file ([toFile]) was made,
     * `default` for the default notebook (T43, A766): sent as the move's `fromNotebook`. Kept
     * across later moves made before it files, as [movedFrom] is; a note made here holds the
     * notebook it was made in. Null for a move queued before schema 19 (worked out at sending).
     */
    val moveNotebook: String? = null,
) {
    companion object {
        /** Moved to Trash here, not sent yet: Restore cancels it, unless [trashTried]. */
        const val TRASH_QUEUED = 1

        /** The server moved it to Trash; held until an index row after [trashSeq] arrives. */
        const val TRASH_SENT = 2

        /** Restored here, not sent yet: Move to Trash cancels it, unless [trashTried]. */
        const val RESTORE_QUEUED = 3

        /** The server restored it; held until an index row after [trashSeq] arrives. */
        const val RESTORE_SENT = 4

        /** The move to Trash is in flight: Restore meanwhile queues a restore, never a cancel. */
        const val TRASH_SENDING = 5

        /** The restore is in flight: Move to Trash meanwhile queues a move, never a cancel. */
        const val RESTORE_SENDING = 6

        /**
         * In Trash with a notebook deleted here (T43, A755): nothing to send, as the notebook's
         * delete trashes it on the server; held as [TRASH_SENT] is. Trash lists it with the notebook.
         */
        const val TRASH_WITH_NOTEBOOK = 7
    }
}

@Entity(tableName = "folders")
data class FolderEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** The parent the tree shows (cycles and orphans resolved by the server, A17). */
    val parentId: String?,
    val position: String,
    val sortMode: String,
    /** A notebook's own folder (T43, A750): a top-level folder the tree flags. */
    @ColumnInfo(defaultValue = "0") val notebook: Boolean = false,
)

/**
 * A folder change made on this phone, in the order it was asked (T40 P4, NT2–NT7): the queue
 * `FolderSender` sends before the notes are filed, so a note filed into a folder made offline
 * finds it there. Each row carries what the server needs plus the precondition the caller saw
 * (`fromName`, `fromParentId` when checked): a change overtaken elsewhere is refused (409) and
 * dropped, as moves are (A359). The queue survives sign-out, and every row counts as unsent.
 */
@Entity(tableName = "folder_ops")
data class FolderOpEntity(
    @PrimaryKey(autoGenerate = true) val rowId: Long = 0,
    /** The folder changed; null for the top level's sort mode (ROOT_SORT). */
    val folderId: String?,
    /** CREATE, RENAME, MOVE, SORT, REORDER, DELETE, ROOT_SORT, NOTEBOOK or ROOT_NAME. */
    val kind: String,
    /** The new name (CREATE, RENAME), or the default notebook's (ROOT_NAME, T43). */
    val name: String? = null,
    /** Precondition for RENAME when [checkName]: the name seen when it was asked. */
    val fromName: String? = null,
    @ColumnInfo(defaultValue = "0") val checkName: Boolean = false,
    /** The new parent, null the top level (CREATE, MOVE). */
    val parentId: String? = null,
    /** Precondition for MOVE when [checkParent]: the parent seen when it was asked. */
    val fromParentId: String? = null,
    @ColumnInfo(defaultValue = "0") val checkParent: Boolean = false,
    /** The new sort mode (SORT, ROOT_SORT). */
    val sortMode: String? = null,
    /** The manual-order anchor among the folder's siblings (REORDER): exactly one set. */
    val placeBefore: String? = null,
    val placeAfter: String? = null,
    /** The folder's display name when the change was asked: what a dropped-change notice names. */
    val label: String? = null,
    /**
     * A request for this change went out and its answer never came (offline mid-request, a
     * server error, the app stopped): the server may hold it, as a move to Trash tried with
     * no answer may (A430, T40 P4 review B3). Deleting a folder with a tried CREATE queued
     * sends the delete instead of cancelling both, so the folder does not reappear.
     */
    @ColumnInfo(defaultValue = "0") val tried: Boolean = false,
    /**
     * T43 (A750, A756): a CREATE that makes a notebook, or the flag a NOTEBOOK change sets
     * (true: Turn into notebook; false: Turn back into a folder).
     */
    @ColumnInfo(defaultValue = "0") val notebook: Boolean = false,
    /**
     * A MOVE's `fromNotebook` (T43, A766): the notebook the phone saw the folder in when the move
     * was made, `default` for the default notebook. Null for one queued before schema 19.
     */
    val fromNotebook: String? = null,
) {
    companion object {
        const val CREATE = "CREATE"
        const val RENAME = "RENAME"
        const val MOVE = "MOVE"
        const val SORT = "SORT"
        const val REORDER = "REORDER"
        const val DELETE = "DELETE"
        const val ROOT_SORT = "ROOT_SORT"

        /** Turn a top-level folder into a notebook, or a notebook back into a folder (T43, A756). */
        const val NOTEBOOK = "NOTEBOOK"

        /** The default notebook's name (T43, A751): `PATCH /api/folders/root { notebookName }`. */
        const val ROOT_NAME = "ROOT_NAME"
    }
}

/** One stored Yjs update of a note: opaque base64 that Kotlin never decodes (A11). */
@Entity(tableName = "updates", indices = [Index("noteId", "state")])
data class UpdateEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val noteId: String,
    /** [SYNCED], [PENDING], [CONFLICT], [BASE], [COPIED], [KEPT], [RECOVERY] or [WITHHELD]. */
    val state: Int,
    @ColumnInfo(name = "data") val update: String,
    /**
     * For an edit made here: the epoch of the copy the editor made it on (A291). One made
     * on a copy a restore has since replaced is kept apart as a [CONFLICT], never sent.
     */
    val epoch: String? = null,
    /**
     * For a [COPIED] edit: the conflict copy that holds it (null when it changed nothing worth a
     * copy). For a [WITHHELD] row: the original the copy was brought back from (A886).
     */
    val copiedTo: String? = null,
) {
    companion object {
        /** The server has it. */
        const val SYNCED = 0

        /** Made on this device; the server has not confirmed it yet. */
        const val PENDING = 1

        /** Made on this device; the server will not take it (A5 restore, refused). Kept, never sent. */
        const val CONFLICT = 2

        /**
         * What the server had of a copy a restore (or a purge) replaced, kept with that copy's
         * epoch while [CONFLICT] edits made on it wait to become a conflict copy (A306).
         */
        const val BASE = 3

        /**
         * A [CONFLICT] edit now held by a conflict copy ([copiedTo]). Kept, with the [BASE] rows of
         * its epoch, while any edit of that copy may still come: a later edit of it may build on
         * this one (A309).
         */
        const val COPIED = 4

        /**
         * A [CONFLICT] edit no copy can be made of: what it was made on is not on this phone (a
         * T32 build kept it before base rows existed), or its bytes cannot be read. Kept, never
         * sent, never dropped, and counted on the Settings screen (A309).
         */
        const val KEPT = 5

        /**
         * A git notebook's copy of a note from before Android cleared its engine store (A886)
         * that the engine page could not bring back: kept, never sent, while the note itself
         * syncs again, until it is brought back or the person saves its text.
         */
        const val RECOVERY = 6

        /**
         * A git notebook's copy withheld from the push (A886): brought back after Android cleared
         * the engine store, its original then deleted for good on another device before the copy
         * first reached the branch. Kept, never sent, never retried, with every edit typed on it
         * (its rows of any other state join it), until the person saves its text, deletes it for
         * good or keeps and syncs it.
         */
        const val WITHHELD = 7
    }
}

/**
 * A picture stored on this phone (A304): pasted or picked here, waiting to upload or
 * uploaded, or fetched from the server to show. The bytes are a file named by the hash.
 */
@Entity(tableName = "attachments")
data class AttachmentEntity(
    @PrimaryKey val sha256: String,
    val ext: String,
    val size: Long,
    /** The note it was first added to, which the server records. */
    val noteId: String?,
    /** Added on this phone (kept until uploaded) rather than fetched to show (a cache). */
    val local: Boolean,
    /** The server has it. */
    val uploaded: Boolean,
    val attempts: Int = 0,
    /** When to try the upload again (epoch ms). */
    val nextAttemptAt: Long = 0,
    /** The server refused it for good (wrong type, too large, a hash mismatch). */
    val failed: Boolean = false,
    val createdAt: Long = 0,
)

/**
 * A quick capture saved on this phone (T34, A337): from the share sheet, the Quick Settings
 * tile or the widget, offline included. It waits here until `/api/capture` takes it (the
 * server adds it as the web and Mac apps do), after the pictures it names have uploaded.
 */
@Entity(tableName = "captures")
data class CaptureEntity(
    /** Names the capture to the server, so a retried request adds nothing. */
    @PrimaryKey val id: String,
    /** Markdown, pictures included as `![](attachments/<sha256>.<ext>)` lines. */
    val text: String,
    /** `daily` or `inbox` (CaptureRequest). */
    val destination: String,
    /** Epoch ms: the day's note it goes to, and the time it is shown with. */
    val capturedAt: Long,
    /** The person chose the other destination: the server remembers it for every app. */
    val remember: Boolean = false,
    /** The pictures it names, as `sha256.ext`, space-separated: uploaded before it is sent. */
    val pictures: String = "",
    val attempts: Int = 0,
    val nextAttemptAt: Long = 0,
    /** Why it cannot go as it is; null while it may still go. Kept, listed on Home (A345). */
    val refused: String? = null,
    /** The time zone its day and time are read in, as the phone knew it when it was made (A344). */
    val timeZone: String? = null,
    /** The server's last answer to it, when not a success: Home says why it waits (A345). */
    val lastStatus: Int? = null,
)

/** What Home says about captures waiting to be sent (A345). */
data class CapturesWaiting(
    val count: Int = 0,
    /** When the oldest was made (epoch ms). */
    val oldest: Long? = null,
    /** The server answered that it has no capture route: it is waiting for a deploy (A342). */
    val serverOutdated: Boolean = false,
)

@Entity(tableName = "settings")
data class SettingEntity(@PrimaryKey val key: String, val value: String)

/**
 * A synced setting changed on this phone and not sent yet (T40 P1, A411): one row per setting,
 * the latest change winning. It shows at once, laid over what the last `/sync/tree` sent, until
 * `PUT /api/settings` takes it, and survives sign-out like every unsent change (A360).
 */
@Entity(tableName = "pending_settings")
data class PendingSettingEntity(
    @PrimaryKey val key: String,
    /** The value to set, as JSON (`"dark"`, `true`); null removes the setting (its default again). */
    val value: String?,
    /**
     * What the phone last saw of it, as JSON, null for not set: the server takes the change only
     * while the setting still has this value, so a newer choice made elsewhere wins (A410).
     */
    val base: String?,
    /** Epoch ms of the latest change. */
    val changedAt: Long = 0,
    /**
     * The values sent for it whose outcome the phone does not know (a reply lost, or still on its
     * way), as a JSON array; null when none. The server may hold any of them: a tree or a 409
     * showing one is this phone's own change landing, not one made elsewhere (A411).
     */
    val sent: String? = null,
)

/** A row of the native note lists: only what they show, so a list of 5,000 stays light. */
/** A note in Trash as the phone holds it (T40 P3a): [trashChange] says what waits to be sent. */
data class TrashRow(
    val id: String,
    val title: String,
    val updatedAt: Long,
    val trashChange: Int,
    val trashChangeAt: Long,
)

/** A move to Trash a restore elsewhere overruled, not said yet ([NoteEntity.trashNotice]). */
data class TrashNotice(val id: String, val title: String)

data class NoteListRow(
    val id: String,
    val title: String,
    val excerpt: String,
    val updatedAt: Long,
    val folderId: String?,
    val position: String,
)

/** A daily or weekly note's kind and period (T40 P5): what the Journal calendar marks. */
data class JournalMark(val kind: String, val period: String)

/** A base or copied row, as cleanup sees it (A309). */
data class BaseRow(val id: Long, val noteId: String, val epoch: String?)

/**
 * The last version list read for a note (T40 P3b, NT16): the server's answer as JSON, so the
 * history screen still reads offline once it has loaded online. Replaced on each load.
 */
@Entity(tableName = "history_cache")
data class HistoryCacheEntity(
    @PrimaryKey val noteId: String,
    /** The `GET …/versions` answer, as JSON. */
    val json: String,
    /** Epoch ms of the load. */
    val fetchedAt: Long = 0,
)

/** A note as wikilinks see it (A303). */
data class DirectoryRow(val id: String, val title: String, val folderId: String?)

/**
 * One note linking to or embedding another (T40 P7, LK5, A473): the phone's offline backlinks
 * and graph. Filled from `/sync/changes` `links` (D1's links index, rebuildable, D6), and for a
 * note with edits not sent yet, from what the editor page reports of it. Never the only copy.
 */
@Entity(tableName = "note_links", primaryKeys = ["sourceId", "targetId"], indices = [Index("targetId")])
data class NoteLinkEntity(val sourceId: String, val targetId: String)

/** A note linking to the open one, as the Info sheet lists it offline (T40 P7, LK5). */
data class BacklinkSource(val id: String, val title: String, val excerpt: String, val updatedAt: Long)

/**
 * The last backlinks answer read for a note (T40 P7, LK5, LK6): the server's JSON, so the Info
 * sheet shows the text around each link and the unlinked mentions offline once it has loaded
 * online. Replaced on each load.
 */
@Entity(tableName = "backlinks_cache")
data class BacklinksCacheEntity(
    @PrimaryKey val noteId: String,
    /** The `GET …/backlinks` answer, as JSON. */
    val json: String,
    /** Epoch ms of the load. */
    val fetchedAt: Long = 0,
)
