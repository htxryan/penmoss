/**
 * The collapsed sidebar (T41, A508): an icon rail with Search, Today, This
 * week, Graph and Commands, and no note list, calendar or tags. Remembered
 * on this device, like the Info panel: how much room the sidebar gets depends
 * on the window, not on the person. A phone has its drawer instead.
 */
import { useCallback, useSyncExternalStore } from 'react';

export const SIDEBAR_KEY = 'penmoss.sidebar';

const listeners = new Set<() => void>();
/** Where storage throws (private mode), the choice for this page. */
let fallback: boolean | null = null;

function read(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function write(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_KEY, 'collapsed');
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    // Private mode: the choice lasts for this page only.
    fallback = collapsed;
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const snapshot = () => fallback ?? read();

export function useSidebarCollapsed(): readonly [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, snapshot, () => false);
  const set = useCallback((next: boolean) => write(next), []);
  return [collapsed, set] as const;
}
