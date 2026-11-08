import { describeSchema, schema as coreSchema } from '@penmoss/core/schema';
import { getSchema } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { NOTE_MARKS, NOTE_NODES, noteExtensions } from '../src/extensions';

interface Described {
  readonly name: string;
  readonly [field: string]: unknown;
}
interface SchemaDescription {
  readonly topNode: string;
  readonly nodes: readonly Described[];
  readonly marks: readonly Described[];
}

const byName = (items: readonly Described[]) => new Map(items.map((item) => [item.name, item]));

// A first slice of the schema-drift check (#14): the editor builds its model from core (A9).
describe('noteExtensions schema', () => {
  const editor = describeSchema(getSchema(noteExtensions())) as SchemaDescription;
  const core = describeSchema(coreSchema) as SchemaDescription;
  const coreNodes = byName(core.nodes);
  const coreMarks = byName(core.marks);

  it('has the same top node as core', () => {
    expect(editor.topNode).toBe(core.topNode);
  });

  it('produces exactly the T6 subset of nodes and marks', () => {
    expect(editor.nodes.map((node) => node.name).sort()).toEqual([...NOTE_NODES].sort());
    expect(editor.marks.map((mark) => mark.name).sort()).toEqual([...NOTE_MARKS].sort());
  });

  // A157: a node core has and the editor lacks makes every note holding it fail to open.
  it('has every node and mark core has, so anything the codec or server builds opens', () => {
    expect(editor.nodes.map((node) => node.name).sort()).toEqual(
      core.nodes.map((node) => node.name).sort(),
    );
    expect(editor.marks.map((mark) => mark.name).sort()).toEqual(
      core.marks.map((mark) => mark.name).sort(),
    );
  });

  it('starts with the same default block as core', () => {
    const firstBlock = (nodes: readonly Described[]) =>
      nodes.find(
        (node) => typeof node.group === 'string' && node.group.split(' ').includes('block'),
      )?.name;
    expect(firstBlock(editor.nodes)).toBe(firstBlock(core.nodes));
  });

  it('ranks marks in core order, so marks nest the same way', () => {
    const coreOrder = core.marks.map((mark) => mark.name).filter((name) => coreMarks.has(name));
    const supported = new Set<string>(NOTE_MARKS);
    expect(editor.marks.map((mark) => mark.name)).toEqual(
      coreOrder.filter((name) => supported.has(name)),
    );
  });

  it.each(NOTE_NODES)('node %s matches core (content, groups, flags, attributes)', (name) => {
    expect(byName(editor.nodes).get(name)).toEqual(coreNodes.get(name));
  });

  it.each(NOTE_MARKS)('mark %s matches core (inclusive, excludes, attributes)', (name) => {
    expect(byName(editor.marks).get(name)).toEqual(coreMarks.get(name));
  });

  it('accepts a core document using every supported type', () => {
    const doc = coreSchema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }, { type: 'italic' }] },
            { type: 'hardBreak' },
            {
              type: 'image',
              attrs: { src: 'attachments/a.png', alt: 'A', title: null, width: 300, height: null },
            },
            { type: 'text', text: 'x', marks: [{ type: 'code' }, { type: 'strike' }] },
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://example.com', title: null } }],
            },
          ],
        },
        { type: 'blockquote', content: [{ type: 'paragraph' }] },
        {
          type: 'orderedList',
          attrs: { start: 3, tight: false },
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
        },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [
                { type: 'paragraph' },
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
                },
              ],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'ts', meta: 'title="a.ts"' },
          content: [{ type: 'text', text: 'let a' }],
        },
        {
          type: 'callout',
          attrs: { type: 'faq', title: 'Why?', foldable: true, collapsed: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Because' }] }],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, align: 'center' },
                  content: [{ type: 'text', text: 'h' }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
                },
              ],
            },
          ],
        },
        { type: 'horizontalRule' },
      ],
    });
    const editorSchema = getSchema(noteExtensions());
    const roundTripped = editorSchema.nodeFromJSON(doc.toJSON());
    roundTripped.check();
    expect(roundTripped.toJSON()).toEqual(doc.toJSON());
  });
});
