/**
 * Tag descriptions in the WorkspaceDoc (PEN-68): kept by the tag's full path, each merging on its
 * own, so two devices describing two tags both keep theirs, and a device that never touches them
 * (Android's) keeps them through its own changes.
 */
import { TAG_DESCRIPTION_MAX } from '@penmoss/core/tags';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  createFolder,
  readTagDescriptions,
  readWorkspace,
  setTagDescription,
  WorkspaceError,
} from '../src/workspace';

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('tag descriptions', () => {
  it('are kept by full path, as typed, and an empty one removes the entry', () => {
    const doc = new Y.Doc();
    expect(readWorkspace(doc).tagDescriptions).toBeUndefined();
    setTagDescription(doc, 'project/penmoss', 'The notes app. ');
    setTagDescription(doc, 'project', 'Work with an end.');
    expect(readTagDescriptions(doc)).toEqual({
      'project/penmoss': 'The notes app. ',
      project: 'Work with an end.',
    });
    expect(readWorkspace(doc).tagDescriptions).toEqual(readTagDescriptions(doc));
    setTagDescription(doc, 'project', '  \n ');
    expect(readTagDescriptions(doc)).toEqual({ 'project/penmoss': 'The notes app. ' });
    setTagDescription(doc, 'project/penmoss', '');
    expect(readWorkspace(doc).tagDescriptions).toBeUndefined();
  });

  it('cut a long description and refuse what is not a tag', () => {
    const doc = new Y.Doc();
    setTagDescription(doc, 'long', 'x'.repeat(TAG_DESCRIPTION_MAX + 50));
    expect(readTagDescriptions(doc)['long']).toHaveLength(TAG_DESCRIPTION_MAX);
    expect(() => setTagDescription(doc, '#Project', 'x')).toThrow(WorkspaceError);
    expect(() => setTagDescription(doc, 'two words', 'x')).toThrow(WorkspaceError);
  });

  it('merge across devices, and survive changes on a device that never reads them', () => {
    const mac = new Y.Doc();
    const phone = new Y.Doc();
    sync(mac, phone);
    setTagDescription(mac, 'garden', 'Plants and the plot.');
    setTagDescription(phone, 'reading', 'Books to read.');
    sync(mac, phone);
    // The phone files a folder and syncs: the Mac's description is still there on both.
    createFolder(phone, { id: 'f1', name: 'Inbox', parentId: null });
    sync(mac, phone);
    for (const doc of [mac, phone]) {
      expect(readTagDescriptions(doc)).toEqual({
        garden: 'Plants and the plot.',
        reading: 'Books to read.',
      });
    }
    // A fresh device built only from the merged state has them too.
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(phone));
    expect(readTagDescriptions(fresh)['garden']).toBe('Plants and the plot.');
  });

  it('change nothing when set to what they are', () => {
    const doc = new Y.Doc();
    setTagDescription(doc, 'a', 'one');
    let updates = 0;
    doc.on('update', () => updates++);
    setTagDescription(doc, 'a', 'one');
    setTagDescription(doc, 'b', '');
    expect(updates).toBe(0);
  });
});
