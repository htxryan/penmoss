package app.penmoss.engine.notes

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** The tag browser's tree is the web tag pane's (T40 P6, TG1, A467): core's `tagTree` over the same notes. */
class TagTreeTest {
    private val fixture: JsonObject by lazy {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("tag-tree-v1.json") } ?: File("../contract/tag-tree-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val notes: List<List<String>> by lazy {
        fixture.getValue("notes").jsonArray.map { note -> note.jsonArray.map { it.jsonPrimitive.content } }
    }

    private fun node(json: JsonObject): TagNode = TagNode(
        json.getValue("tag").jsonPrimitive.content,
        json.getValue("name").jsonPrimitive.content,
        json.getValue("count").jsonPrimitive.int,
        (json.getValue("children") as JsonArray).map { node(it.jsonObject) },
    )

    @Test
    fun buildsTheTreeCoreBuildsFromTheSameNotes() {
        val expected = fixture.getValue("tree").jsonArray.map { node(it.jsonObject) }
        assertEquals(expected, TagTree.build(notes))
    }

    @Test
    fun putsUnderATagTheNotesCorePutsThere() {
        for (case in fixture.getValue("tagged").jsonArray) {
            val tag = case.jsonObject.getValue("tag").jsonPrimitive.content
            val expected = case.jsonObject.getValue("notes").jsonArray.map { it.jsonPrimitive.int }
            val found = notes.indices.filter { index -> notes[index].any { TagTree.matches(it, tag) } }
            assertEquals("under #$tag", expected, found)
        }
    }

    @Test
    fun countsANoteOnceUnderAParentAndNestsByEachLevel() {
        val tree = TagTree.build(listOf(listOf("log/2026", "log/2026/10"), listOf("log")))
        assertEquals(listOf(TagNode("log", "log", 2, listOf(TagNode("log/2026", "2026", 1, listOf(TagNode("log/2026/10", "10", 1, emptyList())))))), tree)
        assertEquals(listOf("a", "a/b", "a/b/c"), TagTree.ancestors("a/b/c"))
    }
}
