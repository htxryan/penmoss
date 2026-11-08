package app.penmoss.engine.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** JSON as the Penmoss API speaks it: unknown fields are ignored, so the server can add some. */
val PenmossJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
}

/** One row of `GET /sync/changes`: a note whose index row changed after the client's clock. */
@Serializable
data class ChangedNote(
    val id: String,
    val clock: Long = 0,
    val title: String = "",
    val excerpt: String = "",
    val updatedAt: Long = 0,
    val deleted: Boolean = false,
    val purged: Boolean = false,
    /** The NoteDoc's index seq for this row: later rows have higher ones (T40 P3a, A431). */
    val seq: Long = 0,
    /** A daily or weekly note's kind and period (T40 P5): regular notes carry neither. */
    val kind: String? = null,
    val period: String? = null,
    /**
     * The notes this one links to or embeds, distinct and sorted (T40 P7, A473), from D1's links
     * index; null from a server before P7, which leaves what the phone has alone.
     */
    val links: List<String>? = null,
    /**
     * The note's tags, frontmatter and inline, sorted, from the server's index (T40 P6, FD3,
     * TG1); none for a note in Trash. Null from an older server, which leaves what Room holds.
     */
    val tags: List<String>? = null,
)

@Serializable
data class ChangesPage(val clock: Long, val hasMore: Boolean = false, val notes: List<ChangedNote> = emptyList())

/**
 * One note of a `/sync/batch` request. Kotlin never computes a state vector: it sends back
 * the one the server last returned (an opaque cursor, A280), or none for the whole note.
 * `update` is the list of this device's unconfirmed edits, applied in order.
 */
@Serializable
data class BatchEntry(
    val id: String,
    val stateVector: String? = null,
    val update: List<String>? = null,
    val epoch: String? = null,
    /**
     * Ask for the note's plain text (T40 P6, FD4): the server sends it only when it differs from
     * the copy whose SHA-256 is [textHash]. Never on a metered background pass (A328).
     */
    val text: Boolean? = null,
    val textHash: String? = null,
    /**
     * The folder to file the note in on its first upload (T43, fix c): a folder id, or JSON null
     * for the top level; absent (null here) when the phone has filed it or is not asking. The
     * server files it only while its registry does not have the note, falling back within the
     * notebook (A764) when the folder is gone, and answers [BatchNoteReply.filed].
     */
    val folderId: kotlinx.serialization.json.JsonElement? = null,
)

@Serializable
data class BatchRequest(val notes: List<BatchEntry>)

@Serializable
data class BatchNoteReply(
    val id: String,
    val epoch: String? = null,
    val update: String = "",
    val stateVector: String? = null,
    val error: String? = null,
    val deferred: Boolean = false,
    /** How many of the uploaded updates the note now holds, in order (A289); null when none were sent. */
    val applied: Int? = null,
    /** The note's plain text, when asked and changed (T40 P6, FD4), capped at 256 KB. */
    val text: String? = null,
    /** Its headings, one per line, sent with [text] (the index's headings column). */
    val headings: String? = null,
    /** The SHA-256 of the server's text and headings: alone, it says the phone's copy is current. */
    val textHash: String? = null,
    /** Filed by this upload (T43, fix c): where; null when not (an older server, or filed already). */
    val filed: BatchFiled? = null,
)

/** Where `/sync/batch` filed a note on its first upload (T43, fix c): null is the top level. */
@Serializable
data class BatchFiled(val folderId: String? = null)

@Serializable
data class BatchReply(val notes: List<BatchNoteReply>)

/** `GET /sync/tree` (A281): the folder tree and where each note is filed, as plain JSON. */
@Serializable
data class SyncTree(
    val hash: String,
    val unchanged: Boolean = false,
    val rootSortMode: String = "manual",
    val folders: List<TreeFolder> = emptyList(),
    val notes: List<TreeNote> = emptyList(),
    /**
     * The user's theme and mode as the server resolved them (T33, A305): `{ mode, theme }`,
     * the theme with its light and dark colours by token name. Kept as JSON: the native
     * screens read a few colours from it and the editor page gets it as it came.
     */
    val appearance: JsonObject? = null,
    /** Where the user's captures go, as the web and Mac apps remember it (T34, A336). */
    val capture: CaptureSetting? = null,
    /**
     * The user's settings the phone shows and changes (T40 P1, A410), as the server reads them:
     * each one set and readable by key (`theme.mode`, `timeZone`…), and the custom themes,
     * validated, under `theme.custom.<id>`. Null from a server without the settings channel.
     */
    val settings: JsonObject? = null,
    /**
     * The default notebook's name (T43, A751): absent from a server before notebooks, or while
     * the person has not named it, which reads as "Personal".
     */
    val defaultNotebook: String? = null,
    /**
     * A git notebook's device map (A1014): every `device/<key>` setting in its WorkspaceDoc, as
     * the Mac writes them. The device's settings when this is the Journal notebook and there is no
     * account. Never from the Penmoss server.
     */
    val device: JsonObject? = null,
)

/** A git notebook's device map after a read or a change (A1014). */
@Serializable
data class DeviceSettingsReply(val device: JsonObject = JsonObject(emptyMap()), val changed: Boolean = false)

/**
 * `PUT /api/settings` (T40 P1, A410): the settings to change (a null value removes one, which
 * brings back its default) and what the phone last saw of each, its base. One changed elsewhere
 * since is refused (409 `setting_changed`, naming it in [ApiException.keys]).
 */
@Serializable
data class SettingsChange(val set: JsonObject, val base: JsonObject)

/** The settings as the server has them after a change, as `/sync/tree` would send them. */
@Serializable
data class SettingsReply(val settings: JsonObject = JsonObject(emptyMap()), val changed: Boolean = false)

/** Where captures go, and the time zone a capture made now is read in (T34, A336, A344). */
@Serializable
data class CaptureSetting(val destination: String = CaptureRequest.DAILY, val timeZone: String? = null)

/**
 * `POST /api/capture` (T34, A335): a capture stored on the phone. `id` names it, so a retry
 * adds nothing; `capturedAt` (epoch ms) picks the day's note; `remember` makes `destination`
 * the choice every app starts on.
 */
@Serializable
data class CaptureRequest(
    val id: String,
    val text: String,
    val destination: String,
    val capturedAt: Long,
    val remember: Boolean = false,
    /** The time zone the day and time are read in, as it was when the capture was made (A344). */
    val timeZone: String? = null,
) {
    companion object {
        /** Today's note, under `## Captures`. */
        const val DAILY = "daily"

        /** A new note in the Inbox folder. */
        const val INBOX = "inbox"
    }
}

@Serializable
data class CaptureReply(val id: String, val noteId: String, val destination: String, val changed: Boolean = false)

@Serializable
data class TreeFolder(
    val id: String,
    val name: String,
    val parentId: String? = null,
    val position: String = "",
    val sortMode: String = "manual",
    /** A notebook's own folder (T43, A750): only ever at the top level; absent otherwise. */
    val notebook: Boolean = false,
)

@Serializable
data class TreeNote(
    val id: String,
    val folderId: String? = null,
    val position: String = "",
    /** A daily or weekly note's kind and period (T40 P5): regular notes carry neither. */
    val kind: String? = null,
    val period: String? = null,
)

/** One hit of `GET /api/search`. Matched words sit between U+0002 and U+0003. */
@Serializable
data class SearchHit(
    val id: String,
    val title: String = "",
    val snippet: String = "",
    val updatedAt: Long = 0,
    /** The title with its matched words marked (T40 P6, FD1). */
    val titleHighlighted: String = "",
    /** The section that matched (semantic results). */
    val heading: String? = null,
    val tags: List<String> = emptyList(),
    /** `full-text`, `semantic`, or both (T23). */
    val sources: List<String> = emptyList(),
    /** The notebook the note is in (T43, A752): absent from a server before notebooks. */
    val notebook: SearchNotebook? = null,
)

/** A search result's notebook (T43): its id (`default` for the default notebook) and name. */
@Serializable
data class SearchNotebook(val id: String, val name: String = "")

/** The search modes (T23), as the route and the web name them. */
enum class SearchMode(val wire: String, val label: String) {
    FULL_TEXT("full-text", "Full-text"),
    SEMANTIC("semantic", "Semantic"),
    HYBRID("hybrid", "Hybrid"),
    ;

    companion object {
        fun of(wire: String?): SearchMode = entries.firstOrNull { it.wire == wire } ?: FULL_TEXT
    }
}

/** The filters of a search (T40 P6, FD3), as the route takes them; null: no filter. */
data class SearchFilters(
    /** A folder, with its subfolders. */
    val folderId: String? = null,
    /** A tag, with the tags nested under it. */
    val tag: String? = null,
    /** Updated at or after this time (epoch ms). */
    val updatedAfter: Long? = null,
    /**
     * The notebooks open on this phone (T43, A752), sent as `notebooks=`: null sends none (every
     * notebook open). Not a filter the person sets, so [none] leaves it out.
     */
    val notebooks: List<String>? = null,
) {
    val none: Boolean get() = folderId == null && tag == null && updatedAfter == null
}

@Serializable
data class SearchReply(val results: List<SearchHit> = emptyList(), val notice: String? = null)

/** The id of a note the server made or found (`POST /api/daily`). */
@Serializable
data class NoteRef(val id: String, val title: String? = null)

/** A daily or weekly note `POST /api/daily` filed in the Journal (T40 P5): its id. */
@Serializable
data class DailyNoteRef(val id: String, val created: Boolean = false)

/** One tag of `GET /api/tags` and how many notes carry it (T18). */
/** A folder a note is in, null being the top level: a move's precondition (A359). */
data class InFolder(val folderId: String?)

/** A folder as the folder intent routes answer it (T40 P4, NT2–NT7). */
@Serializable
data class FolderRef(
    val id: String,
    val name: String,
    val parentId: String? = null,
    val sortMode: String = "manual",
    /** Made in Trash with its deleted notebook: its parent was gone (T43, A757). */
    val inTrash: Boolean = false,
    /** The notebook the folder is in (T43): with [inTrash], the deleted one it went to Trash with. */
    val notebook: FolderNotebook? = null,
)

/** A folder reply's notebook (T43): its name, and its id unless the token may not see it. */
@Serializable
data class FolderNotebook(val id: String? = null, val name: String = "")

/** Where `POST /api/notes/:id/move` filed the note (T43, A757): the folder the server used. */
data class FiledNote(val folderId: String?)

/** A notebook as a refusal names it (T43, A757): `{ id, name }`. */
@Serializable
data class NotebookRef(val id: String, val name: String = "")

/** A manual-order anchor among notes or folders (NT7): immediately before or after the sibling. */
data class NotePlace(val before: String? = null, val after: String? = null)

/** A manual-order anchor among a folder's subfolders (NT7). */
data class FolderPlace(val before: String? = null, val after: String? = null)

/**
 * Changes to a folder (T40 P4): only set fields are sent. `fromName` and
 * `fromParentId` are preconditions when [checkName] and [checkParent]: the
 * change is refused (409) when the server no longer holds them, so an older
 * change never undoes a newer one (A359's rule for moves).
 */
data class FolderPatch(
    val name: String? = null,
    val fromName: String? = null,
    val checkName: Boolean = false,
    val parentId: String? = null,
    val changeParent: Boolean = false,
    val fromParentId: String? = null,
    val checkParent: Boolean = false,
    val sortMode: String? = null,
    val place: FolderPlace? = null,
    /** Turn into a notebook (true) or back into a folder (false), T43 (A756); null leaves it. */
    val notebook: Boolean? = null,
    /**
     * With a move ([changeParent]): the notebook the phone saw the folder in when the move was
     * made, `default` for the default notebook (T43, A766). Sent as `fromNotebook`; the server
     * records the notebook in its notes' own documents only when it agrees.
     */
    val fromNotebook: String? = null,
)

@Serializable
data class TagCount(val name: String, val notes: Int = 0)

@Serializable
data class TagList(val tags: List<TagCount> = emptyList())

/** `POST /api/tags/rename`'s answer (T24; T40 P6, TG3): the rename started, and the notes it covers. */
@Serializable
data class TagRenameReply(val from: String, val to: String, val notes: List<String> = emptyList())

/** What `POST /api/notes/:id/trash` answers (T40 P3a): the folder it was in (null: the top level) and when. */
@Serializable
data class TrashedNote(
    val folderId: String? = null,
    val deletedAt: Long = 0,
    /** The index seq the move was made after: `/sync/changes` rows with a higher seq show it. */
    val seq: Long = 0,
)

/**
 * What `POST /api/notes/:id/restore` answers: the folder it was deleted from (null: the top
 * level, or unknown), whether it was in Trash (a server from before T40 P3a does not say: true),
 * and the index seq the restore was made after.
 */
@Serializable
data class RestoredNote(val folderId: String? = null, val restored: Boolean = true, val seq: Long = 0)

/** One note `GET /api/trash` lists (T21): deleted on any device, purged 30 days after [deletedAt]. */
@Serializable
data class TrashListed(
    val id: String,
    val title: String = "",
    val deletedAt: Long = 0,
    val updatedAt: Long = 0,
    /** Who moved it there (T42, #113, A574; T40 NT30, A655): absent from an older server. */
    @Serializable(with = DeletedBySerializer::class)
    val deletedBy: FolderDeleter? = null,
    /**
     * It went to Trash with a deleted notebook (T43, A755): it comes back when the notebook is
     * restored, so Trash lists it with the notebook rather than on its own.
     */
    val withNotebook: Boolean = false,
)

@Serializable
data class TrashList(val notes: List<TrashListed> = emptyList())

/**
 * Who deleted a folder, or moved a note to Trash, as the server recorded it (T42, A560, A574): a
 * device's or an agent's name. A malformed one names no one ([DeletedBySerializer], `deletedByText`).
 */
@Serializable
data class FolderDeleter(val label: String = "", val kind: String = "device")

/**
 * Reads `deletedBy` as the web's `parseDeletedBy` (review N4): an object with a non-blank string
 * `label` (trimmed) and a `kind` of "agent" or "device", else null. Any other value, a string or a
 * number say, names no one instead of failing the whole Trash list.
 */
object DeletedBySerializer : KSerializer<FolderDeleter?> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): FolderDeleter? {
        val value = (decoder as? JsonDecoder)?.decodeJsonElement() as? JsonObject ?: return null
        val label = (value["label"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val kind = (value["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it == "agent" || it == "device" } ?: return null
        return FolderDeleter(label, kind)
    }

    override fun serialize(encoder: Encoder, value: FolderDeleter?) {
        val json = encoder as JsonEncoder
        json.encodeJsonElement(value?.let { json.json.encodeToJsonElement(FolderDeleter.serializer(), it) } ?: JsonNull)
    }
}

/**
 * One deleted folder `GET /api/folders/trash` lists (T42, A560; T40 P9, NT25): where it was,
 * when and by whom it was deleted, and what it held (its subfolders at any depth, their notes).
 */
@Serializable
data class TrashedFolderListed(
    val id: String,
    val name: String = "Untitled folder",
    val parentId: String? = null,
    val deletedAt: Long = 0,
    @Serializable(with = DeletedBySerializer::class)
    val deletedBy: FolderDeleter? = null,
    val folders: Int = 0,
    val notes: Int = 0,
    /** A deleted notebook, with its notes (T43, A755). */
    val notebook: Boolean = false,
)

@Serializable
data class FolderTrashList(val folders: List<TrashedFolderListed> = emptyList())

/**
 * `POST /api/folders/:id/restore` (T40 P9, NT25): whether it was in Trash, whether the folder it
 * was in is gone (it then comes back in the nearest folder above within its notebook, T43 A757,
 * named by [RestoredFolder.parentId]), the notes put back, and those left where they were moved since.
 */
@Serializable
data class RestoredFolder(
    val id: String = "",
    val restored: Boolean = false,
    val parentGone: Boolean = false,
    val notes: Int = 0,
    val skipped: List<String> = emptyList(),
    /** A notebook brought back with its notes (T43, A755). */
    val notebook: Boolean = false,
    /**
     * Where it came back (T43, A757): `parentId` as the server sent it, a folder id or JSON null
     * for the top level (kept as JSON, as this client reads a null as absent otherwise); an empty
     * object when an older server did not say. Read through [parentKnown] and [parentId].
     */
    @kotlinx.serialization.SerialName("parentId")
    val parent: kotlinx.serialization.json.JsonElement = NOT_SAID,
) {
    /** The server said where it came back. */
    val parentKnown: Boolean get() = parent != NOT_SAID

    /** The folder it came back in (null: the top level, or not said; see [parentKnown]). */
    val parentId: String? get() = (parent as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.content

    companion object {
        /** No `parentId` in the reply: an older server. */
        val NOT_SAID = kotlinx.serialization.json.JsonObject(emptyMap())
    }
}

/** The agent token an activity entry names (T42, A561). */
@Serializable
data class ActivityActor(val id: String, val label: String = "")

/**
 * One change an agent token made to folders, note places, settings or tags (`GET
 * /api/agent-activity`, T42, A561; T40 P9, AC11), newest first, and whether it was undone.
 */
@Serializable
data class AgentActivityEntry(
    val id: Long,
    val at: Long = 0,
    val actor: ActivityActor,
    val kinds: List<String> = emptyList(),
    val summary: String = "",
    val undoneAt: Long? = null,
    val undoneBy: String? = null,
)

@Serializable
data class AgentActivityList(val entries: List<AgentActivityEntry> = emptyList())

/** `POST /api/agent-activity/:id/undo`: undone, or undone before; [notice] says what it could not put back. */
@Serializable
data class ActivityUndone(val id: Long = 0, val undone: Boolean = true, val alreadyUndone: Boolean = false, val notice: String? = null)

/**
 * `GET /api/notes/:id/backlinks` (T16; T40 P7, LK5, LK6): the notes linking to a note, each link
 * with the text around it, and the notes mentioning its title without a link.
 */
@Serializable
data class BacklinksReply(
    val title: String = "",
    val linked: List<LinkedRow> = emptyList(),
    val unlinked: List<MentionRow> = emptyList(),
) {
    /** One link (or embed) of a note to this one, with its block's text ([context]: text or links). */
    @Serializable
    data class LinkedRow(
        val id: String,
        val title: String = "",
        val updatedAt: Long = 0,
        val heading: String? = null,
        val embed: Boolean = false,
        val count: Int = 1,
        val context: List<JsonElement> = emptyList(),
    )

    /** A note mentioning the title: [snippet] marks the matched words with U+0002 and U+0003. */
    @Serializable
    data class MentionRow(
        val id: String,
        val title: String = "",
        val updatedAt: Long = 0,
        val snippet: String = "",
    )
}
