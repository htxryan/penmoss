/**
 * `app layout` (PEN-174): how a main or note window's page is laid out, so a replay shows what
 * the person saw: the sidebar (shown with its width, the Mac's icon rail, or hidden), the shown
 * note's panel, Full Width, the theme's mode, and how many tabs are open (a count bucket).
 *
 * Each part comes from the component that owns it (`useLayoutPart`): the app's own for the
 * window, Full Width, the theme and the tabs; the notes shell for its sidebar; the note view for
 * its panel. A part whose component is not mounted takes its resting value: no sidebar (Settings,
 * a note window), no panel (no note on screen). Once the window's parts are known, and 500 ms
 * after the last change to any of them, one event is recorded when the layout differs from the
 * last one this page recorded. So a sidebar drag, or Close Others closing five tabs, records
 * once, after the command or setting event the change already records.
 */
import { useEffect } from 'react';
import {
  countBucket,
  lengthOf,
  type PanelState,
  type Props,
  type SidebarState,
  type ThemeModeName,
} from '@penmoss/core/analytics';
import { record } from './record';

/** How long the layout must hold before it is recorded. */
export const LAYOUT_SETTLE_MS = 500;

export interface LayoutParts {
  readonly window: 'main' | 'note';
  readonly sidebar: SidebarState;
  /** The sidebar's rendered width in CSS px; sent only while it is shown. */
  readonly sidebarWidth: number | null;
  readonly panel: PanelState;
  readonly fullWidth: boolean;
  readonly themeMode: ThemeModeName;
  /** How many tabs the strip shows; null where there are no tabs (a note window). */
  readonly tabs: number | null;
}

/** What a part is while nothing gives it. */
const RESTING: Partial<LayoutParts> = { sidebar: 'hidden', sidebarWidth: null, panel: 'none' };

/** The parts the app itself gives: none is recorded until all are known. */
const REQUIRED = ['window', 'fullWidth', 'themeMode'] as const;

/** The event's props: lengths rounded to 10, the tabs as a count bucket. */
export function layoutProps(parts: LayoutParts): Props {
  return {
    window: parts.window,
    sidebar: parts.sidebar,
    ...(parts.sidebar === 'shown' && parts.sidebarWidth !== null
      ? { sidebarWidth: lengthOf(parts.sidebarWidth) }
      : {}),
    panel: parts.panel,
    fullWidth: parts.fullWidth,
    themeMode: parts.themeMode,
    ...(parts.tabs !== null ? { tabs: countBucket(parts.tabs) } : {}),
  };
}

type Emit = (props: Props) => void;

/**
 * The page's layout as its parts change, and the settle and repeat rules. One per page; tests
 * make their own with a recorder of their own.
 */
export class LayoutTracker {
  private readonly given = new Map<keyof LayoutParts, { owner: object; value: unknown }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: string | null = null;

  constructor(
    private readonly emit: Emit = (props) => record('app', 'layout', props),
    private readonly settleMs = LAYOUT_SETTLE_MS,
  ) {}

  /** `owner` gives `key` this value (undefined: gives it no more). */
  set<K extends keyof LayoutParts>(
    owner: object,
    key: K,
    value: LayoutParts[K] | undefined,
  ): void {
    const held = this.given.get(key);
    if (value === undefined) {
      if (held?.owner !== owner) return;
      this.given.delete(key);
    } else {
      if (held?.owner === owner && held.value === value) return;
      this.given.set(key, { owner, value });
    }
    this.changed();
  }

  /** The layout now, or null while a part the app gives is not known yet. */
  parts(): LayoutParts | null {
    const value = (key: keyof LayoutParts) =>
      this.given.has(key) ? this.given.get(key)!.value : RESTING[key];
    if (REQUIRED.some((key) => !this.given.has(key))) return null;
    return {
      window: value('window') as LayoutParts['window'],
      sidebar: value('sidebar') as SidebarState,
      sidebarWidth: (value('sidebarWidth') as number | null | undefined) ?? null,
      panel: value('panel') as PanelState,
      fullWidth: value('fullWidth') as boolean,
      themeMode: value('themeMode') as ThemeModeName,
      tabs: (value('tabs') as number | null | undefined) ?? null,
    };
  }

  private changed(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.settle(), this.settleMs);
  }

  /** Records the layout now, if it is known and differs from the last one recorded. */
  settle(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const parts = this.parts();
    if (!parts) return;
    const props = layoutProps(parts);
    const key = JSON.stringify(props);
    if (key === this.last) return;
    this.last = key;
    this.emit(props);
  }
}

let tracker = new LayoutTracker();

/** The page's tracker. */
export const layoutTracker = (): LayoutTracker => tracker;

/** A fresh tracker (tests). */
export function resetLayoutTracking(next = new LayoutTracker()): void {
  tracker = next;
}

/**
 * Gives the page's layout one part while the calling component is mounted: undefined gives it
 * none (a preview's note view, which is not the window's).
 */
export function useLayoutPart<K extends keyof LayoutParts>(
  key: K,
  value: LayoutParts[K] | undefined,
): void {
  useEffect(() => {
    const owner = {};
    const target = tracker;
    target.set(owner, key, value);
    return () => target.set(owner, key, undefined);
  }, [key, value]);
}
