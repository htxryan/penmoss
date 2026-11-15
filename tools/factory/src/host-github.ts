/**
 * The run's pull request and its CI on GitHub, through gh as the factory's app (A1222): opening or
 * reusing the PR with its proof uploaded (A1223), its checks and failed logs, re-runs, and main's
 * runs of a workflow (A1328).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CheckRun, failedLines, jobIdOf, runIdOf } from './checks.ts';
import { MAIN_RUNS_READ, rerunWhenDone } from './ci-failure.ts';
import type { MainRun, RunJob } from './merge.ts';
import { type Gh, GhError } from './github.ts';
import { proofFiles } from './proof/body.ts';
import { publishRefs } from './proof/store.ts';
import { githubUrl, type OpenPr, resumablePr, unchangedSincePush } from './publish.ts';
import type { HostContext } from './host-context.ts';
import type { HostDeps } from './host.ts';

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

/** The PR and its CI. */
export function githubDeps(
  ctx: HostContext,
): Pick<
  HostDeps,
  'pushedPr' | 'openPr' | 'conflicts' | 'checks' | 'failedLog' | 'rerunFailed' | 'mainRunJobs'
> {
  const { config, gh, exec, options, publish, state, runDir, fetchRun } = ctx;
  return {
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
  };
}
