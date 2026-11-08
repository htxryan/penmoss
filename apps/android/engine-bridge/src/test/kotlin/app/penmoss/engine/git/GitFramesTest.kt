package app.penmoss.engine.git

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * The git engine page's frames (T50 G7, A873) against `contract/git-engine-v1.json`, which the
 * page's own tests read too: Kotlin reads each example frame as the page wrote it, and writes the
 * same bytes back, so the two sides agree byte for byte.
 */
class GitFramesTest {
    private val contract: JsonObject by lazy {
        val dir = File(System.getProperty("penmoss.contract")).parentFile
        Json.parseToJsonElement(File(dir, "git-engine-v1.json").readText()).jsonObject
    }

    private fun hex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /** The contract shows each blob as `{"bytes": [...]}`: a blob reference becomes that. */
    private fun shown(value: JsonElement, frame: GitFrame): JsonElement = when {
        frame.bytes(value) != null -> JsonObject(mapOf("bytes" to JsonArray(frame.bytes(value)!!.map { JsonPrimitive(it.toInt() and 0xff) })))
        value is JsonArray -> JsonArray(value.map { shown(it, frame) })
        value is JsonObject -> JsonObject(value.mapValues { shown(it.value, frame) })
        else -> value
    }

    /** And back: `{"bytes": [...]}` into the frame's blobs, in the order they come. */
    private fun lifted(value: JsonElement, builder: FrameBuilder): JsonElement = when {
        value is JsonObject && value.keys == setOf("bytes") ->
            builder.blob(value.getValue("bytes").jsonArray.map { it.jsonPrimitive.int.toByte() }.toByteArray())
        value is JsonArray -> JsonArray(value.map { lifted(it, builder) })
        value is JsonObject -> JsonObject(value.mapValues { lifted(it.value, builder) })
        else -> value
    }

    @Test
    fun everyContractFrameReadsAsItsMessageAndIsWrittenBackByteForByte() {
        val frames = contract.getValue("frames").jsonArray
        assertTrue("the contract has its examples", frames.size >= 8)
        var blobs = 0
        for (example in frames) {
            val bytes = hex(example.jsonObject.getValue("hex").jsonPrimitive.content)
            val message = example.jsonObject.getValue("message").jsonObject
            val frame = GitFrame.decode(bytes)
            blobs += frame.blobs.size
            assertEquals(message, shown(frame.header, frame))
            val builder = FrameBuilder()
            val header = lifted(message, builder) as JsonObject
            assertArrayEquals("frame ${message["k"]} ${message["op"] ?: ""}", bytes, builder.encode(header))
        }
        assertTrue("file bytes cross as blobs", blobs >= 5)
    }

    @Test
    fun aFrameThatDoesNotAddUpIsRefused() {
        val good = hex(contract.getValue("frames").jsonArray[1].jsonObject.getValue("hex").jsonPrimitive.content)
        val bad = listOf(
            "short" to good.copyOf(good.size - 1),
            "trailing" to good + byteArrayOf(0),
            "no header" to byteArrayOf(0, 0),
            "header past the end" to byteArrayOf(0, 0, 0, 9, '{'.code.toByte(), '}'.code.toByte()),
            "not an object" to byteArrayOf(0, 0, 0, 2, '['.code.toByte(), ']'.code.toByte()),
            "not UTF-8" to byteArrayOf(0, 0, 0, 3, '"'.code.toByte(), 0xff.toByte(), '"'.code.toByte()),
            "huge header" to byteArrayOf(0x7f, 0, 0, 0, '{'.code.toByte(), '}'.code.toByte()),
            "negative size" to "\u0000\u0000\u0000\u0008{\"b\":[-1]}".toByteArray().let { it.copyOf().also { b -> b[3] = (it.size - 4).toByte() } },
        )
        for ((name, bytes) in bad) {
            try {
                GitFrame.decode(bytes)
                fail("read a frame that is $name")
            } catch (expected: FrameException) {
                // Refused.
            }
        }
    }

    @Test
    fun aReferenceIsOnlyAnObjectWithOneIndexKeyAndATooLargeFrameIsNotWritten() {
        val builder = FrameBuilder()
        val ref = builder.blob(byteArrayOf(7))
        val frame = GitFrame.decode(builder.encode(JsonObject(mapOf("v" to ref, "other" to JsonObject(mapOf("\$b" to JsonPrimitive(0), "x" to JsonPrimitive(1)))))))
        assertArrayEquals(byteArrayOf(7), frame.bytes(frame.header["v"]))
        assertEquals(null, frame.bytes(frame.header["other"]))
        assertEquals(null, frame.bytes(JsonObject(mapOf("\$b" to JsonPrimitive(5)))))
        val big = FrameBuilder()
        big.blob(ByteArray(GitFrame.MAX_FRAME_BYTES))
        try {
            big.encode(JsonObject(emptyMap()))
            fail("wrote a frame past the limit")
        } catch (expected: FrameException) {
            // Refused.
        }
    }
}
