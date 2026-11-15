import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter, readNoteMeta, setFrontmatterFields } from '../src/frontmatter';
import type { LinkResolver } from '../src/markdown/context';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { schema } from '../src/schema';

/** An in-memory note registry: title → id, id → current title. */
function fakeLinks(notes: Record<string, string>): LinkResolver {
  const byTitle = new Map(Object.entries(notes).map(([id, title]) => [title.toLowerCase(), id]));
  return {
    resolve: (target) => byTitle.get(target.toLowerCase()) ?? null,
    linkText: (noteId) => notes[noteId] ?? null,
  };
}

const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));
const firstBlock = (markdown: string) => parseMarkdown(markdown).doc.firstChild!;

describe('parseMarkdown', () => {
  it('returns an empty paragraph for an empty note', () => {
    const { frontmatter, doc } = parseMarkdown('');

    expect(frontmatter).toBeNull();
    expect(doc.toJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('separates frontmatter from the body', () => {
    const { frontmatter, doc } = parseMarkdown('---\ntitle: Hello\n---\n\nBody\n');

    expect(readNoteMeta(frontmatter!)).toEqual({ title: 'Hello' });
    expect(doc.textContent).toBe('Body');
  });

  it('normalises CRLF line endings and a byte-order mark', () => {
    expect(roundTrip('\uFEFFa\r\nb\r\n')).toBe('a\nb\n');
  });

  it('resolves a wikilink to a note ID and keeps what was written', () => {
    const link = parseMarkdown('[[Sync design#Merge|merging]]', {
      links: fakeLinks({ n1: 'Sync design' }),
    }).doc.firstChild!.firstChild!;

    expect(link.type.name).toBe('wikilink');
    expect(link.attrs).toEqual({
      noteId: 'n1',
      target: 'Sync design',
      heading: 'Merge',
      alias: 'merging',
    });
  });

  it('keeps an unresolved wikilink with a null note ID', () => {
    const link = firstBlock('[[Nowhere]]').firstChild!;

    expect(link.attrs['noteId']).toBeNull();
    expect(link.attrs['target']).toBe('Nowhere');
  });

  it('reads an embed on its own line as an embed block', () => {
    const block = firstBlock('![[Brief#Milestones]]');

    expect(block.type.name).toBe('embed');
    expect(block.attrs).toMatchObject({ target: 'Brief', heading: 'Milestones' });
  });

  it('keeps an embed inside running text as raw inline markdown', () => {
    const inline = firstBlock('See ![[Brief]] here').child(1);

    expect(inline.type.name).toBe('rawInline');
    expect(inline.attrs['markdown']).toBe('![[Brief]]');
  });

  it('reads Obsidian callout type, title and fold state', () => {
    const callout = firstBlock('> [!warning]- Mind the gap\n> Body');

    expect(callout.type.name).toBe('callout');
    expect(callout.attrs).toEqual({
      type: 'warning',
      title: 'Mind the gap',
      foldable: true,
      collapsed: true,
    });
    expect(callout.textContent).toBe('Body');
  });

  it('keeps an escaped callout marker as an ordinary quote', () => {
    expect(firstBlock('> \\[!note] not a callout').type.name).toBe('blockquote');
  });

  it('reads the image size suffix into width and height', () => {
    const image = firstBlock('![Diagram|300x200](attachments/a.png)').firstChild!;

    expect(image.attrs).toMatchObject({ alt: 'Diagram', width: 300, height: 200 });
  });

  // T41 (A506): the apps show every picture on its own line; the markdown keeps it inline,
  // where it was written, in a list item or a paragraph, with its size.
  it('keeps a picture inline in a list item or paragraph, with its size', () => {
    const sha = '4c894371d07259dc609cf331ae4bac9cb01bdb914809b4ce54a366caa021c8b9';
    for (const markdown of [
      `1. The default content width needs to be wider![|289](attachments/${sha}.png)\n2. Next\n`,
      `A paragraph with a picture ![](attachments/${sha}.png) in the middle.\n`,
      `- Two side by side ![a|205](attachments/${sha}.png)![b|235](attachments/${sha}.png)\n`,
    ]) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
    const item = firstBlock(`1. Wider![|289](attachments/${sha}.png)\n`).firstChild!.firstChild!;
    expect(item.type.name).toBe('paragraph');
    expect(item.lastChild?.type.name).toBe('image');
    expect(item.lastChild?.attrs).toMatchObject({ width: 289 });
  });

  it('reads a link into attachments/ as an attachment', () => {
    const file = firstBlock('[report.pdf](../attachments/9f2c.pdf)').firstChild!;

    expect(file.type.name).toBe('attachment');
    expect(file.attrs).toEqual({ href: '../attachments/9f2c.pdf', name: 'report.pdf' });
  });

  it('marks text with every inline mark', () => {
    const marks = firstBlock('**b** *i* ~~s~~ ==h== `c` [l](u)')
      .content.content.filter((node) => node.text?.trim())
      .map((node) => node.marks.map((mark) => mark.type.name));

    expect(marks).toEqual([['bold'], ['italic'], ['strike'], ['highlight'], ['code'], ['link']]);
  });

  describe('links and images to unsafe addresses (T24 review)', () => {
    // As the paste path does (A51, A52): an unsafe link becomes its text, a picture its alt text.
    const unsafe: Array<[string, string]> = [
      ['[click](javascript:alert(1))', 'click'],
      ['[click](JaVaScRiPt:alert(1))', 'click'],
      ['[click](java&#9;script:alert(1))', 'click'],
      ['[click](vbscript:msgbox(1))', 'click'],
      ['[click](data:text/html,<b>x</b>)', 'click'],
      ['<javascript:alert(1)>', 'javascript:alert(1)'],
      ['![pic](javascript:alert(1))', 'pic'],
      ['![pic|300](javascript:alert(1))', 'pic'],
      ['[**bold** click](javascript:alert(1) "t")', '**bold** click'],
    ];
    for (const [markdown, text] of unsafe) {
      it(`reads ${markdown} as its text, never a link`, () => {
        const block = firstBlock(markdown);
        const hrefs: unknown[] = [];
        block.descendants((node) => {
          if (node.type.name === 'image') hrefs.push(node.attrs['src']);
          for (const mark of node.marks)
            if (mark.type.name === 'link') hrefs.push(mark.attrs['href']);
          return true;
        });
        expect(hrefs).toEqual([]);
        expect(roundTrip(markdown)).toBe(`${text}\n`);
      });
    }

    it('keeps web, mail, relative and fragment links as links', () => {
      for (const href of ['https://a.example/x', 'mailto:r@example.com', '../n/other.md', '#top']) {
        const text = firstBlock(`[x](${href})`).firstChild!;
        expect(text.marks.map((mark) => mark.attrs['href'] as unknown)).toEqual([href]);
      }
    });
  });

  it('keeps bare URLs as text (no GFM autolink literals)', () => {
    expect(firstBlock('see https://example.com/a_b').firstChild!.marks).toEqual([]);
  });

  describe('lists mixing task items and plain items (A157)', () => {
    const shape = (node: PMNode): unknown =>
      node.isTextblock
        ? node.textContent
        : {
            [node.type.name]:
              node.type.name === 'taskItem' ? (node.attrs['checked'] as boolean) : undefined,
            content: node.children.map(shape),
          };

    it('splits a mixed list into adjacent task and bullet lists, in order', () => {
      const { doc } = parseMarkdown('- [ ] task\n- plain\n- more\n- [x] done\n');

      expect(doc.children.map((list) => list.type.name)).toEqual([
        'taskList',
        'bulletList',
        'taskList',
      ]);
      expect(doc.textContent).toBe('taskplainmoredone');
      expect(doc.lastChild!.firstChild!.attrs['checked']).toBe(true);
      expect(doc.children.every((list) => list.attrs['tight'] === true)).toBe(true);
      doc.check();
    });

    it('writes the split lists so they read back the same, and stays stable', () => {
      const markdown = roundTrip('- [ ] task\n- plain\n- [x] done\n');

      expect(markdown).toBe('- [ ] task\n\n* plain\n\n- [x] done\n');
      expect(roundTrip(markdown)).toBe(markdown);
    });

    it('splits a mixed list nested in an item, keeping the item’s other blocks', () => {
      const { doc } = parseMarkdown(
        '- [ ] parent\n  - [ ] child task\n  - child note\n- [x] next\n',
      );

      expect(shape(doc)).toEqual({
        doc: undefined,
        content: [
          {
            taskList: undefined,
            content: [
              {
                taskItem: false,
                content: [
                  'parent',
                  { taskList: undefined, content: [{ taskItem: false, content: ['child task'] }] },
                  {
                    bulletList: undefined,
                    content: [{ listItem: undefined, content: ['child note'] }],
                  },
                ],
              },
              { taskItem: true, content: ['next'] },
            ],
          },
        ],
      });
      doc.check();
      const markdown = roundTrip('- [ ] parent\n  - [ ] child task\n  - child note\n- [x] next\n');
      expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
      // Two lists in one item make the outer list loose when written; the structure stays.
      expect(shape(parseMarkdown(markdown).doc)).toEqual(shape(doc));
    });

    it('keeps each run’s own looseness', () => {
      const { doc } = parseMarkdown('- [ ] a\n- [ ] b\n- plain\n\n  more\n');

      expect(doc.children.map((list) => [list.type.name, list.attrs['tight'] as boolean])).toEqual([
        ['taskList', true],
        ['bulletList', false],
      ]);
    });

    it('keeps an ordered list with task items as raw markdown (no ordered task list)', () => {
      const block = firstBlock('1. [ ] first\n2. second');

      expect(block.type.name).toBe('rawMarkdown');
      expect(block.textContent).toBe('1. [ ] first\n2. second');
    });
  });

  describe('<br> outside tables (A157)', () => {
    it('reads <br> between text as a hard break, dropping the spaces around it', () => {
      const block = firstBlock('one <br> two<br/>three<BR />four');

      expect(block.toJSON()).toEqual({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'one' },
          { type: 'hardBreak' },
          { type: 'text', text: 'two' },
          { type: 'hardBreak' },
          { type: 'text', text: 'three' },
          { type: 'hardBreak' },
          { type: 'text', text: 'four' },
        ],
      });
      expect(roundTrip('one <br> two')).toBe('one\\\ntwo\n');
      expect(roundTrip('one\\\ntwo\n')).toBe('one\\\ntwo\n');
    });

    it('reads <br> in a list item and in emphasis as a hard break', () => {
      const item = firstBlock('- a<br>*b<br>c*').firstChild!.firstChild!;

      expect(item.content.toJSON()).toEqual([
        { type: 'text', text: 'a' },
        { type: 'hardBreak' },
        { type: 'text', text: 'b', marks: [{ type: 'italic' }] },
        { type: 'hardBreak', marks: [{ type: 'italic' }] },
        { type: 'text', text: 'c', marks: [{ type: 'italic' }] },
      ]);
    });

    it('keeps <br> raw where markdown has no hard break: a paragraph’s edges and headings', () => {
      expect(firstBlock('<br>text').firstChild!.toJSON()).toEqual({
        type: 'rawInline',
        attrs: { markdown: '<br>' },
      });
      expect(firstBlock('text <br/>').lastChild!.toJSON()).toEqual({
        type: 'rawInline',
        attrs: { markdown: '<br/>' },
      });
      expect(firstBlock('# a<br>b').child(1).type.name).toBe('rawInline');
      for (const markdown of ['<br>text\n', 'text <br/>\n', '# a<br>b\n']) {
        expect(roundTrip(markdown)).toBe(markdown);
      }
    });
  });

  it('reads <br> in a table cell as a hard break', () => {
    const cell = firstBlock('| a<br>b |\n| - |').firstChild!.firstChild!;

    expect(cell.child(1).type.name).toBe('hardBreak');
  });

  it('reads escaped pipes in inline math in a table cell as pipes, like inline code', () => {
    const table = firstBlock('| $\\|x\\|$ | $\\\\\\|v\\\\\\|$ |\n| - | - |');
    const [abs, norm] = [table.firstChild!.child(0), table.firstChild!.child(1)];

    expect(abs.firstChild!.attrs['latex']).toBe('|x|');
    expect(norm.firstChild!.attrs['latex']).toBe('\\|v\\|');
  });

  it('reads a list as loose when blank lines separate its items', () => {
    expect(firstBlock('- a\n\n- b').attrs['tight']).toBe(false);
    expect(firstBlock('- a\n- b').attrs['tight']).toBe(true);
  });
});

describe('serializeMarkdown', () => {
  // Found by the agent markdown property test (A157): `- [ ] &#x20;` with a nested list.
  it('writes an item whose text is only spaces like an empty one, as markdown that parses', () => {
    const text = (value?: string) =>
      schema.node('paragraph', null, value ? [schema.text(value)] : []);
    const nested = schema.node('bulletList', null, [schema.node('listItem', null, [text('x')])]);
    const doc = schema.node('doc', null, [
      schema.node('taskList', null, [schema.node('taskItem', null, [text('  '), nested])]),
    ]);
    const markdown = serializeMarkdown({ frontmatter: null, doc });

    expect(markdown).toBe(
      serializeMarkdown({
        frontmatter: null,
        doc: schema.node('doc', null, [
          schema.node('taskList', null, [schema.node('taskItem', null, [text(), nested])]),
        ]),
      }),
    );
    expect(parseMarkdown(markdown).doc.textContent).toBe('x');
  });

  it('escapes pipes in inline math in a table cell, so the cell keeps its formula', () => {
    const cell = (latex: string) =>
      schema.node('tableHeader', null, [schema.node('inlineMath', { latex })]);
    const doc = schema.node('doc', null, [
      schema.node('table', null, [
        schema.node('tableRow', null, [cell('|x|'), cell('\\|v\\|'), cell('a\\\\|b')]),
      ]),
      schema.node('paragraph', null, [schema.node('inlineMath', { latex: '|x|' })]),
    ]);

    const markdown = serializeMarkdown({ frontmatter: null, doc });

    expect(markdown).toBe(
      '| $\\|x\\|$ | $\\\\\\|v\\\\\\|$ | $a\\\\\\\\\\|b$ |\n| - | - | - |\n\n$|x|$\n',
    );
    expect(parseMarkdown(markdown).doc.toJSON()).toEqual(doc.toJSON());
  });

  it('writes a linked note under its current title after a rename', () => {
    const parsed = parseMarkdown('See [[Old title]].', { links: fakeLinks({ n1: 'Old title' }) });

    const markdown = serializeMarkdown(parsed, { links: fakeLinks({ n1: 'New title' }) });

    expect(markdown).toBe('See [[New title]].\n');
  });

  it('keeps the written target when the linked note is unknown', () => {
    const parsed = parseMarkdown('[[Gone]]', { links: fakeLinks({ n1: 'Gone' }) });

    expect(serializeMarkdown(parsed, { links: fakeLinks({}) })).toBe('[[Gone]]\n');
  });

  it('writes edited frontmatter with a blank line before the body', () => {
    const { frontmatter, doc } = parseMarkdown('---\nid: n1\n---\nBody\n');
    const updated = setFrontmatterFields(frontmatter!, { title: 'T' });

    expect(serializeMarkdown({ frontmatter: updated, doc })).toBe(
      '---\nid: n1\ntitle: T\n---\n\nBody\n',
    );
  });

  it('writes frontmatter alone when the body is empty', () => {
    expect(roundTrip('---\nid: n1\n---\n')).toBe('---\nid: n1\n---\n');
  });

  it('writes a leading rule as *** when there is no frontmatter', () => {
    expect(roundTrip('---\n\ntext\n')).toBe('***\n\ntext\n');
  });

  it('drops empty paragraphs', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph'),
      schema.node('paragraph', null, [schema.text('a')]),
      schema.node('paragraph'),
    ]);

    expect(serializeMarkdown({ frontmatter: null, doc })).toBe('a\n');
  });

  it('drops hard breaks at the edges of a paragraph', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('hardBreak'),
        schema.text('a'),
        schema.node('hardBreak'),
        schema.text('b'),
        schema.node('hardBreak'),
      ]),
    ]);

    expect(serializeMarkdown({ frontmatter: null, doc })).toBe('a\\\nb\n');
  });

  it('moves whitespace at the edge of bold text outside the markers', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('a'),
        schema.text(' bold ', [schema.marks.bold.create()]),
        schema.text('b'),
      ]),
    ]);

    expect(serializeMarkdown({ frontmatter: null, doc })).toBe('a **bold** b\n');
  });

  it('merges adjacent inline formulas, which markdown cannot separate', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('inlineMath', { latex: '\\alpha' }),
        schema.node('inlineMath', { latex: 'b' }),
      ]),
    ]);

    expect(serializeMarkdown({ frontmatter: null, doc })).toBe('$\\alpha b$\n');
  });

  it('writes a hard break in a table cell as <br>', () => {
    const doc = schema.node('doc', null, [
      schema.node('table', null, [
        schema.node('tableRow', null, [
          schema.node('tableHeader', null, [
            schema.text('a'),
            schema.node('hardBreak'),
            schema.text('b'),
          ]),
        ]),
      ]),
    ]);

    expect(serializeMarkdown({ frontmatter: null, doc })).toBe('| a<br>b |\n| - |\n');
  });

  it('escapes | in wikilinks inside table cells', () => {
    expect(roundTrip('| [[A\\|b]] |\n| - |\n')).toBe('| [[A\\|b]] |\n| - |\n');
  });

  describe('wikilink references with markup characters', () => {
    const references = [
      { target: 'C# notes', heading: null, alias: null },
      { target: 'a|b', heading: null, alias: null },
      { target: 'Q3 [draft]', heading: null, alias: null },
      { target: 'trailing\\', heading: null, alias: null },
      { target: 'Note', heading: null, alias: 'x]]y' },
      { target: 'C:\\Users', heading: 'H#1 [a] | b\\', alias: 'p|q\\' },
    ];
    const link = (reference: (typeof references)[number]) =>
      schema.node('wikilink', { noteId: null, ...reference });
    const inParagraph = (reference: (typeof references)[number]) =>
      schema.node('doc', null, [schema.node('paragraph', null, [link(reference)])]);
    const inTable = (reference: (typeof references)[number]) =>
      schema.node('doc', null, [
        schema.node('table', null, [
          schema.node('tableRow', null, [
            schema.node('tableHeader', null, [link(reference), schema.text(' | after')]),
          ]),
        ]),
      ]);

    it.each(references)('round-trips $target / $heading / $alias in a paragraph', (reference) => {
      const markdown = serializeMarkdown({ frontmatter: null, doc: inParagraph(reference) });
      const parsed = parseMarkdown(markdown).doc;

      expect(parsed.toJSON()).toEqual(inParagraph(reference).toJSON());
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    });

    it.each(references)('round-trips $target / $heading / $alias in a table cell', (reference) => {
      const markdown = serializeMarkdown({ frontmatter: null, doc: inTable(reference) });
      const parsed = parseMarkdown(markdown).doc;

      expect(parsed.toJSON()).toEqual(inTable(reference).toJSON());
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    });

    it('escapes only what would end or split the reference', () => {
      expect(serializeMarkdown({ frontmatter: null, doc: inParagraph(references[0]!) })).toBe(
        '[[C\\# notes]]\n',
      );
      expect(serializeMarkdown({ frontmatter: null, doc: inParagraph(references[5]!) })).toBe(
        '[[C:\\Users#H#1 \\[a\\] \\| b\\\\|p\\|q\\\\]]\n',
      );
    });
  });

  it('writes a callout type that is not one word so it reads back as a callout', () => {
    const doc = (type: string) =>
      schema.node('doc', null, [
        schema.node('callout', { type, title: 'T' }, [
          schema.node('paragraph', null, [schema.text('Body')]),
        ]),
      ]);

    const markdown = serializeMarkdown({ frontmatter: null, doc: doc('my type') });
    expect(markdown).toBe('> [!my-type] T\n> Body\n');
    expect(parseMarkdown(markdown).doc.toJSON()).toEqual(doc('my-type').toJSON());
    expect(serializeMarkdown({ frontmatter: null, doc: doc(' a]b ') })).toBe(
      '> [!a-b] T\n> Body\n',
    );
    expect(serializeMarkdown({ frontmatter: null, doc: doc('') })).toBe('> [!note] T\n> Body\n');
  });

  it('keeps ordinary prose punctuation unescaped', () => {
    const prose = '#tag at the start, AT&T, ~5 min, a == b, snake_case, 2 < 3\n';

    expect(roundTrip(prose)).toBe(prose);
  });

  it('escapes punctuation that would otherwise become markup', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('*a* ==b== [[c]] $d$ ~~e~~ <x@y.z>')]),
    ]);

    expect(serializeMarkdown({ frontmatter: null, doc })).toBe(
      '\\*a\\* \\==b\\== \\[\\[c]] \\$d\\$ \\~\\~e\\~\\~ \\<x@y.z>\n',
    );
  });

  it('escapes the whole run of = beside a highlight delimiter', () => {
    const highlight = schema.marks.highlight.create();
    const file = schema.node('attachment', { href: '../attachments/f00d.pdf', name: 'a.pdf' });
    const cases = [
      [schema.text('a ===', [highlight]), file],
      [schema.text('===a', [highlight])],
      [schema.text('x', [highlight]), schema.text('== y')],
    ];
    for (const content of cases) {
      const doc = schema.node('doc', null, [schema.node('paragraph', null, content)]);
      const markdown = serializeMarkdown({ frontmatter: null, doc });
      const parsed = parseMarkdown(markdown).doc;

      expect(parsed.toJSON()).toEqual(doc.toJSON());
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    }
  });

  it('escapes a == after escaped punctuation so it cannot close a highlight early', () => {
    // An escaped `` ` `` is still punctuation, so `` \`== `` before a space closes.
    const highlight = schema.marks.highlight.create();
    const docs = [...'`~*_[$'].map((punctuation) =>
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text(`a${punctuation}== b`, [highlight])]),
      ]),
    );
    for (const doc of docs) {
      const markdown = serializeMarkdown({ frontmatter: null, doc });
      const parsed = parseMarkdown(markdown).doc;

      expect(parsed.toJSON()).toEqual(doc.toJSON());
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    }
    expect(serializeMarkdown({ frontmatter: null, doc: docs[0]! })).toBe('==a\\`\\== b==\n');
  });

  it('escapes == and < against the text as written, not as typed', () => {
    const highlight = schema.marks.highlight.create();
    const italic = schema.marks.italic.create();
    const strike = schema.marks.strike.create();
    const cases: PMNode[][] = [
      // Whitespace at the inner edge of a span is written `&#x20;`; the `;` lets `==` close.
      [schema.text('a', [italic, highlight]), schema.text(' == a', [highlight])],
      [schema.text('a', [strike, highlight]), schema.text(' == a', [highlight])],
      // Line endings and spaces before them are written as references; `&` lets `==` open.
      [schema.text('a ==\n\na'), schema.text('a', [highlight])],
      [schema.text('a == \na', [highlight])],
      // Escaping one `=` of a longer run leaves a bare `==` beside an escaped `=`.
      [schema.text('a=== a', [highlight])],
      [schema.text('a=== a')],
      // `~` is escaped, so to-markdown skips the `<`; then `\~` is unescaped.
      [schema.text('<~@a>', [highlight])],
      [schema.text('x <~@a> y')],
    ];
    for (const content of cases) {
      const doc = schema.node('doc', null, [schema.node('paragraph', null, content)]);
      const markdown = serializeMarkdown({ frontmatter: null, doc });
      const parsed = parseMarkdown(markdown).doc;

      expect(parsed.toJSON()).toEqual(doc.toJSON());
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    }
  });

  it('leaves a < alone when no autolink could form across the next spans', () => {
    const code = schema.marks.code.create();
    const italic = schema.marks.italic.create();
    const cases: [PMNode[], string][] = [
      [[schema.text('List<'), schema.text('T', [code])], 'List<`T`\n'],
      [[schema.text('a<'), schema.text('x', [italic])], 'a<*x*\n'],
      [[schema.text('x<'), schema.node('inlineMath', { latex: 'y' })], 'x<$y$\n'],
      [[schema.text('<'), schema.text('@a', [code]), schema.text(' b>')], '<`@a` b>\n'],
    ];
    for (const [content, expected] of cases) {
      const doc = schema.node('doc', null, [schema.node('paragraph', null, content)]);
      expect(serializeMarkdown({ frontmatter: null, doc })).toBe(expected);
    }
  });

  it('escapes a < that would open an autolink closed inside a later span or after a mark', () => {
    const code = schema.marks.code.create();
    const italic = schema.marks.italic.create();
    const cases = [
      [schema.text('a<b', [italic]), schema.text('@c.d> e')],
      [schema.text('<x'), schema.text('y@host>', [code])],
    ];
    for (const content of cases) {
      const doc = schema.node('doc', null, [schema.node('paragraph', null, content)]);
      const markdown = serializeMarkdown({ frontmatter: null, doc });
      const parsed = parseMarkdown(markdown).doc;
      expect(parsed.toJSON()).toEqual(doc.toJSON());
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    }
  });

  it('escapes a < that an email autolink could join with the next span', () => {
    const code = schema.marks.code.create();
    const bold = schema.marks.bold.create();
    const cases = [
      [schema.text('<'), schema.text('@a>a', [code])],
      [schema.text('x <y'), schema.text('z', [bold]), schema.text('@a.b> c')],
    ];
    for (const content of cases) {
      const doc = schema.node('doc', null, [schema.node('paragraph', null, content)]);
      const markdown = serializeMarkdown({ frontmatter: null, doc });
      const parsed = parseMarkdown(markdown).doc;

      expect(parsed.textContent).toBe(doc.textContent);
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    }
    expect(roundTrip('a < b `c`\n')).toBe('a < b `c`\n');
  });

  it('escapes a < in link text that an email autolink could join with the next span', () => {
    const link = schema.marks.link.create({ href: 'https://example.com/a' });
    const italic = schema.marks.italic.create();
    const bold = schema.marks.bold.create();
    const cases = [
      [schema.text('<', [italic, link]), schema.text('@a>', [link]), schema.text('a')],
      [schema.text('<', [link]), schema.text('@a>', [bold, link])],
    ];
    for (const content of cases) {
      const doc = schema.node('doc', null, [schema.node('paragraph', null, content)]);
      const markdown = serializeMarkdown({ frontmatter: null, doc });
      const parsed = parseMarkdown(markdown).doc;

      expect(parsed.toJSON()).toEqual(doc.toJSON());
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    }
  });

  describe('a leading link that markdown would read as a reference definition (#44)', () => {
    const link = schema.marks.link.create({ href: 'https://example.com/a' });
    const code = schema.marks.code.create();
    const file = schema.node('attachment', { href: '../attachments/f00d.pdf', name: 'a.pdf' });
    const paragraph = (...content: PMNode[]) => schema.node('paragraph', null, content);
    const wrap = {
      paragraph: (p: ReturnType<typeof paragraph>) => [p],
      'list item': (p: ReturnType<typeof paragraph>) => [
        schema.node('bulletList', null, [schema.node('listItem', null, [p])]),
      ],
      'task item': (p: ReturnType<typeof paragraph>) => [
        schema.node('taskList', null, [schema.node('taskItem', null, [p])]),
      ],
      quote: (p: ReturnType<typeof paragraph>) => [schema.node('blockquote', null, [p])],
      callout: (p: ReturnType<typeof paragraph>) => [schema.node('callout', null, [p])],
    };

    it.each(Object.keys(wrap) as (keyof typeof wrap)[])(
      'keeps inline code with `]:` in a link at the start of a %s',
      (where) => {
        const doc = schema.node(
          'doc',
          null,
          wrap[where](paragraph(schema.text(']:a', [link, code]), file)),
        );
        const markdown = serializeMarkdown({ frontmatter: null, doc });
        const parsed = parseMarkdown(markdown).doc;

        expect(markdown).toContain('[\\]`:a`](https://example.com/a)');
        expect(parsed.textContent).toBe(doc.textContent);
        expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
        let raw = false;
        parsed.descendants((node) => void (raw ||= node.type.name === 'rawMarkdown'));
        expect(raw).toBe(false);
      },
    );

    it('guards every `]:` in the label, not just the first, and leaves other code alone', () => {
      const doc = schema.node('doc', null, [
        paragraph(schema.text('x]:]:y', [link, code]), schema.text(' tail ]: `z`')),
      ]);
      const markdown = serializeMarkdown({ frontmatter: null, doc });

      expect(markdown).toBe('[`x`\\]`:`\\]`:y`](https://example.com/a) tail ]: \\`z\\`\n');
      expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
      expect(parseMarkdown(markdown).doc.textContent).toBe(doc.textContent);
    });

    it('guards inline math with `]:` in a leading link', () => {
      const doc = schema.node('doc', null, [
        schema.node('paragraph', null, [schema.node('inlineMath', { latex: 'a]:b' }).mark([link])]),
      ]);
      const markdown = serializeMarkdown({ frontmatter: null, doc });
      const parsed = parseMarkdown(markdown).doc;

      expect(parsed.firstChild?.type.name).toBe('paragraph');
      expect(serializeMarkdown({ frontmatter: null, doc: parsed })).toBe(markdown);
    });

    it('leaves a leading link alone when its label cannot end in `]:`', () => {
      const safe = [
        '[`]x`](https://example.com/a)\n',
        '[`[]:`](https://example.com/a)\n',
        '[`x]`](https://example.com/a): y\n',
      ];
      for (const markdown of safe) expect(roundTrip(markdown)).toBe(markdown);
    });
  });

  it('keeps unmodified frontmatter byte for byte', () => {
    const source = '---\n# comment\ntitle:   "x"\ncustom: {a: 1}\n---\n\nBody\n';

    expect(roundTrip(source)).toBe(source);
  });

  it('keeps invalid frontmatter verbatim', () => {
    const source = '---\ntitle: [oops\n---\n\nBody\n';

    expect(parseFrontmatter('title: [oops\n').errors.length).toBeGreaterThan(0);
    expect(roundTrip(source)).toBe(source);
  });
});

describe('serializeMarkdown for the git mirror (T27)', () => {
  const sha = 'a'.repeat(64);
  const mirrorLinks: LinkResolver = {
    resolve: () => null,
    // The mirror writes each note's file name, which differs from a title it shares.
    linkText: (id) => ({ n1: 'Meeting (7KQ2MX)', n2: 'Plans' })[id] ?? null,
    title: (id) => ({ n1: 'Meeting', n2: 'Plans' })[id] ?? null,
  };

  it('writes a link whose file name differs from the title as [[name|Title]] (A10)', () => {
    const doc = parseMarkdown('See [[Meeting]], [[Plans#Q3]] and [[Meeting|the meeting]].', {
      links: { resolve: (t) => (t === 'Meeting' ? 'n1' : 'n2'), linkText: () => null },
    }).doc;

    expect(serializeMarkdown({ frontmatter: null, doc }, { links: mirrorLinks })).toBe(
      'See [[Meeting (7KQ2MX)|Meeting]], [[Plans#Q3]] and [[Meeting (7KQ2MX)|the meeting]].\n',
    );
  });

  it('writes an embed by file name alone: an alias means nothing on an embed', () => {
    const doc = parseMarkdown('![[Meeting#Notes]]', {
      links: { resolve: () => 'n1', linkText: () => null },
    }).doc;

    expect(serializeMarkdown({ frontmatter: null, doc }, { links: mirrorLinks })).toBe(
      '![[Meeting (7KQ2MX)#Notes]]\n',
    );
  });

  it('keeps a drawing as its SVG picture linked to its scene, both paths rewritten (PEN-28)', () => {
    const scene = 'b'.repeat(64);
    const drawing = `[![Drawing](attachments/${sha}.svg)](attachments/${scene}.excalidraw)`;
    const sized = `[![Drawing|480](attachments/${sha}.svg)](attachments/${scene}.excalidraw)`;
    const doc = parseMarkdown(`A sketch:\n\n${drawing}\n\n${sized}\n`).doc;
    // An image with a link mark: no node of its own, so every client keeps it.
    const image = doc.child(1).child(0);
    expect(image.type.name).toBe('image');
    expect(image.marks.map((mark) => [mark.type.name, mark.attrs['href'] as string])).toEqual([
      ['link', `attachments/${scene}.excalidraw`],
    ]);
    expect(serializeMarkdown({ frontmatter: null, doc })).toBe(
      `A sketch:\n\n${drawing}\n\n${sized}\n`,
    );
    expect(
      serializeMarkdown(
        { frontmatter: null, doc },
        { assetUrl: (url) => (url.startsWith('attachments/') ? `../${url}` : url) },
      ),
    ).toBe(
      `A sketch:\n\n[![Drawing](../attachments/${sha}.svg)](../attachments/${scene}.excalidraw)\n\n` +
        `[![Drawing|480](../attachments/${sha}.svg)](../attachments/${scene}.excalidraw)\n`,
    );
  });

  it('rewrites attachment paths through assetUrl, and nothing else', () => {
    const doc = parseMarkdown(
      `![Plan|300](attachments/${sha}.png) [spec](attachments/${sha}.pdf) [site](https://example.com/attachments/x.png)`,
    ).doc;
    const markdown = serializeMarkdown(
      { frontmatter: null, doc },
      { assetUrl: (url) => (url.startsWith('attachments/') ? `../../${url}` : url) },
    );

    expect(markdown).toBe(
      `![Plan|300](../../attachments/${sha}.png) [spec](../../attachments/${sha}.pdf) [site](https://example.com/attachments/x.png)\n`,
    );
  });
});
