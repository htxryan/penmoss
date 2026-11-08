/**
 * Deep links (T29): `penmoss://note/<id>` opens a note, `penmoss://capture`
 * the capture window (T30; for Shortcuts, Raycast or Alfred). Anything else
 * is ignored: a link is data from whatever app sent it.
 */
import { DEEP_LINK_SCHEME } from './config';

const NOTE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export type DeepLink =
  { readonly kind: 'path'; readonly path: string } | { readonly kind: 'capture' };

export function parseDeepLink(link: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (url.hostname === 'capture' && parts.length === 0) return { kind: 'capture' };
  if (url.hostname === 'note' && parts.length === 1) {
    let id: string;
    try {
      id = decodeURIComponent(parts[0]!);
    } catch {
      return null;
    }
    if (!NOTE_ID.test(id)) return null;
    return { kind: 'path', path: `/notes/${id.toUpperCase()}` };
  }
  return null;
}

/** The deep link among a process's arguments (Linux and Windows pass it on the command line). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}
