/**
 * The sidebar's and the note panel's widths (Quanta feedback 2, item 4; A1122): each is dragged
 * by its edge, within limits that keep the sidebar's rows and the panel's tabs readable and the
 * note beside them wide enough to write in. Remembered on this device, as the sidebar's
 * collapsed state is (A508): how much room each gets depends on the window, not on the person.
 * Kept in rem, so a larger text size widens them with everything else; every window on this Mac
 * follows a change made in another.
 */
import { devicePref, useDevicePref, type DevicePref } from './device-pref';

/**
 * `historyPreview` is a height: History's docked changes under its list of versions (Ryan's
 * review of #192, finding 13), split from the list by a handle.
 */
export type PaneKind = 'sidebar' | 'panel' | 'historyPreview';

export interface PaneLimits {
  /** The width it has until it is dragged, in rem. */
  readonly initial: number;
  readonly min: number;
  readonly max: number;
}

export const PANE_LIMITS: Readonly<Record<PaneKind, PaneLimits>> = {
  // 17rem was the sidebar's one width (T6). 14.5rem still fits its head's buttons after the Mac's
  // traffic lights (88px, then Back and Forward, the pin and the toggle: PEN-135 item 8), and a
  // notebook's name beside its buttons.
  sidebar: { initial: 17, min: 14.5, max: 30 },
  // 26rem was the panel's one width (T51), which History's diffs and the Local Graph need.
  panel: { initial: 26, min: 20, max: 44 },
  // About 14 diff lines and the actions under them; the list keeps its own room above it.
  historyPreview: { initial: 20, min: 8, max: 48 },
};

export const PANE_KEYS: Readonly<Record<PaneKind, string>> = {
  sidebar: 'penmoss.sidebarWidth',
  panel: 'penmoss.notePanelWidth',
  historyPreview: 'penmoss.historyPreviewHeight',
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

/** Each kind's width on this device; another window on this Mac (a note window) follows a drag. */
const widths = Object.fromEntries(
  (Object.keys(PANE_KEYS) as PaneKind[]).map((kind) => [
    kind,
    devicePref(PANE_KEYS[kind], {
      parse: (stored) => readPaneWidth(kind, stored),
      // The initial width forgets it.
      serialise: (rem) => {
        const width = clampPane(kind, rem);
        return width === PANE_LIMITS[kind].initial ? null : String(width);
      },
      crossWindow: true,
    }),
  ]),
) as Record<PaneKind, DevicePref<number>>;

/** The kind's width in rem, and a way to keep a new one. */
export function usePaneSize(kind: PaneKind): readonly [number, (rem: number) => void] {
  return useDevicePref(widths[kind]);
}
