import 'fake-indexeddb/auto';
import * as Y from '@y/y';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredAttachment } from '../../../src/store/attachment-store';
import {
  ATTACHMENT_BYTES_STORE,
  ATTACHMENTS_STORE,
  DB_VERSION,
  META_STORE,
  NOTES_STORE,
  NoteStore,
  STATE_STORE,
  toMeta,
  type NoteRecord,
  type UnloadWrite,
} from '../../../src/store/idb';
import { recordFromDoc } from '@penmoss/model/records';
import { UNLOAD_MAX_CHARS } from '../../../src/store/unload';
import { setDeleted } from '@penmoss/model/note';
import { NOTE_ROOT } from '@penmoss/model/replica';
import { setFrontmatterTag } from '@penmoss/model/tags';
import { createFolder, renameFolder, WORKSPACE_RECORD_KEY } from '@penmoss/model/workspace';
import { appendParagraph, createReplica } from '../../../../../packages/model/test/support/editing';
import { seedRecords } from './support/seed';
import { MemoryStorage } from './support/storage';

let dbCount = 0;
const stores: NoteStore[] = [];

async function openFresh(): Promise<NoteStore> {
  const store = await NoteStore.open(`penmoss-test-${++dbCount}`);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** The keys of one object store, read from the database itself. */
async function keysOf(name: string, storeName: string): Promise<IDBValidKey[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('read failed'));
    });
  } finally {
    db.close();
  }
}

function record(noteId: string, overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    noteId,
    engine: 'yjs14',
    update: new Uint8Array([1, 2, 3]),
    stateVector: new Uint8Array([0]),
    text: `Title of ${noteId}\nbody`,
    updatedAt: 1_700_000_000_000,
    unsynced: false,
    ...overrides,
  };
}

describe('NoteStore', () => {
  it('keeps every note in one object store, next to a small state store', async () => {
    const store = await openFresh();
    expect(store.objectStoreNames().sort()).toEqual(
      [ATTACHMENT_BYTES_STORE, ATTACHMENTS_STORE, META_STORE, NOTES_STORE, STATE_STORE].sort(),
    );
  });

  it('keeps small state values beside the notes', async () => {
    const store = await openFresh();
    expect(await store.getState('tagRenames')).toBeUndefined();
    await store.setState('tagRenames', [{ from: 'a', to: 'b' }]);
    expect(await store.getState('tagRenames')).toEqual([{ from: 'a', to: 'b' }]);
    await store.setState('tagRenames', undefined);
    expect(await store.getState('tagRenames')).toBeUndefined();
  });

  it('keeps note metadata in its own store, in step with every write', async () => {
    const store = await openFresh();
    await store.put(record('n1', { update: new Uint8Array(10_000) }));
    await store.update('n1', (current) => ({ ...current!, unsynced: true }));
    await store.update('n2', () => record('n2'));
    await store.put(record('n3'));
    await store.delete('n3');
    const metas = await store.listMeta();
    expect(metas).toEqual([
      toMeta({ ...record('n1', { update: new Uint8Array(10_000) }), unsynced: true }),
      toMeta(record('n2')),
    ]);
    // listMeta reads only the small store.
    expect(await keysOf(store.name, META_STORE)).toEqual(['n1', 'n2']);
  });

  describe('attachments', () => {
    const attachment = (
      sha256: string,
      extra: Partial<StoredAttachment> = {},
    ): StoredAttachment => ({
      sha256,
      type: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      size: 3,
      createdAt: 1,
      ...extra,
    });

    it('stores an attachment once, its bytes apart from its metadata', async () => {
      const store = await openFresh();
      expect(await store.saveAttachment(attachment('a'))).toBe(true);
      expect(await store.saveAttachment(attachment('a', { createdAt: 2 }))).toBe(false);
      expect(await store.getAttachment('a')).toEqual(attachment('a'));
      expect(await keysOf(store.name, ATTACHMENTS_STORE)).toEqual(['a']);
      expect(await keysOf(store.name, ATTACHMENT_BYTES_STORE)).toEqual(['a']);
    });

    it('replaces the bytes when the file is added again, so a damaged copy is repaired', async () => {
      const store = await openFresh();
      await store.saveAttachment(attachment('a', { bytes: new Uint8Array([9, 9, 9]) }));
      expect(await store.saveAttachment(attachment('a'))).toBe(false);
      expect((await store.getAttachment('a'))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    });
  });

  it('reads, changes and writes a record in one transaction', async () => {
    const store = await openFresh();
    await store.put(record('n1', { text: 'one' }));
    // Two writers that each read and extend the record: neither change is lost.
    const append = (suffix: string) =>
      store.update('n1', (current) => ({ ...current!, text: `${current!.text}${suffix}` }));
    await Promise.all([append(' two'), append(' three')]);
    expect((await store.get('n1'))?.text).toBe('one two three');

    expect(await store.update('n1', () => null)).toBeNull();
    expect((await store.get('n1'))?.text).toBe('one two three');
    await store.update('n2', (current) => (current ? null : record('n2')));
    expect(await store.keys()).toEqual(['n1', 'n2']);
  });

  it('aborts the transaction when the change throws', async () => {
    const store = await openFresh();
    await store.put(record('n1', { text: 'kept' }));
    await expect(
      store.update('n1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await store.get('n1'))?.text).toBe('kept');
  });

  it('reports a blocked upgrade and opens once the old connection closes', async () => {
    const name = `penmoss-blocked-${++dbCount}`;
    // An old tab without a versionchange handler holds version 1 open.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(NOTES_STORE, { keyPath: 'noteId' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open failed'));
    });
    const onBlocked = vi.fn();
    const opening = NoteStore.open(name, { onBlocked });
    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1));
    old.close();
    const store = await opening;
    stores.push(store);
    expect(store.objectStoreNames()).toContain(STATE_STORE);
  });

  it('lets a newer version upgrade: saves, then closes its connection', async () => {
    const name = `penmoss-versionchange-${++dbCount}`;
    const saved: string[] = [];
    const store = await NoteStore.open(name, {
      onVersionChange: async () => {
        await store.put(record('saved-before-close'));
        saved.push('done');
      },
    });
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, DB_VERSION + 1);
      // Blocked until the old connection has saved and closed; then it proceeds.
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open failed'));
    });
    expect(saved).toEqual(['done']);
    expect(store.isClosed).toBe(true);
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = newer.transaction(NOTES_STORE).objectStore(NOTES_STORE).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('read failed'));
    });
    expect(keys).toEqual(['saved-before-close']);
    newer.close();
  });

  it('round-trips a note record keyed by note id', async () => {
    const store = await openFresh();
    await store.put(record('n1'));
    await store.put(record('n2', { unsynced: true }));

    const loaded = await store.get('n1');
    expect(loaded).toEqual(record('n1'));
    expect(loaded?.update).toBeInstanceOf(Uint8Array);
    expect(await store.get('missing')).toBeUndefined();
    expect(await store.keys()).toEqual(['n1', 'n2']);
  });

  it('lists metadata without exposing document bytes', async () => {
    const store = await openFresh();
    await store.put(record('n1', { update: new Uint8Array(500), unsynced: true }));
    expect(await store.listMeta()).toEqual([
      {
        noteId: 'n1',
        engine: 'yjs14',
        title: 'Title of n1',
        excerpt: 'body',
        updatedAt: 1_700_000_000_000,
        unsynced: true,
        deleted: false,
        bytes: 500,
        tags: [],
      },
    ]);
  });

  it('lists the stored title and the body excerpt when the record has a title', async () => {
    const store = await openFresh();
    await store.put(record('n1', { title: '', text: 'First line\n\n  second   line' }));
    await store.put(record('n2', { title: 'Plans', text: '' }));
    const meta = await store.listMeta();
    expect(meta.map(({ title, excerpt }) => ({ title, excerpt }))).toEqual([
      { title: '', excerpt: 'First line second line' },
      { title: 'Plans', excerpt: '' },
    ]);
  });

  it('deletes notes', async () => {
    const store = await openFresh();
    await store.put(record('n1'));
    await store.delete('n1');
    expect(await store.keys()).toEqual([]);
  });

  it('says which records each committed write changed, for other windows (T45, A711)', async () => {
    const store = await openFresh();
    const writes: string[][] = [];
    const off = store.onWrite((ids) => writes.push([...ids]));
    await store.put(record('n1'));
    await store.put(record('n2'));
    await store.update('n1', (current) => (current ? { ...current, text: 'Changed' } : null));
    // An update that writes nothing, or throws, says nothing.
    await store.update('n1', () => null);
    await expect(
      store.update('n2', () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    await store.delete('n2');
    off();
    await store.put(record('n3'));
    expect(writes).toEqual([['n1'], ['n2'], ['n1'], ['n2']]);
  });

  it('reads one note’s metadata without its document', async () => {
    const store = await openFresh();
    await store.put(record('n1', { text: 'Plans\nfor the garden' }));
    expect(await store.getMeta('n1')).toEqual(
      toMeta(record('n1', { text: 'Plans\nfor the garden' })),
    );
    expect(await store.getMeta('missing')).toBeUndefined();
  });

  it('opens a 5,000-note store and lists its metadata (its time is a budget: idb.budget.test.ts)', async () => {
    const name = `penmoss-bench-${++dbCount}`;
    (await NoteStore.open(name)).close();
    await seedRecords(
      name,
      Array.from({ length: 5000 }, (_, i) =>
        record(`note-${String(i).padStart(5, '0')}`, {
          update: new Uint8Array(1500).fill(i % 256),
        }),
      ),
    );

    const store = await NoteStore.open(name);
    stores.push(store);
    expect(await store.listMeta()).toHaveLength(5000);
  });

  describe('changes kept as the page goes (A626, A640)', () => {
    let storage: MemoryStorage;
    beforeEach(() => {
      storage = new MemoryStorage();
      vi.stubGlobal('localStorage', storage);
    });
    afterEach(() => vi.unstubAllGlobals());

    async function named(name: string): Promise<NoteStore> {
      const store = await NoteStore.open(name);
      stores.push(store);
      return store;
    }

    /** A document holding these paragraphs, and its record. */
    function written(noteId: string, paragraphs: string[]) {
      const replica = createReplica();
      for (const text of paragraphs) appendParagraph(replica, text);
      return { replica, record: recordFromDoc(noteId, replica.doc, { unsynced: true }) };
    }

    /** What the page keeps: the replica's changes since `since` (a stored state vector). */
    function kept(
      noteId: string,
      replica: ReturnType<typeof createReplica>,
      since: Uint8Array | null,
      extra: Partial<UnloadWrite> = {},
    ): UnloadWrite {
      return {
        noteId,
        engine: 'yjs14',
        source: 'editor',
        update: since ? replica.encodeStateAsUpdate(since) : replica.encodeStateAsUpdate(),
        whole: since === null,
        unsynced: true,
        updatedAt: 1_700_000_000_000,
        ...extra,
      };
    }

    /** Whether a stored update holds structs back for want of what they build on. */
    function pending(record: NoteRecord | undefined): boolean {
      const { doc } = createReplica();
      Y.applyUpdate(doc, record!.update);
      return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
    }

    const copiesIn = async (store: NoteStore, ...ids: string[]) =>
      (await store.listMeta()).filter(
        (meta) => !ids.includes(meta.noteId) && meta.noteId !== WORKSPACE_RECORD_KEY,
      );

    const lines = (record: NoteRecord | undefined) => record?.text.split('\n').sort();

    it('keeps the changes the record lacks at once, and merges them in on the next open', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const { replica, record: base } = written('n1', ['first']);
      await page.put({ ...base, unsynced: false });
      appendParagraph(replica, 'last words');
      // Kept in the call itself: the page gets no further turn.
      expect(page.putOnUnload(kept('n1', replica, base.stateVector))).toBe(true);
      expect(storage.keys()).toHaveLength(1);
      page.close();

      const next = await named(name);
      const stored = await next.get('n1');
      expect(stored?.text).toBe('first\nlast words');
      expect(stored?.unsynced).toBe(true); // Catch-up sync uploads it.
      expect((await next.listMeta()).map((meta) => [meta.noteId, meta.unsynced])).toEqual([
        ['n1', true],
      ]);
      expect(storage.keys()).toEqual([]); // Merged in once.
    });

    it('tells the first write listener which records it merged in as it opened (T45, A711)', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const { replica, record: base } = written('n1', ['first']);
      await page.put(base);
      appendParagraph(replica, 'last words');
      expect(page.putOnUnload(kept('n1', replica, base.stateVector))).toBe(true);
      page.close();

      const next = await named(name);
      const heard: string[][] = [];
      next.onWrite((ids) => heard.push([...ids]));
      expect(heard).toEqual([['n1']]);
      // Once: a second listener hears only what is written from now on.
      const later: string[][] = [];
      next.onWrite((ids) => later.push([...ids]));
      expect(later).toEqual([]);
    });

    it('merges what another window keeps as it goes at once, while this one stays open (PR #167)', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const main = await named(name);
      const closing = await named(name);
      const { replica, record: base } = written('n1', ['first']);
      await main.put({ ...base, unsynced: false });
      const heard: string[][] = [];
      main.onWrite((ids) => heard.push([...ids]));
      const merged: string[][] = [];
      const target = new EventTarget();
      const stop = main.watchUnloadWrites((ids) => merged.push([...ids]), target);
      /** What the browser tells the other windows of one origin when local storage changes. */
      const storageEvent = (key: string | null, newValue: string | null) =>
        Object.assign(new Event('storage'), { key, newValue });
      const settled = () => vi.waitFor(() => expect(merged.length).toBeGreaterThan(0));

      // The other window goes without storing its last keystrokes: only kept.
      appendParagraph(replica, 'last words');
      expect(closing.putOnUnload(kept('n1', replica, base.stateVector))).toBe(true);
      closing.close();
      const [key] = storage.keys();
      // Another store's key, or a key taken out, is no reason to look.
      target.dispatchEvent(storageEvent('penmoss:unload:elsewhere:n1', '{}'));
      target.dispatchEvent(storageEvent(key!, null));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(merged).toEqual([]);
      expect((await main.get('n1'))?.text).toBe('first');

      target.dispatchEvent(storageEvent(key!, storage.getItem(key!)));
      await settled();
      expect(merged).toEqual([['n1']]);
      // The write listeners hear it (the Mac app's engine window pushes a git note's edits).
      expect(heard).toEqual([['n1']]);
      const stored = await main.get('n1');
      expect(stored?.text).toBe('first\nlast words');
      expect(stored?.unsynced).toBe(true);
      expect(storage.keys()).toEqual([]); // Merged once: the next open finds nothing to merge.

      // Unsubscribed, nothing is merged until the store next opens.
      stop();
      const more = await named(name);
      appendParagraph(replica, 'after that');
      expect(more.putOnUnload(kept('n1', replica, stored!.stateVector))).toBe(true);
      more.close();
      const [next] = storage.keys();
      target.dispatchEvent(storageEvent(next!, storage.getItem(next!)));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(merged).toEqual([['n1']]);
      expect((await main.get('n1'))?.text).toBe('first\nlast words');
      const reopened = await named(name);
      expect((await reopened.get('n1'))?.text).toBe('first\nlast words\nafter that');
    });

    it('never overwrites a newer record another tab wrote meanwhile', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const other = await named(name);
      const { replica, record: base } = written('n1', ['base']);
      await page.put(base);
      appendParagraph(replica, 'mine');
      expect(page.putOnUnload(kept('n1', replica, base.stateVector))).toBe(true);
      page.close();
      // Another tab, still open, stores its own change after this page went.
      const theirs = createReplica();
      theirs.applyUpdate(base.update);
      appendParagraph(theirs, 'theirs');
      await other.put(recordFromDoc('n1', theirs.doc, { unsynced: true }));

      const next = await named(name);
      expect(lines(await next.get('n1'))).toEqual(['base', 'mine', 'theirs']);
    });

    it('makes a note never stored from its whole document, and drops changes to one no longer here', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const fresh = written('fresh', ['just typed']);
      expect(page.putOnUnload(kept('fresh', fresh.replica, null))).toBe(true);
      const gone = written('gone', ['stored once']);
      appendParagraph(gone.replica, 'then changed');
      expect(page.putOnUnload(kept('gone', gone.replica, gone.record.stateVector))).toBe(true);
      page.close();

      const next = await named(name);
      expect((await next.get('fresh'))?.text).toBe('just typed');
      expect(await next.get('gone')).toBeUndefined();
      expect((await next.listMeta()).map((meta) => meta.noteId)).toEqual(['fresh']);
      expect(storage.keys()).toEqual([]);
    });

    it('keeps the changes of two pages that went at once, and of their later writes only the last', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const one = await named(name);
      const two = await named(name);
      const { record: base } = written('n1', ['base']);
      await one.put(base);
      const fromOne = createReplica();
      fromOne.applyUpdate(base.update);
      appendParagraph(fromOne, 'from one');
      expect(one.putOnUnload(kept('n1', fromOne, base.stateVector))).toBe(true);
      appendParagraph(fromOne, 'and later');
      expect(one.putOnUnload(kept('n1', fromOne, base.stateVector))).toBe(true);
      const fromTwo = createReplica();
      fromTwo.applyUpdate(base.update);
      appendParagraph(fromTwo, 'from two');
      expect(two.putOnUnload(kept('n1', fromTwo, base.stateVector))).toBe(true);
      expect(storage.keys()).toHaveLength(2);
      one.close();
      two.close();

      const next = await named(name);
      expect(lines(await next.get('n1'))).toEqual(['and later', 'base', 'from one', 'from two']);
    });

    it('describes a record again when an entry adds nothing but its text is of an older state (A695)', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const replica = createReplica();
      for (const text of ['typed', 'the last words']) appendParagraph(replica, text);
      setFrontmatterTag(replica.doc, 'kept', true);
      const record = recordFromDoc('n1', replica.doc, { unsynced: true });
      expect(record.tags).toEqual(['kept']);
      // As a write between text refreshes stores it: the whole document, an older description.
      await page.put({ ...record, text: 'typed', tags: [] });
      expect(page.putOnUnload(kept('n1', replica, record.stateVector))).toBe(true);
      // The workspace's record has no description to refresh, and is left as it is.
      const workspace = written(WORKSPACE_RECORD_KEY, []);
      await page.put(workspace.record);
      expect(
        page.putOnUnload(
          kept(WORKSPACE_RECORD_KEY, workspace.replica, workspace.record.stateVector),
        ),
      ).toBe(true);
      page.close();

      const next = await named(name);
      const stored = await next.get('n1');
      expect(stored?.text).toBe(record.text);
      expect(record.text).toContain('the last words');
      expect(stored?.tags).toEqual(record.tags);
      expect(stored?.update).toEqual(record.update);
      // Later by 1 ms, so the saved search index, which keeps each note's `updatedAt`, takes it.
      expect(stored?.updatedAt).toBe(record.updatedAt + 1);
      expect((await next.listMeta()).find((meta) => meta.noteId === 'n1')?.updatedAt).toBe(
        record.updatedAt + 1,
      );
      // Described once: the next open finds it current and writes nothing.
      expect(next.putOnUnload(kept('n1', replica, record.stateVector))).toBe(true);
      expect(await next.adoptUnloadWrites()).toMatchObject({ described: 0, unchanged: 1 });
      expect(storage.keys()).toEqual([]);
    });

    it('describes a record again when it went deleted or restored after its description (A695)', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      // Deleted within the text interval: the write stored the document, not yet the deletion.
      const gone = createReplica();
      appendParagraph(gone, 'typed, then deleted');
      setDeleted(gone.doc, true, null, { at: 1_700_000_000_500, folderId: 'f1' });
      const deleted = recordFromDoc('n1', gone.doc, { unsynced: true });
      expect(deleted).toMatchObject({ deleted: true, deletedAt: 1_700_000_000_500 });
      const undeleted = Object.fromEntries(
        Object.entries(deleted).filter(([key]) => !key.startsWith('deleted')),
      ) as unknown as NoteRecord;
      expect(undeleted.deleted).toBeUndefined();
      await page.put(undeleted);
      expect(page.putOnUnload(kept('n1', gone, deleted.stateVector))).toBe(true);
      // Restored within it: the write stored the restore, not yet the description without Trash.
      const back = createReplica();
      appendParagraph(back, 'deleted, then restored');
      setDeleted(back.doc, true, null, { at: 1_700_000_000_500, folderId: null });
      setDeleted(back.doc, false);
      const restored = recordFromDoc('n2', back.doc, { unsynced: true });
      expect(restored.deleted).toBeUndefined();
      await page.put({
        ...restored,
        deleted: true,
        deletedAt: 1_700_000_000_500,
        deletedFrom: null,
      });
      expect(page.putOnUnload(kept('n2', back, restored.stateVector))).toBe(true);
      page.close();

      const next = await named(name);
      expect(await next.get('n1')).toMatchObject({
        deleted: true,
        deletedAt: 1_700_000_000_500,
        deletedFrom: 'f1',
        update: deleted.update,
      });
      const n2 = await next.get('n2');
      expect(n2?.deleted).toBeUndefined();
      expect(n2?.deletedAt).toBeUndefined();
      expect(n2?.deletedFrom).toBeUndefined();
      const metas = await next.listMeta();
      expect(metas.find((meta) => meta.noteId === 'n1')?.deleted).toBe(true);
      expect(metas.find((meta) => meta.noteId === 'n2')?.deleted).toBe(false);
      expect(storage.keys()).toEqual([]);
    });

    it('forgets what it kept once a later write stored it, and leaves other databases alone', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const store = await named(name);
      // A name that starts with the other's, and its separator.
      const elsewhere = await named(`${name}:other`);
      const { replica } = written('n1', ['typed']);
      expect(store.putOnUnload(kept('n1', replica, null))).toBe(true);
      expect(elsewhere.putOnUnload(kept('n1', replica, null))).toBe(true);
      store.forgetUnload('n1', 'editor');
      expect(storage.keys()).toHaveLength(1);
      elsewhere.close();

      expect(store.putOnUnload(kept('n1', replica, null))).toBe(true);
      store.close();
      const next = await named(name);
      expect((await next.get('n1'))?.text).toBe('typed');
      expect(storage.keys()).toHaveLength(1); // The other database's, still waiting for it.
      const other = await named(`${name}:other`);
      expect((await other.get('n1'))?.text).toBe('typed');
      expect(storage.keys()).toEqual([]);
    });

    it('declines when it cannot keep the change: closed, storage full, or no page storage', async () => {
      const { replica } = written('n1', ['typed']);
      const closed = await openFresh();
      closed.close();
      expect(closed.putOnUnload(kept('n1', replica, null))).toBe(false);
      const full = await openFresh();
      storage.full = true;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(full.putOnUnload(kept('n1', replica, null))).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
      vi.stubGlobal('localStorage', undefined);
      expect(full.putOnUnload(kept('n1', replica, null))).toBe(false);
    });

    it('merges the rest when one entry cannot be merged, and drops that one with an error (A640)', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const good = written('good', ['kept']);
      expect(page.putOnUnload(kept('good', good.replica, null))).toBe(true);
      await page.put(written('bad', ['stored']).record);
      // An entry whose update Yjs cannot read: merging it throws.
      const bad = {
        ...kept('bad', good.replica, null),
        update: new Uint8Array([255, 255, 255, 255]),
      };
      expect(page.putOnUnload({ ...bad, source: 'broken' })).toBe(true);
      page.close();

      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const next = await named(name);
      expect(error).toHaveBeenCalledOnce();
      error.mockRestore();
      expect((await next.get('good'))?.text).toBe('kept');
      expect((await next.get('bad'))?.text).toBe('stored');
      expect(storage.keys()).toEqual([]); // Neither waits for the next open, for ever.
    });

    it('drops changes whose base the record no longer holds, as a note made again under its id (A640)', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const other = await named(name);
      // A daily note: stored, changed, then purged and made again elsewhere.
      const old = written('daily', ['old daily']);
      await page.put(old.record);
      appendParagraph(old.replica, 'typed last');
      expect(page.putOnUnload(kept('daily', old.replica, old.record.stateVector))).toBe(true);
      page.close();
      const fresh = written('daily', ['new daily']).record;
      await other.put(fresh);

      const next = await named(name);
      const stored = await next.get('daily');
      expect(stored?.text).toBe('new daily');
      expect(pending(stored)).toBe(false); // No structs of the old note held back in it.
      expect(stored?.update).toEqual(fresh.update);
      expect(await copiesIn(next, 'daily')).toEqual([]);
    });

    // PR #167's final check: every open window hears the same entry; one change, one copy.
    for (const [kind, prefix, claimed] of [
      ['the personal store', 'penmoss-unload-', true],
      ['a git notebook store', 'penmoss-git-01JBNOTEBOOK0000000000000', true],
      // Without Web Locks, nothing claims the entry: the copy's id alone keeps it to one.
      ['the personal store, unclaimed', 'penmoss-unload-', false],
      ['a git notebook store, unclaimed', 'penmoss-git-01JBNOTEBOOK0000000000000', false],
    ] as const) {
      it(`makes one conflict copy when two windows merge one entry that cannot join its record (${kind})`, async () => {
        if (!claimed) vi.stubGlobal('navigator', { ...navigator, locks: undefined });
        const request = claimed ? vi.spyOn(navigator.locks, 'request') : null;
        const name = `${prefix}${++dbCount}`;
        const first = await named(name);
        const second = await named(name);
        const note = written('n1', ['first']);
        appendParagraph(note.replica, 'typed as it went');
        const closing = await named(name);
        expect(closing.putOnUnload(kept('n1', note.replica, null))).toBe(true);
        closing.close();
        // Meanwhile a newer build stored the note under an engine this one cannot merge into.
        await first.put({ ...note.record, engine: 'yjs15' as 'yjs14', unsynced: false });
        const [key] = storage.keys();
        const event = Object.assign(new Event('storage'), {
          key,
          newValue: storage.getItem(key!),
        });
        const merged: string[][] = [];
        const targets = [new EventTarget(), new EventTarget()];
        const stops = [first, second].map((store, i) =>
          store.watchUnloadWrites((ids) => merged.push([...ids]), targets[i]),
        );
        // Both at once, as the browser tells every other window.
        for (const target of targets) target.dispatchEvent(event);
        await vi.waitFor(() => expect(storage.keys()).toEqual([]));
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const stop of stops) stop();

        const copies = await copiesIn(first, 'n1');
        expect(copies).toHaveLength(1);
        expect((await first.get(copies[0]!.noteId))?.text).toContain('typed as it went');
        expect(await copiesIn(second, 'n1')).toEqual(copies);
        if (request) {
          expect(request).toHaveBeenCalledWith(
            `penmoss:unload-merge:${encodeURIComponent(name)}`,
            expect.any(Function),
          );
          request.mockRestore();
        }
        // A store opened later finds nothing more to copy.
        const next = await named(name);
        expect(await copiesIn(next, 'n1')).toHaveLength(1);
      });
    }

    it('makes no conflict copy of a whole document it cannot merge with no unsynced edits (A640)', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const other = await named(name);
      // Read and not written yet, so kept whole: the engine had all of it.
      const note = written('n1', ['as the engine had it']);
      expect(page.putOnUnload(kept('n1', note.replica, null, { unsynced: false }))).toBe(true);
      page.close();
      const newer = written('n1', ['a newer build’s']).record;
      await other.put({ ...newer, engine: 'yjs15' as 'yjs14' });

      const next = await named(name);
      expect((await next.get('n1'))?.text).toBe('a newer build’s');
      expect(await copiesIn(next, 'n1')).toEqual([]);
    });

    it('writes nothing when the record holds every change already, so it stays synced', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const note = written('n1', ['typed']);
      expect(page.putOnUnload(kept('n1', note.replica, null))).toBe(true);
      // The ordinary write landed after all, and the server confirmed it.
      const synced = { ...note.record, unsynced: false, rev: 'r1' };
      await page.put(synced);
      page.close();
      const next = await named(name);
      expect(await next.get('n1')).toEqual(synced);
    });

    it('keeps two sources of the same note in one page apart, as an editor and an embed (A640)', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const base = written('n1', ['base']);
      await page.put(base.record);
      const editor = createReplica();
      editor.applyUpdate(base.record.update);
      appendParagraph(editor, 'in the editor');
      const embed = createReplica();
      embed.applyUpdate(base.record.update);
      appendParagraph(embed, 'in the embed');
      const since = base.record.stateVector;
      expect(page.putOnUnload(kept('n1', editor, since, { source: 'replica-1' }))).toBe(true);
      expect(page.putOnUnload(kept('n1', embed, since, { source: 'replica-2' }))).toBe(true);
      // The embed's own write landed: only its entry is forgotten.
      page.forgetUnload('n1', 'replica-2');
      expect(storage.keys()).toHaveLength(1);
      expect(page.putOnUnload(kept('n1', embed, since, { source: 'replica-2' }))).toBe(true);
      page.close();

      const next = await named(name);
      expect(lines(await next.get('n1'))).toEqual(['base', 'in the editor', 'in the embed']);
    });

    it('declines a change too large to keep, so the origin has room for the session (A640)', async () => {
      const store = await openFresh();
      const large = createReplica();
      appendParagraph(large, 'x'.repeat(UNLOAD_MAX_CHARS));
      expect(store.putOnUnload(kept('n1', large, null))).toBe(false);
      expect(storage.keys()).toEqual([]);
    });

    // #116, review S2: a window still on the refused folder replica closes after another window
    // recovered (A581, A670). Its last folder change, kept as it went, builds on structs the
    // recovered record no longer holds, so it cannot be merged and is dropped. The store keeps
    // the count, so the next folder notice says so (A676), once.
    it('counts a folder change it drops for the next folder notice, until it is taken', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const mac = createReplica();
      createFolder(mac.doc, { id: 'f-unsent', name: 'Unsent', parentId: null });
      const refused = recordFromDoc(WORKSPACE_RECORD_KEY, mac.doc, { unsynced: true });
      await page.put(refused);
      // The lagging window renames the folder; meanwhile the other window's recovery replaced
      // the record with the server's tree and the folder made again under a new client id.
      const lagging = createReplica();
      lagging.applyUpdate(refused.update);
      renameFolder(lagging.doc, 'f-unsent', 'Renamed as the window went');
      const recovered = createReplica();
      createFolder(recovered.doc, { id: 'f-unsent', name: 'Unsent', parentId: null });
      await page.put(recordFromDoc(WORKSPACE_RECORD_KEY, recovered.doc, { unsynced: true }));
      expect(page.putOnUnload(kept(WORKSPACE_RECORD_KEY, lagging, refused.stateVector))).toBe(true);
      page.close();

      const next = await named(name);
      expect(storage.keys()).toEqual([]);
      // Kept in the store, not this page: the window that shows the notice may open it later.
      const other = await named(name);
      expect(await other.takeUnloadDrops(WORKSPACE_RECORD_KEY)).toBe(1);
      expect(await next.takeUnloadDrops(WORKSPACE_RECORD_KEY)).toBe(0);
      expect(await next.takeUnloadDrops('n1')).toBe(0);
    });

    // A folder change the server already has is not lost, and a note's lost edits become
    // conflict copies; neither is counted, so no count waits for a notice that never comes.
    function laggingFolderWrite(unsynced: boolean): {
      readonly write: UnloadWrite;
      readonly recovered: NoteRecord;
    } {
      const mac = createReplica();
      createFolder(mac.doc, { id: 'f-unsent', name: 'Unsent', parentId: null });
      const refused = recordFromDoc(WORKSPACE_RECORD_KEY, mac.doc, { unsynced: true });
      const lagging = createReplica();
      lagging.applyUpdate(refused.update);
      renameFolder(lagging.doc, 'f-unsent', 'Renamed as the window went');
      const recovered = createReplica();
      createFolder(recovered.doc, { id: 'f-unsent', name: 'Unsent', parentId: null });
      return {
        write: kept(WORKSPACE_RECORD_KEY, lagging, refused.stateVector, { unsynced }),
        recovered: recordFromDoc(WORKSPACE_RECORD_KEY, recovered.doc, {
          unsynced: true,
        }),
      };
    }

    it('adds up the folder drops of several opens until they are taken', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      for (let i = 0; i < 2; i++) {
        const page = await named(name);
        const { write, recovered } = laggingFolderWrite(true);
        await page.put(recovered);
        expect(page.putOnUnload(write)).toBe(true);
        page.close();
      }
      const next = await named(name);
      expect(await next.takeUnloadDrops(WORKSPACE_RECORD_KEY)).toBe(2);
    });

    it('counts neither a folder change the server already has nor a note’s drop', async () => {
      const name = `penmoss-unload-${++dbCount}`;
      const page = await named(name);
      const { write, recovered } = laggingFolderWrite(false);
      await page.put(recovered);
      expect(page.putOnUnload(write)).toBe(true);
      const gone = written('gone', ['stored once']);
      appendParagraph(gone.replica, 'never stored whole');
      expect(page.putOnUnload(kept('gone', gone.replica, gone.record.stateVector))).toBe(true);
      page.close();

      const next = await named(name);
      expect(storage.keys()).toEqual([]);
      expect(await next.takeUnloadDrops(WORKSPACE_RECORD_KEY)).toBe(0);
      expect(await next.takeUnloadDrops('gone')).toBe(0);
    });
  });
});

describe('search fields in records (T22)', () => {
  it('stores the headings with each record, and lists them with the text and tags', async () => {
    const doc = new Y.Doc();
    const root = doc.get(NOTE_ROOT);
    const heading = new Y.Node('heading');
    heading.setAttr('level', 2);
    const paragraph = new Y.Node('paragraph');
    root.push([heading, paragraph]);
    heading.insert(0, 'Restoring');
    paragraph.insert(0, 'Clone the #backup repository');
    const record = recordFromDoc('n1', doc, { unsynced: false, updatedAt: 5 });
    expect(record.headings).toBe('Restoring');
    const store = await NoteStore.open(`penmoss-search-${Date.now()}`);
    try {
      await store.put(record);
      expect(await store.listTexts()).toEqual([
        {
          noteId: 'n1',
          title: '',
          text: 'Restoring\nClone the #backup repository',
          headings: 'Restoring',
          tags: ['backup'],
          updatedAt: 5,
          deleted: false,
        },
      ]);
    } finally {
      store.close();
    }
  });
});
