/**
 * The Mac app's log file (PEN-137, T6; AC22, AC28): every line scrubbed before it is written,
 * rotation by size up to the files kept, the age limit (whole files, then the oldest one's
 * head), what lowering a limit would delete, and a bug report's lines read backwards across the
 * files, scrubbed again with the page's names, within non-default limits.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type Limits } from '@penmoss/core/analytics';
import {
  LineBudget,
  linesBackwards,
  LogFile,
  logFileName,
  offsetFrom,
  type LogLimits,
} from '../../src/log-file';

const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const dirs: string[] = [];
const files: LogFile[] = [];

afterEach(async () => {
  for (const file of files.splice(0)) await file.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logs(limits: Partial<LogLimits> = {}, known = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'penmoss-logs-'));
  dirs.push(dir);
  const clock = { now: NOW };
  const file = new LogFile({
    dir,
    limits: { ...DEFAULT_LIMITS, ...limits },
    known,
    now: () => clock.now,
    ageEveryMs: 0,
  });
  files.push(file);
  const names = () =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .sort();
  const read = (index = 0) => readFileSync(join(dir, logFileName(index)), 'utf8');
  return { dir, clock, file, names, read };
}

const limits = (changes: Partial<Limits>): Limits => ({ ...DEFAULT_LIMITS, ...changes });

describe('writing (scrub #1, AC22)', () => {
  it('writes `<ISO time> <level> <source> <message>` lines, scrubbed before they reach the disk', async () => {
    const w = logs(
      {},
      {
        login: 'lemurcanary',
        notebooks: ['Wombatcanary Notebook'],
        repositories: ['canary-owner/kiwicanary-repo'],
        branches: ['tapircanary-branch'],
      },
    );
    w.file.write('info', 'main', 'window shown 120 ms after launch');
    w.file.write(
      'warn',
      'git',
      'push https://github.com/canary-owner/kiwicanary-repo.git as lemurcanary failed for Wombatcanary Notebook on tapircanary-branch',
    );
    w.file.write(
      'error',
      'page',
      'token ghp_CANARYabcdefghijklmnop1234 from ibis.canary@example.invalid at /Users/ryan/Notes/Okapicanary Folder/x.md "Zebracanary Title Q7"',
    );
    await w.file.flushed();
    const lines = w.read().trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('2026-11-19T12:00:00.000Z info main window shown 120 ms after launch');
    expect(lines[1]).toMatch(/^2026-11-19T12:00:00\.000Z warn git push ‹repo-1› as ‹login› failed/);
    expect(lines[2]).toMatch(/^2026-11-19T12:00:00\.000Z error page /);
    const text = w.read().toLowerCase();
    for (const canary of [
      'lemurcanary',
      'kiwicanary',
      'canary-owner',
      'wombatcanary',
      'tapircanary',
      'ghp_canary',
      'ibis.canary',
      'okapicanary',
      'zebracanary',
      '/users/ryan',
    ]) {
      expect(text).not.toContain(canary);
    }
    expect(statSync(w.file.path).mode & 0o777).toBe(0o600);
  });

  it('keeps one line per call: newlines are spaces, a long message is cut', async () => {
    const w = logs();
    w.file.write('error', 'main', `Error: boom\n    at x (y:1:2)\n${'z'.repeat(10_000)}`);
    await w.file.flushed();
    const lines = w.read().trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(4100);
    expect(lines[0]).toMatch(/Error: boom +at x/);
  });
});

describe('rotation by size (AC28: non-default limits)', () => {
  it('rotates a full file up to the files kept, the oldest dropped', async () => {
    const w = logs({ 'logs.fileKb': 256, 'logs.files': 3 });
    const line = 'x'.repeat(1000);
    for (let i = 0; i < 1200; i++) w.file.write('info', 'main', `${i} ${line}`);
    await w.file.flushed();
    expect(w.names()).toEqual(['penmoss.1.log', 'penmoss.2.log', 'penmoss.log']);
    for (const name of w.names()) {
      expect(statSync(join(w.dir, name)).size).toBeLessThanOrEqual(256 * 1024);
    }
    // The newest line is last in the current file; the oldest kept is first in penmoss.2.log.
    expect(w.read().trimEnd().split('\n').at(-1)).toContain(' 1199 ');
    const oldest = Number(/ info main (\d+) /.exec(w.read(2))![1]);
    const newestOfOldest = Number(/ info main (\d+) /.exec(w.read(1))![1]);
    expect(oldest).toBeLessThan(newestOfOldest);
    expect(oldest).toBeGreaterThan(0);
    expect(await w.file.bytes()).toBeLessThanOrEqual(3 * 256 * 1024);
  });

  it('with one file kept, a full file keeps its newer half', async () => {
    const w = logs({ 'logs.fileKb': 256, 'logs.files': 1 });
    for (let i = 0; i < 400; i++) w.file.write('info', 'main', `${i} ${'y'.repeat(1000)}`);
    await w.file.flushed();
    expect(w.names()).toEqual(['penmoss.log']);
    const size = statSync(w.file.path).size;
    expect(size).toBeLessThanOrEqual(256 * 1024);
    expect(size).toBeGreaterThan(100 * 1024);
    expect(w.read().trimEnd().split('\n').at(-1)).toContain(' 399 ');
    // Whole lines only.
    expect(w.read().startsWith('2026-')).toBe(true);
  });
});

describe('the age limit (N14, AC28)', () => {
  it('deletes expired rotated files and trims the oldest one’s head, hourly', async () => {
    const w = logs({ 'logs.fileKb': 256, 'logs.files': 3, 'logs.days': 2 });
    // Four days of lines, a little over one file's worth a day.
    for (let day = 0; day < 4; day++) {
      w.clock.now = NOW - (3 - day) * DAY;
      for (let i = 0; i < 150; i++)
        w.file.write('info', 'main', `day${day} ${i} ${'z'.repeat(1000)}`);
      await w.file.flushed();
    }
    w.clock.now = NOW;
    expect(w.names()).toHaveLength(3);
    // The files' times are as the days passed: each file's is its last line's.
    for (const name of w.names()) {
      const path = join(w.dir, name);
      const last = readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!;
      const at = new Date(last.slice(0, 24));
      utimesSync(path, at, at);
    }
    const before = await w.file.bytes();
    const expected = await w.file.preview({ 'logs.fileKb': 256, 'logs.files': 3, 'logs.days': 2 });
    expect(expected).toBeGreaterThan(0);
    await w.file.enforceAge();
    const kept = w.names().map((name) => readFileSync(join(w.dir, name), 'utf8'));
    const text = kept.join('');
    expect(text).not.toContain('day0 ');
    expect(text).toContain('day3 ');
    // Every line left is from the last two days.
    for (const line of text.trimEnd().split('\n')) {
      expect(Date.parse(line.slice(0, 24))).toBeGreaterThanOrEqual(NOW - 2 * DAY);
    }
    expect(before - (await w.file.bytes())).toBe(expected);
  });

  it('trims the current file itself when it is the only one', async () => {
    const w = logs({ 'logs.files': 1, 'logs.days': 1 });
    w.clock.now = NOW - 2 * DAY;
    w.file.write('info', 'main', 'old line');
    w.clock.now = NOW;
    w.file.write('info', 'main', 'new line');
    await w.file.enforceAge();
    w.file.write('info', 'main', 'after the trim');
    await w.file.flushed();
    expect(w.read()).not.toContain('old line');
    expect(
      w
        .read()
        .trimEnd()
        .split('\n')
        .map((line) => line.slice(30)),
    ).toEqual(['main new line', 'main after the trim']);
  });

  it('finds where the kept lines start, a stack’s lines going with theirs', async () => {
    const w = logs();
    writeFileSync(
      w.file.path,
      [
        `${new Date(NOW - 3 * DAY).toISOString()} error main boom`,
        '    at continuation',
        `${new Date(NOW - DAY).toISOString()} info main kept`,
        '',
      ].join('\n'),
    );
    const offset = await offsetFrom(w.file.path, NOW - 2 * DAY);
    expect(readFileSync(w.file.path, 'utf8').slice(offset)).toMatch(
      /^2026-11-18T12:00:00\.000Z info main kept/,
    );
    expect(await offsetFrom(w.file.path, NOW)).toBe(statSync(w.file.path).size);
  });
});

describe('lowering a limit (N9)', () => {
  it('previews and then deletes files beyond the count and bytes beyond the size', async () => {
    const w = logs({ 'logs.fileKb': 256, 'logs.files': 3 });
    for (let i = 0; i < 900; i++) w.file.write('info', 'main', `${i} ${'q'.repeat(1000)}`);
    await w.file.flushed();
    expect(w.names()).toHaveLength(3);
    const before = await w.file.bytes();
    const lower = { 'logs.fileKb': 256, 'logs.files': 1, 'logs.days': 7 } as const;
    const previewed = await w.file.preview(lower);
    expect(previewed).toBe(before - statSync(w.file.path).size);
    // Raising deletes nothing.
    expect(await w.file.preview({ ...lower, 'logs.files': 5 })).toBe(0);
    await w.file.apply(lower);
    expect(w.names()).toEqual(['penmoss.log']);
    expect(await w.file.bytes()).toBe(before - previewed);
    w.file.write('info', 'main', 'still writing');
    await w.file.flushed();
    expect(w.read()).toContain('still writing');
  });
});

describe('a bug report’s logs (scrub #2, AC28)', () => {
  it('reads the newest lines backwards across the files, within the report limits', async () => {
    const w = logs({ 'logs.fileKb': 256, 'logs.files': 3 });
    for (let i = 0; i < 2000; i++) {
      w.clock.now = NOW - (2000 - i) * 60_000;
      w.file.write('info', 'main', `line ${i} ${'r'.repeat(200)}`);
    }
    w.clock.now = NOW;
    await w.file.flushed();
    expect(w.names().length).toBeGreaterThan(1);
    // report.lines = 50, as feedback-logs.spec.ts sets it.
    const fifty = await w.file.report(limits({ 'report.lines': 50, 'report.kb': 40 }));
    expect(fifty.lines).toHaveLength(50);
    expect(fifty.lines.at(-1)).toContain('line 1999 ');
    expect(fifty.lines[0]).toContain('line 1950 ');
    expect(fifty.bytes).toBe(Buffer.byteLength(fifty.lines.join('\n')));
    // At most 4 KB.
    const small = await w.file.report(limits({ 'report.kb': 4, 'report.lines': 2000 }));
    expect(small.bytes).toBeLessThanOrEqual(4 * 1024);
    expect(small.lines.at(-1)).toContain('line 1999 ');
    // Only the last hour.
    const hour = await w.file.report(
      limits({ 'report.hours': 1, 'report.lines': 2000, 'report.kb': 40 }),
    );
    expect(hour.lines).toHaveLength(60);
    // No more than the logs keep: logs.days 1 caps 168 hours to 24.
    const day = await w.file.report(
      limits({ 'report.hours': 168, 'logs.days': 1, 'report.lines': 2000, 'report.kb': 40 }),
    );
    expect(day.lines.every((line) => Date.parse(line.slice(0, 24)) >= NOW - DAY)).toBe(true);
  });

  it('scrubs the names the page sends, and those main knows, again', async () => {
    const w = logs({}, { notebooks: ['Wombatcanary Notebook'] });
    w.file.write('info', 'main', 'opened Zebracanary Title Q7 in Wombatcanary Notebook');
    w.file.write('info', 'main', 'tag narwhalcanary added');
    const report = await w.file.report(DEFAULT_LIMITS, [
      'Zebracanary Title Q7',
      'narwhalcanary',
      'absent',
    ]);
    expect(report.lines.map((line) => line.slice(25))).toEqual([
      'info main opened ‹name› in ‹notebook-1›',
      'info main tag ‹name› added',
    ]);
  });

  it('reads a file backwards a chunk at a time, every line once', async () => {
    const w = logs();
    const lines = Array.from({ length: 5000 }, (_, i) => `${i} ${'é'.repeat(i % 37)}`);
    writeFileSync(w.file.path, `${lines.join('\n')}\n`);
    const seen: string[] = [];
    for await (const line of linesBackwards(w.file.path, 1000)) seen.push(line);
    expect(seen).toEqual([...lines].reverse());
  });
});

describe('the pages’ lines', () => {
  it('takes at most 50 a minute, and says how many it left out', () => {
    const clock = { now: NOW };
    const budget = new LineBudget(50, () => clock.now);
    let taken = 0;
    for (let i = 0; i < 80; i++) if (budget.take()) taken += 1;
    expect(taken).toBe(50);
    expect(budget.takeDropped()).toBe(30);
    expect(budget.takeDropped()).toBe(0);
    clock.now += 60_000;
    expect(budget.take()).toBe(true);
  });
});
