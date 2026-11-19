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

    // --- The log scrubber (PEN-137): core's `scrub.ts`, line for line ---

    /**
     * What a scrubber knows to replace beyond its patterns (core's `ScrubKnown`): the GitHub login,
     * the notebooks' names, their repositories (URLs or `owner/name`) and branches, and, for scrub
     * #2, note titles and folder, tag and attachment names.
     */
    data class Known(
        val login: String? = null,
        val notebooks: List<String> = emptyList(),
        val repositories: List<String> = emptyList(),
        val branches: List<String> = emptyList(),
        val names: List<String> = emptyList(),
    ) {
        /** These, and [more] names besides (scrub #2). */
        fun withNames(more: Collection<String>) = copy(names = names + more)
    }

    /** The shortest name scrubbed as a known name; shorter ones would eat ordinary words. */
    const val MIN_KNOWN_NAME = 3

    /** One scrubber: it numbers what it replaces consistently (`‹repo-N›`, `‹id-N›`). */
    interface LineScrubber {
        /** One line, scrubbed. */
        fun line(text: String): String

        /** Many lines (a whole report), scrubbed. */
        fun text(text: String): String = text.split(Regex("\r?\n")).joinToString("\n") { line(it) }
    }

    /** One line scrubbed (a fresh scrubber, so numbering starts at 1): core's `scrubLogLine`. */
    fun line(text: String, known: Known = Known()): String = scrubber(known).line(text)

    /*
     * JavaScript's regular expressions, spelt out so the JVM's and Android's (ICU) read them the
     * same: `\b`, `\s` and `\w` as JavaScript means them without the `u` flag.
     */
    private const val W = "A-Za-z0-9_"
    private const val B = "(?:(?<=[$W])(?![$W])|(?<![$W])(?=[$W]))"
    private const val S = Js.SPACE

    /** JavaScript's `i` without `u`: ASCII case only (Kotlin's IGNORE_CASE folds Unicode too). */
    private fun ci(pattern: String): Regex = java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.CASE_INSENSITIVE).toRegex()

    private val TOKENS = listOf(
        Regex("$B(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{20,})$B"),
        Regex("${B}pm_[A-Za-z0-9_-]{16,}$B"),
        Regex("$B(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}$B"),
        Regex("${B}xox[abprs]-[A-Za-z0-9-]{10,}$B"),
        Regex("${B}AKIA[0-9A-Z]{16}$B"),
        Regex("${B}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}$B"),
    )
    private val BEARER = ci("$B(Bearer|Basic|token)[$S]+[A-Za-z0-9._~+/=-]{8,}")
    private val KEY_VALUE = ci(
        "$B(password|passwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|private[_-]?key)" +
            "([\"']?[$S]*[:=][$S]*[\"']?)(?!‹|(?:Bearer|Basic|token)[$S])[^$S\"',;&]+",
    )
    private val PEM = Regex("-----BEGIN [A-Z ]+-----[\\s\\S]*?(?:-----END [A-Z ]+-----|\\z)")
    private val EMAIL = Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
    private val SSH_REPO = Regex("$B(?:ssh://)?[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+[:/][A-Za-z0-9_.~/-]*[A-Za-z0-9_~/-]")
    private val URL = Regex("$B(https?|git|file)://[^$S\"'<>()\\[\\]{}]+")
    private val LOG_QUOTED = Regex("\"[^\"\\n]{1,400}\"|“[^”\\n]{1,400}”|‘[^’\\n]{1,400}’|'[^'\\n]{1,400}'|`[^`\\n]{1,400}`")
    private const val PATH_END = "[^$S\"'<>|:;,)\\]}]"
    private val PATH = Regex(
        "(?:~|\\\$HOME|%USERPROFILE%)(?:[/\\\\]$PATH_END*)?" +
            "|(?<![$W./])/(?:Users|home|private|var|tmp|Volumes|opt|data|storage|sdcard|mnt|etc|root|Library|Applications|System|usr)(?:/$PATH_END*)*" +
            "|$B[A-Za-z]:\\\\$PATH_END*",
    )

    /**
     * A path with spaces (`/Users/a/My Notes/b c.md`), as core's `pathEnd`: [PATH] stops at the
     * first space, so the words after it are read on, [PATH_SPACE_WORDS] at a time, while the path
     * so far has no file extension. The first word that holds a `/` or `\` or ends in an extension
     * ends the stretch taken, with every word before it; a word that starts another path stops it.
     */
    private const val PATH_SPACE_WORDS = 3
    private val PATH_WORDS = Regex("^(?: [^$S\"'<>|:;,)\\]}]+){1,$PATH_SPACE_WORDS}")
    private val PATH_START = Regex("^(?:[/\\\\~]|\\\$HOME|%USERPROFILE%|[A-Za-z]:\\\\)")
    private val EXTENSION = Regex("\\.[A-Za-z][A-Za-z0-9]{0,7}$")
    private val SEPARATOR = Regex("[/\\\\]")

    /** Where the path [PATH] found at [start]..<[end] really ends, its spaced words read on. */
    private fun pathEnd(text: String, start: Int, end: Int): Int {
        var at = end
        while (!EXTENSION.containsMatchIn(text.substring(start, at))) {
            val words = PATH_WORDS.find(text.substring(at))?.value?.substring(1)?.split(' ').orEmpty()
            var taken = -1
            for ((index, word) in words.withIndex()) {
                if (PATH_START.containsMatchIn(word)) break
                if (SEPARATOR.containsMatchIn(word) || EXTENSION.containsMatchIn(word)) {
                    taken = index
                    break
                }
            }
            if (taken < 0) break
            at += words.take(taken + 1).sumOf { it.length + 1 }
        }
        return at
    }

    /** Every path in [text] → ‹path›, with its spaced words ([pathEnd]). */
    private fun replacePaths(text: String): String {
        val out = StringBuilder()
        var from = 0
        for (match in PATH.findAll(text)) {
            val start = match.range.first
            if (start < from) continue
            out.append(text, from, start).append("‹path›")
            from = pathEnd(text, start, match.range.last + 1)
        }
        return out.append(text, from, text.length).toString()
    }

    private val ULID = ci("$B[0-7][0-9A-HJKMNP-TV-Z]{25}$B")
    private val UUID = Regex("$B[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$B")
    private val HEX_ID = ci("$B(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{12,}$B")
    private val CODE_HOST = ci("(^|\\.)(github\\.com|gitlab\\.com|bitbucket\\.org|codeberg\\.org)$")
    private val DOT_GIT = ci("\\.git$")

    /** A name as a whole word, any case (JavaScript's `iu`: Kotlin's IGNORE_CASE folds Unicode). */
    private fun wholeWord(name: String): Regex =
        Regex("(?<![\\p{L}\\p{N}_])${Regex.escape(name)}(?![\\p{L}\\p{N}_])", RegexOption.IGNORE_CASE)

    private fun repoKey(value: String): String = value.lowercase(java.util.Locale.ROOT)
        .replaceFirst(Regex("^(?:https?|git|ssh)://(?:[^@/]+@)?"), "")
        .replaceFirst(Regex("^[^@]+@"), "")
        .replaceFirst(":", "/")
        .replaceFirst(Regex("\\.git$"), "")
        .replaceFirst(Regex("/+$"), "")

    /** A scrubber that numbers what it replaces consistently (core's `createScrubber`). */
    fun scrubber(known: Known = Known()): LineScrubber {
        val repos = HashMap<String, Int>()
        val ids = HashMap<String, Int>()
        fun repoLabel(value: String): String = "‹repo-${repos.getOrPut(repoKey(value)) { repos.size + 1 }}›"
        fun idLabel(value: String): String = "‹id-${ids.getOrPut(value.lowercase(java.util.Locale.ROOT)) { ids.size + 1 }}›"
        fun usableNames(values: List<String?>) =
            values.map { Js.trim(it.orEmpty()) }.distinct().filter { it.length >= MIN_KNOWN_NAME }.sortedByDescending { it.length }
        val repositories = usableNames(known.repositories)
        val repoNames = repositories.map { repoKey(it).split('/').takeLast(2).joinToString("/") }
        val repoOwners = repositories.mapNotNull { repoKey(it).split('/').takeLast(2).firstOrNull() }.filter { it.length >= MIN_KNOWN_NAME }
        val repoBare = repositories.mapNotNull { repoKey(it).split('/').lastOrNull() }.filter { it.length >= MIN_KNOWN_NAME }
        val notebooks = usableNames(known.notebooks)
        val branches = usableNames(known.branches).filter { it.lowercase(java.util.Locale.ROOT) !in setOf("main", "master") }
        val login = usableNames(listOf(known.login))
        val names = usableNames(known.names)
        val notebookNumber = notebooks.mapIndexed { index, name -> name.lowercase(java.util.Locale.ROOT) to index + 1 }.toMap()
        val patterns: List<Pair<Regex, (String) -> String>> =
            repoNames.distinct().filter { '/' in it }.map { wholeWord(it) to { match: String -> repoLabel(match) } } +
                notebooks.map { wholeWord(it) to { match: String -> "‹notebook-${notebookNumber[match.lowercase(java.util.Locale.ROOT)] ?: 0}›" } } +
                login.map { wholeWord(it) to { _: String -> "‹login›" } } +
                (repoOwners + repoBare).distinct().map { wholeWord(it) to { _: String -> "‹repo›" } } +
                branches.map { wholeWord(it) to { _: String -> "‹branch›" } } +
                names.map { wholeWord(it) to { _: String -> "‹name›" } }

        return object : LineScrubber {
            override fun line(text: String): String {
                var out = text.replace(Regex("[\r\n]+"), " ")
                out = PEM.replace(out) { "‹token›" }
                for (pattern in TOKENS) out = pattern.replace(out) { "‹token›" }
                out = BEARER.replace(out) { "${it.groupValues[1]} ‹token›" }
                out = KEY_VALUE.replace(out) { "${it.groupValues[1]}${it.groupValues[2]}‹token›" }
                out = URL.replace(out) { match ->
                    val scheme = match.groupValues[1]
                    val rest = match.value.substring(scheme.length + 3)
                    if (scheme == "file") return@replace "‹path›"
                    val hostEnd = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }
                    val authority = if (hostEnd == -1) rest else rest.substring(0, hostEnd)
                    val host = authority.replaceFirst(Regex("^[^@]*@"), "")
                    val path = if (hostEnd == -1) "" else rest.substring(hostEnd)
                    val segments = path.split('?', '#')[0].split('/').filter { it.isNotEmpty() }
                    if (scheme == "git" || DOT_GIT.containsMatchIn(segments.lastOrNull().orEmpty()) || (CODE_HOST.containsMatchIn(host) && segments.size >= 2)) {
                        repoLabel("$host/${segments.take(2).joinToString("/")}")
                    } else if (segments.isNotEmpty()) {
                        "$scheme://$host/‹path›"
                    } else {
                        "$scheme://$host"
                    }
                }
                out = SSH_REPO.replace(out) { if ('@' in it.value) repoLabel(it.value) else it.value }
                out = EMAIL.replace(out) { "‹email›" }
                for ((pattern, replace) in patterns) out = pattern.replace(out) { replace(it.value) }
                out = replacePaths(out)
                out = LOG_QUOTED.replace(out) { "‹text›" }
                out = UUID.replace(out) { idLabel(it.value) }
                out = ULID.replace(out) { idLabel(it.value) }
                out = HEX_ID.replace(out) { idLabel(it.value) }
                return out
            }
        }
    }
}
