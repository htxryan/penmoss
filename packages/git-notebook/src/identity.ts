/**
 * A notebook's own commit identity (#170 F6), as the Mac, Android and the CLI take it: plain
 * text only (#174 review). Android's `GitNotebooks.setAuthor` keeps the same rules. Also what a
 * token and its user name may be.
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

/**
 * A git personal access token, or a writer secret, as the Mac app and the CLI keep one: nothing
 * a keychain command must quote. Android's `GitNotebooks.kt` keeps the same rule.
 */
export function isTokenText(text: string): boolean {
  return /^[A-Za-z0-9_.~+/=-]{8,1000}$/.test(text);
}

/** A token's user name: no quoting, nothing a URL or a credential prompt treats specially. */
export function isTokenUser(text: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(text);
}
