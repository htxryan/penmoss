package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The phone ranks as the web's offline index does, which ranks as the server does (T40 P6, A101,
 * A462, review S6): `contract/search-ranking-v1.json` holds notes, queries and the ids and bm25
 * scores core's `LocalSearchIndex` gives them (written by the page's `search-contract.test.ts`).
 * The same notes in Room, through the store as sync puts them there, give the same order and
 * the same scores.
 */
@RunWith(AndroidJUnit4::class)
class SearchRankingContractTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    private val contract = Json.parseToJsonElement(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("search-ranking-v1.json") } ?: File("../contract/search-ranking-v1.json")).readText(),
    ).jsonObject

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 5_000 })
    }

    @After
    fun close() = db.close()

    private fun JsonObject.string(name: String) = getValue(name).jsonPrimitive.content

    @Test
    fun ranksEveryQueryAsCoresIndexDoes() = runTest {
        var clock = 0L
        for (element in contract.getValue("notes").jsonArray) {
            val note = element.jsonObject
            val id = note.string("id")
            val text = note.string("body")
            val headings = note.string("headings")
            val tags = note.getValue("tags").jsonArray.map { it.jsonPrimitive.content }
            clock++
            store.saveChanges(ChangesPage(clock, notes = listOf(ChangedNote(id, clock, note.string("title"), "", clock, tags = tags))))
            val sent = store.content(id)
            store.saveExchange(
                Exchange.decide(sent, Exchange.entry(sent, withText = true), BatchNoteReply(id, "e1", "U$id", "SV", null, text = text, headings = headings, textHash = textHash(text, headings))),
            )
        }
        val search = OfflineSearch(db)
        val wrong = mutableListOf<String>()
        for (element in contract.getValue("queries").jsonArray) {
            val query = element.jsonObject.string("query")
            val expected = element.jsonObject.getValue("hits").jsonArray.map { it.jsonObject.string("id") to it.jsonObject.getValue("score").jsonPrimitive.double }
            // As typed (#120, A680): the last word a prefix, completed from the notes' words.
            val prefixLast = element.jsonObject["prefixLast"]?.jsonPrimitive?.boolean ?: false
            val got = search.search(query, limit = 10, prefixLast = prefixLast).map { it.noteId to it.score }
            val sameOrder = got.map { it.first } == expected.map { it.first }
            val sameScores = sameOrder && got.zip(expected).all { (a, b) -> kotlin.math.abs(a.second - b.second) <= 1e-6 * maxOf(1.0, kotlin.math.abs(b.second)) }
            if (!sameOrder || !sameScores) wrong += "$query: $got ≠ $expected"
        }
        assertEquals(emptyList<String>(), wrong)
        assert(contract.getValue("queries").jsonArray.count { it.jsonObject["prefixLast"] != null } >= 5)
    }
}
