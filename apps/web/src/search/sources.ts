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
