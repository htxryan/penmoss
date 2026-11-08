package app.penmoss.feedback

import app.penmoss.feedback.MarkdownPreview.Block
import app.penmoss.feedback.MarkdownPreview.Run
import app.penmoss.feedback.MarkdownToolbar.Edit
import org.junit.Assert.assertEquals
import org.junit.Test

/** The description's toolbar writes GitHub markdown around the selection, and the preview reads it back (T49, A800). */
class MarkdownToolbarTest {
    /** [text] with `[` and `]` marking the selection (a lone `|` for a caret). */
    private fun edit(marked: String): Edit {
        if ('|' in marked) return Edit(marked.replace("|", ""), marked.indexOf('|'))
        val start = marked.indexOf('[')
        val end = marked.indexOf(']') - 1
        return Edit(marked.replace("[", "").replace("]", ""), start, end)
    }

    private fun shown(edit: Edit) =
        if (edit.start == edit.end) edit.text.substring(0, edit.start) + "|" + edit.text.substring(edit.start)
        else edit.text.substring(0, edit.start) + "[" + edit.selected + "]" + edit.text.substring(edit.end)

    @Test
    fun boldItalicAndCodeWrapTheSelectionAndUnwrapIt() {
        assertEquals("It **[broke]** today", shown(MarkdownToolbar.bold(edit("It [broke] today"))))
        assertEquals("It [broke] today", shown(MarkdownToolbar.bold(edit("It **[broke]** today"))))
        assertEquals("It [broke] today", shown(MarkdownToolbar.bold(edit("It [**broke**] today"))))
        assertEquals("It _[broke]_", shown(MarkdownToolbar.italic(edit("It [broke]"))))
        assertEquals("Run `[task]`", shown(MarkdownToolbar.code(edit("Run [task]"))))
        // A caret gets an empty pair with the caret inside, to type into.
        assertEquals("a **|** b", shown(MarkdownToolbar.bold(edit("a | b"))))
        assertEquals("_|_", shown(MarkdownToolbar.italic(edit("|"))))
        // Italic inside bold is added, not taken for bold's markers.
        assertEquals("**_[x]_**", shown(MarkdownToolbar.italic(edit("**[x]**"))))
    }

    @Test
    fun aLinkSelectsWhatIsLeftToType() {
        assertEquals("See [docs]([url])", shown(MarkdownToolbar.link(edit("See [docs]"))))
        assertEquals("See [[text]](url)", shown(MarkdownToolbar.link(edit("See |"))))
    }

    @Test
    fun listsAndQuotesPrefixEachSelectedLineAndToggleOff() {
        assertEquals("[- one\n- two]", shown(MarkdownToolbar.bullets(edit("[one\ntwo]"))))
        assertEquals("[one\ntwo]", shown(MarkdownToolbar.bullets(edit("[- one\n- two]"))))
        assertEquals("[1. first\n2. second\n3. third]", shown(MarkdownToolbar.numbered(edit("[first\nsecond\nthird]"))))
        // A bulleted list becomes numbered in one tap.
        assertEquals("[1. one\n2. two]", shown(MarkdownToolbar.numbered(edit("[- one\n- two]"))))
        assertEquals("[> said\n> this]", shown(MarkdownToolbar.quote(edit("[said\nthis]"))))
        assertEquals("[said\nthis]", shown(MarkdownToolbar.quote(edit("[> said\n> this]"))))
        // A caret on an empty line: the marker, and the caret after it.
        assertEquals("intro\n- |", shown(MarkdownToolbar.bullets(edit("intro\n|"))))
        // The caret keeps its place in the line's text.
        assertEquals("- wo|rd", shown(MarkdownToolbar.bullets(edit("wo|rd"))))
    }

    @Test
    fun indentNestsUnderTheLineAboveByItsMarkersWidthAndOutdentUndoesIt() {
        assertEquals("- one\n  - |two", shown(MarkdownToolbar.indent(edit("- one\n- |two"))))
        // Under a numbered item: three spaces, and the nested list starts at 1.
        assertEquals("1. one\n   1. |two", shown(MarkdownToolbar.indent(edit("1. one\n2. |two"))))
        assertEquals("1. one\n2. |two", shown(MarkdownToolbar.outdent(edit("1. one\n   2. |two"))))
        assertEquals("- one\n- |two", shown(MarkdownToolbar.outdent(edit("- one\n  - |two"))))
        // A line that is not a list item is left as it is.
        assertEquals("plain|", shown(MarkdownToolbar.indent(edit("plain|"))))
        assertEquals("- a\n  - b\n    - |c", shown(MarkdownToolbar.indent(edit("- a\n  - b\n  - |c"))))
    }

    @Test
    fun aCodeBlockFencesTheSelectedLinesOnLinesOfTheirOwn() {
        assertEquals("Logs:\n```\n[line 1\nline 2]\n```", shown(MarkdownToolbar.codeBlock(edit("Logs:\n[line 1\nline 2]"))))
        assertEquals("```\n|\n```", shown(MarkdownToolbar.codeBlock(edit("|"))))
    }

    @Test
    fun thePreviewReadsWhatTheToolbarWrites() {
        val blocks = MarkdownPreview.blocks(
            "It **broke** _badly_ with `code` and [a link](https://example.com)\n\n- one\n  - nested\n1. first\n> quoted\n\n```\nlet x\n```\n## Heading",
        )
        assertEquals(
            listOf(
                Block.Paragraph(
                    listOf(
                        Run("It "), Run("broke", bold = true), Run(" "), Run("badly", italic = true), Run(" with "), Run("code", code = true),
                        Run(" and "), Run("a link", url = "https://example.com"),
                    ),
                ),
                Block.Item(0, "•", listOf(Run("one"))),
                Block.Item(1, "•", listOf(Run("nested"))),
                Block.Item(0, "1.", listOf(Run("first"))),
                Block.Quote(listOf(Run("quoted"))),
                Block.Code("let x"),
                Block.Heading(2, listOf(Run("Heading"))),
            ),
            blocks,
        )
        assertEquals(listOf(Run("bold ", bold = true), Run("and italic", bold = true, italic = true)), MarkdownPreview.runs("**bold _and italic_**"))
    }
}
