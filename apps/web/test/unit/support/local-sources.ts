/**
 * A git notebook's notes and folders without its engine (T59: the only kind, D49), for tests
 * that render views over one source: a sync backend whose state a test sets, and the services
 * over an in-memory store.
 */
import type { ReplicaStore } from '@penmoss/sync-client';
import {
  Notes,
  type LocalNotes,
  type LocalSyncBackend,
  type LocalSyncState,
  type NotesOptions,
} from '../../../src/notes/service';
import { Workspace, type WorkspaceOptions } from '../../../src/workspace/service';

export const TEST_NOTEBOOK = 'nb-test';

/** A sync backend that stays where a test puts it. */
export function staticBackend(initial: Partial<LocalSyncState> = {}): LocalSyncBackend & {
  set(next: Partial<LocalSyncState>): void;
  readonly purged: string[];
} {
  let state: LocalSyncState = { phase: 'synced', detail: null, pending: new Set(), ...initial };
  const listeners = new Set<() => void>();
  const purged: string[] = [];
  return {
    purged,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    purge(id) {
      purged.push(id);
      return Promise.resolve();
    },
    set(next) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
}

/** A source's notes over `store`. */
export function testNotes(store: LocalNotes, options: Partial<NotesOptions> = {}): Notes {
  return new Notes({
    backend: staticBackend(),
    periodicSalt: TEST_NOTEBOOK,
    openStore: () => Promise.resolve(store),
    ...options,
  });
}

/** A source's folders and settings over `store`. */
export function testWorkspace(
  store: ReplicaStore,
  options: Partial<WorkspaceOptions> = {},
): Workspace {
  return new Workspace({
    gitNotebook: { id: TEST_NOTEBOOK },
    openStore: () => Promise.resolve(store),
    ...options,
  });
}
