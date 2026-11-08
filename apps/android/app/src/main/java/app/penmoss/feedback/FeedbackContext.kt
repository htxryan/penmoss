package app.penmoss.feedback

import kotlinx.serialization.Serializable

/*
 * In-app feedback's shared rules on Android (T49, D41, A791, A794): the captured context's six
 * groups and the markdown the issue holds for them, ported from core's `feedback.ts` so the form
 * previews exactly what is sent. `FeedbackMarkdownTest` checks this against
 * `apps/android/contract/feedback-v1.json`, which core writes.
 */

/** The groups, in the order the issue lists them. */
enum class FeedbackGroupId(val wire: String, val title: String) {
    APP("app", "App"),
    WHERE("where", "Where you are"),
    SYNC("sync", "Sync"),
    NOTE("note", "This note"),
    EDITS("edits", "Recent edits to this note"),
    ERRORS("errors", "Recent errors"),
    ;

    companion object {
        fun of(wire: String): FeedbackGroupId? = entries.firstOrNull { it.wire == wire }
    }
}

/** A group: a small table of strings (core's `FeedbackGroup`). */
@Serializable
data class FeedbackGroup(val id: String, val columns: List<String>, val rows: List<List<String>>) {
    val group: FeedbackGroupId? get() = FeedbackGroupId.of(id)
}

/** What the payload's `context` holds: the groups left in, in [FeedbackGroupId] order. */
@Serializable
data class FeedbackContextData(val groups: List<FeedbackGroup> = emptyList()) {
    /** The context without the groups the person left out (the form's per-group checkboxes). */
    fun without(omitted: Set<String>): FeedbackContextData = FeedbackContextData(groups.filterNot { it.id in omitted })
}

/** The limits every client and the Worker share (A792), as core's FEEDBACK_LIMITS. */
object FeedbackLimits {
    const val TITLE_MAX = 256
    const val DESCRIPTION_MAX = 20_000
    const val VERSION_MAX = 80
    const val SCREENSHOTS = 6
    const val SCREENSHOT_BYTES = 10L * 1024 * 1024
    const val REQUEST_BYTES = 40L * 1024 * 1024
    const val LONG_SIDE = 2560
    const val JPEG_QUALITY = 85
    const val GROUP_ROWS = 40
    const val CELL = 400
    const val RECENT = 10
}

enum class FeedbackType(val wire: String, val label: String) {
    BUG("bug", "Bug report"),
    FEATURE("feature", "Feature request"),
    ;

    companion object {
        fun of(wire: String?): FeedbackType? = entries.firstOrNull { it.wire == wire }
    }
}

/** How the form names each priority (P1 Highest … P4 Lowest). */
object FeedbackPriority {
    val all = listOf(1, 2, 3, 4)

    fun label(priority: Int): String = when (priority) {
        1 -> "P1 Highest"
        2 -> "P2 High"
        3 -> "P3 Normal"
        4 -> "P4 Lowest"
        else -> "P$priority"
    }
}

/** The labels an issue gets (A794): the feedback label, its type and its priority. */
fun feedbackLabels(type: FeedbackType, priority: Int): List<String> =
    listOf("in-app feedback", if (type == FeedbackType.BUG) "bug" else "feature request", "P$priority")

/** A group of named values' columns. */
val FIELD_COLUMNS = listOf("Field", "Value")

/** The recent-edits table's columns (group 5). */
val EDIT_COLUMNS = listOf("Time", "Actor", "Kind", "Change")

/** The recent-errors table's columns (group 6). */
val ERROR_COLUMNS = listOf("Time", "Message", "Stack")

/**
 * A group of named values; a value of null is left out, a boolean is yes or no (core's
 * `fieldGroup`). Each value is clipped to a cell, and at most [FeedbackLimits.GROUP_ROWS] rows kept.
 */
fun fieldGroup(id: FeedbackGroupId, fields: List<Pair<String, Any?>>): FeedbackGroup {
    val rows = fields.mapNotNull { (name, value) ->
        val text = when (value) {
            null -> return@mapNotNull null
            is Boolean -> if (value) "yes" else "no"
            else -> value.toString()
        }
        listOf(clipCell(name), clipCell(text))
    }
    return FeedbackGroup(id.wire, FIELD_COLUMNS, rows.take(FeedbackLimits.GROUP_ROWS))
}

/** A table group, its cells clipped and its rows limited. */
fun tableGroup(id: FeedbackGroupId, columns: List<String>, rows: List<List<String>>): FeedbackGroup =
    FeedbackGroup(id.wire, columns, rows.take(FeedbackLimits.GROUP_ROWS).map { row -> columns.indices.map { clipCell(row.getOrElse(it) { "" }) } })

/** The longest a cell may be, cut with "…" (never half a surrogate pair), as core's `clipCell`. */
fun clipCell(value: String, max: Int = FeedbackLimits.CELL): String {
    if (value.length <= max) return value
    var cut = value.substring(0, max - 1)
    if (cut.isNotEmpty() && Character.isHighSurrogate(cut.last())) cut = cut.dropLast(1)
    return "$cut…"
}

/**
 * The captured context as markdown, byte for byte what core's `contextMarkdown` writes (A794):
 * a `<details>` block with a table per group, then a fenced JSON copy. Empty with no groups.
 */
object FeedbackMarkdown {
    fun context(context: FeedbackContextData): String {
        if (context.groups.isEmpty()) return ""
        val parts = mutableListOf("<details><summary>Captured context</summary>")
        for (group in context.groups) {
            parts += "#### ${group.group?.title ?: group.id}"
            parts += if (group.rows.isEmpty()) "_None_" else table(group.columns, group.rows)
        }
        val json = Js.stringify(json(context))
        val fence = fenceFor(json)
        parts += "${fence}json\n$json\n$fence"
        parts += "</details>"
        return parts.joinToString("\n\n")
    }

    /**
     * The issue's body as the Worker writes it (core's `feedbackIssueBody`): the description,
     * the screenshots, the context, then the footer. For the contract test: the phone never
     * writes the body, but its context part must match.
     */
    fun issueBody(
        description: String,
        screenshots: List<Pair<String, String>>,
        context: FeedbackContextData,
        client: String,
        version: String,
        submissionId: String,
    ): String {
        val parts = mutableListOf<String>()
        val trimmed = Js.trim(description)
        if (trimmed.isNotEmpty()) parts += trimmed
        if (screenshots.isNotEmpty()) {
            parts += screenshots.joinToString("\n\n") { (name, url) -> "![${name.replace(Regex("[\\[\\]\\n]"), "")}]($url)" }
        }
        val markdown = context(context)
        if (markdown.isNotEmpty()) parts += markdown
        val shown = footerVersion(version)
        val name = when (client) {
            "web" -> "web"
            "mac" -> "Mac"
            "android" -> "Android"
            else -> client
        }
        parts += "Sent from Penmoss $name $shown · submission $submissionId"
        return "${parts.joinToString("\n\n")}\n"
    }

    private fun isFieldGroup(group: FeedbackGroup) = group.columns == FIELD_COLUMNS

    /** A table cell: one line, its pipes escaped, no HTML; a dash when empty. */
    internal fun cell(value: String): String {
        val flat = Js.trim(Js.collapseSpaces(value))
        if (flat.isEmpty()) return "—"
        return inertReferences(flat.replace("\\", "\\\\").replace("|", "\\|").replace("<", "&lt;"))
    }

    private val MENTION = Regex("@(?=[\\p{L}\\p{N}_])")
    private val ISSUE = Regex("#(?=[0-9])")
    private val CROSS = Regex("(?<![A-Za-z0-9_])GH-(?=[0-9])")
    private val NOT_VERSION = Regex("[^A-Za-z0-9 ._()+:-]")
    private val RUNS = Regex(" +")

    /**
     * Text GitHub would turn into a mention or a cross-reference (`@ryan`, `#100`, `GH-12`) made
     * inert with a zero-width joiner after the sign, as core's `inertReferences`. Table cells only.
     */
    fun inertReferences(text: String): String =
        CROSS.replace(ISSUE.replace(MENTION.replace(text, "@\u200d"), "#\u200d"), "GH\u200d-")

    /**
     * A client's version as the footer shows it (core's `footerVersion`): letters, digits,
     * spaces and `. _ ( ) + : -` only, one line, at most [FeedbackLimits.VERSION_MAX]
     * characters; `unknown` when nothing is left.
     */
    fun footerVersion(version: String): String {
        val kept = NOT_VERSION.replace(version, "")
        val safe = RUNS.replace(kept, " ").trim(' ').take(FeedbackLimits.VERSION_MAX).trim(' ')
        return safe.ifEmpty { "unknown" }
    }

    private fun table(columns: List<String>, rows: List<List<String>>): String {
        fun line(cells: List<String>) = "| ${cells.joinToString(" | ") { cell(it) }} |"
        return (listOf(line(columns), "| ${columns.joinToString(" | ") { "---" }} |") + rows.map { row -> line(columns.indices.map { row.getOrElse(it) { "" } }) })
            .joinToString("\n")
    }

    /** The context as JSON for agents: a group of named values as an object, a table as a list. */
    internal fun json(context: FeedbackContextData): Js.Obj {
        val out = Js.Obj()
        for (group in context.groups) {
            out[group.id] = if (isFieldGroup(group)) {
                Js.Obj().also { obj -> for (row in group.rows) obj[row.getOrElse(0) { "" }] = row.getOrElse(1) { "" } }
            } else {
                group.rows.map { row -> Js.Obj().also { obj -> group.columns.forEachIndexed { index, column -> obj[column] = row.getOrElse(index) { "" } } } }
            }
        }
        return out
    }

    /** A code fence longer than any run of backticks in [text]. */
    private fun fenceFor(text: String): String {
        val longest = Regex("`+").findAll(text).maxOfOrNull { it.value.length } ?: 0
        return "`".repeat(maxOf(3, longest + 1))
    }
}

/** The few JavaScript behaviours the markdown must match exactly. */
object Js {
    /**
     * JavaScript's whitespace and line terminators: what `\s` and `String.prototype.trim` take
     * (Kotlin's `\s` and `trim()` take other sets).
     */
    internal const val SPACE = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val SPACES = Regex("[$SPACE]+")
    private val EDGES = Regex("^[$SPACE]+|[$SPACE]+$")

    /** `text.replace(/\s+/g, ' ')`. */
    fun collapseSpaces(text: String): String = SPACES.replace(text, " ")

    /** `text.trim()`. */
    fun trim(text: String): String = EDGES.replace(text, "")

    /** A JavaScript object: its keys in the order JavaScript gives them (integer keys first). */
    class Obj {
        private val values = LinkedHashMap<String, Any>()

        operator fun set(key: String, value: Any) {
            values[key] = value
        }

        val entries: List<Pair<String, Any>>
            get() {
                val (indices, others) = values.keys.partition(::isIndex)
                return (indices.sortedBy { it.toLong() } + others).map { it to values.getValue(it) }
            }

        /** An array index as JavaScript orders it: a canonical integer below 2³² − 1. */
        private fun isIndex(key: String): Boolean =
            key.isNotEmpty() && key.length <= 10 && key.all(Char::isDigit) && (key == "0" || key[0] != '0') && key.toLong() < 4_294_967_295L
    }

    /** `JSON.stringify(value, null, 2)` for objects, lists and strings. */
    fun stringify(value: Any): String = StringBuilder().also { write(it, value, "") }.toString()

    private fun write(out: StringBuilder, value: Any, indent: String) {
        when (value) {
            is String -> quote(out, value)
            is Obj -> {
                val entries = value.entries
                if (entries.isEmpty()) {
                    out.append("{}")
                    return
                }
                val inner = "$indent  "
                out.append("{\n")
                entries.forEachIndexed { index, (key, item) ->
                    out.append(inner)
                    quote(out, key)
                    out.append(": ")
                    write(out, item, inner)
                    if (index < entries.size - 1) out.append(',')
                    out.append('\n')
                }
                out.append(indent).append('}')
            }
            is List<*> -> {
                if (value.isEmpty()) {
                    out.append("[]")
                    return
                }
                val inner = "$indent  "
                out.append("[\n")
                value.forEachIndexed { index, item ->
                    out.append(inner)
                    write(out, item ?: "", inner)
                    if (index < value.size - 1) out.append(',')
                    out.append('\n')
                }
                out.append(indent).append(']')
            }
            else -> quote(out, value.toString())
        }
    }

    /** JSON.stringify's string quoting: escapes, other controls and lone surrogates as `\u00xx`. */
    private fun quote(out: StringBuilder, text: String) {
        out.append('"')
        var index = 0
        while (index < text.length) {
            val char = text[index]
            when {
                char == '"' -> out.append("\\\"")
                char == '\\' -> out.append("\\\\")
                char == '\b' -> out.append("\\b")
                char == '\u000C' -> out.append("\\f")
                char == '\n' -> out.append("\\n")
                char == '\r' -> out.append("\\r")
                char == '\t' -> out.append("\\t")
                char < ' ' -> out.append("\\u").append("%04x".format(char.code))
                Character.isHighSurrogate(char) && index + 1 < text.length && Character.isLowSurrogate(text[index + 1]) -> {
                    out.append(char).append(text[index + 1])
                    index++
                }
                Character.isSurrogate(char) -> out.append("\\u").append("%04x".format(char.code))
                else -> out.append(char)
            }
            index++
        }
        out.append('"')
    }
}
