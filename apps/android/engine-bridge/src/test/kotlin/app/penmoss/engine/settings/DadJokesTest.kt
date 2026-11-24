package app.penmoss.engine.settings

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Dad Jokes on the phone (PEN-10): core's one list, the setting read as core's `dadJokesOf`, and
 * the deck dealt as the web's `joke-deck.ts` deals it (A1576).
 */
class DadJokesTest {
    private class Memory(var value: String? = null) : JokeDeck.Store {
        override fun read(): String? = value
        override fun write(deck: String) {
            value = deck
        }
    }

    private class Broken : JokeDeck.Store {
        override fun read(): String? = throw IllegalStateException("blocked")
        override fun write(deck: String) = throw IllegalStateException("blocked")
    }

    @Before
    fun forget() = JokeDeck.reset()

    @Test
    fun theJokesAreCoresList() {
        // packages/core/data/dad-jokes.json, the file the web imports, bundled as it is: no copy.
        val core = File("../../../packages/core/data/dad-jokes.json")
        val jokes = DadJokes.ALL
        assertEquals(Json.parseToJsonElement(core.readText()).jsonArray.map { it.jsonPrimitive.content }, jokes)
        assertTrue(jokes.size > 300)
        assertEquals(jokes.size, jokes.toSet().size)
        assertTrue(jokes.all { it.isNotBlank() })
    }

    @Test
    fun onUnlessTurnedOff() {
        assertTrue(DadJokes.on(Settings()))
        assertTrue(DadJokes.on(Settings().with(DadJokes.KEY, JsonPrimitive(true))))
        assertFalse(DadJokes.on(Settings().with(DadJokes.KEY, JsonPrimitive(false))))
        // Any other value is the default, as core's dadJokesOf.
        assertTrue(DadJokes.on(Settings().with(DadJokes.KEY, JsonPrimitive("false"))))
        assertTrue(DadJokes.on(Settings().with(DadJokes.KEY, JsonPrimitive(0))))
        // This device's own (A1626).
        assertTrue(LocalSettings.isLocal(DadJokes.KEY))
    }

    @Test
    fun noneTwiceUntilEveryOneIsSeenAndANewShuffleNeverStartsWithTheLast() {
        val jokes = (1..7).map { "joke $it" }
        val store = Memory()
        val deck = JokeDeck(store, Random(42))
        repeat(20) {
            val round = (1..jokes.size).map { deck.draw(jokes) }
            assertEquals(jokes.toSet(), round.toSet())
            val next = deck.draw(jokes)
            assertNotEquals(round.last(), next)
            // Put that one back: the next round starts after it in the stored deck.
            val again = JokeDeck(store, Random(it))
            val rest = (1 until jokes.size).map { again.draw(jokes) }
            assertEquals(jokes.toSet() - next, rest.toSet())
        }
    }

    @Test
    fun keepsTheDeckInTheWebsShapeAndReshufflesWhenTheListChanges() {
        val store = Memory()
        val deck = JokeDeck(store, Random(1))
        deck.draw(listOf("a", "b", "c"))
        assertTrue(store.value!!.contains("\"size\":3"))
        assertTrue(store.value!!.contains("\"left\":["))
        // A list of another length starts a new deck of that length.
        val four = listOf("a", "b", "c", "d")
        assertEquals(four.toSet(), (1..4).map { deck.draw(four) }.toSet())
        // A deck stored wrong is shuffled again.
        store.value = "{\"size\":4,\"left\":[9],\"last\":null}"
        assertTrue(deck.draw(four) in four)
        store.value = "not json"
        assertTrue(deck.draw(four) in four)
    }

    @Test
    fun aStoreThatFailsDealsFromMemory() {
        val jokes = listOf("a", "b", "c", "d", "e")
        val deck = JokeDeck(Broken(), Random(3))
        assertEquals(jokes.toSet(), (1..jokes.size).map { deck.draw(jokes) }.toSet())
        assertEquals("", deck.draw(emptyList()))
    }

    @Test
    fun aShuffleIsEveryIndexOnce() {
        for (seed in 0 until 50) {
            val order = JokeDeck.shuffled(10, last = 3, random = Random(seed))
            assertEquals((0 until 10).toList(), order.sorted())
            assertNotEquals(3, order.first())
        }
    }
}
