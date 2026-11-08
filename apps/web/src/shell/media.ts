/**
 * Phone layout (T36, A181): one breakpoint, the prototype's. At 700 px and
 * narrower the sidebar becomes a drawer behind a top app bar, note actions
 * move into a sheet, and a formatting bar sits above the keyboard. CSS uses
 * the same query (styles.css, `--pm-phone`); components read it here for
 * what CSS alone cannot do (focus, `inert`, rendering phone-only controls).
 */
import { useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 700px)';

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

const phone = mediaStore(PHONE_QUERY, browserMatch);

/** Whether the phone layout is showing (re-renders when the window crosses the breakpoint). */
export function usePhone(): boolean {
  return useSyncExternalStore(phone.subscribe, phone.getSnapshot, () => false);
}
