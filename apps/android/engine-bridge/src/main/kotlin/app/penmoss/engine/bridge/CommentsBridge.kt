package app.penmoss.engine.bridge

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/*
 * Comment threads (T48, D40, A770–A784): the bridge messages for the Comments sheet. The page
 * owns the note's Yjs document and so its threads; the app shows what the page lists
 * ([CommentFromEditor.Threads]) and asks the page for every change, which then reaches the app as
 * an ordinary `update` to store and upload (Kotlin never reads Yjs, A11). The page's side is
 * `apps/android/editor/src/comments-protocol.ts`; `bridge-v1.json` holds an example of each.
 */

/** Limits shared with the page and the server. */
object CommentLimits {
    /** A thread's or comment's id (the server's `COMMENT_ID`). */
    val ID = Regex("^[0-9A-Za-z_-]{1,40}$")

    /** An agent clone's writer id (T54; a ULID), as a thread's target names it (A1060). */
    val WRITER_ID = Regex("^[A-Za-z0-9_-]{1,80}$")

    /** A channel session's key: 24 hex digits of `sessionKey(writer, name)` (A1060). */
    val SESSION_KEY = Regex("^[0-9a-f]{24}$")

    /** The longest comment, in UTF-16 code units (`MAX_COMMENT_CHARS`). */
    const val MAX_CHARS = 20_000

    /** The longest target label: what Send to… showed for the session. */
    const val MAX_TARGET_LABEL = 300

    /** At most this many sessions in one [CommentToEditor.Sessions] (the page's `MAX_SESSIONS`). */
    const val MAX_SESSIONS = 500

    /** A device's actor id, as the server makes it: `device:` and the device's id. */
    val DEVICE_ACTOR_ID = Regex("^device:[A-Za-z0-9_-]{1,80}$")

    /** The longest device name the phone's own comments carry. */
    const val MAX_AUTHOR_LABEL = 300

    /** Whether [body] can be a comment's text: something besides spaces, and not too long. */
    fun usable(body: String): Boolean = body.isNotBlank() && body.length <= MAX_CHARS
}

/**
 * Where a new thread goes: the selection the selection menu kept, the editor's own selection (the
 * caret), or the note as a whole, with no passage (T52 item 5, Add Note Comment).
 */
enum class DraftSource(val wire: String) {
    SELECTION("selection"),
    CARET("caret"),
    NOTE("note"),
    ;

    companion object {
        fun of(wire: String?): DraftSource? = entries.firstOrNull { it.wire == wire }
    }
}

enum class ThreadStatus(val wire: String) {
    OPEN("open"),
    RESOLVED("resolved"),
    ;

    companion object {
        fun of(wire: String?): ThreadStatus? = entries.firstOrNull { it.wire == wire }
    }
}

/** Where delivery of a thread's newest comment to its agent session stands (A774). */
enum class DeliveryState(val wire: String) {
    WAITING("waiting"),
    SENT("sent"),
    SEEN("seen"),
    REPLIED("replied"),

    /** Not delivered: see [CommentDelivery.reason]. */
    FAILED("failed"),
    ;

    companion object {
        fun of(wire: String?): DeliveryState? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * Why a delivery failed: the session has not been seen for a week ([GONE], A1062). [SCOPE] and
 * [REVOKED] were the server's (a token's folder, a revoked token) and are only read.
 */
enum class DeliveryFailure(val wire: String) {
    GONE("gone"),
    SCOPE("scope"),
    REVOKED("revoked"),
    ;

    companion object {
        fun of(wire: String?): DeliveryFailure? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * The agent session a thread is sent to (A1060): the agent clone's writer, the session's key, and
 * what Send to… showed.
 */
data class CommentTarget(val writer: String, val session: String, val label: String)

/** A session the notebook lists, as the page's gone check needs it (A1062, A1077). */
data class SessionSeen(val key: String, val lastSeen: Long)

/** Who wrote a comment: one of Ryan's devices, or an agent. */
data class CommentAuthor(val agent: Boolean, val label: String)

data class CommentEntry(
    val id: String,
    val author: CommentAuthor,
    /** Markdown, shown as written. */
    val body: String,
    /** Epoch ms, the writer's clock. */
    val at: Long,
    val edited: Long? = null,
    /** The thread's first comment, removed (A784): its text is gone, its replies stay. */
    val removed: Boolean = false,
)

/** Where delivery stands; [reason] only with [DeliveryState.FAILED], when the server said why. */
data class CommentDelivery(val state: DeliveryState, val at: Long, val reason: DeliveryFailure? = null)

/** A thread as the sheet lists it. */
data class CommentThread(
    val id: String,
    val status: ThreadStatus,
    val quote: String,
    /** Its text was deleted, or its block is gone: listed last, with its quote. */
    val orphaned: Boolean,
    /** On a passage (false: at a point). */
    val range: Boolean,
    val created: Long,
    val author: CommentAuthor,
    val comments: List<CommentEntry>,
    val target: CommentTarget? = null,
    val delivery: CommentDelivery? = null,
    val resolvedAt: Long? = null,
    val resolvedBy: CommentAuthor? = null,
    /** On the note as a whole (T52 item 5): no passage, listed first, never orphaned. */
    val note: Boolean = false,
)

/**
 * Who this phone's comments are by (review S5): its device actor as the server names it, so the
 * page writes new threads, replies and resolves under it and the server need not rewrite them
 * (A781). About no note: sent when the page is ready, and again if the account changes.
 */
data class CommentAuthorToEditor(
    /** `device:` and the device's id. */
    val id: String,
    /** The device's name, `/api/me`'s actor label. */
    val label: String,
) : ToEditor {
    companion object {
        /** The message for a signed-in device, or null until both its id and its name are known. */
        fun of(deviceId: String?, label: String?): CommentAuthorToEditor? {
            val id = deviceId?.let { "device:$it" }?.takeIf(CommentLimits.DEVICE_ACTOR_ID::matches) ?: return null
            val name = label?.takeIf { it.isNotBlank() && it.length <= CommentLimits.MAX_AUTHOR_LABEL } ?: return null
            return CommentAuthorToEditor(id, name)
        }
    }
}

/** The comment messages from the app to the page. */
sealed interface CommentToEditor : ToEditor {
    val noteId: String

    /** Take a new thread's place; the page answers [CommentFromEditor.Draft]. */
    data class Draft(override val noteId: String, val from: DraftSource) : CommentToEditor

    /** Write the draft's thread with its first comment, sent to [target] or not. */
    data class Create(override val noteId: String, val body: String, val target: CommentTarget?) : CommentToEditor

    data class Reply(override val noteId: String, val threadId: String, val body: String) : CommentToEditor

    /** Change one of Ryan's own comments. */
    data class Edit(override val noteId: String, val threadId: String, val commentId: String, val body: String) :
        CommentToEditor

    /** Remove a comment: an agent's (its undo, A779) or Ryan's; the first one is only marked removed (A784). */
    data class Delete(override val noteId: String, val threadId: String, val commentId: String) : CommentToEditor

    data class DeleteThread(override val noteId: String, val threadId: String) : CommentToEditor

    /** Resolve or reopen. */
    data class Status(override val noteId: String, val threadId: String, val status: ThreadStatus) : CommentToEditor

    /** Send to… an agent session, or (null) stop sending. */
    data class Target(override val noteId: String, val threadId: String, val target: CommentTarget?) : CommentToEditor

    /** The sheet's open thread, highlighted in the note (and scrolled to with [reveal]); null for none. */
    data class Active(override val noteId: String, val threadId: String?, val reveal: Boolean) : CommentToEditor

    /**
     * The sessions the notebook's WorkspaceDoc lists (T60, A1077), sent as the note's comments are
     * shown: the page fails each delivery still waiting for one gone (A1062).
     */
    data class Sessions(override val noteId: String, val sessions: List<SessionSeen>) : CommentToEditor
}

/** The comment messages from the page to the app. */
sealed interface CommentFromEditor : FromEditor {
    val noteId: String

    /** Every thread in document order, orphans last, whenever any of it changes. */
    data class Threads(
        override val noteId: String,
        /** How many are open. */
        val open: Int,
        val active: String?,
        val threads: List<CommentThread>,
    ) : CommentFromEditor

    /** A highlighted passage or a point's marker was tapped. */
    data class Open(override val noteId: String, val threadId: String) : CommentFromEditor

    /** A new thread's place: its quote, on a passage ([range]), at a point, or on the whole [note] (T52 item 5). */
    data class Draft(override val noteId: String, val quote: String, val range: Boolean, val note: Boolean = false) : CommentFromEditor

    /**
     * A thread was sent to its agent session just now (T60, A1078), its update posted before
     * this: the app stores it and syncs the notebook at once.
     */
    data class Sent(override val noteId: String, val threadId: String) : CommentFromEditor
}

/** Reads and writes the comment messages for [BridgeProtocol]. */
internal object CommentsBridge {
    fun encode(builder: JsonObjectBuilder, message: CommentToEditor) = with(builder) {
        put("type", typeOf(message))
        put("noteId", message.noteId)
        when (message) {
            is CommentToEditor.Draft -> put("from", message.from.wire)
            is CommentToEditor.Create -> {
                put("body", message.body)
                target("target", message.target)
            }
            is CommentToEditor.Reply -> {
                put("threadId", message.threadId)
                put("body", message.body)
            }
            is CommentToEditor.Edit -> {
                put("threadId", message.threadId)
                put("commentId", message.commentId)
                put("body", message.body)
            }
            is CommentToEditor.Delete -> {
                put("threadId", message.threadId)
                put("commentId", message.commentId)
            }
            is CommentToEditor.DeleteThread -> put("threadId", message.threadId)
            is CommentToEditor.Status -> {
                put("threadId", message.threadId)
                put("status", message.status.wire)
            }
            is CommentToEditor.Target -> {
                put("threadId", message.threadId)
                target("target", message.target)
            }
            is CommentToEditor.Active -> {
                put("threadId", message.threadId?.let(::JsonPrimitive) ?: JsonNull)
                put("reveal", message.reveal)
            }
            is CommentToEditor.Sessions -> putJsonArray("sessions") {
                for (session in message.sessions) {
                    addJsonObject {
                        put("key", session.key)
                        put("lastSeen", session.lastSeen)
                    }
                }
            }
        }
    }

    fun encode(builder: JsonObjectBuilder, message: CommentAuthorToEditor) = with(builder) {
        put("type", "commentAuthor")
        put("id", message.id)
        put("label", message.label)
    }

    /** `commentAuthor` to the page, or null when malformed. */
    fun decodeAuthor(value: JsonObject): CommentAuthorToEditor? {
        val id = value.string("id")?.takeIf(CommentLimits.DEVICE_ACTOR_ID::matches) ?: return null
        val label = value.string("label")?.takeIf { it.isNotBlank() && it.length <= CommentLimits.MAX_AUTHOR_LABEL } ?: return null
        return CommentAuthorToEditor(id, label)
    }

    fun encode(builder: JsonObjectBuilder, message: CommentFromEditor) = with(builder) {
        when (message) {
            is CommentFromEditor.Threads -> {
                put("type", "comments")
                put("noteId", message.noteId)
                put("open", message.open)
                put("active", message.active?.let(::JsonPrimitive) ?: JsonNull)
                putJsonArray("threads") { message.threads.forEach { thread -> addJsonObject { thread(thread) } } }
            }
            is CommentFromEditor.Open -> {
                put("type", "commentOpen")
                put("noteId", message.noteId)
                put("threadId", message.threadId)
            }
            is CommentFromEditor.Draft -> {
                put("type", "commentDraft")
                put("noteId", message.noteId)
                put("quote", message.quote)
                put("kind", kindOf(message.range, message.note))
            }
            is CommentFromEditor.Sent -> {
                put("type", "commentSent")
                put("noteId", message.noteId)
                put("threadId", message.threadId)
            }
        }
    }

    private fun typeOf(message: CommentToEditor): String = when (message) {
        is CommentToEditor.Draft -> "commentDraft"
        is CommentToEditor.Create -> "commentCreate"
        is CommentToEditor.Reply -> "commentReply"
        is CommentToEditor.Edit -> "commentEdit"
        is CommentToEditor.Delete -> "commentDelete"
        is CommentToEditor.DeleteThread -> "commentDeleteThread"
        is CommentToEditor.Status -> "commentStatus"
        is CommentToEditor.Target -> "commentTarget"
        is CommentToEditor.Active -> "commentActive"
        is CommentToEditor.Sessions -> "commentSessions"
    }

    /** A comment message to the page, or null (malformed, or not one of these). */
    fun decodeToEditor(type: String?, noteId: String, value: JsonObject): CommentToEditor? = when (type) {
        "commentDraft" -> CommentToEditor.Draft(noteId, DraftSource.of(value.string("from")) ?: return null)
        "commentCreate" -> CommentToEditor.Create(
            noteId,
            value.body() ?: return null,
            (targetOf(value["target"]) ?: return null).value,
        )
        "commentReply" -> CommentToEditor.Reply(noteId, value.id("threadId") ?: return null, value.body() ?: return null)
        "commentEdit" -> CommentToEditor.Edit(
            noteId,
            value.id("threadId") ?: return null,
            value.id("commentId") ?: return null,
            value.body() ?: return null,
        )
        "commentDelete" -> CommentToEditor.Delete(noteId, value.id("threadId") ?: return null, value.id("commentId") ?: return null)
        "commentDeleteThread" -> CommentToEditor.DeleteThread(noteId, value.id("threadId") ?: return null)
        "commentStatus" -> CommentToEditor.Status(
            noteId,
            value.id("threadId") ?: return null,
            ThreadStatus.of(value.string("status")) ?: return null,
        )
        "commentTarget" -> CommentToEditor.Target(
            noteId,
            value.id("threadId") ?: return null,
            (targetOf(value["target"]) ?: return null).value,
        )
        "commentActive" -> CommentToEditor.Active(
            noteId,
            when (value["threadId"]) {
                is JsonNull -> null
                null -> return null
                else -> value.id("threadId") ?: return null
            },
            value.boolean("reveal") ?: return null,
        )
        "commentSessions" -> CommentToEditor.Sessions(
            noteId,
            (value["sessions"] as? JsonArray)?.takeIf { it.size <= CommentLimits.MAX_SESSIONS }?.map { each ->
                val session = each as? JsonObject ?: return null
                SessionSeen(
                    session.string("key")?.takeIf(CommentLimits.SESSION_KEY::matches) ?: return null,
                    session.long("lastSeen")?.takeIf { it >= 0 } ?: return null,
                )
            } ?: return null,
        )
        else -> null
    }

    /** A comment message from the page, or null (malformed, or not one of these). */
    fun decodeFromEditor(type: String?, noteId: String, value: JsonObject): CommentFromEditor? = when (type) {
        "comments" -> CommentFromEditor.Threads(
            noteId,
            (value["open"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it >= 0 } ?: return null,
            when (value["active"]) {
                is JsonNull -> null
                null -> return null
                else -> value.id("active") ?: return null
            },
            (value["threads"] as? JsonArray)?.map { threadOf(it) ?: return null } ?: return null,
        )
        "commentOpen" -> CommentFromEditor.Open(noteId, value.id("threadId") ?: return null)
        "commentDraft" -> CommentFromEditor.Draft(
            noteId,
            value.string("quote") ?: return null,
            when (value.string("kind")) {
                "range" -> true
                "point", "note" -> false
                else -> return null
            },
            note = value.string("kind") == "note",
        )
        "commentSent" -> CommentFromEditor.Sent(noteId, value.id("threadId") ?: return null)
        else -> null
    }

    /** A thread's or draft's `kind` on the wire: on a passage, at a point, or on the note (T52 item 5). */
    private fun kindOf(range: Boolean, note: Boolean) = when {
        note -> "note"
        range -> "range"
        else -> "point"
    }

    private fun JsonObjectBuilder.target(key: String, target: CommentTarget?) {
        if (target == null) {
            put(key, JsonNull)
            return
        }
        putJsonObject(key) {
            put("writer", target.writer)
            put("session", target.session)
            put("label", target.label)
        }
    }

    private fun JsonObjectBuilder.author(key: String, author: CommentAuthor) {
        putJsonObject(key) {
            put("kind", if (author.agent) "agent" else "device")
            put("label", author.label)
        }
    }

    private fun JsonObjectBuilder.thread(thread: CommentThread) {
        put("id", thread.id)
        put("status", thread.status.wire)
        put("quote", thread.quote)
        put("orphaned", thread.orphaned)
        put("kind", kindOf(thread.range, thread.note))
        put("created", thread.created)
        author("author", thread.author)
        putJsonArray("comments") {
            for (comment in thread.comments) {
                addJsonObject {
                    put("id", comment.id)
                    author("author", comment.author)
                    put("body", comment.body)
                    put("at", comment.at)
                    comment.edited?.let { put("edited", it) }
                    if (comment.removed) put("removed", true)
                }
            }
        }
        thread.target?.let { target("target", it) }
        thread.delivery?.let { delivery ->
            putJsonObject("delivery") {
                put("state", delivery.state.wire)
                put("at", delivery.at)
                delivery.reason?.let { put("reason", it.wire) }
            }
        }
        thread.resolvedAt?.let { put("resolvedAt", it) }
        thread.resolvedBy?.let { author("resolvedBy", it) }
    }

    /** A field that may hold null; the [Field] itself null means it was malformed or missing. */
    private class Field<T>(val value: T)

    private fun targetOf(element: JsonElement?): Field<CommentTarget?>? {
        if (element is JsonNull) return Field(null)
        return targetValue(element)?.let { Field(it) }
    }

    private fun targetValue(element: JsonElement?): CommentTarget? {
        val item = element as? JsonObject ?: return null
        return CommentTarget(
            item.string("writer")?.takeIf(CommentLimits.WRITER_ID::matches) ?: return null,
            item.string("session")?.takeIf(CommentLimits.SESSION_KEY::matches) ?: return null,
            item.string("label")?.takeIf { it.isNotBlank() && it.length <= CommentLimits.MAX_TARGET_LABEL } ?: return null,
        )
    }

    private fun authorOf(element: JsonElement?): CommentAuthor? {
        val item = element as? JsonObject ?: return null
        val agent = when (item.string("kind")) {
            "agent" -> true
            "device" -> false
            else -> return null
        }
        return CommentAuthor(agent, item.string("label") ?: return null)
    }

    private fun threadOf(element: JsonElement): CommentThread? {
        val item = element as? JsonObject ?: return null
        return CommentThread(
            id = item.id("id") ?: return null,
            status = ThreadStatus.of(item.string("status")) ?: return null,
            quote = item.string("quote") ?: return null,
            orphaned = item.boolean("orphaned") ?: return null,
            range = when (item.string("kind")) {
                "range" -> true
                "point", "note" -> false
                else -> return null
            },
            note = item.string("kind") == "note",
            created = item.long("created") ?: return null,
            author = authorOf(item["author"]) ?: return null,
            comments = (item["comments"] as? JsonArray)?.map { entry ->
                val comment = entry as? JsonObject ?: return null
                CommentEntry(
                    comment.id("id") ?: return null,
                    authorOf(comment["author"]) ?: return null,
                    comment.string("body") ?: return null,
                    comment.long("at") ?: return null,
                    when (comment["edited"]) {
                        null -> null
                        else -> comment.long("edited") ?: return null
                    },
                    // Present only as true (A784).
                    removed = when (comment["removed"]) {
                        null -> false
                        else -> comment.boolean("removed")?.takeIf { it } ?: return null
                    },
                )
            } ?: return null,
            target = when (val raw = item["target"]) {
                null -> null
                else -> targetValue(raw) ?: return null
            },
            delivery = when (val raw = item["delivery"]) {
                null -> null
                else -> (raw as? JsonObject)?.let { delivery ->
                    val state = DeliveryState.of(delivery.string("state")) ?: return null
                    CommentDelivery(
                        state,
                        delivery.long("at") ?: return null,
                        // Only a failed delivery says why.
                        when (delivery["reason"]) {
                            null -> null
                            else -> DeliveryFailure.of(delivery.string("reason"))?.takeIf { state == DeliveryState.FAILED } ?: return null
                        },
                    )
                } ?: return null
            },
            resolvedAt = when (item["resolvedAt"]) {
                null -> null
                else -> item.long("resolvedAt") ?: return null
            },
            resolvedBy = when (val raw = item["resolvedBy"]) {
                null -> null
                else -> authorOf(raw) ?: return null
            },
        )
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.id(key: String): String? = string(key)?.takeIf(CommentLimits.ID::matches)

    private fun JsonObject.body(): String? = string("body")?.takeIf(CommentLimits::usable)

    private fun JsonObject.boolean(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private fun JsonObject.long(key: String): Long? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
}
