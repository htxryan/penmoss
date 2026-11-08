package app.penmoss.data

import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Text as the server's FTS5 tokenizer (`porter unicode61 remove_diacritics 2`) and the web's
 * offline index (`@penmoss/core/search`'s `tokenize`) cut and fold it, before FTS4 sees it
 * (T40 P6 review B1). Android's FTS4 has no unicode61, and its simple tokenizer keeps every
 * non-ASCII character in a word (`Ryan’s`, `foo—bar` stay one token) and lower-cases ASCII only
 * (`Éclair` never meets `éclair`). So the phone indexes a folded copy: every separator of
 * unicode61's tables a space, every other character folded as unicode61 folds it (lower-cased,
 * diacritics and marks dropped, the table's own exceptions), each word then stemmed by
 * [SearchStem] as the server's porter stems it ([indexed]), and the simple tokenizer cuts the
 * result exactly at those spaces (A462, review R4).
 *
 * [Folded.from] and [Folded.to] map each folded character back to the original text, so matches
 * found in the folded copy are marked on the real characters.
 */
internal object SearchFold {
    /** The folded text, and for each of its characters the original range it came from. */
    class Folded(val text: String, val from: IntArray, val to: IntArray) {
        /** The tokens: runs of folded characters, as original ranges, with their folded starts. */
        fun tokens(): List<Token> {
            val out = ArrayList<Token>()
            var start = -1
            for (i in 0..text.length) {
                val space = i == text.length || text[i] == ' '
                if (!space && start == -1) start = i
                if (space && start != -1) {
                    out += Token(start, from[start], to[i - 1])
                    start = -1
                }
            }
            return out
        }
    }

    /** One token: where it starts in the folded text, and its range in the original. */
    data class Token(val folded: Int, val start: Int, val end: Int)

    private val separators: IntArray = UnicodeFoldTable.SEPARATOR_RANGES.split(',').flatMap { part ->
        val bounds = part.split('-')
        val from = bounds[0].toInt(36)
        listOf(from, if (bounds.size > 1) bounds[1].toInt(36) else from)
    }.toIntArray()

    private val exceptions: Map<Int, String> = UnicodeFoldTable.FOLD_EXCEPTIONS.split(',').associate { entry ->
        val colon = entry.indexOf(':')
        entry.substring(0, colon).toInt(36) to entry.substring(colon + 1)
    }

    private val cache = ConcurrentHashMap<Int, String>()
    private val MARKS = Regex("\\p{M}+")

    private fun isSeparator(cp: Int): Boolean {
        var low = 0
        var high = separators.size / 2 - 1
        while (low <= high) {
            val mid = (low + high) ushr 1
            when {
                cp < separators[mid * 2] -> high = mid - 1
                cp > separators[mid * 2 + 1] -> low = mid + 1
                else -> return true
            }
        }
        return false
    }

    /** One character's fold where the table has no exception, as core's `defaultFold`. */
    internal fun defaultFold(cp: Int): String {
        val type = Character.getType(cp)
        if (type == Character.NON_SPACING_MARK.toInt() || type == Character.ENCLOSING_MARK.toInt() || type == Character.COMBINING_SPACING_MARK.toInt()) return ""
        val lower = String(Character.toChars(cp)).lowercase(Locale.ROOT)
        return Normalizer.normalize(Normalizer.normalize(lower, Normalizer.Form.NFD).replace(MARKS, ""), Normalizer.Form.NFC)
    }

    private fun foldCodePoint(cp: Int): String = cache.getOrPut(cp) { exceptions[cp] ?: defaultFold(cp) }

    fun fold(raw: String): Folded {
        val out = StringBuilder(raw.length)
        val from = IntArray(raw.length * 2 + 4)
        val to = IntArray(raw.length * 2 + 4)
        var n = 0
        fun emit(char: Char, start: Int, end: Int) {
            out.append(char)
            from[n] = start
            to[n] = end
            n++
        }
        var i = 0
        while (i < raw.length) {
            val code = raw[i].code
            if (code < 0x80) {
                val token = code in 48..57 || code in 65..90 || code in 97..122
                emit(if (!token) ' ' else if (code in 65..90) (code + 32).toChar() else raw[i], i, i + 1)
                i++
                continue
            }
            val cp = raw.codePointAt(i)
            val width = Character.charCount(cp)
            if (isSeparator(cp)) {
                emit(' ', i, i + width)
            } else {
                val folded = foldCodePoint(cp)
                // A mark folds to nothing: it stays inside the token it follows, as core's
                // token runs to the next separator (review N1).
                if (folded.isEmpty() && n > 0 && out[n - 1] != ' ') to[n - 1] = i + width
                // A fold never yields an ASCII separator the simple tokenizer would split on.
                for (char in folded) emit(if (char.code < 0x80 && !char.isLetterOrDigit()) ' ' else char, i, i + width)
            }
            i += width
        }
        return Folded(out.toString(), from.copyOf(n), to.copyOf(n))
    }

    /** The folded words of [text], as core's `tokenize(text, { stem: false })` gives its terms. */
    fun terms(text: String): List<String> = fold(text).text.split(' ').filter { it.isNotEmpty() }

    /**
     * [text] as the index stores it (review R4): its folded words stemmed as the server stems
     * them ([SearchStem]), one space between, which FTS4's `simple` tokenizer cuts back into
     * exactly those terms.
     */
    fun indexed(text: String): String = terms(text).joinToString(" ") { SearchStem.stem(it) }
}
