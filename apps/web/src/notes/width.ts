/**
 * Full-width notes (T41, A501): the note column fills the window instead of
 * stopping at the theme's width (52rem for the built-ins, A500). It is one of
 * the user's synced settings (`note.fullWidth`), so it follows them to every
 * device, like the theme; this device also keeps a copy so the first frame,
 * before the workspace has loaded, already has the right width, and so the
 * choice still works while signed out (when synced settings cannot change). A
 * choice made while signed out is sent as the synced setting once it can be.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useCommand } from '../commands/hooks';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import type { KeyValueStore } from '../shell/key-value';

export const FULL_WIDTH_SETTING = 'note.fullWidth';
export const FULL_WIDTH_KEY = 'penmoss.fullWidth';
/** Set while a choice made here has not reached the synced setting yet (signed out). */
export const FULL_WIDTH_PENDING_KEY = 'penmoss.fullWidth.pending';

/** The synced value: true only for `true` (anything else is the theme's width). */
export function fullWidthOf(settings: Readonly<Record<string, unknown>>): boolean | null {
  const value = settings[FULL_WIDTH_SETTING];
  return value === undefined ? null : value === true;
}

/**
 * What the note shows and what to write, from the synced value (null: none, or it cannot be
 * read or changed now), this device's copy, and whether that copy waits to be sent.
 */
export function widthPlan(facts: {
  readonly canSync: boolean;
  readonly synced: boolean | null;
  readonly cached: boolean;
  readonly pending: boolean;
}): { readonly full: boolean; readonly send: boolean | null; readonly cache: boolean | null } {
  const { canSync, synced, cached, pending } = facts;
  // A choice made while signed out wins, and is sent once settings can change.
  if (pending) return { full: cached, send: canSync ? cached : null, cache: null };
  const full = synced ?? cached;
  return { full, send: null, cache: synced !== null && synced !== cached ? synced : null };
}

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

function readLocal(): boolean {
  try {
    return storage()?.getItem(FULL_WIDTH_KEY) === 'full';
  } catch {
    return false;
  }
}

function writeLocal(full: boolean, pending = false): void {
  try {
    if (full) storage()?.setItem(FULL_WIDTH_KEY, 'full');
    else storage()?.removeItem(FULL_WIDTH_KEY);
    if (pending) storage()?.setItem(FULL_WIDTH_PENDING_KEY, '1');
    else storage()?.removeItem(FULL_WIDTH_PENDING_KEY);
  } catch {
    // Private mode: the synced setting still holds it.
  }
  for (const listener of listeners) listener();
}

function pendingLocal(): boolean {
  try {
    return storage()?.getItem(FULL_WIDTH_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function subscribeLocal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether notes are full width, and a way to change it: the synced setting
 * when there is one, else this device's copy.
 */
export function useFullWidth(): readonly [boolean, (full: boolean) => void] {
  const workspace = useWorkspace();
  useWorkspaceState(); // re-render when settings change (here or by sync)
  const cached = useSyncExternalStore(subscribeLocal, readLocal, () => false);
  const synced = fullWidthOf(workspace.settings());
  const pending = pendingLocal();
  const { full, send, cache } = widthPlan({ canSync: true, synced, cached, pending });
  // After render, never during it: a choice an older build kept here goes to the setting;
  // otherwise this device's copy follows the notebook's.
  useEffect(() => {
    if (send !== null) {
      workspace.setSetting(FULL_WIDTH_SETTING, send);
      writeLocal(send);
    } else if (cache !== null) {
      writeLocal(cache);
    }
  }, [workspace, send, cache]);
  const set = useCallback(
    (next: boolean) => {
      writeLocal(next);
      // Off is stored too: another device's copy must not win over it.
      workspace.setSetting(FULL_WIDTH_SETTING, next);
    },
    [workspace],
  );
  return [full, set] as const;
}

/** The command (palette, menus, its shortcut): mounted once for the whole app. */
export function FullWidthCommand() {
  const [full, setFull] = useFullWidth();
  useCommand('note.fullWidth', () => setFull(!full));
  return null;
}
