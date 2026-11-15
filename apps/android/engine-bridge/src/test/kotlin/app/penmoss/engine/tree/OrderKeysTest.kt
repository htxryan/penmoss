package app.penmoss.engine.tree

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * `OrderKeys.keyBetween` against `packages/core/src/workspace/order.ts` (T40 P4, NT7):
 * `contract/order-keys-v1.json`, which the editor page's vitest writes from core's `keyBetween`
 * and fails when it differs (architecture review A12), plus betweenness on longer chains.
 */
class OrderKeysTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("order-keys-v1.json") } ?: File("../contract/order-keys-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test
    fun matchesTheTypeScriptImplementation() {
        val vectors = contract.getValue("vectors").jsonArray.map { it.jsonObject }
        assertTrue(vectors.size >= 30)
        for (vector in vectors) {
            val before = vector["before"]?.jsonPrimitive?.contentOrNull
            val after = vector["after"]?.jsonPrimitive?.contentOrNull
            assertEquals("keyBetween($before, $after)", vector.getValue("key").jsonPrimitive.content, OrderKeys.keyBetween(before, after))
        }
    }

    @Test
    fun everyKeyLandsBetweenItsBounds() {
        var lo: String? = null
        repeat(40) {
            val key = OrderKeys.keyBetween(lo, null)
            if (lo != null) assertTrue(key > lo!!)
            lo = key
        }
        var hi: String? = null
        repeat(40) {
            val key = OrderKeys.keyBetween(null, hi)
            if (hi != null) assertTrue(key < hi!!)
            hi = key
        }
        var a = "a0"
        var b = "a1"
        repeat(60) {
            val key = OrderKeys.keyBetween(a, b)
            assertTrue("$key between $a and $b", key > a && key < b)
            // Alternate sides so both bounds tighten.
            if (key.hashCode() % 2 == 0) a = key else b = key
        }
    }

    @Test
    fun refusesOutOfOrderBounds() {
        try {
            OrderKeys.keyBetween("a1", "a0")
            fail("expected out-of-order bounds to throw")
        } catch (expected: IllegalArgumentException) {
        }
    }
}
