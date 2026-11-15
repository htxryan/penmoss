package app.penmoss.engine.settings

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Finding a character by name (A1568, A1569): the web's `findGlyphs` (core `glyph-search.ts`),
 * held to its order by `contract/glyph-search-v1.json`. The query is split into words; an item is
 * found when every word matches its name or a keyword. A whole word of the name scores most, then
 * the start of one, then anywhere in the name, then a whole keyword, the start of one, and
 * anywhere in one (three letters or more). The whole query as the name, or its start, scores most
 * of all, and a pasted glyph finds itself. Equal scores keep the list's order.
 */
object GlyphSearch {
    private val PUNCTUATION = Regex("[-_:,]+")
    private val SPACES = Regex("(?U)\\s+")
    private val VARIATION_SELECTORS = Regex("[︎️]")

    /** Lower case, with hyphens, underscores, colons and runs of spaces as one space. */
    fun normalise(text: String): String =
        text.lowercase().replace(PUNCTUATION, " ").replace(SPACES, " ").trim()

    private fun words(text: String): List<String> = normalise(text).split(' ').filter { it.isNotEmpty() }

    private fun wordScore(term: String, name: String, nameWords: List<String>, keys: List<String>): Double = when {
        term in nameWords -> 6.0
        nameWords.any { it.startsWith(term) } -> 4.0
        name.contains(term) -> 3.0
        term in keys -> 2.5
        keys.any { it.startsWith(term) } -> 2.0
        term.length >= 3 && keys.any { it.contains(term) } -> 1.0
        else -> 0.0
    }

    /** An item's score for a normalised query (0: not found); [raw] is the query as typed. */
    fun score(item: Findable, query: String, raw: String = query): Double {
        val glyph = item.glyph
        if (glyph != null && raw.trim().isNotEmpty()) {
            val pasted = raw.trim().replace(VARIATION_SELECTORS, "")
            if (pasted == glyph.replace(VARIATION_SELECTORS, "")) return 1000.0
        }
        val terms = query.split(' ').filter { it.isNotEmpty() }
        if (terms.isEmpty()) return 0.0
        val name = normalise(item.name)
        val nameWords = name.split(' ')
        val keys = item.keywords.flatMap(::words)
        var total = 0.0
        for (term in terms) {
            val each = wordScore(term, name, nameWords, keys)
            if (each == 0.0) return 0.0
            total += each
        }
        total += when {
            name == query -> 100.0
            name.startsWith(query) -> 20.0
            else -> 0.0
        }
        return total
    }

    /** What a query finds, best first; everything, in order, for an empty one. */
    fun <T : Findable> find(items: List<T>, query: String): List<T> {
        val normal = normalise(query)
        if (normal.isEmpty() && query.trim().isEmpty()) return items
        return items.mapIndexedNotNull { at, item ->
            val score = score(item, normal, query)
            if (score > 0.0) Triple(item, score, at) else null
        }.sortedWith(compareByDescending<Triple<T, Double, Int>> { it.second }.thenBy { it.third })
            .map { it.first }
    }
}

/** What [GlyphSearch] finds: a name, other words for it, and the character itself, if it is one. */
interface Findable {
    val name: String
    val keywords: List<String>
    val glyph: String?
}

/**
 * One of the Characters a line symbol can be (A1569): symbols, then emoji, each a valid glyph by
 * [LineSymbols]' rules, with a name and keywords to find it by. The web's own file,
 * `packages/core/data/characters.json`, is a resource of this module (`characterResources`).
 */
@Serializable
data class CharacterEntry(
    override val glyph: String,
    override val name: String,
    override val keywords: List<String> = emptyList(),
    val group: String,
) : Findable

object Characters {
    private val json = Json { ignoreUnknownKeys = true }

    /** Every character, in the file's order: the old presets first, then by group. */
    val all: List<CharacterEntry> by lazy {
        val text = Characters::class.java.getResourceAsStream("/characters.json")
            ?.bufferedReader(Charsets.UTF_8)
            ?.use { it.readText() }
            ?: error("characters.json is missing from the engine's resources")
        json.decodeFromString<List<CharacterEntry>>(text)
    }
}
