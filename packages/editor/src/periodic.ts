/**
 * The Yjs update that creates a daily or weekly note from its template (T19,
 * A4). Every input is fixed by the period and the template: the note id and
 * the Yjs client id are derived from them, `created` is the period's first
 * day (no clock time), and the body is the template with its placeholders
 * filled from the period. Two devices that create the same note offline
 * therefore write byte-identical updates: Yjs sees one set of items, so the
 * note has one copy of the template whichever device syncs first. The client
 * ids are hashes of the updates themselves (each built once under a fixed
 * id): identity and title under one, the body under another. A device whose
 * template, codec or schema produced a different body writes its own copy
 * under another id: the note then holds both bodies (never one copy per
 * device under the same id and clocks, which Yjs would treat as known) and
 * still one title.
 *
 * The codec (`@penmoss/core`) is passed in, so the app can load it lazily.
 * A git notebook passes its id as `salt` (T50, A820), so its daily note is
 * never the personal workspace's, and is the same on all its devices.
 */
import type * as Core from '@penmoss/core';
import {
  fillTemplate,
  parseIsoWeek,
  parsePlainDate,
  periodicNoteId,
  periodicClientId,
  weekMonday,
  type PeriodKind,
} from '@penmoss/core/periodic';
import { initNote } from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { docToDelta } from '@y/prosemirror';
import * as Y from '@y/y';

export interface PeriodicNote {
  readonly id: string;
  readonly kind: PeriodKind;
  /** `2026-10-21` or `2026-W43`. */
  readonly period: string;
  /** The template after its placeholders were filled. */
  readonly body: string;
  /** The Yjs update holding identity, title and body. */
  readonly update: Uint8Array;
}

/** The period's first day, as `created` (date only: no clock, no zone). */
function firstDay(kind: PeriodKind, period: string): string {
  if (kind === 'daily') {
    const date = parsePlainDate(period);
    if (!date) throw new RangeError(`Not a day: ${period}`);
    return date.toString();
  }
  const week = parseIsoWeek(period);
  if (!week) throw new RangeError(`Not a week: ${period}`);
  return weekMonday(week).toString();
}

/** The client id the content is first built under, only to hash it. */
const PROBE_CLIENT_ID = 1;

export function periodicNote(
  codec: Pick<typeof Core, 'parseMarkdown'>,
  kind: PeriodKind,
  period: string,
  template: string,
  /** A git notebook's id (T50, A820): its note and client ids are its own. */
  salt?: string,
): PeriodicNote {
  const id = periodicNoteId(kind, period, salt);
  const body = fillTemplate(template, kind, period);
  const parsed = codec.parseMarkdown(body).doc;
  // Only bodies that fit the schema every app opens are written (A159); the codec builds no other.
  parsed.check();
  const identity = { id, created: firstDay(kind, period), kind, period };
  const delta = docToDelta(parsed);
  /** One part of the note, under a client id hashed from that part's own bytes (A4). */
  type Update = ReturnType<typeof Y.encodeStateAsUpdate>;
  const part = (write: (doc: Y.Doc) => void): Update => {
    const build = (clientID: number): Update => {
      const doc = new Y.Doc();
      doc.clientID = clientID;
      try {
        doc.transact(() => write(doc));
        return Y.encodeStateAsUpdate(doc);
      } finally {
        doc.destroy();
      }
    };
    return build(periodicClientId(kind, period, build(PROBE_CLIENT_ID), salt));
  };
  // Identity and title depend on the period only, so two templates (or builds) share them
  // and the title is never doubled; the body has its own id, from the template's output.
  const head = part((doc) => initNote(doc, identity, period));
  const content = part((doc) => doc.get(NOTE_ROOT).applyDelta(delta));
  return { id, kind, period, body, update: Y.mergeUpdates([head, content]) };
}

/**
 * A note written from markdown as one Yjs update (T69: the welcome note a new notebook starts
 * with, A1146): identity, title and the parsed body, under this device's own client id.
 */
export function markdownNote(
  codec: Pick<typeof Core, 'parseMarkdown'>,
  note: {
    readonly id: string;
    readonly created: string;
    readonly title: string;
    readonly markdown: string;
  },
): Uint8Array {
  const parsed = codec.parseMarkdown(note.markdown).doc;
  parsed.check();
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      initNote(doc, { id: note.id, created: note.created, kind: 'note' }, note.title);
      doc.get(NOTE_ROOT).applyDelta(docToDelta(parsed));
    });
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
