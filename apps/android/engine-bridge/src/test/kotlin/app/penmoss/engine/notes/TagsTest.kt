package app.penmoss.engine.notes

import app.penmoss.engine.bridge.BridgeProtocol
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/** The phone checks a typed tag by the rules every client uses (`packages/core/test/tags.test.ts`, T18). */
class TagsTest {
    @Test
    fun normalisesAsTheSharedRulesDo() {
        assertEquals("area/cooking", Tags.normalise("  #Area//Cooking/ "))
        assertNull(Tags.normalise("has space"))
        assertNull(Tags.normalise("2026"))
        assertEquals("log/2026", Tags.normalise("log/2026"))
        assertEquals("café", Tags.normalise("#Café"))
        assertEquals("to-do_list", Tags.normalise("To-Do_List"))
        assertNull(Tags.normalise(""))
        assertNull(Tags.normalise("#"))
        assertNull(Tags.normalise("a.b"))
        assertNull(Tags.normalise("2026/plans"))
    }

    /** The cases the page's suite runs through the shared `normaliseTag` (A361). */
    @Test
    fun normalisesEveryCaseOfTheSharedFixtureAsThePageDoes() {
        val contract = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("tags-v1.json") } ?: File("../contract/tags-v1.json")
        val fixture = Json.parseToJsonElement(contract.readText()).jsonObject
        assertEquals(fixture.getValue("maxChars").jsonPrimitive.int, Tags.MAX_CHARS)
        assertEquals(Tags.MAX_CHARS, BridgeProtocol.MAX_TAG_CHARS)
        val cases = fixture.getValue("normalise").jsonArray
        for (case in cases) {
            val raw = case.jsonObject.getValue("raw").jsonPrimitive.content
            val tag = case.jsonObject.getValue("tag").let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals("for \"$raw\"", tag, Tags.normalise(raw))
        }
    }

    @Test
    fun suggestsTagsContainingWhatIsTypedThoseStartingWithItFirst() {
        val known = listOf("garden" to 3, "area/cooking" to 9, "cooking" to 1, "inbox" to 20, "soup" to 2)
        assertEquals(listOf("cooking", "area/cooking"), Tags.suggest("cook", known, exclude = emptyList()))
        assertEquals(listOf("cooking", "area/cooking"), Tags.suggest("#Cook", known, exclude = emptyList()))
        // The note's own tags are not offered again.
        assertEquals(listOf("area/cooking"), Tags.suggest("cook", known, exclude = listOf("cooking")))
        // Nothing typed: the most used.
        assertEquals(listOf("inbox", "area/cooking"), Tags.suggest("", known, exclude = emptyList(), limit = 2))
        assertEquals(emptyList<String>(), Tags.suggest("zzz", known, exclude = emptyList()))
    }

    /** The web's own cases (`apps/web/test/unit/tag-suggest.test.ts`, A577), on the phone (TG6, A656). */
    @Test
    fun ranksAsTheWebDoes() {
        val notes = listOf(
            listOf("garden", "area/cooking"),
            listOf("gardening", "garden"),
            listOf("garden", "reading"),
            listOf("wildgarden"),
            listOf("area/garden-tools"),
        )
        val known = notes.flatten().groupingBy { it }.eachCount().toList()
        // Starting with it, then a level starting with it, then containing it; the most used first.
        assertEquals(listOf("garden", "gardening", "area/garden-tools", "wildgarden"), Tags.suggest("gard", known, emptyList()))
        assertEquals(listOf("area/cooking"), Tags.suggest("#Cook", known, emptyList()))
        assertEquals(listOf("area/cooking"), Tags.suggest("##cook", known, emptyList()))
        assertEquals(listOf("gardening", "area/garden-tools", "wildgarden"), Tags.suggest("gard", known, listOf("garden")))
        assertEquals(2, Tags.suggest("a", known, emptyList(), limit = 2).size)
        // A nested level wins over a tag that only contains the text, however used.
        assertEquals(listOf("area/den", "garden"), Tags.suggest("den", listOf("garden" to 9, "area/den" to 1), emptyList()))
    }

    @Test
    fun everyTagIsTheIndexsThenTheListsOthers() {
        val indexed = listOf("garden" to 3, "soup" to 1)
        val listed = listOf("garden" to 1, "new-here" to 1)
        assertEquals(listOf("garden" to 3, "soup" to 1, "new-here" to 1), Tags.everyTag(indexed, listed))
    }
}
