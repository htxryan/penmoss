import type { ReactNode } from 'react';
import { NotesContext } from './hooks';
import type { Notes } from './service';

export function NotesProvider({ notes, children }: { notes: Notes; children: ReactNode }) {
  return <NotesContext.Provider value={notes}>{children}</NotesContext.Provider>;
}
