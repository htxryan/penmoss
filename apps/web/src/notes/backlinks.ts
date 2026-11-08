/**
 * The Backlinks panel's data (T16): notes that link to a note (linked
 * mentions, with the text around each link) and notes that mention its title
 * without linking (unlinked mentions).
 *
 * It comes from this device's store (D49, T59: the server's index went with
 * the server): each note's links are kept with its record, and mentions are
 * searched in the stored text.
 */
import type { ContextPart } from '@penmoss/core/links';
import type { LocalLinks, Notes } from './service';
import type { NoteListEntry } from './list';

export interface Mention {
  readonly context: readonly ContextPart[];
  readonly embed: boolean;
  readonly heading: string | null;
}

export interface LinkedNote {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly mentions: readonly Mention[];
}

/** Text, with the runs that matched the title marked. */
export interface SnippetPart {
  readonly text: string;
  readonly match: boolean;
}

export interface UnlinkedNote {
  readonly id: string;
  readonly title: string;
  readonly snippet: readonly SnippetPart[];
}

export interface Backlinks {
  readonly linked: readonly LinkedNote[];
  readonly unlinked: readonly UnlinkedNote[];
}

/** A snippet's match markers (core's search markers, as the local index writes them). */
const MATCH_START = String.fromCharCode(2);
const MATCH_END = String.fromCharCode(3);
const SNIPPET_RADIUS = 60;
const MAX_UNLINKED = 50;

export async function loadBacklinks(
  notes: Notes,
  noteId: string,
  title: string,
): Promise<Backlinks> {
  const linked = localLinked(notes.localLinks(), noteId);
  const texts = await notes.localTexts();
  return { linked, unlinked: localUnlinked(texts, noteId, title, linked) };
}

/** Linked mentions from the local link index, most recently edited first. */
export function localLinked(local: readonly LocalLinks[], noteId: string): LinkedNote[] {
  const out: LinkedNote[] = [];
  for (const note of local) {
    if (note.id === noteId) continue;
    const mentions = distinct(
      note.links
        .filter((link) => link.noteId === noteId)
        .map((link) => ({ context: link.context, embed: link.embed, heading: link.heading })),
    );
    if (mentions.length > 0) {
      out.push({ id: note.id, title: note.title, updatedAt: note.updatedAt, mentions });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * One mention per block: two links in one paragraph share its text, which
 * shows once (with both links marked).
 */
export function distinct(mentions: readonly Mention[]): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((mention) => {
    const key = JSON.stringify(mention.context);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Notes whose text holds `title` as whole words (ignoring case), apart from those linking. */
export function localUnlinked(
  texts: readonly { noteId: string; title: string; text: string }[],
  noteId: string,
  title: string,
  linked: readonly LinkedNote[],
): UnlinkedNote[] {
  const wanted = title.trim();
  if (!/[\p{L}\p{N}]/u.test(wanted)) return [];
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
    'iu',
  );
  const skip = new Set([noteId, ...linked.map((note) => note.id)]);
  const out: UnlinkedNote[] = [];
  for (const note of texts) {
    if (skip.has(note.noteId)) continue;
    const match = pattern.exec(note.text);
    if (!match) continue;
    const start = match.index;
    const end = start + match[0].length;
    const from = Math.max(0, start - SNIPPET_RADIUS);
    const to = Math.min(note.text.length, end + SNIPPET_RADIUS);
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    out.push({
      id: note.noteId,
      title: note.title,
      snippet: [
        { text: `${from > 0 ? '…' : ''}${flat(note.text.slice(from, start))}`, match: false },
        { text: flat(match[0]), match: true },
        {
          text: `${flat(note.text.slice(end, to))}${to < note.text.length ? '…' : ''}`,
          match: false,
        },
      ],
    });
    if (out.length >= MAX_UNLINKED) break;
  }
  return out;
}

/** Splits a snippet on its match markers. */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let rest = snippet;
  while (rest) {
    const start = rest.indexOf(MATCH_START);
    if (start === -1) {
      parts.push({ text: rest, match: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), match: false });
    const end = rest.indexOf(MATCH_END, start);
    const stop = end === -1 ? rest.length : end;
    parts.push({ text: rest.slice(start + 1, stop), match: true });
    rest = end === -1 ? '' : rest.slice(end + 1);
  }
  return parts.map((part) => ({ ...part, text: part.text.replace(/\s+/g, ' ') }));
}

/**
 * A key that changes when any note but `noteId` is added, removed or edited
 * (a rename is an edit), and not when `noteId` is: the Backlinks panel
 * reloads on it. Built per keystroke, so it is a number fold, not a string
 * per note.
 */
export function othersKey(list: readonly NoteListEntry[], noteId: string): string {
  let count = 0;
  let hash = 0;
  for (const entry of list) {
    if (entry.id === noteId) continue;
    count++;
    const last = entry.id.charCodeAt(entry.id.length - 1) || 0;
    hash = (Math.imul(hash, 31) + ((entry.updatedAt + last) % 2_147_483_647)) | 0;
  }
  return `${count}:${hash}`;
}
