/**
 * The graph page's bridge (T40 P7, LK7, LK8; A478): a second page in the APK,
 * `graph.html`, on the same `penmossNative` listener, origin, CSP and request
 * blocking as the editor page (A293). The app sends the phone's notes and the
 * links between them from Room, what to show (every note, or the notes within
 * a few links of one) and the theme; the page lays the graph out with the web's
 * own code (`@penmoss/ui/graph`) and says what it shows and which note to open.
 * It holds no note content, so it never sees Yjs.
 *
 * Version 1 grows by adding messages, as the editor's does (A300).
 * `apps/android/contract/graph-v1.json` holds an example of every message;
 * this file's tests and the Kotlin `GraphProtocol` tests both check it.
 */
import { NOTE_ID } from './protocol';

export const GRAPH_VERSION = 1;

/** The depths a local graph offers on the phone (LK8): 1 to 3 links. */
export const GRAPH_DEPTHS = [1, 2, 3] as const;

/** More than any vault Penmoss is built for (D20 tests 2,000 notes); a bigger list is refused. */
export const MAX_GRAPH_NOTES = 20_000;

/** The links one note may bring (the editor page reports at most 1,000, A473). */
export const MAX_NOTE_LINKS = 1000;

/** Longer than any title or folder name the server keeps (300). */
export const MAX_GRAPH_TEXT = 1000;

/** A note as the graph draws it: its title, its top-level folder (its colour) and its links. */
export interface GraphNote {
  readonly id: string;
  readonly title: string;
  /** The note's top-level folder, or null at the top level. */
  readonly group: string | null;
  readonly links: readonly string[];
}

/** A top-level folder, in the order the lists show them; null is the top level itself. */
export interface GraphGroupEntry {
  readonly id: string | null;
  readonly name: string;
}

export type GraphScopeMessage =
  | { readonly kind: 'global' }
  | { readonly kind: 'local'; readonly noteId: string; readonly depth: number };

export type ToGraph =
  /** The phone's notes and links, sent again whenever Room's change. */
  | {
      readonly v: 1;
      readonly type: 'graph';
      readonly notes: readonly GraphNote[];
      readonly groups: readonly GraphGroupEntry[];
    }
  /** What to show: every note, or the notes within `depth` links of one. */
  | { readonly v: 1; readonly type: 'scope'; readonly scope: GraphScopeMessage }
  /** A note picked in the search field: shown in the middle with its chip. */
  | { readonly v: 1; readonly type: 'focus'; readonly noteId: string }
  /** The theme to draw with (A305), as the editor page gets it. */
  | {
      readonly v: 1;
      readonly type: 'theme';
      readonly theme: Readonly<Record<string, unknown>>;
      readonly variant: 'light' | 'dark';
    };

export type FromGraph =
  | { readonly v: 1; readonly type: 'ready' }
  /** What the page shows now, after each graph or scope: for the app's count and TalkBack. */
  | { readonly v: 1; readonly type: 'shown'; readonly notes: number; readonly links: number }
  /** The chip was tapped: open this note. */
  | { readonly v: 1; readonly type: 'open'; readonly noteId: string };

const isString = (value: unknown): value is string => typeof value === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNoteId = (value: unknown): value is string => isString(value) && NOTE_ID.test(value);
const isText = (value: unknown): value is string =>
  isString(value) && value.length <= MAX_GRAPH_TEXT;

function notesOf(value: unknown): GraphNote[] | null {
  if (!Array.isArray(value) || value.length > MAX_GRAPH_NOTES) return null;
  const out: GraphNote[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return null;
    const { id, title, group, links } = entry;
    if (!isNoteId(id) || !isText(title)) return null;
    if (group !== null && !isNoteId(group)) return null;
    if (!Array.isArray(links) || links.length > MAX_NOTE_LINKS || !links.every(isNoteId)) {
      return null;
    }
    out.push({ id, title, group, links });
  }
  return out;
}

function groupsOf(value: unknown): GraphGroupEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_GRAPH_NOTES) return null;
  const out: GraphGroupEntry[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return null;
    const { id, name } = entry;
    if ((id !== null && !isNoteId(id)) || !isText(name)) return null;
    out.push({ id, name });
  }
  return out;
}

function scopeOf(value: unknown): GraphScopeMessage | null {
  if (!isRecord(value)) return null;
  if (value['kind'] === 'global') return { kind: 'global' };
  const { kind, noteId, depth } = value;
  if (kind !== 'local' || !isNoteId(noteId)) return null;
  if (!(GRAPH_DEPTHS as readonly unknown[]).includes(depth)) return null;
  return { kind: 'local', noteId, depth: depth as number };
}

/** Reads a message from the app; null for anything malformed or of another version. */
export function parseToGraph(raw: string): ToGraph | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value['v'] !== GRAPH_VERSION) return null;
  switch (value['type']) {
    case 'graph': {
      const notes = notesOf(value['notes']);
      const groups = groupsOf(value['groups']);
      return notes && groups ? { v: 1, type: 'graph', notes, groups } : null;
    }
    case 'scope': {
      const scope = scopeOf(value['scope']);
      return scope ? { v: 1, type: 'scope', scope } : null;
    }
    case 'focus':
      return isNoteId(value['noteId']) ? { v: 1, type: 'focus', noteId: value['noteId'] } : null;
    case 'theme': {
      const { theme, variant } = value;
      if (!isRecord(theme) || (variant !== 'light' && variant !== 'dark')) return null;
      return { v: 1, type: 'theme', theme, variant };
    }
    default:
      return null;
  }
}

export function encodeFromGraph(message: FromGraph): string {
  return JSON.stringify(message);
}
