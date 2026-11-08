/**
 * Sources in React (T50 G3, A862): `SourceScope` puts a source's notes, folders and links in
 * context, so every view under it (a note, a folder tree, Trash, the graph, history) works in
 * that source alone: what `useNotes`, `useWorkspace` and `useDirectory` give there is the
 * source's own. Nothing crosses between sources (A826).
 */
import { useContext, type ReactNode } from 'react';
import { DirectoryContext } from '../notes/directory-hooks';
import { NotesContext } from '../notes/hooks';
import { NotesProvider } from '../notes/context';
import { DirectoryProvider } from '../notes/links-context';
import { WorkspaceContext } from '../workspace/hooks';
import { WorkspaceProvider } from '../workspace/context';
import { SourceContext, SourcesContext } from './hooks';
import type { Source, Sources } from './registry';

export function SourcesProvider({ sources, children }: { sources: Sources; children: ReactNode }) {
  return <SourcesContext.Provider value={sources}>{children}</SourcesContext.Provider>;
}

/** A source's services, for everything under it. */
export function SourceScope({ source, children }: { source: Source; children: ReactNode }) {
  return (
    <SourceContext.Provider value={source}>
      <NotesProvider notes={source.notes}>
        <WorkspaceProvider workspace={source.workspace}>
          <DirectoryProvider directory={source.directory}>{children}</DirectoryProvider>
        </WorkspaceProvider>
      </NotesProvider>
    </SourceContext.Provider>
  );
}

/**
 * `source`'s scope, or, without one, the scope around it, in the same tree either way: what is
 * under it is not mounted again when its source comes or goes. (A view mounted again redoes its
 * effects: the Trash toast took focus back from a new note's title, A862.)
 */
export function SourceScopeOr({
  source,
  children,
}: {
  source: Source | null;
  children: ReactNode;
}) {
  const outer = useContext(SourceContext);
  const notes = useContext(NotesContext);
  const workspace = useContext(WorkspaceContext);
  const directory = useContext(DirectoryContext);
  return (
    <SourceContext.Provider value={source ?? outer}>
      <NotesContext.Provider value={source?.notes ?? notes}>
        <WorkspaceContext.Provider value={source?.workspace ?? workspace}>
          <DirectoryContext.Provider value={source?.directory ?? directory}>
            {children}
          </DirectoryContext.Provider>
        </WorkspaceContext.Provider>
      </NotesContext.Provider>
    </SourceContext.Provider>
  );
}
