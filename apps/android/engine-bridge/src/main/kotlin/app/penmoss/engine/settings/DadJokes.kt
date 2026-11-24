package app.penmoss.engine.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.random.Random

/**
 * Dad Jokes (A1576, A1598; on Android, PEN-10): a joke heads Home when no note is open, as it
 * heads the Mac's empty window. The jokes are core's `packages/core/data/dad-jokes.json`, the one
 * list the web app imports too, bundled as a resource of this module (`jokeResources`). The
 * setting is core's `home.dadJokes`, this device's own (A1626, [LocalSettings]).
 */
object DadJokes {
    /** Core's `DAD_JOKES_SETTING`. */
    const val KEY = "home.dadJokes"

    /** The jokes, in the file's order. */
    val ALL: List<String> by lazy {
        val text = DadJokes::class.java.getResourceAsStream("/dad-jokes.json")?.use { it.readBytes().decodeToString() }
            ?: error("dad-jokes.json is missing from the engine's resources")
        Json.parseToJsonElement(text).jsonArray.map { it.jsonPrimitive.content }
    }

    /** Whether Home's heading is a joke: on unless turned off (`false`), as core's `dadJokesOf`. */
    fun on(settings: Settings): Boolean = (settings.values[KEY] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull != false
}

/**
 * Deals the jokes (A1576), as the web's `joke-deck.ts`: at random, none twice until every one has
 * been seen, then a fresh shuffle that never starts with the last one dealt, reshuffled when the
 * list's length changes. The deck (the jokes still to come, by index) is kept on this device in
 * [store], in the web's own shape; where the store cannot be read or written, a deck in memory
 * does the same while the app runs.
 */
class JokeDeck(private val store: Store?, private val random: Random = Random.Default) {
    /** Where the deck is kept: the phone's own preferences. */
    interface Store {
        fun read(): String?
        fun write(deck: String)
    }

    /** The next joke from [jokes], dealt from the deck; empty when there are none. */
    fun draw(jokes: List<String>): String {
        if (jokes.isEmpty()) return ""
        var deck = read(jokes.size)
        if (deck == null || deck.size != jokes.size || deck.left.isEmpty()) {
            deck = Deck(jokes.size, shuffled(jokes.size, deck?.last, random), null)
        }
        val next = deck.left.first()
        write(Deck(jokes.size, deck.left.drop(1), next))
        return jokes[next]
    }

    private fun read(size: Int): Deck? {
        val raw = try {
            store?.read()
        } catch (_: Exception) {
            return inMemory
        } ?: return inMemory
        return try {
            val json = Json.parseToJsonElement(raw) as? JsonObject ?: return null
            val stored = (json["size"] as? JsonPrimitive)?.intOrNull
            val left = (json["left"] as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.intOrNull ?: -1 }
            val last = json["last"]
            val lastIndex = if (last == null || last is JsonNull) null else (last as? JsonPrimitive)?.intOrNull ?: return null
            val fine = stored == size && left != null && left.all { it in 0 until size } && (lastIndex == null || lastIndex in 0 until size)
            if (fine) Deck(size, left!!, lastIndex) else null
        } catch (_: Exception) {
            inMemory
        }
    }

    private fun write(deck: Deck) {
        inMemory = deck
        try {
            store?.write(
                JsonObject(
                    mapOf(
                        "size" to JsonPrimitive(deck.size),
                        "left" to JsonArray(deck.left.map { JsonPrimitive(it) }),
                        "last" to (deck.last?.let { JsonPrimitive(it) } ?: JsonNull),
                    ),
                ).toString(),
            )
        } catch (_: Exception) {
            // The deck in memory carries on while the app runs.
        }
    }

    /** How many jokes the deck was shuffled from, the indices still to deal (next first), and the last dealt. */
    internal data class Deck(val size: Int, val left: List<Int>, val last: Int?)

    companion object {
        /** The deck while the store fails, as the web's `inMemory`. */
        @Volatile
        private var inMemory: Deck? = null

        /** The web's key, in the phone's preferences. */
        const val KEY = "penmoss.jokeDeck"

        /** The indices 0 until [size] in a random order (Fisher–Yates), not starting with [last]. */
        fun shuffled(size: Int, last: Int?, random: Random): List<Int> {
            val order = MutableList(size) { it }
            for (i in size - 1 downTo 1) {
                val j = random.nextInt(i + 1)
                order[i] = order[j].also { order[j] = order[i] }
            }
            if (size > 1 && order[0] == last) order[0] = order[1].also { order[1] = order[0] }
            return order
        }

        /** Forgets the deck in memory (tests). */
        fun reset() {
            inMemory = null
        }
    }
}
