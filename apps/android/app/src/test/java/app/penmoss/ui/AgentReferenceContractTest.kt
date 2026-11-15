package app.penmoss.ui

import android.content.ClipData
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Copy Agent Reference (T52 item 4; one line with the short id since PEN-69) copies what the web
 * and the Mac copy: `contract/agent-reference-v1.json` holds core's `agentReference` for each case
 * (written by the web's `agent-reference-contract.test.ts`), and Android's text matches every one
 * exactly, the short id's hash and clashes included.
 */
@RunWith(AndroidJUnit4::class)
class AgentReferenceContractTest {
    private val contract = Json.parseToJsonElement(File("../contract/agent-reference-v1.json").readText()).jsonObject

    @Test
    fun everyCaseReadsAsCoreWritesIt() {
        assertEquals(2, contract.getValue("version").jsonPrimitive.content.toInt())
        val cases = contract.getValue("cases").jsonArray
        assertTrue("the fixture has cases", cases.size >= 5)
        for (case in cases) {
            val name = case.jsonObject.getValue("name").jsonPrimitive.content
            val input = case.jsonObject.getValue("input").jsonObject
            val text = AgentReference.text(
                id = input.getValue("id").jsonPrimitive.content,
                gitNotebook = input["gitNotebook"]?.jsonPrimitive?.content,
                notebookId = input["notebookId"]?.jsonPrimitive?.content,
                noteIds = input["noteIds"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            )
            assertEquals(name, case.jsonObject.getValue("expected").jsonPrimitive.content, text)
        }
    }

    private val notebook = "01JQ7M1WQ3R4ZK3V8N2C5D6E7F"
    private val id = "01M6VAE8YFZ99TCZV2SXF7SQ9W"

    @Test
    fun theShortIdIsTheNotebooksFourCharactersAndTheNotesLastEight() {
        assertEquals("ETD7", NoteRef.notebookTag(notebook))
        assertEquals("ETD7-SXF7SQ9W", NoteRef.shortRef(notebook, id))
        assertEquals("ETD7-$id", NoteRef.shortRef(notebook, id, listOf("01AAAAAAAAAAAAAAAASXF7SQ9W", id)))
        assertEquals("welcome", NoteRef.shortRef(notebook, "welcome"))
    }

    @Test
    fun aListsCopyReadsTheNoteFromThePhoneAndRefusesOneInTrash() = kotlinx.coroutines.test.runTest {
        val db = app.penmoss.data.PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        try {
            val store = app.penmoss.data.NoteStore(db)
            db.notes().insert(app.penmoss.data.NoteEntity(id, title = "Q3 review"))
            db.notes().insert(app.penmoss.data.NoteEntity("gone", title = "Old", deleted = true))
            assertEquals(
                "Reference note via Penmoss MCP (penmoss mcp --notebook \"Work\") tool read_note {\"id\":\"ETD7-SXF7SQ9W\"}",
                agentReferenceOf(store, id, "Work", notebook),
            )
            // An older note the phone holds ends the same way: the whole id.
            db.notes().insert(app.penmoss.data.NoteEntity("01AAAAAAAAAAAAAAAASXF7SQ9W", title = "Older"))
            assertEquals(AgentReference.text(id, "Work", notebook, listOf("01AAAAAAAAAAAAAAAASXF7SQ9W")), agentReferenceOf(store, id, "Work", notebook))
            assertTrue(agentReferenceOf(store, id, "Work", notebook)!!.contains("ETD7-$id"))
            assertEquals("Reference note via Penmoss MCP tool read_note {\"id\":\"$id\"}", agentReferenceOf(store, id))
            assertEquals(null, agentReferenceOf(store, "gone"))
            assertEquals(null, agentReferenceOf(store, "missing"))
        } finally {
            db.close()
        }
    }

    @Test
    fun theReferenceGoesOnTheClipboardAsPlainText() {
        var clip: ClipData? = null
        val said = AgentReference.copy(ApplicationProvider.getApplicationContext(), "the text") { clip = it }
        assertEquals(AgentReference.COPIED, said)
        assertEquals("the text", clip!!.getItemAt(0).text.toString())
        val refused = AgentReference.copy(ApplicationProvider.getApplicationContext(), "the text") { throw SecurityException() }
        assertEquals("Copying wasn't allowed here", refused)
    }
}
