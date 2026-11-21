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
 *
 * The same rules settle other values (PEN-177, A1663 keeps one copy of them): a note's cursor
 * and selection, and the length typed in a field. That gate (`SettleGate`) holds any value with
 * an equality check, and starts with nothing recorded, so a first cursor in block 0 or a first
 * length of 0 is recorded; `flush()` records what waits at once (a field that closes), and
 * `mark()` takes a value as known without recording it (typing moved the cursor there).
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

export interface SettleGateOptions<T> {
  readonly clock?: ScrollClock;
  readonly settleMs?: number;
  readonly gapMs?: number;
  /** Whether two values are the same (a repeat is dropped); `===` by default. */
  readonly equals?: (a: T, b: T) => boolean;
  /**
   * The value taken as recorded at the start and after `reset()` (a scroll's top, 0). Without
   * one, nothing is recorded yet, so the first value that settles is.
   */
  readonly start?: T;
}

/** The settle, gap, repeat and reset rules for one value. `emit` records it. */
export class SettleGate<T> {
  /** Whether anything counts as recorded (the start, or a value recorded or marked). */
  private hasLast: boolean;
  /** The last value recorded, or the start since the content last changed. */
  private last: T | undefined;
  private lastAt = Number.NEGATIVE_INFINITY;
  /** Whether a value is waiting, and the latest one seen and not yet recorded. */
  private waiting = false;
  private latest: T | undefined;
  private settling: unknown = null;
  private holding: unknown = null;
  private readonly clock: ScrollClock;
  private readonly settleMs: number;
  private readonly gapMs: number;
  private readonly equals: (a: T, b: T) => boolean;

  constructor(
    private readonly emit: (value: T) => void,
    private readonly options: SettleGateOptions<T> = {},
  ) {
    this.clock = options.clock ?? realScrollClock;
    this.settleMs = options.settleMs ?? SCROLL_SETTLE_MS;
    this.gapMs = options.gapMs ?? SCROLL_MIN_GAP_MS;
    this.equals = options.equals ?? ((a, b) => a === b);
    this.hasLast = 'start' in options;
    this.last = options.start;
  }

  /** The value is now `value`; null (an area that can't scroll) is ignored. */
  moved(value: T | null): void {
    if (value === null) return;
    this.latest = value;
    this.waiting = true;
    if (this.settling !== null) this.clock.clear(this.settling);
    this.settling = this.clock.set(() => {
      this.settling = null;
      // A held event records the latest value when its gap is up.
      if (this.holding === null) this.settle();
    }, this.settleMs);
  }

  /** The content changed: the last value is the start again, and what waits is dropped. */
  reset(): void {
    this.stop();
    this.hasLast = 'start' in this.options;
    this.last = this.options.start;
  }

  /** Drops what waits (the area or field is gone). */
  stop(): void {
    if (this.settling !== null) this.clock.clear(this.settling);
    if (this.holding !== null) this.clock.clear(this.holding);
    this.settling = null;
    this.holding = null;
    this.waiting = false;
    this.latest = undefined;
  }

  /**
   * Records what waits now, without waiting for it to settle or for the gap (a field that
   * closes with a change pending); a value equal to the last recorded is still dropped.
   */
  flush(): void {
    const waiting = this.waiting;
    const value = this.latest as T;
    this.stop();
    if (!waiting) return;
    if (this.hasLast && this.equals(value, this.last as T)) return;
    this.record(value);
  }

  /** Takes `value` as known without recording it, and drops what waits (typing moved it there). */
  mark(value: T): void {
    this.stop();
    this.hasLast = true;
    this.last = value;
  }

  private record(value: T): void {
    this.hasLast = true;
    this.last = value;
    this.lastAt = this.clock.now();
    this.emit(value);
  }

  private settle(): void {
    if (!this.waiting) return;
    const value = this.latest as T;
    if (this.hasLast && this.equals(value, this.last as T)) {
      this.waiting = false;
      this.latest = undefined;
      return;
    }
    const wait = this.lastAt + this.gapMs - this.clock.now();
    if (wait > 0) {
      this.holding = this.clock.set(() => {
        this.holding = null;
        // Still moving: the settle records it.
        if (this.settling === null) this.settle();
      }, wait);
      return;
    }
    this.waiting = false;
    this.latest = undefined;
    this.record(value);
  }
}

/** One area's settle, gap, repeat and reset rules. `emit` records the position. */
export class ScrollGate extends SettleGate<number> {
  constructor(
    emit: (position: number) => void,
    clock: ScrollClock = realScrollClock,
    settleMs = SCROLL_SETTLE_MS,
    gapMs = SCROLL_MIN_GAP_MS,
  ) {
    super(emit, { clock, settleMs, gapMs, start: 0 });
  }
}
