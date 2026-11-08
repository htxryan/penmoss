/// <reference types="node" />
/**
 * The phone's offline search against core's (T40 P6, FD4, A462, review B1 and S6). Two files:
 *
 * - apps/android/contract/search-fold-v1.json: unicode61's tables (`unicode-table.ts`, read from
 *   SQLite) and the folded words core's `tokenize(text, { stem: false })` makes of sample text:
 *   each character of the Latin, Greek, Cyrillic, punctuation, CJK punctuation, full-width and
 *   some astral blocks between two letters, and sentences of punctuation agents write. The Kotlin
 *   `SearchFoldTest` holds `SearchFold` to the same tables and the same words.
 * - apps/android/contract/search-ranking-v1.json: notes (title, body, tags, headings), queries,
 *   and the ids and bm25 scores the web's `LocalSearchIndex` ranks them with (A101: the server's
 *   order). The Kotlin `SearchRankingContractTest` indexes the same notes in Room and expects
 *   the same order and scores. A query with `prefixLast` is read as typed: its last word a
 *   prefix, completed from the notes' words (#120, A680).
 *
 * The fold file also holds core's `completions` (A680) for sample prefixes and words, which the
 * Kotlin `SearchCompletions` must give exactly.
 *
 * After changing core's search, write the files again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test search-contract`,
 * then `pnpm exec prettier --write apps/android/contract/search-*-v1.json`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMPLETION_SCAN,
  FOLD_EXCEPTIONS,
  SEPARATOR_RANGES,
  completions,
  parseQuery,
  stemTerm,
  tokenize,
} from '@penmoss/core/search';
import { LocalSearchIndex, type LocalSearchDocument } from '@penmoss/sync-client/local-index';
import { describe, expect, it } from 'vitest';
import foldContract from '../../contract/search-fold-v1.json';
import rankingContract from '../../contract/search-ranking-v1.json';

const BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x80, 0x24f], // Latin-1, Latin Extended-A and -B
  [0x250, 0x2ff], // IPA, spacing modifiers
  [0x300, 0x36f], // combining marks
  [0x370, 0x3ff], // Greek
  [0x400, 0x4ff], // Cyrillic
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // General Punctuation
  [0x20a0, 0x20bf], // currency
  [0x2100, 0x214f], // letterlike
  [0x2190, 0x21ff], // arrows
  [0x3000, 0x303f], // CJK punctuation
  [0xfb00, 0xfb06], // ligatures
  [0xff00, 0xff65], // full-width
  [0x1d400, 0x1d433], // mathematical bold
  [0x1f600, 0x1f64f], // emoji
];

const SENTENCES = [
  'Ryan’s garden',
  'foo—bar notes',
  'non breaking space',
  '“quoted” words',
  'ellipsis…next',
  'Café Éclair éclair ÉCLAIR',
  'agents’ “memory” — one–two… «three» ‹four›',
  'naïve coöperate façade Ångström Øre Straße',
  'ﬁne ﬂour ½ ² ℃ №',
  'Ⅻ ⅻ ①②',
  'Привет, МИР! Ёлка',
  'Ελληνικά ΆΈΉ ς σ',
  '日本語の文章、テスト。カタカナ',
  'emoji 😀 split 👍🏽 here',
  'tab\tnew\nline sep　wide',
  'İstanbul ǅemal ﬀ',
  'áb c̈d',
  '\u0002marked\u0003 text',
];

function sampleCharacters(): string[] {
  const out: string[] = [];
  for (const [from, to] of BLOCKS) {
    for (let cp = from; cp <= to; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      out.push(`a${String.fromCodePoint(cp)}b`);
    }
  }
  return out;
}

/**
 * Terms for the porter step (review R4): English suffixes from Porter's paper, words with
 * digits (phone numbers, SHAs, ids), long words, and non-Latin runs, which FTS4's own porter
 * would cut short.
 */
const STEM_WORDS = [
  'caresses',
  'ponies',
  'ties',
  'caress',
  'cats',
  'feed',
  'agreed',
  'plastered',
  'bled',
  'motoring',
  'sing',
  'conflated',
  'troubled',
  'sized',
  'hopping',
  'tanned',
  'falling',
  'hissing',
  'fizzed',
  'failing',
  'filing',
  'happy',
  'sky',
  'relational',
  'conditional',
  'rational',
  'valenci',
  'hesitanci',
  'digitizer',
  'conformabli',
  'radicalli',
  'differentli',
  'vileli',
  'analogousli',
  'vietnamization',
  'predication',
  'operator',
  'feudalism',
  'decisiveness',
  'hopefulness',
  'callousness',
  'formaliti',
  'sensitiviti',
  'sensibiliti',
  'triplicate',
  'formative',
  'formalize',
  'electriciti',
  'electrical',
  'hopeful',
  'goodness',
  'revival',
  'allowance',
  'inference',
  'airliner',
  'gyroscopic',
  'adjustable',
  'defensible',
  'irritant',
  'replacement',
  'adjustment',
  'dependent',
  'adoption',
  'homologou',
  'communism',
  'activate',
  'angulariti',
  'homologous',
  'effective',
  'bowdlerize',
  'probate',
  'rate',
  'cease',
  'controll',
  'roll',
  'yellow',
  'yes',
  'by',
  'say',
  'syzygy',
  'gardens',
  'planted',
  'generalizations',
  'counterrevolutionaries',
  'counterrevolution',
  'internationalization',
  '5551234567',
  '555123',
  '555999567',
  '07f7c6f',
  '07f7c',
  '07fc6f',
  'rh12345',
  'rh123',
  '2026',
  'v1',
  'abc123def456ghi789',
  'naive',
  'cafes',
  'façades',
  'jalapeños',
  'достопримечательности',
  'достопримечательн',
  'ελληνικά',
  'καλημέρες',
  '我们今天去公园散步',
  '我们今天',
  'カタカナ',
  'ｆｕｌｌｗｉｄｔｈ',
  'straße',
  'œuvres',
];

/**
 * Prefixes and the words they are completed from (A680): the issue's cases, a prefix that is a
 * whole word, words porter cuts below the prefix, non-Latin and astral words (code-point order),
 * and more words than the scan looks at.
 */
const COMPLETION_CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['happin', ['happiness', 'happinesses', 'happy']],
  ['conditio', ['conditioning', 'conditioned', 'condition', 'conditional']],
  ['generati', ['generations', 'generation', 'generative', 'generating', 'general']],
  ['happ', ['happiness', 'happy', 'happen']],
  ['happy', ['happy', 'happyland', 'happyhour']],
  ['tie', ['tie', 'tied', 'tier', 'ties', 'tiebreak']],
  ['plantin', ['planting', 'plantings']],
  ['gardeni', ['gardening', 'gardenia', 'gardenias']],
  ['agre', ['agree', 'agreed', 'agreement']],
  ['skie', ['skies', 'skied', 'skier']],
  ['caf', ['cafe', 'cafes', 'cafeteria']],
  ['достопримечат', ['достопримечательности', 'достопримечательность']],
  ['happy', ['happy\u{1f600}', 'happy\u{fb01}', 'happy']],
  ['zzz', ['zzz']],
  ['ab', Array.from({ length: COMPLETION_SCAN + 8 }, (_, i) => `ab${String(i).padStart(3, '0')}`)],
  [
    'happy',
    Array.from({ length: COMPLETION_SCAN + 8 }, (_, i) => `happy${String(i).padStart(3, '0')}`),
  ],
];

function foldContractNow() {
  const words = (text: string) => tokenize(text, { stem: false }).map((token) => token.term);
  return {
    version: 1,
    separatorRanges: SEPARATOR_RANGES,
    foldExceptions: FOLD_EXCEPTIONS,
    /** Each text, and its folded words joined by spaces. */
    cases: [...SENTENCES, ...sampleCharacters()].map((text) => [text, words(text).join(' ')]),
    /** Each folded term and core's `stemTerm` of it (the porter step both sides index with). */
    stems: [...new Set(STEM_WORDS.flatMap(words))].map((term) => [term, stemTerm(term)]),
    /** Each prefix, the words it is completed from, and core's `completions` of it (A680). */
    completions: COMPLETION_CASES.map(([prefix, from]) => [
      prefix,
      from,
      completions(prefix, from),
    ]),
  };
}

const NOTES: readonly LocalSearchDocument[] = [
  {
    id: 'n01',
    title: 'Garden plan',
    body: 'Tomatoes along the fence.\nBasil by the door.',
    tags: ['garden'],
    headings: '',
    updatedAt: 1,
  },
  {
    id: 'n02',
    title: 'Groceries',
    body: 'Oat milk, lemons, and basil',
    tags: ['shopping'],
    headings: '',
    updatedAt: 2,
  },
  {
    id: 'n03',
    title: 'Lemon tart',
    body: 'Desserts\nA recipe with lemons and butter',
    tags: ['baking', 'area/kitchen'],
    headings: 'Desserts',
    updatedAt: 3,
  },
  {
    id: 'n04',
    title: 'Weekly review',
    body: 'lemon tart and other things; the garden is growing',
    tags: [],
    headings: '',
    updatedAt: 4,
  },
  {
    id: 'n05',
    title: 'Ryan’s notes',
    body: 'Ryan’s garden — the agents’ “memory” is here…next time',
    tags: ['memory'],
    headings: '',
    updatedAt: 5,
  },
  {
    id: 'n06',
    title: 'Café Éclair',
    body: 'Pastry list: éclair, croissant, tart',
    tags: ['baking'],
    headings: '',
    updatedAt: 6,
  },
  {
    id: 'n07',
    title: 'Trip to Lisbon',
    body: 'Train to Lisbon then the coast road',
    tags: ['travel'],
    headings: 'Day one\nDay two',
    updatedAt: 7,
  },
  {
    id: 'n08',
    title: 'Notes',
    body: 'the coast and then a train',
    tags: [],
    headings: '',
    updatedAt: 8,
  },
  {
    id: 'n09',
    title: 'Lisbon guide',
    body: 'Where to eat in Lisbon: pastéis de nata',
    tags: ['travel', 'food'],
    headings: 'Eating',
    updatedAt: 9,
  },
  {
    id: 'n10',
    title: 'Planting',
    body: 'Planting the gardens in spring; planted garlic',
    tags: ['garden'],
    headings: 'Spring',
    updatedAt: 10,
  },
  {
    id: 'n11',
    title: 'Kitchen',
    body: 'Kitchen\nThe kitchen tap drips',
    tags: ['area/kitchen', 'home'],
    headings: 'Kitchen',
    updatedAt: 11,
  },
  {
    id: 'n12',
    title: 'Home lab',
    body: 'Proxmox node, backups, UPS',
    tags: ['home', 'home-lab'],
    headings: 'Hardware\nBackups',
    updatedAt: 12,
  },
  {
    id: 'n13',
    title: 'Backups',
    body: 'Backups run nightly; restore drill monthly',
    tags: ['home-lab'],
    headings: '',
    updatedAt: 13,
  },
  {
    id: 'n14',
    title: 'Meeting notes',
    body: 'Agenda\nBudget review and the memory project',
    tags: ['work'],
    headings: 'Agenda',
    updatedAt: 14,
  },
  {
    id: 'n15',
    title: 'Budget',
    body: 'Shared budget, ToniSplit, weekly true-up',
    tags: ['money'],
    headings: '',
    updatedAt: 15,
  },
  {
    id: 'n16',
    title: 'Reading list',
    body: 'Books: the garden of forking paths; a memory of light',
    tags: ['books'],
    headings: '',
    updatedAt: 16,
  },
  {
    id: 'n17',
    title: 'Recipes',
    body: 'Soups\nTomato soup with basil\nStews\nBeef stew',
    tags: ['food', 'soup'],
    headings: 'Soups\nStews',
    updatedAt: 17,
  },
  { id: 'n18', title: 'Soup', body: 'soup soup soup', tags: ['soup'], headings: '', updatedAt: 18 },
  {
    id: 'n19',
    title: 'Naïve ideas',
    body: 'A naive façade; coöperate',
    tags: [],
    headings: '',
    updatedAt: 19,
  },
  { id: 'n20', title: 'Привет', body: 'Привет мир, garden', tags: [], headings: '', updatedAt: 20 },
  {
    id: 'n21',
    title: 'Long note',
    body: 'garden '.repeat(3) + 'filler '.repeat(120),
    tags: [],
    headings: '',
    updatedAt: 21,
  },
  {
    id: 'n22',
    title: 'Train times',
    body: 'The 7:15 train; trains run hourly',
    tags: ['travel'],
    headings: '',
    updatedAt: 22,
  },
  {
    id: 'n23',
    title: 'Coast walk',
    body: 'Coast path, road closed',
    tags: ['travel', 'walks'],
    headings: 'Route',
    updatedAt: 23,
  },
  {
    id: 'n24',
    title: 'Basil',
    body: 'Basil basil',
    tags: ['garden', 'herbs'],
    headings: 'Basil care',
    updatedAt: 24,
  },
  { id: 'n25', title: 'Empty', body: '', tags: [], headings: '', updatedAt: 25 },
  {
    id: 'n26',
    title: 'Tags only',
    body: 'nothing here',
    tags: ['lemon', 'garden'],
    headings: '',
    updatedAt: 26,
  },
  {
    id: 'n27',
    title: 'Headings',
    body: 'Lemons\nBasil\nnotes',
    tags: [],
    headings: 'Lemons\nBasil',
    updatedAt: 27,
  },
  {
    id: 'n28',
    title: 'Memory',
    body: 'Penmoss holds the agents’ memory',
    tags: ['memory', 'penmoss'],
    headings: '',
    updatedAt: 28,
  },
  {
    id: 'n29',
    title: 'Dashes',
    body: 'one—two three–four five-six',
    tags: [],
    headings: '',
    updatedAt: 29,
  },
  {
    id: 'n30',
    title: 'Same score a',
    body: 'unique tie word',
    tags: [],
    headings: '',
    updatedAt: 30,
  },
  {
    id: 'n31',
    title: 'Same score b',
    body: 'unique tie word',
    tags: [],
    headings: '',
    updatedAt: 31,
  },
  // Words FTS4's porter would cut short (review R4): digits, long words, long CJK runs.
  {
    id: 'n32',
    title: 'Call back',
    body: 'Phone 5551234567 after lunch',
    tags: [],
    headings: '',
    updatedAt: 32,
  },
  {
    id: 'n33',
    title: 'Release',
    body: 'Fixed in commit 07f7c6f, ticket rh12345',
    tags: [],
    headings: '',
    updatedAt: 33,
  },
  {
    id: 'n34',
    title: 'History',
    body: 'The counterrevolutionaries regrouped',
    tags: [],
    headings: '',
    updatedAt: 34,
  },
  { id: 'n35', title: '日记', body: '我们今天去公园散步', tags: [], headings: '', updatedAt: 35 },
  {
    id: 'n36',
    title: 'Москва',
    body: 'Достопримечательности города',
    tags: [],
    headings: '',
    updatedAt: 36,
  },
  {
    id: 'n37',
    title: 'Numbers',
    body: 'Phone 5559991234 and commit 07fc6f00',
    tags: [],
    headings: '',
    updatedAt: 37,
  },
  // Words typed past their stems (#120, A680): happin(ess), conditio(ning), generati(ons).
  {
    id: 'n38',
    title: 'Happiness',
    body: 'Notes on happiness, and on being happy',
    tags: [],
    headings: '',
    updatedAt: 38,
  },
  {
    id: 'n39',
    title: 'Training',
    body: 'Conditioning work for three generations of runners',
    tags: ['fitness'],
    headings: 'Conditioning',
    updatedAt: 39,
  },
  {
    id: 'n40',
    title: 'Family tree',
    body: 'Four generations, and the ties that bind them; generally happy',
    tags: ['family'],
    headings: '',
    updatedAt: 40,
  },
];

const QUERIES = [
  'garden',
  'basil',
  'lemon',
  'lemon tart',
  '"lemon tart"',
  'title:lemon',
  'lisbon train',
  '"coast road"',
  'lisb*',
  'garden -planting',
  'ryan',
  'éclair',
  'ECLAIR',
  'memory',
  'kitchen',
  'desserts',
  'soup',
  'backups',
  'naive',
  'привет',
  'two',
  'tie',
  'travel',
  'home',
  'gardening',
  // Review R4: prefixes of long words and words with digits, and whole words that differ from
  // a held word only past FTS4's cut (no note holds 555999567 or 07fc6f).
  '555123*',
  '07f7c*',
  'rh123*',
  'counterrevolution*',
  'counterrevolutionaries',
  '我们今天*',
  'достопримечательн*',
  '555999567',
  '07fc6f',
  '5551234567',
  // #120 (A680): a prefix typed past the word's stem matches the whole word's stem too.
  'happin*',
  'conditio*',
  'generati*',
  'title:happin*',
  'tie*',
  'plantin*',
  // Only the last two prefixes are completed (MAX_COMPLETED_PREFIXES): `happin*` matches as before.
  'happin* tie* generati*',
  'gener* tie* happin*',
];

/** Queries as typed (`prefixLast`): the last word a prefix, completed (A680). */
const TYPED = [
  'happin',
  'runners conditio',
  '-happy generati',
  'lemon ta',
  'gardeni',
  'title:conditio',
  'ha',
];

function rankingContractNow() {
  const index = new LocalSearchIndex();
  for (const note of NOTES) index.add(note);
  return {
    version: 1,
    notes: NOTES.map(({ id, title, body, tags, headings }) => ({
      id,
      title,
      body,
      tags,
      headings,
    })),
    queries: [
      ...QUERIES.map((query) => ({ query, prefixLast: false })),
      ...TYPED.map((query) => ({ query, prefixLast: true })),
    ].map(({ query, prefixLast }) => ({
      query,
      ...(prefixLast ? { prefixLast } : {}),
      hits: index
        .search(parseQuery(query, { prefixLast }), { limit: 10 })
        .map((hit) => ({ id: hit.id, score: Number(hit.score.toFixed(9)) })),
    })),
  };
}

function write(name: string, value: unknown) {
  // Run from the package, as `pnpm --filter` does.
  writeFileSync(
    resolve(process.cwd(), `../contract/${name}`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

describe('search contracts v1', () => {
  it('fold: core’s tables and the words tokenize makes, exactly', () => {
    const expected = foldContractNow();
    if (process.env['PENMOSS_WRITE_CONTRACTS']) write('search-fold-v1.json', expected);
    expect(foldContract).toEqual(expected);
  });

  it('ranking: LocalSearchIndex’s order and scores over the notes, exactly', () => {
    const expected = rankingContractNow();
    if (process.env['PENMOSS_WRITE_CONTRACTS']) write('search-ranking-v1.json', expected);
    expect(rankingContract).toEqual(expected);
  });

  it('covers the cases the review names', () => {
    const words = new Map(foldContractNow().cases.map(([text, folded]) => [text, folded]));
    expect(words.get('Ryan’s garden')).toBe('ryan s garden');
    expect(words.get('foo—bar notes')).toBe('foo bar notes');
    expect(words.get('Café Éclair éclair ÉCLAIR')).toBe('cafe eclair eclair eclair');
  });
});
