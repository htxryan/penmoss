/**
 * The real `RunDeps`: the factory's own clone, Sandcastle sandboxes, gh as the GitHub App
 * (A1222), and the run ledger. Kept apart from run.ts so the run's sequence is tested with fakes.
 *
 * The runs work in the factory's own clone (`<stateDir>/repo`), never in Ryan's checkout. Its
 * push URL is a dead end, so a plain `git push` from a worktree goes nowhere. The host never runs
 * git in that clone or its worktrees (A1230): it fetches a run's branch from it into the
 * publish repo (`<stateDir>/publish`, publish.ts), which no sandbox mounts, reads it there, and
 * pushes from there to an explicit URL with the app's write token, which the sandbox never sees
 * (R18): a sandbox holds only the app's read-only token.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { AgentProvider, Sandbox } from '@ai-hero/sandcastle';
import type { Board } from './board.ts';
import { ensureAvd, stopSlotEmulator } from './avd.ts';
import { withHeavySlot } from './heavy.ts';
import { usageLimitReset } from './limits.ts';
import { cardLink } from './ui/link.ts';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { ensureConfig, mustGit } from './git.ts';
import { runIdOf, type CheckRun } from './checks.ts';
import {
  definedPlaceholders,
  formatDecisions,
  numberLines,
  reserveDecisionNumbers,
} from './decisions.ts';
import { GhError, type Gh } from './github.ts';
import { proofFiles, type AttachedProof } from './proof/body.ts';
import { publishRefs, type ProofStore } from './proof/store.ts';
import { fromPlaywrightReport, type ProofItem } from './proof/manifest.ts';
import { checkMedia, framesToMp4, framesWithin, toMp4, within } from './proof/media.ts';
import { addedLines, DECISIONS, rebaseOntoMain } from './rebase.ts';
import { checkMacVm, runMacProof } from './proof/mac.ts';
import {
  descendsFrom,
  ensurePublishRepo,
  fetchMainInto,
  fetchRunBranch,
  githubUrl,
  MAIN,
  publishDir,
  publishRun,
  pushedHead,
  runRef,
} from './publish.ts';
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
 * Appends one event to the run ledger (`runs.jsonl`), which `factory:report`, the daemon's
 * recovery (`unfinishedClaims`) and the UI read: `{ at, run, event, ...detail }`.
 */
export function appendLedger(
  config: FactoryConfig,
  entry: { readonly run: string; readonly event: string; readonly [key: string]: unknown },
): void {
  appendFileSync(
    join(expandHome(config.stateDir), 'runs.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}

/**
 * The publisher's environment for gh: nothing of Ryan's (git's is `gitEnv`, git.ts). `gh` gets the app's token per
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

export { TOKEN_HELPER } from './git.ts';

/**
 * Opens the branch's PR, or, when one is already open, gives it the new title and body and
 * returns it. A run restarted after the daemon stopped (R12), say while it waited on CI, comes
 * back here with its PR open, and `gh pr create` refuses a second one for the same branch. The
 * edit goes through the REST API, which needs only the app's Pull requests permission.
 */
export async function openOrReusePr(
  gh: Gh,
  pr: {
    readonly repo: string;
    readonly branch: string;
    readonly title: string;
    readonly bodyFile: string;
    readonly reviewer: string;
  },
): Promise<string> {
  const open = await gh.json<{ number: number; url: string }[]>([
    ...['pr', 'list', '--repo', pr.repo, '--head', pr.branch],
    ...['--state', 'open', '--json', 'number,url'],
  ]);
  const existing = open[0];
  if (existing) {
    await gh.run([
      ...['api', '-X', 'PATCH', `repos/${pr.repo}/pulls/${existing.number}`],
      ...['-f', `title=${pr.title}`, '-F', `body=@${pr.bodyFile}`],
    ]);
    return existing.url;
  }
  const out = await gh.run([
    ...['pr', 'create', '--repo', pr.repo, '--base', 'main', '--head', pr.branch],
    ...['--title', pr.title, '--reviewer', pr.reviewer, '--body-file', pr.bodyFile],
  ]);
  return out.trim().split('\n').slice(-1)[0] ?? '';
}

/**
 * Clones the runs' clone once, gives it a dead-end push URL and, when given, the app's identity
 * for the commits made in it (`openFactory` sets it once; the worktrees share it), then makes the
 * publish repo and fetches main there (A1230). git never runs in the clone after its `clone`:
 * its config is written as a file (sandboxes see that file read-only), and its main is fetched
 * by each sandbox as it starts and again before each rebase (`sandboxStartCommand`).
 */
export async function ensureClone(
  config: FactoryConfig,
  exec: Exec,
  identity?: { readonly name: string; readonly email: string },
): Promise<string> {
  const dir = repoDir(config);
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  if (!existsSync(join(dir, '.git')))
    await mustGit(exec, parent, ['clone', '--quiet', githubUrl(config), dir]);
  const dotGit = lstatSync(join(dir, '.git'));
  const file = join(dir, '.git', 'config');
  if (!dotGit.isDirectory() || !lstatSync(file).isFile())
    throw new Error(
      `${dir} isn't a clone the factory made (its .git isn't a folder with a config)`,
    );
  const set = (key: string, value: string) => ensureConfig(exec, parent, key, value, file);
  await set('remote.origin.pushurl', DEAD_END_PUSH_URL);
  if (identity) {
    await set('user.name', identity.name);
    await set('user.email', identity.email);
  }
  await ensurePublishRepo(config, exec, identity);
  return dir;
}

/**
 * The gate sandbox's fetch of main into the runs' clone, with the sandbox's read-only token, and
 * main put at `base`: the commit the host fetched into the publish repo, which the push then
 * checks the branch descends from. The host never fetches into the clone itself.
 */
export function sandboxMainCommand(base: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error(`not a commit: ${base}`);
  return [
    `git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    'fetch --quiet --no-tags origin main',
    `&& git update-ref refs/remotes/origin/main ${base}`,
  ].join(' ');
}

/**
 * The first command in every sandbox the host opens: main fetched and put at `base`, as for the
 * gate, then a branch with no commits of its own (one Sandcastle has just made from the clone's
 * main, which only the last gate moved) fast-forwarded onto `base`. A branch with commits of its
 * own (a restarted run's, R12, or a fix or review round's) is rebased onto `base` when its
 * tracked files are clean and the rebase goes through, so the agent works on today's main
 * rather than re-reporting what main has fixed since (PEN-75's restarted run); otherwise it is
 * left where it is, and the gate's rebase, which resolves decision rows, deals with it.
 */
export function sandboxStartCommand(base: string): string {
  return [
    `${sandboxMainCommand(base)} && if git merge-base --is-ancestor HEAD ${base}; then git merge --ff-only --quiet ${base};`,
    `elif test -z "$(git status --porcelain --untracked-files=no)"; then git rebase --quiet ${base} >/dev/null 2>&1 || git rebase --abort; fi`,
  ].join(' ');
}

/** The agent's raw output stream in the run folder, beside Sandcastle's `agent.log`. */
export const AGENT_STREAM = 'agent.stream.jsonl';

/**
 * The command a shell couldn't find, from an agent's failure: `sh`'s "claude: command not found"
 * or exit 127, zsh's "command not found: claude". Undefined for any other failure.
 */
export function agentMissing(message: string): string | undefined {
  const named =
    /command not found: (\S+)/.exec(message)?.[1] ??
    /([^\s:/]+): command not found/.exec(message)?.[1];
  if (named) return named;
  if (!/exited with code 127\b/.test(message)) return undefined;
  // dash: "sh: 1: claude: not found", only with the shell's own exit code.
  return /([^\s:/]+): not found/.exec(message)?.[1] ?? "the agent's command";
}

/**
 * The agent CLI isn't where the factory looks: an installation problem, not the card's. The run
 * says so plainly (start.ts), with the PATH the sandbox had (the LaunchAgent's, A1226).
 */
export class AgentNotInstalled extends Error {
  readonly command: string;

  constructor(command: string, path: string) {
    super(
      `the factory can't find \`${command}\` on its PATH (${path}). That is the factory's installation, not this card: install it on that PATH, or set its full path as the agent's \`bin\` in tools/factory/factory.config.json, then task factory:install (task factory:doctor checks it)`,
    );
    this.name = 'AgentNotInstalled';
    this.command = command;
  }
}

/**
 * Sandcastle ends its log with "reached 1 iteration(s) without completion signal" after every
 * run: the factory never gives the agent Sandcastle's completion signal (it reads
 * `.factory/result.json` instead, and one iteration is all it asks for), so that line is
 * expected. The log says so beneath it, so it doesn't read as a failure.
 */
export function explainCompletion(logFile: string): void {
  let text: string;
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    return;
  }
  if (!/without completion signal\.?\s*$/.test(text)) return;
  appendFileSync(
    logFile,
    "(The factory: that is expected. It doesn't use Sandcastle's completion signal; the agent's .factory/result.json says how the round ended.)\n",
  );
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
  /** What the run waits for (the test VM), for the daemon's status.json (F10). */
  readonly waitingFor?: (reason: string | null) => void;
}

/** The host's RunDeps, plus the commit last pushed to a branch (a review round replies with it). */
export type HostDeps = RunDeps & { headSha(branch: string): Promise<string> };

export function hostDeps(options: HostOptions): HostDeps {
  const { config, slot, gh, exec } = options;
  const dir = repoDir(config);
  const publish = publishDir(config);
  const ref = runRef(options.runId);
  // main as last fetched into the publish repo: the base the gate's rebase goes onto, and that a
  // push checks the branch descends from.
  let base: string | undefined;
  const fetchRun = (branch: string) => fetchRunBranch(exec, publish, dir, branch, ref);
  const state = expandHome(config.stateDir);
  const runDir = join(state, 'runs', options.runId);
  mkdirSync(runDir, { recursive: true });
  const sandboxes = new WeakMap<RunSandbox, Sandbox>();

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
      // Sandcastle makes a new branch from the clone's origin/main, which only the last gate
      // moved: the sandbox starts from the main the host fetched instead (A1232).
      base ??= await fetchMainInto(exec, publish);
      const started = await handle.exec(sandboxStartCommand(base));
      if (started.exitCode !== 0) {
        await handle.close();
        throw new Error(
          `the sandbox couldn't start from main's ${base.slice(0, 10)}: ${started.stderr.trim()}`,
        );
      }
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
      // agent.log is Sandcastle's rendering; the agent's own stream (Claude Code's stream-json,
      // its init event first, which lists the MCP servers it loaded) is kept beside it, verbatim.
      const streamFile = join(runDir, AGENT_STREAM);
      try {
        await sandbox.run({
          agent: options.agent,
          prompt,
          idleTimeoutSeconds: config.timeouts.agentMinutes * 60,
          logging: {
            type: 'file',
            path: logFile,
            onAgentStreamEvent: (event) => {
              if (event.type === 'raw') appendFileSync(streamFile, `${event.line}\n`);
            },
          },
        });
      } catch (error) {
        // An agent stopped by its usage limit exits non-zero: the run waits for the reset (R13).
        const message = error instanceof Error ? error.message : String(error);
        const output = `${tail()}\n${message}`;
        if (usageLimitReset(output, new Date())) return { output };
        const missing = agentMissing(message);
        if (missing) throw new AgentNotInstalled(missing, process.env['PATH'] ?? '');
        throw error;
      }
      explainCompletion(logFile);
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
      const text = readFileSync(path, 'utf8');
      const parsed = parseAgentResult(text);
      // A copy the host keeps: a run restarted after this one resumes from it (resumeFrom).
      if (parsed.ok) writeFileSync(join(runDir, 'result.json'), text);
      return Promise.resolve(parsed);
    },
    diff: async (branch) => {
      const commit = await fetchRun(branch);
      const paths = await mustGit(exec, publish, [
        'diff',
        '--name-only',
        '--no-ext-diff',
        `${MAIN}...${commit}`,
      ]);
      const count = await mustGit(exec, publish, ['rev-list', '--count', `${MAIN}..${commit}`]);
      // The branch's first commit's subject: the PR's title (prTitle, run.ts).
      const subjects = await mustGit(exec, publish, [
        ...['log', '--reverse', '--no-merges', '--format=%s'],
        `${MAIN}..${commit}`,
      ]);
      const subject = subjects.split('\n')[0]?.trim();
      return {
        paths: paths.split('\n').filter(Boolean),
        commits: Number(count.trim()),
        ...(subject ? { subject } : {}),
      };
    },
    macVmCheck: (handle) => checkMacVm(exec, config, handle.worktreePath),
    waitingFor: (reason) => options.waitingFor?.(reason),
    recordProof: async (handle, platform, specs, signal) => {
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
        // The slot's own emulator, inside its sandbox (FD25); the AVD is made on the host first,
        // and an emulator a stopped run left up is stopped. At the proof timeout the host stops
        // the emulator: `am instrument -w` waits as long as a hung test does, and ends when the
        // device goes; closing the gate's sandbox then kills what is left of proof.sh.
        await ensureAvd(config, slot, exec);
        await stopSlotEmulator(config, slot, exec);
        const stop = () => void stopSlotEmulator(config, slot, exec).catch(() => undefined);
        signal?.addEventListener('abort', stop, { once: true });
        try {
          await handle.exec(withJavaHome(`task proof:android -- ${quoted}`));
        } finally {
          signal?.removeEventListener('abort', stop);
        }
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
        // copies this worktree in read-only and queues on the VM's lock (F7). At the proof
        // timeout it is stopped with its `tart run`, and stops the VM, freeing the lock.
        const out = join(handle.worktreePath, 'test-results', 'vm');
        await runMacProof(exec, config, handle.worktreePath, specs, signal);
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
      const raw = join(runDir, 'raw');
      mkdirSync(raw, { recursive: true });
      return items.map((item, i) => {
        // Only the run's own files: the agent's tests write the report that names them.
        const keep = (path: string | undefined, name: string) => {
          if (!path || !within(path, handle.worktreePath)) return undefined;
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
      base = await fetchMainInto(exec, publish);
    },
    behindMain: async (branch) =>
      !(await descendsFrom(exec, publish, MAIN, await fetchRun(branch))),
    rebase: async (handle) => {
      base ??= await fetchMainInto(exec, publish);
      const fetched = await handle.exec(sandboxMainCommand(base));
      if (fetched.exitCode !== 0)
        throw new Error(`the sandbox couldn't fetch main: ${fetched.stderr.trim()}`);
      return rebaseOntoMain(handle, join(state, 'decision-numbers'));
    },
    numberDecisions: async (handle, branch) => {
      // Only what the branch added since the run's base, read from the publish repo: a row it
      // added defines an A-NEW-k, and its added lines elsewhere that name one get the number.
      base ??= await fetchMainInto(exec, publish);
      const commit = await fetchRun(branch);
      const diff = await mustGit(exec, publish, [
        ...['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'],
        `${base}...${commit}`,
      ]);
      const added = addedLines(diff);
      const file = (path: string) => {
        // A tracked file only: never through a symlink, never outside the worktree.
        const at = join(handle.worktreePath, path);
        if (!existsSync(at) || !lstatSync(at).isFile() || !within(at, handle.worktreePath))
          return undefined;
        return { at, text: readFileSync(at, 'utf8') };
      };
      const decisions = added.has(DECISIONS) ? file(DECISIONS) : undefined;
      const keys = decisions
        ? definedPlaceholders(decisions.text, added.get(DECISIONS) ?? new Set())
        : [];
      if (keys.length === 0) return {};
      const main = await mustGit(exec, publish, ['show', `${base}:${DECISIONS}`]);
      const assigned = reserveDecisionNumbers(keys, main, join(state, 'decision-numbers'));
      // The factory's own code and tests name placeholders as data.
      for (const [path, lines] of added) {
        if (path.startsWith('tools/factory/')) continue;
        const found = file(path);
        if (!found) continue;
        let after = numberLines(found.text, lines, assigned);
        if (path === DECISIONS) after = await formatDecisions(after);
        if (after !== found.text) writeFileSync(found.at, after);
      }
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
      // A notification is a courtesy: one that can't be shown never stops a run. terminal-notifier
      // (optional, docs/factory.md) can open the card in the Factory UI (F20) on click; when it
      // isn't installed, spawning it throws, and osascript shows a plain one instead.
      const tried = (cmd: string, args: string[]) =>
        exec(cmd, args).then(
          (result) => result.code === 0,
          () => false,
        );
      const link = cardLink(config, Number(options.runId.split('-')[0]));
      if (
        link &&
        (await tried('terminal-notifier', ['-title', title, '-message', message, '-open', link]))
      )
        return;
      const esc = (t: string) => t.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      if (
        !(await tried('osascript', [
          '-e',
          `display notification "${esc(message)}" with title "${esc(title)}"`,
        ]))
      )
        options.log(`couldn't show the notification "${title}"`);
    },
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    now: () => new Date(),
    heavy: (label, fn) =>
      withHeavySlot(label, repoDir(config), fn, {
        onWait: (holders) =>
          options.log(`waits for a heavy-job slot (held by ${holders.join('; ')})`),
      }),
    push: async (branch) => {
      await publishRun(exec, {
        dir: publish,
        runClone: dir,
        url: githubUrl(config),
        branch,
        ref,
        base,
        token: await options.pushToken(),
      });
    },
    headSha: (branch) => pushedHead(exec, publish, branch),
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
      return openOrReusePr(gh, {
        repo: config.repo,
        branch,
        title,
        bodyFile,
        reviewer: config.owner,
      });
    },
    keep: (name, text) => writeFileSync(join(runDir, name), text),
    // A boundary only: guarded, it is where Blocked stops the run (start.ts, R23).
    step: () => Promise.resolve(),
    log: (event: RunEvent, detail = {}) => {
      appendLedger(config, { run: options.runId, slot: slot.id, event, ...detail });
      options.log(`${event}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
    },
  };
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
