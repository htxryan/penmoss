/**
 * The daemon (F10, #274): one per Mac (a lock file), started at login by a LaunchAgent. Every
 * `pollSeconds` it reads the board, restarts orphaned runs (R12), starts Ready cards in free
 * slots, keeps the Mac awake while runs are active, and writes `status.json` for
 * `factory:status` and the Factory UI.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { readBoard, setBlocked } from './board.ts';
import { nodeExec } from './exec.ts';
import { sweep } from './janitor.ts';
import { expandHome, type FactoryConfig } from './config.ts';
import { labelProblems, tick, type Running } from './dispatcher.ts';
import { formatMarker } from './pick.ts';
import { parseIssueSpec } from './labels.ts';
import { executePlanning, executeRun, openFactory, planAgreed, runnable } from './start.ts';
import { executeMerge, executeRevise, findPr, nextReviewAction } from './watch.ts';

export interface Lock {
  release(): void;
}

/** The singleton lock: a file holding the daemon's pid; a dead pid's lock is taken over. */
export function takeLock(
  path: string,
  pid = process.pid,
  alive = isAlive,
): { ok: true; lock: Lock } | { ok: false; holder: number } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return { ok: true, lock: { release: () => rmSync(path, { force: true }) } };
    } catch {
      const holder = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return { ok: false, holder };
      rmSync(path, { force: true });
    }
  }
  return { ok: false, holder: -1 };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Issues whose last ledger event says a run claimed them and never finished. */
export function unfinishedClaims(ledger: string): Set<number> {
  const open = new Set<number>();
  const terminal = new Set(['blocked', 'failed', 'in-review']);
  for (const line of ledger.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { event?: string; issue?: number; run?: string };
      const issue = e.issue ?? Number(String(e.run ?? '').split('-')[0]);
      if (!Number.isInteger(issue)) continue;
      if (e.event === 'claimed') open.add(issue);
      else if (e.event && terminal.has(e.event)) open.delete(issue);
    } catch {
      // A torn last line from a crash: skip it.
    }
  }
  return open;
}

export async function runDaemon(
  config: FactoryConfig,
  log: (line: string) => void,
): Promise<number> {
  const state = expandHome(config.stateDir);
  mkdirSync(state, { recursive: true });
  const taken = takeLock(join(state, 'daemon.lock'));
  if (!taken.ok) {
    log(`Another factory daemon is running (pid ${taken.holder}).`);
    return 1;
  }
  const opened = await openFactory(config);
  if (!opened.ok) {
    taken.lock.release();
    log(`Can't start: ${opened.error}.`);
    return 2;
  }
  const { factory } = opened;
  const running = new Map<number, Running>();
  const merging = new Set<number>();
  let caffeinate: ChildProcess | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log(
    `Factory daemon ${process.pid}: ${config.slots.length} slot(s), at most ${config.maxConcurrent} at once, every ${config.pollSeconds} s.`,
  );

  let swept = 0;
  while (!stopping) {
    try {
      // The janitor: at start, then every six hours (F13).
      if (Date.now() - swept > 6 * 3600_000) {
        swept = Date.now();
        await sweep(config, nodeExec, new Set(running.keys()), log).catch((error: unknown) =>
          log(`janitor: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      const board = await readBoard(factory.gh, config);
      const ledgerPath = join(state, 'runs.jsonl');
      const claimed = existsSync(ledgerPath)
        ? unfinishedClaims(readFileSync(ledgerPath, 'utf8'))
        : new Set<number>();
      const agreed = new Set(
        board.items
          .filter((i) => i.status === config.status.planning && planAgreed(config, i.number))
          .map((i) => i.number),
      );
      for (const { item, error } of labelProblems(board, config)) {
        log(`#${item.number}: can't start: ${error}; Blocked`);
        await factory.gh
          .run(
            ['issue', 'comment', String(item.number), '--repo', config.repo, '--body-file', '-'],
            `The factory can't start this issue: ${error}. Fix the labels, then clear Blocked.\n\n${formatMarker({ issue: String(item.number), event: 'labels' })}`,
          )
          .then(() => setBlocked(factory.gh, board, item))
          .catch((e: unknown) =>
            log(`#${item.number}: ${e instanceof Error ? e.message : String(e)}`),
          );
      }
      const t = tick(board, config, [...running.values()], claimed, agreed);
      // Planning steps are short CLI calls: one card after another, in this loop.
      for (const item of t.plan) {
        await executePlanning(factory, board, item, (line) => log(`#${item.number}: ${line}`))
          .then((action) => {
            if (action.kind !== 'wait') log(`#${item.number}: planning ${action.kind}`);
          })
          .catch((error: unknown) =>
            log(
              `#${item.number}: planning failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      }
      for (const { item, slot, why } of t.start) {
        const ok = runnable(
          config,
          item,
          why === 'recovered'
            ? [config.status.working]
            : [config.status.pick, config.status.planning],
        );
        if (!ok.ok) {
          log(`Not starting: ${ok.error}`);
          continue;
        }
        running.set(item.number, {
          issue: item.number,
          slot: slot.id,
          startedAt: new Date().toISOString(),
          why,
        });
        log(`#${item.number} on slot ${slot.id} (${why})`);
        void executeRun(factory, board, item, ok.spec, slot, (line) =>
          log(`#${item.number}: ${line}`),
        )
          .then((outcome) => log(`#${item.number}: ${outcome.kind}`))
          .catch((error: unknown) =>
            log(`#${item.number}: ${error instanceof Error ? error.message : String(error)}`),
          )
          .finally(() => running.delete(item.number));
      }
      // In review cards: a review round or CI repair in a free slot, or a merge on approval.
      const busySlots = new Set([...running.values()].map((r) => r.slot));
      for (const item of board.items) {
        if (
          item.status !== config.status.review ||
          item.blocked ||
          item.state !== 'OPEN' ||
          item.repo !== config.repo
        )
          continue;
        if (running.has(item.number) || merging.has(item.number)) continue;
        const parsed = parseIssueSpec(item.labels, config);
        if (!parsed.ok) continue;
        const pr = await findPr(factory, item);
        if (!pr) continue;
        const action = await nextReviewAction(factory, pr, new Date());
        if (action.kind === 'none') continue;
        if (action.kind === 'merge') {
          merging.add(item.number);
          log(`#${item.number}: approved, merging ${pr.url}`);
          void executeMerge(factory, board, item, pr, (line) => log(`#${item.number}: ${line}`))
            .then((kind) => log(`#${item.number}: ${kind}`))
            .catch((error: unknown) =>
              log(
                `#${item.number}: merge failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
            .finally(() => merging.delete(item.number));
          continue;
        }
        const slot = config.slots.find((s) => !busySlots.has(s.id));
        if (!slot || running.size >= config.maxConcurrent) continue;
        busySlots.add(slot.id);
        running.set(item.number, {
          issue: item.number,
          slot: slot.id,
          startedAt: new Date().toISOString(),
          why: 'picked',
        });
        log(
          `#${item.number} on slot ${slot.id}: ${action.kind === 'round' ? `review round (${action.state.trigger})` : 'CI repair'}`,
        );
        void executeRevise(factory, board, item, parsed.spec, slot, pr, action, (line) =>
          log(`#${item.number}: ${line}`),
        )
          .then((kind) => log(`#${item.number}: ${kind}`))
          .catch((error: unknown) =>
            log(`#${item.number}: ${error instanceof Error ? error.message : String(error)}`),
          )
          .finally(() => running.delete(item.number));
      }
      // Awake while anything runs, never otherwise (no battery rule, FD21).
      if (running.size + merging.size > 0 && !caffeinate)
        caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      if (running.size + merging.size === 0 && caffeinate) {
        caffeinate.kill();
        caffeinate = undefined;
      }
      writeFileSync(
        join(state, 'status.json'),
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            pid: process.pid,
            running: [...running.values()],
            waiting: t.waiting,
            planning: t.plan.map((i) => i.number),
            skipped: t.skipped,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      log(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
  }
  caffeinate?.kill();
  taken.lock.release();
  log('Stopped. Runs still in progress are restarted the next time the daemon starts (R12).');
  return 0;
}
