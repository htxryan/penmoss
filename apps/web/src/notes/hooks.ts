import { createContext, useContext, useSyncExternalStore } from 'react';
import type { NoteListEntry } from './list';
import type { AppSyncState, Notes } from './service';

export const NotesContext = createContext<Notes | null>(null);

export function useNotes(): Notes {
  const notes = useContext(NotesContext);
  if (!notes) throw new Error('useNotes outside NotesProvider');
  return notes;
}

export function useNoteList(): NoteListEntry[] {
  const notes = useNotes();
  return useSyncExternalStore(notes.subscribe, notes.list, notes.list);
}

export function useSyncState(): AppSyncState {
  const notes = useNotes();
  return useSyncExternalStore(notes.subscribeSync, notes.syncState, notes.syncState);
}
