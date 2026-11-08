package app.penmoss.engine.notes

/**
 * Tag names as every Penmoss client writes them (T18, `packages/core/src/tags.ts`): letters,
 * marks, digits, `_`, `-` and `/` for levels, with a non-digit in the first level, lower-case.
 * The phone only checks what Ryan types before the editor page sets it; the page normalises it
 * again with the shared code, and the note's own document is the only place tags live (T38).
 */
object Tags {
    private val BODY = Regex("^[\\p{L}\\p{M}\\p{N}_\\-/]+$")
    private val NOT_A_DIGIT = Regex("[^\\p{N}]")

    /** What the web says for a name that is not a tag. */
    const val INVALID = "A tag is letters, digits, - and _, with / for levels, and no spaces."

    /**
     * The longest tag the phone sends the page (A361): far above any tag typed, so a tag set on
     * the web, which has no limit, can still be removed here. Shared with the page through
     * `apps/android/contract/tags-v1.json`.
     */
    const val MAX_CHARS = 1000

    /**
     * The canonical form of a tag, or null when it is not a valid tag (as `normaliseTag`; both are
     * checked against `apps/android/contract/tags-v1.json`).
     */
    fun normalise(raw: String): String? {
        val name = jsTrim(raw)
            .replace(Regex("^#+"), "")
            .replace(Regex("/{2,}"), "/")
            .replace(Regex("^/+|/+$"), "")
            .lowercase()
        if (name.isEmpty() || !BODY.matches(name)) return null
        // Every level needs a non-digit (`#2026` is a number, `#log/2026` is fine).
        if (!NOT_A_DIGIT.containsMatchIn(name.substringBefore('/'))) return null
        return name
    }

    /**
     * Trims as JavaScript's `String.prototype.trim` does, which the shared rules use: Kotlin's
     * `trim()` also strips U+001C–U+001F and keeps U+FEFF.
     */
    private fun jsTrim(text: String): String = text.trim { it == '\uFEFF' || (it.isWhitespace() && it !in '\u001C'..'\u001F') }

    /**
     * Tags to suggest for what is typed (T42, A577; T40 TG6, A656), ranked as the web's
     * `tagSuggestions`: a tag starting with it first, then one with a level starting with it
     * (`area/cooking` for "cook"), then any containing it; the more notes carry a tag, the higher
     * among equals. The note's own tags are left out. With nothing typed, the most used: on a
     * phone a tap on a chip is quicker than typing (the web suggests nothing until typing starts).
     */
    fun suggest(typed: String, known: List<Pair<String, Int>>, exclude: Collection<String>, limit: Int = 8): List<String> {
        val query = typed.trim().replace(Regex("^#+"), "").lowercase()
        val skip = exclude.toSet()
        fun rank(name: String): Int = when {
            query.isEmpty() || name.startsWith(query) -> 0
            name.split('/').any { it.startsWith(query) } -> 1
            query in name -> 2
            else -> -1
        }
        // Each tag ranked once, not on every comparison (#137): a big vault's tags, each keystroke.
        return known.asSequence()
            .filter { (name, _) -> name !in skip }
            .map { (name, count) -> Ranked(name, count, rank(name)) }
            .filter { it.rank >= 0 }
            .sortedWith(compareBy<Ranked> { it.rank }.thenByDescending { it.count }.thenBy { it.name })
            .map { it.name }
            .distinct()
            .take(limit)
            .toList()
    }

    private class Ranked(val name: String, val count: Int, val rank: Int)

    /**
     * Every tag on any note and how many carry it (A577, A656): the phone's own index (Room, from
     * `/sync/changes` and the page, offline too) first, then any the last `/api/tags` or this phone
     * added that the index does not have yet.
     */
    fun everyTag(indexed: List<Pair<String, Int>>, listed: List<Pair<String, Int>>): List<Pair<String, Int>> {
        val names = indexed.mapTo(HashSet()) { it.first }
        return indexed + listed.filter { it.first !in names }
    }
}

/** One tag in the tag browser (T40 P6, TG1): [count] notes carry it or a tag nested under it. */
data class TagNode(
    /** The full tag (`area/cooking`). */
    val tag: String,
    /** The last level (`cooking`). */
    val name: String,
    val count: Int,
    val children: List<TagNode>,
)

/**
 * The tag tree as core's `tagTree` builds it (T18, A467): one node per tag and per level above
 * it, each counting the notes tagged with it or anything nested under it (a note once, however
 * many of its tags sit there), sorted by name as JavaScript sorts (UTF-16 code units, as
 * Kotlin's `String` compares). Checked against `apps/android/contract/tag-tree-v1.json`.
 */
object TagTree {
    /** `a/b/c` → `[a, a/b, a/b/c]`: a note tagged `a/b` is also under `a`. */
    fun ancestors(tag: String): List<String> {
        val parts = tag.split('/')
        return parts.indices.map { parts.subList(0, it + 1).joinToString("/") }
    }

    /** Whether [tag] is [filter] or nested under it (core's `tagMatches`). */
    fun matches(tag: String, filter: String): Boolean = tag == filter || tag.startsWith("$filter/")

    fun build(notes: Iterable<Collection<String>>): List<TagNode> {
        val counts = HashMap<String, Int>()
        for (tags in notes) {
            for (level in tags.flatMapTo(HashSet()) { ancestors(it) }) counts[level] = (counts[level] ?: 0) + 1
        }
        val byParent = counts.keys.groupBy { tag -> tag.lastIndexOf('/').let { if (it == -1) null else tag.substring(0, it) } }
        fun level(parent: String?): List<TagNode> = byParent[parent].orEmpty().sorted().map { tag ->
            TagNode(tag, tag.substring(tag.lastIndexOf('/') + 1), counts.getValue(tag), level(tag))
        }
        return level(null)
    }
}
