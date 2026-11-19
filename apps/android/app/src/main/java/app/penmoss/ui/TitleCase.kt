package app.penmoss.ui

/**
 * Title Case, as Penmoss writes it (A938, amended by PEN-137): core's `title-case.ts`, word for
 * word, replayed against `apps/android/contract/title-case-v1.json` by `TitleCaseTest`. Every
 * title, button, switch or row label, tab, section heading, field label, dialog title
 * (confirmation questions included) and state name. Articles, conjunctions and short prepositions
 * stay lower case unless they come first or last, or follow a colon or a dash ("Move to Folder",
 * "Keep at Most"); a verb's particle is capitalised ("Sign In with GitHub"). Words that are code
 * or a name written its own way (penmoss, MCP, GitHub, ⌘K) keep their spelling. Only full
 * sentences, hints and body copy stay in sentence case. `SettingsTitleCaseTest` and
 * `DialogTitleCaseTest` hold the phone's Settings and dialogs to it.
 */
object TitleCase {
    /** Words kept lower case in the middle of a title. */
    val SHORT_WORDS: Set<String> = linkedSetOf(
        "a", "an", "the", "and", "or", "but", "nor", "as", "at", "by", "for", "from", "in", "into", "of", "on", "per", "to", "with",
    )

    /** Verbs whose particle is capitalised: "Sign In", "Turn Off", "Back Up". */
    private val PARTICLE_VERBS = setOf("sign", "signed", "log", "logged", "turn", "turned", "set", "back", "opt", "check", "zoom")
    private val PARTICLES = setOf("in", "on", "off", "up", "out")

    /** What JavaScript's `\s` matches (Java's own `\s` is ASCII only). */
    private const val SPACE = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val TOKENS = Regex("[$SPACE]+|[^$SPACE]+")
    private val SPACES = Regex("[$SPACE]+")

    private val OPENING = Regex("^[(“\"‘'\\[]+")
    private val NOT_LETTER_FIRST = Regex("^[^\\p{L}]")
    private val UPPER = Regex("\\p{Lu}")
    private val PATH_LIKE = Regex("[./_~]")
    private val TRAILING_PUNCTUATION = Regex("[.…:,;!?)]+$")
    private val OWN_SPELLINGS = setOf("penmoss", "iOS", "macOS", "npm", "git", "pnpm")
    private val LEAD = Regex("^[^\\p{L}]*")
    private val EDGES = Regex("^[^\\p{L}\\p{N}]+|[^\\p{L}\\p{N}]+$")
    private val AFTER_COLON = Regex("[:—–]$")
    private val SHORT_SHAPE = Regex("^\\p{L}+[.…:,;!?)]*$")
    private val OPENING_QUOTE = Regex("^[“\"(]")

    private fun isSpace(token: String) = token.isEmpty() || SPACES.matches(token)

    /** A word written its own way: code, a command, a name with inner capitals, a shortcut. */
    private fun keepsSpelling(raw: String): Boolean {
        val word = raw.replace(OPENING, "")
        return NOT_LETTER_FIRST.containsMatchIn(word) || // a number, a symbol (⌘K, ~/.codex), a placeholder ({device}, $x)
            UPPER.containsMatchIn(word.drop(1)) || // GitHub, macOS, MCP, iOS
            PATH_LIKE.containsMatchIn(word.replace(TRAILING_PUNCTUATION, "")) || // config.toml, ~/.penmoss
            word in OWN_SPELLINGS
    }

    /** Each part of a hyphenated word capitalised: "Sans-Serif", "To-Do", "Wi-Fi". */
    private fun capitalise(word: String): String = word.split('-').joinToString("-") { part ->
        val lead = LEAD.find(part)!!.value
        val rest = part.substring(lead.length)
        if (rest.isEmpty()) part else lead + rest[0].uppercase() + rest.substring(1)
    }

    private fun bare(word: String): String = word.replace(EDGES, "").lowercase()

    /** [text] in Title Case. */
    fun titleCase(text: String): String {
        val words = TOKENS.findAll(text).map { it.value }.toList()
        val indices = words.indices.filter { !isSpace(words[it]) }
        val first = indices.firstOrNull()
        val last = indices.lastOrNull()
        return words.mapIndexed { index, word ->
            if (isSpace(word) || keepsSpelling(word)) return@mapIndexed word
            val position = indices.indexOf(index)
            val before = if (position > 0) words[indices[position - 1]] else ""
            val afterColon = AFTER_COLON.containsMatchIn(before) || before == "—" || before == "–"
            val key = bare(word)
            val isShort = key in SHORT_WORDS && SHORT_SHAPE.matches(word.replaceFirst(OPENING_QUOTE, ""))
            val particle = key in PARTICLES && bare(before) in PARTICLE_VERBS
            if (isShort && index != first && index != last && !afterColon && !particle) word.lowercase() else capitalise(word)
        }.joinToString("")
    }

    /** Whether [text] is in Title Case by the rule above. */
    fun isTitleCase(text: String): Boolean = titleCase(text) == text

    /** Why [text] is not in Title Case: the first word that breaks the rule, or null. */
    fun problem(text: String): String? {
        val want = titleCase(text)
        if (want == text) return null
        val have = text.split(SPACES)
        val should = want.split(SPACES)
        val index = have.indices.first { have[it] != should.getOrNull(it) }
        return "\"${have[index]}\" should be \"${should[index]}\" in \"$text\""
    }
}
