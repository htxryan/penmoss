package app.penmoss.engine.git

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The git engine page's frames (T50 G7, A873), Kotlin's side of `editor/src/git/frames.ts`: a
 * big-endian `u32` header length, the header as UTF-8 JSON with each blob as `{"$b": index}` and
 * `b` listing their lengths, then the blobs. File bytes cross as bytes: Kotlin never decodes
 * base64 for a git notebook and never reads Yjs (A11). `contract/git-engine-v1.json` holds the
 * examples both sides read.
 */
class GitFrame(
    /** The header without `b`: blobs stand as `{"$b": index}` in it. */
    val header: JsonObject,
    val blobs: List<ByteArray>,
) {
    /** The bytes a blob reference stands for, or null when [value] is not one. */
    fun bytes(value: JsonElement?): ByteArray? {
        val ref = value as? JsonObject ?: return null
        if (ref.size != 1) return null
        val index = (ref["\$b"] as? JsonPrimitive)?.intOrNull ?: return null
        return blobs.getOrNull(index)
    }

    companion object {
        const val MAX_HEADER_BYTES = 16 * 1024 * 1024
        const val MAX_FRAME_BYTES = 96 * 1024 * 1024

        fun decode(bytes: ByteArray): GitFrame {
            if (bytes.size < 4 || bytes.size > MAX_FRAME_BYTES) throw FrameException("Not a frame")
            val length = ByteBuffer.wrap(bytes, 0, 4).order(ByteOrder.BIG_ENDIAN).int.toLong() and 0xffffffffL
            if (length > MAX_HEADER_BYTES || 4 + length > bytes.size) throw FrameException("The frame header does not fit")
            val text = try {
                Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes, 4, length.toInt())).toString()
            } catch (error: java.nio.charset.CharacterCodingException) {
                throw FrameException("The frame header is not UTF-8")
            }
            val header = try {
                Json.parseToJsonElement(text) as? JsonObject
            } catch (error: kotlinx.serialization.SerializationException) {
                null
            } ?: throw FrameException("The frame header is not a JSON object")
            val sizes = (header["b"] as? JsonArray ?: JsonArray(emptyList())).map {
                (it as? JsonPrimitive)?.intOrNull?.takeIf { size -> size >= 0 } ?: throw FrameException("The frame lists no blob sizes")
            }
            var at = 4 + length.toInt()
            val blobs = sizes.map { size ->
                if (at.toLong() + size > bytes.size) throw FrameException("A blob runs past the frame")
                bytes.copyOfRange(at, at + size).also { at += size }
            }
            if (at != bytes.size) throw FrameException("The frame has bytes after its blobs")
            return GitFrame(JsonObject(header - "b"), blobs)
        }
    }
}

class FrameException(message: String) : RuntimeException(message)

/** Builds a frame: [blob] puts bytes in and returns their reference for the header. */
class FrameBuilder {
    private val blobs = mutableListOf<ByteArray>()

    fun blob(bytes: ByteArray): JsonObject {
        blobs += bytes
        return JsonObject(mapOf("\$b" to JsonPrimitive(blobs.size - 1)))
    }

    fun encode(header: JsonObject): ByteArray {
        val full = JsonObject(header + ("b" to JsonArray(blobs.map { JsonPrimitive(it.size) })))
        val text = Json.encodeToString(JsonElement.serializer(), full).toByteArray(Charsets.UTF_8)
        if (text.size > GitFrame.MAX_HEADER_BYTES) throw FrameException("The frame header is too large")
        val total = 4L + text.size + blobs.sumOf { it.size.toLong() }
        if (total > GitFrame.MAX_FRAME_BYTES) throw FrameException("The frame is too large")
        val out = ByteBuffer.allocate(total.toInt()).order(ByteOrder.BIG_ENDIAN)
        out.putInt(text.size)
        out.put(text)
        for (blob in blobs) out.put(blob)
        return out.array()
    }
}

/** A blob reference's index, for tests. */
internal fun blobIndex(value: JsonElement): Int? = ((value as? JsonObject)?.get("\$b") as? JsonPrimitive)?.let { runCatching { it.int }.getOrNull() }

internal val JsonElement.textOrNull: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun JsonElement?.text(): String? = this?.let { if (it is JsonPrimitive && it.isString) it.jsonPrimitive.content else null }
