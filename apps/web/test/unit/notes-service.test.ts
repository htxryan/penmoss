import { isUlid } from '@penmoss/core/ids';
import { periodicNoteId } from '@penmoss/core/periodic';
import { readNoteNotebook, readIdentity, readTitle, setTitle } from '@penmoss/sync-client/note';
import { frontmatterTags, setFrontmatterTag } from '@penmoss/sync-client/tags';
import { createThread } from '@penmoss/sync-client/comments';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Notes,
  RestoreNeedsFolder,
  type LocalSyncBackend,
  type LocalSyncState,
  type NoteRegistry,
} from '../../src/notes/service';
import type { UnloadWrite } from '@penmoss/sync-client';
import { appendParagraph } from '../../../../packages/sync-client/test/support/editing';
import { TEST_NOTEBOOK } from './support/local-sources';
import { memoryNotes } from './support/memory-notes';

const notesToStop: Notes[] = [];
afterEach(() => {
  for (const notes of notesToStop.splice(0)) notes.stop();
  vi.restoreAllMocks();
});

/** A git notebook's engine as the notes see it: its state set by the test (A860). */
function gitBackend(initial: Partial<LocalSyncState> = {}) {
  let state: LocalSyncState = { phase: 'synced', detail: null, pending: new Set(), ...initial };
  const listeners = new Set<() => void>();
  const purged: string[] = [];
  const backend: LocalSyncBackend = {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    purge: (id) => {
      purged.push(id);
      return Promise.resolve();
    },
  };
  return {
    backend,
    purged,
    set(next: Partial<LocalSyncState>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
}

function setup(
  options: {
    online?: () => boolean;
    registry?: NoteRegistry;
    /** The local store (shared to stand for a reload). */
    store?: ReturnType<typeof memoryNotes>;
    /** A git notebook's sync (A860). */
    backend?: LocalSyncBackend;
    periodicSalt?: string;
    isPurged?: (id: string) => boolean;
  } = {},
) {
  const store = options.store ?? memoryNotes();
  const notes = new Notes({
    backend: options.backend ?? gitBackend().backend,
    periodicSalt: options.periodicSalt ?? TEST_NOTEBOOK,
    openStore: () => Promise.resolve(store),
    online: options.online ?? (() => true),
    persistStorage: () => Promise.resolve(true),
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.isPurged ? { isPurged: options.isPurged } : {}),
  });
  notesToStop.push(notes);
  return { notes, store };
}

describe('Notes', () => {
  it('creates a note locally with a ULID, identity and empty title, and asks to focus its title', async () => {
    const { notes, store } = setup();
    await notes.start();
    const now = new Date('2026-10-22T15:00:00Z');
    const id = notes.create(now);
    await notes.settled(id);

    expect(isUlid(id)).toBe(true);
    const record = store.records.get(id);
    expect(record).toMatchObject({ noteId: id, engine: 'yjs14', title: '', unsynced: true });
    const replica = createYjs14Replica();
    replica.applyUpdate(record!.update);
    expect(readIdentity(replica.doc)).toMatchObject({ id, kind: 'note' });
    expect(Date.parse(readIdentity(replica.doc).created!)).toBe(now.getTime());

    await vi.waitFor(() => expect(notes.list()).toMatchObject([{ id, title: '' }]));
    expect(notes.takeTitleFocus(id)).toBe(true);
    expect(notes.takeTitleFocus(id)).toBe(false);
  });

  it('updates the list title live while the open note is edited, then keeps it after closing', async () => {
    const { notes, store } = setup();
    await notes.start();
    const id = notes.create();
    const listener = vi.fn();
    notes.subscribe(listener);

    const open = notes.openNote(id);
    await open.ready;
    setTitle(open.replica.doc, 'Groceries');
    expect(notes.list()[0]).toMatchObject({ id, title: 'Groceries' });
    expect(listener).toHaveBeenCalled();

    open.close();
    await vi.waitFor(() => expect(store.records.get(id)?.title).toBe('Groceries'));
    await vi.waitFor(() => expect(notes.list()[0]).toMatchObject({ id, title: 'Groceries' }));
  });

  it('keeps a closed note’s title when an older read of the list ends after a newer one', async () => {
    const { notes, store } = setup();
    await notes.start();
    // The first read after the note is made holds its untitled record, and ends last.
    const read = store.listMeta.bind(store);
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const listMeta = vi.spyOn(store, 'listMeta').mockImplementation(async () => {
      const metas = await read();
      if (first) {
        first = false;
        await late;
      }
      return metas;
    });
    const id = notes.create();
    await vi.waitFor(() => expect(store.records.get(id)).toBeDefined());
    const open = notes.openNote(id);
    await open.ready;
    setTitle(open.replica.doc, 'Recent A');
    open.close();
    await vi.waitFor(() => expect(store.records.get(id)?.title).toBe('Recent A'));
    // The closing write's read has landed and the live title is gone.
    await vi.waitFor(() => expect(listMeta).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(notes.list()[0]).toMatchObject({ id, title: 'Recent A' }));
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notes.list()[0]).toMatchObject({ id, title: 'Recent A' });
  });

  it('leaves a note where it is in the list for a comment, which is not an edit (T48, A770)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-28T10:00:00Z'));
      const { notes } = setup();
      await notes.start();
      const first = notes.create();
      const open = notes.openNote(first);
      await open.ready;
      setTitle(open.replica.doc, 'Commented on');
      vi.setSystemTime(new Date('2026-10-28T10:05:00Z'));
      const second = notes.create();
      await vi.waitFor(() =>
        expect(notes.list().map((entry) => entry.id)).toEqual([second, first]),
      );
      const before = notes.list().find((entry) => entry.id === first)!.updatedAt;
      vi.setSystemTime(new Date('2026-10-28T10:10:00Z'));
      createThread(open.replica.doc, {
        id: 't1',
        anchor: { from: { tname: 'prosemirror' }, to: null },
        quote: '',
        author: { id: 'device:test', kind: 'device', label: 'You' },
        at: Date.now(),
        comment: { id: 'c1', body: 'Later' },
      });
      expect(notes.list().map((entry) => entry.id)).toEqual([second, first]);
      expect(notes.list().find((entry) => entry.id === first)!.updatedAt).toBe(before);
      // An edit does move it.
      setTitle(open.replica.doc, 'Edited');
      expect(notes.list().map((entry) => entry.id)).toEqual([first, second]);
      open.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // T45 (A711): two windows on one store; one reads what the other wrote, as it is told.
  it('reads what another window stored: the named notes, open ones too, not the whole list', async () => {
    const { notes: mine, store } = setup();
    const { notes: theirs } = setup({ store });
    await mine.start();
    await theirs.start();
    const id = theirs.create();
    await theirs.settled(id);
    await mine.refreshLocal();
    const open = mine.openNote(id);
    await open.ready;

    const editing = theirs.openNote(id);
    await editing.ready;
    setTitle(editing.replica.doc, 'Written in the other window');
    await editing.flush();
    const listMeta = vi.spyOn(store, 'listMeta');
    await mine.pullStored([id]);
    expect(readTitle(open.replica.doc)).toBe('Written in the other window');
    expect(mine.list().find((entry) => entry.id === id)?.title).toBe('Written in the other window');
    expect(listMeta).not.toHaveBeenCalled();
    // Nothing named (the capture window's save): everything is read again.
    await mine.pullStored();
    expect(listMeta).toHaveBeenCalledTimes(1);
    open.close();
    editing.close();
  });

  // PR #167: a window that went without storing its last keystrokes kept them as it went (A626);
  // the store merges them as they are kept, and this window reads the records it named.
  it('reads what the store merged from a window that went, as it is merged, until it stops', async () => {
    const store = memoryNotes();
    const watchers: Array<(ids: readonly string[]) => void> = [];
    const off = vi.fn();
    store.watchUnloadWrites = (onMerged) => {
      watchers.push(onMerged);
      return off;
    };
    const { notes: mine } = setup({ store });
    const { notes: theirs } = setup({ store });
    await mine.start();
    await theirs.start();
    await vi.waitFor(() => expect(watchers).toHaveLength(2));
    const id = theirs.create();
    await theirs.settled(id);
    await mine.refreshLocal();
    const open = mine.openNote(id);
    await open.ready;

    const editing = theirs.openNote(id);
    await editing.ready;
    setTitle(editing.replica.doc, 'Kept as the other window went');
    await editing.flush();
    expect(readTitle(open.replica.doc)).not.toBe('Kept as the other window went');
    watchers[0]!([id]);
    await vi.waitFor(() =>
      expect(readTitle(open.replica.doc)).toBe('Kept as the other window went'),
    );
    mine.stop();
    expect(off).toHaveBeenCalledTimes(1);
    open.close();
    editing.close();
  });

  it('re-sorts its list for another window’s typing at most once a second; a new title at once', async () => {
    const { notes: mine, store } = setup();
    const { notes: theirs } = setup({ store });
    await mine.start();
    await theirs.start();
    const id = theirs.create();
    await theirs.settled(id);
    await mine.refreshLocal();
    const editing = theirs.openNote(id);
    await editing.ready;
    let changes = 0;
    const off = mine.subscribe(() => changes++);
    vi.useFakeTimers();
    try {
      // Typed text: each write is read, the list is redrawn once.
      for (const word of ['one', 'two', 'three']) {
        appendParagraph(editing.replica, word);
        await editing.flush();
        await mine.pullStored([id]);
      }
      expect(changes).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(changes).toBe(1);
      // A title shows at once.
      setTitle(editing.replica.doc, 'Renamed elsewhere');
      await editing.flush();
      await mine.pullStored([id]);
      expect(changes).toBe(2);
      expect(mine.list().find((entry) => entry.id === id)?.title).toBe('Renamed elsewhere');
    } finally {
      vi.useRealTimers();
      off();
      editing.close();
    }
  });

  it('opens a note created a moment ago once it is stored', async () => {
    const { notes, store } = setup();
    await notes.start();
    const id = notes.create();
    const open = notes.openNote(id); // before the creation write has finished
    expect(store.records.has(id)).toBe(false);
    expect(readIdentity(open.replica.doc)).toMatchObject({ id, kind: 'note' }); // already, in memory
    await open.ready;
    await notes.settled(id);
    expect(store.records.has(id)).toBe(true);
    open.close();
  });

  it('waits for a closing write before reopening, so no edit is read back stale', async () => {
    const { notes } = setup();
    await notes.start();
    const id = notes.create();
    await notes.settled(id);
    const first = notes.openNote(id);
    await first.ready;
    setTitle(first.replica.doc, 'Edited just before closing');
    first.close();
    const second = notes.openNote(id); // the closing write is still in flight
    await second.ready;
    expect(readTitle(second.replica.doc)).toBe('Edited just before closing');
    second.close();
  });

  it('keeps a closed note’s write in flight as the page goes, though the note is open again (A640)', async () => {
    const store = memoryNotes();
    const kept: UnloadWrite[] = [];
    let held = false;
    const update = store.update.bind(store);
    // Writes from here on stay in flight, as on a busy disk.
    store.update = (noteId, fn) => (held ? new Promise(() => undefined) : update(noteId, fn));
    const unloading = Object.assign(store, {
      putOnUnload: (write: UnloadWrite) => {
        kept.push(write);
        return true;
      },
    });
    const { notes } = setup({ store: unloading });
    await notes.start();
    const id = notes.create();
    await notes.settled(id);
    const first = notes.openNote(id);
    await first.ready;
    held = true;
    setTitle(first.replica.doc, 'Typed just before closing');
    first.close(); // Its closing write is in flight: the note lives in memory meanwhile.
    const again = notes.openNote(id); // Open again from that snapshot, with nothing typed since.
    await again.ready;

    notes.saveAllOnUnload();
    const titles = kept
      .filter((write) => write.noteId === id)
      .map((write) => {
        const replica = createYjs14Replica();
        replica.applyUpdate(write.update);
        return readTitle(replica.doc);
      });
    expect(titles).toContain('Typed just before closing');
    again.close();
  });

  it('ignores an instance closed before it finished loading (React StrictMode)', async () => {
    const { notes } = setup();
    await notes.start();
    const id = notes.create();
    await notes.settled(id);
    const first = notes.openNote(id);
    first.close();
    const second = notes.openNote(id);
    await second.ready;
    expect(readIdentity(second.replica.doc)).toMatchObject({ id });
    second.close();
  });

  it('loads a note from local storage', async () => {
    const { notes } = setup();
    await notes.start();
    const id = notes.create();
    const first = notes.openNote(id);
    await first.ready;
    setTitle(first.replica.doc, 'Saved offline');
    first.close();
    await vi.waitFor(() => expect(notes.list()[0]?.title).toBe('Saved offline'));

    const second = notes.openNote(id);
    await second.ready;
    expect(readTitle(second.replica.doc)).toBe('Saved offline');
    expect(second.unsynced).toBe(true);
    second.close();
  });
});

describe('Notes: offline-first replica (T8)', () => {
  it('knows which ids are notes, and says when it cannot tell yet (B12)', async () => {
    const { notes } = setup();
    expect(notes.knows('01M5ZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull(); // the local list is not read yet
    await notes.start();
    await notes.refreshLocal();
    const id = notes.create();
    expect(notes.knows(id)).toBe(true);
    // Signed out: nothing more will come from the server, so an unknown id is no note.
    expect(notes.knows('01M5ZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
    await notes.deleteNote(id);
    expect(notes.knows(id)).toBe(true); // in Trash: still a note
  });

  it('deletes a note: hidden at once, flagged in its record, removed from the registry', async () => {
    const registry = { unregister: vi.fn<(id: string, besideId?: string) => void>() };
    const { notes, store } = setup({ registry });
    await notes.start();
    const id = notes.create();
    await notes.settled(id);
    await notes.deleteNote(id);
    expect(notes.list()).toEqual([]);
    expect(store.records.get(id)).toMatchObject({ deleted: true, unsynced: true });
    expect(registry.unregister).toHaveBeenCalledWith(id);
    await notes.refreshLocal();
    expect(notes.list()).toEqual([]);
  });

  it('deletes an open note through its editor replica', async () => {
    const { notes, store } = setup();
    await notes.start();
    const id = notes.create();
    const open = notes.openNote(id);
    await open.ready;
    await notes.deleteNote(id);
    open.close();
    await vi.waitFor(() => expect(store.records.get(id)?.deleted).toBe(true));
  });

  it('keeps the epoch and unsynced flag when reopening a note whose closing write is in flight', async () => {
    const { notes, store } = setup();
    await notes.start();
    const id = notes.create();
    await notes.settled(id);
    store.records.set(id, { ...store.records.get(id)!, epoch: 'epoch-1', unsynced: false });
    const first = notes.openNote(id);
    await first.ready;
    first.close(); // nothing changed: the snapshot must not claim unsynced changes
    const second = notes.openNote(id);
    await second.ready;
    expect(second.keeper.currentEpoch).toBe('epoch-1');
    expect(second.unsynced).toBe(false);
    setTitle(second.replica.doc, 'Edited');
    await second.flush();
    expect(store.records.get(id)).toMatchObject({
      epoch: 'epoch-1',
      unsynced: true,
      title: 'Edited',
    });
    second.close();
  });

  it('keeps a closed note in memory until its write lands, retrying failures', async () => {
    const { notes, store } = setup();
    await notes.start();
    const id = notes.create();
    await notes.settled(id);
    const open = notes.openNote(id);
    await open.ready;
    setTitle(open.replica.doc, 'Precious');
    let failures = 2;
    const update = store.update.bind(store);
    store.update = (noteId, fn) =>
      failures-- > 0 ? Promise.reject(new Error('QuotaExceededError')) : update(noteId, fn);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    open.close();
    const reopened = notes.openNote(id); // from memory while the write is retried
    await reopened.ready;
    expect(readTitle(reopened.replica.doc)).toBe('Precious');
    reopened.close();
    await vi.waitFor(() => expect(store.records.get(id)?.title).toBe('Precious'), {
      timeout: 5000,
    });
  });

  it('does not overwrite edits with a retried creation write', async () => {
    const { notes, store } = setup();
    await notes.start();
    const update = store.update.bind(store);
    let failures = 1;
    store.update = (noteId, fn) =>
      failures-- > 0 ? Promise.reject(new Error('Transient')) : update(noteId, fn);
    const put = store.put.bind(store);
    let creationPuts = 0;
    store.put = (record) => {
      creationPuts++;
      return put(record);
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = notes.create();
    const open = notes.openNote(id);
    await open.ready;
    setTitle(open.replica.doc, 'Typed while the creation write retried');
    await open.flush();
    await notes.settled(id);
    expect(store.records.get(id)?.title).toBe('Typed while the creation write retried');
    expect(creationPuts).toBe(0);
    open.close();
  });

  it("keeps an open note's tags in the list a moment after typing (T18)", async () => {
    const { notes } = setup();
    await notes.start();
    const id = notes.create();
    const open = notes.openNote(id);
    await open.ready;
    setFrontmatterTag(open.replica.doc, 'inbox', true);
    await vi.waitFor(() => expect(notes.list()[0]).toMatchObject({ id, tags: ['inbox'] }));
    open.close();
    await vi.waitFor(() => expect(notes.list()[0]?.tags).toEqual(['inbox']));
  });

  it('renames a tag in open and stored notes through their documents (T18)', async () => {
    const { notes, store } = setup();
    await notes.start();
    const stored = notes.create();
    const editing = notes.openNote(stored);
    await editing.ready;
    setFrontmatterTag(editing.replica.doc, 'chores', true);
    editing.close();
    await vi.waitFor(() => expect(store.records.get(stored)?.tags).toEqual(['chores']));
    await notes.refreshLocal();

    const id = notes.create();
    const open = notes.openNote(id);
    await open.ready;
    setFrontmatterTag(open.replica.doc, 'chores/yard', true);
    await vi.waitFor(() =>
      expect(notes.list().find((entry) => entry.id === id)?.tags).toEqual(['chores/yard']),
    );

    const changed = await notes.renameTag('chores', 'home');
    expect(changed.sort()).toEqual([id, stored].sort());
    expect(frontmatterTags(open.replica.doc)).toEqual(['home/yard']);
    expect(store.records.get(stored)).toMatchObject({ tags: ['home'], unsynced: true });
    open.close();
  });

  it('renames a tag in notes in Trash too, so restoring one never brings the old tag back (T18)', async () => {
    const { notes, store } = setup();
    await notes.start();
    const id = notes.create();
    const open = notes.openNote(id);
    await open.ready;
    setFrontmatterTag(open.replica.doc, 'chores', true);
    open.close();
    await vi.waitFor(() => expect(store.records.get(id)?.tags).toEqual(['chores']));
    await notes.deleteNote(id);
    await notes.refreshLocal();
    expect(notes.list().map((entry) => entry.id)).not.toContain(id);

    expect(await notes.renameTag('chores', 'home')).toEqual([id]);
    expect(store.records.get(id)).toMatchObject({ tags: ['home'], deleted: true, unsynced: true });
  });

  it('finishes a tag rename that was cut short when the app next starts (T18)', async () => {
    const store = memoryNotes();
    const first = setup({ store });
    await first.notes.start();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = first.notes.create(new Date(Date.UTC(2026, 9, 22, 10, i)));
      const open = first.notes.openNote(id);
      await open.ready;
      setFrontmatterTag(open.replica.doc, 'chores', true);
      open.close();
      await vi.waitFor(() => expect(store.records.get(id)?.tags).toEqual(['chores']));
      ids.push(id);
    }
    await first.notes.refreshLocal();
    // The tab closes part-way: the second note's write never happens.
    const update = store.update.bind(store);
    store.update = (noteId, fn) =>
      noteId === ids[1] ? Promise.reject(new Error('The tab closed')) : update(noteId, fn);
    await expect(first.notes.renameTag('chores', 'home')).rejects.toThrow('The tab closed');
    first.notes.stop();
    store.update = update;
    expect(store.records.get(ids[1]!)?.tags).toEqual(['chores']);

    // The next start finishes it, and only once.
    const second = setup({ store });
    await second.notes.start();
    await vi.waitFor(() =>
      expect(ids.map((id) => store.records.get(id)?.tags)).toEqual([['home'], ['home'], ['home']]),
    );
    await second.notes.whenRenamed();
    const revs = ids.map((id) => store.records.get(id)!.rev);
    const third = setup({ store });
    await third.notes.start();
    await third.notes.whenRenamed();
    expect(ids.map((id) => store.records.get(id)!.rev)).toEqual(revs);
  });

  it('creates a daily note from its template once, with a fixed id (T19)', async () => {
    const { notes, store } = setup();
    await notes.start();
    const id = await notes.ensurePeriodic('daily', '2026-10-21', '## Plan\n\n{{date}}\n');
    expect(id).toBe(periodicNoteId('daily', '2026-10-21', TEST_NOTEBOOK));
    const record = store.records.get(id)!;
    expect(record).toMatchObject({ title: '2026-10-21', unsynced: true, epoch: null });
    const replica = createYjs14Replica();
    replica.applyUpdate(record.update);
    expect(readIdentity(replica.doc)).toMatchObject({
      id,
      kind: 'daily',
      period: '2026-10-21',
      created: '2026-10-21',
    });
    expect(record.text).toContain('Plan');
    expect(record.text).toContain('2026-10-21');
    expect(notes.list().map((entry) => entry.id)).toContain(id);

    // Asking again (another template meanwhile) keeps the note as it is.
    const before = record.rev;
    await expect(notes.ensurePeriodic('daily', '2026-10-21', 'other')).resolves.toBe(id);
    expect(store.records.get(id)!.rev).toBe(before);

    // In Trash, it comes back instead of opening deleted (T21).
    await notes.deleteNote(id);
    await expect(notes.ensurePeriodic('daily', '2026-10-21', 'other')).resolves.toBe(id);
    expect(store.records.get(id)?.deleted).toBeUndefined();
    expect(store.records.get(id)?.text).toContain('Plan');
  });

  it('creates a periodic note from its template offline (T19)', async () => {
    const { notes, store } = setup({ online: () => false });
    await notes.start();
    const id = await notes.ensurePeriodic('daily', '2026-10-18', '## Plan\n');
    expect(store.records.get(id)).toMatchObject({ epoch: null, unsynced: true });
    expect(store.records.get(id)!.text).toContain('Plan');
  });

  it('records when and from which folder a note was deleted, and restores it there (T21)', async () => {
    const restore = vi.fn();
    const registry = { unregister: vi.fn(), folderOf: () => 'folder-7', restore };
    const { notes, store } = setup({ registry });
    await notes.start();
    const id = notes.create(new Date('2026-10-22T15:00:00Z'));
    await notes.settled(id);
    await notes.deleteNote(id);
    await notes.refreshLocal();
    expect(store.records.get(id)).toMatchObject({ deleted: true, deletedFrom: 'folder-7' });
    expect(notes.localTrash()).toEqual([expect.objectContaining({ id, folderId: 'folder-7' })]);
    expect(notes.list().map((entry) => entry.id)).not.toContain(id);

    await notes.restoreFromTrash(id);
    expect(store.records.get(id)?.deleted).toBeUndefined();
    expect(restore).toHaveBeenCalledWith(id, 'folder-7');
    expect(notes.localTrash()).toEqual([]);
    expect(notes.list().map((entry) => entry.id)).toContain(id);
  });

  it('asks where a note goes when its notebook is in Trash, and files it where the person chose (T43 review B2)', async () => {
    const restore = vi.fn();
    const restorePlace = vi.fn(() => ({
      refused: true as const,
      notebook: { id: 'nb-1', name: 'Work' },
    }));
    const registry = { unregister: vi.fn(), folderOf: () => 'folder-7', restore, restorePlace };
    const { notes, store } = setup({ registry });
    await notes.start();
    const id = notes.create(new Date('2026-10-22T15:00:00Z'));
    await notes.settled(id);
    await notes.deleteNote(id);
    await notes.refreshLocal();

    const refused = await notes.restoreFromTrash(id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RestoreNeedsFolder);
    expect(refused).toMatchObject({ noteId: id, notebook: { id: 'nb-1', name: 'Work' } });
    expect(restorePlace).toHaveBeenCalledWith(id, 'folder-7');
    // Nothing moved: still in Trash, filed nowhere.
    expect(restore).not.toHaveBeenCalled();
    expect(store.records.get(id)?.deleted).toBe(true);

    await notes.restoreFromTrash(id, { folderId: 'folder-2' });
    expect(restore).toHaveBeenCalledWith(id, 'folder-2');
    expect(store.records.get(id)?.deleted).toBeUndefined();
  });

  it('records each note’s notebook in its own document: at creation, and on a move or a chosen restore (A766)', async () => {
    const restore = vi.fn();
    const notebookOf = (folderId: string | null) =>
      folderId === 'work-folder' ? 'work' : folderId === 'gone' ? null : 'default';
    const registry = { unregister: vi.fn(), folderOf: () => 'work-folder', restore, notebookOf };
    const { notes, store } = setup({ registry });
    await notes.start();
    const recorded = (id: string) => {
      const replica = createYjs14Replica();
      replica.applyUpdate(store.records.get(id)!.update);
      return readNoteNotebook(replica.doc);
    };
    const inWork = notes.create(new Date('2026-10-22T15:00:00Z'), { folderId: 'work-folder' });
    const atTop = notes.create(new Date('2026-10-22T15:00:01Z'), { folderId: null });
    const capture = notes.create(new Date('2026-10-22T15:00:02Z'), { notebook: 'default' });
    const unknown = notes.create(new Date('2026-10-22T15:00:03Z'), { folderId: 'gone' });
    const unplaced = notes.create(new Date('2026-10-22T15:00:04Z'));
    for (const id of [inWork, atTop, capture, unknown, unplaced]) await notes.settled(id);
    expect(recorded(inWork)).toBe('work');
    expect(recorded(atTop)).toBe('default');
    expect(recorded(capture)).toBe('default');
    // Where it goes isn't known: no record, so every mirror holds it until one is written.
    expect(recorded(unknown)).toBeNull();
    expect(recorded(unplaced)).toBeNull();

    await notes.recordNotebook(atTop, 'work');
    expect(recorded(atTop)).toBe('work');
    expect(store.records.get(atTop)?.unsynced).toBe(true);

    await notes.deleteNote(inWork);
    await notes.refreshLocal();
    await notes.restoreFromTrash(inWork, { folderId: null });
    expect(restore).toHaveBeenCalledWith(inWork, null);
    expect(recorded(inWork)).toBe('default');
  });
});

describe('Notes: a git notebook, with no server (A860)', () => {
  it('asks no server: create, open, edit, Trash, rename a tag, journal and purge', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const git = gitBackend();
    const salt = '01JBNOTEBOOK00000000000001';
    const { notes, store } = setup({ backend: git.backend, periodicSalt: salt });
    await notes.start();
    const id = notes.create(new Date(), { title: 'Work plan' });
    await notes.settled(id);
    const open = notes.openNote(id);
    await open.ready;
    open.close();
    await notes.deleteNote(id);
    expect((await notes.trash()).map((entry) => entry.id)).toEqual([id]);
    await notes.renameTag('a', 'b');
    const daily = await notes.ensurePeriodic('daily', '2026-10-29', '## Plan\n');
    // Salted with the notebook's id, as the CLI makes it (A820).
    expect(daily).toBe(periodicNoteId('daily', '2026-10-29', salt));
    expect(daily).not.toBe(periodicNoteId('daily', '2026-10-29'));
    await notes.purgeFromTrash(id);
    expect(git.purged).toEqual([id]);
    expect(store.records.has(id)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips an id deleted for good: the next salt, as the engine does (A828)', async () => {
    const salt = '01JBNOTEBOOK00000000000001';
    const gone = periodicNoteId('daily', '2026-10-29', salt);
    const { notes } = setup({
      backend: gitBackend().backend,
      periodicSalt: salt,
      isPurged: (id) => id === gone,
    });
    await notes.start();
    const id = await notes.ensurePeriodic('daily', '2026-10-29', '## Plan\n');
    expect(id).toBe(periodicNoteId('daily', '2026-10-29', `${salt}#2`));
  });

  it('shows what its engine says, with the changes it has not pushed', async () => {
    const git = gitBackend();
    const { notes } = setup({ backend: git.backend });
    await notes.start();
    expect(notes.syncState()).toMatchObject({ phase: 'synced', pending: 0 });
    const id = notes.create(new Date(), { title: 'x' });
    await notes.settled(id);
    // The record says unsynced (no server ever confirms it); only the engine's list counts.
    expect(notes.syncState()).toMatchObject({ phase: 'synced', pending: 0 });
    git.set({ pending: new Set([id, 'workspace']) });
    expect(notes.syncState()).toMatchObject({ phase: 'syncing', pending: 1 });
    git.set({ phase: 'stopped', detail: "Can't sign in to github.com" });
    expect(notes.syncState()).toMatchObject({
      phase: 'stopped',
      reason: 'git',
      detail: "Can't sign in to github.com",
    });
    git.set({ phase: 'offline', detail: null, pending: new Set() });
    expect(notes.syncState().phase).toBe('offline');
  });
});
