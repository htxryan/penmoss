/**
 * The words the owner check (Touch ID, or the password helper) shows for a git notebook (A855):
 * the repository, the folder on this Mac and the note, within the helper's 200 characters, so a
 * note named in them always shows whole or not at all.
 */
import { isolatedTitle } from '@penmoss/core/titles';
import { redactRemote, remoteParts } from '@penmoss/git-notebook/system-git';

/** How the person sees a repository: `github.com/owner/repo`, or the host and path. */
export function repositoryName(remote: string): string {
  const parts = remoteParts(remote);
  if (!parts) return redactRemote(remote);
  if (parts.protocol === 'file') return `this Mac: ${parts.path}`;
  return `${parts.host}/${parts.path}`;
}

/** A repository in the owner check's words: `github.com/owner/repo`, or a path on this Mac. */
export function repositoryWords(remote: string): string {
  const parts = remoteParts(remote);
  if (parts?.protocol === 'file') return `${parts.path} on this Mac`;
  return repositoryName(remote);
}

/**
 * A note as an owner check names it (A855), last in the words: its title from the branch in
 * brackets, isolated from the words around it (U+2068…U+2069, so right-to-left letters in it
 * cannot reorder them), with control and format characters (bidi, zero-width), brackets and
 * double-quote look-alikes taken out, at most 60 characters; else "an untitled note" and its id's end.
 */
export function noteWords(id: string, title: string | undefined): string {
  const isolated = isolatedTitle(title);
  return isolated ? `[${isolated}]` : `an untitled note (…${id.slice(-6)})`;
}

/** The longest the owner check's words get (the password helper's limit). */
const MAX_WORDS = 200;

/**
 * Words for the owner check: no line breaks, at most 200 characters (the helper's limit). A cut
 * never lands inside a character (a surrogate pair) or inside an isolated title (`noteWords`): it
 * goes before the title's bracket instead, so a title is shown whole or not at all.
 */
export function checkWords(text: string): string {
  const flat = text.replace(/\p{Cc}+/gu, ' ').trim();
  if (flat.length <= MAX_WORDS) return flat;
  let cut = MAX_WORDS - 3;
  const open = flat.lastIndexOf('⁨', cut);
  if (open >= 0) {
    const close = flat.indexOf('⁩', open);
    // The title and its closing bracket must both come before the cut.
    if (close < 0 || close + 2 > cut) cut = open > 0 && flat[open - 1] === '[' ? open - 1 : open;
  }
  if (cut > 0 && /[\uD800-\uDBFF]/u.test(flat[cut - 1] ?? '')) cut--;
  return `${flat.slice(0, cut).trimEnd()}…`;
}

/**
 * `before` + `path` + `after` as the owner check's words, shortening only `path` (a repository or
 * a folder on this Mac) with an ellipsis in its middle, so the note `after` names always shows
 * whole within the 200 characters. `checkWords` cuts the end when even that cannot fit.
 */
export function fitWords(before: string, path: string, after: string): string {
  const flat = (text: string) => text.replace(/\p{Cc}+/gu, ' ');
  const shown = flat(path);
  const room = MAX_WORDS - flat(before).length - flat(after).length;
  if (shown.length <= room || room < 9) return checkWords(before + shown + after);
  let head = Math.ceil((room - 1) / 2);
  let tail = room - 1 - head;
  if (/[\uD800-\uDBFF]/u.test(shown[head - 1] ?? '')) head--;
  if (/[\uDC00-\uDFFF]/u.test(shown[shown.length - tail] ?? '')) tail--;
  return checkWords(`${before}${shown.slice(0, head)}…${shown.slice(shown.length - tail)}${after}`);
}
