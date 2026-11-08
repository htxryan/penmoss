/**
 * Pipes inside GFM table cells. GFM splits a row into cells on every `|` not
 * escaped by a backslash, before any inline syntax is read, so a pipe inside
 * a wikilink or `$…$` would end the cell (`$|x|$` lost everything after the
 * first pipe). Inside a cell each `|` takes one more backslash and the
 * backslashes right before it are doubled: `|` → `\|`, `\|` → `\\\|`. Other
 * backslashes are untouched. As for inline code, reading undoes it.
 */
export function toTableCell(text: string): string {
  return text.replace(/(\\*)\|/g, (_match, slashes: string) => `${slashes}${slashes}\\|`);
}

/** Undoes `toTableCell`: a `|` after 2k+1 backslashes becomes one after k. */
export function fromTableCell(text: string): string {
  return text.replace(/(\\*)\|/g, (match, slashes: string) =>
    slashes.length % 2 === 1 ? `${slashes.slice(0, (slashes.length - 1) / 2)}|` : match,
  );
}
