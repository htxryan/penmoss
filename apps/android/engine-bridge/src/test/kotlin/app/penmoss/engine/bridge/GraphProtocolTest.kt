package app.penmoss.engine.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * The graph page's contract (T40 P7, A478), from the app's side: every example in
 * apps/android/contract/graph-v1.json the page sends is read here, every message the app
 * sends is written exactly as the example, and the malformed ones are refused. The page's
 * vitest suite (`graph.test.ts`) checks the same file.
 */
class GraphProtocolTest {
    private val contract: JsonObject = Json.parseToJsonElement(File("../contract/graph-v1.json").readText()).jsonObject

    private fun examples(name: String): JsonArray = contract.getValue(name).jsonArray

    @Test
    fun readsEveryMessageThePageSends() {
        for (example in examples("fromGraph")) {
            val message = GraphProtocol.decodeFromGraph(example.toString())
            assertNotNull("not read: $example", message)
            assertEquals(example, Json.parseToJsonElement(GraphProtocol.encode(message!!)))
        }
    }

    @Test
    fun writesEveryMessageThePageReads() {
        for (example in examples("toGraph")) {
            val message = GraphProtocol.decodeToGraph(example.toString())
            assertNotNull("not read: $example", message)
            assertEquals(example, Json.parseToJsonElement(GraphProtocol.encode(message!!)))
        }
    }

    @Test
    fun refusesMalformedMessagesAndOtherVersions() {
        for (example in examples("invalidToGraph")) {
            val raw = (example as JsonPrimitive).content
            assertNull("accepted: $raw", GraphProtocol.decodeToGraph(raw))
        }
        for (example in examples("invalidFromGraph")) {
            val raw = (example as JsonPrimitive).content
            assertNull("accepted: $raw", GraphProtocol.decodeFromGraph(raw))
        }
    }

    @Test
    fun offersTheDepthsThePageOffers() {
        assertEquals(examples("depths").map { it.jsonPrimitive.int }, GraphProtocol.DEPTHS)
    }

    @Test
    fun cutsAnOverlongTitleRatherThanSendingWhatThePageRefuses() {
        val long = GraphNote("n1", "x".repeat(GraphProtocol.MAX_TEXT + 50), null, List(GraphProtocol.MAX_NOTE_LINKS + 5) { "m$it" })
        val sent = GraphProtocol.decodeToGraph(GraphProtocol.encode(ToGraph.Graph(listOf(long), listOf(GraphGroup(null, "Top level")))))
        val note = (sent as ToGraph.Graph).notes.single()
        assertEquals(GraphProtocol.MAX_TEXT, note.title.length)
        assertEquals(GraphProtocol.MAX_NOTE_LINKS, note.links.size)
    }
}
