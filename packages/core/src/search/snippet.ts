/**
 * Snippets with the matched words marked (T22). The server's FTS5
 * `snippet()` and this function use the same markers, so the app renders
 * both the same way: STX before a match and ETX after it, so marking never
 * needs HTML escaping. A note could hold those control characters, so text is
 * indexed and marked through `searchText`, which turns them into spaces (both
 * are separators to the tokenizer, so no word changes).
 */
import { tokenize } from './tokenize';

export const MATCH_START = '\u0002';
export const MATCH_END = '\u0003';
export const ELLIPSIS = '…';

/** `text` without the match markers, for indexing and marking (A118). */
export function searchText(text: string): string {
  return text.includes(MATCH_START) || text.includes(MATCH_END)
    ? text.replaceAll(MATCH_START, ' ').replaceAll(MATCH_END, ' ')
    : text;
}

/**
 * Up to `size` tokens of `text` around its matches: the window with the most
 * matched tokens, starting one token before its first match.
 */
export function snippet(raw: string, matches: (term: string) => boolean, size = 16): string {
  const text = searchText(raw);
  const tokens = tokenize(text);
  if (tokens.length === 0) return text.slice(0, 200);
  const hits = tokens.map((token) => matches(token.term));
  let best = 0;
  let bestCount = -1;
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (hits[i]) count++;
    if (i >= size && hits[i - size]) count--;
    const start = Math.max(0, i - size + 1);
    if (count > bestCount) {
      bestCount = count;
      best = start;
    }
  }
  let start = best;
  if (bestCount > 0) {
    const first = hits.indexOf(true, best);
    let last = first;
    for (let i = best; i < Math.min(tokens.length, best + size); i++) if (hits[i]) last = i;
    const shifted = Math.max(0, first - 1);
    if (last < shifted + size) start = shifted;
  }
  const end = Math.min(tokens.length, start + size) - 1;
  let out = start > 0 ? ELLIPSIS : '';
  let at = tokens[start]!.start;
  for (let i = start; i <= end; i++) {
    const token = tokens[i]!;
    if (!hits[i]) continue;
    out +=
      text.slice(at, token.start) + MATCH_START + text.slice(token.start, token.end) + MATCH_END;
    at = token.end;
  }
  out += text.slice(at, tokens[end]!.end);
  if (end < tokens.length - 1) out += ELLIPSIS;
  return out;
}

/** The whole of `text` with every matched word marked (FTS5's `highlight()`). */
export function highlight(raw: string, matches: (term: string) => boolean): string {
  const text = searchText(raw);
  let out = '';
  let at = 0;
  for (const token of tokenize(text)) {
    if (!matches(token.term)) continue;
    out +=
      text.slice(at, token.start) + MATCH_START + text.slice(token.start, token.end) + MATCH_END;
    at = token.end;
  }
  return out + text.slice(at);
}
