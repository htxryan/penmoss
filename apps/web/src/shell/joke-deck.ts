/**
 * Deals the empty window's dad jokes (A1576): at random, none twice until every one has been
 * seen, then a fresh shuffle. The deck (the jokes still to come, by index) is kept per device in
 * `localStorage`; where that cannot be read or written (a private window, blocked storage) a deck
 * in memory does the same for this page.
 */
import type { KeyValueStore } from './key-value';

export const JOKE_DECK_KEY = 'penmoss.jokeDeck';

interface Deck {
  /** How many jokes the deck was shuffled from: a different count reshuffles. */
  readonly size: number;
  /** The indices still to deal, next first. */
  readonly left: readonly number[];
  /** The last one dealt, so a new shuffle never starts with it. */
  readonly last: number | null;
}

let inMemory: Deck | null = null;

/** The indices 0 … size − 1 in a random order (Fisher–Yates), not starting with `last`. */
export function shuffled(size: number, last: number | null, random: () => number): number[] {
  const order = Array.from({ length: size }, (_, n) => n);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  if (size > 1 && order[0] === last) [order[0], order[1]] = [order[1]!, order[0]];
  return order;
}

function read(store: KeyValueStore | null, size: number): Deck | null {
  try {
    const raw = store?.getItem(JOKE_DECK_KEY);
    if (!raw) return inMemory;
    const deck = JSON.parse(raw) as Partial<Deck>;
    const fine =
      deck.size === size &&
      Array.isArray(deck.left) &&
      deck.left.every((n) => Number.isInteger(n) && n >= 0 && n < size) &&
      (deck.last === null || (Number.isInteger(deck.last) && deck.last! < size));
    return fine ? (deck as Deck) : null;
  } catch {
    return inMemory;
  }
}

function write(store: KeyValueStore | null, deck: Deck): void {
  inMemory = deck;
  try {
    store?.setItem(JOKE_DECK_KEY, JSON.stringify(deck));
  } catch {
    // The deck in memory carries on for this page.
  }
}

/** The next joke from `jokes`, dealt from the device's deck (A1576). */
export function drawJoke(
  jokes: readonly string[],
  store: KeyValueStore | null,
  random: () => number = Math.random,
): string {
  if (jokes.length === 0) return '';
  let deck = read(store, jokes.length);
  if (!deck || deck.size !== jokes.length || deck.left.length === 0) {
    deck = {
      size: jokes.length,
      left: shuffled(jokes.length, deck?.last ?? null, random),
      last: null,
    };
  }
  const [next, ...left] = deck.left as [number, ...number[]];
  write(store, { size: jokes.length, left, last: next });
  return jokes[next]!;
}

/** Forgets the deck in memory (tests). */
export function resetJokeDeck(): void {
  inMemory = null;
}
