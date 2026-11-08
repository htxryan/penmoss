package app.penmoss.engine.bridge

import app.penmoss.engine.settings.LineSymbol
import app.penmoss.engine.settings.FontSettings
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.sync.StoredUpdate
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonArrayBuilder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * The app's side of the editor bridge (T32, A282; T33, A300); the page's side is
 * `apps/android/editor/src/protocol.ts`, and `apps/android/contract/bridge-v1.json`
 * holds an example of every message for both test suites. One JSON string per
 * message on the `penmossNative` WebMessageListener. Updates are base64 Yjs
 * bytes: Kotlin stores and forwards them, never decodes them. The app and the
 * page ship in one APK, so version 1 grows by adding messages.
 */
const val BRIDGE_VERSION = 1

/** What the native formatting bar can ask the page for (A301), by the page's names. */
enum class FormatCommand(val wire: String) {
    BOLD("bold"),
    ITALIC("italic"),
    STRIKE("strike"),
    CODE("code"),
    HIGHLIGHT("highlight"),
    PARAGRAPH("paragraph"),
    HEADING1("heading1"),
    HEADING2("heading2"),
    HEADING3("heading3"),
    BULLET_LIST("bulletList"),
    ORDERED_LIST("orderedList"),
    TASK_LIST("taskList"),
    BLOCKQUOTE("blockquote"),
    CODE_BLOCK("codeBlock"),
    INDENT("indent"),
    OUTDENT("outdent"),
    UNDO("undo"),
    REDO("redo"),

    /** Carries the address; an empty one removes the link. */
    LINK("link"),

    // T40 P8 (ED4, ED6): the rest of the text styles, and the table buttons.
    HEADING4("heading4"),
    HEADING5("heading5"),
    HEADING6("heading6"),
    NEXT_CELL("nextCell"),
    PREVIOUS_CELL("previousCell"),
    ADD_ROW("addRow"),
    ADD_COLUMN("addColumn"),
    ;

    companion object {
        fun of(wire: String?): FormatCommand? = entries.firstOrNull { it.wire == wire }
    }
}

/** One note of the phone's list, for wikilink titles and `[[` completion (A303). */
data class DirectoryEntry(val id: String, val title: String, val folder: String? = null)

/** A whole note the page made: a wikilink's new note, or a conflict copy (A303, A306). */
data class PageNote(val id: String, val title: String, val update: String)

/** Messages from the app to the editor page. */
sealed interface ToEditor {
    data class Open(
        val noteId: String,
        val synced: List<StoredUpdate>,
        val pending: List<StoredUpdate>,
        val editable: Boolean,
        /**
         * The notebook the phone sees the note in (T43, A766): a notebook's folder id, or
         * `default`. A link's new note made from it records it, as it is filed beside it.
         */
        val notebook: String? = null,
    ) : ToEditor

    data class Remote(val noteId: String, val update: String) : ToEditor

    /** Send the edits waiting for the page's batch timer now (the app is pausing). */
    data class Flush(val noteId: String) : ToEditor

    /** Close the note; the page sends its last edits, then [FromEditor.Closed]. */
    data class Close(val noteId: String) : ToEditor

    /**
     * Merge these stored edits into one (A289): the open note's pending edits pile up
     * while the phone is offline. The page answers with [FromEditor.Merged].
     */
    data class Compact(val noteId: String, val updates: List<StoredUpdate>) : ToEditor

    /** A button of the formatting bar (A301); [href] goes with [FormatCommand.LINK] only. */
    data class Format(val noteId: String, val command: FormatCommand, val href: String? = null) : ToEditor

    /** Back closes the editor's open menu first (A302). */
    data class Dismiss(val noteId: String) : ToEditor

    /** Gives the note the focus back where its selection was (after a native dialog). */
    data class Focus(val noteId: String) : ToEditor

    /** Puts the caret in the note's title, to rename it from a list (T40 P4, NT10). */
    data class FocusTitle(val noteId: String) : ToEditor

    /** Pictures stored from the photo picker (A304), by their `attachments/…` paths. */
    data class InsertImages(val noteId: String, val paths: List<String>) : ToEditor

    /**
     * Edits kept apart ([edits]) and all they may build on ([base]): the page makes a conflict
     * copy of them (A306), or merges them into [into], the copy already made of earlier edits of
     * the same copy, when that copy still shows exactly those (A309).
     */
    data class CopyConflicts(
        val noteId: String,
        val base: List<StoredUpdate>,
        val edits: List<StoredUpdate>,
        val into: CopyInto? = null,
        /** The original's notebook as the phone sees it (T43, A766): the copy's, when the note itself does not say. */
        val notebook: String? = null,
    ) : ToEditor

    /** The answer to [FromEditor.Attachment] and its bytes: stored on the phone, or not (A311). */
    data class AttachmentStored(val noteId: String, val path: String, val ok: Boolean) : ToEditor

    /** The resolved theme from `/sync/tree` (passed through as it came) and the variant (A305). */
    data class Theme(val theme: JsonObject, val variant: String) : ToEditor

    /**
     * The note column's width (T40 P1, A413): the theme's, or ([full]) the whole screen, from the
     * synced `note.fullWidth` (A501).
     */
    data class Width(val full: Boolean) : ToEditor

    /**
     * The person's fonts (T51, A944): the synced `font.interface`, `font.note` and `font.noteSize`,
     * each checked by core `fonts.ts`'s rules ([FontSettings]); the page lays them over the theme.
     */
    data class Fonts(val interfaceFont: String, val noteFont: String, val noteSize: Int) : ToEditor

    /**
     * Whether the keyboard is up (T40 P6 review S8): the page opens an inline `#tag` tapped while
     * it is down, the note still focused, as hiding the keyboard leaves it.
     */
    data class Ime(val visible: Boolean) : ToEditor

    /**
     * The theme editor's preview (T40 P1b, A418): the page shows its sample note, read-only, and
     * sends nothing back; [Theme] re-themes it.
     */
    data object Preview : ToEditor

    /** Closes the page's image lightbox (T51, A948): the system back gesture, while it is open. */
    data object CloseLightbox : ToEditor

    /** The phone's notes, newest first, for wikilinks (A303). */
    data class Directory(val notes: List<DirectoryEntry>) : ToEditor

    /**
     * Make a new, empty note with this id, as the web's New note does (T38): the page builds it
     * (Kotlin never writes Yjs) and answers [FromEditor.Created] with the whole note.
     */
    data class Create(
        val noteId: String,
        /** The notebook of the folder it is made in (T43, A766), recorded in the note itself. */
        val notebook: String? = null,
    ) : ToEditor

    /** Add ([on]) or remove a frontmatter tag on the open note, as the web's tag chips do (T38). */
    data class SetTag(val noteId: String, val tag: String, val on: Boolean) : ToEditor

    /** A daily or weekly note's kind (T40 P5), as the page resolves and answers it. */
    enum class PeriodKind(val wire: String) {
        DAILY("daily"),
        WEEKLY("weekly"),
        ;

        companion object {
            fun of(wire: String?): PeriodKind? = entries.firstOrNull { it.wire == wire }
        }
    }

    /**
     * Make the daily or weekly note for [day] (or today in [timeZone] when null) from
     * [template], exactly as the web does (T40 P5): the page resolves the period with core's
     * functions (never the phone's zone), builds it with the deterministic `periodicNote` and
     * answers [FromEditor.CreatedPeriodic], so a note made offline needs no server. [at] is
     * when the note is made (epoch ms); the day is read in [timeZone], the synced setting.
     */
    data class CreatePeriodic(
        val kind: PeriodKind,
        /** An explicit calendar day (`2026-10-21`), or null for today in [timeZone]. */
        val day: String?,
        val at: Long,
        /** The synced time zone setting, never the phone's. */
        val timeZone: String,
        /** The synced daily or weekly template. */
        val template: String,
        /**
         * This request's tag (T40 P9, P5 review N7): an error from making it names it, so a
         * waiting screen fails on its own request's error only.
         */
        val request: String? = null,
    ) : ToEditor

    /**
     * The user's key bindings and the app's own commands (T40 P9, PL9, A493): [bindings] are
     * the synced `keys.<id>` lists by command id, as stored (the page applies A90 itself);
     * [app] the commands the app runs on the note's screen now, which the page's dispatcher
     * sends back as [FromEditor.Command].
     */
    data class Keys(val bindings: Map<String, List<String>>, val app: List<String>) : ToEditor

    /** Asks what period the open note is, and what surrounds it (T40 P5, JR4). */
    data class PeriodicNav(val noteId: String) : ToEditor

    /**
     * The answer to [FromEditor.NoteContent] (T40 P7, LK2, LK4, A470): another note's stored
     * updates, opaque here, for headings and embeds; [updates] is empty unless [state] is OK.
     */
    data class NoteContent(val noteId: String, val state: ContentState, val updates: List<StoredUpdate>) : ToEditor

    /** A note the page watches changed on the phone: the page reads it again (T40 P7, A471). */
    data class NoteChanged(val noteId: String) : ToEditor

    /** Scroll the open note to [heading], as a `[[Note#Heading]]` link does (T40 P7, LK3). */
    data class ShowHeading(val noteId: String, val heading: String) : ToEditor

    /**
     * The person's line symbols (T44, A747): the synced `symbols.list`, or the defaults. Every
     * open note redraws its margin; no note changes (A741).
     */
    data class Symbols(val symbols: List<LineSymbol>) : ToEditor

    /** The bar's symbol sheet: toggle symbol [index] (its slot, 0–8) on the selection's lines (A740). */
    data class Symbol(val noteId: String, val index: Int) : ToEditor
}

/** What the app has of a note the page asked for (T40 P7, A470). */
enum class ContentState(val wire: String) {
    OK("ok"),

    /** Not on the phone, and it could not be fetched. */
    MISSING("missing"),

    /** Past what the page reads in one go ([BridgeProtocol.MAX_CONTENT_CHARS]). */
    TOO_LARGE("tooLarge"),
    ;

    companion object {
        fun of(wire: String?): ContentState? = entries.firstOrNull { it.wire == wire }
    }
}

/** One frontmatter field as the web's Info panel shows it (T40 P7, NT23). */
data class InfoField(val key: String, val value: String)

/** A conflict copy already made, with every update the phone holds of it (A309). */
data class CopyInto(val noteId: String, val updates: List<StoredUpdate>)

/** Why the page made no copy of edits kept apart (A309). */
enum class CopyFailure(val wire: String) {
    /** The edits build on something they were not sent: the page refuses rather than drop them. */
    INCOMPLETE("incomplete"),

    /** The edits' bytes cannot be read. */
    UNREADABLE("unreadable"),

    /** The edits change nothing a copy would show. */
    EMPTY("empty"),
    ;

    companion object {
        fun of(wire: String?): CopyFailure? = entries.firstOrNull { it.wire == wire }
    }
}

/** Updates merged by the page, and the stored ids they replace. */
data class Compacted(val replaces: List<Long>, val update: String)

/** Messages from the editor page to the app. */
sealed interface FromEditor {
    data object Ready : FromEditor

    /**
     * The page's image lightbox opened or closed (T51, A948): while it is open the system back
     * gesture closes it ([ToEditor.CloseLightbox]) and the note's bars step aside for it.
     */
    data class Lightbox(val open: Boolean) : FromEditor

    data class Opened(
        val noteId: String,
        val title: String,
        val compacted: Compacted?,
        val compactedPending: Compacted?,
    ) : FromEditor

    /** A local edit, merged over a short window; the app stores it as pending and uploads it. */
    data class Update(val noteId: String, val update: String) : FromEditor

    data class Title(val noteId: String, val title: String) : FromEditor

    data class Unsupported(val noteId: String, val nodeTypes: List<String>) : FromEditor

    /** A wikilink was followed. */
    data class OpenNote(val noteId: String, val heading: String? = null) : FromEditor

    /** The answer to [ToEditor.Close]: every edit has been sent. */
    data class Closed(val noteId: String) : FromEditor

    /** The answer to [ToEditor.Compact] (`compacted`): the merged edits. */
    data class Merged(val noteId: String, val compacted: Compacted) : FromEditor

    /** What the formatting bar shows (A301): formatting at the selection and what can be done. */
    data class State(
        val noteId: String,
        val active: List<FormatCommand>,
        val canUndo: Boolean,
        val canRedo: Boolean,
        val canIndent: Boolean,
        val canOutdent: Boolean,
        val href: String?,
        /** A menu of the editor's is open: Back closes it first (A302). */
        val menu: Boolean,
        /** The caret is in a table: the bar shows the cell, row and column buttons (T40 P8, ED6). */
        val inTable: Boolean = false,
        /** The caret is in a code block: Indent and Outdent indent its lines (ED7). */
        val inCode: Boolean = false,
        /** The Block menu's Move up and Move down can move the block holding the caret (ED5). */
        val canMoveUp: Boolean = false,
        val canMoveDown: Boolean = false,
        /** Turn into can act on the selection (not in a table). */
        val canTurnInto: Boolean = false,
        /** The caret is in the note's title, where the bar's buttons do nothing (T40 P9, T39 pass 3, A554). */
        val inTitle: Boolean = false,
        /** The symbol slots every line in the selection has, ticked in the symbol sheet (T44, A747). */
        val symbols: List<Int> = emptyList(),
        /** A line in the selection may carry a symbol (not code, a table or a callout). */
        val canSymbol: Boolean = false,
    ) : FromEditor

    /**
     * A pasted or dropped picture (A304): the path the note holds and its size. Its bytes
     * come as the very next message, an array buffer, so Kotlin never decodes base64 (A11).
     */
    data class Attachment(val noteId: String, val path: String, val size: Long) : FromEditor

    /** A note a wikilink created (A303), to file beside [noteId]. */
    data class NewNote(val noteId: String, val note: PageNote) : FromEditor

    /**
     * The answer to [ToEditor.CopyConflicts] (A306): the copy, and the edits it now holds. With
     * [merged], [note] is an edit of the copy [ToEditor.CopyConflicts.into] named (A309).
     */
    data class ConflictCopy(
        val noteId: String,
        val note: PageNote,
        val replaces: List<Long>,
        val merged: Boolean = false,
    ) : FromEditor

    /** The other answer to [ToEditor.CopyConflicts]: no copy was made of these edits, and why (A309). */
    data class CopyFailed(val noteId: String, val reason: CopyFailure, val replaces: List<Long>) : FromEditor

    /** Something to tell the person (a picture that could not be added). */
    data class Notice(val noteId: String, val message: String) : FromEditor

    /** The answer to [ToEditor.Create]: the new note, to store and upload (T38). */
    data class Created(val noteId: String, val note: PageNote) : FromEditor

    /**
     * The answer to [ToEditor.CreatePeriodic]: the whole new note, to store, file through the
     * daily intent and open (T40 P5). [period] is the resolved period (`2026-10-21` or
     * `2026-W43`), opaque to the app; [date] is the calendar day it was made for (a week's
     * Monday), which the daily intent sends so a midnight between making and filing files
     * the same note.
     */
    data class CreatedPeriodic(val note: PageNote, val kind: ToEditor.PeriodKind, val period: String, val date: String) : FromEditor

    /** One neighbour of a periodic note: an explicit day, what the row shows, and its full name. */
    data class NavTarget(
        val date: String,
        val label: String,
        val full: String,
        /** The period of this target's note (`2026-10-20`, `2026-W43`), opaque: marks a held one (T40 P9, N4). */
        val period: String,
    )

    /**
     * The open periodic note's period and neighbours, for the row under its top bar (T40 P5):
     * every target names an explicit day, so the app opens it through `createPeriodic` again
     * and Kotlin never computes a period.
     */
    data class PeriodicNavData(
        val kind: ToEditor.PeriodKind,
        val period: String,
        val label: String,
        val prev: NavTarget,
        val next: NavTarget,
        /** The daily note's week (its Monday), or null on a weekly note. */
        val week: NavTarget?,
        /** The weekly note's seven days, or null on a daily note. */
        val days: List<NavTarget>?,
    )

    /** The answer to [ToEditor.PeriodicNav]: the open note's period and neighbours, or null (T40 P5). */
    data class PeriodicNav(val noteId: String, val nav: PeriodicNavData?) : FromEditor

    /** The open note's frontmatter tags, sorted: sent when it opens and whenever they change (T38). */
    data class Tags(val noteId: String, val tags: List<String>) : FromEditor

    /** Another note's content for headings and embeds (T40 P7, A470): [noteId] is the note wanted. */
    data class NoteContent(val noteId: String) : FromEditor

    /** Follow ([on]) or stop following a note an embed shows (T40 P7, A471). */
    data class WatchNote(val noteId: String, val on: Boolean) : FromEditor

    /**
     * The open note's details for the Info sheet (T40 P7, NT23, A475), read by the page from its
     * own document, and the notes it links to or embeds ([links], distinct, sorted, A473).
     */
    data class NoteInfo(
        val noteId: String,
        val created: String?,
        val kind: String,
        val period: String?,
        val fields: List<InfoField>,
        val links: List<String>,
    ) : FromEditor

    /**
     * The open note's plain text, capped as the server caps it, for the offline index (T40 P6,
     * FD4): sent once typing here pauses for long, and as the note closes.
     */
    data class Text(
        val noteId: String,
        val text: String,
        /** Its headings, one per line (the index's headings column). */
        val headings: String = "",
        /** Its tags as this phone has them, frontmatter and inline (the tag browser's overlay, S5). */
        val tags: List<String> = emptyList(),
    ) : FromEditor

    /**
     * A highlighted `#tag` in the note was tapped while reading, or Ctrl-tapped (T40 P6, TG5): the
     * app opens its notes. [tag] is canonical, as the page's `data-tag`.
     */
    data class OpenTag(val noteId: String, val tag: String) : FromEditor

    /** A key the page's dispatcher took for one of the app's commands (T40 P9, PL9, A493). */
    data class Command(val noteId: String?, val id: String) : FromEditor

    /** [request] is the [ToEditor.CreatePeriodic] this error answers, when it answers one (T40 P9, N7). */
    data class Error(val noteId: String?, val message: String, val request: String? = null) : FromEditor
}

object BridgeProtocol {
    private val BASE64 = Regex("^[A-Za-z0-9+/]*={0,2}$")
    private val NOTE_ID = Regex("^[A-Za-z0-9_-]{1,80}$")

    /** An optional `notebook` (T43, A766): null when absent; a notebook id, or [BAD_NOTEBOOK]. */
    private fun notebookOf(value: JsonObject): String? {
        val raw = value["notebook"] ?: return null
        val text = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content
        return text?.takeIf(NOTE_ID::matches) ?: BAD_NOTEBOOK
    }

    /** What [notebookOf] answers for a `notebook` that is not a notebook id: the message is refused. */
    private const val BAD_NOTEBOOK = "\u0000"

    /** A command's id, as `keys.<id>` and the registry name one (T40 P9; `@penmoss/editor/keys`). */
    val COMMAND_ID = Regex("^[A-Za-z][A-Za-z0-9-]*(\\.[A-Za-z0-9-]+)*$")

    /** A request's tag (T40 P9): the app's own short id. */
    val REQUEST_ID = Regex("^[A-Za-z0-9_-]{1,64}$")

    /** A calendar day (`2026-10-21`), as the page's day cells and `createPeriodic` use it (T40 P5). */
    val DAY_PATTERN = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    /** A resolved period: a day, or an ISO week (`2026-W43`), opaque to the app (T40 P5). */
    val PERIOD_PATTERN = Regex("^(\\d{4}-\\d{2}-\\d{2}|\\d{4}-W\\d{2})$")

    /** Longer than any heading a link names (T40 P7, LK3); the server keeps titles to 300 too. */
    const val MAX_HEADING_CHARS = 300

    /** The notes a page may report as the open note's links (T40 P7, A473). */
    const val MAX_REPORTED_LINKS = 1000

    /**
     * The most of another note the app hands the page in one `noteContent` (T40 P7, A470): its
     * stored updates as base64, about 3 MB of Yjs. Past it the page is told `tooLarge`, so a huge
     * note never fills the page's memory for an embed or a heading list.
     */
    const val MAX_CONTENT_CHARS = 4 * 1024 * 1024

    /** Longer than any tag Ryan types (A361); the page normalises a tag with the shared rules (T38). */
    const val MAX_TAG_CHARS = app.penmoss.engine.notes.Tags.MAX_CHARS

    /** What a note may hold for a picture the app keeps (A304): `attachments/<sha256>.<ext>`. */
    val ATTACHMENT_PATH = Regex("^attachments/([0-9a-f]{64})\\.(png|jpg|gif|webp|avif)$")

    fun encode(message: ToEditor): String = buildJsonObject {
        put("v", BRIDGE_VERSION)
        when (message) {
            is ToEditor.Open -> {
                type("open", message.noteId)
                putJsonArray("synced") { stored(message.synced) }
                putJsonArray("pending") { stored(message.pending) }
                put("editable", message.editable)
                message.notebook?.let { put("notebook", it) }
            }
            is ToEditor.Remote -> {
                type("remote", message.noteId)
                put("update", message.update)
            }
            is ToEditor.Flush -> type("flush", message.noteId)
            is ToEditor.Close -> type("close", message.noteId)
            is ToEditor.Compact -> {
                type("compact", message.noteId)
                putJsonArray("updates") { stored(message.updates) }
            }
            is ToEditor.Format -> {
                type("format", message.noteId)
                put("command", message.command.wire)
                message.href?.let { put("href", it) }
            }
            is ToEditor.Dismiss -> type("dismiss", message.noteId)
            is ToEditor.Focus -> type("focus", message.noteId)
            is ToEditor.FocusTitle -> type("focusTitle", message.noteId)
            is ToEditor.InsertImages -> {
                type("insertImages", message.noteId)
                putJsonArray("paths") { message.paths.forEach { add(it) } }
            }
            is ToEditor.CopyConflicts -> {
                type("copyConflicts", message.noteId)
                putJsonArray("base") { stored(message.base) }
                putJsonArray("edits") { stored(message.edits) }
                message.into?.let { into ->
                    putJsonObject("into") {
                        put("noteId", into.noteId)
                        putJsonArray("updates") { stored(into.updates) }
                    }
                }
                message.notebook?.let { put("notebook", it) }
            }
            is ToEditor.AttachmentStored -> {
                type("attachmentStored", message.noteId)
                put("path", message.path)
                put("ok", message.ok)
            }
            is ToEditor.Theme -> {
                put("type", "theme")
                put("theme", message.theme)
                put("variant", message.variant)
            }
            is ToEditor.Width -> {
                put("type", "width")
                put("full", message.full)
            }
            is ToEditor.Fonts -> {
                put("type", "fonts")
                put("interface", message.interfaceFont)
                put("note", message.noteFont)
                put("noteSize", message.noteSize)
            }
            is ToEditor.Ime -> {
                put("type", "ime")
                put("visible", message.visible)
            }
            is ToEditor.Preview -> put("type", "preview")
            is ToEditor.CloseLightbox -> put("type", "closeLightbox")
            is ToEditor.Directory -> {
                put("type", "directory")
                putJsonArray("notes") {
                    for (entry in message.notes) {
                        addJsonObject {
                            put("id", entry.id)
                            put("title", entry.title)
                            entry.folder?.let { put("folder", it) }
                        }
                    }
                }
            }
            is ToEditor.Create -> {
                type("create", message.noteId)
                message.notebook?.let { put("notebook", it) }
            }
            is ToEditor.CreatePeriodic -> {
                put("type", "createPeriodic")
                put("kind", message.kind.wire)
                put("day", message.day?.let(::JsonPrimitive) ?: JsonNull)
                put("at", message.at)
                put("timeZone", message.timeZone)
                put("template", message.template)
                message.request?.let { put("request", it) }
            }
            is ToEditor.Keys -> {
                put("type", "keys")
                putJsonObject("bindings") {
                    message.bindings.forEach { (id, keys) -> putJsonArray(id) { keys.forEach { add(it) } } }
                }
                putJsonArray("app") { message.app.forEach { add(it) } }
            }
            is ToEditor.PeriodicNav -> type("periodicNav", message.noteId)
            is ToEditor.SetTag -> {
                type("setTag", message.noteId)
                put("tag", message.tag)
                put("on", message.on)
            }
            is ToEditor.NoteContent -> {
                type("noteContent", message.noteId)
                put("state", message.state.wire)
                putJsonArray("updates") { stored(message.updates) }
            }
            is ToEditor.NoteChanged -> type("noteChanged", message.noteId)
            is ToEditor.ShowHeading -> {
                type("showHeading", message.noteId)
                put("heading", message.heading)
            }
            is ToEditor.Symbols -> {
                put("type", "symbols")
                put("symbols", LineSymbols.toJson(message.symbols))
            }
            is ToEditor.Symbol -> {
                type("symbol", message.noteId)
                put("index", message.index)
            }
            is ParityToEditor -> EditorParity.encode(this, message)
            is CommentToEditor -> CommentsBridge.encode(this, message)
            is CommentAuthorToEditor -> CommentsBridge.encode(this, message)
        }
    }.toString()

    fun encode(message: FromEditor): String = buildJsonObject {
        put("v", BRIDGE_VERSION)
        when (message) {
            FromEditor.Ready -> put("type", "ready")
            is FromEditor.Lightbox -> {
                put("type", "lightbox")
                put("open", message.open)
            }
            is FromEditor.Opened -> {
                type("opened", message.noteId)
                put("title", message.title)
                put("compacted", compacted(message.compacted))
                put("compactedPending", compacted(message.compactedPending))
            }
            is FromEditor.Update -> {
                type("update", message.noteId)
                put("update", message.update)
            }
            is FromEditor.Title -> {
                type("title", message.noteId)
                put("title", message.title)
            }
            is FromEditor.Unsupported -> {
                type("unsupported", message.noteId)
                putJsonArray("nodeTypes") { message.nodeTypes.forEach { add(it) } }
            }
            is FromEditor.OpenNote -> {
                type("openNote", message.noteId)
                message.heading?.let { put("heading", it) }
            }
            is FromEditor.Closed -> type("closed", message.noteId)
            is FromEditor.Merged -> {
                type("compacted", message.noteId)
                put("compacted", compacted(message.compacted))
            }
            is FromEditor.State -> {
                type("state", message.noteId)
                putJsonArray("active") { message.active.forEach { add(it.wire) } }
                put("canUndo", message.canUndo)
                put("canRedo", message.canRedo)
                put("canIndent", message.canIndent)
                put("canOutdent", message.canOutdent)
                put("href", message.href?.let(::JsonPrimitive) ?: JsonNull)
                put("menu", message.menu)
                put("inTable", message.inTable)
                put("inCode", message.inCode)
                put("canMoveUp", message.canMoveUp)
                put("canMoveDown", message.canMoveDown)
                put("canTurnInto", message.canTurnInto)
                put("inTitle", message.inTitle)
                putJsonArray("symbols") { message.symbols.forEach { add(it) } }
                put("canSymbol", message.canSymbol)
            }
            is FromEditor.Attachment -> {
                type("attachment", message.noteId)
                put("path", message.path)
                put("size", message.size)
            }
            is FromEditor.NewNote -> {
                type("newNote", message.noteId)
                note(message.note)
            }
            is FromEditor.ConflictCopy -> {
                type("conflictCopy", message.noteId)
                note(message.note)
                putJsonArray("replaces") { message.replaces.forEach { add(it.toString()) } }
                if (message.merged) put("merged", true)
            }
            is FromEditor.CopyFailed -> {
                type("copyFailed", message.noteId)
                put("reason", message.reason.wire)
                putJsonArray("replaces") { message.replaces.forEach { add(it.toString()) } }
            }
            is FromEditor.Notice -> {
                type("notice", message.noteId)
                put("message", message.message)
            }
            is FromEditor.Created -> {
                type("created", message.noteId)
                note(message.note)
            }
            is FromEditor.CreatedPeriodic -> {
                put("type", "createdPeriodic")
                note(message.note)
                put("kind", message.kind.wire)
                put("period", message.period)
                put("date", message.date)
            }
            is FromEditor.PeriodicNav -> {
                type("periodicNav", message.noteId)
                when (val nav = message.nav) {
                    null -> put("nav", JsonNull)
                    else -> putJsonObject("nav") {
                        put("kind", nav.kind.wire)
                        put("period", nav.period)
                        put("label", nav.label)
                        navTarget("prev", nav.prev)
                        navTarget("next", nav.next)
                        nav.week?.let { navTarget("week", it) } ?: put("week", JsonNull)
                        val days = nav.days
                        if (days == null) {
                            put("days", JsonNull)
                        } else {
                            putJsonArray("days") { days.forEach { day -> addJsonObject { navTargetFields(day) } } }
                        }
                    }
                }
            }
            is FromEditor.Tags -> {
                type("tags", message.noteId)
                putJsonArray("tags") { message.tags.forEach { add(it) } }
            }
            is FromEditor.NoteContent -> type("noteContent", message.noteId)
            is FromEditor.WatchNote -> {
                type("watchNote", message.noteId)
                put("on", message.on)
            }
            is FromEditor.NoteInfo -> {
                type("noteInfo", message.noteId)
                put("created", message.created?.let(::JsonPrimitive) ?: JsonNull)
                put("kind", message.kind)
                put("period", message.period?.let(::JsonPrimitive) ?: JsonNull)
                putJsonArray("fields") {
                    message.fields.forEach { field ->
                        addJsonObject {
                            put("key", field.key)
                            put("value", field.value)
                        }
                    }
                }
                putJsonArray("links") { message.links.forEach { add(it) } }
            }
            is FromEditor.Text -> {
                type("text", message.noteId)
                put("text", message.text)
                put("headings", message.headings)
                putJsonArray("tags") { message.tags.forEach { add(it) } }
            }
            is FromEditor.OpenTag -> {
                type("openTag", message.noteId)
                put("tag", message.tag)
            }
            is ParityFromEditor -> EditorParity.encode(this, message)
            is CommentFromEditor -> CommentsBridge.encode(this, message)
            is FromEditor.Error -> {
                put("type", "error")
                put("noteId", message.noteId?.let(::JsonPrimitive) ?: JsonNull)
                put("message", message.message)
                message.request?.let { put("request", it) }
            }
            is FromEditor.Command -> {
                put("type", "command")
                put("noteId", message.noteId?.let(::JsonPrimitive) ?: JsonNull)
                put("id", message.id)
            }
        }
    }.toString()

    /** Reads a message from the page; null for anything malformed or of another version. */
    fun decodeFromEditor(raw: String): FromEditor? {
        val value = parse(raw) ?: return null
        val type = value.string("type")
        if (type == "ready") return FromEditor.Ready
        if (type == "lightbox") {
            val open = (value["open"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
            return FromEditor.Lightbox(open)
        }
        if (type == "createdPeriodic") {
            val note = noteOf(value["note"]) ?: return null
            val kind = ToEditor.PeriodKind.of(value.string("kind")) ?: return null
            val period = value.string("period")?.takeIf(PERIOD_PATTERN::matches) ?: return null
            val date = value.string("date")?.takeIf(DAY_PATTERN::matches) ?: return null
            // The note made is the period asked for: a periodic note's title is its period (T40 P5 review N8).
            if (note.title != period) return null
            return FromEditor.CreatedPeriodic(note, kind, period, date)
        }
        if (type == "error") {
            val message = value.string("message") ?: return null
            val noteId = value["noteId"].let { if (it == null || it is JsonNull) null else value.string("noteId") }
            val request = when (value["request"]) {
                null -> null
                else -> value.string("request")?.takeIf(REQUEST_ID::matches) ?: return null
            }
            return FromEditor.Error(noteId, message, request)
        }
        if (type == "command") {
            // Only a command's id: what runs is the app's own handler for it, or nothing.
            val id = value.string("id")?.takeIf(COMMAND_ID::matches) ?: return null
            val noteId = when (val raw = value["noteId"]) {
                null, is JsonNull -> null
                else -> (raw as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf(NOTE_ID::matches) ?: return null
            }
            return FromEditor.Command(noteId, id)
        }
        val noteId = value.string("noteId")?.takeIf(NOTE_ID::matches) ?: return null
        return when (type) {
            "opened" -> FromEditor.Opened(
                noteId,
                value.string("title") ?: return null,
                (compactedOf(value["compacted"]) ?: return null).value,
                (compactedOf(value["compactedPending"]) ?: return null).value,
            )
            "update" -> FromEditor.Update(noteId, value.base64("update") ?: return null)
            "title" -> FromEditor.Title(noteId, value.string("title") ?: return null)
            "unsupported" -> FromEditor.Unsupported(noteId, value.strings("nodeTypes") ?: return null)
            "openNote" -> FromEditor.OpenNote(
                noteId,
                when (value["heading"]) {
                    null -> null
                    else -> value.string("heading")?.takeIf { it.isNotBlank() && it.length <= MAX_HEADING_CHARS }
                        ?: return null
                },
            )
            "closed" -> FromEditor.Closed(noteId)
            "compacted" -> FromEditor.Merged(noteId, compactedOf(value["compacted"])?.value ?: return null)
            "state" -> FromEditor.State(
                noteId,
                value.strings("active")?.map { FormatCommand.of(it) ?: return null } ?: return null,
                canUndo = value.boolean("canUndo") ?: return null,
                canRedo = value.boolean("canRedo") ?: return null,
                canIndent = value.boolean("canIndent") ?: return null,
                canOutdent = value.boolean("canOutdent") ?: return null,
                href = when (val href = value["href"]) {
                    null, is JsonNull -> null
                    else -> (href as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
                },
                menu = value.boolean("menu") ?: return null,
                inTable = value.boolean("inTable") ?: return null,
                inCode = value.boolean("inCode") ?: return null,
                canMoveUp = value.boolean("canMoveUp") ?: return null,
                canMoveDown = value.boolean("canMoveDown") ?: return null,
                canTurnInto = value.boolean("canTurnInto") ?: return null,
                // Absent from a page before T40 P9: not in the title.
                inTitle = value.boolean("inTitle") ?: false,
                // Absent from a page before T44: no symbols, and none to add.
                symbols = when (val slots = value["symbols"]) {
                    null -> emptyList()
                    else -> (slots as? JsonArray)?.map { slot ->
                        (slot as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it in 0 until LineSymbols.MAX }
                            ?: return null
                    } ?: return null
                },
                canSymbol = value.boolean("canSymbol") ?: false,
            )
            "attachment" -> FromEditor.Attachment(
                noteId,
                value.string("path")?.takeIf(ATTACHMENT_PATH::matches) ?: return null,
                (value["size"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it > 0 } ?: return null,
            )
            "newNote" -> FromEditor.NewNote(noteId, noteOf(value["note"]) ?: return null)
            "conflictCopy" -> FromEditor.ConflictCopy(
                noteId,
                noteOf(value["note"]) ?: return null,
                value.strings("replaces")?.map { it.toLongOrNull() ?: return null }?.takeIf { it.isNotEmpty() } ?: return null,
                merged = when (value["merged"]) {
                    null -> false
                    else -> value.boolean("merged") ?: return null
                },
            )
            "copyFailed" -> FromEditor.CopyFailed(
                noteId,
                CopyFailure.of(value.string("reason")) ?: return null,
                value.strings("replaces")?.map { it.toLongOrNull() ?: return null }?.takeIf { it.isNotEmpty() } ?: return null,
            )
            "notice" -> FromEditor.Notice(noteId, value.string("message") ?: return null)
            // The note made is the one asked for: never another id for the app to store.
            "created" -> FromEditor.Created(noteId, noteOf(value["note"])?.takeIf { it.id == noteId } ?: return null)
            "periodicNav" -> when (val raw = value["nav"]) {
                null, is JsonNull -> FromEditor.PeriodicNav(noteId, null)
                else -> FromEditor.PeriodicNav(noteId, navDataOf(raw) ?: return null)
            }
            "tags" -> FromEditor.Tags(noteId, value.strings("tags") ?: return null)
            "noteContent" -> FromEditor.NoteContent(noteId)
            "watchNote" -> FromEditor.WatchNote(noteId, value.boolean("on") ?: return null)
            "noteInfo" -> FromEditor.NoteInfo(
                noteId,
                created = (nullableString(value, "created") ?: return null).value,
                kind = value.string("kind")?.takeIf { it.isNotEmpty() } ?: return null,
                period = (nullableString(value, "period") ?: return null).value,
                fields = (value["fields"] as? JsonArray)?.map { entry ->
                    val item = entry as? JsonObject ?: return null
                    InfoField(item.string("key") ?: return null, item.string("value") ?: return null)
                } ?: return null,
                links = value.strings("links")
                    ?.takeIf { links -> links.size <= MAX_REPORTED_LINKS && links.all(NOTE_ID::matches) }
                    ?: return null,
            )
            "text" -> FromEditor.Text(
                noteId,
                value.string("text") ?: return null,
                value.string("headings") ?: "",
                // Canonical tags only, as the page's own rules write them.
                (value.strings("tags") ?: emptyList()).filter { it.length <= MAX_TAG_CHARS && app.penmoss.engine.notes.Tags.normalise(it) == it },
            )
            // Only a canonical tag, as the page's own rules write it (A361's limit too).
            "openTag" -> FromEditor.OpenTag(
                noteId,
                value.string("tag")?.takeIf { it.length <= MAX_TAG_CHARS && app.penmoss.engine.notes.Tags.normalise(it) == it } ?: return null,
            )
            else -> EditorParity.decodeFromEditor(type, noteId, value)
                ?: CommentsBridge.decodeFromEditor(type, noteId, value)
        }
    }

    /** A string-or-null field: a [Field] of null for JSON null; null when missing or not a string. */
    private fun nullableString(value: JsonObject, key: String): Field<String?>? =
        when (val raw = value[key]) {
            null -> null
            is JsonNull -> Field(null)
            else -> (raw as? JsonPrimitive)?.takeIf { it.isString }?.let { Field(it.content) }
        }

    private fun navTargetOf(element: JsonElement?): FromEditor.NavTarget? {
        val item = element as? JsonObject ?: return null
        return FromEditor.NavTarget(
            item.string("date")?.takeIf(DAY_PATTERN::matches) ?: return null,
            item.string("label")?.takeIf { it.isNotEmpty() } ?: return null,
            item.string("full")?.takeIf { it.isNotEmpty() } ?: return null,
            item.string("period")?.takeIf(PERIOD_PATTERN::matches) ?: return null,
        )
    }

    private fun navDataOf(element: JsonElement?): FromEditor.PeriodicNavData? {
        if (element == null || element is JsonNull) return null
        val item = element as? JsonObject ?: return null
        val kind = ToEditor.PeriodKind.of(item.string("kind")) ?: return null
        return FromEditor.PeriodicNavData(
            kind,
            item.string("period")?.takeIf(PERIOD_PATTERN::matches) ?: return null,
            item.string("label")?.takeIf { it.isNotEmpty() } ?: return null,
            navTargetOf(item["prev"]) ?: return null,
            navTargetOf(item["next"]) ?: return null,
            navTargetOf(item["week"]?.takeIf { it !is JsonNull }),
            (item["days"] as? JsonArray)
                ?.map { navTargetOf(it) ?: return null }
                ?.takeIf { it.isNotEmpty() },
        )
    }

    /** Reads a message to the page (the page's own parser is in TypeScript; this is for tests and logs). */
    fun decodeToEditor(raw: String): ToEditor? {
        val value = parse(raw) ?: return null
        when (value.string("type")) {
            "theme" -> {
                val theme = value["theme"] as? JsonObject ?: return null
                val variant = value.string("variant")?.takeIf { it == "light" || it == "dark" } ?: return null
                return ToEditor.Theme(theme, variant)
            }
            "width" -> {
                val full = (value["full"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
                return ToEditor.Width(full)
            }
            "fonts" -> {
                val fonts = listOf(SettingKeys.INTERFACE_FONT to "interface", SettingKeys.NOTE_FONT to "note", SettingKeys.NOTE_FONT_SIZE to "noteSize")
                for ((key, field) in fonts) if (value[field] == null || value[field] is JsonNull || FontSettings.problem(key, value[field]) != null) return null
                return ToEditor.Fonts(value.string("interface")!!, value.string("note")!!, FontSettings.sizeOf(value["noteSize"]))
            }
            "symbols" -> return ToEditor.Symbols(LineSymbols.read(value["symbols"]) ?: return null)
            "commentAuthor" -> return CommentsBridge.decodeAuthor(value)
            "ime" -> {
                val visible = (value["visible"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
                return ToEditor.Ime(visible)
            }
            "preview" -> return ToEditor.Preview
            "closeLightbox" -> return ToEditor.CloseLightbox
            "createPeriodic" -> {
                val kind = ToEditor.PeriodKind.of(value.string("kind")) ?: return null
                val day = when (val raw = value["day"]) {
                    null, is JsonNull -> null
                    else -> (raw as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf(DAY_PATTERN::matches)
                        ?: return null
                }
                val at = (value["at"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 }
                    ?: return null
                val timeZone = value.string("timeZone")?.takeIf { it.isNotEmpty() && it.length <= 256 } ?: return null
                val template = value.string("template") ?: return null
                val request = when (value["request"]) {
                    null -> null
                    else -> value.string("request")?.takeIf(REQUEST_ID::matches) ?: return null
                }
                return ToEditor.CreatePeriodic(kind, day, at, timeZone, template, request)
            }
            "keys" -> {
                val bindings = (value["bindings"] as? JsonObject)?.mapValues { (id, keys) ->
                    if (!COMMAND_ID.matches(id)) return null
                    (keys as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null }
                        ?: return null
                } ?: return null
                val app = value.strings("app")?.takeIf { ids -> ids.all(COMMAND_ID::matches) } ?: return null
                return ToEditor.Keys(bindings, app)
            }
            "directory" -> {
                val notes = (value["notes"] as? JsonArray)?.map { entry ->
                    val item = entry as? JsonObject ?: return null
                    val folder = item["folder"]
                    DirectoryEntry(
                        item.string("id")?.takeIf(NOTE_ID::matches) ?: return null,
                        item.string("title") ?: return null,
                        if (folder == null) null else item.string("folder") ?: return null,
                    )
                } ?: return null
                return ToEditor.Directory(notes)
            }
        }
        val noteId = value.string("noteId")?.takeIf(NOTE_ID::matches) ?: return null
        return when (value.string("type")) {
            "open" -> ToEditor.Open(
                noteId,
                storedOf(value["synced"]) ?: return null,
                storedOf(value["pending"]) ?: return null,
                value.boolean("editable") ?: return null,
                notebookOf(value).takeIf { it != BAD_NOTEBOOK } ?: if (value.containsKey("notebook")) return null else null,
            )
            "remote" -> ToEditor.Remote(noteId, value.base64("update") ?: return null)
            "flush" -> ToEditor.Flush(noteId)
            "close" -> ToEditor.Close(noteId)
            "compact" -> ToEditor.Compact(noteId, storedOf(value["updates"]) ?: return null)
            "format" -> {
                val command = FormatCommand.of(value.string("command")) ?: return null
                val href = value["href"]
                when {
                    command == FormatCommand.LINK -> ToEditor.Format(noteId, command, value.string("href") ?: return null)
                    href != null -> null
                    else -> ToEditor.Format(noteId, command)
                }
            }
            "dismiss" -> ToEditor.Dismiss(noteId)
            "focus" -> ToEditor.Focus(noteId)
            "focusTitle" -> ToEditor.FocusTitle(noteId)
            "insertImages" -> ToEditor.InsertImages(
                noteId,
                value.strings("paths")?.takeIf { paths -> paths.isNotEmpty() && paths.all(ATTACHMENT_PATH::matches) }
                    ?: return null,
            )
            "copyConflicts" -> ToEditor.CopyConflicts(
                noteId,
                storedOf(value["base"]) ?: return null,
                storedOf(value["edits"])?.takeIf { it.isNotEmpty() } ?: return null,
                when (val into = value["into"]) {
                    null -> null
                    is JsonObject -> CopyInto(
                        into.string("noteId")?.takeIf(NOTE_ID::matches) ?: return null,
                        storedOf(into["updates"]) ?: return null,
                    )
                    else -> return null
                },
                notebookOf(value).takeIf { it != BAD_NOTEBOOK } ?: if (value.containsKey("notebook")) return null else null,
            )
            "attachmentStored" -> ToEditor.AttachmentStored(
                noteId,
                value.string("path")?.takeIf(ATTACHMENT_PATH::matches) ?: return null,
                value.boolean("ok") ?: return null,
            )
            "create" -> ToEditor.Create(noteId, notebookOf(value).takeIf { it != BAD_NOTEBOOK } ?: if (value.containsKey("notebook")) return null else null)
            "periodicNav" -> ToEditor.PeriodicNav(noteId)
            "setTag" -> ToEditor.SetTag(
                noteId,
                value.string("tag")?.takeIf { it.isNotBlank() && it.length <= MAX_TAG_CHARS } ?: return null,
                value.boolean("on") ?: return null,
            )
            "noteContent" -> {
                val state = ContentState.of(value.string("state")) ?: return null
                val updates = storedOf(value["updates"]) ?: return null
                if (state != ContentState.OK && updates.isNotEmpty()) return null
                ToEditor.NoteContent(noteId, state, updates)
            }
            "noteChanged" -> ToEditor.NoteChanged(noteId)
            "showHeading" -> ToEditor.ShowHeading(
                noteId,
                value.string("heading")?.takeIf { it.isNotBlank() && it.length <= MAX_HEADING_CHARS } ?: return null,
            )
            "symbol" -> ToEditor.Symbol(
                noteId,
                (value["index"] as? JsonPrimitive)?.takeIf { !it.isString }?.contentOrNull
                    ?.toIntOrNull()?.takeIf { it in 0 until LineSymbols.MAX } ?: return null,
            )
            else -> EditorParity.decodeToEditor(value.string("type"), noteId, value)
                ?: CommentsBridge.decodeToEditor(value.string("type"), noteId, value)
        }
    }

    private fun parse(raw: String): JsonObject? {
        val value = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(raw) }.getOrNull() as? JsonObject
            ?: return null
        val version = (value["v"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        return value.takeIf { version == BRIDGE_VERSION }
    }

    private fun JsonObjectBuilder.type(type: String, noteId: String) {
        put("type", type)
        put("noteId", noteId)
    }

    private fun JsonObjectBuilder.note(note: PageNote) {
        putJsonObject("note") {
            put("id", note.id)
            put("title", note.title)
            put("update", note.update)
        }
    }

    private fun JsonObjectBuilder.navTargetFields(target: FromEditor.NavTarget) {
        put("date", target.date)
        put("label", target.label)
        put("full", target.full)
        put("period", target.period)
    }

    private fun JsonObjectBuilder.navTarget(key: String, target: FromEditor.NavTarget) {
        putJsonObject(key) { navTargetFields(target) }
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.base64(key: String): String? = string(key)?.takeIf(BASE64::matches)

    private fun JsonObject.boolean(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private fun JsonObject.strings(key: String): List<String>? =
        (this[key] as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull ?: return null }

    private fun JsonArrayBuilder.stored(updates: List<StoredUpdate>) {
        for (stored in updates) {
            addJsonObject {
                put("id", stored.id.toString())
                put("update", stored.update)
            }
        }
    }

    private fun storedOf(element: JsonElement?): List<StoredUpdate>? {
        val array = element as? JsonArray ?: return null
        return array.map { entry ->
            val item = entry as? JsonObject ?: return null
            val id = item.string("id")?.toLongOrNull() ?: return null
            val update = item.base64("update") ?: return null
            StoredUpdate(id, update)
        }
    }

    private fun noteOf(element: JsonElement?): PageNote? {
        val item = element as? JsonObject ?: return null
        return PageNote(
            item.string("id")?.takeIf(NOTE_ID::matches) ?: return null,
            item.string("title") ?: return null,
            item.base64("update") ?: return null,
        )
    }

    private fun compacted(value: Compacted?): JsonElement = value?.let {
        buildJsonObject {
            putJsonArray("replaces") { it.replaces.forEach { id -> add(id.toString()) } }
            put("update", it.update)
        }
    } ?: JsonNull

    /** A field that may hold null; the field itself being null means it was malformed or missing. */
    private class Field<T>(val value: T)

    private fun compactedOf(element: JsonElement?): Field<Compacted?>? {
        if (element is JsonNull) return Field(null)
        val item = element as? JsonObject ?: return null
        val replaces = item.strings("replaces")?.map { it.toLongOrNull() ?: return null } ?: return null
        val update = item.base64("update") ?: return null
        return Field(Compacted(replaces, update))
    }
}
