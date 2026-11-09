/**
 * `factory decision-number` (`task decision:next`): the next decision number for a decision added
 * by hand, reserved from the same counter the gate numbers a run's decisions from (the
 * `decision-numbers` file in the state folder). The counter only knew main and the factory's own
 * reservations, so a hand-made PR and an open run both took A1246 (PEN-70's run, 9 Nov 2026).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import { maxDecision, reserveDecisionNumbers } from './decisions.ts';
import type { Exec } from './exec.ts';

export const DECISIONS = 'docs/decisions.md';

export interface DecisionNumberDeps {
  readonly exec: Exec;
  /** The checkout it runs in: its origin's main and its own docs/decisions.md. */
  readonly repo: string;
  readonly log: (line: string) => void;
}

/** `--count n`: how many numbers to reserve (1 to 20), or an error. */
export function parseCount(args: readonly string[]): number | { error: string } {
  if (!args.includes('--count')) return 1;
  const n = Number(args[args.indexOf('--count') + 1]);
  return Number.isInteger(n) && n >= 1 && n <= 20
    ? n
    : { error: '--count takes a whole number from 1 to 20' };
}

/**
 * Reserves `count` numbers after main's highest decision (origin/main, fetched now), this
 * checkout's own and the highest the factory has given out, and prints them. Refused inside a
 * factory run, whose agents write `A-NEW-n` and get numbers from the gate.
 */
export async function decisionNumber(
  config: FactoryConfig,
  args: readonly string[],
  deps: DecisionNumberDeps,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  if (env['PENMOSS_FACTORY_RUN']) {
    deps.log(
      'Inside a factory run, write new decisions as A-NEW-1, A-NEW-2…: the gate numbers them.',
    );
    return 2;
  }
  const count = parseCount(args);
  if (typeof count !== 'number') {
    deps.log(`factory decision-number: ${count.error}`);
    return 2;
  }
  // Your own git in your own checkout, as you'd run it (its remote may need your ssh agent): not
  // the factory's hardened host git, which is for the clones the factory owns (A1230).
  const git = (...a: string[]) => deps.exec('git', ['-C', deps.repo, ...a]);
  const fetched = await git('fetch', '--quiet', '--no-tags', 'origin', 'main');
  if (fetched.code !== 0) {
    deps.log(`Couldn't fetch origin/main: ${fetched.stderr.trim().split('\n').at(-1) ?? ''}`);
    return 1;
  }
  const main = await git('show', `origin/main:${DECISIONS}`);
  if (main.code !== 0) {
    deps.log(`Couldn't read ${DECISIONS} on origin/main: ${main.stderr.trim()}`);
    return 1;
  }
  const own = join(deps.repo, DECISIONS);
  const known = `${main.stdout}\n${existsSync(own) ? readFileSync(own, 'utf8') : ''}`;
  const state = expandHome(config.stateDir);
  if (!existsSync(state)) {
    // No factory on this machine: nothing else can take a number here.
    deps.log(
      `The factory isn't installed here (${state}), so nothing is reserved. The next free number after main's and this checkout's: A${maxDecision(known) + 1}.`,
    );
    return 0;
  }
  const keys = Array.from({ length: count }, (_, i) => `#${i + 1}`);
  const assigned = reserveDecisionNumbers(keys, known, join(state, 'decision-numbers'));
  const numbers = keys.map((k) => assigned[k] ?? '');
  deps.log(numbers.join('\n'));
  return 0;
}
