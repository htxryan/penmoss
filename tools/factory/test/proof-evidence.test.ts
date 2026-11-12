import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearProofFiles,
  fromVm,
  keepProofFiles,
  LAST_PROOF,
  macFailures,
  stageLastProof,
} from '../src/host.ts';
import {
  androidFailures,
  EVIDENCE_TEXT_BYTES,
  keepFailures,
  playwrightFailures,
} from '../src/proof/evidence.ts';
import { fromPlaywrightReport, type PwReport } from '../src/proof/manifest.ts';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `factory-${name}-`));
const b64 = (text: string) => Buffer.from(text).toString('base64');

// The VM's paths, as the Mac proof's report names them (PEN-121, 12 Nov).
const VM = '/Users/admin/penmoss/apps/desktop/test-results/proof';
const TEST_DIR = 'packaged-cli-agents-run-th-b2756-k-and-Finder-while-one-runs-retry1';
const ERROR =
  '\u001b[31mError: Penmoss (pid 46347) was still running 45 s after it was asked to quit\u001b[39m\n\n' +
  '    Call Log:\n    - Timeout 45000ms exceeded while waiting on the predicate\n' +
  '  > 184 |     throw new Error(`Penmoss (pid ${pid}) was still running`);';

/** A Mac proof's report like PEN-121's: one test passed, one failed twice (its retry last). */
function macReport(): PwReport {
  const failed = (dir: string) => ({
    status: 'failed',
    errors: [{ message: ERROR }],
    attachments: [
      {
        name: 'lsappinfo: the MCP server',
        contentType: 'text/plain',
        body: b64('"Penmoss CLI" ASN:0x0-0x2e02e'),
      },
      { name: 'quit Apple Event', contentType: 'text/plain', body: b64('terminate: true') },
      {
        name: 'app.log',
        contentType: 'text/plain',
        path: `${VM}/${dir}/attachments/app-log-006c5c4e.log`,
      },
      {
        name: 'error-context',
        contentType: 'text/markdown',
        path: `${VM}/${dir}/error-context.md`,
      },
      // Playwright lists the error context twice when the error has a cause.
      {
        name: 'error-context',
        contentType: 'text/markdown',
        path: `${VM}/${dir}/error-context.md`,
      },
      { name: 'trace', contentType: 'application/zip', path: `${VM}/${dir}/trace.zip` },
      { name: 'heap', contentType: 'application/octet-stream', body: b64('\u0000\u0001') },
    ],
  });
  return {
    suites: [
      {
        title: 'packaged-cli.spec.ts',
        specs: [
          {
            title: 'an MCP server added before this build still lets Penmoss open',
            tests: [{ results: [{ status: 'passed', attachments: [] }] }],
          },
          {
            title: 'agents run the CLI bundle; Penmoss opens from the Dock and Finder',
            tests: [{ results: [failed(TEST_DIR.replace('-retry1', '')), failed(TEST_DIR)] }],
          },
        ],
      },
    ],
  };
}

/** The files the VM copied back into the gate's worktree, under `test-results/vm`. */
function macWorktree(): { worktree: string; out: string } {
  const worktree = tmp('wt');
  const out = join(worktree, 'test-results', 'vm');
  const dir = join(out, 'test-results', 'proof', TEST_DIR);
  mkdirSync(join(dir, 'attachments'), { recursive: true });
  // The test failed before its window closed, so it attached no screenshot: its screencast's
  // frames are on disk all the same, the newest folder holding the last.
  for (const [frames, at] of [
    ['frames-old', 1000],
    ['frames-new', 2000],
  ] as const) {
    mkdirSync(join(dir, frames));
    for (const f of ['00000.jpg', '00001.jpg', '00002.jpg'])
      writeFileSync(join(dir, frames, f), `${frames}/${f}`);
    utimesSync(join(dir, frames), at, at);
  }
  writeFileSync(join(dir, 'error-context.md'), '# Error details\n\nPenmoss was still running\n');
  writeFileSync(join(dir, 'trace.zip'), 'PK');
  // A log bigger than the cap: its end is what matters.
  writeFileSync(
    join(dir, 'attachments', 'app-log-006c5c4e.log'),
    `${'x'.repeat(EVIDENCE_TEXT_BYTES + 5000)}\nquit requested; before-quit never ran\n`,
  );
  return { worktree, out };
}

describe("a failing proof's evidence, for the agent's next round (A1342)", () => {
  it("keeps a failing Mac test's last frame, error context, text attachments and error", () => {
    const { worktree, out } = macWorktree();
    const raw = tmp('raw');
    const report = macReport();
    const items = fromPlaywrightReport(report, 'mac', 'after').map((item) => ({
      ...item,
      ...(item.screenshot ? { screenshot: fromVm(item.screenshot, out) } : {}),
    }));
    keepProofFiles(items, macFailures(report, out), 'mac', raw, worktree);

    expect(readdirSync(raw).sort()).toEqual([
      'mac-2-app-log.log',
      'mac-2-error-context.md',
      'mac-2-lsappinfo-the-mcp-server.txt',
      'mac-2-quit-apple-event.txt',
      'mac-2-screenshot.jpg',
      'mac-failures.md',
    ]);
    expect(readFileSync(join(raw, 'mac-2-screenshot.jpg'), 'utf8')).toBe('frames-new/00002.jpg');
    expect(readFileSync(join(raw, 'mac-2-error-context.md'), 'utf8')).toContain(
      'Penmoss was still running',
    );
    expect(readFileSync(join(raw, 'mac-2-quit-apple-event.txt'), 'utf8')).toBe('terminate: true');
    const log = readFileSync(join(raw, 'mac-2-app-log.log'), 'utf8');
    expect(log.length).toBeLessThan(EVIDENCE_TEXT_BYTES + 200);
    expect(log.split('\n')[0]).toMatch(/^\[factory: its last 200 KB of \d+ KB\]$/);
    expect(log).toContain('before-quit never ran');

    const index = readFileSync(join(raw, 'mac-failures.md'), 'utf8');
    expect(index).toContain(
      '## 2. agents run the CLI bundle; Penmoss opens from the Dock and Finder',
    );
    expect(index).toContain('Error: Penmoss (pid 46347) was still running 45 s');
    expect(index).toContain('Timeout 45000ms exceeded');
    expect(index).not.toContain('\u001b[');
    for (const f of ['mac-2-screenshot.jpg', 'mac-2-error-context.md', 'mac-2-app-log.log'])
      expect(index).toContain(`\`${f}\``);
    expect(index).not.toContain('trace');
    expect(index).not.toContain('an MCP server added before this build');

    // The next sandbox gets all of it, by the names the prompt gives.
    const next = tmp('next');
    stageLastProof(raw, next);
    expect(readdirSync(join(next, LAST_PROOF)).sort()).toEqual(readdirSync(raw).sort());
  });

  it("names the proof's own screenshot of a failing web test, and never copies a file from outside the worktree", () => {
    const worktree = tmp('wt');
    const outside = tmp('outside');
    const dir = join(worktree, 'apps/web/test-results/proof-5173/a-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'test-failed-1.png'), 'png');
    writeFileSync(join(dir, 'error-context.md'), '# Page snapshot');
    writeFileSync(join(outside, 'secret.txt'), 'not yours');
    const report: PwReport = {
      suites: [
        {
          title: 'comments.spec.ts',
          specs: [
            {
              title: 'shows the badge',
              tests: [
                {
                  results: [
                    {
                      status: 'timedOut',
                      errors: [{ message: 'Test timeout of 30000ms exceeded.' }],
                      attachments: [
                        {
                          name: 'screenshot',
                          contentType: 'image/png',
                          path: join(dir, 'test-failed-1.png'),
                        },
                        {
                          name: 'error-context',
                          contentType: 'text/markdown',
                          path: join(dir, 'error-context.md'),
                        },
                        {
                          name: 'notes',
                          contentType: 'text/plain',
                          path: join(outside, 'secret.txt'),
                        },
                        { name: 'video', contentType: 'video/webm', path: join(dir, 'v.webm') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const raw = tmp('raw');
    keepProofFiles(
      fromPlaywrightReport(report, 'web', 'after'),
      playwrightFailures(report),
      'web',
      raw,
      worktree,
    );
    expect(readdirSync(raw).sort()).toEqual([
      'web-1-error-context.md',
      'web-1-screenshot.png',
      'web-failures.md',
    ]);
    const index = readFileSync(join(raw, 'web-failures.md'), 'utf8');
    expect(index).toContain('`web-1-screenshot.png`: its last screenshot');
    expect(index).toContain('Test timeout of 30000ms exceeded.');
  });

  it("keeps a failing Android test's instrumentation output and logcat", () => {
    const out = tmp('android');
    writeFileSync(join(out, 'android-2.log'), 'FAILURES!!!\njava.lang.AssertionError: badge');
    writeFileSync(join(out, 'android-2.logcat'), 'E AndroidRuntime: FATAL EXCEPTION');
    writeFileSync(join(out, 'android-2.png'), 'png');
    const failed = androidFailures(
      [
        { title: 'BadgeTest#passes', status: 'passed', screenshot: 'android-1.png' },
        { title: 'BadgeTest#shows', status: 'failed', screenshot: 'android-2.png' },
      ],
      out,
    );
    const raw = tmp('raw');
    writeFileSync(join(raw, 'android-2-screenshot.png'), 'png');
    expect(keepFailures(failed, 'android', raw, out).sort()).toEqual([
      'android-2-instrumentation-output.log',
      'android-2-logcat.logcat',
      'android-failures.md',
    ]);
    const index = readFileSync(join(raw, 'android-failures.md'), 'utf8');
    expect(index).toContain('## 2. BadgeTest#shows');
    expect(index).toContain('`android-2-screenshot.png`: its last screenshot');
  });

  it('writes nothing when every test passed', () => {
    const raw = tmp('raw');
    expect(keepFailures(playwrightFailures({ suites: [] }), 'mac', raw, raw)).toEqual([]);
    expect(readdirSync(raw)).toEqual([]);
  });

  it("drops a platform's files from an earlier round, and stages only this round's", () => {
    const raw = tmp('raw');
    for (const f of ['mac-1-screenshot.png', 'mac-failures.md', 'web-1-screenshot.png'])
      writeFileSync(join(raw, f), f);
    clearProofFiles(raw, 'mac');
    expect(readdirSync(raw)).toEqual(['web-1-screenshot.png']);
    const worktree = tmp('wt');
    mkdirSync(join(worktree, LAST_PROOF), { recursive: true });
    writeFileSync(join(worktree, LAST_PROOF, 'mac-failures.md'), 'old');
    stageLastProof(raw, worktree);
    expect(readdirSync(join(worktree, LAST_PROOF))).toEqual(['web-1-screenshot.png']);
    expect(existsSync(join(worktree, LAST_PROOF, 'mac-failures.md'))).toBe(false);
  });
});
