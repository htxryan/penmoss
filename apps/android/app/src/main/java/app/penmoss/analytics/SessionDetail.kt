package app.penmoss.analytics

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Session detail (PEN-177): core's `detail.ts`, checked against `apps/android/contract/
 * analytics-v1.json` (its `detail`, `patterns`, `clamp`, `propsLine` and `eventCases`). The note
 * editor's events come from the editor page, which runs core's own code; here are the checks,
 * the clamping, the viewers' props line, and the refs, which only Kotlin makes (the page never
 * sees the key).
 */
object SessionDetail {
    /** The most a block index, a count of blocks or a depth may be. */
    const val MAX_INDEX = 5000

    /** The most a length in characters may be. */
    const val MAX_CHARS = 1_000_000

    const val MAX_SHAPE_TOKENS = 5000
    const val MAX_SHAPE_BYTES = 32 * 1024
    const val MAX_TABLE_SIDE = 999
    const val MAX_LIST_DEPTH = 9

    /** How long typing in a field must pause before its length is recorded. */
    const val INPUT_SETTLE_MS = 500L

    /** How many of a list prop's items the viewers show before "… +N". */
    const val PROPS_LIST_SHOWN = 12

    val INPUT_FIELDS = listOf("query", "name", "title", "body", "url", "other")

    /** A note's or folder's ref: 16 lower-case hex characters. */
    val REF = Regex("^[0-9a-f]{16}$")

    /** A block's token (core's BLOCK_PATTERN): a kind, and for a block with text its length. */
    val BLOCK = Regex(
        "^(?:(?:p|h[1-6]|li\\.[bnt]\\.[1-9]|quote|code|callout|math|raw|table\\.\\d{1,3}x\\d{1,3}):\\d{1,7}|image|embed|hr|file|drawing|other)$",
    )

    /** A shape prop: at most [MAX_SHAPE_TOKENS] tokens, each a [BLOCK] of length ≤ [MAX_CHARS], at most [MAX_SHAPE_BYTES] as JSON. */
    fun isShape(value: JsonElement): Boolean {
        if (value !is JsonArray || value.size > MAX_SHAPE_TOKENS) return false
        var bytes = 2 + maxOf(0, value.size - 1)
        for (item in value) {
            val token = (item as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
            if (!BLOCK.matches(token)) return false
            val colon = token.lastIndexOf(':')
            if (colon >= 0 && token.substring(colon + 1).toLong() > MAX_CHARS) return false
            bytes += token.length + 2
        }
        return bytes <= MAX_SHAPE_BYTES
    }

    /** Core's `clampUsage`: [value] held to its type's range, as a whole number. */
    fun clampUsage(type: String, value: Double): Int {
        val (min, max) = when (type) {
            "chars" -> 0 to MAX_CHARS
            "index" -> 0 to MAX_INDEX
            "side" -> 1 to MAX_TABLE_SIDE
            "depth" -> 1 to MAX_LIST_DEPTH
            else -> error("No clamp for $type")
        }
        if (!value.isFinite()) return min
        val whole = if (value < 0) kotlin.math.ceil(value) else kotlin.math.floor(value)
        return whole.coerceIn(min.toDouble(), max.toDouble()).toInt()
    }

    fun clampUsage(type: String, value: Int): Int = clampUsage(type, value.toDouble())

    /**
     * Core's `propsLine`: an event's props as the viewers show them, `key: value` joined by commas,
     * a list's items by spaces, and a list longer than [PROPS_LIST_SHOWN] cut to its first items
     * and "… +N" (a note's shape). Copy as JSON keeps every item.
     */
    fun propsLine(props: Map<String, JsonElement>): String = props.entries.joinToString(", ") { (key, value) ->
        val text = when (value) {
            is JsonArray -> {
                val shown = value.take(PROPS_LIST_SHOWN).joinToString(" ") { item -> item.text() }
                val more = value.size - PROPS_LIST_SHOWN
                if (more > 0) "$shown … +$more" else shown
            }
            else -> value.text()
        }
        "$key: $text"
    }

    private fun JsonElement.text(): String = (this as? JsonPrimitive)?.content ?: toString()

}

/**
 * Refs (PEN-177): a note or folder named by `hex(HMAC-SHA256(key, type + ":" + id))[0..16]`, the
 * key being this install's 32 random bytes (kept as 64 hex characters in [ConsentStore], never
 * sent, made again with a new analytics ID). The same note always has the same ref on one
 * install; no one without the key can turn it back into its id. Core's `node/ref-key.ts` makes
 * the same refs, pinned by analytics-v1.json's `refVectors`.
 */
object AnalyticsRefs {
    val KEY = Regex("^[0-9a-f]{64}$")

    private val random = SecureRandom()

    /** A new key: 32 random bytes as hex. */
    fun newKey(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /** The ref of [id] of [type] (`note` or `folder`) under [key]. */
    fun refOf(key: String, type: String, id: String): String {
        require(KEY.matches(key)) { "Not a ref key" }
        val bytes = ByteArray(32) { index -> key.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(bytes, "HmacSHA256"))
        val digest = mac.doFinal("$type:$id".toByteArray(Charsets.UTF_8))
        return digest.take(8).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}

/**
 * The notes list's folder tree (PEN-177), as the Mac's sidebar tree records it: a folder's page
 * opened from the notes list (`tree expand`), that page left however it is left (`tree collapse`:
 * its top bar's Back is `click`, the system Back, its gesture or a predictive back is `key`), and a
 * note opened from the list (`tree open`), each by ref and depth (0 for the notebook's top level).
 * The rows' own clicks (`note-list.folder`, …) stay; these say where in the tree it was.
 */
object TreeEvents {
    fun expand(folderId: String, depth: Int, source: String = "click"): Boolean = folder("expand", folderId, depth, source)

    fun collapse(folderId: String, depth: Int, source: String = "click"): Boolean = folder("collapse", folderId, depth, source)

    /** [noteId] was opened from the tree; [folderId] null at the top level. */
    fun open(noteId: String, folderId: String?, depth: Int, source: String = "click"): Boolean = Analytics.recordWithRefs(
        "tree",
        "open",
        mapOf("depth" to SessionDetail.clampUsage("index", depth), "source" to source),
        mapOf("note" to ("note" to noteId), "folder" to ("folder" to folderId)),
    )

    private fun folder(name: String, folderId: String, depth: Int, source: String) = Analytics.recordWithRefs(
        "tree",
        name,
        mapOf("depth" to SessionDetail.clampUsage("index", depth), "source" to source),
        mapOf("folder" to ("folder" to folderId)),
    )
}
