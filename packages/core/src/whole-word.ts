/** `text` with every regular-expression character escaped, to match as written. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `name` as a whole word in any case: no letter, digit or `_` just before or after it. The
 * scrubbers that remove known names (feedback reports and usage analytics) use it.
 */
export function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'giu');
}
