/**
 * Whether each toggle in a note is open: per device (T11), so it lives in
 * localStorage, never in the note's Y.Doc. One entry per note holds its
 * toggles' states by key (`calloutKey`). Storage can be missing or throw
 * (private windows, blocked site data); toggles then start in their default
 * state and remember changes until the page closes.
 */
import type { FoldState } from '@penmoss/editor';

export const FOLDS_PREFIX = 'penmoss.folds.';
/** Toggles remembered per note; older ones are dropped first (a toggle renamed often adds keys). */
export const MAX_FOLDS_PER_NOTE = 200;

type FoldStorage = Pick<Storage, 'getItem' | 'setItem'>;

function read(storage: FoldStorage | null, key: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

export function localFoldState(noteId: string, storage: FoldStorage | null): FoldState {
  const key = `${FOLDS_PREFIX}${noteId}`;
  let folds = read(storage, key);
  return {
    isOpen: (toggle) => folds[toggle],
    setOpen(toggle, open) {
      // Re-read first: another tab may have folded other toggles in this note.
      const merged = { ...read(storage, key), ...folds };
      delete merged[toggle];
      const entries = Object.entries(merged).slice(-(MAX_FOLDS_PER_NOTE - 1));
      folds = { ...Object.fromEntries(entries), [toggle]: open };
      try {
        storage?.setItem(key, JSON.stringify(folds));
      } catch {
        // Remembering is a convenience; the toggle still opens and closes.
      }
    },
  };
}

export function browserFoldStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
