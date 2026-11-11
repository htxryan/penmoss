package app.penmoss.updates

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Which release notes Android shows (PEN-109): `contract/release-notes-v1.json` holds the cases the
 * web's `notes.ts` wrote (`release-notes-contract.test.ts`), and Kotlin's selection matches each
 * one, so the Mac and the phone pick the same notes.
 */
class ReleaseNotesContractTest {
    private val contract = Json.parseToJsonElement(File("../contract/release-notes-v1.json").readText()).jsonObject

    private fun block(b: NotesBlock?): JsonElement = if (b == null) JsonNull else buildJsonObject {
        put("title", b.title)
        put("builds", b.builds)
        put("groups", buildJsonArray {
            b.groups.forEach { g ->
                add(buildJsonObject {
                    put("kind", g.kind)
                    put("notes", buildJsonArray { g.notes.forEach { n -> add(buildJsonArray { add(JsonPrimitive(n.build)); add(JsonPrimitive(n.text)) }) } })
                })
            }
        })
    }

    @Test
    fun everyCasePicksWhatTheMacPicks() {
        assertEquals(1, contract.getValue("version").jsonPrimitive.content.toInt())
        val notes = parseNotes(contract.getValue("notes").toString())!!
        val cases = contract.getValue("cases").jsonArray
        assertTrue("the fixture has cases", cases.size >= 8)
        for (case in cases.map { it.jsonObject }) {
            val name = case.getValue("name").jsonPrimitive.content
            val current = case.getValue("current").jsonPrimitive.content
            val from = (case["updatedFrom"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val file = when (val f = case["file"]) {
                null -> notes
                JsonNull -> null
                else -> parseNotes(f.toString())
            }
            val view = notesView(file, current)
            val made = buildJsonObject {
                put("status", when (view) { NotesView.None -> "none"; NotesView.Newer -> "newer"; is NotesView.Ok -> "ok" })
                put("current", if (view is NotesView.Ok) block(view.current) else JsonNull)
                put("earlier", JsonArray(if (view is NotesView.Ok) view.earlier.map(::block) else emptyList()))
                put("notice", updatedNotice(file, current, from)?.let(::JsonPrimitive) ?: JsonNull)
            }
            assertEquals(name, case.getValue("expected"), made)
        }
    }

    @Test
    fun aFileThatIsNotOneReadsAsNone() {
        for (text in listOf("not json", "null", "{}", """{"schema":0}""", """{"schema":1,"notes":"x","releases":[]}""",
            """{"schema":1,"notes":[{"build":1,"pr":1,"kind":"changed","platform":null,"text":"x"}],"releases":[]}""")) {
            assertNull(text, parseNotes(text))
        }
        assertEquals(NotesFile(2, emptyList(), emptyList()), parseNotes("""{"schema":2,"anything":true}"""))
    }

    @Test
    fun eachVersionReadsItsChannelsFile() {
        assertEquals("$RELEASES_URL/download/alpha/release-notes.json", notesUrlFor("0.2.2-alpha.1185"))
        assertEquals("$RELEASES_URL/latest/download/release-notes.json", notesUrlFor("0.2.1"))
    }
}
