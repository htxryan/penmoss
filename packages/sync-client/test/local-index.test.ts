/// <reference types="node" />
import 'fake-indexeddb/auto';
/**
 * The offline index ranks as SQLite's FTS5 does (T22): the same notes, the same order and the
 * same bm25 scores as the FTS5 tables the server used to search with (its migrations 0006 and
 * 0011, kept here as the reference since the server went, T59), for every word of the sample
 * vault and the ranking fixture.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  COMPLETION_SCAN,
  completionPrefixes,
  completions,
  ftsMatch,
  MATCH_END,
  MATCH_START,
  parseQuery,
  searchWords,
  terms,
  withCompletions,
  wordRange,
} from '@penmoss/core/search';
import { beforeAll, describe, expect, it } from 'vitest';
import { RANKING_CASES } from '../../core/test/support/search-ranking';
import { vaultDocuments } from '../../core/test/support/search-vault-docs';
import * as Y from '@y/y';
import { NoteStore } from '../src/idb';
import { LocalSearchIndex, type LocalSearchDocument } from '../src/local-index';
import { recordFromDoc } from '../src/records';
import { NOTE_ROOT } from '../src/replica';

const docs: LocalSearchDocument[] = vaultDocuments().map((doc) => ({
  id: doc.id,
  title: doc.title,
  body: doc.text,
  tags: doc.tags,
  headings: doc.headings,
  updatedAt: doc.updatedAt,
}));

/**
 * The reference: FTS5's notes_fts (porter stems, the server's bm25 weights) and notes_words (the
 * words as written, for completions, A680), as the server's migrations 0006 and 0011 made them,
 * holding the vault and queried as the server queried them: completions first.
 */
function serverIndex(notes: readonly LocalSearchDocument[]) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE notes (docid INTEGER PRIMARY KEY, id TEXT NOT NULL);
    CREATE VIRTUAL TABLE notes_fts USING fts5(
      title, body, tags, headings,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    INSERT INTO notes_fts (notes_fts, rank) VALUES ('rank', 'bm25(10.0, 1.0, 5.0, 4.0)');
    CREATE VIRTUAL TABLE notes_words USING fts5(
      words,
      tokenize = 'unicode61 remove_diacritics 2',
      detail = none,
      content = '',
      contentless_delete = 1
    );
    CREATE VIRTUAL TABLE notes_words_vocab USING fts5vocab(notes_words, 'row');
  `);
  const note = db.prepare('INSERT INTO notes (id) VALUES (?) RETURNING docid');
  const fts = db.prepare(
    'INSERT INTO notes_fts (rowid, title, body, tags, headings) VALUES (?, ?, ?, ?, ?)',
  );
  const words = db.prepare('INSERT INTO notes_words (rowid, words) VALUES (?, ?)');
  for (const doc of notes) {
    const { docid } = note.get(doc.id) as { docid: number };
    const columns = [doc.title, doc.body, doc.tags.join(' '), doc.headings];
    fts.run(docid, ...columns);
    words.run(docid, searchWords(columns).join(' '));
  }
  const statement = db.prepare(
    `SELECT n.id AS id, -rank AS score FROM notes_fts JOIN notes n ON n.docid = notes_fts.rowid
     WHERE notes_fts MATCH ? ORDER BY rank`,
  );
  const vocab = db.prepare(
    'SELECT term FROM notes_words_vocab WHERE term >= ? AND term < ? ORDER BY term LIMIT ?',
  );
  const complete = (input: string) => {
    const query = parseQuery(input);
    const found = new Map<string, readonly string[]>();
    for (const prefix of completionPrefixes(query)) {
      const [from, to] = wordRange(prefix);
      const rows = vocab.all(from, to, COMPLETION_SCAN) as Array<{ term: string }>;
      found.set(
        prefix,
        completions(
          prefix,
          rows.map((row) => row.term),
        ),
      );
    }
    return withCompletions(query, (prefix) => found.get(prefix) ?? []);
  };
  const search = (input: string) =>
    statement.all(ftsMatch(complete(input)) ?? '""') as Array<{ id: string; score: number }>;
  return Object.assign(search, { complete });
}

/** Each word of six letters or more cut short: after 3 and 4 letters, and 1 to 3 before its end. */
function partials(words: readonly string[]): string[] {
  const out = new Set<string>();
  for (const word of words) {
    const folded = terms(word).length === 1 ? word.toLowerCase() : '';
    if (!/^\p{L}{6,}$/u.test(folded)) continue;
    for (const length of [3, 4, folded.length - 3, folded.length - 2, folded.length - 1]) {
      out.add(folded.slice(0, length));
    }
  }
  return [...out];
}

describe('the offline index (T22)', () => {
  let local: LocalSearchIndex;
  let server: ReturnType<typeof serverIndex>;
  beforeAll(() => {
    local = new LocalSearchIndex();
    for (const doc of docs) local.add(doc);
    server = serverIndex(docs);
  });

  const localIds = (input: string, limit = 100) =>
    local.search(parseQuery(input), { limit }).map((hit) => hit.id);

  it('ranks the vault as the regression fixture says', () => {
    for (const { query, top } of RANKING_CASES) {
      expect({ query, top: localIds(query).slice(0, top.length) }).toEqual({ query, top });
    }
  });

  it('finds the same notes with the same bm25 scores as FTS5, for every word in the vault', () => {
    const words = [...new Set(docs.flatMap((doc) => doc.body.split(/\s+/)))];
    const queries = [
      ...words,
      ...words.slice(0, 200).map((word, i) => `${word} ${words[(i * 7) % words.length]}`),
      ...words.filter((word) => word.length > 4).map((word) => `${word.slice(0, 3)}*`),
      '"the server"',
      '"cold ferment"',
      '"every night"',
      // Title-only words and phrases, and exclusions (A117).
      ...words.slice(0, 150).map((word) => `title:${word}`),
      ...words.slice(0, 150).map((word, i) => `${word} -${words[(i * 11) % words.length]}`),
      ...words.slice(0, 50).map((word, i) => `title:${word} ${words[(i * 5) % words.length]}`),
      'title:"pizza dough"',
      'dough -title:pizza',
      'backup -"git mirror"',
      'title:back*',
      // Partly typed words (#120, A680): every word cut short, as typed, alone, after a word
      // and in titles only.
      ...partials(words).map((part) => `${part}*`),
      ...partials(words)
        .slice(0, 100)
        .map((part, i) => `${words[(i * 13) % words.length]} ${part}*`),
      ...partials(words)
        .slice(0, 100)
        .map((part) => `title:${part}*`),
    ];
    let compared = 0;
    let completed = 0;
    for (const query of queries) {
      if (parseQuery(query).clauses.length === 0) continue;
      if (server.complete(query).clauses.some((c) => c.kind === 'term' && c.completions)) {
        completed++;
      }
      const theirs = server(query);
      const mine = local.search(parseQuery(query), { limit: 1000 });
      expect({ query, ids: mine.map((h) => h.id).sort() }).toEqual({
        query,
        ids: theirs.map((h) => h.id).sort(),
      });
      const byId = new Map(theirs.map((hit) => [hit.id, hit.score]));
      for (const hit of mine) expect(hit.score).toBeCloseTo(byId.get(hit.id)!, 9);
      // Same order wherever the scores differ (FTS5 leaves exact ties unordered).
      for (let i = 1; i < mine.length; i++) {
        if (Math.abs(mine[i - 1]!.score - mine[i]!.score) > 1e-9) {
          expect(byId.get(mine[i - 1]!.id)!).toBeGreaterThan(byId.get(mine[i]!.id)!);
        }
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
    // Partly typed words the prefix alone missed, compared with FTS5's OR (A680).
    expect(completed).toBeGreaterThan(50);
  });

  it('leaves excluded notes out and marks title: words only in titles', () => {
    expect(localIds('backup -git')).toEqual(['zfs-snapshots', 'offsite-backup']);
    expect(localIds('-backup')).toEqual([]);
    const [hit] = local.search(parseQuery('title:dough'));
    expect(hit?.id).toBe('pizza-dough');
    expect(hit!.titleHighlighted).toContain(`${MATCH_START}dough${MATCH_END}`);
    expect(hit!.snippet).not.toContain(MATCH_START);
  });

  it('knows which words are whole terms of the index (a finished word, not a prefix)', () => {
    expect(local.isTerm('Backups')).toBe(true);
    expect(local.isTerm('backu')).toBe(false);
    expect(local.isTerm('zanzibar')).toBe(false);
    expect(local.unfinished('sourd')).toBe(true);
    expect(local.unfinished('Sourdough')).toBe(false);
    expect(local.unfinished('zanzibar')).toBe(false);
    expect([...local.documents()].map((doc) => doc.id).sort()).toEqual(
      docs.map((doc) => doc.id).sort(),
    );
  });

  it('saves to a plain snapshot and restores in slices, searching exactly as before', async () => {
    const snapshot = structuredClone(local.snapshot());
    let yields = 0;
    const restored = await LocalSearchIndex.restore(snapshot, {
      slice: 7,
      yield: () => {
        yields++;
        return Promise.resolve();
      },
    });
    expect(restored).not.toBeNull();
    expect(yields).toBeGreaterThan(5);
    expect(restored!.size).toBe(local.size);
    for (const query of ['backup', 'sourd*', '"cold ferment"', 'title:dough', 'garden -tomato']) {
      expect(restored!.search(parseQuery(query))).toEqual(local.search(parseQuery(query)));
    }
    restored!.remove('pests');
    expect(restored!.search(parseQuery('aphids'))).toEqual([]);
    // Another format (a tokenizer change) is not restored: the index is built again.
    expect(await LocalSearchIndex.restore({ ...snapshot, format: -1 })).toBeNull();
    expect(await LocalSearchIndex.restore(undefined)).toBeNull();

    const built = new LocalSearchIndex();
    let slices = 0;
    await built.addAll(docs, {
      slice: 10,
      yield: () => {
        slices++;
        return Promise.resolve();
      },
    });
    expect(slices).toBeGreaterThanOrEqual(5);
    expect(built.search(parseQuery('backup'))).toEqual(local.search(parseQuery('backup')));
  });

  it('marks matches in the title and snippet, from the headings when the body has none', () => {
    const marked = (text: string) => text.replaceAll(MATCH_START, '[').replaceAll(MATCH_END, ']');
    const [oil] = local.search(parseQuery('oil change'));
    expect(oil?.id).toBe('car-maintenance');
    expect(marked(oil!.snippet)).toContain('Synthetic [oil] [changed] at 45,000 miles');
    expect(marked(local.search(parseQuery('dough'))[0]!.titleHighlighted)).toBe(
      'Neapolitan pizza [dough]',
    );
    expect(marked(local.search(parseQuery('levain'))[0]!.snippet)).toContain('[levain]');
  });

  it('filters after ranking and honours the limit', () => {
    const homelab = local.search(parseQuery('backup'), {
      filter: (doc) => doc.tags.includes('homelab'),
    });
    expect(homelab.map((hit) => hit.id).sort()).toEqual([
      'git-mirror',
      'offsite-backup',
      'zfs-snapshots',
    ]);
    expect(localIds('garden', 2)).toEqual(['pests', 'watering']);
  });

  it('updates and removes notes in place', () => {
    const index = new LocalSearchIndex();
    for (const doc of docs) index.add(doc);
    const before = index.search(parseQuery('backup')).map((hit) => hit.score);
    index.add({ ...docs[0]!, body: 'Nothing about Zanzibar any more.' });
    expect(index.search(parseQuery('nightly')).map((hit) => hit.id)).toEqual([]);
    expect(index.search(parseQuery('zanzibar')).map((hit) => hit.id)).toEqual([docs[0]!.id]);
    index.add(docs[0]!);
    expect(index.search(parseQuery('backup')).map((hit) => hit.score)).toEqual(before);
    index.remove('pests');
    expect(index.size).toBe(docs.length - 1);
    expect(index.search(parseQuery('aphids'))).toEqual([]);
    // A removed note leaves nothing behind: its words find nothing in what remains.
    const solo = new LocalSearchIndex();
    solo.add(docs[0]!);
    solo.add(docs[1]!);
    solo.remove(docs[0]!.id);
    expect(solo.size).toBe(1);
    expect(solo.search(parseQuery('github'))).toEqual([]);
    const own = new Set(terms(docs[1]!.body));
    const gone = terms(docs[0]!.body).filter((term) => !own.has(term));
    expect(gone.length).toBeGreaterThan(10);
  });
});

describe('partly typed words (#120, A680)', () => {
  const notes: LocalSearchDocument[] = [
    {
      id: 'joy',
      title: 'Happiness',
      body: 'Notes on happiness, and on being happy',
      tags: [],
      headings: '',
      updatedAt: 1,
    },
    {
      id: 'gym',
      title: 'Training',
      body: 'Conditioning work for three generations of runners',
      tags: ['fitness'],
      headings: 'Conditioning',
      updatedAt: 2,
    },
    {
      id: 'family',
      title: 'Family tree',
      body: 'Four generations, and the ties that bind them',
      tags: [],
      headings: '',
      updatedAt: 3,
    },
    {
      id: 'garden',
      title: 'Garden',
      body: 'Planting tomatoes, generally in May',
      tags: ['garden'],
      headings: '',
      updatedAt: 4,
    },
    // Notes without them, so each word is in fewer than half (bm25's idf).
    ...['Boiler service', 'Bread', 'Car insurance', 'Dentist', 'Holiday', 'Taxes'].map(
      (title, i) => ({
        id: `other-${i}`,
        title,
        body: `${title} reminders for the year`,
        tags: [],
        headings: '',
        updatedAt: 10 + i,
      }),
    ),
  ];
  const local = new LocalSearchIndex();
  for (const note of notes) local.add(note);
  const server = serverIndex(notes);
  const PARTS: ReadonlyArray<readonly [string, string]> = [
    ['happin', 'happiness'],
    ['conditio', 'conditioning'],
    ['generati', 'generations'],
    ['plantin', 'planting'],
    ['tie', 'ties'],
  ];

  it('finds what the whole word finds, with the server’s order and scores', () => {
    for (const [typed, word] of PARTS) {
      const typing = parseQuery(typed, { prefixLast: true });
      const mine = local.search(typing);
      expect({ typed, ids: mine.map((hit) => hit.id) }).toEqual({
        typed,
        ids: local.search(parseQuery(word)).map((hit) => hit.id),
      });
      expect(mine.length).toBeGreaterThan(0);
      // FTS5 leaves exact ties unordered: compare each note's score.
      const theirs = new Map(server(`${typed}*`).map((hit) => [hit.id, hit.score]));
      expect(mine.map((hit) => hit.id).sort()).toEqual([...theirs.keys()].sort());
      for (const hit of mine) expect(hit.score).toBeCloseTo(theirs.get(hit.id)!, 9);
    }
    // After another word, and in titles only.
    expect(
      local.search(parseQuery('runners conditio', { prefixLast: true })).map((h) => h.id),
    ).toEqual(['gym']);
    expect(local.search(parseQuery('title:happin*')).map((hit) => hit.id)).toEqual(['joy']);
    expect(local.search(parseQuery('title:conditio*'))).toEqual([]);
    expect(server.complete('happin*').clauses[0]).toMatchObject({ completions: ['happiness'] });
    expect(server.complete('happ*').clauses[0]).not.toHaveProperty('completions');
  });

  it('marks the whole words it found', () => {
    const marked = (text: string) => text.replaceAll(MATCH_START, '[').replaceAll(MATCH_END, ']');
    const [joy] = local.search(parseQuery('happin', { prefixLast: true }));
    expect(marked(joy!.titleHighlighted)).toBe('[Happiness]');
    expect(marked(joy!.snippet)).toBe('…on [happiness], and on being [happy]');
  });

  it('says a partly typed word is unfinished, from the words as written', () => {
    expect(local.unfinished('happin')).toBe(true);
    expect(local.unfinished('conditio')).toBe(true);
    expect(local.unfinished('happiness')).toBe(false);
    expect(local.unfinished('zanzib')).toBe(false);
  });

  it('keeps the words through a snapshot, and forgets a removed note’s', async () => {
    const restored = await LocalSearchIndex.restore(structuredClone(local.snapshot()));
    expect(restored!.search(parseQuery('generati*'))).toEqual(
      local.search(parseQuery('generati*')),
    );
    // A snapshot from before the words (format 1) is built again.
    expect(await LocalSearchIndex.restore({ ...local.snapshot(), format: 1 })).toBeNull();
    restored!.remove('joy');
    expect(restored!.search(parseQuery('happin*'))).toEqual([]);
    expect(restored!.unfinished('happin')).toBe(false);
  });
});

describe('search fields in records (T22)', () => {
  it('stores the headings with each record, and lists them with the text and tags', async () => {
    const doc = new Y.Doc();
    const root = doc.get(NOTE_ROOT);
    const heading = new Y.Node('heading');
    heading.setAttr('level', 2);
    const paragraph = new Y.Node('paragraph');
    root.push([heading, paragraph]);
    heading.insert(0, 'Restoring');
    paragraph.insert(0, 'Clone the #backup repository');
    const record = recordFromDoc('n1', doc, { epoch: null, unsynced: false, updatedAt: 5 });
    expect(record.headings).toBe('Restoring');
    const store = await NoteStore.open(`penmoss-search-${Date.now()}`);
    try {
      await store.put(record);
      expect(await store.listTexts()).toEqual([
        {
          noteId: 'n1',
          title: '',
          text: 'Restoring\nClone the #backup repository',
          headings: 'Restoring',
          tags: ['backup'],
          updatedAt: 5,
          deleted: false,
        },
      ]);
    } finally {
      store.close();
    }
  });
});

// Quanta feedback 3, item 3 (A1126): "moss" found nothing, though notes say "Penmoss".
describe('words inside words (A1126)', () => {
  const index = new LocalSearchIndex();
  const note = (id: string, title: string, body: string): LocalSearchDocument => ({
    id,
    title,
    body,
    tags: [],
    headings: '',
    updatedAt: 1,
  });
  beforeAll(async () => {
    await index.addAll([
      note('a', 'Quanta Penmoss Feedback', 'Things to fix in Penmoss'),
      note('b', 'Moss garden', 'Moss between the stones'),
      note('c', 'Shopping', 'Bread and milk'),
      note('d', 'Holiday', 'Trains to the coast'),
    ]);
  });

  it('matches a term inside longer words, as well as the word itself', () => {
    const hits = index.search(parseQuery('moss'), { infix: true });
    expect(hits.map((hit) => hit.id).sort()).toEqual(['a', 'b']);
    const penmoss = hits.find((hit) => hit.id === 'a')!;
    expect(penmoss.titleHighlighted).toBe(`Quanta ${MATCH_START}Penmoss${MATCH_END} Feedback`);
  });

  it('matches while typing too, and not for terms under three letters', () => {
    expect(
      index.search(parseQuery('mos', { prefixLast: true }), { infix: true }).map((hit) => hit.id),
    ).toContain('a');
    expect(index.search(parseQuery('mo'), { infix: true }).map((hit) => hit.id)).not.toContain('a');
  });

  it('keeps FTS5’s exact matching unless asked (A101)', () => {
    expect(index.search(parseQuery('moss')).map((hit) => hit.id)).toEqual(['b']);
  });

  it('leaves out notes a minus word holds inside a word', () => {
    expect(index.search(parseQuery('garden -moss'), { infix: true })).toEqual([]);
  });
});
