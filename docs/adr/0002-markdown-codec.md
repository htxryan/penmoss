# ADR 0002: Document schema and markdown codec

- Status: Accepted
- Date: 22 October 2026
- Task: T3 ([#3](https://github.com/htxryan/penmoss/issues/3))

## Context

Markdown with YAML frontmatter is Penmoss's export format and the format agents read and write (plan `#format`). The editor, the git mirror, MCP and the CLI all convert between markdown and one document model, so the conversion must be lossless for every v1 block (D11), stable (the same document always produces the same bytes, so the git mirror does not churn), and able to run in workerd with no DOM (A9). The codec rules are in [`packages/core/docs/markdown-normalisation.md`](../../packages/core/docs/markdown-normalisation.md).

## Decision

### Schema (`packages/core/src/schema.ts`)

- **One ProseMirror schema, exported as plain specs** (`nodeSpecs`, `markSpecs`) plus a `schema` instance. The specs are model-only: content expressions, groups, attributes and flags, with no `toDOM` or `parseDOM`, so core never touches the DOM. The editor adds rendering when it builds TipTap extensions from these specs.
- **TipTap names** (`bulletList`, `listItem`, `taskItem`, `codeBlock`, `hardBreak`, `bold`, `italic`, `strike`, …), so the editor can reuse TipTap's commands and keymaps.
- **`describeSchema(schema)`** returns a JSON description of the model (node and mark order, content, groups, attributes). The editor's CI test will compare `describeSchema(editorSchema)` with `describeSchema(coreSchema)` (A9). That test lands with the TipTap extensions in Phase 2; core's own tests already show that the description detects drift.
- **Mermaid is a `codeBlock` with `language: 'mermaid'`**, not its own node. It stays a fenced block in markdown, Obsidian renders it, and the editor picks the Mermaid view from the language (T12).
- **Math** is `inlineMath` and `blockMath` atoms with a `latex` attribute, matching TipTap's Mathematics extension.
- **Images are inline nodes** with `width` and `height` (`![alt|300x200](src)`). **Attachments** are inline atoms for links into an `attachments/` folder. **Embeds** (`![[Note#Heading]]`) are block atoms, used when the embed is alone in its paragraph; an embed inside running text stays raw.
- **Wikilinks** are inline atoms with `noteId` (null when unresolved), `target` (the title or path as written), `heading` and `alias`. A `LinkResolver` maps targets to note IDs when parsing and note IDs to their current title when serialising, so renames update the markdown and unresolved links keep their text.
- **Callouts** have `type`, `title` (raw markdown, written back as is), `foldable` and `collapsed`. `[!type]-` and `[!type]+` are toggles; whether a toggle is open while editing is per-device UI state, not document content (T11).
- **Tables** have inline-only cells (GFM cannot hold blocks in a cell), per-cell `align`, and the `colspan`, `rowspan` and `colwidth` attributes and `tableRole`s that prosemirror-tables expects.
- **Lists** have a `tight` attribute, so loose lists stay loose. Task lists are `taskList`/`taskItem` with `checked`.
- **Unknown syntax is kept**, never dropped: `rawMarkdown` (a code-like block holding the source text) and `rawInline` (an atom). This covers HTML, footnotes, reference definitions and links, lists that mix task and plain items, inline embeds and empty-text links.
- **Inline `#tags` stay text.** The indexer extracts them (T18); a tag node would add nothing the text does not already say.
- **Marks** are ordered link, italic, bold, strike, highlight, code. That is the nesting order when serialising, so bold italic is written `***x***`.

### Codec (`packages/core/src/markdown/`)

- **Built on `mdast-util-from-markdown` and `mdast-util-to-markdown`**, the libraries `remark-parse` and `remark-stringify` wrap, with the micromark extensions passed in directly. This avoids the unified processor and lets us choose the GFM pieces: tables, task lists, `~~strikethrough~~` (two tildes only) and footnotes, but **no GFM autolink literals**. Bare URLs stay text and round-trip byte for byte instead of becoming `<url>`; the editor can still make them clickable.
- **Custom syntax** is in core: a micromark extension for `[[…]]` and `![[…]]`, and one for `==highlight==` (adapted from the GFM strikethrough tokenizer, MIT). Callouts are recognised from the source text of a blockquote's first line, so an escaped `\[!note]` stays a quote. Highlights serialise through mdast-util-to-markdown 2.2's attention mechanism, which pairs delimiter runs the way micromark will.
- **Escaping is minimal but safe.** The default escaping is kept, then removed where it can never matter (`#tag` at a line start, `AT&T`, a single `~`), and added where the libraries miss cases (`$`, email autolinks, `=` next to a highlight, a backslash before a character the serialiser writes as a reference).
- **Frontmatter** uses the `yaml` Document API. Frontmatter the app has not modified is written back byte for byte; edits keep key order, comments and unknown keys.
- **Tightness is read from the source**, not from mdast's `spread` flags, which report a list inside a blockquote as loose when a blank line follows it. When writing, a list stays tight only when no item needs a blank line to keep its blocks apart.

### Verification

- 51 fixtures (15 with a `.expected.md` normalised form) cover every node and mark. Each must serialise to its normalised form and then round-trip byte for byte. A test checks that the normalisation spec names every normalising fixture.
- fast-check generates random schema documents (all node and mark types, nesting up to the schema's limits, markdown punctuation and non-ASCII text) and checks three properties: serialise, parse, serialise is stable; no text content is lost; a parsed document is a fixpoint. These found most of the escaping and list rules above. The default run is 300 documents per property; `PENMOSS_PROPERTY_RUNS` raises it (more than 15,000 per property passed during development).
- The whole core suite runs twice, in Node and in workerd through `@cloudflare/vitest-plugin`. A workerd-only test checks the runtime and the absence of DOM globals.

## Consequences

- **CPU.** A 10,000-word note takes about 82 ms to parse and 25 ms to serialise (median, Node, on the shared agent worker). That fits a Durable Object's 30 s CPU budget, but not the 10 ms a Free-plan Worker request gets (D20). Server-side codec work (T24's edit engine, T27's git mirror) belongs in Durable Objects or queue consumers, not in the request path of the Worker.
- **Known limitations** (documented in the normalisation spec): inline code in a table cell cannot contain a backslash directly before `|`; image alt text ending in `|` and digits is read as a size; `$` in text is always written `\$`.
- **The editor schema test (A9) is still to come.** It needs the TipTap extensions (T9–T14); `describeSchema` is the comparison it will use.
- Raw blocks show as source in the editor. They are rare in notes written in Penmoss, but common in pasted or agent-written markdown that uses HTML or footnotes.
