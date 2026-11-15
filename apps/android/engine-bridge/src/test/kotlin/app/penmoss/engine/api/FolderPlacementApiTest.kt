package app.penmoss.engine.api

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
import org.junit.Before
import org.junit.Test

/**
 * Where the notes server files notes and folders, on the wire (A757, A766 fix c): the folder a
 * move or a first upload was filed in, and where a restored folder came back. A git notebook has
 * no notebooks inside it (A912), so no request names one: no `notebook` or `fromNotebook`.
 */
class FolderPlacementApiTest {
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
    fun noFolderOrMoveRequestNamesANotebook() = runTest {
        respond("""{"id":"p","name":"Projects"}""", 201)
        api.createFolder("p", "Projects", null)
        val made = body()
        assertEquals("null", made["parentId"].toString())
        assertFalse("notebook" in made)

        respond("""{"id":"f","name":"Plans","parentId":"w"}""")
        api.patchFolder("f", FolderPatch(parentId = "w", changeParent = true))
        val patched = body()
        assertEquals("w", patched["parentId"]!!.jsonPrimitive.content)
        assertFalse("fromNotebook" in patched)
        assertFalse("notebook" in patched)

        respond("""{"id":"n","folderId":"w"}""")
        api.moveNote("n", "w", InFolder(null))
        val moved = body()
        assertEquals("null", moved["fromFolderId"].toString())
        assertFalse("fromNotebook" in moved)
    }

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
    fun aRestoreSendsNoFolderAndAFolderRestoreSaysWhereItCameBack() = runTest {
        respond("""{"folderId":"p","restored":true,"seq":6}""")
        assertEquals(RestoredNote("p", true, 6), api.restoreNote("n"))
        assertEquals("{}", server.takeRequest().body!!.utf8())

        respond("""{"id":"f","restored":true,"parentGone":true,"parentId":"w"}""")
        assertEquals("w", api.restoreFolder("f").parentId)
        respond("""{"id":"f","restored":true,"parentGone":true,"parentId":null}""")
        assertNull(api.restoreFolder("f").parentId)
    }

    /** A766 fix c: a note's first upload names the folder to file it in. */
    @Test
    fun aFirstUploadNamesItsFolder() = runTest {
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
    }
}
