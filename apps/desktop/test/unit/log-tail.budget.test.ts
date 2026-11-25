// Wall-clock budgets (A1244) for the Mac app's log file at its largest limits (PEN-137, AC35):
// `task budgets` runs it, never `task check`. 400 MB of logs (5 files of 80 MB): a bug report's
// lines are ready in under 300 ms, read backwards from the end, never a whole file; writing a
// line costs main's thread nothing it waits on. Ceilings get 2× slack on CI.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, LIMITS, type Limits } from '@penmoss/core/analytics';
import { LogFile, logFileName } from '../../src/log-file';

const SLACK = process.env['CI'] ? 2 : 1;
const MAX: Limits = Object.fromEntries(LIMITS.map((spec) => [spec.key, spec.max])) as Limits;
const FILE_BYTES = MAX['logs.fileKb'] * 1000;
const NOW = Date.now();

let dir: string;
let file: LogFile;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'penmoss-log-budget-'));
  // One MB of lines, written again and again: 80 MB a file, the newest an hour old at most.
  const lines: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < 1024 * 1024; i++) {
    const line = `${new Date(NOW - 3_000_000 + i).toISOString()} info main git pull ‹repo-1›: ${i} ${'x'.repeat(120)}\n`;
    lines.push(line);
    bytes += line.length;
  }
  const chunk = Buffer.from(lines.join(''));
  const whole = Buffer.concat(
    Array.from({ length: Math.floor(FILE_BYTES / chunk.length) }, () => chunk),
  );
  for (let index = 0; index < MAX['logs.files']; index++) {
    writeFileSync(join(dir, logFileName(index)), whole);
  }
  file = new LogFile({ dir, limits: MAX, ageEveryMs: 0 });
}, 120_000);

afterAll(async () => {
  await file?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the log file at 400 MB (AC35)', () => {
  it('has a bug report’s lines ready in under 300 ms, at the largest report limits', async () => {
    expect(await file.bytes()).toBeGreaterThan(390_000_000);
    const [report, took] = await (async () => {
      const started = performance.now();
      const value = await file.report(MAX, ['Zebracanary Title Q7', 'Okapicanary Folder']);
      return [value, performance.now() - started] as const;
    })();
    expect(report.lines.length).toBeGreaterThan(0);
    expect(report.bytes).toBeLessThanOrEqual(MAX['report.kb'] * 1000);
    expect(took).toBeLessThan(300 * SLACK);
    const defaults = performance.now();
    await file.report(DEFAULT_LIMITS);
    expect(performance.now() - defaults).toBeLessThan(300 * SLACK);
  });

  it('writes a line without main’s thread waiting (p95 under 0.2 ms)', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const started = performance.now();
      file.write('info', 'main', `window shown ${i} ms after launch`);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.95)]!).toBeLessThan(0.2 * SLACK);
    await file.flushed();
  });
});
