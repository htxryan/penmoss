/**
 * Which card the dispatcher starts next, and what a card's run does. Pure
 * functions over the board, so `factory:next` and the dispatcher agree and
 * tests need no GitHub.
 */
import type { BoardItem } from './board.ts';
import type { FactoryConfig } from './config.ts';
import { parseIssueSpec, type IssueSpec } from './labels.ts';

/**
 * - `plan`: run (or resume) the planning conversation.
 * - `implement`: build the agreed plan on a branch and open the PR.
 * - `revise`: address CI failures and review comments on the open PR.
 */
export type Mode = 'plan' | 'implement' | 'revise';

/** The hidden marker on the factory's issue comments: `<!-- penmoss-factory run=… agent=… -->`. */
export interface Marker {
  readonly fields: Readonly<Record<string, string>>;
}

/** The hidden form, and the visible code line Linear's comments carry instead (LD5). */
const MARKER = /<!--\s*penmoss-factory\s+([^>]*?)\s*-->|`penmoss-factory\s+([^`\n]*?)\s*`/g;

export function parseMarkers(body: string): Marker[] {
  return [...body.matchAll(MARKER)].map((m) => ({
    fields: Object.fromEntries(
      (m[1] ?? m[2] ?? '')
        .split(/\s+/)
        .map((pair) => pair.split('='))
        .filter(
          (kv): kv is [string, string] => kv.length === 2 && kv[0] !== '' && kv[1] !== undefined,
        ),
    ),
  }));
}

export function formatMarker(fields: Readonly<Record<string, string>>): string {
  return `<!-- penmoss-factory ${Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')} -->`;
}

export interface ModeInput {
  readonly status: string | null;
  readonly spec: IssueSpec;
  /** Markers from the factory's own comments on the issue, oldest first. */
  readonly markers: readonly Marker[];
  /** Whether the issue has an open PR from the factory's branch. */
  readonly hasOpenPr: boolean;
}

/**
 * What a run on this card does, or `null` when the factory has nothing to do
 * (Done, Backlog, Triage and the like). Blocked is checked by the caller, before this.
 */
export function modeFor(input: ModeInput, config: FactoryConfig): Mode | null {
  const { status } = input;
  const planApproved = input.markers.some((m) => m.fields['event'] === 'plan-approved');
  if (status === config.status.pick) return input.spec.planSkip ? 'implement' : 'plan';
  if (status === config.status.planning)
    return planApproved || input.spec.planSkip ? 'implement' : 'plan';
  if (status === config.status.working) return 'implement';
  if (status === config.status.review) return input.hasOpenPr ? 'revise' : 'implement';
  return null;
}

export type Skip = { readonly item: BoardItem; readonly reason: string };

export interface Pick {
  readonly item: BoardItem;
  readonly spec: IssueSpec;
  readonly mode: Mode;
  readonly why: string;
}

export interface PickResult {
  /** `null` when nothing in Ready can start. */
  readonly next: Pick | null;
  /** Ready cards passed over, with why: blocked, already running, bad labels. */
  readonly skipped: readonly Skip[];
  /** Ready cards that can start, in pickup order (the first is `next`). */
  readonly queue: readonly Pick[];
}

/**
 * The Ready card to start next: P1 first, then board position. Blocked cards,
 * closed issues, other repositories' issues and cards already running are
 * passed over, and so are cards whose labels conflict.
 */
export function pickNext(
  items: readonly BoardItem[],
  config: FactoryConfig,
  running: ReadonlySet<number> = new Set(),
): PickResult {
  const skipped: Skip[] = [];
  const queue: Pick[] = [];
  for (const item of items) {
    if (item.status !== config.status.pick) continue;
    if (item.repo !== config.repo) {
      skipped.push({ item, reason: `in ${item.repo}, not ${config.repo}` });
    } else if (item.state !== 'OPEN') {
      skipped.push({ item, reason: 'the issue is closed' });
    } else if (item.blocked) {
      skipped.push({
        item,
        reason: item.blockedBy?.length
          ? `blocked by ${item.blockedBy.join(', ')}`
          : `${config.blockedField} is set`,
      });
    } else if (running.has(item.number)) {
      skipped.push({ item, reason: 'already running' });
    } else {
      const parsed = parseIssueSpec(item.labels, config);
      if (!parsed.ok) {
        skipped.push({ item, reason: parsed.error });
      } else {
        const mode = parsed.spec.planSkip ? 'implement' : 'plan';
        // Linear's own priority field wins over P labels (LD11).
        const spec = item.priority ? { ...parsed.spec, priority: item.priority } : parsed.spec;
        queue.push({ item, spec, mode, why: '' });
      }
    }
  }
  queue.sort((a, b) => a.spec.priority - b.spec.priority || a.item.position - b.item.position);
  const withWhy = queue.map((p, i) => ({ ...p, why: explain(p, queue, i, config) }));
  return { next: withWhy[0] ?? null, skipped, queue: withWhy };
}

/**
 * One line for `factory:next` when nothing in the pick status can start: the cards in Planning
 * (each marked when it is blocked) and the blocked cards further on, by status, so "Nothing in
 * Todo can start" doesn't read as an empty board. `undefined` when there are none.
 */
export function elsewhere(items: readonly BoardItem[], config: FactoryConfig): string | undefined {
  const { planning, working, review } = config.status;
  const parts: string[] = [];
  for (const status of [planning, working, review]) {
    const here = items.filter(
      (i) => i.status === status && i.repo === config.repo && i.state === 'OPEN',
    );
    const shown = status === planning ? here : here.filter((i) => i.blocked);
    if (shown.length === 0) continue;
    const keys = shown.map((i) => (status === planning && i.blocked ? `${i.key} blocked` : i.key));
    parts.push(
      `${shown.length} ${status === planning ? 'in' : 'blocked in'} ${status} (${keys.join(', ')})`,
    );
  }
  return parts.length > 0 ? `Elsewhere: ${parts.join('; ')}.` : undefined;
}

const LINEAR_PRIORITY = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' } as const;

/**
 * A pick's priority as its tracker names it: Linear's (`Urgent` … `Low`, and `no priority
 * (Medium)` for a card that has none), or Project 8's `P1`–`P4` label (`no P label (P3)`).
 */
export function priorityName(pick: Pick, config: FactoryConfig): string {
  const p = pick.spec.priority;
  if (config.tracker === 'linear')
    return pick.item.noPriority ? 'no priority (Medium)' : LINEAR_PRIORITY[p];
  return pick.item.labels.some((l) => /^P[1-4]$/.test(l)) ? `P${p}` : `no P label (P${p})`;
}

/** The bucket a priority names, for "above 2 other … cards": `Medium` for none on Linear. */
function bucket(pick: Pick, config: FactoryConfig): string {
  return config.tracker === 'linear'
    ? LINEAR_PRIORITY[pick.spec.priority]
    : `P${pick.spec.priority}`;
}

function explain(pick: Pick, queue: readonly Pick[], index: number, config: FactoryConfig): string {
  const ahead = queue.slice(index + 1);
  const lowerPriority = ahead.filter((p) => p.spec.priority > pick.spec.priority).length;
  const later = ahead.length - lowerPriority;
  const parts = [priorityName(pick, config)];
  if (lowerPriority > 0)
    parts.push(`ahead of ${lowerPriority} lower-priority card${lowerPriority === 1 ? '' : 's'}`);
  if (later > 0)
    parts.push(
      `above ${later} other ${bucket(pick, config)} card${later === 1 ? '' : 's'} on the board`,
    );
  if (ahead.length === 0)
    parts.push(
      index === 0 ? `the only card in ${config.status.pick} that can start` : 'last in the queue',
    );
  return parts.join(', ');
}
