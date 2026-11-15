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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentProvider,
  AgentStreamEvent,
  Sandbox,
  SandboxRunResult,
} from '@ai-hero/sandcastle';
import type { Board } from './board.ts';
import { ensureAvd, stopSlotEmulator } from './avd.ts';
import { ATTACHMENTS, stageAttachments } from './attachments.ts';
import { withHeavySlot } from './heavy.ts';
import { usageLimitReset } from './limits.ts';
import { cardLink } from './ui/link.ts';
import {
  account,
  clearStaged,
  freshLogin,
  loginDir,
  stageLogin,
  stagingDir,
} from './claude-login.ts';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { ensureConfig, mustGit } from './git.ts';
import { type CheckRun, failedLines, jobIdOf, runIdOf } from './checks.ts';
import { ciHistory, MAIN_RUNS_READ, rerunWhenDone } from './ci-failure.ts';
import { findProven } from './carry.ts';
import type { MainRun, RunJob } from './merge.ts';
import {
  definedPlaceholders,
  formatDecisions,
  numberLines,
  reserveDecisionNumbers,
} from './decisions.ts';
import { type Gh, GhError } from './github.ts';
import { proofFiles, type AttachedProof } from './proof/body.ts';
import { type ProofStore, publishRefs } from './proof/store.ts';
import { fromPlaywrightReport, type ProofItem, type PwReport } from './proof/manifest.ts';
import { androidFailures, type FailedTest, playwrightFailures } from './proof/evidence.ts';
import { checkMedia, framesToMp4, framesWithin, toMp4, within } from './proof/media.ts';
import { addedLines, DECISIONS, newRows, rebaseOntoMain } from './rebase.ts';
import { checkMacVm, runMacProof, runMacWalk } from './proof/mac.ts';
import {
  adoptRemoteHead,
  descendsFrom,
  ensurePublishRepo,
  fetchMainInto,
  fetchRunBranch,
  githubUrl,
  MAIN,
  type OpenPr,
  publishDir,
  publishRun,
  pushedHead,
  remoteBranch,
  resumablePr,
  runRef,
  unchangedSincePush,
} from './publish.ts';
import { parseAgentResult, RESULT_PATH } from './result.ts';
import type { RunDeps, RunEvent, RunSandbox } from './run-deps.ts';
import type { IssueComment } from './issue.ts';
import { makeOwnDirs, sandboxSpec, seatbeltProvider, withJavaHome } from './sandbox.ts';
import { ANDROID_WALK_CLASS, MAC_WALK_SPEC, WALK_SHOT, walkFile, walkTail } from './walk.ts';
import type { Secrets } from './secrets.ts';
import type { Tracker } from './tracker/port.ts';
import { leftoversLine, signal, stopLeftovers } from './leftovers.ts';
import {
  execPastRefLocks,
  SANDBOX_READY,
  sandboxMainCommand,
  sandboxStartCommand,
  sandboxTakeCommand,
} from './sandbox-commands.ts';
import {
  clearProofFiles,
  fromVm,
  keepProofFiles,
  macFailures,
  newestReport,
  stageLastProof,
} from './host-proof.ts';
import {
  AGENT_STREAM,
  agentMissing,
  AgentNotInstalled,
  CHAT_URL,
  chatUrlOf,
  explainCompletion,
  keepFiles,
  lastErrorEvent,
  lastResultEvent,
} from './agent-stream.ts';
export {
  AGENT_STREAM,
  AgentNotInstalled,
  CHAT_URL,
  agentMissing,
  chatUrlOf,
  explainCompletion,
  keepFiles,
  lastErrorEvent,
  lastResultEvent,
} from './agent-stream.ts';

export {
  LAST_PROOF,
  clearProofFiles,
  fromVm,
  keepProofFiles,
  macFailures,
  stageLastProof,
} from './host-proof.ts';

export {
  REF_LOCK,
  SANDBOX_READY,
  execPastRefLocks,
  sandboxMainCommand,
  sandboxStartCommand,
  sandboxTakeCommand,
} from './sandbox-commands.ts';

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
  /**
   * The same agent with a chat in the Claude app (A1287), when there is a factory login. A
   * session uses it when the login is fresh or can be refreshed, otherwise `agent`.
   */
  readonly remoteAgent?: AgentProvider | undefined;
  /** A session's chat link, as soon as its runner reports it: the card gets it (A1287). */
  readonly onChat?: (url: string) => void;
  readonly log: (line: string) => void;
  /** What the run waits for (the test VM), for the daemon's status.json (F10). */
  readonly waitingFor?: (reason: string | null) => void;
  /** Ryan's card comments the run's prompt doesn't hold yet (RunDeps.ownerComments). */
  readonly ownerComments?: () => Promise<readonly IssueComment[]>;
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
  // A session with a chat in the Claude app signs in with the factory's own login: the host
  // refreshes it if it must, and stages its access token for this slot until the session ends.
  // Without a login that works, the session runs on the setup token, with no chat (A1287).
  const remoteSession = async () => {
    const dir = loginDir(config);
    if (!options.remoteAgent || !dir) return undefined;
    const staging = stagingDir(config, slot.id);
    clearStaged(staging);
    try {
      const login = await freshLogin(exec, config, dir);
      return { agent: options.remoteAgent, unstage: stageLogin(staging, login, account(dir)) };
    } catch (error) {
      options.log(
        `no chat in the Claude app for this session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
  // A proof's whole output, kept in the run folder: the gate's worktree, with the proof's own
  // logs, is gone once it closes (PEN-70's Android proof failed twice and left no reason, A1252).
  const proofLogs = new Map<string, string>();
  const keepProofLog = (platform: string, ran: { stdout: string; stderr: string }) => {
    const text = ran.stdout + ran.stderr;
    proofLogs.set(platform, text);
    writeFileSync(join(runDir, `proof-${platform}.log`), text);
  };

  // The sandbox's last session, which `continueAgent` resumes when its agent keeps sessions.
  const lastSessions = new WeakMap<RunSandbox, { resume?: SandboxRunResult['resume'] }>();
  /**
   * One agent session in the sandbox, or with `resume` the sandbox's last one continued
   * (Sandcastle's resume: Claude Code's `--resume`). OpenCode's sessions aren't kept (A1263),
   * so it never resumes.
   */
  const session = async (handle: RunSandbox, prompt: string, resume = false) => {
    const sandbox = sandboxes.get(handle);
    if (!sandbox) throw new Error('not a sandbox this run opened');
    const last = lastSessions.get(handle)?.resume;
    if (resume && !last) throw new Error('no session in this sandbox to continue');
    const logFile = join(runDir, 'agent.log');
    // Sandcastle appends every session of the run to agent.log. Only this session's part is
    // read, or a retry after a usage limit would find the old limit message and wait again.
    const start = existsSync(logFile) ? statSync(logFile).size : 0;
    const tail = () => {
      try {
        return readFileSync(logFile).subarray(start).toString('utf8').slice(-8000);
      } catch {
        return '';
      }
    };
    // agent.log is Sandcastle's rendering; the agent's own stream (Claude Code's stream-json,
    // its init event first, which lists the MCP servers it loaded) is kept beside it, verbatim.
    const streamFile = join(runDir, AGENT_STREAM);
    const streamStart = existsSync(streamFile) ? statSync(streamFile).size : 0;
    // What can say the session hit a usage limit. Claude Code ends a session with a result
    // event, which carries a limit as an error: when there is one, only it counts, so an agent
    // that writes about limits (or works on rate limiting) isn't taken for one that hit its own.
    const limitText = (fallback: string) => {
      const result = lastResultEvent(streamFile, streamStart);
      if (!result) {
        // OpenCode's provider error, which says how long its limit lasts.
        const error = lastErrorEvent(streamFile, streamStart);
        return error ? `${fallback}\n${error}` : fallback;
      }
      return result.is_error === true && typeof result.result === 'string' ? result.result : '';
    };
    // A resumed session keeps its agent; its login is staged again all the same.
    const remote = await remoteSession();
    const agent = remote ? remote.agent : options.agent;
    try {
      const run = {
        idleTimeoutSeconds: config.timeouts.agentMinutes * 60,
        logging: {
          type: 'file' as const,
          path: logFile,
          onAgentStreamEvent: (event: AgentStreamEvent) => {
            if (event.type !== 'raw') return;
            appendFileSync(streamFile, `${event.line}\n`);
            const url = remote ? chatUrlOf(event.line) : undefined;
            if (url) {
              writeFileSync(join(runDir, CHAT_URL), url);
              options.log(`the session's chat in the Claude app: ${url}`);
              options.onChat?.(url);
            }
          },
        },
      };
      const ran =
        resume && last ? await last(prompt, run) : await sandbox.run({ agent, prompt, ...run });
      // Sandcastle offers a resume for any agent with session storage, but only a captured
      // session can be resumed: the factory doesn't capture OpenCode's (A1263).
      lastSessions.set(handle, agent.captureSessions && ran.resume ? { resume: ran.resume } : {});
    } catch (error) {
      // An agent stopped by its usage limit exits non-zero: the run waits for the reset (R13).
      const message = error instanceof Error ? error.message : String(error);
      const output = `${limitText(tail())}\n${message}`;
      if (usageLimitReset(output, new Date())) return { output };
      const missing = agentMissing(message);
      if (missing) throw new AgentNotInstalled(missing, process.env['PATH'] ?? '');
      throw error;
    } finally {
      remote?.unstage();
      rmSync(join(runDir, CHAT_URL), { force: true });
    }
    explainCompletion(logFile);
    return { output: limitText(tail()) };
  };

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
      // What an earlier session left running in this worktree goes first, and what this one
      // leaves goes when it closes (A1297).
      const leftovers = async (when: string) => {
        const stopped = await stopLeftovers(exec, sandbox.worktreePath, {
          kill: signal,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        }).catch(() => []);
        if (stopped.length > 0) options.log(leftoversLine(stopped, when));
      };
      await leftovers('by an earlier session');
      const handle: RunSandbox = {
        worktreePath: sandbox.worktreePath,
        exec: async (command, execOptions = {}) => {
          // Out of time (F2): whatever runs in the worktree is stopped, so the command ends.
          const stop = () => void leftovers('when its command ran out of time');
          execOptions.signal?.addEventListener('abort', stop, { once: true });
          try {
            const r = await sandbox.exec(command);
            return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
          } finally {
            execOptions.signal?.removeEventListener('abort', stop);
          }
        },
        close: async () => {
          await sandbox.close();
          await leftovers('when the sandbox closed');
        },
      };
      // Whatever stops the sandbox from opening closes it (F1): no worktree or seatbelt is left.
      try {
        // Commits someone pushed to the PR's branch by hand come first, so the agent builds on
        // them and the push keeps them (PEN-101). A branch rewritten under the factory stops here.
        const remote = await remoteBranch(
          exec,
          publish,
          githubUrl(config),
          branch,
          await options.pushToken(),
        );
        if (remote.kind === 'rewritten') {
          throw new Error(
            `the PR's branch \`${branch}\` was rewritten on GitHub (it is at ${remote.head.slice(0, 10)}, which no longer holds the factory's last push, ${remote.ours.slice(0, 10)}), so the factory won't build on it or push over it. Push your commits on top of ${remote.ours.slice(0, 10)} instead, or close the PR and clear Blocked to start the card again`,
          );
        }
        if (remote.kind === 'ahead') {
          const took = await handle.exec(sandboxTakeCommand(branch, remote.from, remote.to));
          if (took.exitCode !== 0) {
            throw new Error(
              `the commits pushed to \`${branch}\` on GitHub (${remote.from.slice(0, 10)}..${remote.to.slice(0, 10)}) don't apply to the run's branch: ${took.stderr.trim() || `exit ${took.exitCode}`}`,
            );
          }
          await adoptRemoteHead(exec, publish, branch, remote.to);
          options.log(
            `took the commits pushed to ${branch} on GitHub, up to ${remote.to.slice(0, 10)}`,
          );
        }
        // Sandcastle makes a new branch from the clone's origin/main, which only the last gate
        // moved: the sandbox starts from the main the host fetched instead (A1232).
        base ??= await fetchMainInto(exec, publish);
        const started = await execPastRefLocks(handle, sandboxStartCommand(base));
        if (started.exitCode !== 0) {
          throw new Error(
            `the sandbox couldn't start from main's ${base.slice(0, 10)}: ${started.stderr.trim()}`,
          );
        }
        const ready = await handle.exec(SANDBOX_READY);
        if (ready.exitCode !== 0)
          options.log(
            `the sandbox's dependencies didn't install (exit ${ready.exitCode}); the agent starts without them: ${(ready.stderr || ready.stdout).trim().split('\n').slice(-3).join(' ')}`,
          );
        // The last proof's screenshots, so an agent sent back by a failed proof can see where it
        // stopped (A1291): the Mac proof runs in the VM, which the sandbox can't reach.
        try {
          stageLastProof(join(runDir, 'raw'), handle.worktreePath);
        } catch {
          // The agent then has the proof's output only.
        }
        // The issue's images, which the host downloaded into the run folder (attachments.ts). A
        // copy that fails leaves the agent without them; it never stops the run.
        try {
          stageAttachments(join(runDir, ATTACHMENTS), handle.worktreePath);
        } catch {
          // The agent then finds no file where the prompt says; the run goes on.
        }
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
      sandboxes.set(handle, sandbox);
      return handle;
    },
    runAgent: (handle, prompt) => session(handle, prompt),
    canContinue: (handle) => lastSessions.get(handle)?.resume !== undefined,
    continueAgent: (handle, message) => session(handle, message, true),
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
    keepValidation: (handle) => {
      // One folder per validation in the run, so a later round doesn't overwrite an earlier one.
      const root = join(runDir, 'validation');
      const n = existsSync(root) ? readdirSync(root).length + 1 : 1;
      keepFiles(join(handle.worktreePath, '.factory', 'validation'), join(root, String(n)));
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
        return Promise.resolve({
          ok: false,
          error: `the agent wrote no ${RESULT_PATH}`,
          missing: true,
        });
      const text = readFileSync(path, 'utf8');
      const parsed = parseAgentResult(text);
      // A copy the host keeps: a run restarted after this one resumes from it (resumeFrom).
      if (parsed.ok) writeFileSync(join(runDir, 'result.json'), text);
      return Promise.resolve(parsed);
    },
    pushedPr: async (branch) => {
      const head = await unchangedSincePush(
        exec,
        publish,
        githubUrl(config),
        branch,
        await options.pushToken(),
      );
      // The run's branch must have nothing since, not even a commit it never pushed.
      if (!head || (await fetchRun(branch)) !== head) return undefined;
      const open = await gh.json<OpenPr[]>([
        ...['pr', 'list', '--repo', config.repo, '--head', branch],
        ...['--state', 'open', '--json', 'url,headRefOid,mergeable'],
      ]);
      return resumablePr(open, head);
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
      // The branch's first commit's subject: the PR's title (prTitle, pr-title.ts).
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
    ...(options.ownerComments ? { ownerComments: options.ownerComments } : {}),
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
    fetchMain: async () => {
      base = await fetchMainInto(exec, publish);
    },
    behindMain: async (branch) =>
      !(await descendsFrom(exec, publish, MAIN, await fetchRun(branch))),
    rebase: async (handle) => {
      base ??= await fetchMainInto(exec, publish);
      const fetched = await execPastRefLocks(handle, sandboxMainCommand(base));
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
      const main = decisions ? await mustGit(exec, publish, ['show', `${base}:${DECISIONS}`]) : '';
      // Rows the agent's Prettier only re-padded are main's, not the branch's (A1269).
      if (decisions)
        added.set(DECISIONS, newRows(decisions.text, added.get(DECISIONS) ?? new Set(), main));
      const keys = decisions
        ? definedPlaceholders(decisions.text, added.get(DECISIONS) ?? new Set())
        : [];
      if (keys.length === 0) return {};
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
    conflicts: async (pr) =>
      (await gh.json<{ mergeable?: string }>(['pr', 'view', pr, '--json', 'mergeable']))
        .mergeable === 'CONFLICTING',
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
      // The job's own log: `gh run view --log-failed` has nothing while the run's other jobs
      // are still going, which PEN-64's CI repair got as an empty log (A1278).
      const job = jobIdOf(check);
      if (job) {
        const log = await gh
          .run(['api', '--allow-escape-sequences', `repos/${config.repo}/actions/jobs/${job}/logs`])
          .catch(() => '');
        if (log.trim()) return failedLines(log);
      }
      const id = runIdOf(check);
      if (!id) return '(no Actions run to read)';
      const log = await gh
        .run(['run', 'view', id, '--repo', config.repo, '--log-failed'])
        .catch(() => '');
      return failedLines(log) || '(the log was empty)';
    },
    rerunFailed: (run) =>
      rerunWhenDone(run, {
        status: async (id) =>
          (
            await gh.json<{ status: string }>([
              ...['run', 'view', id, '--repo', config.repo, '--json', 'status'],
            ])
          ).status,
        rerun: async (id) => {
          await gh.run(['run', 'rerun', id, '--failed', '--repo', config.repo]);
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    mainRunJobs: async (workflow) => {
      // main's latest finished push runs of the workflow, newest first, and each one's jobs.
      const runs = await gh.json<MainRun[]>([
        ...['run', 'list', '--repo', config.repo, '--branch', 'main', '--event', 'push'],
        ...['--workflow', workflow, '--status', 'completed', '--limit', String(MAIN_RUNS_READ)],
        ...['--json', 'databaseId,status,conclusion,url'],
      ]);
      const jobs: RunJob[][] = [];
      for (const run of runs) {
        if (!run.databaseId) continue;
        const view = await gh.json<{ jobs: RunJob[] }>([
          ...['run', 'view', String(run.databaseId), '--repo', config.repo, '--json', 'jobs'],
        ]);
        jobs.push(view.jobs);
      }
      return jobs;
    },
    provenBefore: (diff) =>
      findProven(state, Number(options.runId.split('-')[0]), diff, options.runId),
    ciHistory: (issue, pr) => {
      const ledger = join(state, 'runs.jsonl');
      return ciHistory(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '', issue, pr);
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
    openPr: async ({ branch, title, body, proof, files = [], proofFrom }) => {
      // The body sits beside the proof files: its ./references are relative to it.
      const dir = join(runDir, 'proof');
      mkdirSync(dir, { recursive: true });
      const bodyFile = join(dir, 'body.md');
      // Proof carried over from an earlier run (carry.ts) is in that run's folder, and goes
      // where that run put it in the bucket, so the links are the ones it had.
      const from = proofFrom && /^[\w-]+$/.test(proofFrom) ? proofFrom : options.runId;
      const linked = await publishRefs(
        body,
        join(state, 'runs', from, 'proof'),
        [...proofFiles(proof), ...files],
        options.proofStore,
        `runs/${from}`,
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
    proofLog: (platform) => proofLogs.get(platform),
    // A boundary only: guarded, it is where Blocked stops the run (start.ts, R23).
    step: () => Promise.resolve(),
    log: (event: RunEvent, detail = {}) => {
      appendLedger(config, { run: options.runId, slot: slot.id, event, ...detail });
      options.log(`${event}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
    },
  };
}
