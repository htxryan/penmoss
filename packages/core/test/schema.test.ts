import { Schema } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { describeSchema, markSpecs, nodeSpecs, schema } from '../src/schema';

describe('schema', () => {
  it('defines every v1 block node', () => {
    const blocks = [
      'paragraph',
      'heading',
      'blockquote',
      'bulletList',
      'orderedList',
      'listItem',
      'taskList',
      'taskItem',
      'codeBlock',
      'horizontalRule',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
      'callout',
      'blockMath',
      'embed',
      'rawMarkdown',
    ];
    for (const name of blocks) {
      expect(schema.nodes[name], name).toBeDefined();
    }
  });

  it('defines every v1 inline node as inline', () => {
    for (const name of [
      'text',
      'hardBreak',
      'image',
      'inlineMath',
      'wikilink',
      'attachment',
      'rawInline',
    ]) {
      expect(schema.nodes[name]?.isInline, name).toBe(true);
    }
  });

  it('defines the marks in nesting order, link outermost and code innermost', () => {
    expect(Object.keys(schema.marks)).toEqual([
      'link',
      'italic',
      'bold',
      'strike',
      'highlight',
      'code',
    ]);
  });

  it('builds a valid document with a checked task item', () => {
    const doc = schema.node('doc', null, [
      schema.node('taskList', null, [
        schema.node('taskItem', { checked: true }, [
          schema.node('paragraph', null, [schema.text('done')]),
        ]),
      ]),
    ]);

    expect(() => doc.check()).not.toThrow();
    expect(doc.firstChild?.firstChild?.attrs['checked']).toBe(true);
  });

  it('rejects a heading level outside 1–6', () => {
    expect(() => schema.node('heading', { level: 7 }).check()).toThrow();
  });

  it('keeps wikilink identity separate from its written target', () => {
    const link = schema.node('wikilink', { noteId: 'n1', target: 'Sync design' });

    expect(link.attrs).toEqual({
      noteId: 'n1',
      target: 'Sync design',
      heading: null,
      alias: null,
    });
  });

  it('exports specs that rebuild an identical schema (A9)', () => {
    const rebuilt = new Schema({ nodes: nodeSpecs, marks: markSpecs });

    expect(describeSchema(rebuilt)).toEqual(describeSchema(schema));
  });

  it('detects a schema that differs from the core schema', () => {
    const drifted = new Schema({
      nodes: { ...nodeSpecs, paragraph: { ...nodeSpecs.paragraph, content: 'text*' } },
      marks: markSpecs,
    });

    expect(describeSchema(drifted)).not.toEqual(describeSchema(schema));
  });
});
