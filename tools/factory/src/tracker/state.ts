/**
 * Card numbers belong to one tracker: GitHub #36 and PEN-36 are different cards. The plans, the
 * run ledger and the run folders are kept by number, so when the tracker changes, the factory
 * moves them into `archive/<old tracker>-<time>/` before it starts, and a new card never picks up
 * an old card's agreed plan or unfinished claim.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from '../config.ts';

/** What is kept by card number. */
export const BY_NUMBER = ['plans', 'runs.jsonl', 'runs', 'status.json'] as const;

export function ensureTrackerState(
  config: FactoryConfig,
  now: Date = new Date(),
): { readonly archived: string | null } {
  const state = expandHome(config.stateDir);
  mkdirSync(state, { recursive: true });
  const stamp = join(state, 'tracker');
  const present = BY_NUMBER.filter((name) => existsSync(join(state, name)));
  // State from before the stamp existed is GitHub's: the factory ran on Project 8 alone.
  const previous = existsSync(stamp)
    ? readFileSync(stamp, 'utf8').trim()
    : present.length
      ? 'github'
      : config.tracker;
  let archived: string | null = null;
  if (previous !== config.tracker && present.length) {
    archived = join(state, 'archive', `${previous}-${now.toISOString().replaceAll(':', '-')}`);
    mkdirSync(archived, { recursive: true });
    for (const name of present) renameSync(join(state, name), join(archived, name));
  }
  writeFileSync(stamp, `${config.tracker}\n`);
  return { archived };
}
