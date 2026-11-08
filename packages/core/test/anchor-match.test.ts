import { describe, expect, it } from 'vitest';
import { editDistance, findAnchorText, similarity } from '../src/anchor-match';

const TEXT =
  'Groceries\nBuy milk and eggs on the way home.\nPlans\nWe should plant the garden in spring, ' +
  'before the rains come.\nThen buy milk and eggs again.';

describe('editDistance and similarity', () => {
  it('counts single-character edits', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(similarity('garden', 'garden')).toBe(1);
    expect(similarity('garden', 'gardens')).toBeCloseTo(6 / 7);
  });
});

describe('findAnchorText (T52 item 5)', () => {
  it('finds a quote that is there once, exactly', () => {
    const found = findAnchorText(TEXT, {
      quote: 'plant the garden',
      prefix: 'We should ',
      suffix: ' in spring',
    });
    expect(found?.how).toBe('exact');
    expect(TEXT.slice(found!.start, found!.end)).toBe('plant the garden');
  });

  it('picks the occurrence whose surroundings match, of several', () => {
    const found = findAnchorText(TEXT, {
      quote: 'milk and eggs',
      prefix: 'Then buy ',
      suffix: ' again.',
    });
    expect(found?.how).toBe('exact-context');
    expect(found!.start).toBe(TEXT.lastIndexOf('milk and eggs'));
  });

  it('finds a passage edited slightly since', () => {
    const quote = 'We should plant the garden in early spring';
    const found = findAnchorText(TEXT, { quote, prefix: 'Plans\n', suffix: ', before the' });
    expect(found?.how).toBe('fuzzy');
    expect(found!.similarity).toBeGreaterThan(0.8);
    expect(TEXT.slice(found!.start, found!.end)).toContain('plant the garden in spring');
  });

  it('places a passage rewritten in place between its unchanged surroundings', () => {
    const found = findAnchorText(TEXT, {
      quote: 'Plant tomatoes and basil',
      prefix: 'Plans\nWe should ',
      suffix: ' in spring, before the rains',
    });
    expect(found?.how).toBe('context');
    expect(TEXT.slice(found!.start, found!.end)).toBe('plant the garden');
  });

  it('gives up when nothing is close', () => {
    expect(
      findAnchorText(TEXT, {
        quote: 'Quarterly revenue forecast',
        prefix: 'Finance\n',
        suffix: ' for the board',
      }),
    ).toBeNull();
  });

  it('finds a point where its surroundings meet', () => {
    const at = TEXT.indexOf(' in spring');
    const exact = findAnchorText(TEXT, {
      quote: '',
      prefix: 'plant the garden',
      suffix: ' in spring',
    });
    expect(exact).toMatchObject({ start: at, end: at, how: 'exact' });
    const near = findAnchorText(TEXT.replace('garden', 'gardens'), {
      quote: '',
      prefix: 'We should plant the garden',
      suffix: ' in spring, before',
    });
    expect(near?.how).toBe('context');
  });
});
