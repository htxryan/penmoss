import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Board } from '../src/board.ts';
import { takeLock, unfinishedClaims, withWait } from '../src/daemon.ts';
import { formatStatus } from '../src/status.ts';
import { tick } from '../src/dispatcher.ts';
import { renderPlist } from '../src/launchd.ts';
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

describe('the LaunchAgent', () => {
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
