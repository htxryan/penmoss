# T15 copy and paste: manual matrix (Checkpoint C)

The automated tests cover Penmoss → Penmoss, Copy as Markdown and rich text, ⌘⇧V, and hand-written payloads in the shape each app writes (`packages/editor/test/clipboard-fixtures/`). This checklist covers what needs the real apps. Run it in Chrome on the Mac (Electron follows in T29). About 20 minutes.

**Set-up.** Make one Penmoss note called _Clipboard test_ and paste this markdown into it with ⌘V (it should turn into blocks straight away):

````markdown
## Weekend plan

Pack **light**, bring ==sunscreen== and the `travel` adapter. A [link](https://example.com).

- [x] Book the cabin
- [ ] Buy groceries

> [!tip] Packing
> Roll clothes, do not fold.

1. First
2. Second

| Day | Plan |
| :- | -: |
| Sat | Hike |

```ts
const days = 2;
```

$$
e^{i\pi} + 1 = 0
$$
````

To check what a note stored, press **Markdown** in the note header (⌘⇧M). After each paste into Penmoss, the note must show no stray colours, fonts or sizes from the source app.

## Penmoss → other apps

Select everything in the note body (click in it, ⌘A) and copy with ⌘C, then paste into each app.

| #   | Paste into                  | Expect                                                                                                                                                                                                         | ✓   |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1   | Google Docs (⌘V)            | Heading 2, bold, highlighted word may show as plain, inline code in a monospace font, a working link, a bulleted list (checkboxes may show as bullets), a quote with **Packing** in bold, numbered list, a real table, code as a monospace block. |     |
| 2   | Apple Notes (⌘V)            | Same rich text: heading, bold, link, lists, table. Formulas show as `$$…$$` text.                                                                                                                              |     |
| 3   | VS Code, a `.md` file (⌘V)  | The markdown above, exactly (fences, `- [x]`, `> [!tip]`, the table with `:-`/`-:`).                                                                                                                           |     |
| 4   | Slack message box (⌘V)      | Bold, code, link and lists kept; the rest as plain lines. Nothing garbled.                                                                                                                                    |     |
| 5   | Notion page (⌘V)            | Heading, bold, code, link, to-do list, numbered list, code block. Notion may read the markdown text instead of the HTML: either is fine if nothing is lost.                                                    |     |
| 6   | TextEdit, plain text mode   | The markdown text.                                                                                                                                                                                             |     |

Then select only the paragraph and use **Copy ▾ → Copy as rich text** in the selection toolbar (or ⌘⌥⇧C; the toolbar menu shows no shortcut for it on Windows or Linux), and paste into TextEdit (plain): expect `Pack light, bring sunscreen and the travel adapter. A link.` with no `**` or backticks. Use **Copy as Markdown** (⌘⇧C) and paste into TextEdit: expect the `**light**` markdown. In the note header, **Copy ▾ → Copy note as Markdown** and paste into VS Code: expect the frontmatter (`id`, `title`, `created`) and then the note. Select from the start of `Second` in the numbered list to the end of the table below it, ⌘C, and paste into VS Code: the item keeps its number (`2. Second`), then the table.

## Other apps → Penmoss

Paste each into a fresh empty note with ⌘V, then open **Markdown**.

| #   | Copy from                                                                                                       | Expect in Penmoss                                                                                                                              | ✓   |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 7   | Google Docs: a heading, a paragraph with bold, italic and a link, a bulleted list with a nested item, a checklist, a 2×2 table, a picture | `#` heading, `**bold**`, `*italic*`, the link's real address (not `google.com/url?q=`), nested `-` list, `- [ ]` / `- [x]`, a table whose first row is the header, the picture as a link labelled _Image_. No colours or fonts. |     |
| 8   | Notion: heading, text with code and a link, bulleted and numbered lists, a to-do list, a callout, a code block   | Same blocks; to-dos as `- [ ]`; the callout as `> [!note]`; the code block with its language (`js`, `py`, …); one list, not one list per item. |     |
| 9   | Apple Notes: a title, bold text, a bulleted list, a table                                                        | `**Title**` (Notes' title is bold text), bold kept, `-` list, table. No blank paragraphs where Notes had empty lines.                           |     |
| 10  | A web page (for example a Wikipedia article: a heading, a paragraph with links and a formula, a table)          | Clean blocks; links absolute; a formula becomes a Penmoss formula (KaTeX); pictures become links to the picture; no ads, buttons or scripts.   |     |
| 11  | VS Code: several lines of a `.ts` file                                                                          | A code block set to TypeScript, indentation kept.                                                                                              |     |
| 12  | VS Code: one identifier                                                                                         | Inline code at the cursor.                                                                                                                     |     |
| 13  | VS Code: lines from a `.md` file                                                                                | Parsed as markdown (headings, lists), not a code block. Badge pictures (`![build](https://img.shields.io/…)`) become links; nothing loads from their hosts.                                                                                        |     |
| 14  | Slack: a message with bold, a list, a code block, a link and an emoji                                           | `**bold**`, `-` list, fenced code, the link, the emoji as its character (🎉), not a picture link.                                              |     |
| 15  | Word (if at hand): a heading, bold/italic, a bulleted and a numbered list, a table                              | Real `-` and `1.` lists (not paragraphs starting with `·`), table with a header row.                                                           |     |
| 16  | A screenshot (⇧⌘4 then ⌃, or Copy image in a browser)                                                            | The picture is inserted and uploads (T10).                                                                                                     |     |

## Paste and match style, and special places

| #   | Do                                                                                                                       | Expect                                                                                   | ✓   |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --- |
| 17  | Copy formatted text from Google Docs. In a Penmoss sentence, put the caret inside **bold** text and press ⌘⇧V (or ⌥⇧⌘V) | Plain text, bold like the words around it; no heading, link or list.                     |     |
| 18  | Copy a markdown snippet from VS Code and press ⌘⇧V in a paragraph                                                        | The characters as typed (`**`, `-`), not formatted.                                       |     |
| 19  | Put the caret inside a Penmoss code block and paste rich HTML                                                            | Plain text inside the code block.                                                         |     |
| 20  | Put the caret in a table cell and paste a few paragraphs from Google Docs                                                | They join into the one cell, separated by line breaks; the table keeps its rows and columns. |     |
| 21  | Click the note title and paste two lines of text                                                                         | One line, the line break as a space; the body is unchanged.                               |     |

Note anything that looks wrong with the app, what was copied, and a screenshot of the result.
