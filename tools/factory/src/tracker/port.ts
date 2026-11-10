/**
 * The tracker port (LD1): everything the factory reads or writes about its cards, whether they
 * live in GitHub's Project 8 or Linear's Penmoss team. Pull requests, CI and merges stay on
 * GitHub and outside this port. A card is identified by its number in the active tracker
 * (GitHub #36, Linear PEN-36); `issueKey` turns it into the name people see.
 *
 * There is deliberately no way to clear Blocked here: only Ryan clears it (R23), and the Factory
 * UI does that as him through `OwnerTracker`.
 */
import type { FactoryConfig, TrackerName } from '../config.ts';
import type { Issue } from '../issue.ts';
import type { Priority } from '../labels.ts';
import type { Downloaded } from './linear-client.ts';

export interface BoardItem {
  /** The tracker's own ID for the card: Project 8's item node ID, or the Linear issue's UUID. */
  readonly itemId: string;
  readonly number: number;
  /** What people call it: `#36` or `PEN-36`. */
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly repo: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly author: string;
  /** Labels as the factory reads them; a Linear label in a group is `group:name` (`agent:claude`). */
  readonly labels: readonly string[];
  readonly status: string | null;
  readonly blocked: boolean;
  /** Unfinished issues this one is blocked by (Linear relations, LD8); they keep it Blocked too. */
  readonly blockedBy?: readonly string[];
  /**
   * Whether Blocked itself (the label, or Project 8's field) is set, which only Ryan clears; false
   * when `blockedBy` alone holds the card. Absent means the same as `blocked`.
   */
  readonly blockedSet?: boolean;
  /** The tracker's own priority (Linear, LD11); GitHub's comes from P1–P4 labels instead. */
  readonly priority?: Priority;
  /** Linear's "No priority", which `priority` counts as Medium; `factory:next` says which. */
  readonly noPriority?: boolean;
  /** Position on the board, 0 first. */
  readonly position: number;
}

export interface Board {
  readonly items: readonly BoardItem[];
}

export interface Tracker {
  readonly name: TrackerName;
  /** The author value whose words count as instructions (R14): Ryan's login or Linear user ID. */
  readonly owner: string;
  readBoard(): Promise<Board>;
  readIssue(issue: number): Promise<Issue>;
  /** Whether the card is Blocked (or canceled, or gone) right now: checked before every side effect (R23). */
  isBlocked(issue: number): Promise<boolean>;
  comment(issue: number, body: string): Promise<void>;
  setStatus(item: BoardItem, status: string): Promise<void>;
  /** Sets Blocked. The factory can only set it, never clear it (R23). */
  setBlocked(item: BoardItem): Promise<void>;
  /** After main is verified (R20): GitHub closes the issue with this comment; Linear comments. */
  closeIssue(issue: number, body: string): Promise<void>;
  /**
   * A file attached to an issue, downloaded on the host with the tracker's own credentials, so
   * an agent can read the issue's images without a token (attachments.ts). Linear only.
   */
  download?(url: string, maxBytes: number): Promise<Downloaded>;
}

/** Ryan's own tracker access, for the Factory UI alone (F21): it may also clear Blocked. */
export interface OwnerTracker extends Tracker {
  clearBlocked(item: BoardItem): Promise<void>;
}

/** Whether Blocked itself is set on the card, not only an unfinished blocker (LD8). */
export function hasBlockedSet(item: BoardItem): boolean {
  return item.blocked && (item.blockedSet ?? true);
}

/** The card's name: `#36` on GitHub, `PEN-36` on Linear. */
export function issueKey(config: FactoryConfig, issue: number): string {
  return config.tracker === 'linear' ? `${config.linear.team}-${issue}` : `#${issue}`;
}

/** The line a PR body uses to name its card without closing it (R20, LD6). */
export function partOfLine(config: FactoryConfig, issue: number): string {
  return `Part of ${issueKey(config, issue)}.`;
}
