import { parseMarkdown, schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import { markSpecs, nodeSpecs } from '@penmoss/core/schema';
import { NOTE_ROOT } from '@penmoss/sync-client';
import { setBody } from '@penmoss/sync-client/history';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { pmnodeToDelta } from '@y/prosemirror';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentMarkdown } from '../../core/test/support/agent-markdown';
import { createCollabEditor, UnsupportedContentError, type CollabEditor } from '../src/collab';
import { noteExtensions } from '../src/extensions';

// A157–A159: a note an agent wrote can always be opened. Markdown the codec keeps verbatim
// (`rawMarkdown`, `rawInline`) has editor nodes; a node type this version does not know (one
// written by a newer version) never fails the open and is never overwritten.

const editors: CollabEditor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function open(replica: Yjs14Replica, onUnsupported?: (types: readonly string[]) => void) {
  const element = document.createElement('div');
  const collab = createCollabEditor({
    element,
    extensions: noteExtensions(),
    replica,
    ...(onUnsupported ? { onUnsupported } : {}),
  });
  editors.push(collab);
  return { collab, element };
}

/** A replica holding `doc` as the server writes it (the engine's `setBody`). */
function written(doc: PMNode): Yjs14Replica {
  const source = createYjs14Replica();
  setBody(source.doc, pmnodeToDelta(doc));
  const replica = createYjs14Replica();
  replica.applyUpdate(source.encodeStateAsUpdate(), 'remote');
  return replica;
}

function localWrites(replica: Yjs14Replica): Uint8Array[] {
  const writes: Uint8Array[] = [];
  replica.onUpdate((update, origin) => {
    if (origin !== 'remote') writes.push(update);
  });
  return writes;
}

const markdownOf = (collab: CollabEditor) =>
  serializeMarkdown({
    frontmatter: null,
    doc: coreSchema.nodeFromJSON(collab.editor.getJSON()),
  });

const AGENT_MARKDOWN = [
  '<div class="note">\nKept as written.\n</div>',
  'Press <kbd>K</kbd> to search.',
  '1. [ ] an ordered task\n2. a step',
  '<!-- a comment for the agent -->',
  'Text with a footnote[^1].',
  '[^1]: The footnote.',
].join('\n\n');

describe('raw markdown in the editor (A157)', () => {
  it('opens a note holding raw blocks and raw inline markdown, writing nothing', () => {
    const parsed = parseMarkdown(AGENT_MARKDOWN).doc;
    const names = new Set<string>();
    parsed.descendants((node) => void names.add(node.type.name));
    expect(names).toContain('rawMarkdown');
    expect(names).toContain('rawInline');

    const replica = written(parsed);
    const writes = localWrites(replica);
    const { collab } = open(replica);

    expect(collab.editor.getJSON()).toEqual(parsed.toJSON());
    expect(writes).toEqual([]);
    expect(markdownOf(collab)).toBe(serializeMarkdown({ frontmatter: null, doc: parsed }));
  });

  it('shows raw blocks and raw inline markdown visibly marked, as text', () => {
    const { element } = open(written(parseMarkdown(AGENT_MARKDOWN).doc));

    const blocks = [...element.querySelectorAll('pre[data-raw-markdown]')];
    expect(blocks.map((block) => block.textContent)).toContain(
      '<div class="note">\nKept as written.\n</div>',
    );
    expect(element.querySelector('pre[data-raw-markdown] div')).toBeNull();
    const inline = [...element.querySelectorAll('[data-raw-inline]')];
    expect(inline.map((node) => node.textContent)).toEqual(['<kbd>', '</kbd>', '[^1]']);
    expect(element.querySelector('kbd')).toBeNull();
  });

  it('edits a raw block as text, and writes it back as markdown', () => {
    const replica = written(parseMarkdown('Before\n\n<div>\nOld\n</div>\n\nAfter\n').doc);
    const { collab } = open(replica);
    let at = -1;
    collab.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'rawMarkdown') at = pos + 1 + node.textContent.indexOf('Old');
    });
    collab.editor.view.dispatch(
      collab.editor.state.tr.setSelection(TextSelection.create(collab.editor.state.doc, at + 3)),
    );
    collab.editor.commands.keyboardShortcut('Enter');
    collab.editor.commands.insertContent('New');

    expect(markdownOf(collab)).toBe('Before\n\n<div>\nOld\nNew\n</div>\n\nAfter\n');
    const other = createYjs14Replica();
    other.applyUpdate(replica.encodeStateAsUpdate());
    const { collab: second } = open(other);
    expect(markdownOf(second)).toBe('Before\n\n<div>\nOld\nNew\n</div>\n\nAfter\n');
  });

  // A159: what the server writes from any agent markdown binds as is: nothing the binding
  // fails on, drops or rewrites (it would write the rewrite back into the note).
  it('opens random agent markdown exactly as written, writing nothing', () => {
    fc.assert(
      fc.property(agentMarkdown, (markdown) => {
        const parsed = parseMarkdown(markdown).doc;
        const replica = written(parsed);
        const writes = localWrites(replica);
        const { collab } = open(replica);
        expect(collab.editor.getJSON()).toEqual(parsed.toJSON());
        expect(writes).toEqual([]);
        collab.destroy();
        editors.pop();
      }),
      { numRuns: Number(globalThis.process?.env['PENMOSS_PROPERTY_RUNS'] ?? 100) },
    );
  }, 120_000);

  it('opens a mixed list an agent wrote as task and bullet lists', () => {
    const { collab } = open(written(parseMarkdown('- [ ] task\n- plain\n- [x] done\n').doc));

    expect(collab.editor.state.doc.children.map((node) => node.type.name)).toEqual([
      'taskList',
      'bulletList',
      'taskList',
    ]);
  });
});

/** A schema from a later version: core's, plus a block this version does not know. */
const later = new Schema({
  nodes: { ...nodeSpecs, futureBlock: { group: 'block', content: 'text*' } },
  marks: markSpecs,
});
const laterDoc = (text: string) =>
  later.node('doc', null, [
    later.node('paragraph', null, [later.text(text)]),
    later.node('blockquote', null, [later.node('futureBlock', null, [later.text('from later')])]),
  ]);

describe('node types this version does not know (A158)', () => {
  it('refuses to bind instead of failing half-way, naming the types and changing nothing', () => {
    const replica = written(laterDoc('Hello'));
    const before = replica.encodeStateAsUpdate();
    const writes = localWrites(replica);
    const element = document.createElement('div');

    let caught: unknown = null;
    try {
      editors.push(createCollabEditor({ element, extensions: noteExtensions(), replica }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnsupportedContentError);
    expect((caught as UnsupportedContentError).nodeTypes).toEqual(['futureBlock']);
    expect(writes).toEqual([]);
    expect(replica.encodeStateAsUpdate()).toEqual(before);
    // No editor was left mounted in the element.
    expect(element.querySelector('.ProseMirror')).toBeNull();
  });

  it('stops syncing, read-only, when such a node arrives while the note is open', () => {
    const source = createYjs14Replica();
    setBody(source.doc, pmnodeToDelta(parseMarkdown('Hello\n').doc));
    const replica = createYjs14Replica();
    replica.applyUpdate(source.encodeStateAsUpdate(), 'remote');
    const unsupported = vi.fn();
    const { collab } = open(replica, unsupported);
    const writes = localWrites(replica);

    setBody(source.doc, pmnodeToDelta(laterDoc('Hello')));
    expect(() =>
      replica.applyUpdate(source.encodeStateAsUpdate(replica.encodeStateVector()), 'remote'),
    ).not.toThrow();

    expect(unsupported).toHaveBeenCalledWith(['futureBlock']);
    expect(collab.editor.isEditable).toBe(false);
    // Nothing the editor does now reaches the replica, and the later block stays.
    collab.editor.commands.insertContentAt(1, 'typed ');
    collab.undo();
    expect(writes).toEqual([]);
    const names: string[] = [];
    const walk = (node: { name?: string; children?: { insert?: unknown }[] }) => {
      if (node.name) names.push(node.name);
      for (const op of node.children ?? []) {
        if (Array.isArray(op.insert)) for (const child of op.insert) walk(child as typeof node);
      }
    };
    walk(replica.doc.get(NOTE_ROOT).toDeltaDeep().toJSON() as never);
    expect(names).toContain('futureBlock');
  });
});
