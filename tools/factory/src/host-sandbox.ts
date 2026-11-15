/**
 * Opening a run's sandbox (RunDeps' `openSandbox`): a Sandcastle worktree on the branch in the
 * runs' clone, under its own Seatbelt profile with the app's read-only token (A1222), started
 * from the main the host fetched (A1232), with commits pushed to the PR by hand taken first
 * (PEN-101), and the last proof's files and the issue's images staged in it.
 */
import { join } from 'node:path';
import { ATTACHMENTS, stageAttachments } from './attachments.ts';
import { adoptRemoteHead, fetchMainInto, githubUrl, remoteBranch } from './publish.ts';
import { makeOwnDirs, sandboxSpec, seatbeltProvider } from './sandbox.ts';
import { leftoversLine, signal, stopLeftovers } from './leftovers.ts';
import {
  execPastRefLocks,
  SANDBOX_READY,
  sandboxStartCommand,
  sandboxTakeCommand,
} from './sandbox-commands.ts';
import { stageLastProof } from './host-proof.ts';
import type { HostContext } from './host-context.ts';
import type { HostDeps } from './host.ts';
import type { RunSandbox } from './run-deps.ts';

/** `openSandbox`: whatever stops the sandbox from opening closes it (F1). */
export function sandboxDeps(ctx: HostContext): Pick<HostDeps, 'openSandbox'> {
  const { config, slot, exec, options, dir, publish, runDir, sandboxes } = ctx;
  return {
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
        const base = (ctx.main.base ??= await fetchMainInto(exec, publish));
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
  };
}
