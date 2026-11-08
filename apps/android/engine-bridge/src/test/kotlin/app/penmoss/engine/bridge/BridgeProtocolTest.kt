package app.penmoss.engine.bridge

import app.penmoss.engine.sync.StoredUpdate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * The bridge contract (T32, A282), from the app's side: every example in
 * apps/android/contract/bridge-v1.json that the page sends is read here, and
 * every message the app sends is written exactly as the example. The page's
 * vitest suite checks the same file.
 */
class BridgeProtocolTest {
    private val contract: JsonObject = Json.parseToJsonElement(
        File(System.getProperty("penmoss.contract") ?: "../contract/bridge-v1.json").readText(),
    ).jsonObject

    private fun examples(name: String): JsonArray = contract.getValue(name).jsonArray

    @Test
    fun readsEveryMessageThePageSends() {
        for (example in examples("fromEditor")) {
            val raw = example.toString()
            val message = BridgeProtocol.decodeFromEditor(raw)
            assertNotNull("not read: $raw", message)
            // And written back the same, so the shapes match field for field.
            assertEquals(example, Json.parseToJsonElement(BridgeProtocol.encode(message!!)))
        }
    }

    @Test
    fun writesEveryMessageThePageReads() {
        for (example in examples("toEditor")) {
            val message = BridgeProtocol.decodeToEditor(example.toString())
            assertNotNull("not read: $example", message)
            assertEquals(example, Json.parseToJsonElement(BridgeProtocol.encode(message!!)))
        }
    }

    @Test
    fun aStateFromAPageBeforeTheTitleFlagIsNotInTheTitle() {
        // T40 P9 (A554): `inTitle` is new; an older page's state still reads, with the bar shown.
        val raw = """{"v":1,"type":"state","noteId":"01JD2Z7Q8R4T6Y8W0E2R4T6YB1","active":[],"canUndo":false,"canRedo":false,"canIndent":false,"canOutdent":false,"href":null,"menu":false,"inTable":false,"inCode":false,"canMoveUp":false,"canMoveDown":false,"canTurnInto":false}"""
        val state = BridgeProtocol.decodeFromEditor(raw) as FromEditor.State
        assertEquals(false, state.inTitle)
        // T44 (A747): nor had it symbols; the bar's symbol button is off until a newer page says.
        assertEquals(emptyList<Int>(), state.symbols)
        assertEquals(false, state.canSymbol)
    }

    @Test
    fun refusesMalformedMessagesAndOtherVersions() {
        for (example in examples("invalidToEditor")) {
            val raw = (example as JsonPrimitive).content
            assertNull("accepted: $raw", BridgeProtocol.decodeToEditor(raw))
        }
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":2,"type":"ready"}"""))
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"update","noteId":"n1","update":"%%"}"""))
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"opened","noteId":"n1","title":"t"}"""))
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"openNote","noteId":"../etc"}"""))
        assertNull(BridgeProtocol.decodeFromEditor("not json"))
        // A new note is the one asked for (T38): the page never names another for the app to store.
        assertNull(
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"created","noteId":"n1","note":{"id":"n2","title":"","update":"AAA="}}""",
            ),
        )
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"tags","noteId":"n1","tags":[1]}"""))
        // And the contract's, which the page's suite holds it to never send (T38 review).
        for (example in examples("invalidFromEditor")) {
            val raw = (example as JsonPrimitive).content
            assertNull("accepted: $raw", BridgeProtocol.decodeFromEditor(raw))
        }
    }

    @Test
    fun readsTheTextsHeadingsAndKeepsOnlyCanonicalTags() {
        // T40 P6 review S5, S6: the index's headings and this phone's own tags come with its text.
        assertEquals(
            FromEditor.Text("n1", "body", "Intro", listOf("area/kitchen")),
            BridgeProtocol.decodeFromEditor("""{"v":1,"type":"text","noteId":"n1","text":"body","headings":"Intro","tags":["area/kitchen","Not Canonical","../x"]}"""),
        )
        // A page from before them: none.
        assertEquals(FromEditor.Text("n1", "body"), BridgeProtocol.decodeFromEditor("""{"v":1,"type":"text","noteId":"n1","text":"body"}"""))
        assertNull(BridgeProtocol.decodeToEditor("""{"v":1,"type":"ime","visible":"no"}"""))
    }

    @Test
    fun namesTheFormattingBarsCommandsAsThePageDoes() {
        val names = examples("formatCommands").map { (it as JsonPrimitive).content }
        assertEquals(names, FormatCommand.entries.map { it.wire })
    }

    @Test
    fun refusesWhatThePageMustNotSendAboutPicturesNotesAndTheBar() {
        val sha = "a".repeat(64)
        // Only an attachment path the app can store: no other folder, scheme or type.
        for (path in listOf("../attachments/$sha.png", "attachments/$sha.svg", "https://evil.test/x.png", "attachments/abc.png")) {
            assertNull(path, BridgeProtocol.decodeFromEditor("""{"v":1,"type":"attachment","noteId":"n1","path":"$path","size":3}"""))
        }
        assertNotNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"attachment","noteId":"n1","path":"attachments/$sha.png","size":3}"""))
        assertNull(
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"state","noteId":"n1","active":["blink"],"canUndo":true,"canRedo":false,"canIndent":false,"canOutdent":false,"href":null,"menu":false}""",
            ),
        )
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"newNote","noteId":"n1","note":{"id":"../x","title":"t","update":"AAA="}}"""))
        assertNull(
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"conflictCopy","noteId":"n1","note":{"id":"c1","title":"t","update":"AAA="},"replaces":["x"]}""",
            ),
        )
    }

    @Test
    fun refusesMalformedPeriodicMessages() {
        // `at` is never negative; a day is `2026-10-21` or null.
        assertNull(
            BridgeProtocol.decodeToEditor(
                """{"v":1,"type":"createPeriodic","kind":"daily","day":null,"at":-1,"timeZone":"America/Chicago","template":"x"}""",
            ),
        )
        assertNotNull(
            BridgeProtocol.decodeToEditor(
                """{"v":1,"type":"createPeriodic","kind":"weekly","day":null,"at":0,"timeZone":"America/Chicago","template":""}""",
            ),
        )
        // A period is a day or an ISO week; a neighbour's day is a day.
        assertNull(
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"createdPeriodic","note":{"id":"n1","title":"t","update":"AAA="},"kind":"daily","period":"October","date":"2026-10-21"}""",
            ),
        )
        assertNull(
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"createdPeriodic","note":{"id":"n1","title":"2026-10-21","update":"AAA="},"kind":"daily","period":"2026-10-21","date":"21/10/2026"}""",
            ),
        )
        // The note made is the period's: its title is the period (review N8).
        assertNull(
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"createdPeriodic","note":{"id":"n1","title":"2026-10-22","update":"AAA="},"kind":"daily","period":"2026-10-21","date":"2026-10-21"}""",
            ),
        )
        assertNotNull(
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"createdPeriodic","note":{"id":"n1","title":"2026-10-21","update":"AAA="},"kind":"daily","period":"2026-10-21","date":"2026-10-21"}""",
            ),
        )
        assertNull(
            BridgeProtocol.decodeFromEditor(
                """{"v":1,"type":"periodicNav","noteId":"n1","nav":{"kind":"daily","period":"2026-10-21","label":"L","prev":{"date":"x","label":"l","full":"f"},"next":{"date":"2026-10-22","label":"l","full":"f"},"week":null,"days":null}}""",
            ),
        )
        assertNotNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"periodicNav","noteId":"n1","nav":null}"""))
    }

    @Test
    fun opensWithStoredIdsAsStringsAndReadsCompactionBack() {
        val open = ToEditor.Open(
            "n1",
            synced = listOf(StoredUpdate(11, "AAA="), StoredUpdate(12, "AAA=")),
            pending = listOf(StoredUpdate(13, "AAA=")),
            editable = true,
        )
        val json = Json.parseToJsonElement(BridgeProtocol.encode(open)).jsonObject
        assertEquals(JsonPrimitive("11"), json.getValue("synced").jsonArray[0].jsonObject["id"])
        val opened = BridgeProtocol.decodeFromEditor(
            """{"v":1,"type":"opened","noteId":"n1","title":"","compacted":{"replaces":["11","12"],"update":"AAA="},"compactedPending":null}""",
        ) as FromEditor.Opened
        assertEquals(Compacted(listOf(11L, 12L), "AAA="), opened.compacted)
        assertNull(opened.compactedPending)
    }
}
