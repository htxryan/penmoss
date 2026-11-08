/**
 * Search by meaning (T71, D59, A1155): the pieces every process shares, with no runtime. An
 * `Embedder` turns text into unit vectors (EmbeddingGemma on the Mac, `@penmoss/embed`; the fake
 * below in tests); a `VectorCache` keeps them by chunk key; a `VectorIndex` holds the open
 * notebooks' chunks and finds each note's best one; `MeaningIndex` keeps the two in step with the
 * notes; `fuseHybrid` merges meaning with the words' ranking.
 */
import { MATCH_START } from './snippet';
import { reciprocalRankFusion } from './rrf';
import { chunkNote, type NoteSection } from './sections';
import { terms } from './tokenize';

export interface Embedder {
  /**
   * The model, its revision, dimensions and prompts in one id (e.g.
   * `embeddinggemma-300m-q4@5090578d/768/p1`): part of every chunk key, so changing any of them
   * embeds everything again.
   */
  readonly model: string;
  readonly dimensions: number;
  /** The cosine a note found only by meaning needs to show in hybrid search (A1155). */
  readonly floor: number;
  embedQuery(text: string): Promise<Float32Array>;
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
}

/** Vectors by chunk key (A1153). Missing keys are simply absent from `get`'s answer. */
export interface VectorCache {
  get(keys: readonly string[]): Promise<Map<string, Float32Array>>;
  put(entries: ReadonlyMap<string, Float32Array>): Promise<void>;
}

/** A cache in memory: tests, and a process with nowhere to keep vectors. */
export class MemoryVectorCache implements VectorCache {
  readonly vectors = new Map<string, Float32Array>();

  get(keys: readonly string[]): Promise<Map<string, Float32Array>> {
    const found = new Map<string, Float32Array>();
    for (const key of keys) {
      const vector = this.vectors.get(key);
      if (vector) found.set(key, vector);
    }
    return Promise.resolve(found);
  }

  put(entries: ReadonlyMap<string, Float32Array>): Promise<void> {
    for (const [key, vector] of entries) this.vectors.set(key, vector);
    return Promise.resolve();
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** A chunk's key (A1153): SHA-256 of the model id and the chunk's text, in hex. */
export async function chunkKey(model: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${model}\n${text}`),
  );
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += HEX[byte];
  return hex;
}

/** `vector` scaled to length 1 (a zero vector stays zero). */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

/** The dot product: cosine similarity for unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** FNV-1a, for the fake embedder's feature hashing. */
function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const FAKE_DIMENSIONS = 1024;
/**
 * The fake embedder's floor (A571's, kept): made-up words score at most about 0.10 against the
 * sample vault and its labelled notes' median is about 0.30.
 */
export const FAKE_FLOOR = 0.2;

/**
 * A deterministic stand-in for a real model (the server's A105, revived): stemmed words and
 * their character trigrams hashed into 1,024 signed dimensions, then normalised. Texts that share
 * words land close together, which is all tests need of "meaning". `delayMs` makes each call slow,
 * for tests of indexing in the background.
 */
export function fakeEmbedder(options: { delayMs?: number } = {}): Embedder {
  const embed = (text: string) => {
    const vector = new Float32Array(FAKE_DIMENSIONS);
    const add = (feature: string, weight: number) => {
      const hash = fnv(feature);
      vector[hash % FAKE_DIMENSIONS]! += hash & 0x80000000 ? -weight : weight;
    };
    for (const term of terms(text)) {
      add(term, 1);
      const padded = ` ${term} `;
      for (let i = 0; i + 3 <= padded.length; i++) add(`#${padded.slice(i, i + 3)}`, 0.3);
    }
    return normalize(vector);
  };
  const later = <T>(value: T) =>
    options.delayMs
      ? new Promise<T>((resolve) => setTimeout(() => resolve(value), options.delayMs))
      : Promise.resolve(value);
  return {
    model: 'fake-hash-1024',
    dimensions: FAKE_DIMENSIONS,
    floor: FAKE_FLOOR,
    embedQuery: (text) => later(embed(text)),
    embedDocuments: (texts) => later(texts.map(embed)),
  };
}

/** One chunk of a note in the index. */
export interface IndexedChunk {
  readonly key: string;
  /** The section's heading (a hit opens the note there); null before the first heading. */
  readonly heading: string | null;
  /** The start of the section's text, for a result's snippet. */
  readonly preview: string;
  readonly vector: Float32Array;
}

/** A note found by meaning: its best chunk's cosine, heading and preview. */
export interface MeaningHit {
  readonly id: string;
  readonly score: number;
  readonly heading: string | null;
  readonly preview: string;
}

export interface MeaningSearchOptions {
  /** At most this many notes (default 50, the depth hybrid fuses). */
  readonly limit?: number;
  /** Only notes this accepts (folder, tag and date filters). */
  readonly filter?: (id: string) => boolean;
}

/** The depth of each list hybrid fuses (the server's HYBRID_DEPTH). */
export const HYBRID_DEPTH = 50;

/** Every note's chunks in memory, searched by a scan: a few thousand chunks take milliseconds. */
export class VectorIndex {
  private readonly notes = new Map<string, readonly IndexedChunk[]>();

  set(id: string, chunks: readonly IndexedChunk[]): void {
    this.notes.set(id, chunks);
  }

  remove(id: string): void {
    this.notes.delete(id);
  }

  has(id: string): boolean {
    return this.notes.has(id);
  }

  ids(): IterableIterator<string> {
    return this.notes.keys();
  }

  get size(): number {
    return this.notes.size;
  }

  /** The keys of every chunk held: what a cache's collection keeps (A1157). */
  keys(): Set<string> {
    const keys = new Set<string>();
    for (const chunks of this.notes.values()) for (const chunk of chunks) keys.add(chunk.key);
    return keys;
  }

  search(query: Float32Array, options: MeaningSearchOptions = {}): MeaningHit[] {
    const limit = options.limit ?? HYBRID_DEPTH;
    const hits: MeaningHit[] = [];
    for (const [id, chunks] of this.notes) {
      if (chunks.length === 0 || (options.filter && !options.filter(id))) continue;
      let best: IndexedChunk | undefined;
      let bestScore = -Infinity;
      for (const chunk of chunks) {
        const score = dot(query, chunk.vector);
        if (score > bestScore) {
          bestScore = score;
          best = chunk;
        }
      }
      hits.push({ id, score: bestScore, heading: best!.heading, preview: best!.preview });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return hits.slice(0, limit);
  }
}

/** A note as meaning reads it: its title and its body's heading sections (A1154). */
export interface MeaningNote {
  readonly id: string;
  /** Changes whenever the note's text does (a revision or an update time); skips unchanged notes. */
  readonly version: string | number;
  readonly title: string;
  readonly sections: readonly NoteSection[];
}

export interface MeaningCoverage {
  /** Notes whose every chunk has a vector. */
  readonly indexed: number;
  /** Notes meaning should cover. */
  readonly total: number;
}

export interface UpdateOptions {
  /** Stop embedding after about this long (ms); the rest waits for the next update. */
  readonly budgetMs?: number;
  /** Chunks a call to the embedder (default 8). */
  readonly batch?: number;
  readonly signal?: AbortSignal;
  /** False: only take vectors the cache already has, embedding nothing (A1157's readers). */
  readonly embed?: boolean;
}

/** One note's chunks, waiting for vectors. */
interface Pending {
  readonly version: string | number;
  readonly chunks: ReadonlyArray<{
    readonly key: string;
    readonly text: string;
    readonly heading: string | null;
    readonly preview: string;
  }>;
}

/**
 * Keeps a `VectorIndex` in step with a set of notes: chunks each note, takes what the cache has,
 * embeds the rest within a budget, and drops notes that are gone. Indexing is incremental: a note
 * whose `version` is unchanged is not chunked again, and an unchanged chunk is never embedded twice.
 */
export class MeaningIndex {
  readonly index = new VectorIndex();
  private readonly versions = new Map<string, string | number>();
  private readonly pending = new Map<string, Pending>();
  private total = 0;
  /** An update is embedding: one that starts meanwhile only takes what the cache has. */
  private embedding = false;

  constructor(
    readonly embedder: Embedder,
    readonly cache: VectorCache,
  ) {}

  coverage(): MeaningCoverage {
    return { indexed: this.index.size, total: this.total };
  }

  /** Brings the index up to `notes` (every note meaning should cover), within the budget. */
  async update(
    notes: Iterable<MeaningNote>,
    options: UpdateOptions = {},
  ): Promise<MeaningCoverage> {
    const started = Date.now();
    const live = new Set<string>();
    let total = 0;
    for (const note of notes) {
      total++;
      live.add(note.id);
      if (this.versions.get(note.id) === note.version && this.index.has(note.id)) continue;
      if (this.pending.get(note.id)?.version === note.version) continue;
      const chunks = await Promise.all(
        chunkNote(note.title, note.sections).map(async (chunk) => ({
          key: await chunkKey(this.embedder.model, chunk.text),
          text: chunk.text,
          heading: chunk.heading,
          preview: chunk.preview,
        })),
      );
      this.pending.set(note.id, { version: note.version, chunks });
    }
    for (const id of [...this.index.ids()]) if (!live.has(id)) this.forget(id);
    for (const id of [...this.pending.keys()]) if (!live.has(id)) this.pending.delete(id);
    this.total = total;
    await this.fill(started, options);
    return this.coverage();
  }

  /** Notes still waiting for vectors. */
  get waiting(): number {
    return this.pending.size;
  }

  async search(query: string, options: MeaningSearchOptions = {}): Promise<MeaningHit[]> {
    if (this.index.size === 0) return [];
    return this.index.search(await this.embedder.embedQuery(query), options);
  }

  private forget(id: string): void {
    this.index.remove(id);
    this.versions.delete(id);
  }

  private async fill(started: number, options: UpdateOptions): Promise<void> {
    const known = new Map<string, Float32Array>();
    const allKeys = [...this.pending.values()].flatMap((note) => note.chunks.map((c) => c.key));
    for (const [key, vector] of await this.cache.get(allKeys)) known.set(key, vector);
    const settle = () => {
      for (const [id, note] of this.pending) {
        if (!note.chunks.every((chunk) => known.has(chunk.key))) continue;
        this.index.set(
          id,
          note.chunks.map((chunk) => ({
            key: chunk.key,
            heading: chunk.heading,
            preview: chunk.preview,
            vector: known.get(chunk.key)!,
          })),
        );
        this.versions.set(id, note.version);
        this.pending.delete(id);
      }
    };
    settle();
    if (options.embed === false || this.embedding) return;
    this.embedding = true;
    try {
      await this.embedMissing(started, options, known, settle);
    } finally {
      this.embedding = false;
    }
  }

  private async embedMissing(
    started: number,
    options: UpdateOptions,
    known: Map<string, Float32Array>,
    settle: () => void,
  ): Promise<void> {
    const batch = options.batch ?? 8;
    const missing = new Map<string, string>();
    for (const note of this.pending.values())
      for (const chunk of note.chunks)
        if (!known.has(chunk.key)) missing.set(chunk.key, chunk.text);
    const queue = [...missing];
    while (queue.length > 0) {
      if (options.signal?.aborted) break;
      if (options.budgetMs !== undefined && Date.now() - started >= options.budgetMs) break;
      const slice = queue.splice(0, batch);
      const vectors = await this.embedder.embedDocuments(slice.map(([, text]) => text));
      const fresh = new Map<string, Float32Array>();
      slice.forEach(([key], i) => {
        known.set(key, vectors[i]!);
        fresh.set(key, vectors[i]!);
      });
      await this.cache.put(fresh);
      settle();
    }
  }
}

/** A words hit as fusion needs it: its title, highlighted, tells whether a word matched there. */
export interface FusableTextHit {
  readonly id: string;
  readonly titleHighlighted?: string;
}

export interface FusedHit<T, M> {
  readonly id: string;
  readonly text: T | undefined;
  readonly meaning: M | undefined;
}

/**
 * Hybrid search (A1155, after the server's T23 and A571, A905): the words' and meaning's lists
 * fused by reciprocal rank fusion; a note found only by meaning stays when its best chunk is at
 * least `floor` similar; notes with a matched word in the title come first.
 */
export function fuseHybrid<
  T extends FusableTextHit,
  M extends { readonly id: string; readonly score: number },
>(textHits: readonly T[], meaningHits: readonly M[], floor: number): Array<FusedHit<T, M>> {
  const byText = new Map(textHits.map((hit) => [hit.id, hit]));
  const byMeaning = new Map(meaningHits.map((hit) => [hit.id, hit]));
  const fused = reciprocalRankFusion([
    textHits.map((hit) => hit.id),
    meaningHits.map((hit) => hit.id),
  ])
    .map(({ id }) => ({ id, text: byText.get(id), meaning: byMeaning.get(id) }))
    .filter(({ text, meaning }) => text !== undefined || (meaning?.score ?? -Infinity) >= floor);
  const inTitle = (hit: FusedHit<T, M>) =>
    hit.text?.titleHighlighted?.includes(MATCH_START) ?? false;
  return [...fused.filter(inTitle), ...fused.filter((hit) => !inTitle(hit))];
}
