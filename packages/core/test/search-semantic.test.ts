import { describe, expect, it } from 'vitest';
import {
  FAKE_FLOOR,
  MATCH_START,
  MeaningIndex,
  MemoryVectorCache,
  VectorIndex,
  chunkKey,
  chunkNote,
  dot,
  fakeEmbedder,
  fuseHybrid,
  type Embedder,
  type MeaningNote,
  type NoteSection,
} from '../src/search';
import { UNRELATED } from './support/search-eval';
import { vaultDocuments } from './support/search-vault-docs';

const section = (heading: string | null, text: string, path: string[] = heading ? [heading] : []) =>
  ({ heading, path, text }) satisfies NoteSection;
const note = (
  id: string,
  title: string,
  sections: NoteSection[],
  version: number = 1,
): MeaningNote => ({
  id,
  version,
  title,
  sections,
});
const vector = (...values: number[]) => Float32Array.from(values);

/** Counts what reaches the embedder. */
function counting(inner: Embedder = fakeEmbedder()) {
  const embedded: string[] = [];
  const embedder: Embedder = {
    ...inner,
    embedQuery: (text) => inner.embedQuery(text),
    embedDocuments: (texts) => {
      embedded.push(...texts);
      return inner.embedDocuments(texts);
    },
  };
  return { embedder, embedded };
}

describe('the fake embedder (T71)', () => {
  it('is deterministic, unit length and closer for shared words', async () => {
    const embedder = fakeEmbedder();
    const [a, b, c] = await embedder.embedDocuments([
      'sourdough starter fed with flour',
      'feeding the sourdough starter',
      'firewall rules for the iot vlan',
    ]);
    expect(dot(a!, a!)).toBeCloseTo(1, 5);
    expect(await embedder.embedQuery('sourdough starter fed with flour')).toEqual(a);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });

  // It shares words, not meaning: 'saxophone reed strength' is near the strength-training note.
  it('keeps made-up words under its floor against the sample vault', async () => {
    const embedder = fakeEmbedder();
    const meaning = new MeaningIndex(embedder, new MemoryVectorCache());
    await meaning.update(vaultDocuments().map((doc) => note(doc.id, doc.title, doc.sections)));
    for (const query of UNRELATED.filter((q) => /zqx|xyzzy/.test(q))) {
      const [best] = await meaning.search(query);
      expect({ query, below: (best?.score ?? 0) < FAKE_FLOOR }).toEqual({ query, below: true });
    }
  });
});

describe('chunk keys (A1153)', () => {
  it('depend on the model and the text only', async () => {
    const key = await chunkKey('m', 'text');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await chunkKey('m', 'text')).toBe(key);
    expect(await chunkKey('other', 'text')).not.toBe(key);
    expect(await chunkKey('m', 'text!')).not.toBe(key);
  });

  it('change only for the first chunk when a note is renamed', async () => {
    const sections = [section(null, 'Intro text.'), section('Later', 'More text.')];
    const keys = (title: string) =>
      Promise.all(chunkNote(title, sections).map((c) => chunkKey('m', c.text)));
    const [before, after] = [await keys('Old title'), await keys('New title')];
    expect(before).toHaveLength(2);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });
});

describe('the vector index (T71)', () => {
  const chunk = (key: string, heading: string | null, values: number[]) => ({
    key,
    heading,
    preview: `preview ${key}`,
    vector: vector(...values),
  });

  it('answers each note once, at its best chunk, best first', () => {
    const index = new VectorIndex();
    index.set('a', [chunk('a1', 'One', [1, 0]), chunk('a2', 'Two', [0.6, 0.8])]);
    index.set('b', [chunk('b1', null, [0.8, 0.6])]);
    index.set('empty', []);
    const hits = index.search(vector(0, 1));
    expect(hits.map(({ id, heading, preview }) => ({ id, heading, preview }))).toEqual([
      { id: 'a', heading: 'Two', preview: 'preview a2' },
      { id: 'b', heading: null, preview: 'preview b1' },
    ]);
    expect(hits[0]!.score).toBeCloseTo(0.8, 5);
    expect(hits[1]!.score).toBeCloseTo(0.6, 5);
  });

  it('applies the filter and the limit, and forgets removed notes', () => {
    const index = new VectorIndex();
    index.set('a', [chunk('a1', null, [1, 0])]);
    index.set('b', [chunk('b1', null, [0.9, 0.1])]);
    index.set('c', [chunk('c1', null, [0.5, 0.5])]);
    expect(index.search(vector(1, 0), { filter: (id) => id !== 'a' }).map((h) => h.id)).toEqual([
      'b',
      'c',
    ]);
    expect(index.search(vector(1, 0), { limit: 1 }).map((h) => h.id)).toEqual(['a']);
    index.remove('a');
    expect(index.search(vector(1, 0)).map((h) => h.id)).toEqual(['b', 'c']);
    expect([...index.keys()].sort()).toEqual(['b1', 'c1']);
  });
});

describe('the meaning index (T71)', () => {
  const notes = [
    note('bread', 'Sourdough', [section(null, 'Feed the starter flour and water.')]),
    note('net', 'Network', [
      section('VLANs', 'IoT devices on their own VLAN.'),
      section('DNS', 'AdGuard filters ads.'),
    ]),
  ];

  it('embeds each chunk once, takes the rest from the cache, and reports coverage', async () => {
    const cache = new MemoryVectorCache();
    const first = counting();
    const meaning = new MeaningIndex(first.embedder, cache);
    expect(await meaning.update(notes)).toEqual({ indexed: 2, total: 2 });
    expect(first.embedded).toHaveLength(3);
    await meaning.update(notes);
    expect(first.embedded).toHaveLength(3);

    // Another process with the same cache embeds nothing.
    const second = counting();
    const again = new MeaningIndex(second.embedder, cache);
    expect(await again.update(notes)).toEqual({ indexed: 2, total: 2 });
    expect(second.embedded).toHaveLength(0);
    expect((await again.search('ads dns filter'))[0]).toMatchObject({ id: 'net', heading: 'DNS' });
  });

  it('re-embeds only the chunks an edit changed, and drops deleted notes', async () => {
    const { embedder, embedded } = counting();
    const meaning = new MeaningIndex(embedder, new MemoryVectorCache());
    await meaning.update(notes);
    const edited = note(
      'net',
      'Network',
      [section('VLANs', 'IoT devices on their own VLAN.'), section('DNS', 'Pi-hole now.')],
      2,
    );
    await meaning.update([notes[0]!, edited]);
    expect(embedded.slice(3)).toEqual(['DNS\n\nPi-hole now.']);
    expect(await meaning.update([edited])).toEqual({ indexed: 1, total: 1 });
    expect(meaning.index.has('bread')).toBe(false);
  });

  it('stops at its budget and carries on at the next update', async () => {
    const meaning = new MeaningIndex(fakeEmbedder({ delayMs: 30 }), new MemoryVectorCache());
    const many = Array.from({ length: 6 }, (_, i) =>
      note(`n${i}`, `Note ${i}`, [section(null, `text ${i}`)]),
    );
    const partial = await meaning.update(many, { budgetMs: 1, batch: 1 });
    expect(partial.total).toBe(6);
    expect(partial.indexed).toBeLessThan(6);
    expect(meaning.waiting).toBe(6 - partial.indexed);
    expect(await meaning.update(many)).toEqual({ indexed: 6, total: 6 });
  });

  it('only reads the cache when told not to embed', async () => {
    const { embedder, embedded } = counting();
    const meaning = new MeaningIndex(embedder, new MemoryVectorCache());
    expect(await meaning.update(notes, { embed: false })).toEqual({ indexed: 0, total: 2 });
    expect(embedded).toEqual([]);
    expect(await meaning.search('anything')).toEqual([]);
  });
});

describe('hybrid fusion (A1155)', () => {
  const text = (id: string, inTitle = false) => ({
    id,
    titleHighlighted: inTitle ? `${MATCH_START}${id}\u0003` : id,
  });
  const meaning = (id: string, score: number) => ({ id, score });

  it('fuses by reciprocal rank, each note once', () => {
    const fused = fuseHybrid([text('a'), text('b')], [meaning('b', 0.9), meaning('c', 0.8)], 0);
    expect(fused.map((hit) => hit.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0]).toEqual({ id: 'b', text: text('b'), meaning: meaning('b', 0.9) });
  });

  it('keeps a note found only by meaning only at or above the floor', () => {
    const fused = fuseHybrid(
      [text('a')],
      [meaning('b', 0.3), meaning('c', 0.29), meaning('a', 0.1)],
      0.3,
    );
    expect(fused.map((hit) => hit.id)).toEqual(['a', 'b']);
  });

  it('puts notes with a matched word in the title first', () => {
    const fused = fuseHybrid(
      [text('a'), text('b', true)],
      [meaning('a', 0.9), meaning('c', 0.9)],
      0,
    );
    expect(fused.map((hit) => hit.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('the meaning index at once (T75)', () => {
  it('embeds in one update at a time; another meanwhile only reads the cache', async () => {
    const { embedder, embedded } = counting(fakeEmbedder({ delayMs: 20 }));
    const meaning = new MeaningIndex(embedder, new MemoryVectorCache());
    const notes = Array.from({ length: 4 }, (_, i) =>
      note(`n${i}`, `Note ${i}`, [section(null, `text ${i}`)]),
    );
    // Either call may reach the embedder first (each hashes its chunks asynchronously): that one
    // embeds everything, the other only reads the cache, and no chunk is embedded twice.
    const answers = await Promise.all([
      meaning.update(notes, { batch: 1 }),
      meaning.update(notes, { batch: 1 }),
    ]);
    expect(answers.map((answer) => answer.total)).toEqual([4, 4]);
    expect(answers.map((answer) => answer.indexed)).toContain(4);
    expect(meaning.coverage()).toEqual({ indexed: 4, total: 4 });
    expect(embedded).toHaveLength(4);
  });
});
