/**
 * What the host's parts share for one run: its options, the runs' clone and the publish repo, the
 * run's folder, its sandboxes, and main as last fetched.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProvider, Sandbox } from '@ai-hero/sandcastle';
import type { Board } from './board.ts';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import type { Exec } from './exec.ts';
import type { Gh } from './github.ts';
import type { ProofStore } from './proof/store.ts';
import { fetchRunBranch, publishDir, runRef } from './publish.ts';
import type { IssueComment } from './issue.ts';
import type { Secrets } from './secrets.ts';
import type { Tracker } from './tracker/port.ts';
import type { RunSandbox } from './run-deps.ts';
import { repoDir } from './clone.ts';

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

/** One run's host: what `hostDeps` and its parts (host-agent.ts, host-git.ts and the rest) share. */
export interface HostContext {
  readonly options: HostOptions;
  readonly config: FactoryConfig;
  readonly slot: SlotConfig;
  readonly gh: Gh;
  readonly exec: Exec;
  /** The runs' clone. */
  readonly dir: string;
  /** The publish repo (A1230), which no sandbox mounts. */
  readonly publish: string;
  readonly ref: string;
  /** The factory's state folder, and the run's own folder in it. */
  readonly state: string;
  readonly runDir: string;
  /** The Sandcastle sandbox behind each handle the run opened. */
  readonly sandboxes: WeakMap<RunSandbox, Sandbox>;
  /**
   * main as last fetched into the publish repo: the base the gate's rebase goes onto, and that a
   * push checks the branch descends from.
   */
  readonly main: { base: string | undefined };
  /** Fetches the run's branch from the runs' clone into the publish repo: its commit. */
  readonly fetchRun: (branch: string) => Promise<string>;
}

export function hostContext(options: HostOptions): HostContext {
  const { config, slot, gh, exec } = options;
  const dir = repoDir(config);
  const publish = publishDir(config);
  const ref = runRef(options.runId);
  const fetchRun = (branch: string) => fetchRunBranch(exec, publish, dir, branch, ref);
  const state = expandHome(config.stateDir);
  const runDir = join(state, 'runs', options.runId);
  mkdirSync(runDir, { recursive: true });
  const sandboxes = new WeakMap<RunSandbox, Sandbox>();
  return {
    options,
    config,
    slot,
    gh,
    exec,
    dir,
    publish,
    ref,
    state,
    runDir,
    sandboxes,
    main: { base: undefined },
    fetchRun,
  };
}
