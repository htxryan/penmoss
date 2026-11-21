/**
 * Where an area is scrolled (PEN-175): `fractionOf` and the ScrollGate's settle, gap, repeat and
 * reset rules, on a fake clock; then the cases Kotlin's `ScrollEvents` replays, pinned in
 * `apps/android/contract/scroll-v1.json`.
 *
 * After changing the rules, write the contract again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/core exec vitest run test/analytics-scroll`,
 * then `pnpm exec prettier --write apps/android/contract/scroll-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  fractionOf,
  SCROLL_MIN_GAP_MS,
  SCROLL_SETTLE_MS,
  ScrollGate,
  SettleGate,
  type ScrollClock,
} from '../src/analytics/scroll';

/** A clock that moves only when told, running each timer as its time comes. */
class FakeClock implements ScrollClock {
  time = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  now(): number {
    return this.time;
  }

  set(run: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run });
    return id;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Moves to `to`, running each timer due by then in time order. */
  advance(to: number): void {
    for (;;) {
      let due: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= to && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].run();
    }
    this.time = to;
  }
}

/** One step of a case: the area moved to a position (null: it can't scroll), or its content changed. */
type Step =
  | { readonly at: number; readonly move: number | null }
  | { readonly at: number; readonly reset: true };

interface GateCase {
  readonly name: string;
  readonly steps: readonly Step[];
  /** When the case ends. */
  readonly until: number;
  /** What is recorded, and when. */
  readonly recorded: ReadonlyArray<{ readonly at: number; readonly position: number }>;
}

function run(steps: readonly Step[], until: number): Array<{ at: number; position: number }> {
  const clock = new FakeClock();
  const recorded: Array<{ at: number; position: number }> = [];
  const gate = new ScrollGate((position) => recorded.push({ at: clock.now(), position }), clock);
  for (const step of steps) {
    clock.advance(step.at);
    if ('reset' in step) gate.reset();
    else gate.moved(step.move);
  }
  clock.advance(until);
  return recorded;
}

/** A run of movements every `every` ms from `from` to `to` (exclusive), ending at `position`. */
function scrolling(from: number, to: number, every: number, position: number): Step[] {
  const steps: Step[] = [];
  for (let at = from; at < to; at += every) {
    steps.push({ at, move: Math.round(((at - from) / (to - from)) * position * 100) / 100 });
  }
  steps.push({ at: to, move: position });
  return steps;
}

const S = SCROLL_SETTLE_MS;
const G = SCROLL_MIN_GAP_MS;

const GATE_CASES: readonly GateCase[] = [
  {
    name: 'records once the area has been still for the settle time',
    steps: [{ at: 0, move: 0.42 }],
    until: 5000,
    recorded: [{ at: S, position: 0.42 }],
  },
  {
    name: 'waits while it keeps moving, then records where it rests',
    steps: scrolling(0, 2000, 50, 0.8),
    until: 5000,
    recorded: [{ at: 2000 + S, position: 0.8 }],
  },
  {
    name: 'records nothing for a screen that opens at the top',
    steps: [{ at: 0, move: 0 }],
    until: 5000,
    recorded: [],
  },
  {
    name: 'drops a position equal to the last one recorded',
    steps: [
      { at: 0, move: 0.3 },
      { at: 2000, move: 0.35 },
      { at: 2100, move: 0.3 },
    ],
    until: 5000,
    recorded: [{ at: S, position: 0.3 }],
  },
  {
    name: 'holds a position that settles within the gap, then records the latest when it is up',
    steps: [
      { at: 0, move: 0.2 },
      { at: S + 100, move: 0.25 },
      { at: S + 300, move: 0.3 },
    ],
    until: 5000,
    recorded: [
      { at: S, position: 0.2 },
      { at: S + G, position: 0.3 },
    ],
  },
  {
    name: 'a hold that ends while the area moves again waits for it to settle',
    steps: [
      { at: 0, move: 0.2 },
      { at: S + 100, move: 0.25 },
      { at: S + 900, move: 0.5 },
      { at: S + 1100, move: 0.6 },
    ],
    until: 5000,
    recorded: [
      { at: S, position: 0.2 },
      { at: S + 1100 + S, position: 0.6 },
    ],
  },
  {
    name: 'a held position that comes back to the last one recorded records nothing',
    steps: [
      { at: 0, move: 0.2 },
      { at: S + 100, move: 0.5 },
      { at: S + 500, move: 0.2 },
    ],
    until: 5000,
    recorded: [{ at: S, position: 0.2 }],
  },
  {
    name: 'a content change forgets the last position and drops what waits',
    steps: [
      { at: 0, move: 0.6 },
      { at: 1000, move: 0.7 },
      { at: 1100, reset: true },
      { at: 1150, move: 0 },
      { at: 3000, move: 0.6 },
    ],
    until: 5000,
    recorded: [
      { at: S, position: 0.6 },
      { at: 3000 + S, position: 0.6 },
    ],
  },
  {
    name: 'the app restoring a place in new content records it',
    steps: [
      { at: 0, move: 0.5 },
      { at: 2000, reset: true },
      { at: 2010, move: 0.42 },
    ],
    until: 5000,
    recorded: [
      { at: S, position: 0.5 },
      { at: 2010 + S, position: 0.42 },
    ],
  },
  {
    name: 'a content change keeps the gap: at most one a second still',
    steps: [
      { at: 0, move: 0.5 },
      { at: S + 10, reset: true },
      { at: S + 20, move: 0.9 },
    ],
    until: 5000,
    recorded: [
      { at: S, position: 0.5 },
      { at: S + G, position: 0.9 },
    ],
  },
  {
    name: 'an area that cannot scroll records nothing',
    steps: [
      { at: 0, move: null },
      { at: 100, move: null },
    ],
    until: 5000,
    recorded: [],
  },
  {
    name: 'goes to the bottom and back to the top',
    steps: [
      { at: 0, move: 1 },
      { at: 2000, move: 0 },
    ],
    until: 5000,
    recorded: [
      { at: S, position: 1 },
      { at: 2000 + S, position: 0 },
    ],
  },
];

/** A value a generalised gate holds (PEN-177): a cursor's block, or a selection. */
type Value = number | { readonly block: number; readonly chars: number; readonly span: number };

/** One step of a value case: a value, a flush, a mark (known, not recorded) or a reset. */
type ValueStep =
  | { readonly at: number; readonly move: Value }
  | { readonly at: number; readonly flush: true }
  | { readonly at: number; readonly mark: Value }
  | { readonly at: number; readonly reset: true };

interface ValueCase {
  readonly name: string;
  readonly steps: readonly ValueStep[];
  readonly until: number;
  readonly recorded: ReadonlyArray<{ readonly at: number; readonly value: Value }>;
}

/** Two values are the same when they hold the same numbers. */
const sameValue = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

function runValues(
  steps: readonly ValueStep[],
  until: number,
): Array<{ at: number; value: Value }> {
  const clock = new FakeClock();
  const recorded: Array<{ at: number; value: Value }> = [];
  // As a cursor, a selection or a field's length starts: nothing recorded yet.
  const gate = new SettleGate<Value>((value) => recorded.push({ at: clock.now(), value }), {
    clock,
    equals: sameValue,
  });
  for (const step of steps) {
    clock.advance(step.at);
    if ('reset' in step) gate.reset();
    else if ('flush' in step) gate.flush();
    else if ('mark' in step) gate.mark(step.mark);
    else gate.moved(step.move);
  }
  clock.advance(until);
  return recorded;
}

const VALUE_CASES: readonly ValueCase[] = [
  {
    name: 'records a first value of 0: nothing is recorded yet',
    steps: [{ at: 0, move: 0 }],
    until: 5000,
    recorded: [{ at: S, value: 0 }],
  },
  {
    name: 'a cursor that moves on settles where it rests, at most one a second',
    steps: [
      { at: 0, move: 3 },
      { at: S + 50, move: 4 },
      { at: S + 100, move: 5 },
    ],
    until: 5000,
    recorded: [
      { at: S, value: 3 },
      { at: S + G, value: 5 },
    ],
  },
  {
    name: 'drops a repeat of the last value recorded',
    steps: [
      { at: 0, move: 2 },
      { at: 1000, move: 2 },
    ],
    until: 5000,
    recorded: [{ at: S, value: 2 }],
  },
  {
    name: 'a selection is the same only with the same block, length and span',
    steps: [
      { at: 0, move: { block: 1, chars: 40, span: 2 } },
      { at: 1000, move: { block: 1, chars: 40, span: 2 } },
      { at: 2000, move: { block: 1, chars: 41, span: 2 } },
      { at: 3000, move: { block: 1, chars: 41, span: 3 } },
    ],
    until: 5000,
    recorded: [
      { at: S, value: { block: 1, chars: 40, span: 2 } },
      { at: 2000 + S, value: { block: 1, chars: 41, span: 2 } },
      { at: 3000 + S, value: { block: 1, chars: 41, span: 3 } },
    ],
  },
  {
    name: 'a flush records what waits at once, inside the settle and the gap',
    steps: [
      { at: 0, move: 7 },
      { at: S + 10, move: 12 },
      { at: S + 20, flush: true },
    ],
    until: 5000,
    recorded: [
      { at: S, value: 7 },
      { at: S + 20, value: 12 },
    ],
  },
  {
    name: 'a flush with nothing waiting, or a repeat waiting, records nothing',
    steps: [
      { at: 0, move: 7 },
      { at: 1000, flush: true },
      { at: 2000, move: 7 },
      { at: 2010, flush: true },
    ],
    until: 5000,
    recorded: [{ at: S, value: 7 }],
  },
  {
    name: 'a mark takes a value as known and drops what waits',
    steps: [
      { at: 0, move: 4 },
      { at: 100, mark: 6 },
      { at: 2000, move: 6 },
      { at: 3000, move: 4 },
    ],
    until: 5000,
    recorded: [{ at: 3000 + S, value: 4 }],
  },
  {
    name: 'a reset forgets the last value: the next is recorded again',
    steps: [
      { at: 0, move: 0 },
      { at: 2000, reset: true },
      { at: 2010, move: 0 },
    ],
    until: 5000,
    recorded: [
      { at: S, value: 0 },
      { at: 2010 + S, value: 0 },
    ],
  },
];

describe('SettleGate (PEN-177)', () => {
  for (const each of VALUE_CASES) {
    it(each.name, () => {
      expect(runValues(each.steps, each.until)).toEqual(each.recorded);
    });
  }

  it('a scroll gate still starts at the top and resets to it', () => {
    expect(run([{ at: 0, move: 0 }], 5000)).toEqual([]);
  });
});

/** [scrollTop, scrollHeight, clientHeight] and the position, or null when it can't scroll. */
const FRACTION_CASES: ReadonlyArray<readonly [number, number, number, number | null]> = [
  [0, 2000, 500, 0],
  [1500, 2000, 500, 1],
  [630, 2000, 500, 0.42],
  [7, 1500, 800, 0.01],
  [3, 1500, 800, 0],
  [693, 1500, 800, 0.99],
  [697, 1500, 800, 1],
  [-40, 2000, 500, 0],
  [1600, 2000, 500, 1],
  [100.5, 1201, 200, 0.1],
  [0, 500, 500, null],
  [0, 400, 500, null],
  [0, 500.4, 500, null],
];

describe('fractionOf', () => {
  it('is the offset over how far the area scrolls, held to 0–1, in hundredths', () => {
    for (const [top, height, client, expected] of FRACTION_CASES) {
      expect(fractionOf(top, height, client), `${top}/${height}-${client}`).toBe(expected);
    }
  });

  it('is a whole number of hundredths for every offset', () => {
    for (let top = 0; top <= 1700; top++) {
      const value = fractionOf(top, 2000, 300)!;
      expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-9);
    }
  });

  it('is null for what is not a number', () => {
    expect(fractionOf(Number.NaN, 2000, 500)).toBeNull();
    expect(fractionOf(0, Number.POSITIVE_INFINITY, 500)).toBeNull();
  });
});

describe('ScrollGate', () => {
  for (const each of GATE_CASES) {
    it(each.name, () => {
      expect(run(each.steps, each.until)).toEqual(each.recorded);
    });
  }

  it('records at most one a second: ten minutes of nonstop scrolling records at most 600', () => {
    // Scrolls for 350 ms, rests for 310 ms (just past the settle), over and over: the most
    // settled positions an area can have, each different from the last.
    const steps: Step[] = [];
    let position = 0;
    for (let at = 0; at < 600_000; at += 660) {
      position = position >= 0.9 ? 0.01 : Math.round((position + 0.03) * 100) / 100;
      for (let t = at; t < at + 350; t += 16) steps.push({ at: t, move: position });
    }
    const recorded = run(steps, 610_000);
    expect(recorded.length).toBeGreaterThan(300);
    expect(recorded.length).toBeLessThanOrEqual(600);
    for (let i = 1; i < recorded.length; i++) {
      expect(recorded[i]!.at - recorded[i - 1]!.at).toBeGreaterThanOrEqual(G);
    }
  });

  it('moving without rest records nothing until it rests', () => {
    expect(run(scrolling(0, 600_000, 16, 0.5), 600_000)).toEqual([]);
  });

  it('stop drops what waits', () => {
    const clock = new FakeClock();
    const recorded: number[] = [];
    const gate = new ScrollGate((position) => recorded.push(position), clock);
    gate.moved(0.5);
    gate.stop();
    clock.advance(5000);
    expect(recorded).toEqual([]);
  });
});

const FILE = fileURLToPath(
  new URL('../../../apps/android/contract/scroll-v1.json', import.meta.url),
);

function contract() {
  return {
    $comment:
      'Where an area is scrolled (PEN-175), written from packages/core/src/analytics/scroll.ts by packages/core/test/analytics-scroll.test.ts, which also checks it. `fraction`: [scrollTop, scrollHeight, clientHeight] and the position fractionOf gives (null: the area cannot scroll). `gate`: a ScrollGate run on a fake clock from 0; each step at its time moves the area to a position (null: it cannot scroll) or resets it (its content changed); `recorded` is each position the gate records, and when. `values` (PEN-177): the same gate holding any value (a cursor’s block, a selection as block, chars and span, a field’s length), starting with nothing recorded, so a first 0 is recorded; values are the same when equal as JSON; a step may also flush (record what waits at once, inside the settle and the gap, a repeat still dropped) or mark a value (known, not recorded; what waits is dropped). Kotlin’s ScrollEvents replays every case.',
    settleMs: SCROLL_SETTLE_MS,
    minGapMs: SCROLL_MIN_GAP_MS,
    fraction: FRACTION_CASES,
    gate: GATE_CASES,
    values: VALUE_CASES,
  };
}

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') writeFileSync(FILE, text(contract()));

describe('apps/android/contract/scroll-v1.json', () => {
  it('holds the rules and the cases as core has them', () => {
    const stored: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(stored).toEqual(JSON.parse(text(contract())));
  });
});
