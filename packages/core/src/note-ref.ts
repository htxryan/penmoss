/**
 * Short note references (PEN-69): `<notebook>-<note>`, e.g. `K7QD-9HTF2CXA`, a shorter way to
 * name a git notebook's note to an agent, the CLI or a link. Stored ids never change: notes keep
 * their 26-character ULIDs everywhere, and everything that takes a note id takes both forms.
 *
 * - `<notebook>`: 4 Crockford base32 characters of a hash (32-bit FNV-1a) of the notebook's id
 *   from `.penmoss/notebook.json`, so the same on every machine and in every clone.
 * - `<note>`: the last 8 characters of the note's ULID (its random part). When two notes of the
 *   notebook share them, the older (smaller) id keeps the short form and every later one is
 *   referred to by its whole ULID (`K7QD-01M6…`), so a reference never names two notes.
 *
 * Case-insensitive on input, and Crockford's look-alikes are read as it reads them (O as 0,
 * I and L as 1). The Android app ports this in `NoteRef.kt`, matched by the contract
 * `apps/android/contract/agent-reference-v1.json`.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** How many of a note id's last characters a short reference keeps. */
export const NOTE_REF_LENGTH = 8;
/** How many characters name the notebook. */
export const NOTEBOOK_TAG_LENGTH = 4;

/** `<notebook>-<note>`: an 8-character note part, or the whole ULID after a clash. */
const SHORT = /^([0-9A-Z]{4})-([0-9A-Z]{8}|[0-9A-Z]{26})$/;

/** 32-bit FNV-1a of `text`'s UTF-16 code units (notebook ids are ASCII ULIDs). */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Upper case, with Crockford's look-alikes as the digits they stand for. */
function normalise(text: string): string {
  return text.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** The 4 characters that name a notebook in its notes' short references. */
export function notebookTag(notebookId: string): string {
  const hash = fnv1a(notebookId.trim());
  let out = '';
  // The hash's top 20 bits, 5 at a time.
  for (let i = 0; i < NOTEBOOK_TAG_LENGTH; i++) out += ALPHABET[(hash >>> (27 - i * 5)) & 31];
  return out;
}

/**
 * A note's short reference in a notebook. `others` are the notebook's other note ids (any order,
 * the note's own may be among them): an older one ending the same way makes this one's
 * reference its whole id. A note id that is not a ULID is its own reference.
 */
export function shortNoteRef(
  notebookId: string,
  noteId: string,
  others: Iterable<string> = [],
): string {
  const id = noteId.trim();
  if (!ULID.test(id)) return id;
  const end = id.slice(-NOTE_REF_LENGTH);
  for (const other of others) {
    if (other !== id && other < id && ULID.test(other) && other.endsWith(end)) {
      return `${notebookTag(notebookId)}-${id}`;
    }
  }
  return `${notebookTag(notebookId)}-${end}`;
}

/** A reference as given: a note id, or a short reference's two parts (upper case). */
export type NoteRef =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'short'; readonly notebook: string; readonly note: string };

/** Reads a reference: `K7QD-9HTF2CXA` (any case) is short; anything else is an id, trimmed. */
export function parseNoteRef(ref: string): NoteRef {
  const trimmed = ref.trim();
  const match = SHORT.exec(normalise(trimmed));
  if (match) return { kind: 'short', notebook: match[1]!, note: match[2]! };
  // A whole ULID in another case reads as the ULID.
  const upper = trimmed.toUpperCase();
  return { kind: 'id', id: ULID.test(upper) ? upper : trimmed };
}

/** Whether `ref` is a short reference (`K7QD-9HTF2CXA`, any case). */
export function isShortNoteRef(ref: string): boolean {
  return parseNoteRef(ref).kind === 'short';
}

/**
 * The note a short reference's note part names among a notebook's note ids: the whole id, or of
 * the ids ending with the 8 characters, the oldest (the one whose reference they are). Null when
 * none does.
 */
export function matchNoteRef(note: string, ids: Iterable<string>): string | null {
  const wanted = normalise(note);
  let best: string | null = null;
  for (const id of ids) {
    if (wanted.length > NOTE_REF_LENGTH) {
      if (id === wanted) return id;
      continue;
    }
    if (ULID.test(id) && id.endsWith(wanted) && (best === null || id < best)) best = id;
  }
  return best;
}

/**
 * Names many notes of a notebook at once (a list an MCP tool returns): each id's short
 * reference, with a clash decided as `shortNoteRef` decides it, from one pass over `ids`.
 */
export function noteRefNamer(notebookId: string, ids: Iterable<string>): (id: string) => string {
  const tag = notebookTag(notebookId);
  const oldest = new Map<string, string>();
  for (const id of ids) {
    if (!ULID.test(id)) continue;
    const end = id.slice(-NOTE_REF_LENGTH);
    const held = oldest.get(end);
    if (held === undefined || id < held) oldest.set(end, id);
  }
  return (id) => {
    if (!ULID.test(id)) return id;
    const end = id.slice(-NOTE_REF_LENGTH);
    const held = oldest.get(end);
    return held === undefined || held >= id ? `${tag}-${end}` : `${tag}-${id}`;
  };
}
