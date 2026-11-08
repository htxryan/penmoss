/**
 * Note lists across sources (T50 G4, A826, A862): Quick open and the recent-notes switcher
 * (⌘E) reach every note this window shows, each git notebook's. A note's id says its source
 * (A820), so opening one from the merged list opens it in its own source. A git notebook has no
 * notebooks inside it to close (A912).
 */
import { useEffect, useMemo, useState } from 'react';
import type { NoteListEntry } from '../notes/list';
import { useOpenNoteList } from '../workspace/notebooks';
import { useSourcesState } from './hooks';
import type { Source } from './registry';

/** Each source's notes, in order. */
export function openLists(all: readonly Pick<Source, 'notes'>[]): readonly NoteListEntry[] {
  return all.flatMap((source) => source.notes.list());
}

/** Every source's notes; without a registry (a test's lone source), the one list. */
export function useEveryOpenNoteList(): readonly NoteListEntry[] {
  const own = useOpenNoteList();
  const all = useSourcesState()?.all;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!all) return;
    const bump = () => setTick((n) => n + 1);
    const offs = all.flatMap((source) => [
      source.notes.subscribe(bump),
      source.workspace.subscribe(bump),
    ]);
    return () => {
      for (const off of offs) off();
    };
  }, [all]);
  return useMemo(() => {
    if (!all) return own;
    void tick;
    return openLists(all);
  }, [all, own, tick]);
}
