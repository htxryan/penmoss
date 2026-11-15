import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { createNoteThread, readThreads } from '../src/comments';
import { initNote, NOTE_META, readIdentity, readTitle } from '../src/note';
import { NOTE_ROOT } from '../src/replica';
import {
  CONFLICT_SUFFIX,
  conflictCopy,
  copyNote,
  noteAttachmentPaths,
  recordFromDoc,
} from '../src/records';
import { frontmatterTags, setFrontmatterTag } from '../src/tags';
import { bodyJson, createYjs14Replica } from '../src/yjs14';
import { appendEmbed, appendLinkParagraph, appendParagraph } from './support/editing';

const IMAGE = `attachments/${'a'.repeat(64)}.png`;

function original() {
  const replica = createYjs14Replica();
  initNote(replica.doc, { id: 'orig', created: '2026-11-01T09:00:00-05:00', kind: 'note' }, 'Plan');
  // A note made before A1449 records its notebook (T43, A766); nothing reads it now.
  replica.doc.transact(() => replica.doc.get(NOTE_META).setAttr('notebook', 'nb1'));
  appendParagraph(replica, 'First line');
  appendLinkParagraph(replica, 'See ', { noteId: 'other', target: 'Other' }, '.');
  appendLinkParagraph(replica, 'And ', { noteId: 'outside', target: 'Outside' }, '.');
  appendEmbed(replica, { noteId: 'other', target: 'Other' });
  replica.doc.transact(() => {
    const image = new Y.Node('image');
    replica.doc.get(NOTE_ROOT).push([image]);
    image.setAttr('src', IMAGE);
    image.setAttr('alt', 'diagram');
  });
  setFrontmatterTag(replica.doc, 'work/plans', true);
  createNoteThread(replica.doc, {
    id: 'thread',
    author: { id: 'mac', kind: 'device', label: 'Mac' },
    at: 1,
    comment: { id: 'c1', body: 'Hi' },
  });
  const state = replica.encodeStateAsUpdate();
  replica.destroy();
  return state;
}

function read(update: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

describe('copyNote (T68: Duplicate, #227; another notebook, #230)', () => {
  it('copies the body and tags under a new id and title, without the comments', () => {
    const state = original();
    expect(readThreads(read(state))).toHaveLength(1);
    const record = copyNote(state, {
      title: 'Plan (copy)',
      id: 'copy1',
      now: new Date(2026, 10, 6),
    });
    const doc = read(record.update);
    expect(record.noteId).toBe('copy1');
    expect(readTitle(doc)).toBe('Plan (copy)');
    expect(readIdentity(doc)).toMatchObject({ id: 'copy1', kind: 'note' });
    expect(readIdentity(doc).created).toMatch(/^2026-11-06T/);
    expect(doc.get(NOTE_META).getAttr('notebook')).toBeUndefined();
    expect(frontmatterTags(doc)).toEqual(['work/plans']);
    expect(readThreads(doc)).toEqual([]);
    expect(bodyJson(doc)).toEqual(bodyJson(read(state)));
    expect(record.unsynced).toBe(true);
    expect(record.title).toBe('Plan (copy)');
  });

  it('leaves the frontmatter tags behind when told to, and the body as it is (A1353)', () => {
    const state = original();
    const doc = read(copyNote(state, { title: 'Plan', tags: false }).update);
    expect(frontmatterTags(doc)).toEqual([]);
    expect(bodyJson(doc)).toEqual(bodyJson(read(state)));
    // tags: true is the default's behaviour.
    const kept = read(copyNote(state, { title: 'Plan', tags: true }).update);
    expect(frontmatterTags(kept)).toEqual(['work/plans']);
  });

  it('points links to notes copied with it at their copies, and leaves the rest', () => {
    const record = copyNote(original(), {
      title: 'Plan',
      links: new Map([['other', 'other-copy']]),
    });
    const ids = record.links?.map((link) => link.noteId);
    expect(ids).toEqual(['other-copy', 'outside', 'other-copy']);
  });

  it('a conflict copy keeps the body under a new id and a marked title, and not the old notebook (A640)', () => {
    const state = original();
    const record = conflictCopy(state, { id: 'copy2', now: new Date(2026, 10, 6) });
    const doc = read(record.update);
    expect(record.noteId).toBe('copy2');
    expect(readTitle(doc)).toBe(`Plan${CONFLICT_SUFFIX}`);
    expect(readIdentity(doc)).toMatchObject({ id: 'copy2', kind: 'note' });
    expect(readIdentity(doc).created).toMatch(/^2026-11-06T/);
    expect(bodyJson(doc)).toEqual(bodyJson(read(state)));
    expect(doc.get(NOTE_META).getAttr('notebook')).toBeUndefined();
    expect(record.unsynced).toBe(true);
  });

  it('lists the attachments the body shows', () => {
    expect(noteAttachmentPaths(original())).toEqual([IMAGE]);
    const plain = createYjs14Replica();
    appendParagraph(plain, 'Nothing attached');
    expect(noteAttachmentPaths(recordFromDoc('p', plain.doc, { unsynced: false }).update)).toEqual(
      [],
    );
  });
});
