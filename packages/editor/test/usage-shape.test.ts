/**
 * A note's shape (PEN-177, AC5–AC7): every block kind's token, list items as blocks of their
 * own, a quote, a callout and a table as one block each, the caps, and nothing of the note's
 * words in any token. Runs in the web and Android editor builds (both run this package).
 */
import { BLOCK_PATTERN, capShape, eventProblem, isShape } from '@penmoss/core/analytics';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { blockTokens } from '../src/usage';
import { openEditor } from './support/editor';
import { h, li, p, ul, usageEditor } from './support/usage';

const text = (value: string): JSONContent => ({ type: 'text', text: value });
const SHA = 'ab'.repeat(32);

/** One block of every kind the editor has. */
const EVERY_KIND: JSONContent[] = [
  h(1, 'Weekly plan'),
  p('Water the plants in the morning.'),
  h(3, 'Lists'),
  ul(li('Buy milk', ul(li('Oat')))),
  { type: 'orderedList', content: [li('First')] },
  {
    type: 'taskList',
    content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('Call Sam')] }],
  },
  { type: 'blockquote', content: [p('To be'), p('or not')] },
  { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] },
  {
    type: 'callout',
    attrs: { kind: 'warning', title: '', fold: null },
    content: [p('Careful')],
  },
  { type: 'blockMath', attrs: { latex: 'e^{i\\pi}+1=0' } },
  { type: 'rawMarkdown', content: [text('<div>hi</div>')] },
  {
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          { type: 'tableHeader', content: [text('Name')] },
          { type: 'tableHeader', content: [text('Age')] },
        ],
      },
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [text('Ann')] },
          { type: 'tableCell', content: [text('42')] },
        ],
      },
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [text('Bo')] },
          { type: 'tableCell', content: [text('7')] },
        ],
      },
    ],
  },
  { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'attachments/cat.png' } }] },
  {
    type: 'paragraph',
    content: [
      {
        type: 'image',
        attrs: { src: `attachments/${SHA}.svg`, alt: 'Excalidraw Diagram' },
        marks: [{ type: 'link', attrs: { href: `attachments/${SHA}.excalidraw` } }],
      },
    ],
  },
  {
    type: 'paragraph',
    content: [
      { type: 'attachment', attrs: { href: 'attachments/report.pdf', name: 'report.pdf' } },
    ],
  },
  { type: 'embed', attrs: { noteId: null, target: 'Other note', heading: null, alias: null } },
  { type: 'horizontalRule' },
  p(),
];

const EVERY_TOKEN = [
  'h1:11',
  'p:32',
  'h3:5',
  'li.b.1:8',
  'li.b.2:3',
  'li.n.1:5',
  'li.t.1:8',
  'quote:11',
  'code:12',
  'callout:7',
  'math:12',
  'raw:13',
  'table.3x2:15',
  'image',
  'drawing',
  'file',
  'embed',
  'hr',
  'p:0',
];

describe('blockTokens (PEN-177)', () => {
  it('gives each block’s kind and length, in reading order', () => {
    const collab = openEditor(EVERY_KIND);
    const tokens = blockTokens(collab.editor.state.doc);
    expect(tokens).toEqual(EVERY_TOKEN);
    for (const token of tokens) expect(BLOCK_PATTERN.test(token), token).toBe(true);
  });

  it('holds no word of the note', () => {
    const tokens = blockTokens(openEditor(EVERY_KIND).editor.state.doc).join(' ');
    for (const word of [
      'Weekly',
      'plan',
      'milk',
      'Sam',
      'const',
      'cat',
      'report',
      'Other',
      'ts',
      'warning',
    ]) {
      expect(tokens).not.toContain(word);
    }
  });

  it('counts an inline link, formula, picture or break as one character', () => {
    const collab = openEditor([
      {
        type: 'paragraph',
        content: [
          text('ab'),
          { type: 'hardBreak' },
          { type: 'inlineMath', attrs: { latex: 'x^2' } },
          {
            type: 'wikilink',
            attrs: { noteId: null, target: 'Plans', heading: null, alias: null },
          },
          text('c'),
        ],
      },
    ]);
    expect(blockTokens(collab.editor.state.doc)).toEqual(['p:6']);
  });

  it('records a note open with the shape and the title’s length, and nothing else', () => {
    const { events } = usageEditor(EVERY_KIND);
    expect(events).toEqual([
      {
        name: 'open',
        props: { how: 'open', titleChars: 7, shape: EVERY_TOKEN },
        at: 0,
      },
    ]);
  });

  it('nests list depth up to 9, deeper ones recorded at 9', () => {
    let nested: JSONContent = ul(li('deep'));
    for (let i = 0; i < 11; i++) nested = ul(li('x', nested));
    // The editor keeps an empty paragraph after a list that ends the note.
    const tokens = blockTokens(openEditor([nested, p()]).editor.state.doc);
    expect(tokens).toHaveLength(13);
    expect(tokens.slice(0, 3)).toEqual(['li.b.1:1', 'li.b.2:1', 'li.b.3:1']);
    expect(tokens.slice(-5)).toEqual(['li.b.9:1', 'li.b.9:1', 'li.b.9:1', 'li.b.9:4', 'p:0']);
  });
});

describe('the shape’s caps (AC7)', () => {
  it('records the first 5,000 of 6,000 blocks, with more', () => {
    const blocks = Array.from({ length: 6000 }, (_, i) => p(`line ${i}`));
    const { events } = usageEditor(blocks);
    const open = events[0]!;
    expect(open.props['more']).toBe(true);
    const shape = open.props['shape'] as string[];
    expect(shape.length).toBeLessThanOrEqual(5000);
    expect(isShape(shape)).toBe(true);
    expect(eventProblem({ ...BASE, kind: 'note', name: 'open', props: open.props })).toBeNull();
  });

  it('stops a note of long tables at 32 KB', () => {
    const row = {
      type: 'tableRow',
      content: [{ type: 'tableCell', content: [text('x'.repeat(50))] }],
    };
    const table = { type: 'table', content: Array.from({ length: 12 }, () => row) };
    const blocks = Array.from({ length: 3000 }, () => table);
    const tokens = blockTokens(openEditor(blocks).editor.state.doc);
    expect(tokens[0]).toBe('table.12x1:600');
    const { shape, more } = capShape(tokens);
    expect(more).toBe(true);
    expect(JSON.stringify(shape).length).toBeLessThanOrEqual(32 * 1024);
  });
});

const BASE = {
  session: '0123456789abcdef',
  seq: 0,
  at: 1,
  client: 'mac',
  actor: 'person',
  version: '1.4.0',
  channel: 'stable',
  os: 'macos',
  osVersion: '26.1',
} as const;
