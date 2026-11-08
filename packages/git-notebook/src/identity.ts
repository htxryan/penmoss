/**
 * A notebook's own commit identity (#170 F6), as the Mac, Android and the CLI take it: plain
 * text only (#174 review). Android's `GitNotebooks.setAuthor` keeps the same rules.
 */

/** What no commit name or email holds (#174 review): controls (NUL too), bidi and format characters. */
const IDENTITY_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A commit name: one line of plain text, at most 200 characters, without `<` or `>`. */
export function validCommitName(name: string): boolean {
  return (
    name.length > 0 && name.length <= 200 && !IDENTITY_INVISIBLE.test(name) && !/[<>]/.test(name)
  );
}

/** A commit email: an address of plain text, at most 254 characters. */
export function validCommitEmail(email: string): boolean {
  return (
    email.length <= 254 &&
    !IDENTITY_INVISIBLE.test(email) &&
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(email)
  );
}
