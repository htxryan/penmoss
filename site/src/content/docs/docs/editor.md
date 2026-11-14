---
title: The editor
description: Write notes with the slash menu, blocks, diagrams, math, pictures, files, Excalidraw drawings, embedded notes and line symbols.
---

This page shows you what the editor can do: the blocks you can insert, the markdown it understands as you type, pictures and files, Excalidraw diagrams, embedded notes, line symbols, the markdown source, and copy and paste.

Everything you write is saved as markdown. What you see in the editor is what the `.md` file in your repository holds.

## The title

The note's title sits above its first line, and the caret moves between them as it does between lines. Enter in the title, or ↓ on its last line, goes to the start of the note's first line. ↑ on the first line goes back to the end of the title, and Backspace at the start of a first line of plain text joins it to the title.

## The slash menu

Type `/` at the start of a line or after a space to open the slash menu. Keep typing to filter it, move with ↑ and ↓, and press Enter or Tab to insert. Escape closes it.

| Item               | Also found by                      | In markdown      |
| ------------------ | ---------------------------------- | ---------------- |
| Text               | paragraph, plain                   |                  |
| Heading 1, 2, 3    | h1, h2, h3, title, section         | `#`, `##`, `###` |
| Bulleted List      | bullet, ul                         | `-`              |
| Numbered List      | ordered, number, ol                | `1.`             |
| Checklist          | todo, task, checkbox               | `- [ ]`          |
| Quote              | blockquote, citation               | `>`              |
| Divider            | rule, hr, line, separator          | `---`            |
| Code Block         | snippet, fence, pre                | ` ``` `          |
| Table              | grid, columns, rows                | `\| a \| b \|`   |
| Callout            | admonition, note, info, aside      | `> [!note]`      |
| Toggle             | collapse, fold, details, expand    | `> [!note]-`     |
| Mermaid Diagram    | diagram, flowchart, chart, graph   | ` ```mermaid `   |
| Math Block         | equation, formula, latex, katex    | `$$`             |
| Inline Math        |                                    | `$x$`            |
| Link to Note       | wikilink, reference, backlink      | `[[`             |
| Embed Note         | transclude, include, section       | `![[`            |
| Image              | picture, photo, upload, screenshot |                  |
| File               | attachment, pdf, document          |                  |
| Excalidraw Diagram | draw, drawing, sketch, whiteboard  |                  |
| Symbol             | signifier, important, idea, star   |                  |

Each item is also in the [command palette](/docs/shortcuts/#the-command-palette) as **Insert: …**. In a table cell the menu offers only Inline Math, Link to Note, Image, File and Symbol.

## Markdown as you type

The editor turns markdown into formatting as you type it:

- `#` to `######` and a space make a heading.
- `-`, `*` or `+` and a space start a bulleted list; `1.` and a space a numbered one.
- `[ ]` or `[x]` and a space start a checklist item.
- `>` and a space start a quote; `> [!tip]` and a space a callout.
- ` ``` ` (or `~~~`), with an optional language, then a space or Enter, start a code block.
- `---` makes a divider.
- `| a | b |` then Enter makes a table.
- `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` and `==highlight==` format text.
- `[text](https://…)` makes a link and `![alt](https://…)` a picture.
- `[[` starts a [link to a note](/docs/links/), and `![[` an [embed](#embedded-notes).
- `$x^2$` makes inline math and `$$` on its own line a math block.

## Formatting text

Select text to show the formatting toolbar: **Bold**, **Italic**, **Strikethrough**, **Inline Code**, **Highlight**, **Link**, **Comment**, **Copy As** and **Turn Into**. Alt+F10 moves the focus into it. **Turn Into** changes the block to Text, a heading, a list, a quote, a code block, a callout or a toggle.

The keys for each are on the [keyboard shortcuts](/docs/shortcuts/#formatting) page.

## Blocks

### Lists and checklists

Tab and Shift+Tab indent and outdent a list item. Click a checkbox to tick it.

### Tables

While the caret is in a table, a toolbar offers **Add Row Above**, **Add Row Below**, **Delete Row**, **Add Column Left**, **Add Column Right**, **Delete Column** and **Delete Table**. Tab and Shift+Tab move between cells, and Tab in the last cell adds a row. A table always has one header row.

### Callouts and toggles

A callout is a quote with a type, written `> [!type] Title`. Choose the type from the callout's **Callout type** menu, and type a title in **Callout title**. The types are note, abstract, info, todo, tip, success, question, warning, failure, danger, bug, example and quote; common aliases such as `tldr`, `hint`, `caution` and `error` work too.

A toggle is a callout that folds: `> [!note]-` starts folded and `> [!note]+` starts open. Whether a toggle is open is kept on each device and never written to the note.

### Code blocks

Pick the language from the block's **Code block language** menu: Plain Text, about 40 languages, or Mermaid Diagram. Code is highlighted in the theme's colours. **Copy** copies the code, and Tab indents by two spaces.

### Diagrams

A Mermaid diagram is a code block in the `mermaid` language. Penmoss draws it in place and follows your theme. Click the diagram, or **Edit**, to change its source, and **Preview** to draw it again. If the source has a mistake, the block says what Mermaid did not understand.

### Math

Math is written in LaTeX and drawn with KaTeX.

- **Inline:** `$x^2$`, with no space just inside the dollar signs. Select it and press Enter to edit it; Enter saves.
- **Block:** type `$$` on its own line, then Enter. Mod+Enter (⌘Enter on a Mac) saves, Escape cancels.

## Pictures and files

Add a picture by pasting it, dropping it on the note, choosing **Image** in the slash menu, or typing `![alt](https://…)`. Penmoss stores PNG, JPEG, GIF, WebP and AVIF pictures; SVG is not accepted.

Select a picture to resize it with its handle, and to set its **Alt text** and **Width**. Double-click it, or use **Open in Lightbox**, to see it full size: zoom up to 8× with the wheel, a pinch or a double-click, drag to pan, and step through the note's pictures with ← and →. Escape leaves full screen, then closes it.

Add any other file by dropping or pasting it, or with **File** in the slash menu. It shows as a chip with its name, size and type, with **Preview** for a PDF and a way to open or save a copy.

The Mac app takes pictures and files up to 50 MB. The Android app, the `penmoss` CLI and agents keep files of at most 10 MB in a notebook (the CLI's `attach`, at most 700 KB).

Pictures and files are saved on the device first, so this works offline, and go to the repository with the next sync, in its `attachments/` folder. See [Notebooks on disk](/docs/reference/notebook-format/#attachments).

## Excalidraw Diagrams

Choose **Excalidraw Diagram** in the slash menu to sketch in [Excalidraw](https://excalidraw.com), a hand-drawn style drawing editor, which opens over the whole window. Draw with its shapes, arrows, lines, pen and text, then press **Done** to put the drawing in the note, or **Cancel** to leave the note as it was. The editor follows your light or dark mode, and works offline.

The drawing shows in the note as a picture, as wide as you drew it. Click it to select it. Point at it, or select it, and two buttons show in its top-right corner: **Edit Excalidraw Diagram** (the pencil) opens it in Excalidraw again, and **Delete Excalidraw Diagram** (the bin) removes it from the note. With the drawing selected, Enter edits it too, and Backspace or Delete removes it. Undo (⌘Z, or Ctrl+Z) brings a removed drawing back. A read-only note, such as an older version in History, shows the drawing without the buttons.

Each drawing is two files in the repository's `attachments/` folder: the Excalidraw scene, a `.excalidraw` file you can also open at excalidraw.com, and an `.svg` picture of it. The note shows the picture, linked to the scene, so GitHub and any markdown viewer show the drawing too:

```markdown
[![Excalidraw Diagram](attachments/9c1e…b2.svg)](attachments/41d7…0a.excalidraw)
```

Each edit saves a new pair of files and points the note at them; the old pair stays in `attachments/`, as a picture does when you remove it from a note. Agents reading the note see the same picture link. The Android app shows drawings but can't edit them, and keeps them as they are when you edit the note around them.

## Embedded notes

`![[Title]]` on a line of its own shows another note inside this one, and `![[Title#Heading]]` shows one section of it. You can also choose **Embed Note** in the slash menu. An embed is read-only and always up to date; open the note to edit it. Embeds inside embeds go three levels deep.

If the note or the heading does not exist, the embed says so. A note that embeds itself shows a link instead.

## Line symbols

Line symbols are small marks at the start of a line, such as ★ for important or ? for a question, drawn in colour in the margin. They work on paragraphs, list and checklist items, headings and table cells.

The default symbols are ★ Important, ? Question, ! Follow-up, 💡 Idea and → Next. To add or remove one on the current line, or on every selected line:

- **On a Mac:** ⌃1 to ⌃9 toggle symbols 1 to 9, and ⌃0 opens the **Symbols…** picker.
- **Elsewhere:** Alt+Shift+1 to Alt+Shift+9, and Alt+Shift+0 for the picker.
- **Anywhere:** **Symbol** in the slash menu, or click a line's symbols.

In the picker, ↑ and ↓ move, Enter or Space toggles, a digit toggles that symbol, and Escape closes. **Edit Symbols…** at its foot opens **Settings → Symbols**, where you can change each symbol's glyph and colour, reorder them, **Add a Symbol** (up to nine) or **Restore Defaults**.

In markdown a symbol is plain text: the glyph and a space after the list marker, checkbox or `#`, as in `- [ ] ★ Send the form` or `## ? Open questions`.

:::tip
If ⌃ and a digit switch Spaces on your Mac, rebind the symbols in **Settings → Keyboard Shortcuts**.
:::

## Moving blocks

Hover over a block to show its handle (⠿). Drag the handle to move the block, or click it to select the block. **Move Block Up** and **Move Block Down** are ⌥⇧↑ and ⌥⇧↓ (Alt+Shift+↑ and ↓ elsewhere). **Duplicate Block** and **Delete Block** are in the command palette.

## The markdown source

**Toggle Markdown Source** (⌘⇧M, or **Markdown Source** in the note's ⋯ menu) shows the note as plain markdown. The frontmatter is shown but read-only; you can edit the body, and your edits apply after a short pause. When you switch back, Penmoss shows the note as it stores it, which may be formatted slightly differently from what you typed.

Markdown Penmoss has no block for, such as raw HTML or footnotes, is kept exactly as written and shown as **Markdown kept as written**.

## Copy and paste

- **Copy** puts rich text and markdown on the clipboard together, so a paste into Mail gets formatting and a paste into a text editor gets markdown.
- **Copy as Markdown** (⌘⇧C) and **Copy as Rich Text** (⌘⌥⇧C) copy one or the other. With nothing selected they copy the whole note.
- **Copy Note as Markdown** and **Copy Note as Rich Text**, in the note's ⋯ menu, always copy the whole note.

When you paste:

- Formatted text from a web page, Google Docs or Word keeps its headings, lists, bold, italic and safe links, and loses the rest of its styling.
- Plain text that looks like markdown is read as markdown.
- ⌘⇧V pastes plain text.
- Code copied from VS Code becomes a code block in its language.
- A picture is stored in the note. A picture that only has a web address stays a link.
- A single web address becomes a link.
