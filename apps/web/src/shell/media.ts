/**
 * The narrow window's layout (T36, A181, A727): one breakpoint, the prototype's. A Mac window
 * 700 px wide or narrower (it can be 480 px) gets the layout once made for phones, which the
 * CSS and some names still call the phone layout: the sidebar becomes a drawer behind a top app
 * bar, note actions move into a sheet, and a formatting bar sits along the bottom. CSS uses the
 * same query (shell/narrow.css and the other `max-width: 700px` rules); components read it here
 * for what CSS alone cannot do (focus, `inert`, rendering its own controls).
 */
import { useSyncExternalStore } from 'react';

export const NARROW_QUERY = '(max-width: 700px)';

type MatchMedia = (
  query: string,
) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

/** A store for one media query; never matches where there is no `matchMedia` (server, tests). */
export function mediaStore(query: string, matchMedia: MatchMedia | undefined) {
  const list = matchMedia?.(query) ?? null;
  return {
    subscribe: (onChange: () => void): (() => void) => {
      if (!list) return () => undefined;
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    getSnapshot: (): boolean => list?.matches ?? false,
  };
}

const browserMatch: MatchMedia | undefined =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? (query) => window.matchMedia(query)
    : undefined;

const narrow = mediaStore(NARROW_QUERY, browserMatch);

/** Whether the narrow layout is showing (re-renders when the window crosses the breakpoint). */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(narrow.subscribe, narrow.getSnapshot, () => false);
}
