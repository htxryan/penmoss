/**
 * A card's runs, from the ledger (A1233): each run's events, where it is, why it stopped, and the
 * run in words.
 */
import type { FactoryConfig } from '../config.ts';
import type { LedgerEvent } from '../ledger.ts';
import type { RunView } from './view.ts';
import { str, num, time } from './fields.ts';

/**
 * An agent CLI's error as one line: `claude-code exited with code 127:\n/bin/sh: claude:
 * command not found` becomes `claude: command not found (exit 127)`.
 */
export function cleanError(raw: string): string {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const code = /exited with code (\d+)/.exec(raw)?.[1];
  const last = (lines.at(-1) ?? raw.trim()).replace(/^\/bin\/(?:ba|z)?sh:\s*(?:line \d+:\s*)?/, '');
  const text = code && lines.length > 1 ? last : (lines[0] ?? raw.trim());
  return code && !text.includes(`code ${code}`) ? `${text} (exit ${code})` : text;
}

/** Errors that mean the Mac, not the card, needs fixing. */
export const MACHINE = /exit 127|command not found|ENOENT|EACCES|not mode 600|permission denied/i;

/** The step each ledger event puts a card on. */
export const STAGE_OF: Readonly<Record<string, number>> = {
  claimed: 2,
  'agent-started': 2,
  'agent-finished': 2,
  'needs-info': 2,
  'usage-limited': 2,
  'decisions-numbered': 3,
  rebased: 3,
  'rebase-conflict': 3,
  'gate-failed': 3,
  'gate-passed': 4,
  'validation-mismatch': 4,
  'proof-waiting': 4,
  'proof-recorded': 4,
  'proof-reused': 4,
  validated: 4,
  'validation-reused': 4,
  pushed: 5,
  'pr-opened': 5,
  'ci-red': 5,
  'ci-repaired': 5,
  'ci-rerun': 5,
  'ci-flake-rerun': 5,
  'ci-stalled': 5,
  'in-review': 6,
  resumed: 7,
  merged: 7,
  done: 8,
};

export const STOPS = new Set(['blocked', 'failed']);

export interface Run {
  readonly id: string;
  readonly events: readonly LedgerEvent[];
}

export function runsOf(events: readonly LedgerEvent[]): Run[] {
  const runs: { id: string; events: LedgerEvent[] }[] = [];
  for (const e of events) {
    const run = runs.find((r) => r.id === e.run);
    if (run) run.events.push(e);
    else runs.push({ id: e.run, events: [e] });
  }
  return runs;
}

function phaseOf(run: Run): RunView['phase'] {
  const claim = run.events.find((e) => e.event === 'claimed');
  const phase = str(claim?.['phase']);
  if (phase === 'revise' || phase === 'rebase') return phase;
  if (!claim && run.events.some((e) => e.event === 'merged' || e.event === 'done')) return 'merge';
  return 'implement';
}

/** Why a run stopped, in words, or null when it didn't stop. */
export interface Stop {
  readonly text: string;
  readonly machine: boolean;
  readonly paused: boolean;
  readonly at: string;
}

export function stopOf(run: Run, config: FactoryConfig): Stop | null {
  const last = run.events.at(-1);
  if (!last) return null;
  const has = (event: string) => run.events.some((e) => e.event === event);
  const lastOf = (event: string) => run.events.findLast((e) => e.event === event);
  if (last.event === 'needs-info')
    return {
      text: 'The agent has questions on the issue',
      machine: false,
      paused: false,
      at: last.at,
    };
  if (last.event === 'failed') {
    if (str(last['stopped']))
      return { text: 'Paused by you', machine: false, paused: true, at: last.at };
    const error = str(last['error']);
    if (error) {
      const clean = cleanError(error);
      const machine = MACHINE.test(clean);
      const finished = has('agent-finished');
      // Exit 127: the agent's CLI itself wasn't there, so the agent never ran (PEN-75's run 1).
      const notStarted = !has('agent-started') || /exit 127|command not found/i.test(clean);
      // A review round that only rebases onto main runs no agent (A1377).
      const rebase = str(run.events[0]?.['phase']) === 'rebase';
      const text = rebase
        ? `Rebasing onto main stopped: ${clean}`
        : !finished && notStarted
          ? `Failed before the agent started: ${clean}`
          : !finished
            ? `The agent stopped before it finished: ${clean}`
            : `Stopped: ${clean}`;
      return { text, machine, paused: false, at: last.at };
    }
    const summary = str(last['summary']);
    return {
      text: summary ? `The agent couldn't finish: ${summary}` : 'Stopped',
      machine: false,
      paused: false,
      at: last.at,
    };
  }
  if (last.event !== 'blocked') return null;
  const reason = str(last['reason']) ?? '';
  const at = last.at;
  switch (reason) {
    case 'ci-red': {
      const red = lastOf('ci-red');
      const failed = Array.isArray(red?.['failed']) ? (red['failed'] as string[]).join(', ') : '';
      const repairs = num(red?.['repairs']) ?? config.rounds.ciRepair;
      return {
        text: `CI stayed red after ${repairs} repair round${repairs === 1 ? '' : 's'}${failed ? `: ${failed}` : ''}`,
        machine: false,
        paused: false,
        at,
      };
    }
    case 'ci-infra': {
      const signature = str(lastOf('ci-rerun')?.['signature']);
      return {
        text: `CI failed on the runners' infrastructure, not the branch${signature ? ` (${signature})` : ''}; re-run it once GitHub recovers`,
        machine: false,
        paused: false,
        at,
      };
    }
    case 'gate-failed': {
      // Every fix round counts, a validation mismatch's too.
      const rounds = run.events.filter(
        (e) => e.event === 'gate-failed' || e.event === 'validation-mismatch',
      ).length;
      return {
        text: `The gate still failed after ${rounds} round${rounds === 1 ? '' : 's'}; the checks that failed are on the issue`,
        machine: false,
        paused: false,
        at,
      };
    }
    case 'needs-info':
      return { text: 'The agent has questions on the issue', machine: false, paused: false, at };
    case 'failed': {
      const summary = str(lastOf('failed')?.['summary']);
      return {
        text: summary ? `The agent couldn't finish: ${summary}` : "The agent couldn't finish",
        machine: false,
        paused: false,
        at,
      };
    }
    case 'no-commits':
      return {
        text: 'The agent reported done but committed nothing',
        machine: false,
        paused: false,
        at,
      };
    case 'rebase-conflict':
      return {
        text: 'The branch no longer rebases onto main; the conflicting files are named on the issue',
        machine: false,
        paused: false,
        at,
      };
    case 'mac-vm': {
      const wait = str(lastOf('proof-waiting')?.['reason']);
      return {
        text: `The Mac proof couldn't run${wait ? `: ${wait}` : ''}`,
        machine: true,
        paused: false,
        at,
      };
    }
    default:
      return { text: reason || 'Blocked', machine: false, paused: false, at };
  }
}

/** What a run is doing now, from its last event. */
export function progressOf(e: LedgerEvent, config: FactoryConfig): string {
  const rounds = config.rounds.gateFix + 1;
  switch (e.event) {
    case 'claimed':
      return str(e['phase']) === 'revise'
        ? 'Review round: addressing your comments'
        : str(e['phase']) === 'rebase'
          ? 'Rebasing onto main'
          : 'Claimed; starting the agent';
    case 'agent-started':
      // The ledger counts rounds from 0; people count them from 1.
      return `Agent round ${(num(e['round']) ?? 0) + 1} of ${rounds}`;
    case 'agent-finished':
      return 'Agent finished; checking its work';
    case 'usage-limited': {
      const until = str(e['until']);
      return `Waiting for the usage limit to reset${until ? ` at ${time(until)}` : ''}`;
    }
    case 'decisions-numbered':
    case 'rebased':
      return 'Gate: rebased onto main, running the checks';
    case 'gate-failed':
      return `Gate failed; fix round ${(num(e['round']) ?? 0) + 2} of ${rounds}`;
    case 'gate-passed':
      return 'Gate passed; recording proof';
    case 'validation-mismatch': {
      const criteria = Array.isArray(e['criteria']) ? (e['criteria'] as string[]) : [];
      const n = criteria.length;
      return `Validation: ${n || 'some'} criteri${n === 1 ? 'on' : 'a'} not met${n ? ` (${criteria.join(', ')})` : ''}; fix round ${(num(e['round']) ?? 0) + 2} of ${rounds}`;
    }
    case 'proof-waiting':
      return `Mac proof waits: ${str(e['reason']) ?? 'the test VM'}`;
    case 'proof-recorded':
      return 'Proof recorded';
    case 'proof-reused':
      return `Proof carried over from ${str(e['from']) ?? 'an earlier run'}`;
    case 'validated':
      return 'Validated against the plan';
    case 'validation-reused':
      return `Validation carried over from ${str(e['from']) ?? 'an earlier run'}`;
    case 'pushed':
      return 'Pushed; opening the pull request';
    case 'pr-opened':
      return 'Pull request open; waiting for CI';
    case 'ci-red': {
      const failed = Array.isArray(e['failed']) ? (e['failed'] as string[]).join(', ') : '';
      return `CI red${failed ? ` (${failed})` : ''}; repair ${(num(e['repairs']) ?? 0) + 1} of ${config.rounds.ciRepair}`;
    }
    case 'ci-repaired':
      return 'CI repaired; waiting for green';
    case 'ci-rerun': {
      const signature = str(e['signature']);
      return `CI re-run: the runners' infrastructure failed${signature ? ` (${signature})` : ''}`;
    }
    case 'ci-flake-rerun': {
      const tests = Array.isArray(e['tests']) ? (e['tests'] as string[]).join(', ') : '';
      return `CI re-run once: tests the branch doesn't change failed${tests ? ` (${tests})` : ''}`;
    }
    case 'ci-stalled':
      return 'CI waiting for a Mac runner';
    case 'in-review':
      return 'Waiting for your review';
    case 'resumed':
    case 'merged':
      return 'Merged; watching main';
    case 'done':
      return 'Done';
    default:
      return e.event;
  }
}

export function roundOf(run: Run, config: FactoryConfig): string | null {
  const red = run.events.findLast((e) => e.event === 'ci-red' || e.event === 'ci-repaired');
  if (red)
    return `CI repair ${num(red['repairs']) ?? num(red['round']) ?? 0} of ${config.rounds.ciRepair}`;
  const agent = run.events.findLast((e) => e.event === 'agent-started');
  if (agent) return `Agent round ${(num(agent['round']) ?? 0) + 1} of ${config.rounds.gateFix + 1}`;
  return null;
}

export function runView(run: Run, config: FactoryConfig, isLast: boolean, live: boolean): RunView {
  const first = run.events[0]!;
  const last = run.events.at(-1)!;
  const slot = num(first['slot']);
  const stop = stopOf(run, config);
  const base = { id: run.id, slot, phase: phaseOf(run), startedAt: first.at };
  if (stop)
    return {
      ...base,
      endedAt: stop.at,
      outcome: stop.paused ? 'paused' : last.event === 'failed' ? 'failed' : 'blocked',
      summary: stop.text,
    };
  if (last.event === 'done')
    return { ...base, endedAt: last.at, outcome: 'done', summary: 'Done: main verified' };
  if (last.event === 'merged' || last.event === 'resumed')
    return {
      ...base,
      endedAt: live ? null : last.at,
      outcome: 'merged',
      summary: 'Merged; watching main',
    };
  if (last.event === 'in-review') {
    const pr = str(last['pr']);
    return {
      ...base,
      endedAt: last.at,
      outcome: 'in-review',
      summary: `Reached review${pr ? ` (PR #${pr.split('/').at(-1)})` : ''}`,
    };
  }
  if (isLast && live)
    return { ...base, endedAt: null, outcome: 'running', summary: progressOf(last, config) };
  return {
    ...base,
    endedAt: last.at,
    outcome: 'interrupted',
    summary: isLast
      ? `Stopped at "${progressOf(last, config)}"; the daemon restarts it on its branch`
      : `Interrupted at "${progressOf(last, config)}"; a later run took over`,
  };
}
