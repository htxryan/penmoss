/**
 * One search across every source (T50 G4, #152; A826): each git notebook's own index on this
 * device (A101's ranking), and in the Mac app its meaning (T77, A1156). Results come grouped by
 * notebook, each labelled with its notebook when there is more than one. Words only shows as it
 * does for one notebook: when any notebook matched by words alone.
 */
import type { SearchHit, SearchOutcome, SearchRequest, SearchService } from './service';

/** What the search overlay needs of a search. */
export type Searcher = Pick<SearchService, 'invalidate' | 'refresh' | 'typing' | 'search'>;

export interface SourceSearch {
  readonly id: string;
  readonly name: string;
  readonly service: Searcher;
}

export class SourcesSearch implements Searcher {
  constructor(private readonly sources: () => readonly SourceSearch[]) {}

  invalidate(): void {
    for (const source of this.sources()) source.service.invalidate();
  }

  async refresh(): Promise<void> {
    await Promise.all(this.sources().map((source) => source.service.refresh()));
  }

  /** The sources the request searches: one, when its notebook filter names it (A1127). */
  private searched(request: SearchRequest): readonly SourceSearch[] {
    const all = this.sources();
    const only = request.filters.notebookId ?? null;
    return only === null ? all : all.filter((source) => source.id === only);
  }

  async typing(request: SearchRequest): Promise<SearchOutcome | null> {
    const sources = this.searched(request);
    const outcomes = await Promise.all(sources.map((source) => source.service.typing(request)));
    if (outcomes.every((outcome) => outcome === null)) return null;
    return merge(sources, outcomes);
  }

  async search(request: SearchRequest): Promise<SearchOutcome> {
    const sources = this.searched(request);
    const outcomes = await Promise.all(sources.map((source) => source.service.search(request)));
    return merge(sources, outcomes);
  }
}

function merge(
  sources: readonly SourceSearch[],
  outcomes: ReadonlyArray<SearchOutcome | null>,
): SearchOutcome {
  if (sources.length === 0) return { source: 'device', hits: [], notice: null };
  if (sources.length === 1) return outcomes[0] ?? { source: 'device', hits: [], notice: null };
  const hits: SearchHit[] = [];
  let notice: string | null = null;
  let wordsOnly: string | undefined;
  let preview = false;
  sources.forEach((source, index) => {
    const outcome = outcomes[index];
    if (!outcome) return;
    notice ??= outcome.notice;
    wordsOnly ??= outcome.wordsOnly;
    preview ||= outcome.preview === true;
    for (const hit of outcome.hits) hits.push({ ...hit, notebook: source.name });
  });
  return {
    source: 'device',
    hits,
    notice,
    ...(wordsOnly !== undefined ? { wordsOnly } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** What `SourceSearches` needs of a source: its id, and its notes' changes. */
export interface SearchedSource {
  readonly id: string;
  readonly notes: { subscribe(listener: () => void): () => void };
}

/**
 * Each source's search for the window's life, made on first use and kept up to date with its
 * notes. A source that goes (its notebook removed) has its search closed, with its meaning and
 * its subscription (A-NEW-1).
 */
export class SourceSearches<
  S extends SearchedSource,
  T extends Pick<SearchService, 'invalidate' | 'close'>,
> {
  private readonly entries = new Map<string, { readonly service: T; readonly off: () => void }>();

  constructor(private readonly make: (source: S) => T) {}

  get(source: S): T {
    const known = this.entries.get(source.id);
    if (known) return known.service;
    const service = this.make(source);
    const off = source.notes.subscribe(() => service.invalidate());
    this.entries.set(source.id, { service, off });
    return service;
  }

  /** Closes the search of every source not in `ids`: its notebook was removed. */
  retain(ids: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (!ids.has(id)) this.drop(id, entry, true);
    }
  }

  /**
   * Lets go of every search (the view that held them went). Only the sources not in `live` are
   * forgotten by meaning's service: the others' notes stay there for the view that comes next.
   */
  release(live: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) this.drop(id, entry, !live.has(id));
  }

  private drop(
    id: string,
    entry: { readonly service: T; readonly off: () => void },
    forget: boolean,
  ) {
    this.entries.delete(id);
    entry.off();
    entry.service.close(forget);
  }
}
