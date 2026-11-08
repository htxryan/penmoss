import { describe, expect, it } from 'vitest';
import type { Board } from '../src/board.ts';
import { labelProblems, tick, type Running } from '../src/dispatcher.ts';
import { BlockedByRyan, guardEffects } from '../src/guard.ts';
import { item as anyItem, testConfig } from './helpers.ts';

const config = testConfig();
/** A card that skips planning, so it takes a slot straight from Ready. */
const item: typeof anyItem = (n, o = {}) => anyItem(n, { labels: ['plan:skip'], ...o });
const board = (items: Board['items']): Board => ({
  items,
});
const run = (issue: number, slot: number): Running => ({
  issue,
  slot,
  startedAt: '2026-11-07T12:00:00Z',
  why: 'picked',
});

describe('tick', () => {
  it('starts two of three Ready cards, and the third waits for a slot', () => {
    const t = tick(board([item(1), item(2), item(3)]), config, [], new Set());
    expect(t.start.map((s) => [s.item.number, s.slot.id])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(t.waiting).toEqual([3]);
  });

  it('starts the waiting card once a slot frees', () => {
    const t = tick(
      board([item(1, { status: 'In progress' }), item(3)]),
      config,
      [run(1, 1)],
      new Set([1]),
    );
    expect(t.start.map((s) => [s.item.number, s.slot.id, s.why])).toEqual([[3, 2, 'picked']]);
  });

  it('starts nothing while every slot is busy', () => {
    expect(tick(board([item(3)]), config, [run(1, 1), run(2, 2)], new Set()).start).toEqual([]);
  });

  it('restarts an orphaned In progress run first, after a crash (R12)', () => {
    const t = tick(board([item(9), item(4, { status: 'In progress' })]), config, [], new Set([4]));
    expect(t.start.map((s) => [s.item.number, s.why])).toEqual([
      [4, 'recovered'],
      [9, 'picked'],
    ]);
  });

  it("leaves In progress cards alone that the factory didn't claim, or that are Blocked", () => {
    const t = tick(
      board([
        item(4, { status: 'In progress' }),
        item(5, { status: 'In progress', blocked: true }),
      ]),
      config,
      [],
      new Set([5]),
    );
    expect(t.start).toEqual([]);
  });

  it('advances planning for Ready cards that need a plan, without a slot', () => {
    const t = tick(
      board([anyItem(1), anyItem(2, { status: 'Planning' }), item(3)]),
      config,
      [run(7, 1), run(8, 2)],
      new Set(),
    );
    expect(t.plan.map((i) => i.number)).toEqual([2, 1]);
    expect(t.start).toEqual([]);
    expect(t.waiting).toEqual([3]);
  });

  it('implements an agreed plan ahead of new Ready cards', () => {
    const t = tick(
      board([item(1), anyItem(2, { status: 'Planning' })]),
      { ...config, maxConcurrent: 1 },
      [],
      new Set(),
      new Set([2]),
    );
    expect(t.start.map((s) => s.item.number)).toEqual([2]);
    expect(t.plan).toEqual([]);
  });

  it('never plans a Blocked card', () => {
    const t = tick(
      board([anyItem(1, { blocked: true }), anyItem(2, { status: 'Planning', blocked: true })]),
      config,
      [],
      new Set(),
    );
    expect(t.plan).toEqual([]);
  });

  it('never starts a Blocked Ready card', () => {
    const t = tick(board([item(1, { blocked: true })]), config, [], new Set());
    expect(t.start).toEqual([]);
    expect(t.skipped).toEqual([{ issue: 1, reason: 'Blocked is set' }]);
  });
});

describe('guardEffects (R23)', () => {
  it('stops before an effect once Blocked is set, and the effect never runs', async () => {
    let blocked = false;
    const done: string[] = [];
    const effects = guardEffects(
      {
        comment: (t: string) => {
          done.push(t);
          return Promise.resolve();
        },
      },
      ['comment'],
      7,
      () => Promise.resolve(blocked),
    );
    await effects.comment('one');
    blocked = true;
    await expect(effects.comment('two')).rejects.toBeInstanceOf(BlockedByRyan);
    expect(done).toEqual(['one']);
  });
});

describe('labelProblems (F12)', () => {
  it('finds Ready and Planning cards whose model belongs to the other agent', () => {
    const problems = labelProblems(
      board([
        anyItem(1, { labels: ['agent:claude', 'model:go'] }),
        anyItem(2, { labels: ['agent:opencode', 'model:go'] }),
        anyItem(3, { labels: ['agent:claude', 'agent:opencode'], status: 'Planning' }),
        anyItem(4, { labels: ['model:go', 'agent:claude'], blocked: true }),
        anyItem(5, { labels: ['model:go', 'agent:claude'], status: 'Backlog' }),
      ]),
      config,
    );
    expect(problems.map((p) => [p.item.number, p.error])).toEqual([
      [1, 'model:go runs on opencode, not agent:claude'],
      [3, 'conflicting labels agent:claude and agent:opencode'],
    ]);
  });
});
