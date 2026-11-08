/**
 * The offline full-text index (T22, A101): every note on this device, ranked
 * exactly as the server's D1 FTS5 ranks it, so an exact-word query returns
 * the same top results offline as online.
 *
 * Terms come from `@penmoss/core/search`, which cuts, folds and stems text
 * as FTS5's `porter unicode61 remove_diacritics 2` does. The dictionary is
 * MiniSearch's radix tree (`SearchableMap`: incremental inserts and deletes,
 * fast prefix walks); each term holds, per note, its count in each column.
 * Scoring is FTS5's bm25 (fts5_aux.c) over those counts with the shared
 * column weights, so scores match the server's to rounding. MiniSearch's own
 * `search()` is not used: its per-field BM25+ ranks differently from FTS5,
 * and FlexSearch keeps no term frequencies to rank with at all.
 *
 * A partly typed word (#120, A680) is completed from the notes' words as
 * written (folded, not stemmed: `words`, with how many notes hold each):
 * core's `completions` picks the whole words a prefix's stem cannot reach,
 * and each counts as one more phrase ORed with the prefix, as the server's
 * `notes_words` and FTS5 do.
 *
 * Phrases are checked against each candidate's text (kept for snippets).
 * `title:` clauses count the title column only and `-` clauses leave notes
 * out, as FTS5's column filters and NOT do (A117).
 *
 * Startup (A119): `addAll` builds in slices and `snapshot`/`restore` save the
 * index as plain arrays (IndexedDB stores them by structured clone), so
 * opening search neither tokenises every note again nor blocks the page.
 */
import {
  BM25_B,
  BM25_K1,
  completions,
  FTS_COLUMNS,
  FTS_WEIGHTS,
  highlight,
  MATCH_START,
  queryMatcher,
  snippet,
  searchText,
  stemTerm,
  tokenize,
  withCompletions,
  type QueryClause,
  type SearchQuery,
} from '@penmoss/core/search';
import SearchableMap from 'minisearch/SearchableMap';

/** One note as the offline index takes it. */
export interface LocalSearchDocument {
  readonly id: string;
  readonly title: string;
  /** The note's text, one line per block (the record's `text`). */
  readonly body: string;
  readonly tags: readonly string[];
  /** One heading per line. */
  readonly headings: string;
  readonly updatedAt: number;
}

export interface LocalSearchHit {
  readonly id: string;
  /** bm25, higher is better (the server's `rank` is its negative). */
  readonly score: number;
  readonly title: string;
  readonly titleHighlighted: string;
  readonly snippet: string;
  readonly tags: readonly string[];
  readonly updatedAt: number;
}

export interface LocalSearchOptions {
  readonly limit?: number;
  /** Applied after ranking, as the server's filters are (bm25's statistics stay whole-index). */
  readonly filter?: (doc: LocalSearchDocument) => boolean;
  /**
   * A term also matches the words holding it inside them (A1126): the app's search. Off, the
   * index ranks exactly as FTS5 does (A101).
   */
  readonly infix?: boolean;
}

/** Building or restoring in slices: what to await between them (the page gets a turn). */
export interface SliceOptions {
  /** Notes (or terms, when restoring) per slice. */
  readonly slice?: number;
  readonly yield?: () => Promise<void>;
}

/**
 * The saved form of an index. `format` changes whenever tokenising, stemming
 * or posting packing changes, so an old snapshot is rebuilt, never misread.
 */
export interface LocalIndexSnapshot {
  readonly format: number;
  readonly nextNumber: number;
  /** [number, document, row size in tokens]. */
  readonly docs: ReadonlyArray<readonly [number, LocalSearchDocument, number]>;
  /** [term, [number, packed counts, number, packed counts, …]]. */
  readonly terms: ReadonlyArray<readonly [string, readonly number[]]>;
  /** [word as written (folded), notes holding it] (A680). */
  readonly words: ReadonlyArray<readonly [string, number]>;
}

/** 2: the words as written, for completions (A680). */
export const LOCAL_INDEX_FORMAT = 2;
/** The shortest term matched inside longer words (A1126): shorter ones match too much. */
export const MIN_INFIX_LENGTH = 3;
/** How many words holding a term inside them it matches, the most common first (A1126). */
export const MAX_INFIX_WORDS = 24;

const DEFAULT_SLICE = 200;
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Entry {
  readonly doc: LocalSearchDocument;
  /** The four column texts, in FTS_COLUMNS order. */
  readonly columns: readonly string[];
  /** Tokens in all columns (FTS5's row size). */
  readonly length: number;
}

const COLUMN_WEIGHTS = FTS_COLUMNS.map((column) => FTS_WEIGHTS[column]);
/** Per-column counts share one number: 13 bits each, 52 bits in all. */
const COUNT_BASE = 8192;
const COUNT_MAX = COUNT_BASE - 1;
/** FTS5's smallest idf (a term in more than half the notes). */
const MIN_IDF = 1e-6;
const SNIPPET_TOKENS = 16;

function pack(counts: readonly number[]): number {
  let packed = 0;
  for (let column = counts.length - 1; column >= 0; column--) {
    packed = packed * COUNT_BASE + Math.min(counts[column]!, COUNT_MAX);
  }
  return packed;
}

/** Σ weight × count over the columns of a packed posting. */
function weighted(packed: number): number {
  let rest = packed;
  let sum = 0;
  for (const weight of COLUMN_WEIGHTS) {
    sum += weight * (rest % COUNT_BASE);
    rest = Math.floor(rest / COUNT_BASE);
  }
  return sum;
}

/** Σ weight × count over one column only (a `title:` clause). */
function weightedIn(packed: number, column: number): number {
  return COLUMN_WEIGHTS[column]! * (Math.floor(packed / COUNT_BASE ** column) % COUNT_BASE);
}

const TITLE_COLUMN = FTS_COLUMNS.indexOf('title');

function columnOf(clause: QueryClause): number | null {
  return clause.column === 'title' ? TITLE_COLUMN : null;
}

function columnsOf(doc: LocalSearchDocument): string[] {
  const values: Record<(typeof FTS_COLUMNS)[number], string> = {
    title: doc.title,
    body: doc.body,
    tags: doc.tags.join(' '),
    headings: doc.headings,
  };
  // The server indexes the same text without match markers (searchText, A118).
  return FTS_COLUMNS.map((column) => searchText(values[column]));
}

export class LocalSearchIndex {
  private readonly terms = new SearchableMap<Map<number, number>>();
  /** Each word as written (folded, not stemmed) and how many notes hold it (A680). */
  private readonly wordNotes = new Map<string, number>();
  /** The same words, for prefix walks (written only when a word comes or goes). */
  private readonly words = new SearchableMap<true>();
  private readonly entries = new Map<number, Entry>();
  private readonly numbers = new Map<string, number>();
  private nextNumber = 1;
  private totalTokens = 0;

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.numbers.has(id);
  }

  /** The document as indexed, if any. */
  get(id: string): LocalSearchDocument | undefined {
    const number = this.numbers.get(id);
    return number === undefined ? undefined : this.entries.get(number)?.doc;
  }

  /** Whether `word` (folded and stemmed as the index does) is a whole term of some note. */
  isTerm(word: string): boolean {
    const [token] = tokenize(word, { stem: false });
    return token !== undefined && this.terms.has(stemTerm(token.term));
  }

  /**
   * Whether `word` is still being typed: not a whole term of any note, but
   * the start of one ("sourd" while "sourdough" is indexed). A word the index
   * has never seen counts as finished.
   */
  unfinished(word: string): boolean {
    const [token] = tokenize(word, { stem: false });
    if (!token || this.terms.has(stemTerm(token.term))) return false;
    // A word typed past its stem (`happin`) starts a word as written, not a term (A680).
    return this.terms.atPrefix(token.term).size > 0 || this.words.atPrefix(token.term).size > 0;
  }

  /** Every indexed document. */
  *documents(): IterableIterator<LocalSearchDocument> {
    for (const entry of this.entries.values()) yield entry.doc;
  }

  /** Adds many notes, a slice at a time, awaiting `yield` between slices. */
  async addAll(docs: Iterable<LocalSearchDocument>, options: SliceOptions = {}): Promise<void> {
    const slice = options.slice ?? DEFAULT_SLICE;
    const pause = options.yield ?? nextTurn;
    let count = 0;
    for (const doc of docs) {
      this.add(doc);
      if (++count % slice === 0) await pause();
    }
  }

  /** The index as plain arrays, to save (structured-clone safe). */
  snapshot(): LocalIndexSnapshot {
    const docs: Array<readonly [number, LocalSearchDocument, number]> = [];
    for (const [number, entry] of this.entries) docs.push([number, entry.doc, entry.length]);
    const terms: Array<readonly [string, number[]]> = [];
    for (const [term, postings] of this.terms) {
      const flat: number[] = [];
      for (const [number, packed] of postings) flat.push(number, packed);
      terms.push([term, flat]);
    }
    const words = [...this.wordNotes];
    return { format: LOCAL_INDEX_FORMAT, nextNumber: this.nextNumber, docs, terms, words };
  }

  /** An index from a saved snapshot, restored in slices; null for another format or none. */
  static async restore(
    value: unknown,
    options: SliceOptions = {},
  ): Promise<LocalSearchIndex | null> {
    const saved = value as Partial<LocalIndexSnapshot> | null | undefined;
    if (
      !saved ||
      saved.format !== LOCAL_INDEX_FORMAT ||
      !(saved.docs instanceof Array) ||
      !(saved.terms instanceof Array) ||
      !(saved.words instanceof Array)
    ) {
      return null;
    }
    const snapshot = saved as LocalIndexSnapshot;
    const slice = (options.slice ?? DEFAULT_SLICE) * 10;
    const pause = options.yield ?? nextTurn;
    const index = new LocalSearchIndex();
    let count = 0;
    for (const [number, doc, length] of snapshot.docs) {
      index.entries.set(number, { doc, columns: columnsOf(doc), length });
      index.numbers.set(doc.id, number);
      index.totalTokens += length;
      if (++count % slice === 0) await pause();
    }
    for (const [term, flat] of snapshot.terms) {
      const postings = new Map<number, number>();
      for (let i = 0; i + 1 < flat.length; i += 2) postings.set(flat[i]!, flat[i + 1]!);
      index.terms.set(term, postings);
      if (++count % slice === 0) await pause();
    }
    for (const [word, notes] of snapshot.words) {
      index.wordNotes.set(word, notes);
      index.words.set(word, true);
      if (++count % slice === 0) await pause();
    }
    index.nextNumber = snapshot.nextNumber;
    return index;
  }

  /** Adds a note, replacing what was indexed for it. */
  add(doc: LocalSearchDocument): void {
    this.remove(doc.id);
    const number = this.nextNumber++;
    const columns = columnsOf(doc);
    const counts = new Map<string, number[]>();
    const words = new Set<string>();
    let length = 0;
    columns.forEach((text, column) => {
      for (const { term: word } of tokenize(text, { stem: false })) {
        const term = stemTerm(word);
        let perColumn = counts.get(term);
        if (!perColumn) counts.set(term, (perColumn = FTS_COLUMNS.map(() => 0)));
        perColumn[column]!++;
        words.add(word);
        length++;
      }
    });
    for (const word of words) {
      const notes = this.wordNotes.get(word) ?? 0;
      this.wordNotes.set(word, notes + 1);
      if (notes === 0) this.words.set(word, true);
    }
    for (const [term, perColumn] of counts) {
      let postings = this.terms.get(term);
      if (!postings) this.terms.set(term, (postings = new Map<number, number>()));
      postings.set(number, pack(perColumn));
    }
    this.numbers.set(doc.id, number);
    this.entries.set(number, { doc, columns, length });
    this.totalTokens += length;
  }

  remove(id: string): void {
    const number = this.numbers.get(id);
    if (number === undefined) return;
    const entry = this.entries.get(number)!;
    const words = new Set<string>();
    for (const text of entry.columns) {
      for (const { term: word } of tokenize(text, { stem: false })) {
        words.add(word);
        const term = stemTerm(word);
        const postings = this.terms.get(term);
        if (!postings) continue;
        postings.delete(number);
        if (postings.size === 0) this.terms.delete(term);
      }
    }
    for (const word of words) {
      const notes = (this.wordNotes.get(word) ?? 1) - 1;
      if (notes > 0) this.wordNotes.set(word, notes);
      else {
        this.wordNotes.delete(word);
        this.words.delete(word);
      }
    }
    this.entries.delete(number);
    this.numbers.delete(id);
    this.totalTokens -= entry.length;
  }

  clear(): void {
    this.terms.clear();
    this.wordNotes.clear();
    this.words.clear();
    this.entries.clear();
    this.numbers.clear();
    this.totalTokens = 0;
  }

  /**
   * The query with its prefixes' completions from this index's words (A680), and each word's
   * infixes when asked (Quanta feedback 3, item 3; A1126): a term of three letters or more matches
   * the words that hold it inside them, so "moss" finds "Penmoss". The most common
   * `MAX_INFIX_WORDS` such words join the term's completions, each a phrase ORed with it.
   */
  complete(query: SearchQuery, { infix = false }: { infix?: boolean } = {}): SearchQuery {
    const prefixed = withCompletions(query, (prefix) =>
      completions(prefix, this.words.atPrefix(prefix).keys()),
    );
    if (!infix) return prefixed;
    let changed = false;
    const clauses = prefixed.clauses.map((clause) => {
      if (clause.kind !== 'term' || clause.negated || clause.text.length < MIN_INFIX_LENGTH) {
        return clause;
      }
      const inside = this.infixWords(clause.text, clause.completions ?? []);
      if (inside.length === 0) return clause;
      changed = true;
      return { ...clause, completions: [...(clause.completions ?? []), ...inside] };
    });
    return changed ? { clauses } : prefixed;
  }

  /** Indexed words holding `part` past their start, most common first (A1126). */
  private infixWords(part: string, already: readonly string[]): string[] {
    const found: Array<[string, number]> = [];
    for (const [word, notes] of this.wordNotes) {
      if (word.length <= part.length || already.includes(word)) continue;
      if (word.indexOf(part, 1) === -1) continue;
      found.push([word, notes]);
    }
    found.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return found.slice(0, MAX_INFIX_WORDS).map(([word]) => word);
  }

  /**
   * Notes matching every clause, best first, with snippets. A prefix with
   * completions matches when any of its phrases does, and each phrase scores
   * on its own (its idf, its count), as FTS5's bm25 scores an OR.
   */
  search(input: SearchQuery, options: LocalSearchOptions = {}): LocalSearchHit[] {
    const limit = options.limit ?? 20;
    const query = this.complete(input, { infix: options.infix ?? false });
    const wanted = query.clauses.filter((clause) => !clause.negated);
    if (wanted.length === 0 || this.entries.size === 0) return [];
    const termCache = new Map<number, string[][]>();
    const hitsOf = (clause: QueryClause): Array<Map<number, number>> =>
      clause.kind === 'term'
        ? [
            this.termHits(stemTerm(clause.text), clause.prefix, columnOf(clause)),
            ...(clause.completions ?? []).map((word) =>
              this.termHits(stemTerm(word), false, columnOf(clause)),
            ),
          ]
        : [this.phraseHits(clause.texts.map(stemTerm), termCache, columnOf(clause))];
    const clausePhrases = wanted.map(hitsOf);
    // The notes each clause matches: any of its phrases.
    const clauseHits = clausePhrases.map((phrases) =>
      phrases.length === 1 ? phrases[0]! : new Set(phrases.flatMap((hits) => [...hits.keys()])),
    );
    const excluded = query.clauses.filter((clause) => clause.negated).map((c) => hitsOf(c)[0]!);
    const phrases = clausePhrases.flat();
    const n = this.entries.size;
    const avgdl = this.totalTokens / n;
    const idf = phrases.map((hits) => {
      const value = Math.log((0.5 + n - hits.size) / (0.5 + hits.size));
      return value <= 0 ? MIN_IDF : value;
    });
    const smallest = clauseHits.reduce((a, b) => (b.size < a.size ? b : a));
    const scored: Array<{ number: number; score: number; entry: Entry }> = [];
    for (const number of smallest.keys()) {
      if (!clauseHits.every((hits) => hits.has(number))) continue;
      if (excluded.some((hits) => hits.has(number))) continue;
      const entry = this.entries.get(number)!;
      if (options.filter && !options.filter(entry.doc)) continue;
      const norm = BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / avgdl);
      let score = 0;
      phrases.forEach((hits, i) => {
        const f = hits.get(number) ?? 0;
        score += (idf[i]! * (f * (BM25_K1 + 1))) / (f + norm);
      });
      scored.push({ number, score, entry });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        (a.entry.doc.id < b.entry.doc.id ? -1 : a.entry.doc.id > b.entry.doc.id ? 1 : 0),
    );
    const inTitle = queryMatcher(query, 'title');
    const inBody = queryMatcher(query, 'body');
    const inHeadings = queryMatcher(query, 'headings');
    return scored.slice(0, limit).map(({ score, entry }) => {
      const { doc, columns } = entry;
      const body = snippet(columns[1]!, inBody, SNIPPET_TOKENS);
      const headings = body.includes(MATCH_START)
        ? ''
        : snippet(columns[3]!, inHeadings, SNIPPET_TOKENS);
      return {
        id: doc.id,
        score,
        title: doc.title,
        titleHighlighted: highlight(doc.title, inTitle),
        snippet: headings.includes(MATCH_START) ? headings : body,
        tags: doc.tags,
        updatedAt: doc.updatedAt,
      };
    });
  }

  /** Each note holding the term (or a term it prefixes), with its weighted count. */
  private termHits(term: string, prefix: boolean, column: number | null): Map<number, number> {
    const hits = new Map<number, number>();
    const add = (postings: Map<number, number>) => {
      for (const [number, packed] of postings) {
        const value = column === null ? weighted(packed) : weightedIn(packed, column);
        if (value > 0) hits.set(number, (hits.get(number) ?? 0) + value);
      }
    };
    if (!prefix) {
      const postings = this.terms.get(term);
      if (postings) add(postings);
      return hits;
    }
    for (const [, postings] of this.terms.atPrefix(term)) add(postings);
    return hits;
  }

  /** Each note holding the phrase in one column, with its weighted count of occurrences. */
  private phraseHits(
    words: readonly string[],
    cache: Map<number, string[][]>,
    only: number | null,
  ): Map<number, number> {
    const hits = new Map<number, number>();
    const lists = words.map((word) => this.terms.get(word));
    if (lists.some((list) => !list)) return hits;
    const postings = lists as Array<Map<number, number>>;
    const smallest = postings.reduce((a, b) => (b.size < a.size ? b : a));
    for (const number of smallest.keys()) {
      if (!postings.every((list) => list.has(number))) continue;
      let columns = cache.get(number);
      if (!columns) {
        columns = this.entries
          .get(number)!
          .columns.map((text) => tokenize(text).map((token) => token.term));
        cache.set(number, columns);
      }
      let f = 0;
      columns.forEach((terms, column) => {
        if (only !== null && column !== only) return;
        let count = 0;
        for (let i = 0; i + words.length <= terms.length; i++) {
          let all = true;
          for (let j = 0; j < words.length; j++) {
            if (terms[i + j] !== words[j]) {
              all = false;
              break;
            }
          }
          if (all) count++;
        }
        f += COLUMN_WEIGHTS[column]! * count;
      });
      if (f > 0) hits.set(number, f);
    }
    return hits;
  }
}
