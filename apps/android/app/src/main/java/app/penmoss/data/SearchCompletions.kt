package app.penmoss.data

/**
 * Partly typed words on the phone (#120, A680), as core's `completions` (`completions.ts`):
 * the index holds stems, so a prefix typed past a word's stem (`happin`, of happiness, stemmed
 * `happi`) reached nothing. The phone keeps each note's words as written ([NoteTextEntity.fwords],
 * indexed by [NoteWordFts]); a prefix looks up the first [SCAN] that start with it, in code-point
 * order (as SQLite sorts them), and keeps one per stem that its own stem does not reach, at most
 * [MAX]. Each is matched as one more whole word, ORed with the prefix, and ranks as its own
 * phrase, as FTS5 ranks the server's `"happin"* OR "happiness"`. `search-fold-v1.json` holds the
 * two to the same answers.
 */
internal object SearchCompletions {
    /** Shorter prefixes are left alone: porter keeps a word's first two letters (core's `MIN_COMPLETION_LENGTH`). */
    const val MIN_LENGTH = 3

    /** Words looked at per prefix (core's `COMPLETION_SCAN`). */
    const val SCAN = 64

    /** Completions kept per prefix (core's `MAX_COMPLETIONS`). */
    const val MAX = 16

    /** Prefixes completed per query, the last ones (core's `MAX_COMPLETED_PREFIXES`). */
    const val MAX_PREFIXES = 2

    /** Code-point order: UTF-8's, which is how SQLite compares the words it holds. */
    fun compareCodePoints(a: String, b: String): Int {
        val length = minOf(a.length, b.length)
        for (i in 0 until length) {
            val x = a[i]
            val y = b[i]
            if (x == y) continue
            // A surrogate (an astral character) sorts after every other UTF-16 unit.
            val sx = x.isSurrogate()
            val sy = y.isSurrogate()
            if (sx != sy) return if (sx) 1 else -1
            return x.code - y.code
        }
        return a.length - b.length
    }

    /** Bounds for a range scan of the words starting with [prefix]: `>=` the first, `<` the second. */
    fun range(prefix: String): Pair<String, String> = prefix to prefix + String(Character.toChars(0x10FFFF))

    /**
     * The completions of [prefix] among [words] (any order; ones that do not start with it are
     * ignored): of the first [SCAN] in code-point order, one word per stem that the prefix's stem
     * does not reach, at most [MAX].
     */
    fun completions(prefix: String, words: Iterable<String>): List<String> {
        val scanned = words.toSet().filter { it.startsWith(prefix) }.sortedWith(::compareCodePoints).take(SCAN)
        val reached = SearchStem.stem(prefix)
        val stems = HashSet<String>()
        val out = ArrayList<String>()
        for (word in scanned) {
            val stem = SearchStem.stem(word)
            if (stem.startsWith(reached) || !stems.add(stem)) continue
            out += word
            if (out.size == MAX) break
        }
        return out
    }

    /** A note's distinct words as written (folded, not stemmed), space-separated, in the order they first appear. */
    fun words(columns: List<String>): String = columns.flatMap { SearchFold.terms(it) }.distinct().joinToString(" ")
}
