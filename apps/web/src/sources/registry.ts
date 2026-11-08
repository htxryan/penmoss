/**
 * The sources this window shows (T50 G3, G4; A820, A826, A827, A862; T59, A1030): each git
 * notebook on this Mac, side by side. Each source has its own store and services, so nothing
 * crosses between them (A826): a note view, a folder tree, completion, links, embeds, moves,
 * Trash and history work inside the source of the note they show. Note ids are unique across
 * sources (A820: ULIDs, and derived ids salted with the notebook's id), so `/notes/:id` stays as
 * it is and the id says which source it is in.
 *
 * - With no git notebook the app shows its first run (A1030): there is no other kind of notebook.
 * - The Journal notebook (A827) is this device's choice, otherwise the first git notebook; a
 *   removed one falls back to that default. The app's own services (settings, the palette, the
 *   theme) are the Journal notebook's (`root`).
 */
import type { DesktopGit, GitNotebookInfo } from '../desktop/bridge';
import type { ChangedRecords, StoreSync } from '../window/store-sync';
import { GitSource, type GitSourceDeps } from './git-source';

export type Source = GitSource;

export interface SourcesState {
  /** Every git notebook this window holds, in the order they were added. */
  readonly all: readonly Source[];
  /** Whose Journal, Calendar and Inbox the app shows (A827); null with no notebook. */
  readonly journal: Source | null;
  /** The Journal notebook is this device's choice, not the fallback (A888: capture says so). */
  readonly journalPicked: boolean;
  /** The app's own services: settings, the palette, the theme (the Journal's); null with none. */
  readonly root: Source | null;
  /** The git notebooks are read (until then, routes wait). */
  readonly loaded: boolean;
}

/** The state once there is a notebook: the app is mounted only then (A1030). */
export interface OpenSourcesState extends SourcesState {
  readonly journal: Source;
  readonly root: Source;
}

/** Whether there is a notebook to open (the first run shows until there is). */
export function isOpen(state: SourcesState): state is OpenSourcesState {
  return state.root !== null && state.journal !== null;
}

/** This device's Journal notebook (A827). */
export const JOURNAL_KEY = 'penmoss.journalNotebook';

export interface SourcesOptions {
  /** The Mac app's git bridge; absent outside it (no notebook there, D48). */
  readonly git: DesktopGit | null;
  readonly gitDeps?: Omit<GitSourceDeps, 'git'>;
  /** The windows' store announcements: each source hears its own records' (A711). */
  readonly sync?: StoreSync;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Makes a git source (tests stand in). */
  readonly makeGit?: (info: GitNotebookInfo) => GitSource;
}

/** A git notebook's records in the windows' announcements: `<notebookId>/<record id>`. */
export const scopedId = (notebookId: string, id: string) => `${notebookId}/${id}`;

/** Splits announced ids by notebook; an id with no notebook (from no source) is dropped. */
export function routeChanged(ids: ChangedRecords): ReadonlyMap<string, readonly string[]> | null {
  if (ids === null) return null;
  const git = new Map<string, string[]>();
  for (const id of ids) {
    const slash = id.indexOf('/');
    if (slash < 0) continue;
    const notebook = id.slice(0, slash);
    const list = git.get(notebook) ?? [];
    list.push(id.slice(slash + 1));
    git.set(notebook, list);
  }
  return git;
}

export class Sources {
  private git: GitSource[] = [];
  /** Each git source's announcer of its stored records, to stop with it. */
  private readonly announcing = new Map<GitSource, () => void>();
  private state: SourcesState;
  private readonly listeners = new Set<() => void>();
  private readonly offs: Array<() => void> = [];
  private loading: Promise<void> | null = null;
  private loaded: boolean;

  constructor(private readonly options: SourcesOptions) {
    this.loaded = options.git === null;
    this.state = this.compute();
  }

  /** The Mac app's git bridge (null outside it). */
  get bridge(): DesktopGit | null {
    return this.options.git;
  }

  getState = (): SourcesState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reads the git notebooks and follows changes to the list. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      // The Journal notebook picked in another window (the capture window starts on it, A914).
      if (typeof window !== 'undefined') {
        const onStorage = (event: StorageEvent) => {
          if (event.key === JOURNAL_KEY || event.key === null) this.changed();
        };
        window.addEventListener('storage', onStorage);
        this.offs.push(() => window.removeEventListener('storage', onStorage));
      }
      const git = this.options.git;
      if (git) {
        this.offs.push(git.onChange(() => void this.refresh()));
        await this.refresh();
      }
      this.loaded = true;
      this.changed();
    })();
    return this.loading;
  }

  /** Reads main's list again: new notebooks start, removed ones stop, the rest update. */
  async refresh(): Promise<void> {
    const git = this.options.git;
    if (!git) return;
    const listed = await git.list().catch(() => [] as GitNotebookInfo[]);
    const byId = new Map(listed.map((info) => [info.notebookId, info]));
    const kept: GitSource[] = [];
    for (const source of this.git) {
      const info = byId.get(source.id);
      if (info) {
        source.setInfo(info);
        kept.push(source);
      } else {
        this.announcing.get(source)?.();
        this.announcing.delete(source);
        source.stop();
      }
    }
    for (const info of listed) {
      if (kept.some((source) => source.id === info.notebookId)) continue;
      const source =
        this.options.makeGit?.(info) ?? new GitSource(info, { ...this.options.gitDeps!, git });
      // Its stored records reach the other windows, prefixed with the notebook (A711).
      this.announcing.set(source, source.notes.onStored(this.announceFor(source)));
      source.start();
      kept.push(source);
    }
    // In the order main lists them (the order they were added).
    this.git = listed.flatMap((info) => kept.filter((source) => source.id === info.notebookId));
    this.changed();
  }

  /** The git notebook with this id. */
  gitSource(id: string): GitSource | null {
    return this.git.find((source) => source.id === id) ?? null;
  }

  sourceById(id: string): Source | null {
    return this.gitSource(id);
  }

  /**
   * The source a note is in (A820): the git notebook that holds it, else the Journal notebook
   * (a new note's). Null while that can't be told yet (a notebook's list is still being read),
   * or with no notebook.
   */
  sourceOfNote(noteId: string): Source | null {
    let unsure = !this.loaded;
    for (const source of this.git) {
      const known = source.notes.knows(noteId);
      if (known === true) return source;
      if (known === null) unsure = true;
    }
    if (unsure) return null;
    return this.state.journal;
  }

  /** Sets this device's Journal notebook (A827); unknown ids fall back to the default. */
  setJournal(id: string): void {
    try {
      this.options.storage?.setItem(JOURNAL_KEY, id);
    } catch {
      // Remembering is a convenience: the default stands.
    }
    this.changed();
  }

  /** Hands the windows' announcements a source's stored records, prefixed with it (A711). */
  announceFor(source: Source): (ids: readonly string[]) => void {
    const sync = this.options.sync;
    if (!sync) return () => undefined;
    return (ids) => sync.announce(ids.map((id) => scopedId(source.id, id)));
  }

  /** Another window stored records: each git notebook reads its own. */
  async storedElsewhere(ids: ChangedRecords): Promise<void> {
    const routed = routeChanged(ids);
    await Promise.all(
      this.git.map((source) =>
        routed === null
          ? source.storedElsewhere(null)
          : routed.has(source.id)
            ? source.storedElsewhere(routed.get(source.id)!)
            : Promise.resolve(),
      ),
    );
  }

  /** Every open notebook's notes write what they hold (before a window closes, T29). */
  async saveAll(): Promise<void> {
    await Promise.all(this.git.map((source) => source.notes.saveAll()));
  }

  /**
   * As main asks (#174 review): `close`, every git notebook stores its changes and syncs once
   * (A825); `flush`, it only stores them.
   */
  async store(reason: 'close' | 'flush' = 'close'): Promise<void> {
    await Promise.all(this.git.map((source) => source.store(reason).catch(() => undefined)));
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const off of this.announcing.values()) off();
    this.announcing.clear();
    for (const source of this.git) source.stop();
  }

  private compute(): SourcesState {
    const git = this.git;
    const chosen = (() => {
      try {
        return this.options.storage?.getItem(JOURNAL_KEY) ?? null;
      } catch {
        return null;
      }
    })();
    const picked = chosen ? git.find((source) => source.id === chosen) : undefined;
    const journal = picked ?? git[0] ?? null;
    return {
      all: [...git],
      journal,
      journalPicked: picked !== undefined,
      root: journal,
      loaded: this.loaded,
    };
  }

  private changed(): void {
    this.state = this.compute();
    for (const listener of this.listeners) listener();
  }
}
