/**
 * The app as the Mac app's window holds it, for tests that render views over one notebook: a
 * `Sources` registry holding one real `GitSource` (its notes and folders over an in-memory store,
 * no engine), with the providers `main.tsx` puts around the app (`SourcesProvider`, the Journal
 * notebook's scope). The views then take the paths users get, not a single-source stand-in.
 */
import type { ReactNode } from 'react';
import type { DesktopGit, GitNotebookInfo } from '../../../src/desktop/bridge';
import { NotesProvider } from '../../../src/notes/context';
import { NoteDirectory } from '../../../src/notes/directory';
import type { LocalNotes } from '../../../src/notes/service-types';
import type { Notes } from '../../../src/notes/service';
import { SourcesProvider } from '../../../src/sources/context';
import type { GitSource } from '../../../src/sources/git-source';
import { SourceContext } from '../../../src/sources/hooks';
import { JournalScope } from '../../../src/sources/JournalScope';
import { Sources, type OpenSourcesState } from '../../../src/sources/registry';
import { WorkspaceProvider } from '../../../src/workspace/context';
import type { Workspace } from '../../../src/workspace/service';
import { TEST_NOTEBOOK } from './local-sources';
import { memoryNotes } from './memory-notes';

/** A git notebook as main lists it. */
function notebookInfo(overrides: Partial<GitNotebookInfo> = {}): GitNotebookInfo {
  return {
    localId: `local-${overrides.notebookId ?? TEST_NOTEBOOK}`,
    notebookId: TEST_NOTEBOOK,
    name: 'Notes',
    create: false,
    remote: 'https://github.com/test/notes.git',
    repository: 'github.com/test/notes',
    host: 'github.com',
    branch: 'main',
    dir: '',
    pushDelayS: 12,
    pullEveryMin: 1,
    sign: false,
    author: null,
    hasToken: true,
    filterIgnored: false,
    ...overrides,
  };
}

/** Main's git bridge with one notebook listed; nothing else answers. */
function oneNotebookGit(info: GitNotebookInfo): DesktopGit {
  return {
    list: () => Promise.resolve([info]),
    onChange: () => () => undefined,
  } as unknown as DesktopGit;
}

export interface OneSource {
  readonly sources: Sources;
  readonly source: GitSource;
  readonly store: LocalNotes;
  /** Stops the source's services. */
  readonly stop: () => void;
}

/**
 * One notebook's registry, read and started (its notes and folders loading from `store`). Await
 * `source.notes.start()` and `source.workspace.start()`'s work through the test's own waits.
 */
export async function oneSource(
  options: {
    readonly store?: LocalNotes;
    readonly info?: Partial<GitNotebookInfo>;
    /** When the store opens (at once by default): a test holding it sees the views before. */
    readonly opened?: Promise<void>;
  } = {},
): Promise<OneSource> {
  const store = options.store ?? memoryNotes();
  const info = notebookInfo(options.info);
  const sources = new Sources({
    git: oneNotebookGit(info),
    gitDeps: {
      directory: (notes, workspace) =>
        new NoteDirectory({
          notes,
          folderOf: (id) =>
            workspace.getState().snapshot.notes.find((entry) => entry.id === id)?.folderId ?? null,
          folderName: (id) =>
            workspace.getState().snapshot.folders.find((folder) => folder.id === id)?.name ?? null,
          register: (id, folderId) => workspace.registerNote(id, folderId),
          navigate: () => undefined,
        }),
      canHost: false,
      notices: true,
      locks: null,
      channel: null,
      openStore: () => (options.opened ?? Promise.resolve()).then(() => store),
    },
    storage: null,
  });
  await sources.load();
  const source = sources.getState().all[0]!;
  return { sources, source, store, stop: () => sources.stop() };
}

/** What `main.tsx` puts around the app: the registry and the Journal notebook's scope. */
export function InSources({
  sources,
  children,
}: {
  readonly sources: Sources;
  readonly children: ReactNode;
}) {
  return (
    <SourcesProvider sources={sources}>
      <JournalScope>{children}</JournalScope>
    </SourcesProvider>
  );
}

/**
 * A window's sources holding one notebook made of the services a test gives (fakes, or a view's
 * own test services), for a view rendered alone: what `useSourcesState` and the rest read. The
 * list never changes.
 */
export function standInSources(parts: { readonly notes: Notes; readonly workspace: Workspace }): {
  readonly sources: Sources;
  readonly source: GitSource;
} {
  const source = {
    kind: 'git',
    id: TEST_NOTEBOOK,
    name: 'Notes',
    info: notebookInfo(),
    notes: parts.notes,
    workspace: parts.workspace,
  } as unknown as GitSource;
  const state: OpenSourcesState = {
    all: [source],
    journal: source,
    journalPicked: false,
    loaded: true,
  };
  const sources = {
    getState: () => state,
    subscribe: () => () => undefined,
    sourceById: (id: string) => (id === source.id ? source : null),
    gitSource: (id: string) => (id === source.id ? source : null),
    sourceOfNote: () => source,
    refresh: () => Promise.resolve(),
  } as unknown as Sources;
  return { sources, source };
}

/** A view alone in one stand-in notebook (`standInSources`), in its scope. */
export function InStandIn({
  notes,
  workspace,
  children,
}: {
  readonly notes: Notes;
  readonly workspace: Workspace;
  readonly children: ReactNode;
}) {
  const { sources, source } = standInSources({ notes, workspace });
  return (
    <SourcesProvider sources={sources}>
      <SourceContext.Provider value={source}>
        <NotesProvider notes={notes}>
          <WorkspaceProvider workspace={workspace}>{children}</WorkspaceProvider>
        </NotesProvider>
      </SourceContext.Provider>
    </SourcesProvider>
  );
}
