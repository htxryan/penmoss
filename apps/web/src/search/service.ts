/**
 * Search for the app (T22, T23; T59, T77): a git notebook's index on this device answers by
 * words, ranking as A101 says. In the Mac app, search by meaning's service (T76) answers too:
 * hybrid fuses its hits with the words' (A1155), and semantic is meaning's alone. The words
 * answer at once while typing; the hybrid answer replaces them after a pause or on Enter
 * (A1156). Without meaning, hybrid says Words only and semantic says why it found nothing.
 *
 * The index (A119) is restored from its saved snapshot, or built from the local replica a slice
 * at a time, giving the page a turn between slices, once older records have their search
 * fields. It is then kept up to date from the notes' list metadata (only notes whose record
 * changed are read again) and saved a moment after it changes.
 */
import { HYBRID_DEPTH, fuseHybrid, parseQuery, type NoteSection } from '@penmoss/core/search';
import { tagMatches } from '@penmoss/core/tags';
import { folderSubtree, openNotebookFilter, type FolderRecord } from '@penmoss/core/workspace';
import type { NoteMeta, NoteRecord, NoteText } from '@penmoss/sync-client';
import {
  LocalSearchIndex,
  type LocalSearchDocument,
  type SliceOptions,
} from '@penmoss/sync-client/local-index';
import type { RegistryEntry } from '@penmoss/sync-client/workspace';
import { MEANING_ELSEWHERE, sectionsOfRecord, type NotebookMeaning } from './meaning';

export const SEARCH_MODES = ['full-text', 'semantic', 'hybrid'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/**
 * The app always searches Hybrid (T42, #104 item 2, A571), with no picker: by meaning too in the
 * Mac app (T77), by words elsewhere.
 */
export const APP_SEARCH_MODE: SearchMode = 'hybrid';

export interface SearchFilters {
  /** One git notebook of several (Quanta feedback 3, item 2; A1127); null: all of them. */
  readonly notebookId?: string | null;
  /** A folder, with its subfolders. */
  readonly folderId: string | null;
  /** A tag, with the tags nested under it. */
  readonly tag: string | null;
  /** Updated at or after this time (epoch ms). */
  readonly updatedAfter: number | null;
}

export const NO_FILTERS: SearchFilters = {
  notebookId: null,
  folderId: null,
  tag: null,
  updatedAfter: null,
};

export interface SearchHit {
  readonly id: string;
  readonly title: string;
  /** Matched words between U+0002 and U+0003. */
  readonly titleHighlighted: string;
  readonly snippet: string;
  /** The section meaning matched, to open the note there (null: found by words alone). */
  readonly heading: string | null;
  readonly tags: readonly string[];
  readonly updatedAt: number;
  readonly sources: ReadonlyArray<'full-text' | 'semantic'>;
  /** The notebook it is in, when the search spans several sources (T50, A826). */
  readonly notebook?: string;
}

export interface SearchOutcome {
  /** This device's index. */
  readonly source: 'device';
  readonly hits: readonly SearchHit[];
  /** Why the results are not what the mode asked for (semantic search), or a failure. */
  readonly notice: string | null;
  /** Hybrid answered by words alone, and why: shown quietly as "Words only" (A571). */
  readonly wordsOnly?: string;
  /** The words' first answer, which the hybrid answer replaces (A1156). */
  readonly preview?: boolean;
}

export interface SearchRequest {
  readonly input: string;
  readonly mode: SearchMode;
  readonly filters: SearchFilters;
  readonly limit?: number;
  /** Enter: the last word is finished, whatever it looks like. */
  readonly submitted?: boolean;
}

/** The local replica as search reads it (NoteStore implements it). */
export interface SearchStore {
  listMeta(): Promise<NoteMeta[]>;
  listTexts?(): Promise<NoteText[]>;
  get(noteId: string): Promise<NoteRecord | undefined>;
  /** Saved values (the offline index's snapshot, A119). */
  getState?(key: string): Promise<unknown>;
  setState?(key: string, value: unknown): Promise<void>;
  /** Fills in older records' tags and headings (NoteStore, A119). */
  backfillSearchFields?(): Promise<void>;
}

export interface SearchDeps {
  readonly store: () => Promise<SearchStore>;
  /** The folder tree and registry, from the local WorkspaceDoc replica. */
  readonly workspace: () => { readonly folders: FolderRecord[]; readonly notes: RegistryEntry[] };
  /** Notebooks closed on this device (T43, A752): their notes are never found here. */
  readonly closed?: () => ReadonlySet<string>;
  /** Keys in the notes store that are not notes. */
  readonly reserved?: ReadonlySet<string>;
  /** Awaited between slices of building or restoring the offline index (default: a timeout). */
  readonly yieldToPage?: () => Promise<void>;
  /** Notes per slice when building the offline index. */
  readonly indexSlice?: number;
  /** How long after a change the offline index is saved. */
  readonly saveDelayMs?: number;
  /** Search by meaning for this notebook, in the Mac app (T77). */
  readonly meaning?: NotebookMeaning;
  /** A note's heading sections for meaning (default: from its record's Yjs document). */
  readonly sectionsOf?: (record: NoteRecord) => NoteSection[];
}

/** Where the offline index's snapshot is saved (the notes store's state, A119). */
export const SEARCH_INDEX_KEY = 'searchIndex';
const SAVE_DELAY_MS = 5_000;

const DEFAULT_LIMIT = 30;

function documentOf(text: NoteText): LocalSearchDocument {
  return {
    id: text.noteId,
    title: text.title,
    body: text.text,
    tags: text.tags,
    headings: text.headings,
    updatedAt: text.updatedAt,
  };
}

function documentOfRecord(record: NoteRecord): LocalSearchDocument {
  return {
    id: record.noteId,
    title: record.title ?? '',
    body: record.text,
    tags: record.tags ?? [],
    headings: record.headings ?? '',
    updatedAt: record.updatedAt,
  };
}

export class SearchService {
  private index: LocalSearchIndex | null = null;
  /** Each indexed note's record time, to find what changed. */
  private readonly indexed = new Map<string, number>();
  private refreshing: Promise<void> | null = null;
  private stale = true;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: SearchDeps) {
    deps.meaning?.attach({
      versions: async () => {
        await this.refresh();
        return this.indexed;
      },
      note: async (id) => {
        const record = await (await deps.store()).get(id);
        if (!record || record.deleted) return null;
        return {
          title: record.title ?? '',
          sections: (deps.sectionsOf ?? sectionsOfRecord)(record),
        };
      },
    });
  }

  /** Notes changed: the offline index catches up before its next search, and meaning after. */
  invalidate(): void {
    this.stale = true;
    this.deps.meaning?.schedule();
  }

  /** Builds or updates the offline index (search calls it; opening search warms it). */
  async refresh(): Promise<void> {
    if (!this.stale && this.index) return;
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * The answer while typing (A111, A1156): the words at once. With meaning to come it is a
   * preview the hybrid answer replaces; without, it is the answer. Null for semantic search.
   */
  async typing(request: SearchRequest): Promise<SearchOutcome | null> {
    if (request.mode === 'semantic') return null;
    if (request.mode === 'hybrid' && this.deps.meaning?.ready()) {
      return { source: 'device', hits: await this.local(request), notice: null, preview: true };
    }
    return this.search(request);
  }

  async search(request: SearchRequest): Promise<SearchOutcome> {
    if (request.mode === 'full-text') {
      return { source: 'device', hits: await this.local(request), notice: null };
    }
    await this.refresh();
    const meaning = this.deps.meaning ?? null;
    const filter = this.filterOf(request.filters);
    const answer = await meaning?.search(request.input, {
      limit: HYBRID_DEPTH,
      ...(filter ? { ids: [...this.indexed.keys()].filter((id) => this.passes(id, filter)) } : {}),
    });
    if (!meaning || !answer) {
      const why = meaning?.unavailable() ?? MEANING_ELSEWHERE;
      if (request.mode === 'semantic') return { source: 'device', hits: [], notice: why.semantic };
      return {
        source: 'device',
        hits: await this.local(request),
        notice: null,
        wordsOnly: why.wordsOnly,
      };
    }
    const limit = request.limit ?? DEFAULT_LIMIT;
    const index = this.index!;
    const byMeaning = (hit: (typeof answer.hits)[number]): SearchHit | null => {
      const doc = index.get(hit.id);
      if (!doc) return null;
      return {
        id: doc.id,
        title: doc.title,
        titleHighlighted: doc.title,
        snippet: hit.preview,
        heading: hit.heading,
        tags: doc.tags,
        updatedAt: doc.updatedAt,
        sources: ['semantic'],
      };
    };
    let hits: SearchHit[];
    if (request.mode === 'semantic') {
      hits = answer.hits.flatMap((hit) => byMeaning(hit) ?? []);
    } else {
      const words = await this.local({ ...request, limit: HYBRID_DEPTH });
      hits = fuseHybrid(words, answer.hits, answer.floor).flatMap(({ text, meaning: found }) => {
        if (!text) return found ? (byMeaning(found) ?? []) : [];
        return found
          ? { ...text, heading: found.heading, sources: ['full-text', 'semantic'] as const }
          : text;
      });
    }
    return { source: 'device', hits: hits.slice(0, limit), notice: meaning.coverage() };
  }

  /** Full-text search on this device only. */
  async local(request: SearchRequest): Promise<SearchHit[]> {
    await this.refresh();
    const index = this.index!;
    const filter = this.filterOf(request.filters);
    const query = parseQuery(request.input, { prefixLast: true });
    return index
      .search(query, {
        limit: request.limit ?? DEFAULT_LIMIT,
        // "moss" finds "Penmoss" too (Quanta feedback 3, item 3; A1126).
        infix: true,
        ...(filter ? { filter } : {}),
      })
      .map((hit) => ({ ...hit, heading: null, sources: ['full-text'] }));
  }

  /** Whether an indexed note passes `filter`. */
  private passes(id: string, filter: (doc: LocalSearchDocument) => boolean): boolean {
    const doc = this.index?.get(id);
    return doc !== undefined && filter(doc);
  }

  /** The folder, tag, date and open-notebook filters, or null when nothing is filtered. */
  private filterOf(filters: SearchFilters): ((doc: LocalSearchDocument) => boolean) | null {
    const { folderId, tag, updatedAfter } = filters;
    let inFolder: Set<string> | null = null;
    if (folderId) {
      const workspace = this.deps.workspace();
      const folders = folderSubtree(workspace.folders, folderId);
      inFolder = new Set(
        workspace.notes
          .filter((note) => note.folderId !== null && folders.has(note.folderId))
          .map((note) => note.id),
      );
    }
    const isOpen = this.openFilter();
    if (!inFolder && !isOpen && !tag && updatedAfter === null) return null;
    return (doc) =>
      (!inFolder || inFolder.has(doc.id)) &&
      (!isOpen || isOpen(doc.id)) &&
      (!tag || doc.tags.some((each) => tagMatches(each, tag))) &&
      (updatedAfter === null || doc.updatedAt >= updatedAfter);
  }

  /** Whether a note is in an open notebook (T43), or null with every notebook open. */
  private openFilter(): ((noteId: string) => boolean) | null {
    const closed = this.deps.closed?.() ?? new Set<string>();
    if (closed.size === 0) return null;
    const workspace = this.deps.workspace();
    const inOpen = openNotebookFilter(workspace.folders, closed);
    const folderOf = new Map(workspace.notes.map((note) => [note.id, note.folderId]));
    return (noteId) => inOpen(folderOf.get(noteId) ?? null);
  }

  private async doRefresh(): Promise<void> {
    this.stale = false;
    const store = await this.deps.store();
    // Records from before the search fields existed get them first (A119).
    await store.backfillSearchFields?.();
    const reserved = this.deps.reserved ?? new Set<string>();
    const slices: SliceOptions = {
      ...(this.deps.yieldToPage ? { yield: this.deps.yieldToPage } : {}),
      ...(this.deps.indexSlice ? { slice: this.deps.indexSlice } : {}),
    };
    let changed = false;
    if (!this.index) {
      const restored = await LocalSearchIndex.restore(
        await store.getState?.(SEARCH_INDEX_KEY),
        slices,
      );
      if (restored) {
        for (const doc of restored.documents()) this.indexed.set(doc.id, doc.updatedAt);
        this.index = restored;
      } else {
        const index = new LocalSearchIndex();
        const texts = (await store.listTexts?.()) ?? [];
        const docs = texts
          .filter((text) => !text.deleted && !reserved.has(text.noteId))
          .map(documentOf);
        await index.addAll(docs, slices);
        for (const doc of docs) this.indexed.set(doc.id, doc.updatedAt);
        this.index = index;
        if (store.listTexts) {
          this.scheduleSave(store);
          return;
        }
        changed = true;
      }
    }
    const index = this.index;
    const metas = await store.listMeta();
    const present = new Set<string>();
    const drop = (id: string) => {
      if (!this.indexed.has(id) && !index.has(id)) return;
      index.remove(id);
      this.indexed.delete(id);
      changed = true;
    };
    for (const meta of metas) {
      if (reserved.has(meta.noteId)) continue;
      if (meta.deleted) {
        drop(meta.noteId);
        continue;
      }
      if (this.indexed.get(meta.noteId) === meta.updatedAt) {
        present.add(meta.noteId);
        continue;
      }
      const record = await store.get(meta.noteId);
      // Listed but its record is gone or deleted: it leaves the index too.
      if (!record || record.deleted) {
        drop(meta.noteId);
        continue;
      }
      present.add(meta.noteId);
      index.add(documentOfRecord(record));
      this.indexed.set(meta.noteId, record.updatedAt);
      changed = true;
    }
    for (const id of [...this.indexed.keys()]) if (!present.has(id)) drop(id);
    if (changed) this.scheduleSave(store);
  }

  /** Saves the offline index a moment after it changed, so a burst of changes saves once. */
  private scheduleSave(store: SearchStore): void {
    if (!store.setState) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const index = this.index;
      if (!index) return;
      store.setState?.(SEARCH_INDEX_KEY, index.snapshot()).catch((error: unknown) => {
        console.warn('[search] could not save the offline index', error);
      });
    }, this.deps.saveDelayMs ?? SAVE_DELAY_MS);
  }
}
