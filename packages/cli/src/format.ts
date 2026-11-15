/** Shaping replies for people and for `--json`. */
import type { LocalEditReply } from '@penmoss/git-notebook/local';

/** Search marks matches with U+0002 … U+0003 (A118). */
const START = String.fromCharCode(2);
const END = String.fromCharCode(3);

/** Wraps each marked match with `open` and `close`. */
function mark(text: string, open: string, close: string): string {
  return text.replaceAll(START, open).replaceAll(END, close);
}

/** Matches in bold on a terminal, plain otherwise. */
export const highlight = (text: string, color: boolean): string =>
  color ? mark(text, '\u001b[1m', '\u001b[22m') : mark(text, '', '');

/** Matches as `**bold**`, as the MCP tools give them (for `--json`). */
export const markdownMarks = (text: string) => mark(text, '**', '**');

/** An epoch-ms time as ISO 8601 (for `--json`), or null. */
export const iso = (ms: number | null | undefined): string | null =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null;

const LOCAL = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short' });

/** An epoch-ms time in this machine's zone, `2026-10-22 14:03`. */
export const when = (ms: number | null | undefined): string =>
  typeof ms === 'number' && ms > 0 ? LOCAL.format(new Date(ms)) : '—';

export const dim = (text: string, color: boolean) => (color ? `\u001b[2m${text}\u001b[22m` : text);

/** “Title”, or the id when there is no title. */
export const named = (title: string | null | undefined, id: string) =>
  title ? `“${title}” (${id})` : id;

/** What an edit reply says, for people: ` · summary · version 12`. */
export function editTail(reply: LocalEditReply): string {
  const parts: string[] = [];
  if (!reply.changed) parts.push('no change');
  if (reply.summary) parts.push(reply.summary);
  parts.push(`version ${reply.baseVersion}`);
  return ` · ${parts.join(' · ')}`;
}

/**
 * An edit reply (A123) for `--json`: the next baseVersion and what the edit did (A177; absent
 * from a replayed create).
 */
export function editJson(reply: LocalEditReply): Record<string, unknown> {
  return {
    id: reply.id,
    changed: reply.changed,
    baseVersion: reply.baseVersion,
    ...(reply.summary ? { summary: reply.summary } : {}),
  };
}
