package app.penmoss.engine.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Who moved a note or folder to Trash, as `GET /api/trash` and `GET /api/folders/trash` send it
 * (T42, A574; T40 NT30, A655; review N4): read as the web's `parseDeletedBy`, so an odd value names
 * no one instead of failing the whole list.
 */
class DeletedByTest {
    private fun note(deletedBy: String) =
        PenmossJson.decodeFromString(TrashList.serializer(), """{"notes":[{"id":"n","deletedBy":$deletedBy}]}""").notes.single().deletedBy

    private fun folder(deletedBy: String) =
        PenmossJson.decodeFromString(FolderTrashList.serializer(), """{"folders":[{"id":"f","deletedBy":$deletedBy}]}""").folders.single().deletedBy

    @Test
    fun aDeviceOrAnAgentWithANameIsRead() {
        assertEquals(FolderDeleter("Pixel 9", "device"), note("""{"label":"Pixel 9","kind":"device"}"""))
        // Trimmed, as the web's.
        assertEquals(FolderDeleter("Claude Code", "agent"), folder("""{"label":"  Claude Code ","kind":"agent","extra":1}"""))
    }

    @Test
    fun anythingElseNamesNoOne() {
        val odd = listOf(
            "\"Pixel 9\"", "7", "true", "null", "[]", "{}",
            """{"label":42,"kind":"agent"}""", """{"label":"  ","kind":"device"}""",
            """{"label":"Pixel 9"}""", """{"label":"Pixel 9","kind":"robot"}""", """{"label":"Pixel 9","kind":1}""",
        )
        odd.forEach { value ->
            assertNull(value, note(value))
            assertNull(value, folder(value))
        }
    }

    @Test
    fun anOlderServersListWithoutItNamesNoOne() {
        assertNull(PenmossJson.decodeFromString(TrashList.serializer(), """{"notes":[{"id":"n"}]}""").notes.single().deletedBy)
    }
}
