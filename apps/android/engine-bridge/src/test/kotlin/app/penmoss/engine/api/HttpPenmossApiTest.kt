package app.penmoss.engine.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
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

class HttpPenmossApiTest {
    private val server = MockWebServer()
    private lateinit var api: HttpPenmossApi

    @Before
    fun start() {
        server.start()
        api = HttpPenmossApi(server.url("/").toString(), OkHttpClient())
    }

    @After
    fun stop() = server.close()

    private fun respond(body: String, code: Int = 200) =
        server.enqueue(MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build())

    @Test
    fun readsTheErrorCodeOfARefusal() = runTest {
        respond("""{"error":{"code":"in_trash","message":"The note is in Trash"}}""", 409)
        val error = runCatching { api.moveNote("n1", null) }.exceptionOrNull() as ApiException
        assertEquals(409, error.status)
        assertEquals("in_trash", error.code)
        assertFalse(error.unauthorized)
    }

    @Test
    fun asksTheServerToRenameATagInTheNotesThePhoneHolds() = runTest {
        respond("""{"from":"cook","to":"area/cooking","notes":["n1","n2"]}""", 202)
        assertEquals(TagRenameReply("cook", "area/cooking", listOf("n1", "n2")), api.renameTag("cook", "area/cooking", listOf("n1", "n2")))
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/tags/rename", request.url.encodedPath)
        assertEquals("""{"from":"cook","to":"area/cooking","noteIds":["n1","n2"]}""", request.body!!.utf8())
        // A refusal carries the server's words, which the dialog shows.
        respond("""{"error":{"code":"invalid_request","message":"A tag cannot move inside itself"}}""", 400)
        val error = runCatching { api.renameTag("a", "a/b", emptyList()) }.exceptionOrNull() as ApiException
        assertEquals(400, error.status)
        assertEquals("A tag cannot move inside itself", error.message)
    }

    @Test
    fun readsTheWorkspacesTagsForSuggestions() = runTest {
        respond("""{"tags":[{"name":"area/cooking","notes":3},{"name":"inbox","notes":12}]}""")
        assertEquals(listOf(TagCount("area/cooking", 3), TagCount("inbox", 12)), api.tags())
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/tags", request.url.encodedPath)
        // No token: the notes server is on the phone (T59).
        assertNull(request.headers["Authorization"])
    }

    @Test
    fun searchesWithTheModeAndFiltersAndReadsTheMarkedTitle() = runTest {
        respond(
            """{"results":[{"id":"n1","title":"Lemon tart","titleHighlighted":"\u0002Lemon\u0003 tart",""" +
                """"snippet":"a \u0002lemon\u0003","updatedAt":5,"heading":"Method","tags":["baking"],"sources":["full-text","semantic"]}],"notice":null}""",
        )
        val reply = api.search("lemon ta", 30, SearchMode.HYBRID, SearchFilters(folderId = "f1", tag = "baking", updatedAfter = 1000), partial = true)
        val hit = reply.results.single()
        assertEquals("\u0002Lemon\u0003 tart", hit.titleHighlighted)
        assertEquals("Method", hit.heading)
        assertEquals(listOf("baking"), hit.tags)
        assertEquals(listOf("full-text", "semantic"), hit.sources)
        val url = server.takeRequest().url
        assertEquals("/api/search", url.encodedPath)
        assertEquals("lemon ta", url.queryParameter("q"))
        assertEquals("hybrid", url.queryParameter("mode"))
        assertEquals("1", url.queryParameter("prefix"))
        assertEquals("1", url.queryParameter("partial"))
        assertEquals("f1", url.queryParameter("folder"))
        assertEquals("baking", url.queryParameter("tag"))
        assertEquals("1000", url.queryParameter("after"))
        // No filters: none sent.
        respond("""{"results":[]}""")
        api.search("x")
        val plain = server.takeRequest().url
        assertEquals("full-text", plain.queryParameter("mode"))
        assertNull(plain.queryParameter("folder"))
        assertNull(plain.queryParameter("partial"))
    }

    @Test
    fun asksForTextInABatchOnlyWhenTheEntrySaysAndReadsIt() = runTest {
        respond("""{"notes":[{"id":"n1","epoch":"e","update":"","stateVector":"SV","error":null,"text":"body","textHash":"H"}]}""")
        val reply = api.batch(listOf(BatchEntry("n1", "SV", text = true, textHash = "OLD"), BatchEntry("n2")))
        assertEquals("body", reply.notes.single().text)
        assertEquals("H", reply.notes.single().textHash)
        val body = Json.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject
        val notes = body.getValue("notes") as kotlinx.serialization.json.JsonArray
        assertEquals("true", notes[0].jsonObject.getValue("text").jsonPrimitive.content)
        assertEquals("OLD", notes[0].jsonObject.getValue("textHash").jsonPrimitive.content)
        assertFalse("text" in notes[1].jsonObject)
        assertFalse("textHash" in notes[1].jsonObject)
    }

    @Test
    fun readsEachChangedNotesTagsAndToleratesAnOlderServer() = runTest {
        respond("""{"clock":3,"notes":[{"id":"a","clock":2,"tags":["area/garden","cooking"]},{"id":"b","clock":3}]}""")
        val page = api.changes(0)
        assertEquals(listOf("area/garden", "cooking"), page.notes[0].tags)
        assertNull(page.notes[1].tags)
    }

    @Test
    fun cancellingTheCallerCancelsTheRequestInFlightAtOnce() = runBlocking {
        // A server that would answer only half a minute later (a slow uplink, a stalled proxy).
        server.enqueue(MockResponse.Builder().headersDelay(30, TimeUnit.SECONDS).body("{}").build())
        val waiting = async(Dispatchers.Default) { api.changes(0) }
        assertEquals("/sync/changes", server.takeRequest(5, TimeUnit.SECONDS)!!.url.encodedPath)
        // A background run WorkManager stops does not wait for it (A329).
        withTimeout(2_000) { waiting.cancelAndJoin() }
        assertTrue(waiting.isCancelled)
    }

    @Test
    fun omitsAMissingCursorAndSendsEditsAsAList() = runTest {
        respond("""{"notes":[]}""")
        api.batch(listOf(BatchEntry("n1"), BatchEntry("n2", stateVector = "SV", update = listOf("U1"), epoch = "e")))
        val body = server.takeRequest().body!!.utf8()
        assertEquals("""{"notes":[{"id":"n1"},{"id":"n2","stateVector":"SV","update":["U1"],"epoch":"e"}]}""", body)
    }

    @Test
    fun filesANoteAtTheTopLevelBySendingANullFolder() = runTest {
        respond("""{"id":"n1","folderId":null}""")
        api.moveNote("n1", null)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/notes/n1/move", request.url.encodedPath)
        // The server needs the field itself: null is "the top level".
        assertEquals("""{"folderId":null}""", request.body!!.utf8())
        respond("""{"id":"n2","folderId":"f1"}""")
        api.moveNote("n2", "f1")
        assertEquals("""{"folderId":"f1"}""", server.takeRequest().body!!.utf8())
        // A move made on the phone says where the note was (A359), the top level as null.
        respond("""{"id":"n2","folderId":"f2"}""")
        api.moveNote("n2", "f2", InFolder("f1"))
        assertEquals("""{"folderId":"f2","fromFolderId":"f1"}""", server.takeRequest().body!!.utf8())
        respond("""{"id":"n2","folderId":"f2"}""")
        api.moveNote("n2", "f2", InFolder(null))
        assertEquals("""{"folderId":"f2","fromFolderId":null}""", server.takeRequest().body!!.utf8())
        // Refused: in Trash, or moved since; the filer reads the code.
        server.enqueue(MockResponse.Builder().code(409).body("""{"error":{"code":"note_moved","message":"Moved since"}}""").build())
        val refused = runCatching { api.moveNote("n2", "f2", InFolder("f1")) }.exceptionOrNull() as ApiException
        assertEquals(409, refused.status)
        assertEquals("note_moved", refused.code)
    }

    @Test
    fun movesANoteWithAReorderAnchorAndManagesFolders() = runTest {
        respond("""{"id":"n1","folderId":"f1"}""")
        api.moveNote("n1", "f1", place = NotePlace(after = "n0"))
        assertEquals("""{"folderId":"f1","place":{"after":"n0"}}""", server.takeRequest().body!!.utf8())

        respond("""{"id":"f1","name":"Projects","parentId":null,"sortMode":"manual"}""")
        val created = api.createFolder("f1", "Projects", null)
        assertEquals(FolderRef("f1", "Projects", null, "manual"), created)
        val creating = server.takeRequest()
        assertEquals("POST", creating.method)
        assertEquals("/api/folders", creating.url.encodedPath)
        assertEquals("""{"id":"f1","name":"Projects","parentId":null}""", creating.body!!.utf8())

        respond("""{"id":"f1","name":"Work","parentId":null,"sortMode":"manual"}""")
        api.patchFolder("f1", FolderPatch(name = "Work", fromName = "Projects", checkName = true))
        assertEquals("""{"name":"Work","from":{"name":"Projects"}}""", server.takeRequest().body!!.utf8())

        respond("""{"id":"f1","name":"Work","parentId":"f2","sortMode":"alpha"}""")
        api.patchFolder(
            "f1",
            FolderPatch(parentId = "f2", changeParent = true, fromParentId = null, checkParent = true, sortMode = "alpha", place = FolderPlace(before = "f0")),
        )
        assertEquals(
            """{"parentId":"f2","sortMode":"alpha","from":{"parentId":null},"place":{"before":"f0"}}""",
            server.takeRequest().body!!.utf8(),
        )

        respond("""{"sortMode":"alpha"}""")
        api.setRootSortMode("alpha")
        val root = server.takeRequest()
        assertEquals("PATCH", root.method)
        assertEquals("/api/folders/root", root.url.encodedPath)
        assertEquals("""{"sortMode":"alpha"}""", root.body!!.utf8())

        respond("""{"id":"f1","deleted":true}""")
        assertTrue(api.deleteFolder("f1"))
        val deleting = server.takeRequest()
        assertEquals("DELETE", deleting.method)
        assertEquals("/api/folders/f1", deleting.url.encodedPath)
    }

    @Test
    fun filesADailyNoteThroughTheDailyIntent() = runTest {
        respond("""{"id":"d1","created":true}""")
        assertEquals(DailyNoteRef("d1", created = true), api.dailyNote("2026-10-21", "daily"))
        val daily = server.takeRequest()
        assertEquals("POST", daily.method)
        assertEquals("/api/daily", daily.url.encodedPath)
        assertEquals("""{"date":"2026-10-21","period":"daily"}""", daily.body!!.utf8())
        respond("""{"id":"w1","created":false}""")
        assertEquals(DailyNoteRef("w1", created = false), api.dailyNote(null, "weekly"))
        assertEquals("""{"period":"weekly"}""", server.takeRequest().body!!.utf8())
    }

    @Test
    fun uploadsAndFetchesPicturesByTheirHash() = runTest {
        val sha = "a".repeat(64)
        server.enqueue(MockResponse.Builder().code(201).body("""{"sha256":"$sha","stored":true}""").build())
        api.putAttachment(sha, fileOf(1, 2, 3), "n1")
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/api/attachments/$sha", put.url.encodedPath)
        assertEquals("n1", put.url.queryParameter("note"))
        assertNull(put.headers["Authorization"])
        assertEquals(3, put.body!!.size)
        // A picture names no extension: the server takes it from the bytes.
        assertEquals(null, put.url.queryParameter("ext"))

        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "image/png").body(okio.Buffer().write(byteArrayOf(9, 8))).build())
        assertEquals(listOf<Byte>(9, 8), api.attachment(sha).toList())
        assertEquals("GET", server.takeRequest().method)

        respond("""{"error":{"code":"hash_mismatch","message":"The body does not match its SHA-256"}}""", 400)
        val error = runCatching { api.putAttachment(sha, fileOf(1), null) }.exceptionOrNull() as ApiException
        assertEquals("hash_mismatch", error.code)
    }

    private fun fileOf(vararg bytes: Byte): java.io.File =
        java.io.File.createTempFile("upload", ".bin").apply {
            deleteOnExit()
            writeBytes(bytes)
        }

    @Test
    fun streamsAnUploadFromItsFileWithItsLength() = runTest {
        // Review PS2: the body is read from the file as it goes, with the length the server checks.
        val sha = "c".repeat(64)
        val file = java.io.File.createTempFile("large", ".bin").apply {
            deleteOnExit()
            writeBytes(ByteArray(3 * 1024 * 1024) { it.toByte() })
        }
        server.enqueue(MockResponse.Builder().code(201).body("{}").build())
        api.putAttachment(sha, file, null)
        val put = server.takeRequest()
        assertEquals(file.length().toString(), put.headers["Content-Length"])
        assertEquals(file.readBytes().toList(), put.body!!.toByteArray().toList())
    }

    @Test
    fun anUploadCutShortAfterItsBytesWentOutIsInterruptedNotOffline() = runTest {
        // Review PS2: a timeout once the body was going out is an attempt; no connection is offline.
        val slow = HttpPenmossApi(server.url("/").toString(), OkHttpClient.Builder().callTimeout(300, TimeUnit.MILLISECONDS).build())
        server.enqueue(MockResponse.Builder().code(201).headersDelay(5, TimeUnit.SECONDS).body("{}").build())
        val cut = runCatching { slow.putAttachment("c".repeat(64), fileOf(1, 2, 3), null) }.exceptionOrNull()
        assertTrue(cut.toString(), cut is UploadInterrupted)
        val closed = MockWebServer().apply { start() }
        val unreachable = closed.url("/").toString()
        closed.close()
        val offline = runCatching {
            HttpPenmossApi(unreachable, OkHttpClient()).putAttachment("c".repeat(64), fileOf(1), null)
        }.exceptionOrNull()
        assertTrue(offline.toString(), offline is java.io.IOException && offline !is UploadInterrupted)
    }

    @Test
    fun asksTheSizeOfAStoredFileWithoutItsBytes() = runTest {
        // Review PS3: HEAD, as the web's chips ask.
        val sha = "d".repeat(64)
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Length", "2048").addHeader("Content-Type", "application/pdf").build())
        assertEquals(2048L, api.attachmentSize(sha))
        val head = server.takeRequest()
        assertEquals("HEAD", head.method)
        assertEquals("/api/attachments/$sha", head.url.encodedPath)
        assertNull(head.headers["Authorization"])
        server.enqueue(MockResponse.Builder().code(404).build())
        assertNull(api.attachmentSize(sha))
    }

    @Test
    fun uploadsAFileWithTheExtensionItsPathUses() = runTest {
        val sha = "b".repeat(64)
        server.enqueue(MockResponse.Builder().code(201).body("""{"sha256":"$sha","stored":true}""").build())
        api.putAttachment(sha, fileOf(1, 2), "n1", ext = "csv")
        val put = server.takeRequest()
        assertEquals("/api/attachments/$sha", put.url.encodedPath)
        assertEquals("csv", put.url.queryParameter("ext"))
        assertEquals("n1", put.url.queryParameter("note"))
    }

    @Test
    fun sendsACaptureAndReadsTheNoteItLandedIn() = runTest {
        respond("""{"id":"c1","noteId":"daily-2026-10-20","destination":"daily","changed":true}""")
        val reply = api.capture(CaptureRequest("c1", "Penmoss\n<https://penmoss.app>", CaptureRequest.DAILY, 1_760_000_000_000, remember = true))
        assertEquals(CaptureReply("c1", "daily-2026-10-20", "daily", changed = true), reply)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/capture", request.url.encodedPath)
        // No token: the notes server is on the phone (T59).
        assertNull(request.headers["Authorization"])
        val body = Json.parseToJsonElement(request.body!!.utf8()).jsonObject
        assertEquals("c1", body.getValue("id").jsonPrimitive.content)
        assertEquals("Penmoss\n<https://penmoss.app>", body.getValue("text").jsonPrimitive.content)
        assertEquals("daily", body.getValue("destination").jsonPrimitive.content)
        assertEquals("1760000000000", body.getValue("capturedAt").jsonPrimitive.content)
        assertEquals("true", body.getValue("remember").jsonPrimitive.content)
        // Not remembering is the server's default, so it is left out.
        respond("""{"id":"c2","noteId":"n","destination":"inbox"}""")
        api.capture(CaptureRequest("c2", "x", CaptureRequest.INBOX, 1))
        assertFalse("remember" in Json.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject)
        // The time zone the capture was made in goes with it (A344).
        respond("""{"id":"c3","noteId":"n","destination":"daily"}""")
        api.capture(CaptureRequest("c3", "x", CaptureRequest.DAILY, 1, timeZone = "America/Chicago"))
        assertEquals("America/Chicago", Json.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject.getValue("timeZone").jsonPrimitive.content)
    }

    @Test
    fun readsWhereCapturesGoFromTheTree() = runTest {
        respond("""{"hash":"h","capture":{"destination":"inbox"}}""")
        assertEquals(CaptureSetting("inbox"), api.tree(null).capture)
        respond("""{"hash":"h1","capture":{"destination":"daily","timeZone":"Asia/Tokyo"}}""")
        assertEquals(CaptureSetting("daily", "Asia/Tokyo"), api.tree(null).capture)
        respond("""{"hash":"h2"}""")
        assertNull(api.tree(null).capture)
    }

    @Test
    fun ignoresFieldsItDoesNotKnow() = runTest {
        respond("""{"clock":4,"hasMore":false,"notes":[{"id":"n","seq":3,"clock":4,"title":"T","excerpt":"E","updatedAt":9,"deleted":false,"future":1}]}""")
        val page = api.changes(0)
        assertEquals(ChangedNote("n", 4, "T", "E", 9, deleted = false, seq = 3), page.notes.single())
    }

    @Test
    fun aMoveToTrashSendsTheSeqItHadSeenAndReadsTheServersAnswer() = runTest {
        respond("""{"folderId":"f","deletedAt":5,"seq":7}""")
        assertEquals(TrashedNote("f", 5, 7), api.trashNote("n", 3))
        val sent = server.takeRequest()
        assertEquals("/api/notes/n/trash", sent.url.encodedPath)
        assertEquals("""{"knownSeq":3}""", sent.body!!.utf8())
        respond("""{"folderId":null,"restored":false,"seq":8}""")
        assertEquals(RestoredNote(null, restored = false, seq = 8), api.restoreNote("n"))
    }

    @Test
    fun aNoteTheServerDoesNotHaveIsToldApartFromAnyOther404() = runTest {
        respond("""{"error":{"code":"not_found","message":"No such note"}}""", 404)
        val note = runCatching { api.trashNote("n", 0) }.exceptionOrNull() as ApiException
        assertTrue(note.noSuchNote)
        assertEquals(404, note.status)
        // The Trash routes' own code.
        respond("""{"error":{"code":"note_not_found","message":"No such note"}}""", 404)
        assertTrue((runCatching { api.restoreNote("n") }.exceptionOrNull() as ApiException).noSuchNote)
    }

    /** Only a server that says the note is gone is believed: any other 404 says nothing of it. */
    @Test
    fun aNotFoundPageThatIsNotJsonSaysNothingOfTheNote() = runTest {
        respond("<html><body>404 Not Found</body></html>", 404)
        val page = runCatching { api.trashNote("n", 0) }.exceptionOrNull() as ApiException
        assertEquals(404, page.status)
        assertEquals("HTTP 404", page.message)
        assertFalse(page.noSuchNote)
        // The server's own answer for a route it does not have (an older server), and another
        // route's 404 with a different message.
        respond("404 Not Found", 404)
        assertFalse((runCatching { api.trashNote("n", 0) }.exceptionOrNull() as ApiException).noSuchNote)
        respond("""{"error":{"code":"not_found","message":"No such folder"}}""", 404)
        assertFalse((runCatching { api.restoreNote("n") }.exceptionOrNull() as ApiException).noSuchNote)
    }

    /** Version history (T40 P3b, NT16–NT20): the list, one version's diff, restore, revert and save. */
    @Test
    fun readsTheHistoryListWithItsAuthors() = runTest {
        respond("""{"versions":[{"id":3,"createdAt":1700000000000,"reason":"edit","summary":"Appended","actors":["a1"],"authors":[{"id":"a1","kind":"agent","label":"Claude"}]},{"id":2,"createdAt":1699999999000,"reason":"manual","summary":"Saved by hand","actors":["d1"],"authors":[{"id":"d1","kind":"device","label":"Pixel"}]}],"unversioned":{"authors":[{"id":"d1","kind":"device","label":"Pixel"}],"since":1700000001000}}""")
        val history = api.history("n")
        assertEquals(listOf(3L, 2L), history.versions.map { it.id })
        assertEquals("agent", history.versions[0].authors.single().kind)
        assertEquals("Claude", history.versions[0].authors.single().label)
        assertEquals("device", history.versions[1].authors.single().kind)
        assertEquals(1700000001000L, history.unversioned?.since)
        val sent = server.takeRequest()
        assertEquals("/api/notes/n/versions", sent.url.encodedPath)
    }

    @Test
    fun readsOneVersionsDiffAndWritesBack() = runTest {
        respond("""{"id":3,"previousId":2,"markdown":"# T\nnew\n","diff":[{"op":"same","line":"# T"},{"op":"add","line":"new"}]}""")
        val detail = api.versionDetail("n", 3)
        assertEquals(3L, detail.id)
        assertEquals(2L, detail.previousId)
        assertEquals("# T\nnew\n", detail.markdown)
        assertEquals(listOf("same", "add"), detail.diff.map { it.op })
        assertEquals("/api/notes/n/versions/3", server.takeRequest().url.encodedPath)

        respond("""{"version":{"id":4},"changed":true}""")
        assertTrue(api.restoreVersion("n", 3).changed)
        assertEquals("/api/notes/n/versions/3/restore", server.takeRequest().url.encodedPath)

        respond("""{"version":null,"changed":false,"conflicts":[{"part":"body","ours":["kept"],"theirs":["gone"]}]}""")
        val reverted = api.revertVersion("n", 3)
        assertEquals(listOf("body"), reverted.conflicts.map { it.part })
        assertEquals(listOf("kept"), reverted.conflicts.single().ours)
        assertEquals("/api/notes/n/versions/3/revert", server.takeRequest().url.encodedPath)

        respond("{}", 201)
        api.saveVersion("n")
        assertEquals("/api/notes/n/versions", server.takeRequest().url.encodedPath)
    }
}
