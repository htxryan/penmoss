/**
 * The Factory UI's view (F20, #276): every card the factory handles, in its status column, with
 * the step it's on and its links; Blocked cards in a Waiting on you lane with the reason. Built
 * from the board, the run ledger, the planning folders and `claude agents`, all read-only.
 */
import type { Board, BoardItem } from '../board.ts';
import type { FactoryConfig } from '../config.ts';
import type { PlanMeta } from '../planning-host.ts';
import type { PlanQuestion, PlanState } from '../planning.ts';

export interface Link {
  readonly label: string;
  readonly href: string;
}

export interface CardView {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  /** What the factory is doing (or did last) on the card. */
  readonly step: string;
  /** When that step began. */
  readonly since: string | null;
  /** For a Blocked card: why, from the factory's last word on it, and what's open. */
  readonly reason: string | null;
  readonly open: readonly string[];
  /** Planning questions with one-click answers (F21). */
  readonly questions: readonly PlanQuestion[];
  /** Whether "Complete" applies: a plan exists and isn't agreed yet. */
  readonly canComplete: boolean;
  readonly blocked: boolean;
  readonly links: readonly Link[];
}

export interface FactoryView {
  readonly updatedAt: string;
  /** Whether the page may write (F21): the UI found Ryan's own gh login. */
  readonly writable: boolean;
  readonly daemon: {
    readonly pid: number;
    readonly updatedAt: string;
    readonly stale: boolean;
  } | null;
  readonly waiting: readonly CardView[];
  readonly columns: readonly { readonly name: string; readonly cards: readonly CardView[] }[];
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
  readonly daemon: { readonly pid: number; readonly updatedAt: string } | null;
  readonly now: Date;
  readonly writable?: boolean;
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

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** A ledger event in words. */
export function describeEvent(e: LedgerEvent): string {
  switch (e.event) {
    case 'claimed':
      return e['phase'] === 'revise' ? 'Review round started' : 'Claimed';
    case 'agent-started':
      return `Agent working (round ${typeof e['round'] === 'number' ? e['round'] : 1})`;
    case 'agent-finished':
      return 'Agent finished; checking its work';
    case 'needs-info':
      return 'The agent has questions';
    case 'gate-failed':
      return 'Checks failed; the agent is fixing them';
    case 'gate-passed':
      return 'Checks passed; recording proof';
    case 'proof-recorded':
      return 'Proof recorded';
    case 'decisions-numbered':
      return 'Numbering decisions';
    case 'pushed':
      return 'Pushed';
    case 'pr-opened':
      return 'Pull request open; CI running';
    case 'ci-red':
      return 'CI red; repairing';
    case 'ci-repaired':
      return 'CI repaired; waiting for green';
    case 'ci-stalled':
      return 'CI waiting for a runner';
    case 'in-review':
      return 'Waiting for your review';
    case 'merged':
      return 'Merged; watching main';
    case 'done':
      return 'Done';
    case 'usage-limited':
      return `Usage limit: waiting until ${typeof e['until'] === 'string' ? new Date(e['until']).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'the reset'}`;
    case 'blocked':
      return 'Blocked';
    case 'failed':
      return 'Stopped';
    default:
      return e.event;
  }
}

/** Why the factory last stopped on the card, in its own words. */
function reasonOf(e: LedgerEvent | undefined): string | null {
  if (!e) return null;
  if (e.event === 'blocked') return str(e['reason']) ?? 'Blocked';
  if (e.event === 'failed') return str(e['error']) ?? str(e['stopped']) ?? str(e['summary']);
  if (e.event === 'needs-info') return 'The agent has questions on the issue';
  return null;
}

/** The desktop app's link for a claude.ai session URL. */
export function desktopLink(chatUrl: string): string | null {
  const m = /^https:\/\/claude\.ai\/(code\/session_[A-Za-z0-9_-]+)$/.exec(chatUrl);
  return m ? `claude://claude.ai/${m[1]}` : null;
}

function planningStep(plan: PlanInfo | undefined, busy: boolean): string {
  if (!plan?.meta.sessionId) return 'Planning starts on the next poll';
  if (plan.meta.agreed)
    return plan.meta.agreed.trivial
      ? 'No plan needed; waiting for a slot'
      : 'Plan agreed; waiting for a slot';
  if (busy) return 'Planning session working';
  if (plan.meta.askedAt) return 'Open points posted';
  return 'Planning session idle';
}

export function buildView(input: ViewInput): FactoryView {
  const { config, board, now } = input;
  const byIssue = new Map<number, LedgerEvent[]>();
  for (const e of parseLedger(input.ledger)) {
    const n = issueOf(e);
    if (!Number.isInteger(n)) continue;
    const list = byIssue.get(n) ?? [];
    list.push(e);
    byIssue.set(n, list);
  }
  const s = config.status;
  const order = [s.pick, s.planning, s.working, s.review, s.done];
  const doneSince = now.getTime() - config.ui.doneDays * 86_400_000;

  const cards: CardView[] = [];
  for (const item of board.items) {
    if (item.repo !== config.repo || !order.includes(item.status ?? '')) continue;
    const events = byIssue.get(item.number) ?? [];
    const last = events.at(-1);
    if (item.status === s.done) {
      const doneAt = events.findLast((e) => e.event === 'done')?.at;
      if (!doneAt || Date.parse(doneAt) < doneSince) continue;
    }
    cards.push(card(input, item, events, last));
  }

  const waiting = cards.filter((c) => c.reason !== null);
  const columns = order.map((name) => ({
    name,
    cards: cards.filter((c) => c.status === name && c.reason === null),
  }));
  const daemon = input.daemon
    ? {
        ...input.daemon,
        // Three missed polls: the daemon has stopped or hung.
        stale: now.getTime() - Date.parse(input.daemon.updatedAt) > config.pollSeconds * 3000,
      }
    : null;
  return {
    updatedAt: now.toISOString(),
    writable: input.writable ?? false,
    daemon,
    waiting,
    columns,
  };
}

function card(
  input: ViewInput,
  item: BoardItem,
  events: readonly LedgerEvent[],
  last: LedgerEvent | undefined,
): CardView {
  const { config } = input;
  const plan = input.plans[item.number];
  const pr = events.findLast((e) => str(e['pr']))?.['pr'] as string | undefined;
  const links: Link[] = [{ label: `#${item.number}`, href: item.url }];
  if (pr) links.push({ label: 'Pull request', href: pr }, { label: 'CI', href: `${pr}/checks` });
  if (plan?.state?.planUrl) links.push({ label: 'Plan', href: plan.state.planUrl });
  if (plan?.state?.designUrl) links.push({ label: 'Design', href: plan.state.designUrl });
  if (plan?.meta.chatUrl) {
    links.push({ label: 'Chat', href: plan.meta.chatUrl });
    const desktop = desktopLink(plan.meta.chatUrl);
    if (desktop) links.push({ label: 'Open in Claude', href: desktop });
  }

  const planning = item.status === config.status.planning || (!!plan && !last);
  // The step the run reached: a stop is the reason, not the step.
  const progress = events.findLast((e) => e.event !== 'blocked' && e.event !== 'failed') ?? last;
  let step = planning
    ? planningStep(plan, input.busySessions.has(item.number))
    : progress
      ? describeEvent(progress)
      : item.status === config.status.pick
        ? 'Waiting for a slot'
        : 'Not started by the factory';
  let since = planning ? (plan?.meta.messagedAt ?? null) : (last?.at ?? null);
  let reason: string | null = null;
  let open: readonly string[] = [];
  let questions: readonly PlanQuestion[] = [];
  if (item.blocked) {
    // Planning's open points, or the run's last word; otherwise Ryan set it himself.
    if (planning && plan?.meta.askedAt) {
      reason = 'The plan has open points';
      open = plan.state?.open ?? [];
      questions = plan.state?.questions ?? [];
      since = plan.meta.askedAt;
    } else {
      reason = reasonOf(last) ?? 'You set Blocked';
    }
    step = `Paused: ${step}`;
  }
  const canComplete = planning && !!plan?.state?.planUrl && !plan.meta.agreed;
  return {
    number: item.number,
    title: item.title,
    status: item.status ?? '',
    step,
    since,
    reason,
    open,
    questions,
    canComplete,
    blocked: item.blocked,
    links,
  };
}
