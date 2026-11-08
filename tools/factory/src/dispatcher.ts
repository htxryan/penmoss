/**
 * The dispatcher (F10, #274): every `pollSeconds`, read the board, recover orphaned runs, and
 * start the next Ready cards in free slots, at most `maxConcurrent` at once (R3). It never acts on
 * a card with Blocked set (R23). Pure scheduling: what a run does is `startRun`'s business.
 */
import type { Board, BoardItem } from './board.ts';
import type { FactoryConfig, SlotConfig } from './config.ts';
import { parseIssueSpec } from './labels.ts';
import { pickNext, type Pick } from './pick.ts';

export interface Running {
  readonly issue: number;
  readonly slot: number;
  readonly startedAt: string;
  readonly why: 'picked' | 'recovered';
  /** What the run is waiting for (the test VM, F10), and since when; `factory:status` says. */
  readonly waitingFor?: { readonly reason: string; readonly since: string };
}

export interface Tick {
  readonly start: readonly {
    readonly item: BoardItem;
    readonly slot: SlotConfig;
    readonly why: Running['why'];
    readonly pick?: Pick;
  }[];
  /** Ready cards that can start but have no free slot. */
  readonly waiting: readonly number[];
  /** Cards whose planning the daemon advances this tick: it takes no slot. */
  readonly plan: readonly BoardItem[];
  readonly skipped: readonly { readonly issue: number; readonly reason: string }[];
}

/**
 * In progress cards the factory claimed (a marker comment) but no live run holds: the daemon
 * died mid-run (R12). They are restarted on the same branch, ahead of new Ready cards.
 */
export function orphans(
  board: Board,
  config: FactoryConfig,
  running: readonly Running[],
  claimed: ReadonlySet<number>,
): BoardItem[] {
  const live = new Set(running.map((r) => r.issue));
  return board.items.filter(
    (i) =>
      i.status === config.status.working &&
      i.state === 'OPEN' &&
      !i.blocked &&
      claimed.has(i.number) &&
      !live.has(i.number),
  );
}

/**
 * Cards the factory would pick up whose labels conflict (a `model:` of the other agent, two
 * `agent:` labels): the daemon says why on the issue and sets Blocked, once (F12).
 */
export function labelProblems(
  board: Board,
  config: FactoryConfig,
): { readonly item: BoardItem; readonly error: string }[] {
  const statuses = [config.status.pick, config.status.planning];
  return board.items.flatMap((item) => {
    if (
      !statuses.includes(item.status ?? '') ||
      item.blocked ||
      item.state !== 'OPEN' ||
      item.repo !== config.repo
    )
      return [];
    const parsed = parseIssueSpec(item.labels, config);
    return parsed.ok ? [] : [{ item, error: parsed.error }];
  });
}

export function tick(
  board: Board,
  config: FactoryConfig,
  running: readonly Running[],
  claimed: ReadonlySet<number>,
  /** Planning cards whose plan is agreed: they implement next, ahead of new Ready cards. */
  agreed: ReadonlySet<number> = new Set(),
): Tick {
  const busy = new Set(running.map((r) => r.slot));
  const free = config.slots.filter((s) => !busy.has(s.id));
  const room = Math.max(0, Math.min(free.length, config.maxConcurrent - running.length));
  const start: Tick['start'][number][] = [];
  const skipped: { issue: number; reason: string }[] = [];

  for (const item of orphans(board, config, running, claimed)) {
    const parsed = parseIssueSpec(item.labels, config);
    if (!parsed.ok) {
      skipped.push({ issue: item.number, reason: parsed.error });
      continue;
    }
    if (start.length < room) start.push({ item, slot: free[start.length]!, why: 'recovered' });
  }
  const live = new Set(running.map((r) => r.issue));
  const waiting: number[] = [];
  const plan: BoardItem[] = [];
  for (const item of board.items) {
    if (
      item.status !== config.status.planning ||
      item.state !== 'OPEN' ||
      item.blocked ||
      item.repo !== config.repo ||
      live.has(item.number)
    )
      continue;
    if (!agreed.has(item.number)) plan.push(item);
    else if (start.length < room) start.push({ item, slot: free[start.length]!, why: 'picked' });
    else waiting.push(item.number);
  }
  const picked = pickNext(board.items, config, live);
  for (const s of picked.skipped) skipped.push({ issue: s.item.number, reason: s.reason });
  for (const pick of picked.queue) {
    // A Ready card that needs a plan starts planning, which takes no slot.
    if (pick.mode === 'plan') {
      plan.push(pick.item);
      continue;
    }
    if (start.length < room)
      start.push({ item: pick.item, slot: free[start.length]!, why: 'picked', pick });
    else waiting.push(pick.item.number);
  }
  return { start, waiting, skipped, plan };
}
