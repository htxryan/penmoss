import { createContext, useContext } from 'react';
import type { NoteDirectory } from './directory';

export const DirectoryContext = createContext<NoteDirectory | null>(null);

/** The note registry for wikilinks (T16). */
export function useDirectory(): NoteDirectory {
  const directory = useContext(DirectoryContext);
  if (!directory) throw new Error('useDirectory outside DirectoryProvider');
  return directory;
}
