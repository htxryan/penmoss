package app.penmoss.data

/**
 * The porter step on one folded term, exactly as the server's FTS5 `porter` and core's
 * `stemTerm` take it (T40 P6 review R4): Martin Porter's algorithm, ported line for line from
 * the `stemmer` package core uses, run with SQLite's byte semantics. A term is stemmed only
 * when its UTF-8 form is 3 to 64 bytes long, and each byte of a non-ASCII character counts as
 * one consonant. Android's FTS4 `porter` tokenizer differs (it cuts a word with a digit over 6
 * bytes to 3 + 3, and any word over 20 to 10 + 10, so a prefix of it never matches), so the
 * phone indexes with FTS4's `simple` tokenizer over text this has already stemmed.
 * `search-fold-v1.json`'s `stems` holds it to core's.
 */
internal object SearchStem {
    private const val MIN_BYTES = 3
    private const val MAX_BYTES = 64

    /** Stands in for each UTF-8 byte of a non-ASCII character while stemming: a consonant. */
    private const val BYTE_STANDIN = 'q'

    private fun utf8Length(cp: Int): Int = when {
        cp < 0x80 -> 1
        cp < 0x800 -> 2
        cp < 0x10000 -> 3
        else -> 4
    }

    /** Core's `stemTerm`. */
    fun stem(term: String): String {
        val masked = StringBuilder()
        var i = 0
        var ascii = true
        while (i < term.length) {
            val cp = term.codePointAt(i)
            if (cp < 0x80) masked.append(cp.toChar()) else {
                ascii = false
                repeat(utf8Length(cp)) { masked.append(BYTE_STANDIN) }
            }
            i += Character.charCount(cp)
        }
        if (masked.length < MIN_BYTES || masked.length > MAX_BYTES) return term
        if (ascii) return porter(term)
        val stemmed = porter(masked.toString())
        var common = 0
        while (common < stemmed.length && common < masked.length && stemmed[common] == masked[common]) common++
        // The unchanged prefix maps back to the original characters.
        val out = StringBuilder()
        var used = 0
        i = 0
        while (i < term.length) {
            val cp = term.codePointAt(i)
            val width = utf8Length(cp)
            if (used + width > common) break
            out.appendCodePoint(cp)
            used += width
            i += Character.charCount(cp)
        }
        return out.append(stemmed, minOf(used, stemmed.length), stemmed.length).toString()
    }

    private val step2list = mapOf(
        "ational" to "ate", "tional" to "tion", "enci" to "ence", "anci" to "ance", "izer" to "ize",
        "bli" to "ble", "alli" to "al", "entli" to "ent", "eli" to "e", "ousli" to "ous",
        "ization" to "ize", "ation" to "ate", "ator" to "ate", "alism" to "al", "iveness" to "ive",
        "fulness" to "ful", "ousness" to "ous", "aliti" to "al", "iviti" to "ive", "biliti" to "ble",
        "logi" to "log",
    )
    private val step3list = mapOf(
        "icate" to "ic", "ative" to "", "alize" to "al", "iciti" to "ic", "ical" to "ic", "ful" to "", "ness" to "",
    )

    private const val CONSONANT = "[^aeiou]"
    private const val VOWEL = "[aeiouy]"
    private const val CONSONANTS = "($CONSONANT[^aeiouy]*)"
    private const val VOWELS = "($VOWEL[aeiou]*)"

    private val gt0 = Regex("^$CONSONANTS?$VOWELS$CONSONANTS")
    private val eq1 = Regex("^$CONSONANTS?$VOWELS$CONSONANTS$VOWELS?$")
    private val gt1 = Regex("^$CONSONANTS?($VOWELS$CONSONANTS){2,}")
    private val vowelInStem = Regex("^$CONSONANTS?$VOWEL")
    private val consonantLike = Regex("^$CONSONANTS$VOWEL[^aeiouwxy]$")

    private val sfxLl = Regex("ll$")
    private val sfxE = Regex("^(.+?)e$")
    private val sfxY = Regex("^(.+?)y$")
    private val sfxIon = Regex("^(.+?(s|t))(ion)$")
    private val sfxEdOrIng = Regex("^(.+?)(ed|ing)$")
    private val sfxAtOrBlOrIz = Regex("(at|bl|iz)$")
    private val sfxEED = Regex("^(.+?)eed$")
    private val sfxS = Regex("^.+?[^s]s$")
    private val sfxSsesOrIes = Regex("^.+?(ss|i)es$")
    private val sfxMultiConsonantLike = Regex("([^aeiouylsz])\\1$")
    private val step2 = Regex(
        "^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$",
    )
    private val step3 = Regex("^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$")
    private val step4 = Regex("^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$")

    private fun Regex.test(text: String) = containsMatchIn(text)

    /** The `stemmer` package's `stemmer(value)`, step for step. */
    fun porter(value: String): String {
        var result = value.lowercase()
        if (result.length < 3) return result
        var firstY = false
        if (result[0] == 'y') {
            firstY = true
            result = "Y" + result.substring(1)
        }
        // Step 1a.
        if (sfxSsesOrIes.test(result)) {
            result = result.dropLast(2)
        } else if (sfxS.test(result)) {
            result = result.dropLast(1)
        }
        // Step 1b.
        var match = sfxEED.find(result)
        if (match != null) {
            if (gt0.test(match.groupValues[1])) result = result.dropLast(1)
        } else {
            match = sfxEdOrIng.find(result)
            if (match != null && vowelInStem.test(match.groupValues[1])) {
                result = match.groupValues[1]
                if (sfxAtOrBlOrIz.test(result)) {
                    result += "e"
                } else if (sfxMultiConsonantLike.test(result)) {
                    result = result.dropLast(1)
                } else if (consonantLike.test(result)) {
                    result += "e"
                }
            }
        }
        // Step 1c.
        match = sfxY.find(result)
        if (match != null && vowelInStem.test(match.groupValues[1])) result = match.groupValues[1] + "i"
        // Step 2.
        match = step2.find(result)
        if (match != null && gt0.test(match.groupValues[1])) result = match.groupValues[1] + step2list.getValue(match.groupValues[2])
        // Step 3.
        match = step3.find(result)
        if (match != null && gt0.test(match.groupValues[1])) result = match.groupValues[1] + step3list.getValue(match.groupValues[2])
        // Step 4.
        match = step4.find(result)
        if (match != null) {
            if (gt1.test(match.groupValues[1])) result = match.groupValues[1]
        } else {
            match = sfxIon.find(result)
            if (match != null && gt1.test(match.groupValues[1])) result = match.groupValues[1]
        }
        // Step 5.
        match = sfxE.find(result)
        if (match != null && (gt1.test(match.groupValues[1]) || (eq1.test(match.groupValues[1]) && !consonantLike.test(match.groupValues[1])))) {
            result = match.groupValues[1]
        }
        if (sfxLl.test(result) && gt1.test(result)) result = result.dropLast(1)
        if (firstY) result = "y" + result.substring(1)
        return result
    }
}
