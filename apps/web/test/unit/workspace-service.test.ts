/**
 * A git notebook's folders and settings (T59: the only kind, D49): the tree kept in the note
 * store under the reserved key, filing, notebooks, journal folders, the notebook's and the
 * device's settings (A827), and the notice for folder changes a closed window could not keep.
 */
import {
  deleteFolder,
  moveNote,
  readSettings,
  readWorkspace,
  setNotebook,
  WORKSPACE_RECORD_KEY,
} from '@penmoss/sync-client/workspace';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planDrop } from '../../src/workspace/model';
import {
  GIT_DEVICE_SETTINGS,
  GIT_NOTEBOOK_SETTINGS,
  Workspace,
  type WorkspaceOptions,
} from '../../src/workspace/service';
import { memoryNotes } from './support/memory-notes';
import { testNotes, testWorkspace } from './support/local-sources';

const toStop: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const item of toStop.splice(0)) item.stop();
});

function setup(store = memoryNotes(), options: Partial<WorkspaceOptions> = {}) {
  const workspace = testWorkspace(store, options);
  toStop.push(workspace);
  return { workspace, store };
}

describe('Workspace', () => {
  it('keeps the tree in the note store under the reserved key, and restores it', async () => {
    const store = memoryNotes();
    const first = setup(store).workspace;
    await first.start();
    const projects = first.createFolder('Projects', null);
    first.registerNote('01NOTE', projects);
    await first.flush();
    expect(store.records.has(WORKSPACE_RECORD_KEY)).toBe(true);

    const second = setup(store).workspace;
    expect(second.getState().loaded).toBe(false);
    await second.start();
    const state = second.getState();
    expect(state.loaded).toBe(true);
    expect(state.snapshot.folders.map((folder) => folder.name)).toEqual(['Projects']);
    expect(state.snapshot.notes).toMatchObject([{ id: '01NOTE', folderId: projects }]);
  });

  it('never lists the workspace record as a note', async () => {
    const store = memoryNotes();
    const { workspace } = setup(store);
    await workspace.start();
    workspace.createFolder('Projects', null);
    await workspace.flush();
    const notes = testNotes(store);
    toStop.push(notes);
    await notes.refreshLocal();
    expect(notes.list()).toEqual([]);
  });

  // Fail closed (T43 review B2, A757): a folder Trash knows nothing of is no proof the note is the
  // default notebook's; it is filed as asked, held by every mirror until the repair settles it.
  it('files a new note where it was asked when its folder is gone and Trash forgets it', async () => {
    const { workspace } = setup();
    await workspace.start();
    workspace.registerNote('01A', 'missing-folder');
    expect(readWorkspace(workspace.doc).notes).toMatchObject([
      { id: '01A', folderId: 'missing-folder' },
    ]);
  });

  it('files a new note in the folder above when its own was deleted, within the notebook', async () => {
    const { workspace } = setup();
    await workspace.start();
    const work = workspace.createFolder('Work', null);
    setNotebook(workspace.doc, work, true);
    const specs = workspace.createFolder('Specs', work);
    deleteFolder(workspace.doc, specs);
    workspace.registerNote('01A', specs);
    expect(readWorkspace(workspace.doc).notes).toMatchObject([{ id: '01A', folderId: work }]);
  });

  it('files a conflict copy beside its original, and nowhere while the original is in Trash with its notebook', async () => {
    const { workspace } = setup();
    await workspace.start();
    const work = workspace.createFolder('Work', null);
    setNotebook(workspace.doc, work, true);
    workspace.registerNote('01ORIG', work);
    workspace.registerCopy('01COPY', '01ORIG');
    expect(workspace.folderOfNote('01COPY')).toBe(work);
    deleteFolder(workspace.doc, work);
    workspace.registerCopy('01LATER', '01ORIG');
    expect(readWorkspace(workspace.doc).notes.some((note) => note.id === '01LATER')).toBe(false);
  });

  it('asks where a note goes when its notebook is in Trash, never the top level (review B2)', async () => {
    const { workspace } = setup();
    await workspace.start();
    const work = workspace.createFolder('Work', null);
    setNotebook(workspace.doc, work, true);
    const home = workspace.createFolder('Home', null);
    deleteFolder(workspace.doc, home);
    expect(workspace.restorePlace('01GONE', home)).toEqual({ folderId: null });
    deleteFolder(workspace.doc, work);
    expect(workspace.restorePlace('01GONE', work)).toEqual({
      refused: true,
      notebook: { id: work, name: 'Work' },
    });
  });

  it('tells of each note this device moves to another notebook, and of no other change (A766)', async () => {
    const { workspace } = setup();
    await workspace.start();
    const work = workspace.createFolder('Work', null);
    setNotebook(workspace.doc, work, true);
    const home = workspace.createFolder('Home', null);
    workspace.registerNote('01A', home);
    workspace.registerNote('01B', home);
    const moves: Array<[string, string]> = [];
    workspace.onNotebookMove((id, notebook) => moves.push([id, notebook]));
    // Filed for the first time, or moved within a notebook: nothing to record.
    workspace.registerNote('01C', work);
    const inner = workspace.createFolder('Inner', home);
    moveNote(workspace.doc, '01B', inner, 'a5');
    expect(moves).toEqual([]);
    moveNote(workspace.doc, '01A', work, 'a1');
    expect(moves).toEqual([['01A', work]]);
    // A notebook turned back into a folder: each of its notes is the default's now.
    setNotebook(workspace.doc, work, false);
    expect(moves.slice(1).sort()).toEqual([
      ['01A', 'default'],
      ['01C', 'default'],
    ]);
    // A change from elsewhere is that device's to record.
    const local = (workspace as unknown as { replica: Yjs14Replica }).replica;
    const remote = createYjs14Replica();
    remote.applyUpdate(local.encodeStateAsUpdate());
    const sv = remote.encodeStateVector();
    setNotebook(remote.doc, work, true);
    local.applyUpdate(remote.encodeStateAsUpdate(sv), 'remote');
    expect(moves).toHaveLength(3);
    expect(workspace.notebookOf(work)).toBe(work);
    expect(workspace.notebookOf(null)).toBe('default');
  });

  it('restores a note filed at the top level meanwhile into its folder (B10)', async () => {
    const { workspace } = setup();
    await workspace.start();
    const folder = workspace.createFolder('B', null);
    workspace.registerNote('01A', null);
    workspace.restoreNote('01A', folder);
    expect(readWorkspace(workspace.doc).notes).toMatchObject([{ id: '01A', folderId: folder }]);
    // A note filed in another folder since stays there.
    const other = workspace.createFolder('C', null);
    workspace.registerNote('01B', other);
    workspace.restoreNote('01B', folder);
    expect(readWorkspace(workspace.doc).notes.find((n) => n.id === '01B')?.folderId).toBe(other);
  });

  it('notifies subscribers with a new state on every change', async () => {
    const { workspace } = setup();
    await workspace.start();
    const seen: unknown[] = [];
    const off = workspace.subscribe(() => seen.push(workspace.getState()));
    const before = workspace.getState();
    workspace.setSortMode(null, 'alpha');
    off();
    expect(seen.length).toBeGreaterThan(0);
    expect(workspace.getState()).not.toBe(before);
    expect(workspace.getState().snapshot.rootSortMode).toBe('alpha');
  });

  it('applies a planned move, registering unknown notes it re-keys', async () => {
    const { workspace } = setup();
    await workspace.start();
    const folder = workspace.createFolder('F', null);
    workspace.registerNote('01A', folder);
    const tree = {
      rootSortMode: 'manual' as const,
      folders: [],
      notes: [
        { id: '01B', folderId: null, position: '~', title: 'B', updatedAt: 0 },
        { id: '01C', folderId: null, position: '~', title: 'C', updatedAt: 0 },
      ],
      byId: new Map(),
    };
    const plan = planDrop(
      tree,
      { kind: 'note', id: '01A' },
      {
        kind: 'note',
        id: '01C',
        zone: 'before',
      },
    );
    workspace.apply(plan);
    const notes = readWorkspace(workspace.doc).notes.sort((a, b) =>
      a.position < b.position ? -1 : 1,
    );
    expect(notes.map((note) => [note.id, note.folderId])).toEqual([
      ['01B', null],
      ['01A', null],
      ['01C', null],
    ]);
  });

  it('keeps the notebook’s settings apart from this device’s (A827)', async () => {
    const { workspace } = setup();
    await workspace.start();
    workspace.setSetting('timeZone', 'America/Chicago');
    workspace.setSetting('theme', 'dark');
    expect(workspace.settings()).toEqual({ timeZone: 'America/Chicago', theme: 'dark' });
    expect(readSettings(workspace.doc, GIT_NOTEBOOK_SETTINGS)).toEqual({
      timeZone: 'America/Chicago',
    });
    expect(readSettings(workspace.doc, GIT_DEVICE_SETTINGS)).toEqual({ theme: 'dark' });
    workspace.setSetting('timeZone', undefined);
    expect(workspace.settings()).toEqual({ theme: 'dark' });
  });

  it('files a journal note under Journal/<year>/<month> or Weekly, in folders every device names alike (T19)', async () => {
    const store = memoryNotes();
    const { workspace } = setup(store);
    await workspace.start();
    workspace.fileJournalNote('01DAY', 'daily', '2026-10-21');
    workspace.fileJournalNote('01WEEK', 'weekly', '2026-W43');
    workspace.fileJournalNote('01NOV', 'daily', '2026-11-02');

    const other = setup(memoryNotes()).workspace;
    await other.start();
    other.fileJournalNote('01DAY', 'daily', '2026-10-21');

    const path = (ws: Workspace, id: string) => {
      const { folders, notes } = ws.getState().snapshot;
      const names: string[] = [];
      let folderId = notes.find((note) => note.id === id)?.folderId ?? null;
      while (folderId) {
        const folder = folders.find((entry) => entry.id === folderId)!;
        names.unshift(folder.name);
        folderId = folder.parentId;
      }
      return names.join('/');
    };
    expect(path(workspace, '01DAY')).toBe('Journal/2026/10');
    expect(path(workspace, '01WEEK')).toBe('Journal/2026/Weekly');
    expect(path(workspace, '01NOV')).toBe('Journal/2026/11');
    // One Journal folder, and the same folder ids on a device that created them separately.
    const ids = (ws: Workspace) => ws.getState().snapshot.folders.map((folder) => folder.id);
    expect(workspace.getState().snapshot.folders.filter((f) => f.name === 'Journal')).toHaveLength(
      1,
    );
    expect(ids(workspace)).toEqual(expect.arrayContaining(ids(other)));
  });

  it('leaves a journal note where the user moved it (T19)', async () => {
    const { workspace } = setup();
    await workspace.start();
    const mine = workspace.createFolder('Mine', null);
    workspace.registerNote('01DAY', mine);
    workspace.fileJournalNote('01DAY', 'daily', '2026-10-21');
    expect(workspace.getState().snapshot.notes).toMatchObject([{ id: '01DAY', folderId: mine }]);
    expect(workspace.getState().snapshot.folders.map((folder) => folder.name)).toEqual(['Mine']);
  });

  it('keeps a setting changed just before a reload, on page hide (A20, A626)', async () => {
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    const store = memoryNotes();
    const { workspace } = setup(store);
    await workspace.start();
    workspace.createFolder('Projects', null);
    await workspace.flush();
    workspace.setSetting('theme', 'dark');
    // The page goes at once: page hide is all it gets.
    page.dispatchEvent(new Event('pagehide'));
    const reloaded = setup(store).workspace;
    await reloaded.start();
    expect(reloaded.settings()).toEqual({ theme: 'dark' });
    expect(reloaded.getState().snapshot.folders.map((folder) => folder.name)).toEqual(['Projects']);
    vi.unstubAllGlobals();
  });

  // #116, review S2 (A676): a window still on the refused replica closed after another window
  // recovered; the folder change it kept as it went could not be merged and was dropped. The
  // next window that shows notices says so, once.
  it('says how many folder changes from a window that closed could not be kept', async () => {
    const store = Object.assign(memoryNotes(), {
      drops: 2,
      takeUnloadDrops(this: { drops: number }, noteId: string) {
        const count = noteId === WORKSPACE_RECORD_KEY ? this.drops : 0;
        if (noteId === WORKSPACE_RECORD_KEY) this.drops = 0;
        return Promise.resolve(count);
      },
    });
    const { workspace } = setup(store);
    await workspace.start();

    await vi.waitFor(() => expect(workspace.getState().recovered).toMatchObject({ closed: 2 }));
    expect(store.drops).toBe(0);
  });

  it('leaves them to a window that shows notices (the Mac’s capture window shows none)', async () => {
    const take = vi.fn(() => Promise.resolve(3));
    const store = Object.assign(memoryNotes(), { takeUnloadDrops: take });
    const { workspace } = setup(store, { notices: false });
    await workspace.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(take).not.toHaveBeenCalled();
    expect(workspace.getState().recovered).toBeUndefined();
  });
});
