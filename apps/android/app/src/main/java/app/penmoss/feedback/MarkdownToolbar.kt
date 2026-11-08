package app.penmoss.feedback

/**
 * The description's formatting toolbar (T49, A790, A800): a native text field holds markdown,
 * and each button inserts or removes its markup around the selection, as GitHub writes it. Bold
 * `**`, italic `_`, inline code, links, code blocks, bulleted and numbered lists (nested by
 * indent and outdent) and quotes. No underline: markdown has none.
 */
object MarkdownToolbar {
    /** The field's text and its selection ([start] ≤ [end]; equal for a caret). */
    data class Edit(val text: String, val start: Int, val end: Int = start) {
        init {
            require(start in 0..end && end <= text.length) { "selection out of range" }
        }

        val selected: String get() = text.substring(start, end)
    }

    fun bold(edit: Edit) = wrap(edit, "**")

    fun italic(edit: Edit) = wrap(edit, "_")

    fun code(edit: Edit) = wrap(edit, "`")

    /**
     * Wraps the selection in [marker], or unwraps it when it is wrapped already (inside the
     * selection or just around it). A caret gets an empty pair with the caret between.
     */
    fun wrap(edit: Edit, marker: String): Edit {
        val (text, start, end) = edit
        val inner = edit.selected
        val m = marker.length
        if (inner.length >= 2 * m && inner.startsWith(marker) && inner.endsWith(marker) && !isLonger(inner, marker)) {
            val bare = inner.substring(m, inner.length - m)
            return Edit(text.substring(0, start) + bare + text.substring(end), start, start + bare.length)
        }
        val around = start >= m && end + m <= text.length && text.startsWith(marker, start - m) && text.startsWith(marker, end)
        if (around && !longerAround(text, start, end, marker)) {
            return Edit(text.substring(0, start - m) + inner + text.substring(end + m), start - m, end - m)
        }
        return Edit(text.substring(0, start) + marker + inner + marker + text.substring(end), start + m, end + m)
    }

    /** `**x**` is not italic `_…_`, nor is `` ``x`` `` a single backtick: a longer run of the marker's character. */
    private fun isLonger(inner: String, marker: String): Boolean =
        marker.length == 1 && inner.length >= 4 && inner.startsWith(marker + marker) && inner.endsWith(marker + marker)

    /** The selection sits in a longer run of a one-character marker (`` ``x`` ``): not this marker's pair. */
    private fun longerAround(text: String, start: Int, end: Int, marker: String): Boolean {
        if (marker.length != 1) return false
        val c = marker[0]
        return start >= 2 && end + 2 <= text.length && text[start - 2] == c && text[end + 1] == c
    }

    /**
     * A link: the selection becomes its text with `url` selected to type over; with nothing
     * selected, `[text](url)` with `text` selected.
     */
    fun link(edit: Edit): Edit {
        val (text, start, end) = edit
        val label = edit.selected.ifEmpty { "text" }
        val inserted = "[$label](url)"
        val next = text.substring(0, start) + inserted + text.substring(end)
        return if (edit.selected.isEmpty()) {
            Edit(next, start + 1, start + 1 + label.length)
        } else {
            val url = start + label.length + 3
            Edit(next, url, url + 3)
        }
    }

    /** A fenced code block around the selected lines, the fences on lines of their own; or an empty one. */
    fun codeBlock(edit: Edit): Edit {
        val block = lines(edit)
        val body = edit.text.substring(block.first, block.last)
        val before = edit.text.substring(0, block.first)
        val after = edit.text.substring(block.last)
        val lead = if (before.isEmpty() || before.endsWith("\n")) "" else "\n"
        val trail = if (after.isEmpty() || after.startsWith("\n")) "" else "\n"
        val inserted = "$lead```\n$body\n```$trail"
        val caret = before.length + lead.length + 4
        return Edit(before + inserted + after, caret, caret + body.length)
    }

    fun bullets(edit: Edit) = prefix(edit, ordered = false)

    fun numbered(edit: Edit) = prefix(edit, ordered = true)

    /** Quotes the selected lines with `> `, or unquotes them when every one is quoted. */
    fun quote(edit: Edit): Edit = mapLines(edit) { lines ->
        val quoted = lines.filter { it.isNotBlank() }.let { solid -> solid.isNotEmpty() && solid.all { it.startsWith(">") } }
        lines.map { line ->
            when {
                quoted -> line.removePrefix(">").removePrefix(" ")
                else -> "> $line"
            }
        }
    }

    private val LIST = Regex("^( *)([-*+]|\\d{1,9}[.)]) (.*)$")
    private val BULLET = Regex("^( *)[-*+] ")
    private val NUMBER = Regex("^( *)\\d{1,9}[.)] ")

    /** A bulleted or numbered list of the selected lines, or plain lines when they are such a list already. */
    private fun prefix(edit: Edit, ordered: Boolean): Edit = mapLines(edit) { lines ->
        val marker = if (ordered) NUMBER else BULLET
        val solid = lines.filter { it.isNotBlank() }
        val already = solid.isNotEmpty() && solid.all { marker.containsMatchIn(it) }
        var number = 0
        lines.map { line ->
            val indent = line.takeWhile { it == ' ' }
            val content = LIST.matchEntire(line)?.groupValues?.get(3) ?: line.substring(indent.length)
            when {
                already -> indent + content
                line.isBlank() && lines.size > 1 -> line
                ordered -> "$indent${++number}. $content"
                else -> "$indent- $content"
            }
        }
    }

    /**
     * Nests the selected list lines one level deeper: each moves under the list line above it, by
     * the width of that line's marker (2 for `- `, 3 for `1. `), as GitHub's markdown needs; a
     * numbered line that starts a new level becomes 1.
     */
    fun indent(edit: Edit): Edit {
        val block = lines(edit)
        val above = edit.text.substring(0, block.first).split('\n').dropLast(1)
        return mapLines(edit) { lines ->
            val out = mutableListOf<String>()
            for (line in lines) {
                val item = LIST.matchEntire(line)
                if (item == null) {
                    out += line
                    continue
                }
                val indent = item.groupValues[1].length
                val parent = (above + out).asReversed().mapNotNull(LIST::matchEntire).firstOrNull { it.groupValues[1].length <= indent }
                val width = if (parent != null && parent.groupValues[1].length == indent) parent.groupValues[2].length + 1 else 2
                val deeper = indent + width
                var marker = item.groupValues[2]
                val sibling = (above + out).asReversed().mapNotNull(LIST::matchEntire).firstOrNull { it.groupValues[1].length <= deeper }
                if (marker.first().isDigit() && (sibling == null || sibling.groupValues[1].length != deeper)) marker = "1" + marker.last()
                out += " ".repeat(deeper) + marker + " " + item.groupValues[3]
            }
            out
        }
    }

    /** Moves the selected list lines up a level: to the indent of the list line they are nested under. */
    fun outdent(edit: Edit): Edit {
        val block = lines(edit)
        val above = edit.text.substring(0, block.first).split('\n').dropLast(1)
        return mapLines(edit) { lines ->
            val out = mutableListOf<String>()
            for (line in lines) {
                val item = LIST.matchEntire(line)
                val indent = line.takeWhile { it == ' ' }.length
                if (item == null || indent == 0) {
                    out += line
                    continue
                }
                val parent = (above + out).asReversed().mapNotNull(LIST::matchEntire).firstOrNull { it.groupValues[1].length < indent }
                val shallower = parent?.groupValues?.get(1)?.length ?: maxOf(0, indent - 2)
                out += line.substring(indent - shallower)
            }
            out
        }
    }

    /** The whole lines the selection touches, as [start, end) of the text (end before its newline). */
    private fun lines(edit: Edit): IntRange {
        val (text, start, end) = edit
        val first = text.lastIndexOf('\n', start - 1) + 1
        val last = if (end > start && text[end - 1] == '\n') end - 1 else end
        val stop = text.indexOf('\n', last).let { if (it < 0) text.length else it }
        return first..maxOf(first, stop)
    }

    /**
     * Changes the selected lines. A caret on one line moves with its text; a selection covers the
     * changed lines.
     */
    private fun mapLines(edit: Edit, change: (List<String>) -> List<String>): Edit {
        val block = lines(edit)
        val old = edit.text.substring(block.first, block.last)
        val oldLines = old.split('\n')
        val newLines = change(oldLines)
        val new = newLines.joinToString("\n")
        val text = edit.text.substring(0, block.first) + new + edit.text.substring(block.last)
        if (edit.start == edit.end && oldLines.size == 1) {
            val offset = edit.start - block.first
            // The caret keeps its place in the line's text: after a marker added, at its place
            // less one removed; on an empty line, after the new marker.
            val caret = if (old.isBlank()) new.length else (offset + new.length - old.length).coerceIn(0, new.length)
            return Edit(text, block.first + caret)
        }
        return Edit(text, block.first, block.first + new.length)
    }
}

/**
 * The description's preview (T49, A800): the markdown the toolbar writes, read into blocks and
 * runs that Compose draws natively. Paragraphs, headings, bulleted and numbered lists (nested),
 * quotes and code blocks; bold, italic, inline code and links.
 */
object MarkdownPreview {
    /** A run of text with its style. */
    data class Run(val text: String, val bold: Boolean = false, val italic: Boolean = false, val code: Boolean = false, val url: String? = null)

    sealed interface Block {
        data class Paragraph(val runs: List<Run>) : Block

        data class Heading(val level: Int, val runs: List<Run>) : Block

        data class Item(val depth: Int, val marker: String, val runs: List<Run>) : Block

        data class Quote(val runs: List<Run>) : Block

        data class Code(val text: String) : Block
    }

    private val FENCE = Regex("^ {0,3}(`{3,}|~{3,})")
    private val HEADING = Regex("^ {0,3}(#{1,6}) +(.*)$")
    private val ITEM = Regex("^( *)([-*+]|\\d{1,9}[.)]) +(.*)$")
    private val QUOTE = Regex("^ {0,3}> ?(.*)$")

    fun blocks(markdown: String): List<Block> {
        val out = mutableListOf<Block>()
        val lines = markdown.replace("\r\n", "\n").split('\n')
        var index = 0
        val paragraph = mutableListOf<String>()
        val quote = mutableListOf<String>()
        val indents = ArrayDeque<Int>()
        fun flush() {
            if (paragraph.isNotEmpty()) out += Block.Paragraph(runs(paragraph.joinToString(" ") { it.trim() }))
            paragraph.clear()
            if (quote.isNotEmpty()) out += Block.Quote(runs(quote.joinToString(" ") { it.trim() }))
            quote.clear()
        }
        while (index < lines.size) {
            val line = lines[index]
            val fence = FENCE.find(line)
            when {
                fence != null -> {
                    flush()
                    indents.clear()
                    val mark = fence.groupValues[1]
                    val body = mutableListOf<String>()
                    index++
                    while (index < lines.size && !lines[index].trimStart().startsWith(mark)) body += lines[index++]
                    out += Block.Code(body.joinToString("\n"))
                }
                line.isBlank() -> {
                    flush()
                    indents.clear()
                }
                HEADING.matches(line) -> {
                    flush()
                    val heading = HEADING.matchEntire(line)!!
                    out += Block.Heading(heading.groupValues[1].length, runs(heading.groupValues[2].trimEnd('#', ' ')))
                }
                ITEM.matches(line) -> {
                    flush()
                    val item = ITEM.matchEntire(line)!!
                    val indent = item.groupValues[1].length
                    while (indents.isNotEmpty() && indents.last() >= indent) indents.removeLast()
                    val depth = indents.size
                    indents.addLast(indent)
                    val marker = item.groupValues[2].let { if (it.first().isDigit()) "${it.dropLast(1)}." else "•" }
                    out += Block.Item(depth, marker, runs(item.groupValues[3]))
                }
                QUOTE.matches(line) -> {
                    if (paragraph.isNotEmpty()) flush()
                    quote += QUOTE.matchEntire(line)!!.groupValues[1]
                }
                else -> {
                    if (quote.isNotEmpty()) flush()
                    paragraph += line
                }
            }
            index++
        }
        flush()
        return out
    }

    /** Inline markdown as runs: `code`, **bold** or __bold__, _italic_ or *italic*, [text](url). */
    fun runs(text: String, bold: Boolean = false, italic: Boolean = false): List<Run> {
        val out = mutableListOf<Run>()
        val plain = StringBuilder()
        fun flushPlain() {
            if (plain.isNotEmpty()) out += Run(plain.toString(), bold = bold, italic = italic)
            plain.clear()
        }
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '\\' && i + 1 < text.length && text[i + 1] in "\\`*_[]()#>-+.!") {
                plain.append(text[i + 1])
                i += 2
                continue
            }
            if (c == '`') {
                val close = text.indexOf('`', i + 1)
                if (close > i) {
                    flushPlain()
                    out += Run(text.substring(i + 1, close), bold = bold, italic = italic, code = true)
                    i = close + 1
                    continue
                }
            }
            if (c == '[') {
                val link = Regex("^\\[([^\\]]*)]\\(([^)\\s]+)\\)").find(text.substring(i))
                if (link != null) {
                    flushPlain()
                    out += runs(link.groupValues[1], bold, italic).map { it.copy(url = link.groupValues[2]) }
                    i += link.value.length
                    continue
                }
            }
            if ((c == '*' || c == '_') && text.startsWith("$c$c", i)) {
                val close = text.indexOf("$c$c", i + 2)
                if (close > i + 2) {
                    flushPlain()
                    out += runs(text.substring(i + 2, close), bold = true, italic = italic)
                    i = close + 2
                    continue
                }
            }
            if (c == '*' || c == '_') {
                val close = text.indexOf(c, i + 1)
                if (close > i + 1 && !text.startsWith("$c$c", close)) {
                    flushPlain()
                    out += runs(text.substring(i + 1, close), bold = bold, italic = true)
                    i = close + 1
                    continue
                }
            }
            plain.append(c)
            i++
        }
        flushPlain()
        return out
    }
}
