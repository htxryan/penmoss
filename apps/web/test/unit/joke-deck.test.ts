import { beforeEach, describe, expect, it } from 'vitest';
import { DAD_JOKES } from '../../src/shell/dad-jokes';
import { drawJoke, JOKE_DECK_KEY, resetJokeDeck, shuffled } from '../../src/shell/joke-deck';
import type { KeyValueStore } from '../../src/shell/key-value';

// A1576: the empty window's dad jokes, dealt with no repeats until every one has been seen.

function memory(): KeyValueStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const broken: KeyValueStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

beforeEach(() => resetJokeDeck());

describe('the dad jokes', () => {
  it('number at least 250, none twice, each short and on its own', () => {
    expect(DAD_JOKES.length).toBeGreaterThanOrEqual(250);
    const key = (joke: string) => joke.toLowerCase().replace(/[^a-z]/gu, '');
    expect(new Set(DAD_JOKES.map(key)).size).toBe(DAD_JOKES.length);
    for (const joke of DAD_JOKES) {
      expect(joke.trim()).toBe(joke);
      expect(joke.length).toBeLessThanOrEqual(140);
    }
  });
});

describe('the deck', () => {
  const jokes = ['a', 'b', 'c', 'd', 'e'];

  it('deals every joke once before any comes again, then reshuffles', () => {
    const store = memory();
    const first = Array.from({ length: jokes.length }, () => drawJoke(jokes, store));
    expect([...first].sort()).toEqual(jokes);
    const second = Array.from({ length: jokes.length }, () => drawJoke(jokes, store));
    expect([...second].sort()).toEqual(jokes);
    // A new round never opens with the joke the last one ended on.
    expect(second[0]).not.toBe(first.at(-1));
  });

  it('keeps its place on the device, so a new page carries on with the same round', () => {
    const store = memory();
    const seen = [drawJoke(jokes, store), drawJoke(jokes, store)];
    resetJokeDeck();
    const rest = Array.from({ length: 3 }, () => drawJoke(jokes, store));
    expect([...seen, ...rest].sort()).toEqual(jokes);
    expect(JSON.parse(store.data.get(JOKE_DECK_KEY)!)).toMatchObject({ size: 5, left: [] });
  });

  it('reshuffles a deck kept for a different list, or one that will not read', () => {
    const store = memory();
    store.setItem(JOKE_DECK_KEY, JSON.stringify({ size: 3, left: [2, 1], last: 0 }));
    const dealt = Array.from({ length: jokes.length }, () => drawJoke(jokes, store));
    expect([...dealt].sort()).toEqual(jokes);
    store.setItem(JOKE_DECK_KEY, '{not json');
    expect(jokes).toContain(drawJoke(jokes, store));
  });

  it('deals from memory when storage throws, still with no repeats', () => {
    const dealt = Array.from({ length: jokes.length }, () => drawJoke(jokes, broken));
    expect([...dealt].sort()).toEqual(jokes);
    expect(Array.from({ length: jokes.length }, () => drawJoke(jokes, null)).sort()).toEqual(jokes);
  });

  it('shuffles every index once, whatever the random numbers', () => {
    for (const random of [() => 0, () => 0.999_999, Math.random]) {
      expect(shuffled(7, null, random).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
    expect(shuffled(4, 0, () => 0.999_999)[0]).not.toBe(0);
  });
});
