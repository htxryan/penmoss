/**
 * Which sidebar folders are open: per device, so it lives in localStorage
 * rather than the synced WorkspaceDoc. Storage can be missing or throw
 * (private windows, blocked site data); the tree then starts collapsed.
 */
import { useCallback, useState } from 'react';

export const EXPANDED_KEY = 'penmoss.sidebar.expanded';

export function readExpanded(storage: Pick<Storage, 'getItem'> | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(EXPANDED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeExpanded(storage: Pick<Storage, 'setItem'> | null, ids: ReadonlySet<string>) {
  try {
    storage?.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    // Remembering is a convenience; the tree still works.
  }
}

const browserStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The open folders, and a setter that opens (true), closes (false) or toggles (undefined) some. */
export function useExpanded(): [
  ReadonlySet<string>,
  (ids: readonly string[], open?: boolean) => void,
] {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    readExpanded(browserStorage()),
  );
  const change = useCallback((ids: readonly string[], open?: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of ids) {
        const want = open ?? !next.has(id);
        if (want) next.add(id);
        else next.delete(id);
      }
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      writeExpanded(browserStorage(), next);
      return next;
    });
  }, []);
  return [expanded, change];
}
