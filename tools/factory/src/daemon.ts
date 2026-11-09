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
import { nodeExec } from './exec.ts';
import { sweep } from './janitor.ts';
import { expandHome, type FactoryConfig } from './config.ts';
import { labelProblems, tick, type Running } from './dispatcher.ts';
import { formatMarker } from './pick.ts';
import { parseIssueSpec } from './labels.ts';
import { executePlanning, executeRun, openFactory, planAgreed, runnable } from './start.ts';
import { executeMerge, executeRevise, findPr, nextReviewAction } from './watch.ts';
import { codeDir, commitOf, ownCheckout, updatePending } from './code.ts';
import type { DaemonStatus } from './status.ts';

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

/**
 * Issues whose last ledger event says a run claimed them and never reached In review. A run
 * that stopped Blocked (Ryan paused it, or it asked him something) stays claimed: orphans()
 * passes over a Blocked card, and once he clears Blocked the run restarts on its branch (R23).
 */
export function unfinishedClaims(ledger: string): Set<number> {
  const open = new Set<number>();
  // A merge (merged, done) finishes a claim too: a run that failed after its card reached In
  // Review wrote no in-review, and the card then merged through the review loop (PEN-75).
  const terminal = new Set(['in-review', 'merged', 'done']);
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

/** `status.json`, which the daemon writes every poll for `factory:status` and the UI. */
/** A run's entry with what it now waits for (F10); `since` stays when the wait began. */
export function withWait(run: Running, reason: string | null, now: Date): Running {
  if (reason === null) {
    const rest = { ...run };
    delete rest.waitingFor;
    return rest;
  }
  return { ...run, waitingFor: { reason, since: run.waitingFor?.since ?? now.toISOString() } };
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
  // The code it runs, so the log and factory:status say which commit is live (A1226).
  const commit = await commitOf(nodeExec, ownCheckout());
  const code = { dir: ownCheckout(), ...(commit ? { commit } : {}) };
  // A run says what it waits for (the test VM); status.json carries it to factory:status.
  const waitingFor = (issue: number) => (reason: string | null) => {
    const r = running.get(issue);
    if (r) running.set(issue, withWait(r, reason, new Date()));
  };
  log(
    `Factory daemon ${process.pid} at ${commit ? `${commit.sha.slice(0, 7)} (${commit.subject})` : 'an unknown commit'} from ${code.dir}: ${config.slots.length} slot(s), at most ${config.maxConcurrent} at once, every ${config.pollSeconds} s.`,
  );
  if (code.dir !== codeDir(config))
    log(`Not the factory's own code checkout (${codeDir(config)}): run task factory:install.`);
  let held = false;

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
      // factory:update is waiting for the runs to finish: start nothing new until it restarts us.
      const hold = updatePending(config, isAlive);
      if (hold !== held)
        log(hold ? 'Holding new work for task factory:update.' : 'No longer held.');
      held = hold;
      const board = await factory.tracker.readBoard();
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
        log(`${item.key}: can't start: ${error}; Blocked`);
        await factory.tracker
          .comment(
            item.number,
            `The factory can't start this issue: ${error}. Fix the labels, then clear Blocked.\n\n${formatMarker({ issue: String(item.number), event: 'labels' })}`,
          )
          .then(() => factory.tracker.setBlocked(item))
          .catch((e: unknown) => log(`${item.key}: ${e instanceof Error ? e.message : String(e)}`));
      }
      const t = tick(board, config, [...running.values()], claimed, agreed);
      // Planning steps are short CLI calls: one card after another, in this loop.
      for (const item of hold ? [] : t.plan) {
        await executePlanning(factory, item, (line) => log(`${item.key}: ${line}`))
          .then((action) => {
            if (action.kind !== 'wait') log(`${item.key}: planning ${action.kind}`);
          })
          .catch((error: unknown) =>
            log(
              `${item.key}: planning failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      }
      for (const { item, slot, why } of hold ? [] : t.start) {
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
        log(`${item.key} on slot ${slot.id} (${why})`);
        void executeRun(
          factory,
          board,
          item,
          ok.spec,
          slot,
          (line) => log(`${item.key}: ${line}`),
          why === 'recovered',
          waitingFor(item.number),
        )
          .then((outcome) => log(`${item.key}: ${outcome.kind}`))
          .catch((error: unknown) =>
            log(`${item.key}: ${error instanceof Error ? error.message : String(error)}`),
          )
          .finally(() => running.delete(item.number));
      }
      // In review cards: a review round or CI repair in a free slot, or a merge on approval.
      const busySlots = new Set([...running.values()].map((r) => r.slot));
      for (const item of hold ? [] : board.items) {
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
          log(
            `${item.key}: ${pr.state === 'MERGED' ? 'merged; verifying main for' : 'approved, merging'} ${pr.url}`,
          );
          void executeMerge(factory, item, pr, (line) => log(`${item.key}: ${line}`))
            .then((kind) => log(`${item.key}: ${kind}`))
            .catch((error: unknown) =>
              log(
                `${item.key}: merge failed: ${error instanceof Error ? error.message : String(error)}`,
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
          `${item.key} on slot ${slot.id}: ${action.kind === 'round' ? `review round (${action.state.trigger})` : action.kind === 'rebase' ? 'rebase onto main' : 'CI repair'}`,
        );
        void executeRevise(
          factory,
          board,
          item,
          parsed.spec,
          slot,
          pr,
          action,
          (line) => log(`${item.key}: ${line}`),
          waitingFor(item.number),
        )
          .then((kind) => log(`${item.key}: ${kind}`))
          .catch((error: unknown) =>
            log(`${item.key}: ${error instanceof Error ? error.message : String(error)}`),
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
      const status: DaemonStatus = {
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        running: [...running.values()],
        merging: [...merging],
        waiting: t.waiting,
        planning: t.plan.map((i) => i.number),
        skipped: t.skipped,
        paused: hold,
        code,
      };
      writeFileSync(join(state, 'status.json'), JSON.stringify(status, null, 2));
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
