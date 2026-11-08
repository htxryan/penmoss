/**
 * Notebooks in the web and Mac apps (T43, A750–A752): which ones are open on
 * this device, and what each view shows with some closed.
 *
 * A notebook is a top-level folder whose notes Ryan mirrors to a repository
 * of its own; everything else is the default notebook. Open or closed is this
 * device's choice (a work Mac shows the work notebook, the home one does not),
 * so it lives in localStorage, never in the synced settings. Closed notebooks
 * leave the sidebar, search, tags, the graph, the switchers and Recent; a link
 * into one still opens the note, which then names its notebook. The default
 * notebook is always open: the Journal and the Inbox live there.
 *
 * Every window of the app reads the same storage, and a change in one reaches
 * the others through the `storage` event (note windows, T45).
 */
import {
  DEFAULT_NOTEBOOK,
  notebookIndex,
  openNotebookFilter,
  type Notebook,
} from '@penmoss/core/workspace';
import { defaultNotebookName, type WorkspaceSnapshot } from '@penmoss/sync-client/workspace';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useNoteList } from '../notes/hooks';
import type { NoteListEntry } from '../notes/list';
import { useIsGitSource } from '../sources/hooks';
import { useWorkspaceState } from './hooks';

export const CLOSED_NOTEBOOKS_KEY = 'penmoss.notebooks.closed';

/** The storage key for one workspace's closed notebooks (T43 review: per workspace). */
export const closedNotebooksKey = (workspaceId: string) => `${CLOSED_NOTEBOOKS_KEY}:${workspaceId}`;

const NONE: ReadonlySet<string> = new Set();
/** The signed-in workspace: closed notebooks are kept per workspace, and none without one. */
let workspace: string | null = null;
const listeners = new Set<() => void>();
/** Where storage throws (private mode), the choice for this page. */
let fallback: ReadonlySet<string> | null = null;
let cached: { readonly raw: string | null; readonly set: ReadonlySet<string> } | null = null;

function rawClosed(): string | null {
  if (workspace === null) return null;
  try {
    return localStorage.getItem(closedNotebooksKey(workspace));
  } catch {
    return null;
  }
}

/**
 * The workspace signed in on this device (null: signed out). Signing out forgets which notebooks
 * were closed for it, so the next person or workspace starts with every notebook open.
 */
export function setClosedNotebooksWorkspace(id: string | null): void {
  if (id === workspace) return;
  if (id === null && workspace !== null) {
    try {
      localStorage.removeItem(closedNotebooksKey(workspace));
    } catch {
      // Storage unavailable: nothing was kept.
    }
  }
  workspace = id;
  fallback = null;
  cached = null;
  notify();
}

/** The notebooks closed on this device (ids); the same set until it changes. */
export function closedNotebooks(): ReadonlySet<string> {
  if (fallback) return fallback;
  const raw = rawClosed();
  if (cached?.raw === raw) return cached.set;
  let set: ReadonlySet<string> = NONE;
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) {
      set = new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== ''));
    }
  } catch {
    // Unreadable: every notebook open.
  }
  cached = { raw, set };
  return set;
}

/** Opens or closes a notebook on this device. The default notebook is always open. */
export function setNotebookOpen(id: string, open: boolean): void {
  if (id === DEFAULT_NOTEBOOK || workspace === null) return;
  const key = closedNotebooksKey(workspace);
  const next = new Set(closedNotebooks());
  if (open) next.delete(id);
  else next.add(id);
  try {
    if (next.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...next].sort()));
    fallback = null;
  } catch {
    fallback = next;
  }
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || (workspace !== null && event.key === closedNotebooksKey(workspace))) {
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useClosedNotebooks(): ReadonlySet<string> {
  const closed = useSyncExternalStore(subscribe, closedNotebooks, () => NONE);
  // A git notebook has no notebooks in it (A912): one closed there before has no way back, so
  // its tree, lists and searches ignore the closed set.
  return useIsGitSource() ? NONE : closed;
}

/** A notebook as the apps list it: the default first (`default`), then the folders. */
export interface NotebookEntry {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly open: boolean;
}

/** Every notebook, the default one first, each open or closed on this device. */
export function notebookEntries(
  snapshot: WorkspaceSnapshot,
  closed: ReadonlySet<string>,
): NotebookEntry[] {
  const { notebooks } = notebookIndex(snapshot.folders);
  return [
    {
      id: DEFAULT_NOTEBOOK,
      name: defaultNotebookName(snapshot),
      isDefault: true,
      open: true,
    },
    ...notebooks.map((notebook: Notebook) => ({
      id: notebook.id,
      name: notebook.name,
      isDefault: false,
      open: !closed.has(notebook.id),
    })),
  ];
}

export function useNotebooks(): NotebookEntry[] {
  const { snapshot } = useWorkspaceState();
  const closed = useClosedNotebooks();
  return useMemo(() => notebookEntries(snapshot, closed), [snapshot, closed]);
}

/** Whether a note is in an open notebook, by its id (a note the tree does not know: yes). */
export function openNoteFilter(
  snapshot: WorkspaceSnapshot,
  closed: ReadonlySet<string>,
): ((noteId: string) => boolean) | null {
  if (closed.size === 0) return null;
  const inOpen = openNotebookFilter(snapshot.folders, closed);
  const folderOf = new Map(snapshot.notes.map((note) => [note.id, note.folderId]));
  return (noteId) => inOpen(folderOf.get(noteId) ?? null);
}

/** `filter` for views of notes: only those in open notebooks (the same list with none closed). */
export function useOpenNotes(): <T extends { readonly id: string }>(
  list: readonly T[],
) => readonly T[] {
  const { snapshot } = useWorkspaceState();
  const closed = useClosedNotebooks();
  const isOpen = useMemo(() => openNoteFilter(snapshot, closed), [snapshot, closed]);
  return useCallback(
    <T extends { readonly id: string }>(list: readonly T[]): readonly T[] =>
      isOpen ? list.filter((entry) => isOpen(entry.id)) : list,
    [isOpen],
  );
}

/** The open notebooks' ids for the server's search (`notebooks=`), or null with none closed. */
export function openNotebookIds(
  snapshot: WorkspaceSnapshot,
  closed: ReadonlySet<string>,
): string[] | null {
  if (closed.size === 0) return null;
  return notebookEntries(snapshot, closed)
    .filter((entry) => entry.open)
    .map((entry) => entry.id);
}

/** The notebook a note is in, or null for the default notebook. */
export function notebookOfNote(
  snapshot: WorkspaceSnapshot,
  noteId: string,
): { readonly id: string; readonly name: string } | null {
  const folderId = snapshot.notes.find((note) => note.id === noteId)?.folderId ?? null;
  const index = notebookIndex(snapshot.folders);
  const id = index.ofFolder(folderId);
  if (id === null) return null;
  return { id, name: snapshot.folders.find((folder) => folder.id === id)?.name ?? 'Notebook' };
}

/** The notebook a note is in, for the note's header and Info (null: the default notebook). */
export function useNoteNotebook(
  noteId: string,
): { readonly id: string; readonly name: string } | null {
  const { snapshot } = useWorkspaceState();
  return useMemo(() => notebookOfNote(snapshot, noteId), [snapshot, noteId]);
}

/** The note list without closed notebooks' notes (T43, A752): the same array with none closed. */
export function useOpenNoteList(): readonly NoteListEntry[] {
  const list = useNoteList();
  const filter = useOpenNotes();
  return useMemo(() => filter(list), [list, filter]);
}
