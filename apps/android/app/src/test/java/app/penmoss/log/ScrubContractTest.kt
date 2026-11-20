package app.penmoss.log

import app.penmoss.feedback.ErrorScrub
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The phone's log scrubber is core's (PEN-137, AC14, AC22): every case of
 * `apps/android/contract/scrub-v1.json`, which core's `scrub.ts` writes and checks, turns each
 * input line into the same expected line here, numbering carried from line to line.
 */
class ScrubContractTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("scrub-v1.json") }
            ?: File("../contract/scrub-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun strings(value: JsonObject, key: String): List<String> =
        value[key]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()

    private fun known(value: JsonObject) = ErrorScrub.Known(
        login = (value["login"] as? JsonPrimitive)?.content,
        notebooks = strings(value, "notebooks"),
        repositories = strings(value, "repositories"),
        branches = strings(value, "branches"),
        names = strings(value, "names"),
    )

    @Test
    fun everyCaseScrubsExactlyAsCoreDoes() {
        assertEquals(contract.getValue("minKnownName").jsonPrimitive.int, ErrorScrub.MIN_KNOWN_NAME)
        val cases = contract.getValue("cases").jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 5)
        for (case in cases) {
            val name = case.getValue("name").jsonPrimitive.content
            val scrubber = ErrorScrub.scrubber(known(case.getValue("known").jsonObject))
            val input = strings(case, "input")
            val expected = strings(case, "expected")
            assertEquals(name, expected.size, input.size)
            input.zip(expected).forEach { (line, want) -> assertEquals("$name: $line", want, scrubber.line(line)) }
        }
    }

    @Test
    fun noCanaryOutlivesScrubTwo() {
        val case = contract.getValue("cases").jsonArray.map { it.jsonObject }.first { it.getValue("name").jsonPrimitive.content == "canaries, scrub #2" }
        val scrubber = ErrorScrub.scrubber(known(case.getValue("known").jsonObject))
        val text = strings(case, "input").joinToString("\n") { scrubber.line(it) }.lowercase()
        for (canary in listOf("zebracanary", "okapicanary", "narwhalcanary", "quokkacanary", "axolotlcanary", "pangolincanary", "wombatcanary", "kiwicanary", "tapircanary", "lemurcanary", "ibis.canary", "ghp_canary", "slothcanary")) {
            assertFalse(canary, canary in text)
        }
    }
}
