/** What the Notebooks settings pages (GitNotebooksSettings.tsx) and their tabs share. */

export const when = (at: number | null) =>
  at === null
    ? 'never'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);

/** How often "Synced 2 min ago" is worked out again. */
export const TICK_MS = 30_000;

export const ALL_OTHERS = '*';

export type Answer = <T>(
  run: () => Promise<
    { ok: true; value: T } | { ok: false; error: { message: string; hostMessage?: string } } | null
  >,
  done: (value: T) => string,
) => Promise<void>;
