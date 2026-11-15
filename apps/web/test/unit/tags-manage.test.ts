import { describe, expect, it } from 'vitest';
import {
  deleteCount,
  describedAfter,
  mergeChanges,
  mergeCounts,
  mergedDescription,
  mergeProblem,
  renameProblem,
  rowMatches,
  tagList,
  tagRows,
} from '../../src/tags/manage';

// The Tags page's sums (finding 8 of Ryan's review of #192): its rows, and what a rename, merge
// or delete will do, worked out before anything changes.

const notes = [
  ['development', 'dev'],
  ['dev'],
  ['dev-notes'],
  ['penmoss/review'],
  ['penmoss', 'penmoss/factory'],
];

describe('the Tags page’s rows and sums', () => {
  it('has one row per tag and level, sorted, with counts and what is nested under each', () => {
    const rows = tagRows(notes);
    expect(rows.map((row) => row.tag)).toEqual([
      'dev',
      'dev-notes',
      'development',
      'penmoss',
      'penmoss/factory',
      'penmoss/review',
    ]);
    expect(rows.find((row) => row.tag === 'penmoss')).toEqual({
      tag: 'penmoss',
      parent: '',
      name: 'penmoss',
      count: 2,
      own: 1,
      nested: ['penmoss/factory', 'penmoss/review'],
    });
    expect(rows.find((row) => row.tag === 'penmoss/review')).toMatchObject({
      parent: 'penmoss/',
      name: 'review',
      count: 1,
      nested: [],
    });
  });

  it('filters by name and by description', () => {
    const [dev] = tagRows([['dev']]);
    expect(rowMatches(dev!, '', 'de')).toBe(true);
    expect(rowMatches(dev!, 'Engineering work', 'engineer')).toBe(true);
    expect(rowMatches(dev!, '', 'cloud')).toBe(false);
  });

  it('counts a merge’s notes, those that had the target already among them', () => {
    expect(mergeCounts(notes, ['dev', 'dev-notes'], 'development')).toEqual({
      retagged: 2,
      had: 1,
      after: 3,
    });
    expect(deleteCount(notes, ['penmoss'])).toBe(2);
    expect(deleteCount(notes, ['dev', 'dev-notes'])).toBe(3);
  });

  it('refuses names that are not tags, and a move inside itself', () => {
    expect(renameProblem('dev', 'two words')).toMatch(/Spaces/);
    expect(renameProblem('dev', 'dev/inner')).toBe('#dev cannot move inside itself.');
    expect(renameProblem('dev', '#Engineering')).toBeNull();
    expect(mergeProblem(['penmoss', 'penmoss/review'], 'penmoss/review')).toMatch(
      /inside #penmoss/,
    );
    expect(mergeProblem(['penmoss', 'penmoss/review'], 'penmoss')).toBeNull();
    expect(mergeChanges(['dev', 'development', 'dev-notes'], 'development')).toEqual([
      { from: 'dev', to: 'development' },
      { from: 'dev-notes', to: 'development' },
    ]);
    expect(tagList(['a', 'b', 'c'])).toBe('#a, #b and #c');
  });

  it('moves descriptions with a rename, keeps a merge target’s, and drops a deleted tag’s', () => {
    const descriptions = {
      development: 'Engineering work',
      dev: 'Short for it',
      penmoss: 'The app',
      'penmoss/review': 'Review rounds',
    };
    // A rename takes its description along, with those of the tags inside it.
    expect(describedAfter(descriptions, [{ from: 'penmoss', to: 'app' }])).toEqual({
      penmoss: '',
      app: 'The app',
      'penmoss/review': '',
      'app/review': 'Review rounds',
    });
    // One level only: the nested tag's stays.
    expect(describedAfter(descriptions, [{ from: 'penmoss', to: 'app', nested: false }])).toEqual({
      penmoss: '',
      app: 'The app',
    });
    // A merge keeps the target's; the merged tag's goes.
    expect(describedAfter(descriptions, mergeChanges(['dev'], 'development'))).toEqual({
      dev: '',
    });
    // Into a tag without one: it takes the first merged tag's that has one.
    expect(
      describedAfter(descriptions, mergeChanges(['dev-notes', 'dev', 'development'], 'new')),
    ).toEqual({ dev: '', development: '', new: 'Short for it' });
    expect(mergedDescription(descriptions, ['dev-notes', 'dev'], 'new')).toBe('dev');
    expect(mergedDescription(descriptions, ['dev'], 'development')).toBe('development');
    // A delete drops it, and those of the tags inside it.
    expect(describedAfter(descriptions, [{ from: 'penmoss', to: null }])).toEqual({
      penmoss: '',
      'penmoss/review': '',
    });
  });
});
