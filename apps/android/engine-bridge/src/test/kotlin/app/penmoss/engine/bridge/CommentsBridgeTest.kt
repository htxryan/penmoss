package app.penmoss.engine.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The comment messages (T48): beside the contract's examples (BridgeProtocolTest), what the app
 * sends is what the page reads, and what the page could send wrong is refused.
 */
class CommentsBridgeTest {
    private val note = "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"
    private val target = CommentTarget("01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "0123456789abcdef01234567", "Codex · garden")

    private fun encoded(message: ToEditor) = Json.parseToJsonElement(BridgeProtocol.encode(message)).jsonObject

    @Test
    fun writesWhatTheSheetAsksFor() {
        assertEquals(
            Json.parseToJsonElement("""{"v":1,"type":"commentCreate","noteId":"$note","body":"Hi","target":null}"""),
            encoded(CommentToEditor.Create(note, "Hi", null)),
        )
        assertEquals(
            Json.parseToJsonElement("""{"v":1,"type":"commentTarget","noteId":"$note","threadId":"T1","target":{"writer":"01JD2Z7Q8R4T6Y8W0E2R4T6YW1","session":"0123456789abcdef01234567","label":"Codex · garden"}}"""),
            encoded(CommentToEditor.Target(note, "T1", target)),
        )
        assertEquals(
            Json.parseToJsonElement("""{"v":1,"type":"commentActive","noteId":"$note","threadId":null,"reveal":false}"""),
            encoded(CommentToEditor.Active(note, null, reveal = false)),
        )
    }

    @Test
    fun readsTheThreadsAsThePageListsThem() {
        val message = BridgeProtocol.decodeFromEditor(
            """{"v":1,"type":"comments","noteId":"$note","open":1,"active":"T1","threads":[{"id":"T1","status":"open","quote":"fence","orphaned":false,"kind":"range","created":1,"author":{"kind":"device","label":"Pixel 9"},"comments":[{"id":"C1","author":{"kind":"agent","label":"Codex"},"body":"Yes","at":2}],"target":{"writer":"01JD2Z7Q8R4T6Y8W0E2R4T6YW1","session":"0123456789abcdef01234567","label":"Codex · garden"},"delivery":{"state":"seen","at":3}}]}""",
        )
        assertEquals(
            CommentFromEditor.Threads(
                note,
                open = 1,
                active = "T1",
                threads = listOf(
                    CommentThread(
                        "T1", ThreadStatus.OPEN, "fence", orphaned = false, range = true, created = 1,
                        author = CommentAuthor(agent = false, label = "Pixel 9"),
                        comments = listOf(CommentEntry("C1", CommentAuthor(agent = true, label = "Codex"), "Yes", 2)),
                        target = target,
                        delivery = CommentDelivery(DeliveryState.SEEN, 3),
                    ),
                ),
            ),
            message,
        )
    }

    @Test
    fun readsARemovedFirstCommentAndSaysWhoThePhoneWritesAs() {
        // A784: the first comment removed, its reply kept; `removed` is there only when true.
        val message = BridgeProtocol.decodeFromEditor(
            """{"v":1,"type":"comments","noteId":"$note","open":1,"active":null,"threads":[{"id":"T1","status":"open","quote":"","orphaned":false,"kind":"point","created":1,"author":{"kind":"device","label":"Pixel 9"},"comments":[{"id":"C1","author":{"kind":"device","label":"Pixel 9"},"body":"","at":1,"removed":true},{"id":"C2","author":{"kind":"agent","label":"Codex"},"body":"Yes","at":2}]}]}""",
        ) as CommentFromEditor.Threads
        val (first, reply) = message.threads.single().comments
        assertEquals(CommentEntry("C1", CommentAuthor(agent = false, label = "Pixel 9"), "", 1, removed = true), first)
        assertEquals(false, reply.removed)
        val written = Json.parseToJsonElement(BridgeProtocol.encode(message)).jsonObject.toString()
        assertEquals(1, Regex("\"removed\"").findAll(written).count())
        // Review S5: the device's actor, about no note.
        assertEquals(
            Json.parseToJsonElement("""{"v":1,"type":"commentAuthor","id":"device:D1","label":"Android app (Pixel 9)"}"""),
            encoded(CommentAuthorToEditor.of("D1", "Android app (Pixel 9)")!!),
        )
        assertNull(CommentAuthorToEditor.of(null, "Android app (Pixel 9)"))
        assertNull(CommentAuthorToEditor.of("D1", null))
        assertNull(CommentAuthorToEditor.of("D1", "  "))
        assertNull(CommentAuthorToEditor.of("../x", "Pixel"))
        assertNull(BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentAuthor","id":"agent:T1","label":"Codex"}"""))
    }

    @Test
    fun aThreadAndADraftOnTheNoteAsAWholeRoundTrip() {
        // T52 item 5: Add Note Comment asks for a draft on the note; its threads are kind "note".
        assertEquals(
            Json.parseToJsonElement("""{"v":1,"type":"commentDraft","noteId":"$note","from":"note"}"""),
            encoded(CommentToEditor.Draft(note, DraftSource.NOTE)),
        )
        assertEquals(CommentToEditor.Draft(note, DraftSource.NOTE), BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentDraft","noteId":"$note","from":"note"}"""))
        val draft = BridgeProtocol.decodeFromEditor("""{"v":1,"type":"commentDraft","noteId":"$note","quote":"","kind":"note"}""")
        assertEquals(CommentFromEditor.Draft(note, "", range = false, note = true), draft)
        val raw = """{"v":1,"type":"comments","noteId":"$note","open":1,"active":null,"threads":[{"id":"T1","status":"open","quote":"","orphaned":false,"kind":"note","created":1,"author":{"kind":"device","label":"Pixel 9"},"comments":[]}]}"""
        val threads = BridgeProtocol.decodeFromEditor(raw) as CommentFromEditor.Threads
        val thread = threads.threads.single()
        assertEquals(true, thread.note)
        assertEquals(false, thread.range)
        assertEquals(Json.parseToJsonElement(raw), Json.parseToJsonElement(BridgeProtocol.encode(threads)))
        // A passage's thread is not on the note.
        val passage = BridgeProtocol.decodeFromEditor(raw.replace("\"kind\":\"note\"", "\"kind\":\"range\"")) as CommentFromEditor.Threads
        assertEquals(false, passage.threads.single().note)
    }

    @Test
    fun readsAFailedDeliveryAndWhy() {
        fun delivery(json: String) = (
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"comments","noteId":"$note","open":1,"active":null,"threads":[{"id":"T1","status":"open","quote":"","orphaned":false,"kind":"point","created":1,"author":{"kind":"device","label":"Pixel 9"},"comments":[],"target":{"writer":"01JD2Z7Q8R4T6Y8W0E2R4T6YW1","session":"0123456789abcdef01234567","label":"Codex · garden"},"delivery":$json}]}""",
            ) as CommentFromEditor.Threads?
            )?.threads?.single()?.delivery
        // The session is gone (T60, A1062); the server's reasons are still read.
        assertEquals(CommentDelivery(DeliveryState.FAILED, 3, DeliveryFailure.GONE), delivery("""{"state":"failed","at":3,"reason":"gone"}"""))
        assertEquals(CommentDelivery(DeliveryState.FAILED, 3, DeliveryFailure.SCOPE), delivery("""{"state":"failed","at":3,"reason":"scope"}"""))
        assertEquals(CommentDelivery(DeliveryState.FAILED, 3, DeliveryFailure.REVOKED), delivery("""{"state":"failed","at":3,"reason":"revoked"}"""))
        assertEquals(CommentDelivery(DeliveryState.FAILED, 3), delivery("""{"state":"failed","at":3}"""))
        // An unknown reason, or one beside a delivery that did not fail, is refused.
        assertNull(delivery("""{"state":"failed","at":3,"reason":"lost"}"""))
        assertNull(delivery("""{"state":"seen","at":3,"reason":"scope"}"""))
    }

    @Test
    fun aTargetNamesTheAgentsWriterAndATokenOneIsRefused() {
        // T60, A1060: a target from the server's time names a token: never read as a target.
        val target = """{"writer":"01JD2Z7Q8R4T6Y8W0E2R4T6YW1","session":"0123456789abcdef01234567","label":"Claude Code · garden"}"""
        assertEquals(
            CommentToEditor.Target(note, "T1", CommentTarget("01JD2Z7Q8R4T6Y8W0E2R4T6YW1", "0123456789abcdef01234567", "Claude Code · garden")),
            BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentTarget","noteId":"$note","threadId":"T1","target":$target}"""),
        )
        for (bad in listOf(
            """{"token":"01JD2Z7Q8R4T6Y8W0E2R4T6YT1","session":"0123456789abcdef01234567","label":"Codex"}""",
            """{"writer":"../x","session":"0123456789abcdef01234567","label":"Codex"}""",
            """{"writer":"01JD2Z7Q8R4T6Y8W0E2R4T6YW1","session":"0123","label":"Codex"}""",
        )) {
            assertNull(bad, BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentTarget","noteId":"$note","threadId":"T1","target":$bad}"""))
        }
    }

    @Test
    fun sendsTheSessionsAndReadsThatAThreadWasSent() {
        // T60, A1077: the notebook's sessions for the page's gone check.
        val sessions = CommentToEditor.Sessions(note, listOf(SessionSeen("0123456789abcdef01234567", 5), SessionSeen("89abcdef0123456789abcdef", 0)))
        assertEquals(
            Json.parseToJsonElement("""{"v":1,"type":"commentSessions","noteId":"$note","sessions":[{"key":"0123456789abcdef01234567","lastSeen":5},{"key":"89abcdef0123456789abcdef","lastSeen":0}]}"""),
            encoded(sessions),
        )
        assertEquals(sessions, BridgeProtocol.decodeToEditor(BridgeProtocol.encode(sessions)))
        assertNull(BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentSessions","noteId":"$note","sessions":[{"key":"nope","lastSeen":5}]}"""))
        assertNull(BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentSessions","noteId":"$note","sessions":[{"key":"0123456789abcdef01234567","lastSeen":-1}]}"""))
        assertNull(BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentSessions","noteId":"$note"}"""))
        // A1078: the page sent a thread, its update first.
        assertEquals(
            CommentFromEditor.Sent(note, "T1"),
            BridgeProtocol.decodeFromEditor("""{"v":1,"type":"commentSent","noteId":"$note","threadId":"T1"}"""),
        )
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"commentSent","noteId":"$note","threadId":"../x"}"""))
    }

    @Test
    fun refusesWhatThePageMustNotSend() {
        val bad = listOf(
            // A thread id that is no id, an unknown status or kind, a negative count.
            """{"v":1,"type":"comments","noteId":"$note","open":0,"active":null,"threads":[{"id":"a/b","status":"open","quote":"","orphaned":false,"kind":"point","created":0,"author":{"kind":"device","label":"You"},"comments":[]}]}""",
            """{"v":1,"type":"comments","noteId":"$note","open":0,"active":null,"threads":[{"id":"T1","status":"done","quote":"","orphaned":false,"kind":"point","created":0,"author":{"kind":"device","label":"You"},"comments":[]}]}""",
            """{"v":1,"type":"comments","noteId":"$note","open":-1,"active":null,"threads":[]}""",
            """{"v":1,"type":"comments","noteId":"$note","open":0,"active":"../x","threads":[]}""",
            """{"v":1,"type":"commentDraft","noteId":"$note","quote":"x"}""",
            """{"v":1,"type":"commentOpen","noteId":"$note","threadId":7}""",
        )
        for (raw in bad) assertNull(raw, BridgeProtocol.decodeFromEditor(raw))
        // Nor a comment too long, or only spaces, to the page.
        assertNull(BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentReply","noteId":"$note","threadId":"T1","body":"${"x".repeat(CommentLimits.MAX_CHARS + 1)}"}"""))
        assertNull(BridgeProtocol.decodeToEditor("""{"v":1,"type":"commentReply","noteId":"$note","threadId":"T1","body":"  "}"""))
    }
}
