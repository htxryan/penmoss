/**
 * Agent Activity across notebooks (PEN-146): each notebook's list (A920, read from its branch)
 * merged into one, newest first, and the filters for a notebook and an agent.
 */
import type { ActivityEntry } from '../agents/activity';

/** One change, with the notebook it was made in. */
export interface NotebookActivity {
  readonly notebookId: string;
  readonly notebook: string;
  readonly entry: ActivityEntry;
}

/** A filter's choice that keeps every notebook, or every agent. */
export const EVERY = '*';

/** Every notebook's changes in one list, newest first (ties: the notebooks' order, then id). */
export function mergeActivity(
  lists: ReadonlyArray<{
    readonly notebookId: string;
    readonly notebook: string;
    readonly entries: readonly ActivityEntry[];
  }>,
): NotebookActivity[] {
  return lists
    .flatMap((list, at) =>
      list.entries.map((entry) => ({
        at,
        item: { notebookId: list.notebookId, notebook: list.notebook, entry },
      })),
    )
    .sort(
      (a, b) =>
        b.item.entry.at - a.item.entry.at || a.at - b.at || b.item.entry.id - a.item.entry.id,
    )
    .map(({ item }) => item);
}

/** The agents that made the changes, by label, in order of their latest change. */
export function activityAgents(items: readonly NotebookActivity[]): string[] {
  return [...new Set(items.map((item) => item.entry.actor.label))];
}

/** The changes a filter keeps: one notebook, one agent, or every one. */
export function filterActivity(
  items: readonly NotebookActivity[],
  notebook: string,
  agent: string,
): NotebookActivity[] {
  return items.filter(
    (item) =>
      (notebook === EVERY || item.notebookId === notebook) &&
      (agent === EVERY || item.entry.actor.label === agent),
  );
}
