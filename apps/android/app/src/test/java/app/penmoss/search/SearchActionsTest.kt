package app.penmoss.search

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Search's actions are the commands contract's (T40 P6, FD6, A466): `commands-v1.json` lists
 * every web command with how a phone reaches it, and its web test fails when one has no entry.
 * Here: the phone offers exactly the `{"search": true}` entries, in the registry's order, with
 * the web's titles, and ranks them as the palette's `fuzzy` does.
 */
class SearchActionsTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("commands-v1.json") }
            ?: File("../contract/commands-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val commands = contract.getValue("commands").jsonArray.map { it.jsonObject }


    @Test
    fun offersExactlyTheContractsSearchActionsInItsOrderWithTheWebsTitles() {
        val search = commands.filter { (it["android"] as? JsonObject)?.containsKey("search") == true }
            .map { SearchAction(it.getValue("id").jsonPrimitive.content, it.getValue("title").jsonPrimitive.content) }
        assertEquals(search, SearchActions.ALL)
    }

    @Test
    fun everyWebCommandSaysHowAPhoneReachesIt() {
        assertTrue(commands.size > 50)
        for (command in commands) {
            val android = command["android"] as? JsonObject
            assertNotNull("${command["id"]} has no Android entry", android)
            assertEquals("${command["id"]}", 1, android!!.size)
            assertTrue(android.keys.single() in setOf("search", "elsewhere", "na"))
        }
    }

    @Test
    fun ranksAsTheWebPalettesFuzzyMatchRanks() {
        val cases = contract.getValue("fuzzy").jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val query = case.getValue("query").jsonPrimitive.content
            val expected = case.getValue("ids").jsonArray.map { it.jsonPrimitive.content }
            assertEquals("for \"$query\"", expected, SearchActions.matching(query).map { it.id })
        }
    }

    @Test
    fun matchesLettersInOrderAndRefusesScatteredOnes() {
        assertNotNull(Fuzzy.score("tdm", "Toggle Dark Mode"))
        assertNull(Fuzzy.score("mdt", "Toggle Dark Mode"))
        // Scattered across a long title: no match, as on the web.
        assertNull(Fuzzy.score("sx", "s" + "a".repeat(20) + "x"))
        assertTrue(SearchActions.matching("  ").isEmpty())
    }
}
