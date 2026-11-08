package app.penmoss.feedback

/*
 * What keeps note text out of feedback (T49, A791): an error is scrubbed as the app's error
 * reports were ([ErrorScrub], A427), then of tokens, emails and URL queries as core's
 * `redactText` does, and one that quotes the open note's text is dropped, not redacted.
 */
object FeedbackRedaction {
    /** How many characters of a note's text in a row count as quoting it (core's QUOTE_WINDOW). */
    const val QUOTE_WINDOW = 24

    private val TOKEN = Regex("\\bpm[sda]_[A-Za-z0-9_-]{8,}")
    private val BEARER = Regex("\\bBearer\\s+\\S+", RegexOption.IGNORE_CASE)
    private val EMAIL = Regex("[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+")

    /** GitHub's tokens (classic, OAuth, app and fine-grained), now that the phone holds one (A1010). */
    private val GITHUB_TOKEN = Regex("\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")

    /**
     * [text] with Penmoss and GitHub tokens and bearer credentials removed (core's
     * `redactSecrets`): the last check on everything the phone posts to GitHub (A791, A1010).
     */
    fun redactSecrets(text: String): String =
        BEARER.replace(GITHUB_TOKEN.replace(TOKEN.replace(text, "[token removed]"), "[token removed]"), "Bearer [token removed]")

    /** The context with [redactSecrets] applied to every cell (core's `contextWithoutSecrets`). */
    fun contextWithoutSecrets(context: FeedbackContextData): FeedbackContextData =
        FeedbackContextData(context.groups.map { group -> group.copy(rows = group.rows.map { row -> row.map(::redactSecrets) }) })

    /**
     * A URL's query and fragment can hold search text or codes: any scheme's (`https:`,
     * `penmoss://`, `content://`) and a path's from the root (`/notes/…?q=…`), as core's
     * `URL_TAIL`, with JavaScript's whitespace and ASCII word characters and case folding.
     */
    private val URL_TAIL = Regex(
        "((?:(?<![A-Za-z0-9_])[a-z][a-z0-9+.-]*://|(?<![A-Za-z0-9_.:/])/)[^${Js.SPACE}?#\"'<>()]*)[?#][^${Js.SPACE}\"'<>()]*",
        RegexOption.IGNORE_CASE,
    )
    private val QUOTATION = Regex("“([^”]{8,})”|\"([^\"]{8,})\"|'([^']{8,})'")

    /** Tokens, bearer credentials, email addresses and URL queries removed (core's `redactText`'s first steps). */
    fun secrets(text: String): String = URL_TAIL.replace(
        EMAIL.replace(BEARER.replace(TOKEN.replace(text, "[token removed]"), "Bearer [token removed]"), "[email removed]"),
        "$1",
    )

    /**
     * Whether [text] quotes [noteText] (core's `quotesNoteText`): any run of [QUOTE_WINDOW]
     * characters (whitespace folded, case ignored) that appears in the note, taken every 4
     * characters, or a quotation of 8 characters or more that does.
     */
    fun quotesNoteText(text: String, noteText: String): Boolean {
        if (noteText.isEmpty()) return false
        fun fold(value: String) = Js.collapseSpaces(value).lowercase()
        val haystack = fold(noteText)
        val needle = fold(text)
        for (match in QUOTATION.findAll(needle)) {
            val quoted = Js.trim(match.groupValues.drop(1).firstOrNull { it.isNotEmpty() }.orEmpty())
            if (quoted.length >= 8 && haystack.contains(quoted)) return true
        }
        if (needle.length < QUOTE_WINDOW || haystack.length < QUOTE_WINDOW) return false
        var start = 0
        while (start + QUOTE_WINDOW <= needle.length) {
            val window = needle.substring(start, start + QUOTE_WINDOW)
            if (Js.trim(window).length >= QUOTE_WINDOW / 2 && haystack.contains(window)) return true
            start += 4
        }
        return false
    }
}
