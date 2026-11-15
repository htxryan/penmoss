/**
 * A note holding content from a newer Penmoss, read without an editor (A158, A159, A1493): the
 * agent edit engine, revert and the renders never take it for an empty note. Before A1493 an
 * agent's append planned on an empty body and diffed it over the note, deleting all of it.
 */
import { markSpecs, nodeSpecs } from '@penmoss/core/schema';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { setBody } from '@penmoss/sync-client/history';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { pmnodeToDelta } from '@y/prosemirror';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { applyPlan, baseConflict, planEdit, type EditOp } from '../src/edit-engine';
import {
  bodyMarkdown,
  mergedBodyDelta,
  noteBody,
  noteBodyForDisplay,
  readNoteState,
  UnsupportedContentError,
} from '../src/markdown';
import { revertChange } from '../src/revert';

/** A schema from a later version: core's, plus a block this version does not know. */
const later = new Schema({
  nodes: { ...nodeSpecs, futureBlock: { group: 'block', content: 'text*' } },
  marks: markSpecs,
});

const links = { resolve: () => null, linkText: () => null };

function docOf(body: PMNode): Y.Doc {
  const doc = new Y.Doc();
  setBody(doc, pmnodeToDelta(body));
  return doc;
}

/** A note a newer Penmoss wrote: a section, then a block this build does not know. */
function fromLater(): Y.Doc {
  return docOf(
    later.node('doc', null, [
      later.node('heading', { level: 2 }, [later.text('Plans')]),
      later.node('paragraph', null, [later.text('Keep me')]),
      later.node('futureBlock', null, [later.text('from later')]),
    ]),
  );
}

const bodyOf = (doc: Y.Doc) => JSON.stringify(doc.get(NOTE_ROOT).toDeltaDeep().toJSON());

/** Plans `op` and applies it when planning allows it, as every host does. */
function edit(doc: Y.Doc, op: EditOp) {
  const plan = planEdit(doc, op, links);
  if (plan.ok) doc.transact(() => applyPlan(doc, plan));
  return plan;
}

const BODY_EDITS: Array<[string, EditOp]> = [
  ['append', { op: 'append', markdown: 'Appended' }],
  ['append under a heading', { op: 'append', markdown: 'Appended', heading: 'Plans' }],
  ['section replace', { op: 'section', heading: 'Plans', markdown: 'New', mode: 'replace' }],
  ['section prepend', { op: 'section', heading: 'Plans', markdown: 'New', mode: 'prepend' }],
  ['section append', { op: 'section', heading: 'Plans', markdown: 'New', mode: 'append' }],
  ['replace', { op: 'replace', find: 'Keep me', replace: 'Changed', all: false }],
  [
    'replace all in markdown',
    { op: 'replace', find: 'e', replace: 'E', all: true, scope: 'markdown' },
  ],
  ['capture', { op: 'capture', markdown: 'Captured', time: '09:30' }],
  ['capture with no time', { op: 'capture', markdown: 'Captured', time: null }],
];

describe('a body from a newer Penmoss, read headless (A1493)', () => {
  it('is null to noteBody, its text to noteBodyForDisplay, and named in the note state', () => {
    const doc = fromLater();
    expect(noteBody(doc)).toBeNull();
    const display = noteBodyForDisplay(doc);
    expect(display.content.content.map((block) => block.textContent)).toEqual([
      'Plans',
      'Keep me',
      'from later',
    ]);
    const state = readNoteState(doc);
    expect(state.unsupported).toEqual(['futureBlock']);
    expect(state.body.textContent).toContain('from later');
    // A note this build reads is as before.
    const plain = docOf(
      later.node('doc', null, [later.node('paragraph', null, [later.text('Hi')])]),
    );
    expect(noteBody(plain)?.textContent).toBe('Hi');
    expect(readNoteState(plain).unsupported).toBeNull();
    expect(readNoteState(new Y.Doc()).unsupported).toBeNull();
  });

  it.each(BODY_EDITS)('refuses %s with 409 unsupported_content and changes nothing', (_, op) => {
    const doc = fromLater();
    const before = bodyOf(doc);
    const update = Y.encodeStateAsUpdate(doc);
    expect(edit(doc, op)).toEqual({
      ok: false,
      status: 409,
      code: 'unsupported_content',
      message:
        'This note holds content from a newer Penmoss; update Penmoss to edit it. Nothing was changed.',
      details: { nodeTypes: ['futureBlock'] },
    });
    expect(bodyOf(doc)).toBe(before);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(update);
    expect(bodyOf(doc)).toContain('from later');
  });

  it('still sets the title and tags, leaving the body as it is', () => {
    const doc = fromLater();
    const before = bodyOf(doc);
    expect(edit(doc, { op: 'properties', title: 'Renamed', tags: ['work'] }).ok).toBe(true);
    expect(edit(doc, { op: 'tag', add: ['later'], remove: [] }).ok).toBe(true);
    expect(readNoteState(doc)).toMatchObject({ title: 'Renamed', listedTags: ['later', 'work'] });
    expect(bodyOf(doc)).toBe(before);
  });

  it('leaves the refusal to planning when the live body cannot be read', () => {
    const live = fromLater();
    const base = docOf(later.node('doc', null, [later.node('paragraph', null, [later.text('x')])]));
    for (const [, op] of BODY_EDITS) expect(baseConflict(base, live, op, links)).toBeNull();
  });

  it('refuses to revert a change into a body it cannot read, before writing anything', () => {
    const live = fromLater();
    const after = new Y.Doc();
    Y.applyUpdate(after, Y.encodeStateAsUpdate(live));
    const before = docOf(
      later.node('doc', null, [later.node('paragraph', null, [later.text('Old')])]),
    );
    const was = Y.encodeStateAsUpdate(live);
    expect(() => live.transact(() => revertChange(live, before, after))).toThrow(
      UnsupportedContentError,
    );
    expect(Y.encodeStateAsUpdate(live)).toEqual(was);
    expect(() => mergedBodyDelta(bodyMarkdown(before), [live, before])).toThrow(
      UnsupportedContentError,
    );
  });
});
