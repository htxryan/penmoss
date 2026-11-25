/**
 * The proof on the host (F9: out of host.ts): each platform's proof specs run with recording on
 * (the Mac's in the test VM, Android's on the slot's emulator), validation's walkthroughs
 * (PEN-94), the recordings made into the PR's files, the last proof staged for an agent sent back
 * by it (A1291), each platform's files kept in the run folder, and the Mac proof's failures read
 * from the VM's report.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, extname } from 'node:path';
import { ensureAvd, stopSlotEmulator } from './avd.ts';
import type { AttachedProof } from './proof/body.ts';
import { fromPlaywrightReport, type ProofItem, type PwReport } from './proof/manifest.ts';
import {
  androidFailures,
  type FailedTest,
  playwrightFailures,
  keepFailures,
} from './proof/evidence.ts';
import { checkMedia, framesToMp4, framesWithin, toMp4, within } from './proof/media.ts';
import { checkMacVm, runMacProof, runMacWalk } from './proof/mac.ts';
import { withJavaHome } from './sandbox.ts';
import { ANDROID_WALK_CLASS, MAC_WALK_SPEC, WALK_SHOT, walkFile, walkTail } from './walk.ts';
import type { HostContext } from './host-context.ts';
import type { HostDeps } from './host.ts';

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
function newestReport(results: string): string | undefined {
  if (!existsSync(results)) return undefined;
  return readdirSync(results)
    .filter((d) => d.startsWith('proof-'))
    .map((d) => join(results, d, 'report.json'))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** Recording the proof and validation's walkthroughs, and the files the PR attaches. */
export function proofDeps(
  ctx: HostContext,
): Pick<HostDeps, 'macVmCheck' | 'walk' | 'recordProof' | 'prepareProof' | 'proofLog'> {
  const { config, slot, exec, runDir } = ctx;
  // A proof's whole output, kept in the run folder: the gate's worktree, with the proof's own
  // logs, is gone once it closes (PEN-70's Android proof failed twice and left no reason, A1252).
  const proofLogs = new Map<string, string>();
  const keepProofLog = (platform: string, ran: { stdout: string; stderr: string }) => {
    const text = ran.stdout + ran.stderr;
    proofLogs.set(platform, text);
    writeFileSync(join(runDir, `proof-${platform}.log`), text);
  };
  return {
    macVmCheck: (handle) => checkMacVm(exec, config, handle.worktreePath),
    walk: async (handle, platform, signal) => {
      // The session wrote the walkthrough; the host runs it where the app runs (walk.ts).
      const file = walkFile(platform);
      if (!existsSync(join(handle.worktreePath, file)))
        return {
          platform,
          captures: [],
          problem: `The validating session wrote no walkthrough (\`${file}\`).`,
        };
      const into = join(handle.worktreePath, '.factory', 'validation');
      mkdirSync(into, { recursive: true });
      const bring = (from: string) =>
        existsSync(from)
          ? readdirSync(from)
              .filter((f) => WALK_SHOT.test(f))
              .map((f) => {
                copyFileSync(join(from, f), join(into, f));
                return f;
              })
          : [];
      let ran: { readonly ok: boolean; readonly text: string };
      let shots: string;
      if (platform === 'android') {
        // As the Android proof runs (recordProof): the slot's own emulator, stopped at the timeout.
        await ensureAvd(config, slot, exec);
        await stopSlotEmulator(config, slot, exec);
        const stop = () => void stopSlotEmulator(config, slot, exec).catch(() => undefined);
        signal?.addEventListener('abort', stop, { once: true });
        try {
          const done = await handle.exec(
            withJavaHome(`task proof:android -- ${ANDROID_WALK_CLASS}`),
          );
          const out = join(handle.worktreePath, 'apps/android/build/proof');
          const report = join(out, 'report.json');
          const passed =
            existsSync(report) &&
            (JSON.parse(readFileSync(report, 'utf8')) as { status: string }[]).every(
              (r) => r.status === 'passed',
            );
          ran = { ok: passed, text: done.stdout + done.stderr };
          shots = join(out, 'walk');
        } finally {
          signal?.removeEventListener('abort', stop);
        }
      } else {
        // In the test VM, which copies the worktree in; the VM's lock makes it wait (whenVmFree).
        const done = await runMacWalk(exec, config, handle.worktreePath, MAC_WALK_SPEC, signal);
        ran = { ok: done.code === 0, text: done.stdout + done.stderr };
        shots = join(handle.worktreePath, 'test-results', 'vm', 'test-results', 'walk');
      }
      writeFileSync(join(runDir, `walk-${platform}.log`), ran.text);
      const captures = bring(shots);
      return {
        platform,
        captures,
        ...(ran.ok ? {} : { problem: `The walkthrough failed. ${walkTail(ran.text)}` }),
      };
    },
    recordProof: async (handle, platform, specs, signal) => {
      const quoted = specs.map((spec) => `'${spec.replaceAll("'", '')}'`).join(' ');
      let items: ProofItem[];
      // What each failing test left, for the agent's next round (proof/evidence.ts).
      let failed: FailedTest[];
      // An earlier round's files would show the agent a failure this round no longer has.
      clearProofFiles(join(runDir, 'raw'), platform);
      if (platform === 'web') {
        // Its exit code is not the verdict: the report says which tests passed.
        keepProofLog('web', await handle.exec(`task proof:web -- ${quoted}`));
        const report = newestReport(join(handle.worktreePath, 'apps/web/test-results'));
        if (!report) return [];
        const parsed = JSON.parse(readFileSync(report, 'utf8')) as PwReport;
        failed = playwrightFailures(parsed);
        items = fromPlaywrightReport(parsed, 'web', 'after');
      } else if (platform === 'android') {
        // The slot's own emulator, inside its sandbox (FD25); the AVD is made on the host first,
        // and an emulator a stopped run left up is stopped. At the proof timeout the host stops
        // the emulator: `am instrument -w` waits as long as a hung test does, and ends when the
        // device goes; closing the gate's sandbox then kills what is left of proof.sh.
        await ensureAvd(config, slot, exec);
        await stopSlotEmulator(config, slot, exec);
        const stop = () => void stopSlotEmulator(config, slot, exec).catch(() => undefined);
        signal?.addEventListener('abort', stop, { once: true });
        try {
          keepProofLog(
            'android',
            await handle.exec(withJavaHome(`task proof:android -- ${quoted}`)),
          );
        } finally {
          signal?.removeEventListener('abort', stop);
        }
        const out = join(handle.worktreePath, 'apps/android/build/proof');
        const report = join(out, 'report.json');
        if (!existsSync(report)) return [];
        const parsed = JSON.parse(readFileSync(report, 'utf8')) as {
          title: string;
          status: string;
          video: string;
          screenshot: string;
        }[];
        failed = androidFailures(parsed, out);
        items = parsed.map((r) => ({
          platform: 'android',
          title: r.title,
          status: r.status === 'passed' ? 'passed' : 'failed',
          phase: 'after',
          source: 'harness',
          ...(existsSync(join(out, r.video)) ? { video: join(out, r.video) } : {}),
          ...(existsSync(join(out, r.screenshot)) ? { screenshot: join(out, r.screenshot) } : {}),
        }));
      } else {
        // The Mac app runs in the test VM (W10), which only the host can start: the VM script
        // copies this worktree in read-only and queues on the VM's lock (F7). At the proof
        // timeout it is stopped with its `tart run`, and stops the VM, freeing the lock.
        const out = join(handle.worktreePath, 'test-results', 'vm');
        const ran = await runMacProof(exec, config, handle.worktreePath, specs, signal);
        // The VM script prints only the log's last lines; the whole log came back beside the
        // report. Kept like the other platforms' output, so a failure reaches the agent (A1291).
        const vmLog = join(out, 'desktop-test.log');
        keepProofLog(
          'mac',
          existsSync(vmLog) ? { stdout: readFileSync(vmLog, 'utf8'), stderr: '' } : ran,
        );
        const report = join(out, 'test-results', 'proof', 'report.json');
        if (!existsSync(report)) return [];
        const parsed = JSON.parse(readFileSync(report, 'utf8')) as PwReport;
        failed = macFailures(parsed, out);
        items = fromPlaywrightReport(parsed, 'mac', 'after').map((item) => ({
          ...item,
          // The report names the VM's paths; the files came back under test-results/vm.
          ...(item.video ? { video: fromVm(item.video, out) } : {}),
          ...(item.screenshot ? { screenshot: fromVm(item.screenshot, out) } : {}),
        }));
        // The window's screencast frames become its video (Playwright's own recording stops
        // Electron's window loading in the VM, so the tests record through CDP instead).
        items = await Promise.all(
          items.map(async (item) => {
            const dirs = (item.frames ?? []).map((f) => fromVm(f.dir, out));
            if (
              !item.frames ||
              !dirs.every((d) => existsSync(d)) ||
              !framesWithin(item.frames, dirs, handle.worktreePath)
            )
              return item;
            const video = join(dirs[0] ?? out, 'video.mp4');
            await framesToMp4(exec, item.frames, dirs, video);
            return { ...item, video };
          }),
        );
      }
      return keepProofFiles(items, failed, platform, join(runDir, 'raw'), handle.worktreePath);
    },
    prepareProof: async (items) => {
      const dir = join(runDir, 'proof');
      mkdirSync(dir, { recursive: true });
      const proof: AttachedProof[] = [];
      const counts = new Map<string, number>();
      for (const item of items.filter((i) => i.status === 'passed')) {
        const n = (counts.get(item.platform) ?? 0) + 1;
        counts.set(item.platform, n);
        const base = `${item.platform}-${item.phase === 'before' ? 'before-' : ''}${n}`;
        let image: string | undefined;
        let video: string | undefined;
        if (item.screenshot) {
          image = `${base}.png`;
          copyFileSync(item.screenshot, join(dir, image));
        }
        if (item.video) {
          video = `${base}.mp4`;
          await toMp4(exec, item.video, join(dir, video));
        }
        proof.push({
          label: `${item.platform}: ${item.title}`,
          phase: item.phase,
          source: item.source,
          ...(image ? { image } : {}),
          ...(video ? { video } : {}),
        });
      }
      const files = proof.flatMap((p) =>
        [p.image, p.video].filter((f): f is string => Boolean(f)).map((f) => join(dir, f)),
      );
      const problems = checkMedia(files);
      if (problems.length > 0)
        return { ok: false, error: problems.map((p) => `${p.path}: ${p.problem}`).join('; ') };
      return { ok: true, proof };
    },
    proofLog: (platform) => proofLogs.get(platform),
  };
}
