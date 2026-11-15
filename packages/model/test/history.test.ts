import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { restoreContent } from '../src/history';
import { initNote, isDeleted, readIdentity, readTitle, setDeleted, setTitle } from '../src/note';
import { NOTE_ROOT } from '../src/replica';
import { frontmatterTags, setFrontmatterTag } from '../src/tags';

function paragraph(doc: Y.Doc, index: number, text: string): void {
  const node = new Y.Node('paragraph');
  doc.get(NOTE_ROOT).insert(index, [node]);
  node.insert(0, text);
}

function paragraphs(doc: Y.Doc): string[] {
  return doc
    .get(NOTE_ROOT)
    .toArray()
    .map((node) => (node instanceof Y.Node ? node.toArray().join('') : String(node)));
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('restoring a version (T21)', () => {
  it('brings back body, title and tags as a new change, keeping identity and the trash flag', () => {
    const doc = new Y.Doc();
    initNote(doc, { id: '01NOTE', created: '2026-10-22T09:00:00-05:00', kind: 'note' }, 'Plan');
    paragraph(doc, 0, 'First idea');
    paragraph(doc, 1, 'Second idea');
    setFrontmatterTag(doc, 'garden', true);
    const version = new Y.Doc();
    Y.applyUpdate(version, Y.encodeStateAsUpdate(doc));

    setTitle(doc, 'Plan (rewritten)');
    doc.get(NOTE_ROOT).delete(1, 1);
    paragraph(doc, 1, 'Replacement');
    setFrontmatterTag(doc, 'garden', false);
    setFrontmatterTag(doc, 'house', true);
    setDeleted(doc, true);

    const before = Y.encodeStateVector(doc);
    expect(restoreContent(doc, version)).toBe(true);
    expect(readTitle(doc)).toBe('Plan');
    expect(paragraphs(doc)).toEqual(['First idea', 'Second idea']);
    expect(frontmatterTags(doc)).toEqual(['garden']);
    expect(readIdentity(doc)).toMatchObject({ id: '01NOTE', kind: 'note' });
    expect(isDeleted(doc)).toBe(true); // Trash is restored separately.
    // A new change on top of the history, not a reset: the old state is still a prefix.
    const change = Y.encodeStateAsUpdate(doc, before);
    expect(change.byteLength).toBeGreaterThan(2);
    // Restoring the same version again changes nothing.
    expect(restoreContent(doc, version)).toBe(false);
  });

  it('keeps unchanged blocks, so a concurrent edit to them on another device survives', () => {
    const server = new Y.Doc();
    initNote(server, { id: '01NOTE', created: '2026-10-22T09:00:00-05:00', kind: 'note' });
    paragraph(server, 0, 'Shopping list');
    paragraph(server, 1, 'Old ending');
    const version = new Y.Doc();
    Y.applyUpdate(version, Y.encodeStateAsUpdate(server));
    // Later: the ending is rewritten.
    server.get(NOTE_ROOT).delete(1, 1);
    paragraph(server, 1, 'New ending');

    const phone = new Y.Doc();
    sync(server, phone);
    // Offline on the phone: an edit to the first block, which the version shares.
    (phone.get(NOTE_ROOT).get(0) as Y.Node).insert(13, ': milk');

    restoreContent(server, version);
    expect(paragraphs(server)).toEqual(['Shopping list', 'Old ending']);
    sync(server, phone);
    expect(paragraphs(server)).toEqual(['Shopping list: milk', 'Old ending']);
    expect(paragraphs(phone)).toEqual(paragraphs(server));
  });

  it('restores formatting and nested blocks exactly', () => {
    const doc = new Y.Doc();
    const list = new Y.Node('bulletList');
    doc.get(NOTE_ROOT).insert(0, [list]);
    const item = new Y.Node('listItem');
    list.insert(0, [item]);
    const para = new Y.Node('paragraph');
    item.insert(0, [para]);
    para.insert(0, 'bold', { bold: {} });
    para.insert(4, ' plain');
    const version = new Y.Doc();
    Y.applyUpdate(version, Y.encodeStateAsUpdate(doc));
    para.format(0, 4, { bold: null });
    para.insert(10, ' more');
    restoreContent(doc, version);
    expect(doc.get(NOTE_ROOT).toDeltaDeep().toJSON()).toEqual(
      version.get(NOTE_ROOT).toDeltaDeep().toJSON(),
    );
  });
});
