package app.penmoss.ui

import app.penmoss.analytics.ControlScan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every dialog's title is in Title Case (PEN-137, AC45; A938 as amended): each `AlertDialog`'s
 * `title` in the app's sources, confirmation questions included ("Discard This Draft?", "Delete
 * “X” for Good?"). A title written as a string is read from the source; a placeholder in it
 * (`$name`, `${…}`) stands for a name, which keeps its own spelling. A failure names the file and
 * line, and the word that breaks the rule.
 */
class DialogTitleCaseTest {
    private val sources = File("src/main/java")

    private val dialog = Regex("(?<![\\w.])(?:[a-z][a-z0-9_]*\\.)*(AlertDialog|BasicAlertDialog)\\s*\\(")
    private val title = Regex("\\btitle\\s*=\\s*")
    private val name = Regex("\\$[A-Za-z_][A-Za-z0-9_]*")

    /** [text] with each placeholder (`${…}`, its braces balanced, or `$name`) as X. */
    private fun placeheld(text: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < text.length) {
            if (text.startsWith("\${", i)) {
                var depth = 0
                var j = i + 1
                while (j < text.length) {
                    if (text[j] == '{') depth++
                    if (text[j] == '}' && --depth == 0) break
                    j++
                }
                out.append('X')
                i = j + 1
            } else {
                out.append(text[i++])
            }
        }
        return out.toString().replace(name, "X")
    }

    /** Each dialog's title strings, with where each is. */
    private fun titles(): List<Pair<String, String>> {
        val found = ArrayList<Pair<String, String>>()
        for (file in sources.walkTopDown().filter { it.isFile && it.extension == "kt" }.sortedBy { it.path }) {
            val text = file.readText()
            val source = ControlScan.Source(text)
            for (match in dialog.findAll(text)) {
                if (!source.code(match.range.first)) continue
                val close = source.close(match.range.last) ?: continue
                val args = match.range.last + 1
                val at = title.findAll(text.substring(args, close)).firstOrNull { source.code(args + it.range.first) } ?: continue
                val from = args + at.range.last + 1
                val expression = source.argument(from)
                for ((where, literal) in source.literals(from, from + expression.length)) {
                    found += "${file.relativeTo(sources).path}:${source.line(where)}" to placeheld(literal)
                }
            }
        }
        return found
    }

    @Test
    fun everyDialogTitleIsInTitleCase() {
        val all = titles()
        assertTrue("Only ${all.size} dialog titles found", all.size >= 15)
        val wrong = all.mapNotNull { (where, text) -> TitleCase.problem(text)?.let { "$where: $it" } }
        assertEquals("Dialog titles not in Title Case:\n" + wrong.joinToString("\n"), emptyList<String>(), wrong)
    }
}
