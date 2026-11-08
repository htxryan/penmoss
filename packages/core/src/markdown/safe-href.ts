/**
 * Which link and image addresses the codec turns into links (T24 review,
 * A139). Markdown from agents, imports and other apps can carry
 * `javascript:` and similar addresses; the editor's renderer drops them, but
 * the codec feeds other renderers too (Android, exports, published pages), so
 * such a link is read as its text and such a picture as its alt text, as the
 * paste path does (A51, A52). Web and mail addresses, relative paths and
 * fragments are links.
 *
 * Looser than the paste sanitiser's `safeHref` (packages/editor), which also
 * drops relative addresses: a note's own markdown may link a sibling file.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

export function isSafeHref(href: string): boolean {
  // Browsers skip ASCII whitespace and control characters in a scheme (`java\tscript:`).
  let value = '';
  for (const char of href) if (char > ' ' && char !== '\u007f') value += char;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  return !scheme || SAFE_SCHEMES.has(scheme[1]!.toLowerCase());
}
