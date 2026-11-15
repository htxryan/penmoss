/**
 * Search in a git notebook on this device (A101, A1156): by words over the offline index, and by
 * meaning when the caller gives an embedder, a cache and an index. Backlinks read the same index
 * for the notes that name a title without linking it.
 */
import {
  HYBRID_DEPTH,
  fuseHybrid,
  parseQuery,
  type MeaningCoverage,
  type MeaningHit,
  type MeaningIndex,
  type MeaningNote,
} from '@penmoss/core/search';
import { tagMatches } from '@penmoss/core/tags';
import { folderSubtree } from '@penmoss/core/workspace';
import { LocalSearchIndex, type LocalSearchDocument } from '@penmoss/model/local-index';
import { LocalError, type NoteCatalog } from './catalog';

/** Search by meaning for this notebook (A1156): its own index, over a shared cache. */
export interface LocalMeaning {
  readonly index: MeaningIndex;
  /**
   * How long one search may embed chunks the cache lacks (ms). 0 reads the cache only: the
   * lease holder indexes, everyone else embeds just the query and this budget (A1157).
   */
  readonly budgetMs?: number;
  /** Records the keys this notebook uses, so a compaction elsewhere keeps them (PEN-134). */
  readonly claim?: (keys: ReadonlySet<string>) => Promise<void>;
}

/** One search result, as `GET /api/search` gives it. */
export interface LocalSearchResult {
  readonly id: string;
  readonly title: string;
  readonly titleHighlighted: string;
  readonly snippet: string;
  /** The heading of the note's best chunk (meaning only); a hit opens the note there. */
  readonly heading: string | null;
  readonly tags: string[];
  readonly kind: string;
  readonly updatedAt: number;
  /** How the note was found: by its words, by meaning, or both. */
  readonly sources: Array<'full-text' | 'semantic'>;
}

export interface LocalSearchAnswer {
  readonly mode: 'full-text' | 'hybrid' | 'semantic';
  readonly results: LocalSearchResult[];
  /** With meaning: how many of the notes have vectors (A1156). */
  readonly coverage?: MeaningCoverage;
  readonly notice?: string;
}

/** What `search` takes. */
export interface LocalSearchInput {
  readonly q: string;
  readonly mode?: string;
  readonly limit?: number;
  readonly tag?: string | null;
  readonly folderId?: string | null;
  readonly after?: number | null;
  readonly before?: number | null;
}

/** One note linking to another, by heading and embed, as `backlinks` lists it. */
export interface LocalBacklink {
  id: string;
  title: string;
  updatedAt: number;
  heading: string | null;
  embed: boolean;
  count: number;
}

/** What hybrid says without meaning (A843), and what meaning says while it is indexing. */
export const WORDS_ONLY_NOTICE = 'A git notebook searches words only: these are keyword results.';
export const coverageNotice = ({ indexed, total }: MeaningCoverage) =>
  `Meaning covers ${indexed} of ${total} notes so far.`;

export class LocalSearch {
  private readonly index = new LocalSearchIndex();
  private readonly indexed = new Map<string, number>();
  private meaning: LocalMeaning | null = null;

  constructor(private readonly notes: NoteCatalog) {}

  /** Brings the word index up to the live notes' revisions. */
  private refresh(): void {
    const live = new Map(this.notes.live().map((note) => [note.id, note]));
    for (const id of [...this.indexed.keys()]) {
      if (!live.has(id)) {
        this.index.remove(id);
        this.indexed.delete(id);
      }
    }
    for (const note of live.values()) {
      if (this.indexed.get(note.id) === note.rev) continue;
      if (this.indexed.has(note.id)) this.index.remove(note.id);
      const doc: LocalSearchDocument = {
        id: note.id,
        title: note.title,
        body: note.text,
        tags: note.tags,
        headings: note.headings,
        updatedAt: note.updatedAt,
      };
      this.index.add(doc);
      this.indexed.set(note.id, note.rev);
    }
  }

  useMeaning(meaning: LocalMeaning | null): void {
    this.meaning = meaning;
  }

  meaningNotes(): MeaningNote[] {
    return this.notes.live().map((note) => ({
      id: note.id,
      version: note.rev,
      title: note.title,
      sections: note.sections,
    }));
  }

  async search(input: LocalSearchInput): Promise<LocalSearchAnswer> {
    const mode = input.mode ?? 'hybrid';
    const meaning = this.meaning;
    if (mode === 'semantic' && !meaning) {
      throw new LocalError(
        422,
        'semantic_unavailable',
        'Search by meaning is not set up here (on a Mac: Settings → Search by Meaning in the app, or penmoss models fetch): search with mode full-text or hybrid',
      );
    }
    if (mode !== 'hybrid' && mode !== 'full-text' && mode !== 'semantic') {
      throw new LocalError(400, 'invalid_request', 'mode must be hybrid, full-text or semantic');
    }
    const query = input.q.trim();
    if (!query) throw new LocalError(400, 'invalid_request', 'q must not be empty');
    this.refresh();
    let inFolder: Set<string> | null = null;
    if (input.folderId) {
      if (!this.notes.folder(input.folderId))
        throw new LocalError(422, 'folder_not_found', 'No such folder');
      const folders = folderSubtree(this.notes.folders(), input.folderId);
      inFolder = new Set(
        this.notes
          .live()
          .filter((note) => note.folderId !== null && folders.has(note.folderId))
          .map((note) => note.id),
      );
    }
    const tag = input.tag ?? null;
    const accepts = (id: string, tags: readonly string[], updatedAt: number) =>
      (!inFolder || inFolder.has(id)) &&
      (!tag || tags.some((each) => tagMatches(each, tag))) &&
      (input.after == null || updatedAt > input.after) &&
      (input.before == null || updatedAt < input.before);
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const words = (depth: number) =>
      mode === 'semantic'
        ? []
        : this.index.search(parseQuery(query), {
            limit: depth,
            filter: (doc) => accepts(doc.id, doc.tags, doc.updatedAt),
          });
    const wordResult = (hit: ReturnType<typeof words>[number]): LocalSearchResult => ({
      id: hit.id,
      title: hit.title,
      titleHighlighted: hit.titleHighlighted,
      snippet: hit.snippet,
      heading: null,
      tags: [...hit.tags],
      kind: this.notes.cached(hit.id)?.kind ?? 'note',
      updatedAt: hit.updatedAt,
      sources: ['full-text'],
    });
    if (mode === 'full-text' || !meaning) {
      return {
        mode: 'full-text',
        results: words(limit).map(wordResult),
        ...(mode === 'hybrid' ? { notice: WORDS_ONLY_NOTICE } : {}),
      };
    }

    const budgetMs = meaning.budgetMs ?? 0;
    const coverage = await meaning.index.update(this.meaningNotes(), {
      budgetMs,
      embed: budgetMs > 0,
    });
    // A claim that fails costs a re-embedding later, never this search.
    await meaning.claim?.(meaning.index.usedKeys()).catch(() => undefined);
    const found = await meaning.index.search(query, {
      limit: HYBRID_DEPTH,
      filter: (id) => {
        const note = this.notes.cached(id);
        return note !== undefined && accepts(id, note.tags, note.updatedAt);
      },
    });
    const meaningResult = (hit: MeaningHit): LocalSearchResult | null => {
      const note = this.notes.cached(hit.id);
      if (!note) return null;
      return {
        id: note.id,
        title: note.title,
        titleHighlighted: note.title,
        snippet: hit.preview,
        heading: hit.heading,
        tags: [...note.tags],
        kind: note.kind,
        updatedAt: note.updatedAt,
        sources: ['semantic'],
      };
    };
    const results: LocalSearchResult[] = [];
    if (mode === 'semantic') {
      for (const hit of found) {
        const result = meaningResult(hit);
        if (result) results.push(result);
        if (results.length === limit) break;
      }
    } else {
      for (const fused of fuseHybrid(words(HYBRID_DEPTH), found, meaning.index.embedder.floor)) {
        const result = fused.text
          ? {
              ...wordResult(fused.text),
              heading: fused.meaning?.heading ?? null,
              sources: fused.meaning
                ? (['full-text', 'semantic'] as const)
                : (['full-text'] as const),
            }
          : meaningResult(fused.meaning!);
        if (result) results.push({ ...result, sources: [...result.sources] });
        if (results.length === limit) break;
      }
    }
    return {
      mode,
      results,
      coverage,
      ...(coverage.indexed < coverage.total ? { notice: coverageNotice(coverage) } : {}),
    };
  }

  backlinks(id: string) {
    const { info: target } = this.notes.require(id);
    const linked = new Map<string, LocalBacklink>();
    for (const note of this.notes.live()) {
      if (note.id === id) continue;
      for (const link of note.links) {
        if (link.noteId !== id) continue;
        const key = `${note.id}\u0000${link.heading ?? ''}\u0000${link.embed}`;
        const row = linked.get(key);
        if (row) row.count++;
        else
          linked.set(key, {
            id: note.id,
            title: note.title,
            updatedAt: note.updatedAt,
            heading: link.heading,
            embed: link.embed,
            count: 1,
          });
      }
    }
    const linkers = new Set([...linked.values()].map((row) => row.id));
    let unlinked: Array<{ id: string; title: string; updatedAt: number; snippet: string }> = [];
    const words = target.title.replace(/["*]/g, ' ').trim();
    if (words) {
      this.refresh();
      unlinked = this.index
        .search(parseQuery(`"${words}"`), {
          limit: 20,
          filter: (doc) => doc.id !== id && !linkers.has(doc.id),
        })
        .map((hit) => ({
          id: hit.id,
          title: hit.title,
          updatedAt: hit.updatedAt,
          snippet: hit.snippet,
        }));
    }
    return {
      title: target.title,
      linked: [...linked.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      unlinked,
    };
  }
}
