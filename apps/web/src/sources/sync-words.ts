/**
 * Words for a git notebook's sync in Settings (PEN-146): the cadence as menus in words ("After
 * 12 Seconds", "Every 2 Minutes") instead of number fields, and how long ago it last synced.
 * Main still takes any whole number in its range (5 s to an hour, 1 minute to a day, A825): a
 * value set before, or by hand, that is not one of the menu's is kept as an extra choice.
 */
import type { GitSyncStatus } from './engine-host';

export interface CadenceChoice {
  readonly value: number;
  readonly label: string;
}

/** Push Changes: seconds after edits settle (12 by default). */
export const PUSH_CHOICES: readonly number[] = [5, 12, 30, 60, 120, 300, 600];
/** Pull Changes: minutes between pulls in the foreground (1 by default). */
export const PULL_CHOICES: readonly number[] = [1, 2, 5, 10, 15, 30, 60];

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** "12 Seconds", "1 Minute", "2 Minutes", "1 Hour". */
function span(seconds: number): string {
  if (seconds % 3600 === 0) return plural(seconds / 3600, 'Hour');
  if (seconds % 60 === 0) return plural(seconds / 60, 'Minute');
  return plural(seconds, 'Second');
}

/** "After 12 Seconds", "After 1 Minute". */
export const pushWords = (seconds: number): string => `After ${span(seconds)}`;

/** "Every Minute", "Every 2 Minutes", "Every Hour". */
export function pullWords(minutes: number): string {
  if (minutes === 1) return 'Every Minute';
  if (minutes === 60) return 'Every Hour';
  return `Every ${span(minutes * 60)}`;
}

/** The menu's choices, with the current value among them even when it is not a usual one. */
function choices(
  usual: readonly number[],
  current: number,
  words: (value: number) => string,
): readonly CadenceChoice[] {
  const values = usual.includes(current) ? usual : [...usual, current].sort((a, b) => a - b);
  return values.map((value) => ({ value, label: words(value) }));
}

export const pushChoices = (current: number) => choices(PUSH_CHOICES, current, pushWords);
export const pullChoices = (current: number) => choices(PULL_CHOICES, current, pullWords);

export const PHASE_WORDS: Record<GitSyncStatus['phase'], string> = {
  starting: 'Starting',
  syncing: 'Syncing',
  synced: 'Synced',
  offline: 'Offline',
  stopped: 'Sync Stopped',
};

/** "just now", "2 min ago", "3 h ago", or the day for anything older than a day. */
export function agoWords(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at);
}

/** The dot's state, as the sidebar and the Settings nav show it: fine, at work, or stopped. */
export type DotState = 'ok' | 'syncing' | 'offline' | 'error';

export function dotState(status: Pick<GitSyncStatus, 'phase'>): DotState {
  switch (status.phase) {
    case 'synced':
      return 'ok';
    case 'starting':
    case 'syncing':
      return 'syncing';
    case 'offline':
      return 'offline';
    case 'stopped':
      return 'error';
  }
}

/**
 * A notebook's state in one short line, for its row in All Notebooks and its page's header:
 * "Synced 2 min ago", "Syncing", "Sync Stopped", "Pushing…".
 */
export function syncLine(
  status: Pick<GitSyncStatus, 'phase' | 'lastSyncAt' | 'closing'>,
  now = Date.now(),
): string {
  if (status.closing) return 'Pushing…';
  if (status.phase === 'synced' && status.lastSyncAt !== null) {
    return `Synced ${agoWords(status.lastSyncAt, now)}`;
  }
  return PHASE_WORDS[status.phase];
}
