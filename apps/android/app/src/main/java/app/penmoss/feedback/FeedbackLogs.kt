package app.penmoss.feedback

import java.util.Locale

/**
 * The logs a bug report attaches (PEN-137, Logs in Send Feedback), as core's `log-block.ts` writes
 * them: a collapsed "Anonymised Logs" block in a fence no line can close, cut from the oldest line
 * so the issue's body stays inside the Linear intake's 60,000 characters. Byte for byte what
 * core writes (`FeedbackMarkdownTest` and `FeedbackLogsBlockTest`).
 */
object FeedbackLogs {
    const val BLOCK_TITLE = "Anonymised Logs"

    /** The Linear intake's body limit (`.github/scripts/linear-intake.mjs`). */
    const val INTAKE_BODY_LIMIT = 60_000

    /** The most lines and bytes a payload may carry (the largest limits: 2,000 lines, 40 KB, with room for scrubbing). */
    const val MAX_LINES = 2_000
    const val MAX_BYTES = 64 * 1024

    /** The byte size of the attached text, as the form writes it. */
    fun textBytes(lines: List<String>): Int = lines.joinToString("\n").toByteArray().size

    /** "9.6 KB": the size the form's summary shows (core's `formatReportSize`). */
    fun formatReportSize(bytes: Int): String {
        if (bytes < 1024) return "$bytes B"
        val kb = bytes / 1024.0
        return if (kb < 10) "${"%.1f".format(Locale.US, kb)} KB" else "${Math.round(kb)} KB"
    }

    /** A fence longer than any run of backticks in [text], three at least. */
    private fun fence(text: String): String {
        val longest = maxOf(2, Regex("`+").findAll(text).maxOfOrNull { it.value.length } ?: 0)
        return "`".repeat(longest + 1)
    }

    /** The issue's collapsed block for [lines], or "" when there are none. */
    fun block(lines: List<String>): String {
        if (lines.isEmpty()) return ""
        val text = lines.joinToString("\n")
        val mark = fence(text)
        val noun = if (lines.size == 1) "line" else "lines"
        return listOf(
            "<details>",
            "<summary>$BLOCK_TITLE (${lines.size} $noun)</summary>",
            "",
            "${mark}text",
            text,
            mark,
            "",
            "</details>",
        ).joinToString("\n")
    }

    /** The lines that fit when the rest of the body is [others] characters long: the oldest go first. */
    fun fit(lines: List<String>, others: Int, limit: Int = INTAKE_BODY_LIMIT): List<String> {
        val room = limit - others - 400
        var from = 0
        while (from < lines.size && block(lines.subList(from, lines.size)).length + 2 > room) {
            // Many lines over: drop them in bulk first, then one at a time, as core's loop ends.
            val over = block(lines.subList(from, lines.size)).length + 2 - room
            from += if (over > 4096) maxOf(1, (lines.size - from) / 8) else 1
        }
        if (from > 0) {
            // Bulk drops may overshoot: give back the newest-but-dropped lines while they fit.
            while (from > 0 && block(lines.subList(from - 1, lines.size)).length + 2 <= room) from--
        }
        return lines.subList(from, lines.size).toList()
    }
}
