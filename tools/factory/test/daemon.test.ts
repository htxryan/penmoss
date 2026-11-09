import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Board } from '../src/board.ts';
import { takeLock, unfinishedClaims, withWait } from '../src/daemon.ts';
import { formatStatus } from '../src/status.ts';
import { tick } from '../src/dispatcher.ts';
import { renderPlist } from '../src/launchd.ts';
import { buildReport } from '../src/report.ts';
import { mergeLog } from '../src/watch.ts';
import { finishedRound, resumeFrom } from '../src/start.ts';
import { item, testConfig } from './helpers.ts';

describe('the singleton lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lock-'));
  it('lets one daemon in and refuses a second while it lives', () => {
    const path = join(dir, 'a.lock');
    const first = takeLock(path, 111, () => true);
    expect(first.ok).toBe(true);
    expect(takeLock(path, 222, () => true)).toEqual({ ok: false, holder: 111 });
    if (first.ok) first.lock.release();
    expect(takeLock(path, 222, () => true).ok).toBe(true);
  });
  it('takes over the lock of a daemon that died', () => {
    const path = join(dir, 'b.lock');
    writeFileSync(path, '333');
    expect(takeLock(path, 444, (pid) => pid !== 333).ok).toBe(true);
  });
});

describe('unfinishedClaims (R12)', () => {
  it('finds runs that claimed a card and never reached an end', () => {
    const ledger = [
      { run: '5-a', event: 'claimed', issue: 5 },
      { run: '5-a', event: 'in-review' },
      { run: '6-b', event: 'claimed', issue: 6 },
      { run: '6-b', event: 'agent-started' },
      { run: '7-c', event: 'claimed', issue: 7 },
      { run: '7-c', event: 'blocked', reason: 'gate-failed' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    // 7 stopped Blocked: it stays claimed, so it restarts once Ryan clears Blocked.
    expect([...unfinishedClaims(`${ledger}\n{"run":"8-d","ev`)]).toEqual([6, 7]);
  });

  it("writes the merge's events to the ledger, which closes the claim and counts the merge", () => {
    // PEN-75: the run failed after In Review (no in-review event), then merged through the
    // review loop, which logged merged and done to the daemon log only.
    const config = { ...testConfig(), stateDir: mkdtempSync(join(tmpdir(), 'factory-ledger-')) };
    const ledger = join(config.stateDir, 'runs.jsonl');
    writeFileSync(
      ledger,
      [
        { at: '2026-11-08T00:04:00Z', run: '75-a', event: 'claimed', issue: 75 },
        { at: '2026-11-08T02:18:34Z', run: '75-a', event: 'failed', error: 'spawn ENOENT' },
      ]
        .map((e) => `${JSON.stringify(e)}\n`)
        .join(''),
    );
    expect([...unfinishedClaims(readFileSync(ledger, 'utf8'))]).toEqual([75]);
    const lines: string[] = [];
    const log = mergeLog(config, '75-merge-x', 75, (l) => lines.push(l));
    log('merged', { pr: 'https://github.com/htxryan/penmoss/pull/63', sha: '8b16754' });
    log('done', { sha: '8b16754' });
    const events = readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.slice(2)).toEqual([
      expect.objectContaining({ run: '75-merge-x', issue: 75, event: 'merged', sha: '8b16754' }),
      expect.objectContaining({ run: '75-merge-x', issue: 75, event: 'done', sha: '8b16754' }),
    ]);
    expect(typeof events[2]?.['at']).toBe('string');
    expect(lines).toEqual([
      'merged {"pr":"https://github.com/htxryan/penmoss/pull/63","sha":"8b16754"}',
      'done {"sha":"8b16754"}',
    ]);
    expect([...unfinishedClaims(readFileSync(ledger, 'utf8'))]).toEqual([]);
    const counted = buildReport(
      readFileSync(ledger, 'utf8'),
      new Date('2026-11-01T00:00:00Z'),
      new Date('2099-01-01T00:00:00Z'),
    );
    expect(counted.merged).toBe(1);
  });

  it('finds the run whose agent finished, and resumes from the result the host kept (R12)', () => {
    const config = { ...testConfig(), stateDir: mkdtempSync(join(tmpdir(), 'factory-resume-')) };
    const ledger = (events: object[]) =>
      writeFileSync(
        join(config.stateDir, 'runs.jsonl'),
        events.map((e) => `${JSON.stringify(e)}\n`).join(''),
      );
    const result = {
      status: 'done',
      summary: 'Linked the footer',
      questions: [],
      platforms: {},
      tests: [],
      decisions: [],
      risks: [],
      replies: {},
    };
    mkdirSync(join(config.stateDir, 'runs', '75-a'), { recursive: true });
    writeFileSync(join(config.stateDir, 'runs', '75-a', 'result.json'), JSON.stringify(result));
    const finished = [
      { run: '75-a', event: 'claimed', issue: 75 },
      { run: '75-a', event: 'agent-started' },
      { run: '75-a', event: 'agent-finished', status: 'done' },
      { run: '76-z', event: 'agent-started' },
      { run: '75-a', event: 'decisions-numbered' },
    ];
    ledger(finished);
    expect(resumeFrom(config, 75).resume).toMatchObject({
      run: '75-a',
      result: { summary: 'Linked the footer' },
    });
    // A run that resumed from it, then stopped again, still points at 75-a's result.
    const resumed = [
      ...finished,
      { run: '75-b', event: 'claimed', issue: 75 },
      { run: '75-b', event: 'agent-finished', status: 'done', from: '75-a' },
    ];
    expect(finishedRound(resumed.map((e) => JSON.stringify(e)).join('\n'), 75)).toBe('75-a');
    // A later agent round that never finished, or a round that asked questions: start the agent.
    ledger([...finished, { run: '75-b', event: 'agent-started' }]);
    expect(resumeFrom(config, 75)).toEqual({});
    ledger([
      ...finished.slice(0, 2),
      { run: '75-a', event: 'agent-finished', status: 'needs-info' },
    ]);
    expect(resumeFrom(config, 75)).toEqual({});
    expect(resumeFrom(config, 76)).toEqual({});
  });

  it('keeps a run Ryan paused with Blocked claimed, so clearing Blocked resumes it (R23)', () => {
    const ledger = [
      { run: '9-a', event: 'claimed', issue: 9 },
      { run: '9-a', event: 'agent-started' },
      { run: '9-a', event: 'failed', stopped: 'Blocked set by Ryan' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const claimed = unfinishedClaims(ledger);
    const config = testConfig();
    const card = (blocked: boolean) => item(9, { status: 'In progress', blocked });
    const board = (blocked: boolean): Board => ({ items: [card(blocked)] });
    expect(tick(board(true), config, [], claimed).start).toEqual([]);
    expect(tick(board(false), config, [], claimed).start.map((s) => s.why)).toEqual(['recovered']);
  });
});

describe('the LaunchAgent', { timeout: 30_000 }, () => {
  it('renders a plist macOS accepts, escaping paths', () => {
    const plist = renderPlist({
      node: '/n/node',
      cli: '/r/tools/factory/src/cli.ts',
      repo: '/r',
      path: '/usr/bin:/bin',
      log: '/s/a & b.log',
    });
    expect(plist).toContain('<string>/s/a &amp; b.log</string>');
    const file = join(mkdtempSync(join(tmpdir(), 'factory-plist-')), 'x.plist');
    writeFileSync(file, plist);
    expect(execFileSync('plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK');
  });
});

describe('factory:status (F10)', () => {
  const config = testConfig();
  const run = { issue: 49, slot: 1, startedAt: '2026-11-08T10:00:00.000Z', why: 'picked' as const };

  it("keeps when a run's wait began, and drops it once the run goes on", () => {
    const first = withWait(
      run,
      'the Mac proof waits for the test VM: busy',
      new Date('2026-11-08T11:00:00Z'),
    );
    const later = withWait(
      first,
      'the Mac proof waits for the test VM: tart is not installed',
      new Date('2026-11-08T11:05:00Z'),
    );
    expect(later.waitingFor).toEqual({
      reason: 'the Mac proof waits for the test VM: tart is not installed',
      since: '2026-11-08T11:00:00.000Z',
    });
    expect(withWait(later, null, new Date())).toEqual(run);
  });

  it('says why a running card waits', () => {
    const lines = formatStatus(
      {
        updatedAt: '2026-11-08T11:10:00.000Z',
        pid: 4242,
        running: [
          withWait(
            run,
            'the Mac proof waits for the test VM: penmoss-test did not answer in 3 minutes',
            new Date('2026-11-08T11:00:00Z'),
          ),
          { ...run, issue: 50, slot: 2 },
        ],
        waiting: [51],
        skipped: [],
      },
      config,
      '/s/code',
      new Date('2026-11-08T11:10:30Z'),
    );
    expect(lines).toEqual([
      'Daemon 4242 (commit unknown: it predates task factory:update), last poll 30 s ago.',
      '  running #49 on slot 1 since 2026-11-08T10:00:00.000Z (picked)',
      '    waiting since 2026-11-08T11:00:00.000Z: the Mac proof waits for the test VM: penmoss-test did not answer in 3 minutes',
      '  running #50 on slot 2 since 2026-11-08T10:00:00.000Z (picked)',
      '  waiting for a slot: #51',
    ]);
  });
});
