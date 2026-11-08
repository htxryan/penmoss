package app.penmoss.ui

import android.content.ClipData
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.FolderEntity
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
 * Copy Agent Reference (T52 item 4) copies what the web and the Mac copy:
 * `contract/agent-reference-v1.json` holds core's `agentReference` for each case (written by the
 * web's `agent-reference-contract.test.ts`), and Android's text matches every one exactly.
 */
@RunWith(AndroidJUnit4::class)
class AgentReferenceContractTest {
    private val contract = Json.parseToJsonElement(File("../contract/agent-reference-v1.json").readText()).jsonObject

    @Test
    fun everyCaseReadsAsCoreWritesIt() {
        assertEquals(1, contract.getValue("version").jsonPrimitive.content.toInt())
        val cases = contract.getValue("cases").jsonArray
        assertTrue("the fixture has cases", cases.size >= 5)
        for (case in cases) {
            val name = case.jsonObject.getValue("name").jsonPrimitive.content
            val input = case.jsonObject.getValue("input").jsonObject
            val text = AgentReference.text(
                id = input.getValue("id").jsonPrimitive.content,
                title = input.getValue("title").jsonPrimitive.content,
                notebook = input.getValue("notebook").jsonPrimitive.content,
                folders = input.getValue("folders").jsonArray.map { it.jsonPrimitive.content },
                gitNotebook = input["gitNotebook"]?.jsonPrimitive?.content,
            )
            assertEquals(name, case.jsonObject.getValue("expected").jsonPrimitive.content, text)
        }
    }

    private val id = "01JBXYZ0000000000000000000"

    private fun folder(id: String, name: String, parent: String? = null, notebook: Boolean = false) =
        FolderEntity(id = id, name = name, parentId = parent, position = "a0", sortMode = "manual", notebook = notebook)

    @Test
    fun aNoteInTheDefaultNotebookIsPlacedUnderItsName() {
        val folders = listOf(folder("p", "Projects"), folder("pm", "Penmoss", "p"))
        assertEquals(
            AgentReference.text(id, "Plans", "Home", listOf("Projects", "Penmoss")),
            AgentReference.of(id, "Plans", "pm", folders, defaultNotebook = "Home"),
        )
        assertEquals(AgentReference.text(id, "Plans", "Home", emptyList()), AgentReference.of(id, "Plans", null, folders, "Home"))
    }

    @Test
    fun aNotebooksOwnFolderIsTheNotebookNotAFolder() {
        val folders = listOf(folder("w", "Work", notebook = true), folder("p", "Projects", "w"))
        assertEquals(AgentReference.text(id, "Q3", "Work", listOf("Projects")), AgentReference.of(id, "Q3", "p", folders, "Personal"))
        assertEquals(AgentReference.text(id, "Q3", "Work", emptyList()), AgentReference.of(id, "Q3", "w", folders, "Personal"))
    }

    @Test
    fun aGitNotebooksNoteIsReadThroughItsLocalServer() {
        val folders = listOf(folder("d", "Docs"))
        assertEquals(
            AgentReference.text(id, "Spec", "Work", listOf("Docs"), gitNotebook = "Work"),
            AgentReference.of(id, "Spec", "d", folders, "Personal", gitNotebook = "Work"),
        )
    }

    @Test
    fun aListsCopyReadsTheNoteFromThePhoneAndRefusesOneInTrash() = kotlinx.coroutines.test.runTest {
        val db = app.penmoss.data.PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        try {
            val store = app.penmoss.data.NoteStore(db)
            db.folders().insertAll(listOf(folder("w", "Work", notebook = true), folder("p", "Projects", "w")))
            db.notes().insert(app.penmoss.data.NoteEntity(id, title = "Q3 review", folderId = "p"))
            db.notes().insert(app.penmoss.data.NoteEntity("gone", title = "Old", deleted = true))
            assertEquals(AgentReference.text(id, "Q3 review", "Work", listOf("Projects")), agentReferenceOf(store, id))
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
