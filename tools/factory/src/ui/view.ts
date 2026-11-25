/**
 * The Factory UI's view as the page reads it (F20, A1233): the factory's health, the cards on the
 * lifecycle with what each needs from Ryan, the slots, the timeline and the outcomes. `buildView`
 * (model.ts) makes it.
 */
import type { Board } from '../board.ts';
import type { FactoryConfig } from '../config.ts';
import type { PlanMeta } from '../planning-host.ts';
import type { PlanQuestion, PlanState } from '../planning.ts';
import type { DoctorSummary } from '../doctor-summary.ts';
import type { DaemonStatus } from '../status.ts';

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

interface PointOption {
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
  /**
   * The planning session's chat on claude.ai, which Remote Control serves (A1286), or the
   * running agent session's (A1287).
   */
  readonly chatUrl: string | null;
  /** The last lines of the current run's agent log, for a card in a slot. */
  readonly log: readonly string[];
  readonly links: readonly Link[];
}

type HealthState = 'running' | 'paused' | 'stale' | 'dead' | 'missing';

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

interface SlotView {
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
  /** The running session's chat link, while it runs (host-agent.ts writes agent-stream.ts's CHAT_URL file). */
  readonly runChat?: (run: string) => string | undefined;
  /** Where a run's folder is. */
  readonly runFolder?: (run: string) => string;
  readonly writable?: boolean;
  readonly readOnly?: string | null;
  /** How far back the timeline and outcomes reach (default 12 h). */
  readonly windowHours?: number;
}
