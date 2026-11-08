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

export const SourcesContext = createContext<Sources | null>(null);
export const SourceContext = createContext<Source | null>(null);

/** The window's sources; null where there are none (tests that render one source). */
export function useSourcesRegistry(): Sources | null {
  return useContext(SourcesContext);
}

const NO_SOURCES = (): (() => void) => () => undefined;

const openState = (sources: Sources | null): OpenSourcesState | null => {
  const state = sources?.getState() ?? null;
  return state && isOpen(state) ? state : null;
};

/**
 * The sources' state once there is a notebook, re-rendering when it changes; null without a
 * registry (tests that render one source) or with no notebook yet (the first run shows then,
 * A1030, so the app's views never see it).
 */
export function useSourcesState(): OpenSourcesState | null {
  const sources = useSourcesRegistry();
  return useSyncExternalStore(
    sources?.subscribe ?? NO_SOURCES,
    () => openState(sources),
    () => openState(sources),
  );
}

/**
 * The sources' state as it is, a notebook or not (the first run and Settings → Git Notebooks,
 * which list what there is); null without a registry.
 */
export function useAllSources(): SourcesState | null {
  const sources = useSourcesRegistry();
  return useSyncExternalStore(
    sources?.subscribe ?? NO_SOURCES,
    () => sources?.getState() ?? null,
    () => sources?.getState() ?? null,
  );
}

/** The source of the view in context (null outside any scope: a single-source page). */
export function useSource(): Source | null {
  return useContext(SourceContext);
}

/** Whether the view in context is a git notebook's (A826: its own rules apply). */
export function useIsGitSource(): boolean {
  return useSource()?.kind === 'git';
}

/**
 * The source a note is in, kept current as the sources' lists load and change (A820); null
 * while it can't be told yet. Without a registry, the source in context.
 */
export function useNoteSource(noteId: string): Source | null {
  const sources = useSourcesRegistry();
  const inScope = useSource();
  const state = useSourcesState();
  const subscribe = useMemo(() => {
    if (!sources || !state) return NO_SOURCES;
    return (listener: () => void) => {
      const offs = state.all.map((source) => source.notes.subscribe(listener));
      return () => {
        for (const off of offs) off();
      };
    };
  }, [sources, state]);
  const read = () => (sources ? sources.sourceOfNote(noteId) : inScope);
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

/** A git notebook's facts (name, repository, settings), as they change. */
export function useGitInfo(source: GitSource): GitNotebookInfo {
  return useSyncExternalStore(
    (listener) => source.onInfo(listener),
    () => source.info,
    () => source.info,
  );
}
