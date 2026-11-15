/**
 * The proof's files on the host (F9: out of host.ts): the last proof staged for an agent sent
 * back by it (A1291), each platform's files kept in the run folder, and the Mac proof's failures
 * read from the VM's report.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ProofItem, PwReport } from './proof/manifest.ts';
import { type FailedTest, keepFailures, playwrightFailures } from './proof/evidence.ts';
import { within } from './proof/media.ts';

/** Where a run's sandbox finds the last proof's screenshots and failures (`stageLastProof`). */
export const LAST_PROOF = '.factory/last-proof';

/**
 * The last proof's files the agent gets: each test's screenshot (`<platform>-<n>-screenshot.png`,
 * or `.jpg` for the Mac window's last frame), and a failing test's error context, attachments and
 * logs with their index, `<platform>-failures.md` (proof/evidence.ts). Never a video.
 */
const STAGED = /^[a-z]+-(failures\.md|\d+-[a-z0-9-]+\.(png|jpg|md|txt|log|json|logcat))$/;

/** Copies the last proof's screenshots and failures into the worktree, in place of older ones. */
export function stageLastProof(raw: string, worktree: string): string[] {
  const to = join(worktree, LAST_PROOF);
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(raw)) return [];
  const files = readdirSync(raw).filter((f) => STAGED.test(f));
  if (files.length === 0) return [];
  mkdirSync(to, { recursive: true });
  for (const f of files) copyFileSync(join(raw, f), join(to, f));
  return files;
}

/** Removes a platform's files from an earlier round of the proof from the run folder's `raw/`. */
export function clearProofFiles(raw: string, platform: string): void {
  if (!existsSync(raw)) return;
  for (const f of readdirSync(raw))
    if (f.startsWith(`${platform}-`)) rmSync(join(raw, f), { force: true });
}

/**
 * Copies a proof's recordings into the run folder's `raw/` as `<platform>-<n>-video…` and
 * `<platform>-<n>-screenshot.png`, then what each failing test left (proof/evidence.ts), and
 * returns the items with the copies' paths. Only the run's own files: the agent's tests write the
 * report that names them.
 */
export function keepProofFiles(
  items: readonly ProofItem[],
  failed: readonly FailedTest[],
  platform: string,
  raw: string,
  worktree: string,
): ProofItem[] {
  mkdirSync(raw, { recursive: true });
  const kept = items.map((item, i) => {
    const keep = (path: string | undefined, name: string) => {
      if (!path || !within(path, worktree)) return undefined;
      const to = join(raw, `${platform}-${i + 1}-${name}`);
      copyFileSync(path, to);
      return to;
    };
    const video = keep(item.video, `video${extname(item.video ?? '') || '.webm'}`);
    const screenshot = keep(item.screenshot, 'screenshot.png');
    return {
      ...item,
      ...(video ? { video } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
  });
  keepFailures(failed, platform, raw, worktree);
  return kept;
}

/** The Mac proof's failing tests, with the VM's paths as the copies under `out` (`fromVm`). */
export function macFailures(report: PwReport, out: string): FailedTest[] {
  return playwrightFailures(report, (path) => fromVm(path, out));
}

/** A path in the VM's `apps/desktop/test-results/…` as the copy under `<out>/test-results/…`. */
export function fromVm(path: string, out: string): string {
  const i = path.indexOf('/apps/desktop/test-results/');
  return i < 0
    ? path
    : join(out, 'test-results', path.slice(i + '/apps/desktop/test-results/'.length));
}

/** The newest proof report under the web app's test results (its folder is named by port). */
export function newestReport(results: string): string | undefined {
  if (!existsSync(results)) return undefined;
  return readdirSync(results)
    .filter((d) => d.startsWith('proof-'))
    .map((d) => join(results, d, 'report.json'))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
