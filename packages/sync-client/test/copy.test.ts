import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { createNoteThread, readThreads } from '../src/comments';
import { initNote, readIdentity, readNoteNotebook, readTitle } from '../src/note';
import { NOTE_ROOT } from '../src/replica';
import { copyNote, noteAttachmentPaths, recordFromDoc } from '../src/records';
import { frontmatterTags, setFrontmatterTag } from '../src/tags';
import { bodyJson, createYjs14Replica } from '../src/yjs14';
import { appendEmbed, appendLinkParagraph, appendParagraph } from './support/editing';

const IMAGE = `attachments/${'a'.repeat(64)}.png`;

function original() {
  const replica = createYjs14Replica();
  initNote(
    replica.doc,
    { id: 'orig', created: '2026-11-01T09:00:00-05:00', kind: 'note', notebook: 'nb1' },
    'Plan',
  );
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
    expect(readNoteNotebook(doc)).toBe('nb1');
    expect(frontmatterTags(doc)).toEqual(['work/plans']);
    expect(readThreads(doc)).toEqual([]);
    expect(bodyJson(doc)).toEqual(bodyJson(read(state)));
    expect(record.unsynced).toBe(true);
    expect(record.title).toBe('Plan (copy)');
  });

  it('leaves the frontmatter tags behind when told to, and the body as it is (A1353)', () => {
    const state = original();
    const doc = read(copyNote(state, { title: 'Plan', notebook: null, tags: false }).update);
    expect(frontmatterTags(doc)).toEqual([]);
    expect(bodyJson(doc)).toEqual(bodyJson(read(state)));
    // tags: true is the default's behaviour.
    const kept = read(copyNote(state, { title: 'Plan', tags: true }).update);
    expect(frontmatterTags(kept)).toEqual(['work/plans']);
  });

  it('points links to notes copied with it at their copies, and leaves the rest', () => {
    const record = copyNote(original(), {
      title: 'Plan',
      notebook: null,
      links: new Map([['other', 'other-copy']]),
    });
    const doc = read(record.update);
    expect(readNoteNotebook(doc)).toBeNull();
    const ids = record.links?.map((link) => link.noteId);
    expect(ids).toEqual(['other-copy', 'outside', 'other-copy']);
  });

  it('lists the attachments the body shows', () => {
    expect(noteAttachmentPaths(original())).toEqual([IMAGE]);
    const plain = createYjs14Replica();
    appendParagraph(plain, 'Nothing attached');
    expect(
      noteAttachmentPaths(recordFromDoc('p', plain.doc, { epoch: null, unsynced: false }).update),
    ).toEqual([]);
  });
});
