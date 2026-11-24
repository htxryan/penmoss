package app.penmoss.ui.common

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.ZoneId

/**
 * Sizes and how long ago are core's (PEN-188): every case core wrote to
 * `apps/android/contract/words-v1.json` comes out the same from [formatBytes] and [timeAgo].
 */
class WordsContractTest {
    private val contract = Json.parseToJsonElement(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("words-v1.json") } ?: File("../contract/words-v1.json")).readText(),
    ).jsonObject

    private fun cases(key: String): List<Pair<Long, String>> =
        contract.getValue(key).jsonArray.map { pair -> pair.jsonArray.let { it[0].jsonPrimitive.long to it[1].jsonPrimitive.content } }

    @Test
    fun everySizeIsCores() {
        val sizes = cases("sizes")
        assertTrue(sizes.size > 30)
        val wrong = sizes.filter { (bytes, want) -> formatBytes(bytes) != want }
            .map { (bytes, want) -> "$bytes: core \"$want\", Kotlin \"${formatBytes(bytes)}\"" }
        assertEquals(emptyList<String>(), wrong)
    }

    @Test
    fun everyTimeAgoIsCores() {
        val now = contract.getValue("now").jsonPrimitive.long
        val zone = ZoneId.of(contract.getValue("zone").jsonPrimitive.content)
        val ago = cases("ago")
        assertTrue(ago.size > 15)
        val wrong = ago.filter { (at, want) -> timeAgo(at, now, zone) != want }
            .map { (at, want) -> "$at: core \"$want\", Kotlin \"${timeAgo(at, now, zone)}\"" }
        assertEquals(emptyList<String>(), wrong)
    }
}
