import { describe, expect, it } from 'vitest';
import { parseIssueSpec, type IssueSpec } from '../src/labels.ts';
import type { BoardItem } from '../src/board.ts';
import {
  elsewhere,
  formatMarker,
  modeFor,
  parseMarkers,
  pickNext,
  priorityName,
} from '../src/pick.ts';
import { item, linearConfig, testConfig } from './helpers.ts';

const config = testConfig();

function spec(labels: string[] = []): IssueSpec {
  const result = parseIssueSpec(labels, config);
  if (!result.ok) throw new Error(result.error);
  return result.spec;
}

describe('pickNext', () => {
  it('orders Ready cards by priority, then board position', () => {
    const items = [
      item(10, { position: 0 }),
      item(11, { position: 1, labels: ['P1'] }),
      item(12, { position: 2, labels: ['P1'] }),
      item(13, { position: 3, labels: ['P4'] }),
    ];
    const result = pickNext(items, config);
    expect(result.queue.map((p) => p.item.number)).toEqual([11, 12, 10, 13]);
    expect(result.next?.item.number).toBe(11);
    expect(result.next?.why).toBe(
      'P1, ahead of 2 lower-priority cards, above 1 other P1 card on the board',
    );
  });

  it('never picks a blocked card', () => {
    const result = pickNext([item(1, { blocked: true, labels: ['P1'] }), item(2)], config);
    expect(result.next?.item.number).toBe(2);
    expect(result.skipped.map((s) => [s.item.number, s.reason])).toEqual([[1, 'Blocked is set']]);
  });

  it('passes over closed issues, other repos, running cards and bad labels', () => {
    const result = pickNext(
      [
        item(1, { state: 'CLOSED' }),
        item(2, { repo: 'htxryan/other' }),
        item(3),
        item(4, { labels: ['agent:claude', 'agent:opencode'] }),
      ],
      config,
      new Set([3]),
    );
    expect(result.next).toBeNull();
    expect(result.skipped.map((s) => [s.item.number, s.reason])).toEqual([
      [1, 'the issue is closed'],
      [2, 'in htxryan/other, not htxryan/penmoss'],
      [3, 'already running'],
      [4, 'conflicting labels agent:claude and agent:opencode'],
    ]);
  });

  it('ignores cards outside Ready', () => {
    const result = pickNext(
      [item(1, { status: 'Backlog' }), item(2, { status: 'In progress' })],
      config,
    );
    expect(result).toEqual({ next: null, skipped: [], queue: [] });
  });

  it('plans first unless plan:skip', () => {
    expect(pickNext([item(1)], config).next?.mode).toBe('plan');
    expect(pickNext([item(1, { labels: ['plan:skip'] })], config).next?.mode).toBe('implement');
  });

  it('explains a lone card, saying when its priority is only the default', () => {
    expect(pickNext([item(1)], config).next?.why).toBe(
      'no P label (P3), the only card in Ready that can start',
    );
    expect(pickNext([item(1, { labels: ['P3'] })], config).next?.why).toBe(
      'P3, the only card in Ready that can start',
    );
  });

  it("names Linear's status and priorities, and a card with none as no priority (Medium)", () => {
    // PEN-75's factory:next said "P3, the only card in Ready" for a Todo card with no priority.
    const linear = linearConfig();
    const todo = (n: number, o: Partial<BoardItem>) => item(n, { status: 'Todo', ...o });
    expect(pickNext([todo(75, { priority: 3, noPriority: true })], linear).next?.why).toBe(
      'no priority (Medium), the only card in Todo that can start',
    );
    const result = pickNext(
      [
        todo(1, { priority: 3, noPriority: true, position: 0 }),
        todo(2, { priority: 1, position: 1 }),
        todo(3, { priority: 3, position: 2 }),
      ],
      linear,
    );
    expect(result.queue.map((p) => [p.item.number, priorityName(p, linear)])).toEqual([
      [2, 'Urgent'],
      [1, 'no priority (Medium)'],
      [3, 'Medium'],
    ]);
    expect(result.queue[1]?.why).toBe(
      'no priority (Medium), above 1 other Medium card on the board',
    );
  });
});

describe('elsewhere', () => {
  it('names the cards in Planning and the blocked ones further on, when Todo has none to start', () => {
    const linear = linearConfig();
    const pen = (n: number, o: Partial<BoardItem>) => item(n, { key: `PEN-${n}`, ...o });
    const items = [
      pen(41, { status: 'Planning', blocked: true }),
      pen(42, { status: 'Planning' }),
      pen(43, { status: 'In Progress', blocked: true }),
      pen(44, { status: 'In Progress' }),
      pen(45, { status: 'In Review', blocked: true }),
      pen(46, { status: 'Planning', state: 'CLOSED' }),
      pen(47, { status: 'Backlog', blocked: true }),
      pen(48, { status: 'Todo', blocked: true }),
    ];
    expect(elsewhere(items, linear)).toBe(
      'Elsewhere: 2 in Planning (PEN-41 blocked, PEN-42); 1 blocked in In Progress (PEN-43); 1 blocked in In Review (PEN-45).',
    );
    expect(elsewhere([pen(44, { status: 'In Progress' })], linear)).toBeUndefined();
  });
});

describe('modeFor', () => {
  const base = { spec: spec(), markers: [], hasOpenPr: false };
  it.each([
    ['Ready', 'plan'],
    ['Planning', 'plan'],
    ['In progress', 'implement'],
    ['In review', 'implement'],
    ['Done', null],
    ['Backlog', null],
    [null, null],
  ])('%s → %s', (status, mode) => {
    expect(modeFor({ ...base, status }, config)).toBe(mode);
  });

  it('implements once the plan is approved', () => {
    const markers = parseMarkers(formatMarker({ run: 'r1', event: 'plan-approved' }));
    expect(modeFor({ ...base, status: 'Planning', markers }, config)).toBe('implement');
  });

  it('revises an open PR in review', () => {
    expect(modeFor({ ...base, status: 'In review', hasOpenPr: true }, config)).toBe('revise');
  });

  it('skips planning with plan:skip', () => {
    expect(modeFor({ ...base, spec: spec(['plan:skip']), status: 'Ready' }, config)).toBe(
      'implement',
    );
  });
});

describe('markers', () => {
  it('round-trips and finds several in one body', () => {
    const body = `Claimed.\n${formatMarker({ run: 'a1', agent: 'claude' })}\ntext\n<!--penmoss-factory run=a2 event=plan-approved-->`;
    expect(parseMarkers(body).map((m) => m.fields)).toEqual([
      { run: 'a1', agent: 'claude' },
      { run: 'a2', event: 'plan-approved' },
    ]);
  });
  it('ignores other comments', () => {
    expect(parseMarkers('<!-- something else -->')).toEqual([]);
  });
});
