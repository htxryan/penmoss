/**
 * The real `RunDeps`: the factory's own clone, Sandcastle sandboxes, gh as penmoss-bot, and the
 * run ledger. Kept apart from run.ts so the run's sequence is tested with fakes.
 *
 * The factory works in its own clone (`<stateDir>/repo`), never in Ryan's checkout. Its push
 * URL is a dead end, so a plain `git push` from a worktree goes nowhere; the harness pushes to
 * an explicit URL with the bot's credentials, which the sandbox never sees (R18).
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import type { AgentProvider, Sandbox } from '@ai-hero/sandcastle';
import type { Board } from './board.ts';
import { ensureAvd } from './avd.ts';
import { withHeavySlot } from './heavy.ts';
import { usageLimitReset } from './limits.ts';
import { cardLink } from './ui/link.ts';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { runIdOf, type CheckRun } from './checks.ts';
import { assignDecisionNumbers, maxDecision } from './decisions.ts';
import { GhError, type Gh } from './github.ts';
import { proofFiles, type AttachedProof } from './proof/body.ts';
import { publishRefs, type ProofStore } from './proof/store.ts';
import { fromPlaywrightReport, type ProofItem } from './proof/manifest.ts';
import { checkMedia, framesToMp4, toMp4 } from './proof/media.ts';
import { parseAgentResult, RESULT_PATH } from './result.ts';
import type { RunDeps, RunEvent, RunSandbox } from './run.ts';
import { makeOwnDirs, sandboxSpec, seatbeltProvider, withJavaHome } from './sandbox.ts';
import type { Secrets } from './secrets.ts';
import type { Tracker } from './tracker/port.ts';

export const DEAD_END_PUSH_URL = 'no-push://the-factory-harness-pushes';

export function repoDir(config: FactoryConfig): string {
  return join(expandHome(config.stateDir), 'repo');
}

/**
 * The publisher's environment for gh and git: nothing of Ryan's. `gh` gets the app's token per
 * call (`GH_TOKEN`), and its config folder is the factory's own, empty one, so it can never fall
 * back to Ryan's login in ~/.config/gh.
 */
export function publisherEnv(config: FactoryConfig): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '',
    GH_CONFIG_DIR: join(expandHome(config.stateDir), 'gh'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function git(
  exec: Exec,
  args: readonly string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<string> {
  const result = await exec('git', args, { env, ...(cwd ? { cwd } : {}) });
  if (result.code !== 0)
    throw new Error(
      `git ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
    );
  return result.stdout;
}

/** git's credentials from `GH_TOKEN` in its environment (the app's token), nothing stored. */
export const TOKEN_HELPER = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f',
];

/**
 * Clones the repository once, with a dead-end push URL, and fetches main. Commits made in it
 * carry the app's identity, when given (`openFactory` sets it once; the worktrees share it).
 */
export async function ensureClone(
  config: FactoryConfig,
  exec: Exec,
  identity?: { readonly name: string; readonly email: string },
): Promise<string> {
  const dir = repoDir(config);
  const env = publisherEnv(config);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    await git(exec, ['clone', `https://github.com/${config.repo}.git`, dir], env);
  }
  await git(exec, ['-C', dir, 'remote', 'set-url', '--push', 'origin', DEAD_END_PUSH_URL], env);
  if (identity) {
    await git(exec, ['-C', dir, 'config', 'user.name', identity.name], env);
    await git(exec, ['-C', dir, 'config', 'user.email', identity.email], env);
  }
  await git(exec, ['-C', dir, 'fetch', '--quiet', 'origin', 'main'], env);
  return dir;
}

export interface HostOptions {
  readonly config: FactoryConfig;
  readonly slot: SlotConfig;
  readonly runId: string;
  readonly board: Board;
  readonly gh: Gh;
  readonly tracker: Tracker;
  readonly exec: Exec;
  readonly secrets: Secrets;
  /** The app's installation token, for pushes. */
  readonly pushToken: () => Promise<string>;
  /** A read-only token for the sandbox (A1222). */
  readonly sandboxToken: () => Promise<string>;
  /** Where the PR's proof is uploaded (A1223). */
  readonly proofStore: ProofStore;
  readonly agent: AgentProvider;
  readonly log: (line: string) => void;
}

export function hostDeps(options: HostOptions): RunDeps {
  const { config, slot, gh, exec } = options;
  const dir = repoDir(config);
  const env = publisherEnv(config);
  const state = expandHome(config.stateDir);
  const runDir = join(state, 'runs', options.runId);
  mkdirSync(runDir, { recursive: true });
  const sandboxes = new WeakMap<RunSandbox, Sandbox>();
  const ledger = join(state, 'runs.jsonl');

  return {
    config,
    slot,
    runId: options.runId,
    board: options.board,
    comment: (issue, body) => options.tracker.comment(issue, body),
    setStatus: (item, status) => options.tracker.setStatus(item, status),
    setBlocked: (item) => options.tracker.setBlocked(item),
    openSandbox: async (branch) => {
      const spec = sandboxSpec(config, slot, {
        ...options.secrets,
        GH_TOKEN: await options.sandboxToken(),
      });
      makeOwnDirs(spec);
      const { createSandbox } = await import('@ai-hero/sandcastle');
      const sandbox = await createSandbox({
        branch,
        baseBranch: 'origin/main',
        cwd: dir,
        sandbox: await seatbeltProvider(spec),
      });
      const handle: RunSandbox = {
        worktreePath: sandbox.worktreePath,
        exec: async (command) => {
          const r = await sandbox.exec(command);
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
        },
        close: async () => {
          await sandbox.close();
        },
      };
      sandboxes.set(handle, sandbox);
      return handle;
    },
    runAgent: async (handle, prompt) => {
      const sandbox = sandboxes.get(handle);
      if (!sandbox) throw new Error('not a sandbox this run opened');
      const logFile = join(runDir, 'agent.log');
      const tail = () => {
        try {
          return readFileSync(logFile, 'utf8').slice(-8000);
        } catch {
          return '';
        }
      };
      try {
        await sandbox.run({
          agent: options.agent,
          prompt,
          idleTimeoutSeconds: config.timeouts.agentMinutes * 60,
          logging: { type: 'file', path: logFile },
        });
      } catch (error) {
        // An agent stopped by its usage limit exits non-zero: the run waits for the reset (R13).
        const output = `${tail()}\n${error instanceof Error ? error.message : String(error)}`;
        if (usageLimitReset(output, new Date())) return { output };
        throw error;
      }
      return { output: tail() };
    },
    stageMockups: (handle) => {
      // The mockups agreed with the plan (F16), never the session's later edits.
      const issue = options.runId.split('-')[0] ?? '';
      const from = join(state, 'plans', issue, 'agreed-mockups');
      const to = join(handle.worktreePath, '.factory', 'mockups');
      mkdirSync(to, { recursive: true });
      if (existsSync(from))
        for (const f of readdirSync(from).filter((n) => n.endsWith('.html')))
          copyFileSync(join(from, f), join(to, f));
      return Promise.resolve();
    },
    readReview: (handle) => {
      const path = join(handle.worktreePath, '.factory', 'validation', 'review.json');
      return Promise.resolve(existsSync(path) ? readFileSync(path, 'utf8') : null);
    },
    collectFidelity: (handle, rows) => {
      const dir = join(runDir, 'proof');
      mkdirSync(dir, { recursive: true });
      const from = join(handle.worktreePath, '.factory', 'validation');
      const take = (f: string | undefined) => {
        if (!f || !existsSync(join(from, f))) return undefined;
        const name = `fidelity-${f}`;
        copyFileSync(join(from, f), join(dir, name));
        return name;
      };
      return Promise.resolve(
        rows.map((r) => {
          const { mockup: m, screenshot: s, ...rest } = r;
          const mockup = take(m);
          const screenshot = take(s);
          return { ...rest, ...(mockup ? { mockup } : {}), ...(screenshot ? { screenshot } : {}) };
        }),
      );
    },
    readResult: (handle) => {
      const path = join(handle.worktreePath, RESULT_PATH);
      if (!existsSync(path))
        return Promise.resolve({ ok: false, error: `the agent wrote no ${RESULT_PATH}` });
      return Promise.resolve(parseAgentResult(readFileSync(path, 'utf8')));
    },
    diff: async (branch) => {
      const paths = await git(
        exec,
        ['-C', dir, 'diff', '--name-only', `origin/main...${branch}`],
        env,
      );
      const count = await git(
        exec,
        ['-C', dir, 'rev-list', '--count', `origin/main..${branch}`],
        env,
      );
      return { paths: paths.split('\n').filter(Boolean), commits: Number(count.trim()) };
    },
    recordProof: async (handle, platform, specs) => {
      const quoted = specs.map((spec) => `'${spec.replaceAll("'", '')}'`).join(' ');
      let items: ProofItem[];
      if (platform === 'web') {
        // Its exit code is not the verdict: the report says which tests passed.
        await handle.exec(`task proof:web -- ${quoted}`);
        const report = newestReport(join(handle.worktreePath, 'apps/web/test-results'));
        if (!report) return [];
        items = fromPlaywrightReport(
          JSON.parse(readFileSync(report, 'utf8')) as Parameters<typeof fromPlaywrightReport>[0],
          'web',
          'after',
        );
      } else if (platform === 'android') {
        // The slot's own emulator, inside its sandbox (FD25); the AVD is made on the host first.
        await ensureAvd(config, slot, exec);
        await handle.exec(withJavaHome(`task proof:android -- ${quoted}`));
        const out = join(handle.worktreePath, 'apps/android/build/proof');
        const report = join(out, 'report.json');
        if (!existsSync(report)) return [];
        items = (
          JSON.parse(readFileSync(report, 'utf8')) as {
            title: string;
            status: string;
            video: string;
            screenshot: string;
          }[]
        ).map((r) => ({
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
        // copies this worktree in read-only and queues on the VM's lock (F7).
        const out = join(handle.worktreePath, 'test-results', 'vm');
        await exec('sh', [join(handle.worktreePath, 'scripts/vm/desktop-test.sh'), ...specs], {
          cwd: handle.worktreePath,
          env: {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            HOME: process.env['HOME'] ?? '',
            PENMOSS_PROOF: '1',
          },
        });
        const report = join(out, 'test-results', 'proof', 'report.json');
        if (!existsSync(report)) return [];
        items = fromPlaywrightReport(
          JSON.parse(readFileSync(report, 'utf8')) as Parameters<typeof fromPlaywrightReport>[0],
          'mac',
          'after',
        ).map((item) => ({
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
            if (!item.frames || !dirs.every((d) => existsSync(d))) return item;
            const video = join(dirs[0] ?? out, 'video.mp4');
            await framesToMp4(exec, item.frames, dirs, video);
            return { ...item, video };
          }),
        );
      }
      const raw = join(runDir, 'raw');
      mkdirSync(raw, { recursive: true });
      return items.map((item, i) => {
        const keep = (path: string | undefined, name: string) => {
          if (!path || !existsSync(path)) return undefined;
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
    fetchMain: async () => {
      await git(exec, ['-C', dir, 'fetch', '--quiet', 'origin', 'main'], env);
    },
    numberDecisions: async (handle) => {
      const listed = await handle.exec(
        "git grep -l -E 'A-NEW-[0-9]+' -- . ':!tools/factory' || true",
      );
      const files = listed.stdout.split('\n').filter(Boolean);
      if (files.length === 0) return {};
      const main = await git(exec, ['-C', dir, 'show', 'origin/main:docs/decisions.md'], env);
      const paths = files.map((f) => join(handle.worktreePath, f));
      const { texts, assigned } = assignDecisionNumbers(
        paths.map((p) => readFileSync(p, 'utf8')),
        maxDecision(main),
      );
      paths.forEach((p, i) => writeFileSync(p, texts[i] ?? ''));
      const message = `Number the new decisions: ${Object.entries(assigned)
        .map(([k, v]) => `${k} is ${v}`)
        .join(', ')}`;
      const committed = await handle.exec(`git commit -q -am '${message.replaceAll("'", '')}'`);
      if (committed.exitCode !== 0)
        throw new Error(`couldn't commit the decision numbers: ${committed.stderr.trim()}`);
      return assigned;
    },
    checks: (pr) =>
      gh
        .json<CheckRun[]>([
          'pr',
          'checks',
          pr,
          '--repo',
          config.repo,
          '--json',
          'name,state,bucket,link,startedAt,workflow',
        ])
        .catch((error: unknown) => {
          // gh exits 8 while checks are pending and 1 when there are none yet; both still print JSON or nothing.
          if (error instanceof GhError) return [];
          throw error;
        }),
    failedLog: async (check) => {
      const id = runIdOf(check);
      if (!id) return '(no Actions run to read)';
      const log = await gh
        .run(['run', 'view', id, '--repo', config.repo, '--log-failed'])
        .catch(() => '');
      return log.trim().split('\n').slice(-60).join('\n') || '(the log was empty)';
    },
    notify: async (title, message) => {
      // terminal-notifier can open a link on click: the card in the Factory UI (F20).
      const link = cardLink(config, Number(options.runId.split('-')[0]));
      if (link) {
        const sent = await exec('terminal-notifier', [
          '-title',
          title,
          '-message',
          message,
          '-open',
          link,
        ]);
        if (sent.code === 0) return;
      }
      const esc = (t: string) => t.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      await exec('osascript', [
        '-e',
        `display notification "${esc(message)}" with title "${esc(title)}"`,
      ]);
    },
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    now: () => new Date(),
    heavy: (label, fn) =>
      withHeavySlot(label, repoDir(config), fn, {
        onWait: (holders) =>
          options.log(`waits for a heavy-job slot (held by ${holders.join('; ')})`),
      }),
    push: async (branch) => {
      await git(
        exec,
        [
          '-C',
          dir,
          ...TOKEN_HELPER,
          'push',
          `https://github.com/${config.repo}.git`,
          '--force-with-lease',
          `${branch}:refs/heads/${branch}`,
        ],
        { ...env, GH_TOKEN: await options.pushToken() },
      );
    },
    openPr: async ({ branch, title, body, proof, files = [] }) => {
      // The body sits beside the proof files: its ./references are relative to it.
      const dir = join(runDir, 'proof');
      mkdirSync(dir, { recursive: true });
      const bodyFile = join(dir, 'body.md');
      const linked = await publishRefs(
        body,
        dir,
        [...proofFiles(proof), ...files],
        options.proofStore,
        `runs/${options.runId}`,
      );
      writeFileSync(bodyFile, linked);
      const out = await gh.run([
        ...['pr', 'create', '--repo', config.repo, '--base', 'main', '--head', branch],
        ...['--title', title, '--reviewer', config.owner, '--body-file', bodyFile],
      ]);
      return out.trim().split('\n').slice(-1)[0] ?? '';
    },
    log: (event: RunEvent, detail = {}) => {
      appendFileSync(
        ledger,
        `${JSON.stringify({ at: new Date().toISOString(), run: options.runId, slot: slot.id, event, ...detail })}\n`,
      );
      options.log(`${event}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
    },
  };
}

/** The newest proof report under the web app's test results (its folder is named by port). */
/** A path in the VM's `apps/desktop/test-results/…` as the copy under `<out>/test-results/…`. */
export function fromVm(path: string, out: string): string {
  const i = path.indexOf('/apps/desktop/test-results/');
  return i < 0
    ? path
    : join(out, 'test-results', path.slice(i + '/apps/desktop/test-results/'.length));
}

function newestReport(results: string): string | undefined {
  if (!existsSync(results)) return undefined;
  return readdirSync(results)
    .filter((d) => d.startsWith('proof-'))
    .map((d) => join(results, d, 'report.json'))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
