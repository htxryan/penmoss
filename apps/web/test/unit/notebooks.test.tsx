// @vitest-environment happy-dom
import { buildTree } from '@penmoss/core/workspace';
import {
  createFolder,
  readWorkspace,
  registerNote,
  setDefaultNotebookName,
} from '@penmoss/sync-client/workspace';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { graphInput } from '../../src/graph/data';
import { SourceContext } from '../../src/sources/hooks';
import { openLists } from '../../src/sources/lists';
import type { Source } from '../../src/sources/registry';
import { folderChoices, visibleRows, withoutClosed } from '../../src/workspace/model';
import {
  closedNotebooks,
  closedNotebooksKey,
  notebookEntries,
  notebookOfNote,
  openNoteFilter,
  openNotebookIds,
  setClosedNotebooksWorkspace,
  setNotebookOpen,
  useClosedNotebooks,
} from '../../src/workspace/notebooks';

// T43 (A750–A752, A760): notebooks in the web and Mac apps.

function workspace() {
  const doc = createYjs14Replica().doc;
  createFolder(doc, { id: 'qdk', name: 'QDK', parentId: null, notebook: true });
  createFolder(doc, { id: 'specs', name: 'Specs', parentId: 'qdk' });
  createFolder(doc, { id: 'home', name: 'Home', parentId: null });
  registerNote(doc, { id: 'parser', folderId: 'specs' });
  registerNote(doc, { id: 'groceries', folderId: 'home' });
  registerNote(doc, { id: 'loose', folderId: null });
  return doc;
}

beforeEach(() => {
  setClosedNotebooksWorkspace('ws-1');
});

afterEach(() => {
  setClosedNotebooksWorkspace(null);
  localStorage.clear();
});

describe('notebooks open or closed on this device (A752)', () => {
  it('remembers the closed ones, never the default notebook', () => {
    expect(closedNotebooks().size).toBe(0);
    setNotebookOpen('qdk', false);
    setNotebookOpen('default', false);
    expect([...closedNotebooks()]).toEqual(['qdk']);
    expect(localStorage.getItem(closedNotebooksKey('ws-1'))).toBe('["qdk"]');
    // The same set until it changes, for useSyncExternalStore.
    expect(closedNotebooks()).toBe(closedNotebooks());
    setNotebookOpen('qdk', true);
    expect(closedNotebooks().size).toBe(0);
    expect(localStorage.getItem(closedNotebooksKey('ws-1'))).toBeNull();
    localStorage.setItem(closedNotebooksKey('ws-1'), 'not json');
    expect(closedNotebooks().size).toBe(0);
  });

  it('keeps each workspace’s closed notebooks apart, and forgets them at sign-out', () => {
    setNotebookOpen('qdk', false);
    setClosedNotebooksWorkspace('ws-2');
    expect(closedNotebooks().size).toBe(0);
    setNotebookOpen('other', false);
    setClosedNotebooksWorkspace('ws-1');
    expect([...closedNotebooks()]).toEqual(['qdk']);
    // Signed out: nothing is closed, and this workspace's choice is gone from storage.
    setClosedNotebooksWorkspace(null);
    expect(closedNotebooks().size).toBe(0);
    setNotebookOpen('qdk', false);
    expect(closedNotebooks().size).toBe(0);
    expect(localStorage.getItem(closedNotebooksKey('ws-1'))).toBeNull();
    expect(localStorage.getItem(closedNotebooksKey('ws-2'))).toBe('["other"]');
  });

  it('lists the default notebook first, by its name, then each notebook', () => {
    const doc = workspace();
    setDefaultNotebookName(doc, 'Home life');
    const entries = notebookEntries(readWorkspace(doc), new Set(['qdk']));
    expect(entries).toEqual([
      { id: 'default', name: 'Home life', isDefault: true, open: true },
      { id: 'qdk', name: 'QDK', isDefault: false, open: false },
    ]);
    expect(openNotebookIds(readWorkspace(doc), new Set(['qdk']))).toEqual(['default']);
    expect(openNotebookIds(readWorkspace(doc), new Set())).toBeNull();
  });

  it('leaves closed notebooks’ notes out, and finds a note’s notebook', () => {
    const snapshot = readWorkspace(workspace());
    expect(openNoteFilter(snapshot, new Set())).toBeNull();
    const isOpen = openNoteFilter(snapshot, new Set(['qdk']))!;
    expect(['parser', 'groceries', 'loose', 'unknown'].filter(isOpen)).toEqual([
      'groceries',
      'loose',
      'unknown',
    ]);
    expect(notebookOfNote(snapshot, 'parser')).toEqual({ id: 'qdk', name: 'QDK' });
    expect(notebookOfNote(snapshot, 'groceries')).toBeNull();
  });

  it('takes a closed notebook out of the sidebar’s tree, not out of the folder picker', () => {
    const snapshot = readWorkspace(workspace());
    const tree = buildTree(
      snapshot.folders,
      snapshot.notes.map((note) => ({ ...note, title: note.id, updatedAt: 0 })),
    );
    const rows = visibleRows(tree, new Set(['qdk']));
    expect(rows.find((row) => row.id === 'qdk')).toMatchObject({ kind: 'folder', notebook: true });
    expect(rows.find((row) => row.id === 'home')).toMatchObject({ notebook: false });
    const closed = withoutClosed(tree, new Set(['qdk']));
    expect(visibleRows(closed, new Set()).map((row) => row.id)).toEqual(['home', 'loose']);
    expect(withoutClosed(tree, new Set())).toBe(tree);
    // Notebooks head the top level, whatever their order among the folders (T43).
    const doc = workspace();
    createFolder(doc, { id: 'later', name: 'Later', parentId: null, notebook: true });
    const second = readWorkspace(doc);
    const headed = withoutClosed(buildTree(second.folders, []), new Set());
    expect(headed.folders.map((folder) => folder.id)).toEqual(['qdk', 'later', 'home']);
    expect(visibleRows(headed, new Set()).find((row) => row.id === 'home')).toMatchObject({
      sectionStart: true,
    });
    expect(folderChoices(tree).find((choice) => choice.id === 'qdk')).toMatchObject({
      notebook: true,
    });
  });

  it('leaves closed notebooks out of the graph, their links and their group', () => {
    const snapshot = readWorkspace(workspace());
    const local = [
      { id: 'parser', title: 'Parser', links: [{ noteId: 'groceries' }] },
      { id: 'groceries', title: 'Groceries', links: [{ noteId: 'parser' }] },
    ] as unknown as Parameters<typeof graphInput>[0];
    const source = {
      folders: snapshot.folders,
      registry: snapshot.notes,
      rootSortMode: 'manual' as const,
    };
    expect(graphInput(local, source).notes.map((note) => note.id)).toEqual(['parser', 'groceries']);
    const closed = graphInput(local, { ...source, closed: new Set(['qdk']) });
    expect(closed.notes).toEqual([expect.objectContaining({ id: 'groceries', links: [] })]);
    expect(closed.groups.map((group) => group.id)).toEqual(['home', null]);
  });
});

describe('a git notebook has no closed notebooks (A912 review)', () => {
  // A notebook folder in a git notebook closed on this Mac before A912 took Close away: with
  // nothing left to reopen it, the closed set is ignored there, in the tree, search and Recent.
  function source(kind: Source['kind'], doc = workspace()) {
    const snapshot = readWorkspace(doc);
    return {
      id: kind === 'git' ? 'nb-1' : 'personal',
      kind,
      notes: {
        list: () =>
          snapshot.notes.map((note) => ({
            id: note.id,
            title: note.id,
            preview: '',
            updatedAt: 0,
            folderId: note.folderId,
          })),
      },
      workspace: { getState: () => ({ snapshot }) },
    } as unknown as Source;
  }

  it('shows a git notebook’s notebook closed before, in its tree and searches', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setNotebookOpen('qdk', false);
    const seen: Record<string, string[]> = {};
    function Probe({ name }: { name: string }) {
      seen[name] = [...useClosedNotebooks()];
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() =>
      root.render(
        <>
          <Probe name="personal" />
          <SourceContext.Provider value={source('git')}>
            <Probe name="git" />
          </SourceContext.Provider>
        </>,
      ),
    );
    expect(seen).toEqual({ personal: ['qdk'], git: [] });
    act(() => root.unmount());
  });

  it('keeps a git notebook’s notes in Quick open and Recent, whatever was closed', () => {
    setNotebookOpen('qdk', false);
    const ids = openLists([source('git')]).map((entry) => entry.id);
    expect(ids).toEqual(['parser', 'groceries', 'loose']);
  });
});
