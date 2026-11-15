/**
 * The real `RunDeps` (run-deps.ts): the factory's own clone, Sandcastle sandboxes, gh as the
 * GitHub App (A1222), and the run ledger. Kept apart from the run (run.ts) so its sequence is
 * tested with fakes. `hostDeps` puts it together from parts that share one run's `HostContext`
 * (host-context.ts): the sandbox (host-sandbox.ts), the agent's sessions (host-agent.ts), the
 * branch (host-git.ts), the PR and its CI (host-github.ts), the proof (host-proof.ts) and
 * validation's files (host-validation.ts).
 *
 * The runs work in the factory's own clone (`<stateDir>/repo`), never in Ryan's checkout. Its
 * push URL is a dead end, so a plain `git push` from a worktree goes nowhere. The host never runs
 * git in that clone or its worktrees (A1230): it fetches a run's branch from it into the
 * publish repo (`<stateDir>/publish`, publish.ts), which no sandbox mounts, reads it there, and
 * pushes from there to an explicit URL with the app's write token, which the sandbox never sees
 * (R18): a sandbox holds only the app's read-only token.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withHeavySlot } from './heavy.ts';
import { cardLink } from './ui/link.ts';
import { expandHome, type FactoryConfig } from './config.ts';
import { ciHistory } from './ci-failure.ts';
import { findProven } from './carry.ts';
import { type HostOptions, hostContext } from './host-context.ts';
import type { RunDeps, RunEvent } from './run-deps.ts';
import { repoDir } from './clone.ts';
import { appendLedger } from './ledger.ts';
import { agentDeps } from './host-agent.ts';
import { gitDeps } from './host-git.ts';
import { githubDeps } from './host-github.ts';
import { proofDeps } from './host-proof.ts';
import { sandboxDeps } from './host-sandbox.ts';
import { validationDeps } from './host-validation.ts';

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

/** The host's RunDeps, plus the commit last pushed to a branch (a review round replies with it). */
export type HostDeps = RunDeps & { headSha(branch: string): Promise<string> };

export function hostDeps(options: HostOptions): HostDeps {
  const ctx = hostContext(options);
  const { config, slot, exec, state, runDir } = ctx;
  return {
    config,
    slot,
    runId: options.runId,
    board: options.board,
    comment: (issue, body) => options.tracker.comment(issue, body),
    setStatus: (item, status) => options.tracker.setStatus(item, status),
    setBlocked: (item) => options.tracker.setBlocked(item),
    ...sandboxDeps(ctx),
    ...agentDeps(ctx),
    ...validationDeps(ctx),
    ...githubDeps(ctx),
    ...gitDeps(ctx),
    ...proofDeps(ctx),
    waitingFor: (reason) => options.waitingFor?.(reason),
    ...(options.ownerComments ? { ownerComments: options.ownerComments } : {}),
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
    keep: (name, text) => writeFileSync(join(runDir, name), text),
    // A boundary only: guarded, it is where Blocked stops the run (start.ts, R23).
    step: () => Promise.resolve(),
    log: (event: RunEvent, detail = {}) => {
      appendLedger(config, { run: options.runId, slot: slot.id, event, ...detail });
      options.log(`${event}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
    },
  };
}
