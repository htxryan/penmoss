/**
 * Note lists across sources (T50 G4, A826, A862): Quick open and the recent-notes switcher
 * (⌘E) reach every note this window shows, each git notebook's. A note's id says its source
 * (A820), so opening one from the merged list opens it in its own source.
 */
import { useEffect, useMemo, useState } from 'react';
import type { NoteListEntry } from '../notes/list';
import { useSourcesState } from './hooks';
import type { Source } from './registry';

/** Each source's notes, in order. */
function openLists(all: readonly Pick<Source, 'notes'>[]): readonly NoteListEntry[] {
  return all.flatMap((source) => source.notes.list());
}

/** Every source's notes. */
export function useEveryOpenNoteList(): readonly NoteListEntry[] {
  const { all } = useSourcesState();
  const [tick, setTick] = useState(0);
  useEffect(() => {
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
    void tick;
    return openLists(all);
  }, [all, tick]);
}
