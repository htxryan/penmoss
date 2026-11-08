/**
 * The open note's counts and save status, for the status bar and the Info
 * panel (T41, A505). Counting happens once typing pauses, off the keystroke,
 * and only the bar and the panel re-render for it (the T31 typing budget).
 */
import type { CollabEditor } from '@penmoss/editor';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNotes, useSyncState } from './hooks';
import { gitSaveStatus, type SaveStatus } from './save-status';
import type { OpenNote } from './service';
import { docText, textStats, type TextStats } from './stats';
import { loadTokenCounter } from './tokens';

type Editor = CollabEditor['editor'];

/** How long typing must pause before the counts are taken again. */
export const COUNT_DELAY_MS = 400;
const SELECTION_DELAY_MS = 150;

export interface NoteCounts {
  readonly doc: TextStats | null;
  /** Counts of the selected text; null when nothing is selected. */
  readonly selection: TextStats | null;
  /** The note's Token Count (`tokens.ts`); null until counted, or when it could not be. */
  readonly tokens: number | null;
}

const same = (a: TextStats | null, b: TextStats | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.words === b.words &&
    a.characters === b.characters &&
    a.minutes === b.minutes);

/** The open note's counts, taken after typing pauses; the bar and the panel subscribe. */
export class NoteStats {
  private counts: NoteCounts = { doc: null, selection: null, tokens: null };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): NoteCounts => this.counts;

  /** Follows `editor` until the returned function is called. */
  attach(editor: Editor): () => void {
    let docTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let idle: number | null = null;
    let detached = false;
    const ric = typeof requestIdleCallback === 'function' ? requestIdleCallback : null;
    const countDoc = () => {
      docTimer = null;
      const run = () => {
        idle = null;
        if (editor.isDestroyed) return;
        const text = docText(editor.state.doc);
        this.set({ ...this.counts, doc: textStats(text) });
        const doc = editor.state.doc;
        void loadTokenCounter().then(
          (count) => {
            // Only while the note still reads this way: a later count replaces it.
            if (detached || editor.isDestroyed || editor.state.doc !== doc) return;
            this.set({ ...this.counts, tokens: count(text) });
          },
          () => undefined,
        );
      };
      // When the page is idle, so a long note's count never delays a frame.
      if (ric) idle = ric(run, { timeout: 1000 });
      else run();
    };
    const countSelection = () => {
      selectionTimer = null;
      if (editor.isDestroyed) return;
      const { from, to } = editor.state.selection;
      const selection = from === to ? null : textStats(docText(editor.state.doc, from, to));
      this.set({
        ...this.counts,
        selection: selection && selection.characters > 0 ? selection : null,
      });
    };
    const onUpdate = () => {
      if (docTimer !== null) clearTimeout(docTimer);
      docTimer = setTimeout(countDoc, COUNT_DELAY_MS);
    };
    const onSelection = () => {
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(countSelection, SELECTION_DELAY_MS);
    };
    // The first count waits for the note to show (the T31 note-switch budget).
    docTimer = setTimeout(countDoc, 0);
    editor.on('update', onUpdate);
    editor.on('selectionUpdate', onSelection);
    return () => {
      detached = true;
      editor.off('update', onUpdate);
      editor.off('selectionUpdate', onSelection);
      if (docTimer !== null) clearTimeout(docTimer);
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      if (idle !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
      this.set({ doc: null, selection: null, tokens: null });
    };
  }

  private set(next: NoteCounts): void {
    if (
      same(next.doc, this.counts.doc) &&
      same(next.selection, this.counts.selection) &&
      next.tokens === this.counts.tokens
    )
      return;
    this.counts = next;
    for (const listener of this.listeners) listener();
  }
}

export function useNoteCounts(stats: NoteStats): NoteCounts {
  return useSyncExternalStore(stats.subscribe, stats.get, stats.get);
}

/** The open note's save status, from its keeper and its git notebook's engine (A860). */
export function useSaveStatus(note: OpenNote | null): SaveStatus | null {
  const notes = useNotes();
  // Re-renders as the note's write and the notebook's sync change.
  useSyncState();
  const [, setVersion] = useState(0);
  useEffect(() => note?.onSaveState(() => setVersion((n) => n + 1)), [note]);
  if (!note) return null;
  return gitSaveStatus(
    { savedLocally: note.savedLocally, persistError: note.persistError },
    notes.localSync(),
    note.id,
  );
}
