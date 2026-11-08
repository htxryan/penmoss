package app.penmoss.engine.bridge

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/*
 * The editor's parity with the web (T40 P8): the bridge messages for Copy as Markdown and rich
 * text (ED9), paste and match style (ED11), the Markdown source (ED17), the + sheet and the
 * Block menu (ED4, ED5), toggles remembered per note (ED8) and the counts (NT24); then files
 * through the app (ED12) and pictures from web addresses (ED13). The page's side is in
 * `protocol.ts`; `bridge-v1.json` holds an example of each, checked by both suites.
 */

/** Copy as Markdown or rich text (T15), by the page's names. */
enum class CopyFormat(val wire: String) {
    MARKDOWN("markdown"),
    RICH("rich"),
    ;

    companion object {
        fun of(wire: String?): CopyFormat? = entries.firstOrNull { it.wire == wire }
    }
}

/** What a copy takes: the whole note (the ⋮ menu) or the selection (the selection's menu). */
enum class CopyScope(val wire: String) {
    NOTE("note"),
    SELECTION("selection"),
    ;

    companion object {
        fun of(wire: String?): CopyScope? = entries.firstOrNull { it.wire == wire }
    }
}

/** What a clipboard write carries: Markdown, rich text (HTML and readable text), or text (code). */
enum class ClipFormat(val wire: String) {
    MARKDOWN("markdown"),
    RICH("rich"),
    TEXT("text"),
    ;

    companion object {
        fun of(wire: String?): ClipFormat? = entries.firstOrNull { it.wire == wire }
    }
}

/** The Block menu's actions (ED5): the shared editor commands of the same names. */
enum class BlockAction(val wire: String) {
    MOVE_UP("moveUp"),
    MOVE_DOWN("moveDown"),
    DUPLICATE("duplicate"),
    DELETE("delete"),
    ;

    companion object {
        fun of(wire: String?): BlockAction? = entries.firstOrNull { it.wire == wire }
    }
}

/** What the catalogue is asked for: the + sheet's inserts, or Turn into's kinds. */
enum class BlockPurpose(val wire: String) {
    INSERT("insert"),
    TURN_INTO("turnInto"),
    ;

    companion object {
        fun of(wire: String?): BlockPurpose? = entries.firstOrNull { it.wire == wire }
    }
}

/** One entry of the + sheet or Turn into, as the slash menu shows it. */
data class BlockEntry(
    val id: String,
    val label: String,
    /** The slash menu's glyph (`H1`, `•`, `{}`). */
    val icon: String,
    val hint: String? = null,
    /** For Turn into: the selection's block is already this kind; null for the + sheet. */
    val active: Boolean? = null,
)

/** Counts of some text, as the web's status bar counts them (T41, A505). */
data class TextCounts(val words: Int, val characters: Int)

/** What a file chip's buttons ask (ED12): open the file in another app, or save a copy. */
enum class FileAction(val wire: String) {
    OPEN("open"),
    SAVE("save"),
    ;

    companion object {
        fun of(wire: String?): FileAction? = entries.firstOrNull { it.wire == wire }
    }
}

/** How pictures from web addresses show in a note (ED13): fetched, held for a tap, or not at all. */
enum class WebPictureMode(val wire: String) {
    ON("on"),
    WAIT("wait"),
    OFF("off"),
    ;

    companion object {
        fun of(wire: String?): WebPictureMode? = entries.firstOrNull { it.wire == wire }
    }
}

/** A file stored on the phone, to insert: the path the note holds and the name its chip shows. */
data class FileRef(val path: String, val name: String)

/** A stored file's size and type (`application/pdf`, `image/png`, `application/octet-stream`). */
data class StoredFile(val size: Long, val type: String)

/** The bounds of the file messages (ED12), as `protocol.ts` has them. */
object FileLimits {
    /** A file the note names: any extension core's `filePath` writes, pictures and PDFs included. */
    val PATH = Regex("^attachments/([0-9a-f]{64})\\.([a-z0-9]{1,10})$")

    /** The longest file name carried (a chip's name). */
    const val MAX_NAME = 255

    /** Files the document picker inserts at once. */
    const val MAX_INSERT = 20
}

/** The T40 P8 messages from the app to the page. */
sealed interface ParityToEditor : ToEditor {
    val noteId: String

    /**
     * Copy the note, or the selection the menu opened over (never the note instead: with nothing
     * selected the page says so); the page answers [ParityFromEditor.Clipboard].
     */
    data class Copy(override val noteId: String, val format: CopyFormat, val scope: CopyScope) : ParityToEditor

    /** Paste and match style: clipboard text the app read, pasted as ⌘⇧V pastes it. */
    data class InsertPlain(override val noteId: String, val text: String) : ParityToEditor

    /** Show the note's stored markdown, read-only ([on]), or the note again. */
    data class Source(override val noteId: String, val on: Boolean) : ParityToEditor

    /** The + sheet's or Turn into's entries for [query]; answered by [ParityFromEditor.Blocks]. */
    data class Blocks(override val noteId: String, val purpose: BlockPurpose, val query: String) : ParityToEditor

    /** Insert a catalogue block at the caret, as its slash-menu item does. */
    data class Insert(override val noteId: String, val item: String) : ParityToEditor

    /** Turn the selected blocks into a catalogue kind. */
    data class TurnInto(override val noteId: String, val item: String) : ParityToEditor

    /** One of the Block menu's actions on the block holding the caret. */
    data class Block(override val noteId: String, val action: BlockAction) : ParityToEditor

    /** The note's toggles as this phone left them, sent before `open`. */
    data class Folds(override val noteId: String, val folds: Map<String, Boolean>) : ParityToEditor

    /**
     * The selection menu opened (review B2): the page keeps what is selected and where, for the
     * menu's Copy as and Paste as plain text, since the WebView clears it as the menu closes.
     */
    data class CaptureSelection(override val noteId: String) : ParityToEditor

    /**
     * The snackbar's Undo after Delete block (re-review): the page undoes that delete only while
     * it is still the newest edit, and otherwise says so.
     */
    data class UndoDelete(override val noteId: String) : ParityToEditor

    /** The answer to [ParityFromEditor.File] and its bytes: stored on the phone, or not (A311). */
    data class FileStored(override val noteId: String, val path: String, val ok: Boolean) : ParityToEditor

    /** Files stored from the document picker: insert them at the selection. */
    data class InsertFiles(override val noteId: String, val files: List<FileRef>) : ParityToEditor

    /** The answer to [ParityFromEditor.FileInfo]: the file's size and type, or null when unknown. */
    data class FileInfo(override val noteId: String, val path: String, val info: StoredFile?) : ParityToEditor

    /** How pictures from web addresses show in this note, sent before `open`. */
    data class WebPictures(override val noteId: String, val mode: WebPictureMode) : ParityToEditor
}

/** The T40 P8 messages from the page to the app. */
sealed interface ParityFromEditor : FromEditor {
    val noteId: String

    /** What to put on the clipboard: [html] with rich text only. */
    data class Clipboard(override val noteId: String, val format: ClipFormat, val text: String, val html: String? = null) :
        ParityFromEditor

    /** The answer to [ParityToEditor.Blocks]: the entries for that search, best first. */
    data class Blocks(
        override val noteId: String,
        val purpose: BlockPurpose,
        val query: String,
        val items: List<BlockEntry>,
    ) : ParityFromEditor

    /** A toggle was opened or closed: every toggle the note remembers, for Room. */
    data class Folds(override val noteId: String, val folds: Map<String, Boolean>) : ParityFromEditor

    /** The note's counts once typing pauses, and the selection's when text is selected. */
    data class Counts(
        override val noteId: String,
        val words: Int,
        val characters: Int,
        val minutes: Int,
        val selection: TextCounts?,
    ) : ParityFromEditor

    /** What shows now, after each change: the Markdown source ([on]) or the note. */
    data class Source(override val noteId: String, val on: Boolean) : ParityFromEditor

    /** Delete block removed a block: what it was ("List", "Table"), for an Undo snackbar. */
    data class BlockDeleted(override val noteId: String, val label: String) : ParityFromEditor

    /** A file dropped or pasted into the note: its bytes follow at once, as a picture's do. */
    data class File(override val noteId: String, val path: String, val name: String, val size: Long) : ParityFromEditor

    /** A chip asks for its file's size and type. */
    data class FileInfo(override val noteId: String, val path: String) : ParityFromEditor

    /** A chip's Open or Save a copy. */
    data class OpenFile(override val noteId: String, val path: String, val name: String, val action: FileAction) :
        ParityFromEditor
}

/** Reads and writes the T40 P8 messages for [BridgeProtocol]. */
internal object EditorParity {
    private val BLOCK_ID = Regex("^[A-Za-z0-9-]{1,40}$")
    const val MAX_BLOCK_QUERY = 100
    const val MAX_PLAIN_CHARS = 1_000_000

    /** Toggles remembered per note, as the web keeps them (`MAX_FOLDS_PER_NOTE`). */
    const val MAX_FOLDS = 200
    const val MAX_FOLD_KEY = 2000
    private val FILE_PATH = FileLimits.PATH
    private const val MAX_FILE_NAME = FileLimits.MAX_NAME
    private const val MAX_INSERT_FILES = FileLimits.MAX_INSERT
    private val MEDIA_TYPE = Regex("^[a-z]+/[a-z0-9.+-]{1,80}$")

    /** The longest block name Delete block's snackbar takes. */
    private const val MAX_LABEL = 40

    fun encode(builder: JsonObjectBuilder, message: ParityToEditor) = with(builder) {
        put("type", typeOf(message))
        put("noteId", message.noteId)
        when (message) {
            is ParityToEditor.Copy -> {
                put("format", message.format.wire)
                put("scope", message.scope.wire)
            }
            is ParityToEditor.InsertPlain -> put("text", message.text)
            is ParityToEditor.Source -> put("on", message.on)
            is ParityToEditor.Blocks -> {
                put("purpose", message.purpose.wire)
                put("query", message.query)
            }
            is ParityToEditor.Insert -> put("item", message.item)
            is ParityToEditor.TurnInto -> put("item", message.item)
            is ParityToEditor.Block -> put("action", message.action.wire)
            is ParityToEditor.Folds -> folds(message.folds)
            is ParityToEditor.CaptureSelection, is ParityToEditor.UndoDelete -> Unit
            is ParityToEditor.FileStored -> {
                put("path", message.path)
                put("ok", message.ok)
            }
            is ParityToEditor.InsertFiles -> putJsonArray("files") {
                for (file in message.files) {
                    addJsonObject {
                        put("path", file.path)
                        put("name", file.name)
                    }
                }
            }
            is ParityToEditor.FileInfo -> {
                put("path", message.path)
                when (val info = message.info) {
                    null -> put("info", JsonNull)
                    else -> putJsonObject("info") {
                        put("size", info.size)
                        put("type", info.type)
                    }
                }
            }
            is ParityToEditor.WebPictures -> put("mode", message.mode.wire)
        }
    }

    fun encode(builder: JsonObjectBuilder, message: ParityFromEditor) = with(builder) {
        when (message) {
            is ParityFromEditor.Clipboard -> {
                put("type", "clipboard")
                put("noteId", message.noteId)
                put("format", message.format.wire)
                put("text", message.text)
                message.html?.let { put("html", it) }
            }
            is ParityFromEditor.Blocks -> {
                put("type", "blocks")
                put("noteId", message.noteId)
                put("purpose", message.purpose.wire)
                put("query", message.query)
                putJsonArray("items") {
                    for (item in message.items) {
                        addJsonObject {
                            put("id", item.id)
                            put("label", item.label)
                            put("icon", item.icon)
                            item.hint?.let { put("hint", it) }
                            item.active?.let { put("active", it) }
                        }
                    }
                }
            }
            is ParityFromEditor.Folds -> {
                put("type", "folds")
                put("noteId", message.noteId)
                folds(message.folds)
            }
            is ParityFromEditor.Counts -> {
                put("type", "counts")
                put("noteId", message.noteId)
                put("words", message.words)
                put("characters", message.characters)
                put("minutes", message.minutes)
                when (val selection = message.selection) {
                    null -> put("selection", JsonNull)
                    else -> putJsonObject("selection") {
                        put("words", selection.words)
                        put("characters", selection.characters)
                    }
                }
            }
            is ParityFromEditor.Source -> {
                put("type", "source")
                put("noteId", message.noteId)
                put("on", message.on)
            }
            is ParityFromEditor.BlockDeleted -> {
                put("type", "blockDeleted")
                put("noteId", message.noteId)
                put("label", message.label)
            }
            is ParityFromEditor.File -> {
                put("type", "file")
                put("noteId", message.noteId)
                put("path", message.path)
                put("name", message.name)
                put("size", message.size)
            }
            is ParityFromEditor.FileInfo -> {
                put("type", "fileInfo")
                put("noteId", message.noteId)
                put("path", message.path)
            }
            is ParityFromEditor.OpenFile -> {
                put("type", "openFile")
                put("noteId", message.noteId)
                put("path", message.path)
                put("name", message.name)
                put("action", message.action.wire)
            }
        }
    }

    /** A T40 P8 message to the page, or null (malformed, or not one of these). */
    fun decodeToEditor(type: String?, noteId: String, value: JsonObject): ParityToEditor? = when (type) {
        "copy" -> ParityToEditor.Copy(
            noteId,
            CopyFormat.of(value.string("format")) ?: return null,
            CopyScope.of(value.string("scope")) ?: return null,
        )
        "insertPlain" -> ParityToEditor.InsertPlain(
            noteId,
            value.string("text")?.takeIf { it.isNotEmpty() && it.length <= MAX_PLAIN_CHARS } ?: return null,
        )
        "source" -> ParityToEditor.Source(noteId, value.boolean("on") ?: return null)
        "blocks" -> ParityToEditor.Blocks(
            noteId,
            BlockPurpose.of(value.string("purpose")) ?: return null,
            value.string("query")?.takeIf { it.length <= MAX_BLOCK_QUERY } ?: return null,
        )
        "insert" -> ParityToEditor.Insert(noteId, value.string("item")?.takeIf(BLOCK_ID::matches) ?: return null)
        "turnInto" -> ParityToEditor.TurnInto(noteId, value.string("item")?.takeIf(BLOCK_ID::matches) ?: return null)
        "block" -> ParityToEditor.Block(noteId, BlockAction.of(value.string("action")) ?: return null)
        "folds" -> ParityToEditor.Folds(noteId, foldsOf(value["folds"]) ?: return null)
        "captureSelection" -> ParityToEditor.CaptureSelection(noteId)
        "undoDelete" -> ParityToEditor.UndoDelete(noteId)
        "fileStored" -> ParityToEditor.FileStored(
            noteId,
            value.string("path")?.takeIf(FILE_PATH::matches) ?: return null,
            value.boolean("ok") ?: return null,
        )
        "insertFiles" -> ParityToEditor.InsertFiles(
            noteId,
            (value["files"] as? JsonArray)?.takeIf { it.size in 1..MAX_INSERT_FILES }?.map { entry ->
                val file = entry as? JsonObject ?: return null
                FileRef(
                    file.string("path")?.takeIf(FILE_PATH::matches) ?: return null,
                    file.string("name")?.takeIf { it.length <= MAX_FILE_NAME } ?: return null,
                )
            } ?: return null,
        )
        "fileInfo" -> ParityToEditor.FileInfo(
            noteId,
            value.string("path")?.takeIf(FILE_PATH::matches) ?: return null,
            when (val info = value["info"]) {
                is JsonNull -> null
                is JsonObject -> StoredFile(
                    (info["size"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 } ?: return null,
                    info.string("type")?.takeIf(MEDIA_TYPE::matches) ?: return null,
                )
                else -> return null
            },
        )
        "webPictures" -> ParityToEditor.WebPictures(noteId, WebPictureMode.of(value.string("mode")) ?: return null)
        else -> null
    }

    /** A T40 P8 message from the page, or null (malformed, or not one of these). */
    fun decodeFromEditor(type: String?, noteId: String, value: JsonObject): ParityFromEditor? = when (type) {
        "clipboard" -> ParityFromEditor.Clipboard(
            noteId,
            ClipFormat.of(value.string("format")) ?: return null,
            value.string("text") ?: return null,
            when (value["html"]) {
                null -> null
                else -> value.string("html") ?: return null
            },
        )
        "blocks" -> ParityFromEditor.Blocks(
            noteId,
            BlockPurpose.of(value.string("purpose")) ?: return null,
            value.string("query") ?: return null,
            (value["items"] as? JsonArray)?.map { entry ->
                val item = entry as? JsonObject ?: return null
                BlockEntry(
                    item.string("id")?.takeIf(BLOCK_ID::matches) ?: return null,
                    item.string("label")?.takeIf { it.isNotEmpty() } ?: return null,
                    item.string("icon") ?: return null,
                    if (item["hint"] == null) null else item.string("hint") ?: return null,
                    if (item["active"] == null) null else item.boolean("active") ?: return null,
                )
            } ?: return null,
        )
        "folds" -> ParityFromEditor.Folds(noteId, foldsOf(value["folds"]) ?: return null)
        "counts" -> ParityFromEditor.Counts(
            noteId,
            value.count("words") ?: return null,
            value.count("characters") ?: return null,
            value.count("minutes") ?: return null,
            when (val selection = value["selection"]) {
                is JsonNull -> null
                is JsonObject -> TextCounts(
                    selection.count("words") ?: return null,
                    selection.count("characters") ?: return null,
                )
                else -> return null
            },
        )
        "source" -> ParityFromEditor.Source(noteId, value.boolean("on") ?: return null)
        "blockDeleted" -> ParityFromEditor.BlockDeleted(
            noteId,
            value.string("label")?.takeIf { it.isNotEmpty() && it.length <= MAX_LABEL } ?: return null,
        )
        "file" -> ParityFromEditor.File(
            noteId,
            value.string("path")?.takeIf(FILE_PATH::matches) ?: return null,
            value.string("name")?.takeIf { it.length <= MAX_FILE_NAME } ?: return null,
            (value["size"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 } ?: return null,
        )
        "fileInfo" -> ParityFromEditor.FileInfo(noteId, value.string("path")?.takeIf(FILE_PATH::matches) ?: return null)
        "openFile" -> ParityFromEditor.OpenFile(
            noteId,
            value.string("path")?.takeIf(FILE_PATH::matches) ?: return null,
            value.string("name")?.takeIf { it.length <= MAX_FILE_NAME } ?: return null,
            FileAction.of(value.string("action")) ?: return null,
        )
        else -> null
    }

    private fun typeOf(message: ParityToEditor) = when (message) {
        is ParityToEditor.Copy -> "copy"
        is ParityToEditor.InsertPlain -> "insertPlain"
        is ParityToEditor.Source -> "source"
        is ParityToEditor.Blocks -> "blocks"
        is ParityToEditor.Insert -> "insert"
        is ParityToEditor.TurnInto -> "turnInto"
        is ParityToEditor.Block -> "block"
        is ParityToEditor.Folds -> "folds"
        is ParityToEditor.CaptureSelection -> "captureSelection"
        is ParityToEditor.UndoDelete -> "undoDelete"
        is ParityToEditor.FileStored -> "fileStored"
        is ParityToEditor.InsertFiles -> "insertFiles"
        is ParityToEditor.FileInfo -> "fileInfo"
        is ParityToEditor.WebPictures -> "webPictures"
    }

    private fun JsonObjectBuilder.folds(folds: Map<String, Boolean>) {
        putJsonObject("folds") { folds.forEach { (key, open) -> put(key, open) } }
    }

    /** A note's toggles, or null when malformed or more than the page keeps. */
    private fun foldsOf(element: kotlinx.serialization.json.JsonElement?): Map<String, Boolean>? {
        val item = element as? JsonObject ?: return null
        if (item.size > MAX_FOLDS) return null
        return item.mapValues { (key, open) ->
            if (key.isEmpty() || key.length > MAX_FOLD_KEY) return null
            (open as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
        }
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.boolean(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    /** A count: a whole number, never negative. */
    private fun JsonObject.count(key: String): Int? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
            ?.takeIf { it in 0..Int.MAX_VALUE }?.toInt()
}
