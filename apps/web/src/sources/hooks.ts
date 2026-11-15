/**
 * The sources in React (T50 G3, A862): the contexts and the hooks that read them. The providers
 * are in `context.tsx`.
 */
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import {
  isOpen,
  type OpenSourcesState,
  type Source,
  type Sources,
  type SourcesState,
} from './registry';
import type { GitNotebookInfo } from '../desktop/bridge';
import type { GitSyncStatus } from './engine-host';
import type { GitSource } from './git-source';
import type { Workspace } from '../workspace/service';

export const SourcesContext = createContext<Sources | null>(null);
export const SourceContext = createContext<Source | null>(null);

/** The window's sources (`main.tsx` provides them around everything it renders). */
export function useSourcesRegistry(): Sources {
  const sources = useContext(SourcesContext);
  if (!sources) throw new Error('useSourcesRegistry outside SourcesProvider');
  return sources;
}

/**
 * The sources' state as it is, a notebook or not (the first run and Settings → Notebooks,
 * which list what there is).
 */
export function useAllSources(): SourcesState {
  const sources = useSourcesRegistry();
  return useSyncExternalStore(sources.subscribe, sources.getState, sources.getState);
}

/**
 * The sources' state with a notebook open, re-rendering when it changes. `FirstRunGate` mounts
 * the app only then (A1030), so the views under it never see a window without one.
 */
export function useSourcesState(): OpenSourcesState {
  const state = useAllSources();
  if (!isOpen(state)) throw new Error('useSourcesState with no notebook open (A1030)');
  return state;
}

/**
 * The app's own settings (the Journal notebook's, A827): the theme, the sidebar, the note bar and
 * the rest, whichever notebook the view in context is in.
 */
export function useAppWorkspace(): Workspace {
  return useSourcesState().journal.workspace;
}

/** The source of the view in context (null outside any scope: `main.tsx` puts the app in one). */
export function useSource(): Source | null {
  return useContext(SourceContext);
}

/** Whether the view in context is a git notebook's (A826: its own rules apply). */
export function useIsGitSource(): boolean {
  return useSource()?.kind === 'git';
}

/**
 * The source a note is in, kept current as the sources' lists load and change (A820); null
 * while it can't be told yet.
 */
export function useNoteSource(noteId: string): Source | null {
  const sources = useSourcesRegistry();
  const { all } = useAllSources();
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const offs = all.map((source) => source.notes.subscribe(listener));
      return () => {
        for (const off of offs) off();
      };
    },
    [all],
  );
  const read = () => sources.sourceOfNote(noteId);
  return useSyncExternalStore(subscribe, read, read);
}

/** A git notebook's sync status, as it changes. */
export function useGitStatus(source: GitSource): GitSyncStatus {
  return useSyncExternalStore(
    source.feed.subscribe,
    () => source.feed.status,
    () => source.feed.status,
  );
}

/**
 * A git notebook's sync status as the app shows it (Ryan's R2-7, `shownStatus`): once a sync
 * stopped, Sync Stopped through its retries until one lands or gets further. The sidebar's
 * notebook row and anything else that shows the state use this; `useGitStatus` is the status as
 * it is (Settings → Notebooks' details, what waits for a sync).
 */
export function useShownGitStatus(source: GitSource): GitSyncStatus {
  return useSyncExternalStore(
    source.feed.subscribe,
    () => source.feed.shown,
    () => source.feed.shown,
  );
}

/** A git notebook's facts (name, repository, settings), as they change. */
export function useGitInfo(source: GitSource): GitNotebookInfo {
  return useSyncExternalStore(
    (listener) => source.onInfo(listener),
    () => source.info,
    () => source.info,
  );
}
