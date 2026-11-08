import fc from 'fast-check';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema';

/**
 * fast-check arbitraries for random Penmoss documents built from the schema.
 * Text deliberately includes markdown punctuation and non-ASCII characters so
 * the serialiser's escaping is exercised.
 */

const TEXT_CHARS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...'      ',
  ...'*_[]#&=~`<>!|$\\-+.:(){}"\'/^%@,;?',
  ...'éßøñ中文字🙂—’',
  '\n',
];
/** Includes the characters wikilinks must escape (`\ [ ] | #`). */
const TITLE_CHARS = [...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ0123456789-—éñ中\\[]|#'];
/** Includes `|` and `\\`: a pipe in a table cell's formula must be escaped (`\\|`). */
const LATEX_CHARS = [...'abcxyz0123456789^_{}+-=|\\'];
const CODE_CHARS = [...'abc xyz012{}()<>[]*_`~#$=|\\;:.\n\n'];

const text = (chars: string[], maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...chars), minLength: 1, maxLength });

const trimmedTitle = text(TITLE_CHARS, 16)
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const href = fc.constantFrom(
  'https://example.com/a',
  'https://example.com/b_c?x=1&y=2',
  '../notes/other.md',
);

const MARK_NAMES = ['link', 'bold', 'italic', 'strike', 'highlight', 'code'] as const;

const marks: fc.Arbitrary<Mark[]> = fc
  .record({
    names: fc.subarray([...MARK_NAMES], { maxLength: 3 }),
    href,
  })
  .map(({ names, href }) =>
    names.map((name) =>
      name === 'link' ? schema.marks.link.create({ href }) : schema.marks[name].create(),
    ),
  );

const textNode = fc
  .record({ value: text(TEXT_CHARS, 14), marks })
  // Inline code is single-line: line endings in it become spaces (a documented normalisation).
  .map(({ value, marks }) =>
    schema.text(
      marks.some((mark) => mark.type.name === 'code') ? value.replace(/\n/g, ' ') : value,
      marks,
    ),
  );

const reference = fc.record({
  target: trimmedTitle,
  heading: fc.option(trimmedTitle, { nil: null }),
  alias: fc.option(trimmedTitle, { nil: null }),
});

const atoms: fc.Arbitrary<PMNode>[] = [
  reference.map((attrs) => schema.node('wikilink', { noteId: null, ...attrs })),
  fc
    .record({
      // Alt text ending in `|` plus digits is read as a size suffix (a documented limitation).
      alt: trimmedTitle.filter((alt) => !/\|\d+(?:x\d+)?$/.test(alt)),
      src: fc.constantFrom('attachments/a1.png', 'https://example.com/i.png'),
      width: fc.option(fc.integer({ min: 1, max: 2000 }), { nil: null }),
    })
    .map((attrs) => schema.node('image', attrs)),
  text(LATEX_CHARS, 10).map((latex) => schema.node('inlineMath', { latex })),
  trimmedTitle.map((name) =>
    schema.node('attachment', { href: '../attachments/f00d.pdf', name: `${name}.pdf` }),
  ),
];

function inlineContent(options: { breaks: boolean }): fc.Arbitrary<PMNode[]> {
  const items: fc.Arbitrary<PMNode>[] = [textNode, textNode, textNode, ...atoms];
  if (options.breaks) items.push(fc.constant(schema.node('hardBreak')));
  // Normalisations covered by unit tests, not generated here: hard breaks at the
  // edges are dropped and adjacent inline formulas merge.
  return fc
    .array(fc.oneof(...items), { minLength: 1, maxLength: 8 })
    .map((nodes) =>
      nodes.filter(
        (node, index) =>
          !(node.type.name === 'inlineMath' && nodes[index - 1]?.type.name === 'inlineMath'),
      ),
    )
    .map(trimEdges)
    .filter(
      (nodes) =>
        nodes.length > 0 &&
        nodes[0]?.type.name !== 'hardBreak' &&
        nodes[nodes.length - 1]?.type.name !== 'hardBreak',
    );
}

/**
 * GFM reads `\\|` in a table cell as an escaped backslash and a column divider,
 * even inside inline code, so code ending in a backslash before `|` cannot be
 * written in a cell (a documented limitation).
 */
function withoutCodePipeEscape(node: PMNode): PMNode {
  if (!node.isText || !node.marks.some((mark) => mark.type.name === 'code')) return node;
  return schema.text((node.text ?? '').replace(/\\\|/g, '\\ |'), node.marks);
}

/** Headings and cells are one line: soft line breaks become spaces (a documented normalisation). */
function singleLine(nodes: PMNode[]): PMNode[] {
  return trimEdges(
    nodes.map((node) =>
      node.isText ? schema.text((node.text ?? '').replace(/\n/g, ' '), node.marks) : node,
    ),
  );
}

/** Markdown cannot keep whitespace at the edges of a text block (a documented normalisation). */
function trimEdges(nodes: PMNode[]): PMNode[] {
  const out = [...nodes];
  const trim = (index: number, pattern: RegExp): boolean => {
    const node = out[index];
    if (!node?.isText) return false;
    const text = (node.text ?? '').replace(pattern, '');
    if (text) out[index] = schema.text(text, node.marks);
    else out.splice(index, 1);
    return !text;
  };
  while (trim(0, /^\s+/));
  while (trim(out.length - 1, /\s+$/));
  return out;
}

const paragraph = inlineContent({ breaks: true }).map((content) =>
  schema.node('paragraph', null, content),
);

const leafBlocks: fc.Arbitrary<PMNode>[] = [
  paragraph,
  paragraph,
  paragraph,
  fc
    .record({ level: fc.integer({ min: 1, max: 6 }), content: inlineContent({ breaks: false }) })
    .map(({ level, content }) => schema.node('heading', { level }, singleLine(content)))
    .filter((heading) => heading.childCount > 0),
  fc
    .record({
      language: fc.constantFrom(null, 'ts', 'mermaid', 'python'),
      code: text(CODE_CHARS, 40),
    })
    .map(({ language, code }) => schema.node('codeBlock', { language }, [schema.text(code)])),
  text(LATEX_CHARS, 20).map((latex) => schema.node('blockMath', { latex })),
  fc.constant(schema.node('horizontalRule')),
  reference.map((attrs) => schema.node('embed', { noteId: null, ...attrs })),
  fc
    .record({
      columns: fc.integer({ min: 1, max: 3 }),
      rows: fc.integer({ min: 1, max: 3 }),
      cells: fc.infiniteStream(inlineContent({ breaks: true })),
      align: fc.infiniteStream(fc.constantFrom(null, 'left', 'center', 'right')),
    })
    .map(({ columns, rows, cells, align }) => {
      const aligns = Array.from({ length: columns }, () => align.next().value as string | null);
      return schema.node(
        'table',
        null,
        Array.from({ length: rows + 1 }, (_, row) =>
          schema.node(
            'tableRow',
            null,
            aligns.map((cellAlign) =>
              schema.node(
                row === 0 ? 'tableHeader' : 'tableCell',
                { align: cellAlign },
                singleLine((cells.next().value as PMNode[]).map(withoutCodePipeEscape)),
              ),
            ),
          ),
        ),
      );
    }),
];

const { block } = fc.letrec<{ block: PMNode; list: PMNode }>((tie) => ({
  block: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    ...leafBlocks,
    fc
      .array(tie('block'), { minLength: 1, maxLength: 3 })
      .map((children) => schema.node('blockquote', null, children)),
    fc
      .record({
        // `my type` is written `my-type` (a documented normalisation).
        type: fc.constantFrom('note', 'warning', 'todo', 'my-type'),
        title: fc.option(trimmedTitle, { nil: '' }),
        fold: fc.constantFrom('', '+', '-'),
        children: fc.array(tie('block'), { minLength: 1, maxLength: 3 }),
      })
      .map(({ type, title, fold, children }) =>
        schema.node(
          'callout',
          { type, title, foldable: fold !== '', collapsed: fold === '-' },
          children,
        ),
      ),
    tie('list'),
  ),
  list: fc
    .record({
      kind: fc.constantFrom('bulletList', 'orderedList', 'taskList'),
      tight: fc.boolean(),
      start: fc.integer({ min: 0, max: 20 }),
      items: fc.array(
        fc.record({
          first: paragraph,
          rest: fc.array(tie('block'), { maxLength: 2 }),
          checked: fc.boolean(),
        }),
        { minLength: 1, maxLength: 3 },
      ),
    })
    .map(({ kind, tight, start, items }) => {
      const itemType = kind === 'taskList' ? 'taskItem' : 'listItem';
      const attrs = kind === 'orderedList' ? { tight, start } : { tight };
      return schema.node(
        kind,
        attrs,
        items.map(({ first, rest, checked }) =>
          schema.node(itemType, itemType === 'taskItem' ? { checked } : null, [first, ...rest]),
        ),
      );
    }),
}));

export const documentArbitrary: fc.Arbitrary<PMNode> = fc
  .array(block, { minLength: 1, maxLength: 6 })
  .map((blocks) => schema.node('doc', null, blocks));

/**
 * Every piece of user-visible content in document order: text (hard breaks as
 * newlines) and the content-bearing attributes of atoms. Markup is ignored.
 */
export function contentOf(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.isText) out.push(node.text ?? '');
    else if (node.type.name === 'hardBreak') out.push('\n');
    else if (node.type.name === 'image') out.push(`img:${node.attrs['alt']}:${node.attrs['src']}`);
    else if (node.type.name === 'inlineMath' || node.type.name === 'blockMath') {
      out.push(`math:${node.attrs['latex']}`);
    } else if (node.type.name === 'wikilink' || node.type.name === 'embed') {
      const { target, heading, alias } = node.attrs;
      out.push(`${node.type.name}:${target}#${heading}|${alias}`);
    } else if (node.type.name === 'attachment') out.push(`file:${node.attrs['name']}`);
    return true;
  });
  // Adjacent text pieces may be split or merged differently by marks; compare the joined text.
  return out.reduce<string[]>((acc, piece) => {
    const last = acc.length - 1;
    if (last >= 0 && !isAtom(acc[last]!) && !isAtom(piece)) acc[last] += piece;
    else acc.push(piece);
    return acc;
  }, []);
}

function isAtom(piece: string): boolean {
  return /^(img|math|wikilink|embed|file):/.test(piece);
}
