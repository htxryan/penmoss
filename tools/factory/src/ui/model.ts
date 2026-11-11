/**
 * The Factory UI's view (F20, #276; redesigned in A1233): the factory's health, what needs
 * Ryan and exactly what to do about it, each card on the lifecycle (Todo → Plan → Build → Gate →
 * Proof → PR + CI → Review → Merge → Done) with its runs, and the slots' runs over the last hours.
 * Built from the board, the run ledger, `status.json`, the planning folders and `claude agents`,
 * all read-only. The page draws two views of it, Inbox and Pipeline, with one card detail.
 *
 * A card counts as the factory's only when the factory handles its status (Todo, Planning) or the
 * ledger holds its claim: an In Progress card nobody gave the factory is counted, not listed.
 */
import type { Board, BoardItem } from '../board.ts';
import type { FactoryConfig } from '../config.ts';
import type { Running } from '../dispatcher.ts';
import { parseIssueSpec } from '../labels.ts';
import { pickNext } from '../pick.ts';
import type { PlanMeta } from '../planning-host.ts';
import { attachCommand, type PlanQuestion, type PlanState } from '../planning.ts';
import type { DoctorSummary } from '../doctor-summary.ts';
import type { DaemonStatus } from '../status.ts';
import { hasBlockedSet } from '../tracker/port.ts';

export interface Link {
  readonly label: string;
  readonly href: string;
}

/** The lifecycle's steps, in order: a card's `stage` indexes this. */
export const STAGES = [
  'Todo',
  'Plan',
  'Build',
  'Gate',
  'Proof',
  'PR + CI',
  'Review',
  'Merge',
  'Done',
] as const;

/** How the card's marker is drawn: the factory working, Ryan's turn, stopped, won't start. */
export type Tone = 'live' | 'you' | 'stop' | 'card' | 'idle' | 'done';

/** What Ryan must do to move the card on (the brief's five gates). */
export type NeedKind = 'answer' | 'review' | 'unblock' | 'machine' | 'card';

export interface Need {
  readonly kind: NeedKind;
  /** The gate, as a short verb phrase: "Answer the plan". */
  readonly label: string;
  /** The specific ask, one line: "Answer 4 questions on the plan", "Review PR #85". */
  readonly brief: string;
  /** What to do about it, after the brief (which it doesn't repeat). */
  readonly what: string;
  /** A command to run on the Mac, for a machine problem. */
  readonly command: string | null;
}

/** An open point of the plan as the page asks it: the question, its context, its options. */
export interface Point {
  readonly text: string;
  /** The planner's proposal or context for it, when that isn't the question itself. */
  readonly context: string | null;
  readonly options: readonly PointOption[];
}

export interface PointOption {
  /** What the answer posts, as the planner wrote it. */
  readonly value: string;
  /** What the button says: the value without its "(proposed)". */
  readonly label: string;
  readonly proposed: boolean;
}

export interface RunView {
  readonly id: string;
  readonly slot: number | null;
  readonly phase: 'implement' | 'revise' | 'rebase' | 'merge';
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome:
    'running' | 'in-review' | 'blocked' | 'failed' | 'paused' | 'interrupted' | 'merged' | 'done';
  /** The run in words: how it ended, or where it is. */
  readonly summary: string;
}

export interface CardView {
  readonly number: number;
  /** `#36` or `PEN-36`. */
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly status: string;
  /** Index into STAGES. */
  readonly stage: number;
  readonly tone: Tone;
  /** What the card is doing, or why it stopped. */
  readonly step: string;
  /** When that began. */
  readonly since: string | null;
  readonly need: Need | null;
  /** Ryan set Blocked himself (or the factory left no reason of its own). */
  readonly paused: boolean;
  /** Whether Blocked itself is set, which the page can clear; not an unfinished blocker. */
  readonly blocked: boolean;
  /** Unfinished issues that hold the card (LD8). */
  readonly heldBy: readonly string[];
  readonly group: 'needs' | 'working' | 'queue' | 'done';
  /** Pickup position among Todo cards that can start, 1 first. */
  readonly queuePosition: number | null;
  readonly priority: number | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly slot: number | null;
  readonly round: string | null;
  readonly pr: string | null;
  readonly open: readonly string[];
  /** Planning questions with one-click answers (F21). */
  readonly questions: readonly PlanQuestion[];
  /** The plan's open points as the page asks them: each question with its context and options. */
  readonly points: readonly Point[];
  /** Open points that couldn't be paired with a question: shown once, as the planner's notes. */
  readonly notes: readonly string[];
  /** Whether "Complete" applies: a plan exists and isn't agreed yet. */
  readonly canComplete: boolean;
  readonly runs: readonly RunView[];
  /** The current run's folder, for its logs. */
  readonly runFolder: string | null;
  /** The command that joins the card's planning session from a terminal on this Mac (A1281). */
  readonly chat: string | null;
  /** The planning session's chat on claude.ai, which Remote Control serves (A1286). */
  readonly chatUrl: string | null;
  /** The last lines of the current run's agent log, for a card in a slot. */
  readonly log: readonly string[];
  readonly links: readonly Link[];
}

export type HealthState = 'running' | 'paused' | 'stale' | 'dead' | 'missing';

export interface Health {
  readonly state: HealthState;
  /** Whether the live parts of the page can be trusted: the daemon is alive and polling. */
  readonly fresh: boolean;
  readonly headline: string;
  readonly detail: string;
  readonly fix: string | null;
  readonly pid: number | null;
  readonly updatedAt: string | null;
  readonly ageSeconds: number | null;
  readonly pollSeconds: number;
  readonly commit: { readonly sha: string; readonly subject: string } | null;
  readonly slots: { readonly total: number; readonly busy: number };
  /** Other things wrong with the setup: wrong checkout, a failing doctor check. */
  readonly problems: readonly {
    /** A few words for the header's pill: "wrong checkout", "doctor failing on slot 1". */
    readonly label: string;
    readonly text: string;
    readonly fix: string | null;
  }[];
  readonly doctor: string | null;
}

export interface SlotView {
  readonly slot: number;
  readonly issue: number | null;
  readonly key: string | null;
  readonly since: string | null;
  readonly waitingFor: string | null;
}

export interface TimelineBar {
  readonly issue: number;
  readonly key: string;
  readonly run: string;
  readonly start: string;
  readonly end: string;
  readonly tone: Tone;
  readonly label: string;
}

export interface Outcome {
  readonly at: string;
  readonly issue: number;
  readonly key: string;
  readonly what: string;
  readonly detail: string;
  readonly tone: Tone;
}

export interface FactoryView {
  readonly updatedAt: string;
  /** Whether the page may write (F21): the UI found Ryan's own Linear key (or gh login). */
  readonly writable: boolean;
  /** Why it may not, when it may not. */
  readonly readOnly: string | null;
  readonly health: Health;
  readonly stages: readonly string[];
  /** The cards waiting on Ryan, oldest first. */
  readonly needs: readonly CardView[];
  /** Every card the factory handles, in pipeline order: needs, working, queue, done. */
  readonly cards: readonly CardView[];
  readonly slots: readonly SlotView[];
  /** In Progress or In Review cards the factory never claimed: counted, not listed. */
  readonly outside: readonly string[];
  readonly timeline: {
    readonly from: string;
    readonly to: string;
    readonly lanes: readonly { readonly slot: number; readonly bars: readonly TimelineBar[] }[];
  };
  readonly outcomes: readonly Outcome[];
  readonly totals: {
    readonly started: number;
    readonly inReview: number;
    readonly merged: number;
    readonly blocked: number;
  };
}

export interface LedgerEvent {
  readonly at: string;
  readonly run: string;
  readonly event: string;
  readonly [detail: string]: unknown;
}

export interface PlanInfo {
  readonly meta: PlanMeta;
  readonly state: PlanState | null;
}

export interface ViewInput {
  readonly config: FactoryConfig;
  readonly board: Board;
  /** `runs.jsonl` as text. */
  readonly ledger: string;
  readonly plans: Readonly<Record<number, PlanInfo>>;
  /** Issue numbers whose planning session is running a turn now (`claude agents`). */
  readonly busySessions: ReadonlySet<number>;
  /** `status.json` from the daemon, if any. */
  readonly status: DaemonStatus | null;
  /** Whether a process is alive (`kill -0`): the status file alone can't say the daemon died. */
  readonly alive: (pid: number) => boolean;
  readonly now: Date;
  /** Where `factory:install` keeps the factory's own clone (A1226). */
  readonly codeDir?: string;
  /** The last `factory:doctor` result per slot. */
  readonly doctor?: readonly DoctorSummary[];
  /** The last lines of a run's agent log. */
  readonly logTail?: (run: string) => readonly string[];
  /** Where a run's folder is. */
  readonly runFolder?: (run: string) => string;
  readonly writable?: boolean;
  readonly readOnly?: string | null;
  /** How far back the timeline and outcomes reach (default 12 h). */
  readonly windowHours?: number;
}

export function parseLedger(text: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<LedgerEvent>;
      if (typeof e.at === 'string' && typeof e.run === 'string' && typeof e.event === 'string')
        events.push(e as LedgerEvent);
    } catch {
      // A torn line from a crash.
    }
  }
  return events;
}

export const issueOf = (e: LedgerEvent) => Number(e.run.split('-')[0]);

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);

/** A planning session's claude.ai chat link, or null for anything that isn't one. */
export function chatLink(url: string | undefined): string | null {
  return url && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/.test(url) ? url : null;
}

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
const MACHINE = /exit 127|command not found|ENOENT|EACCES|not mode 600|permission denied/i;

/** The step each ledger event puts a card on. */
const STAGE_OF: Readonly<Record<string, number>> = {
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
  'proof-waiting': 4,
  'proof-recorded': 4,
  validated: 4,
  pushed: 5,
  'pr-opened': 5,
  'ci-red': 5,
  'ci-repaired': 5,
  'ci-stalled': 5,
  'in-review': 6,
  resumed: 7,
  merged: 7,
  done: 8,
};

const STOPS = new Set(['blocked', 'failed']);
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

interface Run {
  readonly id: string;
  readonly events: readonly LedgerEvent[];
}

function runsOf(events: readonly LedgerEvent[]): Run[] {
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
interface Stop {
  readonly text: string;
  readonly machine: boolean;
  readonly paused: boolean;
  readonly at: string;
}

function stopOf(run: Run, config: FactoryConfig): Stop | null {
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
      const text =
        !finished && notStarted
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
    case 'gate-failed': {
      const rounds = run.events.filter((e) => e.event === 'gate-failed').length;
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
function progressOf(e: LedgerEvent, config: FactoryConfig): string {
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
    case 'proof-waiting':
      return `Mac proof waits: ${str(e['reason']) ?? 'the test VM'}`;
    case 'proof-recorded':
      return 'Proof recorded';
    case 'validated':
      return 'Validated against the plan';
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

function roundOf(run: Run, config: FactoryConfig): string | null {
  const red = run.events.findLast((e) => e.event === 'ci-red' || e.event === 'ci-repaired');
  if (red)
    return `CI repair ${num(red['repairs']) ?? num(red['round']) ?? 0} of ${config.rounds.ciRepair}`;
  const agent = run.events.findLast((e) => e.event === 'agent-started');
  if (agent) return `Agent round ${(num(agent['round']) ?? 0) + 1} of ${config.rounds.gateFix + 1}`;
  return null;
}

function runView(run: Run, config: FactoryConfig, isLast: boolean, live: boolean): RunView {
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

function priorityOf(item: BoardItem, config: FactoryConfig): number | null {
  if (item.priority) return item.priority;
  const spec = parseIssueSpec(item.labels, config);
  return spec.ok ? spec.spec.priority : null;
}

const NEED_LABEL: Readonly<Record<NeedKind, string>> = {
  answer: 'Answer the plan',
  review: 'Review the PR',
  unblock: 'Unblock',
  machine: 'Fix the Mac',
  card: 'Fix the card',
};

function need(kind: NeedKind, brief: string, what: string, command: string | null = null): Need {
  return { kind, label: NEED_LABEL[kind], brief, what, command };
}

/** A stop's first clause is the brief; the rest, if any, leads into what to do. */
function stopNeed(kind: 'unblock' | 'machine', text: string, then: string): Need {
  const [brief = text, ...rest] = text.split(/;\s*/);
  const more = rest.join('; ');
  const lead = more ? `${more[0]!.toUpperCase()}${more.slice(1)}. ` : '';
  return need(kind, brief, `${lead}${then}`, kind === 'machine' ? fixFor(text) : null);
}

const PROPOSED = /\s*\((?:proposed|recommended)\)\s*$/i;

/**
 * The plan's open points as the page asks them. The planner lists every point in `open`, and
 * those with a few clear answers again in `questions` (prompts/planning.md), so the same count
 * pairs them by position: the open point becomes its question's context. Otherwise a question
 * that repeats its point word for word pairs with it and the other points are asked without
 * buttons; when that doesn't account for every point, they're shown once, as notes.
 */
export function pointsOf(
  open: readonly string[],
  questions: readonly PlanQuestion[],
): { points: Point[]; notes: string[] } {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const ask = (q: PlanQuestion, context: string | null): Point => {
    const tagged = q.options.some((o) => PROPOSED.test(o));
    return {
      text: q.text,
      context: context && !same(context, q.text) ? context : null,
      // The proposal comes first (prompts/planning.md) when none is marked.
      options: q.options.map((o, i) => ({
        value: o,
        label: o.replace(PROPOSED, ''),
        proposed: tagged ? PROPOSED.test(o) : i === 0,
      })),
    };
  };
  if (questions.length && open.length === questions.length)
    return { points: questions.map((q, i) => ask(q, open[i] ?? null)), notes: [] };
  const rest = open.filter((o) => !questions.some((q) => same(o, q.text)));
  const asked = questions.map((q) => ask(q, null));
  if (rest.length + questions.length === open.length)
    return {
      points: [...asked, ...rest.map((o) => ({ text: o, context: null, options: [] }))],
      notes: [],
    };
  return { points: asked, notes: rest };
}

/** A command that fixes a machine problem the factory names, when there is one. */
function fixFor(text: string): string | null {
  if (/command not found|exit 127/i.test(text)) return 'task factory:install';
  if (/isn.t made|not made/i.test(text)) return 'task desktop:test:vm';
  if (/tart.*(missing|not found|isn.t installed)/i.test(text))
    return 'brew install cirruslabs/cli/tart';
  return null;
}

export function buildView(input: ViewInput): FactoryView {
  const { config, board, now } = input;
  const s = config.status;
  const all = parseLedger(input.ledger);
  const byIssue = new Map<number, LedgerEvent[]>();
  for (const e of all) {
    const n = issueOf(e);
    if (!Number.isInteger(n)) continue;
    const list = byIssue.get(n) ?? [];
    list.push(e);
    byIssue.set(n, list);
  }
  // A dead daemon runs nothing, whatever its last status.json says.
  const status = input.status && input.alive(input.status.pid) ? input.status : null;
  const running = new Map<number, Running>((status?.running ?? []).map((r) => [r.issue, r]));
  const merging = new Set(status?.merging ?? []);
  const doneSince = now.getTime() - config.ui.doneDays * 86_400_000;
  const picks = pickNext(board.items, config, new Set(running.keys()));
  const position = new Map(picks.queue.map((p, i) => [p.item.number, i + 1]));

  const cards: CardView[] = [];
  const outside: string[] = [];
  for (const item of board.items) {
    if (item.repo !== config.repo) continue;
    const events = byIssue.get(item.number) ?? [];
    const st = item.status ?? '';
    if (st === s.working || st === s.review) {
      // The factory's only if its ledger holds the claim: PEN-30's tasks were never given to it.
      if (!events.some((e) => e.event === 'claimed')) {
        outside.push(item.key);
        continue;
      }
    } else if (st === s.done) {
      // The merge step logs to the daemon's log, not the ledger, so a Done card counts by its
      // last ledger line (its review) when there's no `done` line.
      if (!events.some((e) => e.event === 'claimed')) continue;
      const doneAt = (events.findLast((e) => e.event === 'done') ?? events.at(-1))?.at;
      if (!doneAt || Date.parse(doneAt) < doneSince) continue;
    } else if (st !== s.pick && st !== s.planning) continue;
    cards.push(
      card(input, item, events, {
        live: running.get(item.number),
        merging: merging.has(item.number),
        queuePosition: position.get(item.number) ?? null,
      }),
    );
  }

  const order = { needs: 0, working: 1, queue: 2, done: 3 };
  const since = (c: CardView) => (c.since ? Date.parse(c.since) : now.getTime());
  cards.sort(
    (a, b) =>
      order[a.group] - order[b.group] ||
      (a.group === 'needs' ? since(a) - since(b) : 0) ||
      (a.group === 'queue'
        ? (a.queuePosition ?? 99) - (b.queuePosition ?? 99) || (a.priority ?? 3) - (b.priority ?? 3)
        : 0) ||
      (a.group === 'done' ? since(b) - since(a) : 0) ||
      b.stage - a.stage,
  );

  const windowMs = (input.windowHours ?? 12) * 3_600_000;
  const from = new Date(now.getTime() - windowMs);
  return {
    updatedAt: now.toISOString(),
    writable: input.writable ?? false,
    readOnly: input.writable ? null : (input.readOnly ?? 'Read-only'),
    health: health(input),
    stages: STAGES,
    needs: cards.filter((c) => c.group === 'needs'),
    cards,
    slots: config.slots.map((slot) => {
      const r = [...running.values()].find((x) => x.slot === slot.id);
      const it = r ? board.items.find((i) => i.number === r.issue) : undefined;
      return {
        slot: slot.id,
        issue: r?.issue ?? null,
        key: it?.key ?? (r ? `${r.issue}` : null),
        since: r?.startedAt ?? null,
        waitingFor: r?.waitingFor?.reason ?? null,
      };
    }),
    outside,
    timeline: timeline(input, byIssue, from, running),
    ...recent(input, byIssue, from),
  };
}

function health(input: ViewInput): Health {
  const { config, status, now } = input;
  const total = config.slots.length;
  const busy = status?.running.length ?? 0;
  const problems: { label: string; text: string; fix: string | null }[] = [];
  if (status?.code && input.codeDir && status.code.dir !== input.codeDir)
    problems.push({
      label: 'wrong checkout',
      text: `The daemon runs from ${status.code.dir}, not the factory's own clone`,
      fix: 'task factory:install',
    });
  const doctor = input.doctor ?? [];
  for (const d of doctor)
    if (d.failed.length)
      problems.push({
        label: `doctor failing on slot ${d.slot}`,
        text: `Doctor on slot ${d.slot} (${time(d.at)}) failed: ${d.failed.join('; ')}`,
        fix: `task factory:doctor -- --slot ${d.slot}`,
      });
  const doctorLine = doctor.length
    ? doctor.every((d) => d.failed.length === 0)
      ? `doctor passed ${time(
          doctor
            .map((d) => d.at)
            .sort()
            .at(-1)!,
        )}`
      : 'doctor failing'
    : null;
  const base = {
    pollSeconds: config.pollSeconds,
    slots: { total, busy },
    problems,
    doctor: doctorLine,
  };
  if (!status)
    return {
      ...base,
      state: 'missing',
      fresh: false,
      headline: 'No daemon status',
      detail: "The daemon hasn't written status.json: it has never run, or can't start.",
      fix: 'task factory:start',
      pid: null,
      updatedAt: null,
      ageSeconds: null,
      commit: null,
    };
  const age = Math.max(0, Math.round((now.getTime() - Date.parse(status.updatedAt)) / 1000));
  const known = {
    ...base,
    pid: status.pid,
    updatedAt: status.updatedAt,
    ageSeconds: age,
    commit: status.code?.commit ?? null,
  };
  const ago = minutes(age);
  if (!input.alive(status.pid))
    return {
      ...known,
      state: 'dead',
      fresh: false,
      headline: 'Daemon not running',
      detail: `pid ${status.pid} has exited. What follows is as of its last poll, ${ago} ago.`,
      fix: 'task factory:start',
    };
  if (age > config.pollSeconds * 3)
    return {
      ...known,
      state: 'stale',
      fresh: false,
      headline: 'Daemon not polling',
      detail: `pid ${status.pid} is alive but last polled ${ago} ago (every ${config.pollSeconds} s). What follows is as of then.`,
      fix: 'task factory:logs',
    };
  if (status.paused)
    return {
      ...known,
      state: 'paused',
      fresh: true,
      headline: 'Paused for an update',
      detail: 'task factory:update is waiting for the active runs to finish; nothing new starts.',
      fix: null,
    };
  return {
    ...known,
    state: 'running',
    fresh: true,
    headline: 'Running',
    detail: `pid ${status.pid} alive`,
    fix: null,
  };
}

function minutes(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function card(
  input: ViewInput,
  item: BoardItem,
  events: readonly LedgerEvent[],
  ctx: { live: Running | undefined; merging: boolean; queuePosition: number | null },
): CardView {
  const { config } = input;
  const s = config.status;
  const st = item.status ?? '';
  const plan = input.plans[item.number];
  // A planning card's live session, which Ryan can chat with.
  const chatting = st === s.planning && !!plan?.meta.sessionId && !plan.meta.agreed;
  const runs = runsOf(events);
  const lastRun = runs.at(-1);
  const views = runs.map((r, i) =>
    runView(r, config, i === runs.length - 1, !!ctx.live || ctx.merging),
  );
  const pr = (events.findLast((e) => str(e['pr']))?.['pr'] as string | undefined) ?? null;
  const spec = parseIssueSpec(item.labels, config);
  const set = hasBlockedSet(item);
  const heldBy = item.blockedBy ?? [];

  const links: Link[] = [{ label: item.key, href: item.url }];
  if (pr)
    links.push(
      { label: `PR #${pr.split('/').at(-1)}`, href: pr },
      { label: 'CI', href: `${pr}/checks` },
    );
  if (plan?.state?.planUrl) links.push({ label: 'Plan', href: plan.state.planUrl });
  if (plan?.state?.designUrl) links.push({ label: 'Design', href: plan.state.designUrl });

  // Where the card is.
  const progress = lastRun?.events.findLast((e) => !STOPS.has(e.event));
  let stage =
    st === s.pick
      ? 0
      : st === s.planning
        ? 1
        : st === s.done
          ? 8
          : st === s.review
            ? progress && (progress.event === 'merged' || progress.event === 'resumed')
              ? 7
              : 6
            : Math.max(2, Math.min(6, STAGE_OF[progress?.event ?? 'claimed'] ?? 2));
  if (ctx.merging) stage = 7;

  const stop = lastRun ? stopOf(lastRun, config) : null;
  const planning = st === s.planning;
  let tone: Tone;
  let step = '';
  let since: string | null = null;
  let needed: Need | null = null;
  let paused = false;
  let open: readonly string[] = [];
  let questions: readonly PlanQuestion[] = [];
  let asked: { points: Point[]; notes: string[] } = { points: [], notes: [] };

  if (planning && set && plan?.meta.askedAt) {
    open = plan.state?.open ?? [];
    questions = plan.state?.questions ?? [];
    asked = pointsOf(open, questions);
    const n = Math.max(open.length, questions.length);
    needed = need(
      'answer',
      n
        ? `Answer ${n} question${n === 1 ? '' : 's'} on the plan`
        : 'Answer the open points on the plan',
      'Pick an answer for each (the planner’s proposal is marked), add anything else below and send, or agree the plan as it stands. The chat and the issue work too.',
    );
    step = 'Open points posted';
    since = plan.meta.askedAt;
  } else if (set && !spec.ok && (st === s.pick || planning)) {
    needed = need('card', `Won't start: ${spec.error}`, 'Fix the labels in Linear, then unblock.');
    step = "Won't start: labels conflict";
  } else if (
    set &&
    stop &&
    !stop.paused &&
    st !== s.pick &&
    (st !== s.planning || runs.length > 0)
  ) {
    needed = stop.machine
      ? stopNeed('machine', stop.text, 'Fix it on the Mac, then retry.')
      : stopNeed('unblock', stop.text, 'Fix it or say how on the issue, then retry.');
    step = stop.text;
    since = stop.at;
  } else if (set && planning) {
    // Planning errors aren't in the ledger: the issue's last comment says whether it was the
    // factory or Ryan.
    needed = need(
      'unblock',
      'Planning is Blocked',
      'The factory stopped it on an error (its comment on the issue says why), or you paused it. Clear Blocked to resume the session.',
    );
    step = 'Planning Blocked';
  } else if (set) {
    paused = true;
    step = 'Paused by you';
    since = stop?.paused ? stop.at : null;
  } else if (!spec.ok && (st === s.pick || planning)) {
    needed = need('card', `Won't start: ${spec.error}`, 'Fix the labels in Linear.');
    step = "Won't start: labels conflict";
  } else if (heldBy.length) {
    step = `Held: blocked by ${heldBy.join(', ')}`;
  }
  if (heldBy.length && step && !step.startsWith('Held'))
    step = `${step}; also blocked by ${heldBy.join(', ')}`;

  // Not stopped: what it is doing.
  if (!step) {
    if (ctx.live?.waitingFor) {
      step = `Waiting: ${ctx.live.waitingFor.reason}`;
      since = ctx.live.waitingFor.since;
      if (!/busy|another run|queued/i.test(ctx.live.waitingFor.reason))
        needed = need(
          'machine',
          `Waiting: ${ctx.live.waitingFor.reason}`,
          `The run carries on by itself once that's fixed; it stops Blocked after ${config.macProof.waitHours} h.`,
          fixFor(ctx.live.waitingFor.reason),
        );
    } else if (ctx.live || ctx.merging) {
      const last = lastRun?.events.at(-1);
      step = last ? progressOf(last, config) : 'Claimed; starting the agent';
      since = ctx.live?.startedAt ?? last?.at ?? null;
    } else if (planning) {
      step = planningStep(plan, input.busySessions.has(item.number));
      since = plan?.meta.messagedAt ?? null;
    } else if (st === s.review) {
      step = 'Waiting for your review';
      since = progress?.at ?? null;
      if (pr)
        needed = need(
          'review',
          `Review PR #${pr.split('/').at(-1)}`,
          'Approve it on GitHub and the factory merges it and watches main; comment for another round.',
        );
    } else if (st === s.pick) {
      step =
        ctx.queuePosition === 1
          ? 'Next when a slot frees'
          : `In the queue (#${ctx.queuePosition ?? '?'})`;
      if (spec.ok) step += spec.spec.planSkip ? ' · plan:skip' : ' · plans first';
    } else if (st === s.done) {
      step = 'Done';
      since = (events.findLast((e) => e.event === 'done') ?? events.at(-1))?.at ?? null;
    } else {
      // Claimed, not live, not Blocked: an orphan the daemon restarts on its branch (R12).
      step = 'Stopped mid-run; the daemon restarts it on its branch';
      since = lastRun?.events.at(-1)?.at ?? null;
    }
  }

  if (needed) tone = needed.kind === 'unblock' ? 'stop' : needed.kind === 'card' ? 'card' : 'you';
  else if (st === s.done) tone = 'done';
  else if (paused || heldBy.length || st === s.pick) tone = 'idle';
  else tone = 'live';

  const group: CardView['group'] = needed
    ? 'needs'
    : st === s.done
      ? 'done'
      : st === s.pick || paused || (heldBy.length > 0 && !ctx.live)
        ? 'queue'
        : 'working';
  const liveRun = ctx.live && lastRun ? lastRun.id : null;
  const canComplete = planning && !!plan?.state?.planUrl && !plan.meta.agreed;
  return {
    number: item.number,
    key: item.key,
    title: item.title,
    url: item.url,
    status: st,
    stage,
    tone,
    step,
    since,
    need: needed,
    paused,
    blocked: set,
    heldBy,
    group,
    queuePosition: ctx.queuePosition,
    priority: priorityOf(item, config),
    agent: spec.ok ? spec.spec.agent : null,
    model: spec.ok ? spec.spec.modelAlias : null,
    slot: ctx.live?.slot ?? null,
    round: lastRun && st === s.working ? roundOf(lastRun, config) : null,
    pr,
    open,
    questions,
    points: asked.points,
    notes: asked.notes,
    canComplete,
    runs: views,
    runFolder: lastRun && input.runFolder ? input.runFolder(lastRun.id) : null,
    chat: chatting && plan.meta.sessionId ? attachCommand(plan.meta.sessionId) : null,
    chatUrl: chatting ? chatLink(plan.meta.chatUrl) : null,
    log: liveRun && input.logTail ? input.logTail(liveRun) : [],
    links,
  };
}

function planningStep(plan: PlanInfo | undefined, busy: boolean): string {
  if (!plan?.meta.sessionId) return 'Planning starts on the next poll';
  if (plan.meta.agreed)
    return plan.meta.agreed.trivial
      ? 'No plan needed; next when a slot frees'
      : 'Plan agreed; next when a slot frees';
  if (busy) return 'Planning session working';
  return 'Planning session idle';
}

function keyOf(input: ViewInput, issue: number): string {
  return (
    input.board.items.find((i) => i.number === issue)?.key ??
    (input.config.tracker === 'linear' ? `${input.config.linear.team}-${issue}` : `#${issue}`)
  );
}

function timeline(
  input: ViewInput,
  byIssue: ReadonlyMap<number, LedgerEvent[]>,
  from: Date,
  running: ReadonlyMap<number, Running>,
): FactoryView['timeline'] {
  const { config, now } = input;
  const lanes = config.slots.map((slot) => ({ slot: slot.id, bars: [] as TimelineBar[] }));
  for (const [issue, events] of byIssue) {
    const runs = runsOf(events);
    runs.forEach((run, i) => {
      const slot = num(run.events[0]?.['slot']);
      const lane = lanes.find((l) => l.slot === slot);
      if (!lane) return;
      const live = i === runs.length - 1 && running.get(issue)?.slot === slot;
      const v = runView(run, config, i === runs.length - 1, live);
      const end = v.endedAt ?? now.toISOString();
      if (Date.parse(end) < from.getTime()) return;
      const tone: Tone =
        v.outcome === 'running'
          ? running.get(issue)?.waitingFor
            ? 'you'
            : 'live'
          : v.outcome === 'in-review' || v.outcome === 'merged' || v.outcome === 'done'
            ? 'done'
            : v.outcome === 'interrupted' || v.outcome === 'paused'
              ? 'idle'
              : 'stop';
      lane.bars.push({
        issue,
        key: keyOf(input, issue),
        run: run.id,
        start: v.startedAt,
        end,
        tone,
        label: v.summary,
      });
    });
  }
  for (const lane of lanes) lane.bars.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { from: from.toISOString(), to: now.toISOString(), lanes };
}

function recent(
  input: ViewInput,
  byIssue: ReadonlyMap<number, LedgerEvent[]>,
  from: Date,
): Pick<FactoryView, 'outcomes' | 'totals'> {
  const { config } = input;
  const outcomes: Outcome[] = [];
  const totals = { started: 0, inReview: 0, merged: 0, blocked: 0 };
  for (const [issue, events] of byIssue) {
    const key = keyOf(input, issue);
    const runs = runsOf(events);
    runs.forEach((run, i) => {
      for (const e of run.events) {
        if (Date.parse(e.at) < from.getTime()) continue;
        const push = (what: string, detail: string, tone: Tone) =>
          outcomes.push({ at: e.at, issue, key, what, detail, tone });
        if (e.event === 'claimed' && !str(e['phase'])) {
          totals.started++;
          if (i > 0) push('Restarted', `run ${i + 1} on slot ${num(e['slot']) ?? '?'}`, 'live');
        } else if (e.event === 'in-review') {
          totals.inReview++;
          const pr = str(e['pr']);
          push('Reached review', pr ? `PR #${pr.split('/').at(-1)}` : '', 'done');
        } else if (e.event === 'merged') {
          totals.merged++;
          push('Merged', str(e['pr']) ? `PR #${String(e['pr']).split('/').at(-1)}` : '', 'done');
        } else if (e.event === 'done') push('Done', 'main verified', 'done');
      }
      const stop = stopOf(run, config);
      const at = run.events.at(-1)!.at;
      if (stop && !stop.paused && Date.parse(at) >= from.getTime()) {
        totals.blocked++;
        outcomes.push({
          at,
          issue,
          key,
          what: run.events.at(-1)!.event === 'failed' ? 'Failed' : 'Blocked',
          detail: stop.text,
          tone: 'stop',
        });
      }
    });
  }
  outcomes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { outcomes: outcomes.slice(0, 40), totals };
}
