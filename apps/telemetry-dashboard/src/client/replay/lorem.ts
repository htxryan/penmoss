/**
 * Lorem ipsum for a session's replay (PEN-178): what stands in for a note's words, which are never
 * recorded. `loremOf(seed, length)` is exactly `length` characters, and the same seed always gives
 * the same text: each seed has one endless stream of words, and a length takes that many from its
 * start. So a block that grows keeps its first words, and one that shrinks loses its last.
 */

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut ' +
  'labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris ' +
  'nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse ' +
  'cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui ' +
  'officia deserunt mollit anim id est laborum'
).split(' ');

/** The most characters drawn for one block: a huge paste is recorded as up to a million. */
export const MAX_DRAWN = 20_000;

/** FNV-1a, 32 bits: a seed's number. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: the stream's next number in [0, 1). */
function random(state: { n: number }): number {
  state.n = (state.n + 0x6d2b79f5) | 0;
  let t = state.n;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

interface Stream {
  text: string;
  readonly state: { n: number };
}

const streams = new Map<string, Stream>();

/** Adds words to `stream` until it holds at least `length` characters. */
function grow(stream: Stream, length: number): void {
  let text = stream.text;
  while (text.length < length) {
    const word = WORDS[Math.floor(random(stream.state) * WORDS.length)]!;
    const roll = random(stream.state);
    // Now and then a comma or a full stop, as text has.
    const mark = roll < 0.08 ? ',' : roll < 0.14 ? '.' : '';
    text += (text ? ' ' : '') + word + mark;
  }
  stream.text = text;
}

/** Exactly `length` characters of lorem ipsum (at most MAX_DRAWN), the same for the same seed. */
export function loremOf(seed: string, length: number): string {
  const n = Math.max(0, Math.min(MAX_DRAWN, Math.trunc(length)));
  if (n === 0) return '';
  let stream = streams.get(seed);
  if (!stream) {
    stream = { text: '', state: { n: hash(seed) } };
    streams.set(seed, stream);
  }
  grow(stream, n);
  return stream.text.slice(0, n);
}
