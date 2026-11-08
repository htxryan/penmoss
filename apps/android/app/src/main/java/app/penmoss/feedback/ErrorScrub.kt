package app.penmoss.feedback

/**
 * Feedback's Recent errors as they leave the phone (T49, A791; the scrub the error reports used,
 * A427, which went with the Penmoss server in T59): every note title and folder name this phone
 * knows and any quoted text become [SCRUBBED], and the part of a JSON error that quotes the reply
 * goes. With no names known, the free text is withheld: only the exception's kind and its stack
 * frames are kept.
 */
object ErrorScrub {
    /** Names shorter than this are not scrubbed: "a" or "To" would eat the message. */
    private const val MIN_NAME = 3
    const val SCRUBBED = "‹name›"
    const val WITHHELD = "‹withheld›"

    /**
     * Quoted text, scrubbed whatever it holds: curly and straight double quotes, escaped
     * quotes inside, and a quote left open (cut short) running to the end; single quotes
     * only when closed, so an apostrophe does not eat the rest.
     */
    private val QUOTED = Regex("“[^”]*”?|\"(?:[^\"\\\\]|\\\\.)*\"?|'(?:[^'\\\\\\n]|\\\\.){2,}'")

    /** kotlinx.serialization quotes the reply it could not read after this (S1): never sent. */
    private val JSON_INPUT = Regex("(?s)JSON input:.*")

    /** A stack frame, or the "... 3 more" after one: code, never what the person wrote. */
    private val FRAME = Regex("^\\s+(at |\\.\\.\\. \\d+ more)")

    /** An exception's header line: its class (with a package), and whatever message follows. */
    private val HEADER = Regex("^(\\s*(?:Caused by: |Suppressed: )?[\\w$]+(?:\\.[\\w$]+)+)(:.*)?$", RegexOption.DOT_MATCHES_ALL)

    /**
     * An error's message and stack as a report carries them (A427): [fixed] kept, [free] text
     * and the stack's free text cleaned of [names] (whole words) and quotations; with no names
     * known (null or none usable), the free text withheld and only frames and class names
     * kept.
     */
    fun scrubbed(fixed: String, free: String, detail: String, names: Collection<String>?): Pair<String, String> {
        val usable = names?.let(::usable)?.takeIf { it.isNotEmpty() }
        val message = join(fixed, if (free.isEmpty()) "" else if (usable == null) WITHHELD else clean(free, usable))
        return message to if (usable == null) withholdDetail(detail) else scrubDetail(detail, usable)
    }

    private fun usable(names: Collection<String>) =
        names.map { it.trim() }.filter { it.length >= MIN_NAME }.distinct().sortedByDescending { it.length }

    /** The stack's free text (not its frames or blank lines), each run of such lines as one block. */
    private fun mapText(detail: String, change: (String) -> String): String {
        if (detail.isEmpty()) return detail
        val out = StringBuilder()
        val block = mutableListOf<String>()
        fun flush() {
            if (block.isEmpty()) return
            if (out.isNotEmpty()) out.append('\n')
            out.append(change(block.joinToString("\n")))
            block.clear()
        }
        for (line in detail.split('\n')) {
            if (line.isBlank() || FRAME.containsMatchIn(line)) {
                flush()
                if (out.isNotEmpty()) out.append('\n')
                out.append(line)
            } else {
                block += line
            }
        }
        flush()
        return out.toString()
    }

    private fun join(fixed: String, free: String) = when {
        fixed.isEmpty() -> free
        free.isEmpty() -> fixed
        else -> "$fixed: $free"
    }

    /** [text] with the JSON reply quoted, every name (whole words only) and quoted text replaced. */
    private fun clean(text: String, names: List<String>): String {
        var out = JSON_INPUT.replace(text, "JSON input: $WITHHELD")
        for (name in names) {
            out = Regex("(?<![\\p{L}\\p{N}_])${Regex.escape(name)}(?![\\p{L}\\p{N}_])", RegexOption.IGNORE_CASE).replace(out, SCRUBBED)
        }
        return QUOTED.replace(out, SCRUBBED)
    }

    /** A stack's free text cleaned; its frames and exception class names left as they are (N5). */
    private fun scrubDetail(detail: String, names: List<String>) = mapText(detail) { block ->
        val header = HEADER.matchEntire(block)
        if (header == null) clean(block, names) else header.groupValues[1] + clean(header.groupValues[2], names)
    }

    /** A stack with only its frames and exception class names: no names known to scrub it of. */
    private fun withholdDetail(detail: String) = mapText(detail) { block ->
        val header = HEADER.matchEntire(block)
        when {
            header == null -> WITHHELD
            header.groupValues[2].isEmpty() -> block
            else -> "${header.groupValues[1]}: $WITHHELD"
        }
    }
}
