/**
 * The note just moved to Trash, for the toast that offers Undo (T39 pass 2, A524). Moving
 * the open note to Trash closes it, so the toast lives with the app, not the note view.
 */
import { cleanTitle, isolatedTitle } from '@penmoss/core/titles';
import { useSyncExternalStore } from 'react';
import type { Notes } from '../notes/service';

export interface Trashed {
  /** The notes moved, one or several (the tree's context menu, T42, A570). */
  readonly notes: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /**
   * The move to Trash under way: Undo waits for it, so the restore cannot be overtaken. From
   * `trashAll`, it resolves to the notes that reached Trash.
   */
  readonly done: Promise<unknown>;
  /**
   * The notes service that moved them, the one Undo restores in (A826): the toast outlives the
   * note's view and shows over whichever note is open next, maybe in another source.
   */
  readonly from: Notes;
}

/** How long the toast stays once it is neither pointed at nor focused. */
export const TRASHED_MS = 8000;

export class TrashedNote {
  private current: Trashed | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): Trashed | null => this.current;

  set(next: Trashed | null): void {
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const trashedNote = new TrashedNote();

export function useTrashedNote(): Trashed | null {
  return useSyncExternalStore(trashedNote.subscribe, trashedNote.get, trashedNote.get);
}

/** The toast's words: `Moved “Garden plan” to Trash`, or `Moved 3 notes to Trash`. */
export function trashedText(titles: readonly string[]): string {
  return titles.length === 1
    ? `Moved “${trashedTitle(titles[0])}” to Trash`
    : `Moved ${titles.length} notes to Trash`;
}

/**
 * A title as the toast shows it (#170 F11): through the prompts' sanitiser (no bidi or other
 * format characters, no brackets or quote look-alikes), for the toast to isolate in `<bdi>`.
 */
export function trashedTitle(title: string | undefined): string {
  return cleanTitle(title, 80) ?? 'Untitled';
}

/**
 * What Trash says once a note is deleted for good (#170 F13). In a git notebook it says that
 * the repository's git history still keeps it, as the Touch ID prompt does, in Android's words
 * too (`deletedForGoodMessage`), the title cleaned and isolated as the prompts name it.
 */
export function deletedForGoodText(title: string, git: boolean): string {
  if (!git) return `Deleted “${title}” for good.`;
  const shown = isolatedTitle(title);
  return `Deleted ${shown ? `“${shown}”` : 'an untitled note'} for good. The repository’s git history still keeps it.`;
}

/**
 * Moves several notes to Trash at once (T42, A570, review S2). Resolves to those that reached
 * it and never rejects, so one refusal neither hides the others nor sends Undo after a note
 * that never left.
 */
export async function trashAll(
  ids: readonly string[],
  trash: (id: string) => Promise<unknown>,
): Promise<string[]> {
  const results = await Promise.allSettled(ids.map((id) => trash(id)));
  return ids.filter((_, index) => results[index]!.status === 'fulfilled');
}

export interface UndoOutcome {
  /** How many came back. */
  readonly restored: number;
  /** Those that did not, with why. */
  readonly failed: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly message: string;
  }>;
}

/**
 * Undo (A524, review S2): every note that reached Trash comes back, each on its own, so one
 * that cannot does not keep the others there.
 */
export async function undoTrash(
  trashed: Pick<Trashed, 'notes' | 'done'>,
  restore: (id: string) => Promise<unknown>,
): Promise<UndoOutcome> {
  const all = trashed.notes.map((note) => note.id);
  let reached: readonly string[];
  try {
    const value = await trashed.done;
    reached = Array.isArray(value) ? (value as string[]) : all;
  } catch {
    // A single note whose move failed: try it anyway, as before.
    reached = all;
  }
  const notes = trashed.notes.filter((note) => reached.includes(note.id));
  const results = await Promise.allSettled(notes.map((note) => restore(note.id)));
  const failed = notes.flatMap((note, index) => {
    const result = results[index]!;
    if (result.status === 'fulfilled') return [];
    const reason: unknown = result.reason;
    return [{ ...note, message: reason instanceof Error ? reason.message : String(reason) }];
  });
  return { restored: notes.length - failed.length, failed };
}

/** What the toast says when some of an Undo failed: the reason, and for several how many. */
export function undoFailedText(outcome: UndoOutcome): string {
  const first = outcome.failed[0]?.message ?? '';
  const total = outcome.restored + outcome.failed.length;
  if (total <= 1) return first;
  const n = outcome.failed.length;
  return `Restored ${outcome.restored} of ${total} notes; ${n} could not be: ${first}`;
}
