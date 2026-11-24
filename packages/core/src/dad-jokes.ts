/**
 * Dad jokes for the empty window (Ryan, A1576) and Android's Home (PEN-10): the heading where "No
 * note open" was. Folk jokes, each written in our own words after a look at several public lists
 * (Reader's Digest, Fatherly, Baby Chick, Mommy Poppins); short, clean and not about anyone or
 * anything topical. The list is `data/dad-jokes.json`, the one copy both apps read: the web app
 * imports it here, and Android's engine bundles the same file as a resource. The web's
 * `joke-deck.ts` and Android's `JokeDeck` deal them out with no repeats until every one has been
 * seen. Order is free: add at the end or anywhere, and the decks reshuffle when the count changes.
 */
import jokes from '../data/dad-jokes.json';

export const DAD_JOKES: readonly string[] = jokes;
