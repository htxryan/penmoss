import type { ReactNode } from 'react';
import type { NoteDirectory } from './directory';
import { DirectoryContext } from './directory-hooks';

/** Provides the note registry for wikilinks (T16). */
export function DirectoryProvider({
  directory,
  children,
}: {
  directory: NoteDirectory;
  children: ReactNode;
}) {
  return <DirectoryContext.Provider value={directory}>{children}</DirectoryContext.Provider>;
}
