/**
 * `status.json`: what the daemon writes after every poll, for `factory:status`, the Factory UI and
 * `factory:update`, which waits on it before it restarts the daemon.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import type { Running } from './dispatcher.ts';
import { issueKey } from './tracker/port.ts';

/** The commit a checkout is at. */
export interface Commit {
  readonly sha: string;
  readonly subject: string;
}

export interface DaemonStatus {
  readonly updatedAt: string;
  readonly pid: number;
  readonly running: readonly Running[];
  /** Cards being merged or verified on `main` (absent from daemons before `factory:update`). */
  readonly merging?: readonly number[];
  readonly waiting: readonly number[];
  readonly planning?: readonly number[];
  readonly skipped: readonly { readonly issue: number; readonly reason: string }[];
  /** Holding new work for `factory:update` (absent from daemons before it). */
  readonly paused?: boolean;
  /** The checkout the daemon's code runs from, and its commit then. */
  readonly code?: { readonly dir: string; readonly commit?: Commit };
}

export function statusPath(config: FactoryConfig): string {
  return join(expandHome(config.stateDir), 'status.json');
}

export function readStatus(config: FactoryConfig): DaemonStatus | undefined {
  const file = statusPath(config);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DaemonStatus;
  } catch {
    // Written as the daemon read it: the next poll writes it whole.
    return undefined;
  }
}

/** `factory:status`'s lines. `codeDir` is where `factory:install` keeps the factory's code. */
export function formatStatus(
  s: DaemonStatus,
  config: FactoryConfig,
  codeDir: string,
  now: Date,
): string[] {
  const age = Math.round((now.getTime() - Date.parse(s.updatedAt)) / 1000);
  const at = s.code?.commit
    ? ` at ${s.code.commit.sha.slice(0, 7)} (${s.code.commit.subject})`
    : ' (commit unknown: it predates task factory:update)';
  const lines = [
    `Daemon ${s.pid}${at}, last poll ${age} s ago${age > config.pollSeconds * 3 ? ' (stale: is it running? task factory:logs)' : ''}.`,
  ];
  if (s.code && s.code.dir !== codeDir)
    lines.push(
      `  runs from ${s.code.dir}, not the factory's own checkout ${codeDir}: run task factory:install`,
    );
  if (s.paused) lines.push('  paused: task factory:update is waiting for runs to finish');
  lines.push(
    s.running.length
      ? s.running
          .map(
            (r) =>
              `  running ${issueKey(config, r.issue)} on slot ${r.slot} since ${r.startedAt} (${r.why})`,
          )
          .join('\n')
      : '  nothing running',
  );
  if (s.merging?.length)
    lines.push(`  merging: ${s.merging.map((n) => issueKey(config, n)).join(', ')}`);
  if (s.waiting.length)
    lines.push(`  waiting for a slot: ${s.waiting.map((n) => issueKey(config, n)).join(', ')}`);
  for (const k of s.skipped) lines.push(`  passed over ${issueKey(config, k.issue)}: ${k.reason}`);
  return lines;
}
