import { describe, expect, it } from 'vitest';
import {
  COMPLETION_SCAN,
  MAX_COMPLETED_PREFIXES,
  MATCH_END,
  MATCH_START,
  MAX_COMPLETIONS,
  MIN_COMPLETION_LENGTH,
  compareCodePoints,
  completionPrefixes,
  completions,
  ftsMatch,
  highlight,
  parseQuery,
  queryMatcher,
  reciprocalRankFusion,
  searchText,
  searchWords,
  snippet,
  withCompletions,
  wordRange,
} from '../src/search';

describe('search queries (T22)', () => {
  it('reads words, quoted phrases and prefixes, folding them as the index does', () => {
    expect(parseQuery('Backup  "git mirror" plan*')).toEqual({
      clauses: [
        { kind: 'term', text: 'backup', prefix: false },
        { kind: 'phrase', texts: ['git', 'mirror'] },
        { kind: 'term', text: 'plan', prefix: true },
      ],
    });
    // A word written with punctuation is a phrase of its parts; diacritics fold away.
    expect(parseQuery('e-mail Café')).toEqual({
      clauses: [
        { kind: 'phrase', texts: ['e', 'mail'] },
        { kind: 'term', text: 'cafe', prefix: false },
      ],
    });
    expect(parseQuery('   ')).toEqual({ clauses: [] });
    expect(parseQuery('"unclosed phrase')).toEqual({
      clauses: [{ kind: 'phrase', texts: ['unclosed', 'phrase'] }],
    });
  });

  it('treats the last word as a prefix while typing, from two characters', () => {
    expect(parseQuery('garden pl', { prefixLast: true }).clauses.at(-1)).toEqual({
      kind: 'term',
      text: 'pl',
      prefix: true,
    });
    expect(parseQuery('garden p', { prefixLast: true }).clauses.at(-1)).toEqual({
      kind: 'term',
      text: 'p',
      prefix: false,
    });
    // A trailing space ends the word.
    expect(parseQuery('garden ', { prefixLast: true }).clauses).toEqual([
      { kind: 'term', text: 'garden', prefix: false },
    ]);
  });

  it('writes an FTS5 MATCH expression with every token quoted', () => {
    expect(ftsMatch(parseQuery('Backup "git mirror" plan* OR NOT'))).toBe(
      '"backup" "git mirror" "plan"* "or" "not"',
    );
    expect(ftsMatch(parseQuery(''))).toBeNull();
  });

  it('excludes words and phrases written with a leading minus, never matching them instead', () => {
    expect(parseQuery('backup -git -"cold ferment" e-mail').clauses).toEqual([
      { kind: 'term', text: 'backup', prefix: false },
      { kind: 'term', text: 'git', prefix: false, negated: true },
      { kind: 'phrase', texts: ['cold', 'ferment'], negated: true },
      { kind: 'phrase', texts: ['e', 'mail'] },
    ]);
    expect(ftsMatch(parseQuery('backup -git -"cold ferment" plan'))).toBe(
      '("backup" "plan") NOT "git" NOT "cold ferment"',
    );
    // Only exclusions: nothing to look for, so no match at all (never every other note).
    expect(ftsMatch(parseQuery('-git'))).toBeNull();
    // A lone minus is not an operator; the last word stays a prefix while typing.
    expect(parseQuery('- backup -gi', { prefixLast: true }).clauses).toEqual([
      { kind: 'term', text: 'backup', prefix: false },
      { kind: 'term', text: 'gi', prefix: false, negated: true },
    ]);
    const matches = queryMatcher(parseQuery('backup -git'));
    expect(matches('backup')).toBe(true);
    expect(matches('git')).toBe(false);
  });

  it('limits title: words and phrases to the title column', () => {
    expect(parseQuery('title:Backup title:"git mirror" Title:pl*').clauses).toEqual([
      { kind: 'term', text: 'backup', prefix: false, column: 'title' },
      { kind: 'phrase', texts: ['git', 'mirror'], column: 'title' },
      { kind: 'term', text: 'pl', prefix: true, column: 'title' },
    ]);
    expect(ftsMatch(parseQuery('title:backup -title:git restore'))).toBe(
      '(title : "backup" "restore") NOT title : "git"',
    );
    // Other prefixes are not columns: the word is read as written, as before.
    expect(parseQuery('body:x').clauses).toEqual([{ kind: 'phrase', texts: ['body', 'x'] }]);
    // Title words are marked in titles only.
    const query = parseQuery('title:backup restore');
    expect(queryMatcher(query, 'title')('backup')).toBe(true);
    expect(queryMatcher(query, 'body')('backup')).toBe(false);
    expect(queryMatcher(query, 'body')('restor')).toBe(true);
  });

  it('keeps a query to a bounded number of clauses', () => {
    const query = parseQuery(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '));
    expect(query.clauses).toHaveLength(12);
  });

  it('matches stemmed terms and prefixes', () => {
    const matches = queryMatcher(parseQuery('backups strat*'));
    expect(matches('backup')).toBe(true);
    expect(matches('strategi')).toBe(true);
    expect(matches('plan')).toBe(false);
  });
});

describe('snippets (T22)', () => {
  const marked = (text: string) => text.replaceAll(MATCH_START, '[').replaceAll(MATCH_END, ']');

  it('marks matched words in the best window of the text', () => {
    const text =
      'Intro words that do not matter at all here. Later the backup strategy relies on a git mirror that runs nightly. More text after.';
    const out = snippet(text, queryMatcher(parseQuery('backup mirror')), 12);
    expect(marked(out)).toBe(
      '…the [backup] strategy relies on a git [mirror] that runs nightly. More…',
    );
  });

  it('starts at the beginning when the match is there, and handles no match', () => {
    expect(marked(snippet('Backup notes daily', queryMatcher(parseQuery('backup')), 12))).toBe(
      '[Backup] notes daily',
    );
    expect(snippet('Nothing here', queryMatcher(parseQuery('backup')), 4)).toBe('Nothing here');
    expect(snippet('', queryMatcher(parseQuery('backup')), 4)).toBe('');
  });
});

describe('match markers in note text (T22)', () => {
  it('never lets a marker character in a note open or close a match', () => {
    const text = `a ${MATCH_START}b${MATCH_END} backup`;
    const matches = queryMatcher(parseQuery('backup'));
    const marked = (out: string) => out.replaceAll(MATCH_START, '[').replaceAll(MATCH_END, ']');
    expect(marked(highlight(text, matches))).toBe('a  b  [backup]');
    expect(marked(snippet(text, matches, 8))).toBe('…b  [backup]');
    expect(searchText(`x${MATCH_START}y${MATCH_END}z`)).toBe('x y z');
  });
});

describe('highlights (T22)', () => {
  it('marks every match in the whole text', () => {
    const out = highlight('Neapolitan pizza dough, more dough', queryMatcher(parseQuery('dough')));
    expect(out.replaceAll(MATCH_START, '[').replaceAll(MATCH_END, ']')).toBe(
      'Neapolitan pizza [dough], more [dough]',
    );
  });
});

describe('reciprocal rank fusion (T23)', () => {
  it('rewards items ranked well in both lists', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'a', 'd'],
    ]);
    expect(fused.map((item) => item.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(fused[0]).toEqual({ id: 'a', score: 1 / 61 + 1 / 62, ranks: [1, 2] });
    expect(fused.at(-1)).toEqual({ id: 'd', score: 1 / 63, ranks: [null, 3] });
  });

  it('breaks ties by the first list, then by id', () => {
    expect(reciprocalRankFusion([['x'], ['y']]).map((item) => item.id)).toEqual(['x', 'y']);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe('partly typed words (#120, A680)', () => {
  it('completes a prefix with the words whose stems its own stem cannot reach', () => {
    // The stem of what was typed is longer than the word's stem: `happin*` never reaches `happi`.
    expect(completions('happin', ['happiness', 'happinesses'])).toEqual(['happiness']);
    expect(completions('conditio', ['conditioning', 'conditioned'])).toEqual(['conditioned']);
    expect(
      completions('generati', ['generations', 'generation', 'generative', 'generating']),
    ).toEqual(['generating']);
    // Words the prefix's stem already reaches, and words that do not start with it, add nothing.
    expect(completions('happ', ['happiness', 'happy', 'happen'])).toEqual([]);
    expect(completions('happin', ['happy', 'zebra'])).toEqual([]);
    // A prefix that is itself a whole word: its stem (`happi`) misses the longer words.
    expect(completions('happy', ['happy', 'happyland'])).toEqual(['happyland']);
    // `tie*` reaches `tie` and `tier`, not `ties` and `tied` (stemmed `ti`).
    expect(completions('tie', ['tie', 'tied', 'tier', 'ties'])).toEqual(['tied']);
  });

  it('looks at the first words in code-point order, and keeps a bounded number', () => {
    // `happy` stems to `happi`, which reaches none of these (porter leaves them whole).
    const many = Array.from(
      { length: COMPLETION_SCAN },
      (_, i) => `happy${String(i).padStart(3, '0')}`,
    );
    expect(completions('happy', many.toReversed())).toEqual(many.slice(0, MAX_COMPLETIONS));
    // Only the first COMPLETION_SCAN words count: `ties` is the next one after them.
    const reached = Array.from(
      { length: COMPLETION_SCAN },
      (_, i) => `tie${String(i).padStart(3, '0')}`,
    );
    expect(completions('tie', [...reached.slice(1), 'ties'])).toEqual(['ties']);
    expect(completions('tie', [...reached, 'ties'])).toEqual([]);
    // UTF-8 (and SQLite's) order, not UTF-16's: U+FB01 sorts before U+1F600.
    expect(compareCodePoints('a\u{fb01}', 'a\u{1f600}')).toBeLessThan(0);
    expect(['a\u{1f600}', 'a\u{fb01}', 'a'].sort(compareCodePoints)).toEqual([
      'a',
      'a\u{fb01}',
      'a\u{1f600}',
    ]);
    expect(wordRange('happin')).toEqual(['happin', 'happin\u{10ffff}']);
  });

  it('asks for completions of prefix terms of three characters or more', () => {
    expect(completionPrefixes(parseQuery('garden happin', { prefixLast: true }))).toEqual([
      'happin',
    ]);
    expect(completionPrefixes(parseQuery('happin* happin* -tie ha*'))).toEqual(['happin']);
    expect(completionPrefixes(parseQuery('garden happin'))).toEqual([]);
    // Only the last MAX_COMPLETED_PREFIXES, in query order (review S2).
    expect(MAX_COMPLETED_PREFIXES).toBe(2);
    expect(completionPrefixes(parseQuery('abc* abd* abe* abf*'))).toEqual(['abe', 'abf']);
    const completed = withCompletions(parseQuery('abc* abd* abe*'), (prefix) => [`${prefix}ies`]);
    expect(completed.clauses.map((c) => (c.kind === 'term' ? c.completions : null))).toEqual([
      undefined,
      ['abdies'],
      ['abeies'],
    ]);
    expect(MIN_COMPLETION_LENGTH).toBe(3);
  });

  it('matches each completion as a whole word, in the prefix’s column, and marks it', () => {
    const query = withCompletions(parseQuery('lemon happin*'), (prefix) =>
      prefix === 'happin' ? ['happiness'] : [],
    );
    expect(query.clauses[1]).toEqual({
      kind: 'term',
      text: 'happin',
      prefix: true,
      completions: ['happiness'],
    });
    expect(ftsMatch(query)).toBe('"lemon" AND ("happin"* OR "happiness")');
    expect(ftsMatch(withCompletions(parseQuery('happin* -sad'), () => ['happiness']))).toBe(
      '(("happin"* OR "happiness")) NOT "sad"',
    );
    const titled = withCompletions(parseQuery('title:happin*'), () => ['happiness', 'happy']);
    expect(ftsMatch(titled)).toBe('title : ("happin"* OR "happiness" OR "happy")');
    const marks = queryMatcher(query);
    expect(marks('happi')).toBe(true);
    expect(marks('happinz')).toBe(true);
    expect(marks('hap')).toBe(false);
    expect(queryMatcher(titled, 'body')('happi')).toBe(false);
    expect(queryMatcher(titled, 'title')('happi')).toBe(true);
    // No completions, no change.
    expect(withCompletions(parseQuery('happin*'), () => [])).toEqual(parseQuery('happin*'));
  });

  it('lists a note’s distinct words, folded and not stemmed, for the completion index', () => {
    expect(searchWords(['Happiness and happiness', 'Café happiness', ''])).toEqual([
      'happiness',
      'and',
      'cafe',
    ]);
  });
});
