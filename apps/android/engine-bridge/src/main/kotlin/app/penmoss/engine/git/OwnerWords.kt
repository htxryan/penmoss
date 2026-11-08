package app.penmoss.engine.git

/**
 * The words the phone's owner check shows for a git notebook (T50 G7, A855, A877), Kotlin's own,
 * never a page's: as `noteWords`, `checkWords` and `fitWords` in the Mac app's main process
 * (`apps/desktop/src/git-notebooks.ts`), with the same tests.
 */
object OwnerWords {
    /** The longest the words get (the Mac's password helper's limit; BiometricPrompt's description). */
    const val MAX = 200

    /** A note's title in the words: at most this many characters. */
    const val TITLE_MAX = 60

    private const val FSI = '⁨'
    private const val PDI = '⁩'

    /** Control, format (bidi, zero-width) and line and paragraph separators. */
    private val INVISIBLE = Regex("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]+")

    /** Brackets and double-quote look-alikes, which could fake the end of the title. */
    private val QUOTES = Regex("[\"“”„‟«»＂❝❞〝〞〟″‴‶‷\\[\\]［］【】〔〕]")

    /**
     * A title from the branch as a screen shows it (Settings → Git notebooks): cleaned as [note]
     * cleans it (no control, bidi or zero-width characters, no quote or bracket look-alikes) and
     * isolated (U+2068…U+2069), so it cannot reorder or fake the words around it; null when
     * nothing is left (the screen says "An untitled note").
     */
    fun title(title: String?): String? {
        val clean = clean(title)
        if (clean.isEmpty()) return null
        return "$FSI${if (clean.length > TITLE_MAX) cut(clean, TITLE_MAX - 1) + "…" else clean}$PDI"
    }

    private fun clean(title: String?): String =
        visible(title ?: "").replace(QUOTES, " ").replace(Regex("\\s+"), " ").trim()

    /** At most [max] UTF-16 units, never half of a surrogate pair (#174 review). */
    private fun cut(text: String, max: Int): String =
        if (text.length <= max) text else text.take(if (text[max - 1].isHighSurrogate()) max - 1 else max)

    /**
     * [INVISIBLE] as spaces, but what draws something stays (#174 review, as the Mac's
     * `stripInvisible`): the non-joiner, a joiner between two emoji, and the tags of a
     * subdivision flag (U+1F3F4, tag letters or digits, the cancel tag).
     */
    private fun visible(text: String): String {
        val points = text.codePoints().toArray()
        val out = StringBuilder()
        var i = 0
        while (i < points.size) {
            val code = points[i]
            if (code == 0x1F3F4) {
                var j = i + 1
                while (j < points.size && j - i <= 30 && (points[j] in 0xE0030..0xE0039 || points[j] in 0xE0061..0xE007A)) j++
                if (j > i + 1 && j < points.size && points[j] == 0xE007F) {
                    for (k in i..j) out.appendCodePoint(points[k])
                    i = j + 1
                    continue
                }
            }
            val keep = when {
                code == 0x200C -> true
                code == 0x200D -> pictographic(points.getOrNull(baseBefore(points, i))) && pictographic(points.getOrNull(i + 1))
                code == 0xFE0F -> true
                else -> !INVISIBLE.matches(String(Character.toChars(code)))
            }
            if (keep) out.appendCodePoint(code) else out.append(' ')
            i++
        }
        return out.toString()
    }

    /** The code point a joiner at [at] joins from, past a variation selector or skin tone. */
    private fun baseBefore(points: IntArray, at: Int): Int {
        var i = at - 1
        while (i >= 0 && (points[i] == 0xFE0F || points[i] in 0x1F3FB..0x1F3FF)) i--
        return i
    }

    /** Emoji that take part in joiner sequences (the pictographic blocks and their symbols). */
    private fun pictographic(code: Int?): Boolean = code != null && (
        code in 0x1F000..0x1FAFF || code in 0x2600..0x27BF || code in 0x2300..0x23FF ||
            code in 0x2B00..0x2BFF || code in 0x2190..0x21FF || code == 0x00A9 || code == 0x00AE
        )

    /**
     * A note as the check names it: its title from the branch in brackets, isolated (U+2068…U+2069)
     * so right-to-left letters can't reorder the words around it, cleaned and cut at [TITLE_MAX];
     * else "an untitled note" with the end of its id.
     */
    fun note(id: String, title: String?): String {
        val clean = clean(title)
        if (clean.isEmpty()) return "an untitled note (…${id.takeLast(6)})"
        val shown = if (clean.length > TITLE_MAX) cut(clean, TITLE_MAX - 1) + "…" else clean
        return "[$FSI$shown$PDI]"
    }

    /**
     * Words for the check: no line breaks, at most [MAX] characters. A cut never lands inside a
     * character (a surrogate pair) or inside an isolated title: it goes before the title's
     * bracket instead, so a title shows whole or not at all.
     */
    fun check(text: String): String {
        val flat = text.replace(Regex("\\p{Cc}+"), " ").trim()
        if (flat.length <= MAX) return flat
        var cut = MAX - 3
        val open = flat.lastIndexOf(FSI, cut)
        if (open >= 0) {
            val close = flat.indexOf(PDI, open)
            // The title and its closing bracket must both come before the cut.
            if (close < 0 || close + 2 > cut) cut = if (open > 0 && flat[open - 1] == '[') open - 1 else open
        }
        if (cut > 0 && flat[cut - 1].isHighSurrogate()) cut--
        return flat.take(cut).trimEnd() + "…"
    }

    /**
     * [before] + [path] + [after], at most [MAX] characters, shortening only [path] with an
     * ellipsis in its middle, so the note named in [after] always shows whole (the Mac lane's
     * nit, `fitWords` there). [check] cuts the end when even that cannot fit.
     */
    fun fit(before: String, path: String, after: String): String {
        val controls = Regex("\\p{Cc}+")
        val shown = path.replace(controls, " ")
        val room = MAX - before.replace(controls, " ").length - after.replace(controls, " ").length
        if (shown.length <= room || room < 9) return check(before + shown + after)
        var head = (room - 1 + 1) / 2
        var tail = room - 1 - head
        if (head > 0 && shown[head - 1].isHighSurrogate()) head--
        if (tail > 0 && shown[shown.length - tail].isLowSurrogate()) tail--
        return check(before + shown.take(head) + "…" + shown.takeLast(tail) + after)
    }
}
