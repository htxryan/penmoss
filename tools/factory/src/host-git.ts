/**
 * The run's branch on the host (A1230): read from the publish repo, which no sandbox mounts, then
 * rebased in its sandbox, its new decisions numbered, and pushed with the app's write token.
 */
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mustGit } from './git.ts';
import {
  definedPlaceholders,
  formatDecisions,
  numberLines,
  reserveDecisionNumbers,
} from './decisions.ts';
import { within } from './proof/media.ts';
import { addedLines, DECISIONS, newRows, rebaseOntoMain } from './rebase.ts';
import { descendsFrom, fetchMainInto, githubUrl, MAIN, publishRun, pushedHead } from './publish.ts';
import { execPastRefLocks, sandboxMainCommand } from './sandbox-commands.ts';
import type { HostContext } from './host-context.ts';
import type { HostDeps } from './host.ts';

/** The branch: its diff against main, its rebase and decision numbers, and its push. */
export function gitDeps(
  ctx: HostContext,
): Pick<
  HostDeps,
  'diff' | 'fetchMain' | 'behindMain' | 'rebase' | 'numberDecisions' | 'push' | 'headSha'
> {
  const { config, exec, options, dir, publish, ref, state, fetchRun } = ctx;
  return {
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
    fetchMain: async () => {
      ctx.main.base = await fetchMainInto(exec, publish);
    },
    behindMain: async (branch) =>
      !(await descendsFrom(exec, publish, MAIN, await fetchRun(branch))),
    rebase: async (handle) => {
      const base = (ctx.main.base ??= await fetchMainInto(exec, publish));
      const fetched = await execPastRefLocks(handle, sandboxMainCommand(base));
      if (fetched.exitCode !== 0)
        throw new Error(`the sandbox couldn't fetch main: ${fetched.stderr.trim()}`);
      return rebaseOntoMain(handle, join(state, 'decision-numbers'));
    },
    numberDecisions: async (handle, branch) => {
      // Only what the branch added since the run's base, read from the publish repo: a row it
      // added defines an A-NEW-k, and its added lines elsewhere that name one get the number.
      const base = (ctx.main.base ??= await fetchMainInto(exec, publish));
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
    push: async (branch) => {
      await publishRun(exec, {
        dir: publish,
        runClone: dir,
        url: githubUrl(config),
        branch,
        ref,
        base: ctx.main.base,
        token: await options.pushToken(),
      });
    },
    headSha: (branch) => pushedHead(exec, publish, branch),
  };
}
