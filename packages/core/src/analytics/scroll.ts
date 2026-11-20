/**
 * Where an area is scrolled (PEN-175): the `scroll` event's position and when it is recorded,
 * shared by the page (`apps/web/src/analytics/scroll.ts`) and Android's editor page, and pinned
 * for Kotlin's twin (`ScrollEvents.kt`) by `apps/android/contract/scroll-v1.json`.
 *
 * - A position is how far down the area is, from 0 (the top) to 1 (the bottom), rounded to
 *   hundredths. It says nothing else: no note, no length, no heading.
 * - It is recorded once the scrolling settles, SCROLL_SETTLE_MS after the last movement.
 * - At most one event per area every SCROLL_MIN_GAP_MS: a position that settles sooner is held,
 *   and the latest position is recorded when the gap is up, so where the area comes to rest is
 *   never lost.
 * - A position equal to the area's last recorded one is dropped. That memory goes back to the
 *   top (0) when the area's content changes (another note, another Settings page), since a
 *   replay reads a new screen as starting at the top: a screen that opens there records nothing.
 * - Every settled change counts, whatever moved it (the person, or the app restoring a place).
 */

/** How long an area must be still before its position is recorded. */
export const SCROLL_SETTLE_MS = 300;
/** The least time between two events for one area. */
export const SCROLL_MIN_GAP_MS = 1000;

/**
 * How far down an area is: its offset over how far it can scroll, held to 0–1 and rounded to
 * hundredths. Null when it can't scroll at all (its content fits), which records nothing.
 */
export function fractionOf(top: number, scrollHeight: number, clientHeight: number): number | null {
  const range = scrollHeight - clientHeight;
  if (!Number.isFinite(range) || !Number.isFinite(top) || range < 1) return null;
  const fraction = Math.min(1, Math.max(0, top / range));
  return Math.round(fraction * 100) / 100;
}

/** The clock and timer a gate runs on: the real ones, or a test's. */
export interface ScrollClock {
  now(): number;
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realScrollClock: ScrollClock = {
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One area's settle, gap, repeat and reset rules. `emit` records the position. */
export class ScrollGate {
  /** The last position recorded, or the top since the content last changed. */
  private last = 0;
  private lastAt = Number.NEGATIVE_INFINITY;
  /** The latest position seen and not yet recorded. */
  private latest: number | null = null;
  private settling: unknown = null;
  private holding: unknown = null;

  constructor(
    private readonly emit: (position: number) => void,
    private readonly clock: ScrollClock = realScrollClock,
    private readonly settleMs = SCROLL_SETTLE_MS,
    private readonly gapMs = SCROLL_MIN_GAP_MS,
  ) {}

  /** The area moved to `position` (`fractionOf`); null, it can't scroll, is ignored. */
  moved(position: number | null): void {
    if (position === null) return;
    this.latest = position;
    if (this.settling !== null) this.clock.clear(this.settling);
    this.settling = this.clock.set(() => {
      this.settling = null;
      // A held event records the latest position when its gap is up.
      if (this.holding === null) this.flush();
    }, this.settleMs);
  }

  /** The area's content changed: its last position is the top again, and what waits is dropped. */
  reset(): void {
    this.stop();
    this.last = 0;
  }

  /** Drops what waits (the area is gone). */
  stop(): void {
    if (this.settling !== null) this.clock.clear(this.settling);
    if (this.holding !== null) this.clock.clear(this.holding);
    this.settling = null;
    this.holding = null;
    this.latest = null;
  }

  private flush(): void {
    const position = this.latest;
    if (position === null) return;
    if (position === this.last) {
      this.latest = null;
      return;
    }
    const wait = this.lastAt + this.gapMs - this.clock.now();
    if (wait > 0) {
      this.holding = this.clock.set(() => {
        this.holding = null;
        // Still moving: the settle records it.
        if (this.settling === null) this.flush();
      }, wait);
      return;
    }
    this.latest = null;
    this.last = position;
    this.lastAt = this.clock.now();
    this.emit(position);
  }
}
