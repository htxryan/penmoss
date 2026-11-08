import {
  movedQuickAccess,
  quickAccessOf,
  QUICK_ACCESS_SETTING,
  toggledQuickAccess,
} from '@penmoss/core/quick-access';
import { defaultNotebookName } from '@penmoss/sync-client/workspace';
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useSourcesState } from '../sources/hooks';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { notebookOfNote } from '../workspace/notebooks';
import type { Workspace } from '../workspace/service';
import { useNotes } from './hooks';
import type { NoteListEntry } from './list';

export interface QuickAccess {
  /** The pinned note ids, in pin order (trashed or unknown ones included: they stay pinned). */
  readonly ids: readonly string[];
  /** Pins `id` at the end, or unpins it; false when the list is full and nothing changed. */
  readonly toggle: (id: string) => boolean;
  readonly pinned: (id: string) => boolean;
  /** Moves a pinned note to `index` in the list (T53 item 10: dragged into order). */
  readonly move: (id: string, index: number) => void;
  /** Settings can change now: this device's copy is read (until then they are only defaults). */
  readonly canChange: boolean;
}

/**
 * Quick Access (T51, A946): the notes pinned to reach from anywhere, one synced setting
 * (`quickAccess.notes`). Read from and written to the app's own settings (the Journal
 * notebook's, A827, as the palette's are), whichever
 * source's note is open, so a pin made beside a git note lands in the same list.
 */
export function useQuickAccess(): QuickAccess {
  const inScope = useWorkspace();
  const sources = useSourcesState();
  const notes = useNotes();
  const workspace: Workspace = sources?.root.workspace ?? inScope;
  // Re-renders when the settings change, here or by sync.
  const { loaded } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getState,
    workspace.getState,
  );
  const ids = quickAccessOf(workspace.settings());
  /** Whether any source this window holds knows the note (its Trash too); null while unsure. */
  const knows = useCallback(
    (id: string): boolean | null => {
      let unsure = false;
      for (const each of sources ? sources.all.map((source) => source.notes) : [notes]) {
        const known = each.knows(id);
        if (known === true) return true;
        if (known === null) unsure = true;
      }
      return unsure ? null : false;
    },
    [sources, notes],
  );
  const toggle = useCallback(
    (id: string) => {
      // The list now, not this render's: two quick toggles must not undo each other.
      const next = pinToggled(quickAccessOf(workspace.settings()), id, knows);
      if (next === null) return false;
      // An empty list is stored, not removed: an older pin elsewhere must not come back.
      workspace.setSetting(QUICK_ACCESS_SETTING, next);
      return true;
    },
    [workspace],
  );
  const move = useCallback(
    (id: string, index: number) =>
      workspace.setSetting(
        QUICK_ACCESS_SETTING,
        movedQuickAccess(quickAccessOf(workspace.settings()), id, index),
      ),
    [workspace],
  );
  const pinned = (id: string) => ids.includes(id);
  return { ids, toggle, pinned, move, canChange: loaded };
}

/**
 * The list with `id` pinned or unpinned (T51, A946); null when it is full. A full list first
 * lets go of pins no source knows any more (not in any note list, nor in Trash: deleted for
 * good, or a removed git notebook's), which the sidebar and menus never show and so could never
 * be unpinned (T51 review). Only when pinning: unpinning never drops another pin, and a pin
 * whose note cannot be told yet (`knows` null, a list still loading) stays.
 */
export function pinToggled(
  list: readonly string[],
  id: string,
  knows: (id: string) => boolean | null,
): readonly string[] | null {
  const next = toggledQuickAccess(list, id);
  if (next !== null || list.includes(id)) return next;
  const reachable = list.filter((pin) => knows(pin) !== false);
  if (reachable.length === list.length) return null;
  return toggledQuickAccess(reachable, id);
}

export interface QuickAccessNote {
  readonly id: string;
  /** As the note list has it: empty for an untitled note (show `displayTitle`). */
  readonly title: string;
  /**
   * The notebook it is in, by name (T53 item 10): a git notebook's, a notebook folder's, or the
   * default notebook's. Null unless asked for.
   */
  readonly notebook: string | null;
}

const NO_SOURCES = (): (() => void) => () => undefined;

/**
 * The pinned notes with their titles, in pin order (T51, A946), looked up in every source this
 * window holds (the personal notes and each git notebook), or the notes in context without a
 * registry. A trashed note, or one not on this device, is left out but stays pinned. With
 * `withNotebooks`, each names its notebook too (T53 item 10).
 */
export function useQuickAccessNotes(withNotebooks = false): readonly QuickAccessNote[] {
  const { ids } = useQuickAccess();
  const notes = useNotes();
  const state = useSourcesState();
  const inScope = useWorkspace();
  const lists = useMemo(
    () => (state ? state.all.map((source) => source.notes) : [notes]),
    [state, notes],
  );
  /** The notebook's name for a note in the list at `index`. */
  const notebookOf = useCallback(
    (index: number, id: string): string => {
      const source = state?.all[index];
      if (source?.kind === 'git') return source.name;
      const { snapshot } = (source?.workspace ?? inScope).getState();
      return notebookOfNote(snapshot, id)?.name ?? defaultNotebookName(snapshot);
    },
    [state, inScope],
  );
  const subscribe = useMemo(() => {
    if (lists.length === 0) return NO_SOURCES;
    return (listener: () => void) => {
      const offs = lists.map((source) => source.subscribe(listener));
      return () => {
        for (const off of offs) off();
      };
    };
  }, [lists]);
  // Each source's list keeps its reference until it changes: the same snapshot until one does.
  const last = useRef<readonly (readonly NoteListEntry[])[]>([]);
  const read = useCallback(() => {
    const now = lists.map((source) => source.list());
    const same =
      now.length === last.current.length && now.every((list, i) => list === last.current[i]);
    if (!same) last.current = now;
    return last.current;
  }, [lists]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  // Where each note is filed and what its notebook is called: a notebook renamed or a pinned
  // note moved to another one names it afresh (the note lists carry neither).
  const filed = useWorkspaceState().snapshot;
  const key = ids.join(',');
  return useMemo(() => {
    const found = new Map<string, { title: string; index: number }>();
    snapshot.forEach((list, index) => {
      for (const entry of list) found.set(entry.id, { title: entry.title, index });
    });
    return key
      .split(',')
      .filter((id) => id !== '' && found.has(id))
      .map((id) => {
        const { title, index } = found.get(id)!;
        return { id, title, notebook: withNotebooks ? notebookOf(index, id) : null };
      });
    // `filed` is read through `notebookOf`; listed so a change to it names the notebooks again.
  }, [snapshot, key, notebookOf, withNotebooks, withNotebooks ? filed : null]);
}
