/**
 * The sidebar's and the note panel's widths (Quanta feedback 2, item 4; A1122): each is dragged
 * by its edge, within limits that keep the sidebar's rows and the panel's tabs readable and the
 * note beside them wide enough to write in. Remembered on this device, as the sidebar's
 * collapsed state is (A508): how much room each gets depends on the window, not on the person.
 * Kept in rem, so a larger text size widens them with everything else; every window on this Mac
 * follows a change made in another.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type PaneKind = 'sidebar' | 'panel';

export interface PaneLimits {
  /** The width it has until it is dragged, in rem. */
  readonly initial: number;
  readonly min: number;
  readonly max: number;
}

export const PANE_LIMITS: Readonly<Record<PaneKind, PaneLimits>> = {
  // 17rem was the sidebar's one width (T6). 15.5rem still fits its head after the Mac's traffic
  // lights (the logo by them, then Back and Forward, the pin and the toggle: PEN-135 item 8), and
  // a notebook's name beside its buttons.
  sidebar: { initial: 17, min: 15.5, max: 30 },
  // 26rem was the panel's one width (T51), which History's diffs and the Local Graph need.
  panel: { initial: 26, min: 20, max: 44 },
};

export const PANE_KEYS: Readonly<Record<PaneKind, string>> = {
  sidebar: 'penmoss.sidebarWidth',
  panel: 'penmoss.notePanelWidth',
};

/** How wide the note's text stays beside the open panel, in rem (the panel moves over it below). */
export const NOTE_MIN_REM = 34;

/** `rem` within the kind's limits, to a sixteenth of a rem. */
export function clampPane(kind: PaneKind, rem: number): number {
  const { min, max, initial } = PANE_LIMITS[kind];
  if (!Number.isFinite(rem)) return initial;
  return Math.round(Math.min(max, Math.max(min, rem)) * 16) / 16;
}

/** A stored width, read: its kind's initial width for anything that is not a number. */
export function readPaneWidth(kind: PaneKind, value: string | null): number {
  if (value === null || value.trim() === '') return PANE_LIMITS[kind].initial;
  return clampPane(kind, Number(value));
}

const listeners = new Set<() => void>();
/** Where storage throws (private mode), the widths for this page. */
const fallback: Partial<Record<PaneKind, number>> = {};

function read(kind: PaneKind): number {
  const kept = fallback[kind];
  if (kept !== undefined) return kept;
  try {
    return readPaneWidth(kind, localStorage.getItem(PANE_KEYS[kind]));
  } catch {
    return PANE_LIMITS[kind].initial;
  }
}

/** Keeps `rem` as the kind's width (the initial width forgets it). */
export function writePaneWidth(kind: PaneKind, rem: number): void {
  const width = clampPane(kind, rem);
  try {
    if (width === PANE_LIMITS[kind].initial) localStorage.removeItem(PANE_KEYS[kind]);
    else localStorage.setItem(PANE_KEYS[kind], String(width));
  } catch {
    fallback[kind] = width;
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Another window on this Mac (a note window) dragged one.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || Object.values(PANE_KEYS).includes(event.key)) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
};

/** The kind's width in rem, and a way to keep a new one. */
export function usePaneSize(kind: PaneKind): readonly [number, (rem: number) => void] {
  const width = useSyncExternalStore(
    subscribe,
    () => read(kind),
    () => PANE_LIMITS[kind].initial,
  );
  const set = useCallback((rem: number) => writePaneWidth(kind, rem), [kind]);
  return [width, set] as const;
}
