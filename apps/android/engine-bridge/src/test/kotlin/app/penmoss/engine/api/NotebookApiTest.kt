package app.penmoss.engine.api

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * Notebooks on the wire (T43, A750–A760): the tree's flags and the default notebook's name, the
 * folder routes' `notebook` and search's `notebooks=`.
 */
class NotebookApiTest {
    private val server = MockWebServer()
    private lateinit var api: HttpPenmossApi

    @Before
    fun start() {
        server.start()
        api = HttpPenmossApi(server.url("/").toString(), OkHttpClient())
    }

    @After
    fun stop() = server.close()

    private fun respond(body: String = "{}", code: Int = 200) =
        server.enqueue(MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build())

    private fun body(): JsonObject = Json.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject

    @Test
    fun theTreeCarriesEachNotebooksFlagAndTheDefaultNotebooksName() = runTest {
        respond("""{"hash":"h1","defaultNotebook":"Home","folders":[{"id":"w","name":"Work","notebook":true},{"id":"p","name":"Projects"}]}""")
        val tree = api.tree(null)
        assertEquals("Home", tree.defaultNotebook)
        assertEquals(listOf(true, false), tree.folders.map { it.notebook })
        // An older server sends neither.
        respond("""{"hash":"h2","folders":[{"id":"p","name":"Projects"}]}""")
        val old = api.tree("h1")
        assertNull(old.defaultNotebook)
        assertFalse(old.folders.single().notebook)
    }

    @Test
    fun aNotebookIsMadeTurnedBackAndTheDefaultRenamedThroughTheFolderRoutes() = runTest {
        respond("""{"id":"w","name":"Work"}""", 201)
        api.createFolder("w", "Work", null, notebook = true)
        val made = body()
        assertTrue(made["notebook"]!!.jsonPrimitive.boolean)
        assertEquals("null", made["parentId"].toString())
        // A plain folder sends no flag, as before.
        respond("""{"id":"p","name":"Projects"}""", 201)
        api.createFolder("p", "Projects", null)
        assertFalse("notebook" in body())

        respond("""{"id":"w","name":"Work"}""")
        api.patchFolder("w", FolderPatch(notebook = false))
        val patched = server.takeRequest()
        assertEquals("/api/folders/w", patched.url.encodedPath)
        assertEquals("""{"notebook":false}""", patched.body!!.utf8())

        respond("""{"sortMode":"manual","notebookName":"Home"}""")
        assertEquals("Home", api.setDefaultNotebookName("Home"))
        val root = server.takeRequest()
        assertEquals("PATCH", root.method)
        assertEquals("/api/folders/root", root.url.encodedPath)
        assertEquals("""{"notebookName":"Home"}""", root.body!!.utf8())
    }

    @Test
    fun searchSendsTheOpenNotebooksAndReadsEachResultsNotebook() = runTest {
        respond("""{"results":[{"id":"n1","title":"Plan","notebook":{"id":"default","name":"Personal"}},{"id":"n2","title":"Old"}]}""")
        val reply = api.search("plan", filters = SearchFilters(notebooks = listOf("default", "w")))
        assertEquals("default,w", server.takeRequest().url.queryParameter("notebooks"))
        assertEquals(SearchNotebook("default", "Personal"), reply.results[0].notebook)
        assertNull(reply.results[1].notebook)
        // With every notebook open, nothing is sent.
        respond("""{"results":[]}""")
        api.search("plan")
        assertNull(server.takeRequest().url.queryParameter("notebooks"))
    }

    @Test
    fun trashMarksNotesThatWentWithANotebookAndTheNotebookItself() {
        val notes = PenmossJson.decodeFromString(TrashList.serializer(), """{"notes":[{"id":"n1","withNotebook":true},{"id":"n2"}]}""").notes
        assertEquals(listOf(true, false), notes.map { it.withNotebook })
        val folders = PenmossJson.decodeFromString(FolderTrashList.serializer(), """{"folders":[{"id":"w","name":"Work","notebook":true,"notes":4}]}""").folders
        assertTrue(folders.single().notebook)
        assertTrue(PenmossJson.decodeFromString(RestoredFolder.serializer(), """{"id":"w","restored":true,"notebook":true,"notes":4}""").notebook)
    }

    // --- fail closed (T43, A757) ---

    @Test
    fun aMoveAnswersTheFolderTheServerFiledTheNoteIn() = runTest {
        respond("""{"id":"n","folderId":"plans"}""")
        assertEquals(FiledNote("plans"), api.moveNote("n", "gone"))
        respond("""{"id":"n","folderId":null}""")
        assertEquals(FiledNote(null), api.moveNote("n", null))
        // An older server does not say: filed where asked.
        respond("""{"id":"n"}""")
        assertEquals(FiledNote("gone"), api.moveNote("n", "gone"))
    }

    @Test
    fun aRestoreNamesTheChosenFolderAndARefusalNamesItsNotebook() = runTest {
        respond("""{"folderId":"p","restored":true,"seq":4}""")
        assertEquals(RestoredNote("p", true, 4), api.restoreNote("n", InFolder("p")))
        assertEquals("""{"folderId":"p"}""", server.takeRequest().body!!.utf8())
        respond("""{"folderId":null,"restored":true,"seq":5}""")
        api.restoreNote("n", InFolder(null))
        assertEquals("""{"folderId":null}""", server.takeRequest().body!!.utf8())
        // No choice: no folder sent, as before.
        respond("""{"folderId":"p","restored":true,"seq":6}""")
        api.restoreNote("n")
        assertEquals("{}", server.takeRequest().body!!.utf8())

        respond("""{"error":{"code":"restore_needs_folder","message":"The note was in the notebook “Work”, which is in Trash"},"notebook":{"id":"w","name":"Work"}}""", 409)
        val refused = runCatching { api.restoreNote("n") }.exceptionOrNull() as ApiException
        assertEquals("restore_needs_folder", refused.code)
        assertEquals(NotebookRef("w", "Work"), refused.notebook)
        respond("""{"error":{"code":"restore_needs_folder","message":"The folder the note was deleted from is gone"},"notebook":null}""", 409)
        assertNull((runCatching { api.restoreNote("n") }.exceptionOrNull() as ApiException).notebook)
        // A folder's restore refused the same way.
        respond("""{"error":{"code":"restore_needs_folder","message":"x"},"notebook":{"id":"w","name":"Work"}}""", 409)
        assertEquals(NotebookRef("w", "Work"), (runCatching { api.restoreFolder("f") }.exceptionOrNull() as ApiException).notebook)
    }

    @Test
    fun aCreateMadeInTrashSaysSoAndTheMirrorSaysPausedAndMissingBranch() = runTest {
        respond("""{"id":"f","name":"Drafts","parentId":"gone","inTrash":true}""", 201)
        assertTrue(api.createFolder("f", "Drafts", "gone").inTrash)
        respond("""{"id":"g","name":"Plans","parentId":"w"}""", 201)
        assertFalse(api.createFolder("g", "Plans", "gone").inTrash)
        // The notebook it went to Trash with (A757): its id may be left out for a scoped token.
        respond("""{"id":"h","name":"Drafts","parentId":"gone","inTrash":true,"notebook":{"name":"Work"}}""", 201)
        assertEquals(FolderNotebook(null, "Work"), api.createFolder("h", "Drafts", "gone").notebook)

        // A folder's restore says where it came back; an older server does not.
        respond("""{"id":"f","restored":true,"parentGone":true,"parentId":"w"}""")
        val back = api.restoreFolder("f")
        assertTrue(back.parentKnown)
        assertEquals("w", back.parentId)
        respond("""{"id":"f","restored":true,"parentGone":true,"parentId":null}""")
        val top = api.restoreFolder("f")
        assertTrue(top.parentKnown)
        assertNull(top.parentId)
        respond("""{"id":"f","restored":true,"parentGone":true}""")
        assertFalse(api.restoreFolder("f").parentKnown)

    }

    /** T43 round 3 (A766, fix c): the first upload's folder and a move's notebook. */
    @Test
    fun aFirstUploadNamesItsFolderAndMovesNameTheNotebookTheySaw() = runTest {
        respond("""{"notes":[{"id":"m","epoch":"e1","update":"","stateVector":"SV1","applied":1,"filed":{"folderId":null}}]}""")
        val reply = api.batch(
            listOf(
                BatchEntry("m", update = listOf("AAA="), folderId = kotlinx.serialization.json.JsonNull),
                BatchEntry("n", update = listOf("AAA="), folderId = kotlinx.serialization.json.JsonPrimitive("plans")),
                BatchEntry("o", update = listOf("AAA=")),
            ),
        )
        assertEquals(BatchFiled(null), reply.notes.single().filed)
        val notes = body()["notes"]!!.jsonArray.map { it.jsonObject }
        assertEquals("null", notes[0]["folderId"].toString())
        assertEquals("plans", notes[1]["folderId"]!!.jsonPrimitive.content)
        assertFalse("folderId" in notes[2])

        respond("""{"id":"n","folderId":"w"}""")
        api.moveNote("n", "w", InFolder(null), fromNotebook = "default")
        assertEquals("default", body()["fromNotebook"]!!.jsonPrimitive.content)
        respond("""{"id":"n","folderId":null}""")
        api.moveNote("n", null)
        assertFalse("fromNotebook" in body())

        respond("""{"id":"f","name":"Plans","parentId":"w"}""")
        api.patchFolder("f", FolderPatch(parentId = "w", changeParent = true, fromNotebook = "default"))
        assertEquals("default", body()["fromNotebook"]!!.jsonPrimitive.content)
        // Only with a move.
        respond("""{"id":"f","name":"Plans 2","parentId":"w"}""")
        api.patchFolder("f", FolderPatch(name = "Plans 2", fromNotebook = "default"))
        assertFalse("fromNotebook" in body())
    }
}
