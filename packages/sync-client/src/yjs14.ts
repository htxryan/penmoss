/**
 * The Yjs 14 release-candidate stack (@y/y + @y/prosemirror 2). Attribution
 * uses Yjs 14's own attribution renderer instead of walking items.
 */
import { extractLinks, type DocJson, type NoteLink } from '@penmoss/core/links';
import * as Y from '@y/y';
import { touchesOnlyComments } from './comments';
import {
  NOTE_ROOT,
  pushRun,
  type AttributedRun,
  type ClientRanges,
  type ClockRange,
  type Replica,
  type UpdateListener,
} from './replica';

export interface Yjs14Replica extends Replica {
  readonly engine: 'yjs14';
  readonly doc: Y.Doc;
  links(): NoteLink[];
}

interface DeltaJson {
  readonly type?: string;
  readonly name?: string;
  readonly attrs?: Readonly<Record<string, { readonly value?: unknown }>>;
  readonly insert?: string | DeltaJson[];
  /** A text run's marks, by name (the binding's formatting attributes). */
  readonly format?: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
  readonly children?: DeltaJson[];
  readonly attribution?: { readonly insert?: readonly string[] };
}

// @y/y rc.29's declarations use ContentIds in updates.d.ts without importing it; restate the types.
type ContentIdsOf = (update: Uint8Array) => Y.ContentIds;
// Its StructStore declarations leave the struct types unresolved; this is the part we read.
interface StructIds {
  readonly id: { readonly clock: number };
  readonly length: number;
}
/** Inserted and deleted ids of a V1 update (what the wire protocol carries). */
const contentIdsOf = Y.createContentIdsFromUpdate as ContentIdsOf;
/** The same for a V2 update (what Yjs keeps pending internally). */
const contentIdsOfV2 = Y.createContentIdsFromUpdateV2 as ContentIdsOf;

/** Marker attribute for content whose client id has no actor yet. */
const UNMAPPED = '\u0000unmapped';

export function createYjs14Replica(doc: Y.Doc = new Y.Doc()): Yjs14Replica {
  const root = () => doc.get(NOTE_ROOT);
  return {
    engine: 'yjs14',
    doc,
    get clientId() {
      return doc.clientID;
    },
    applyUpdate: (update, origin = null) => Y.applyUpdate(doc, update, origin),
    encodeStateAsUpdate: (stateVector) => Y.encodeStateAsUpdate(doc, stateVector),
    encodeStateVector: () => Y.encodeStateVector(doc),
    stateVectorClocks: () => Y.decodeStateVector(Y.encodeStateVector(doc)),
    pending() {
      // Both are V2 updates: pending structs with an empty delete set, and
      // pending deletions with no structs.
      const { pendingStructs, pendingDs } = doc.store;
      return {
        inserts: pendingStructs
          ? toClientRanges(contentIdsOfV2(pendingStructs.update).inserts)
          : new Map(),
        deletes: pendingDs ? toClientRanges(contentIdsOfV2(pendingDs).deletes) : new Map(),
      };
    },
    insertRanges: (update) => toClientRanges(contentIdsOf(update).inserts),
    holds(clientId, ranges) {
      if (ranges.length === 0) return true;
      const { store } = doc;
      const held = Y.createIdSet();
      // Integrated: everything up to the last struct, minus skipped ranges.
      const structs = store.clients.get(clientId) as readonly StructIds[] | undefined;
      const last = structs?.at(-1);
      if (last) held.add(clientId, 0, last.id.clock + last.length);
      for (const skip of store.skips.clients.get(clientId)?.getIds() ?? []) {
        held.delete(clientId, skip.clock, skip.len);
      }
      if (store.pendingStructs) {
        const pending = contentIdsOfV2(store.pendingStructs.update).inserts.clients.get(clientId);
        for (const range of pending?.getIds() ?? []) held.add(clientId, range.clock, range.len);
      }
      return ranges.every((range) => held.covers(clientId, range.from, range.to - range.from));
    },
    onUpdate(listener: UpdateListener) {
      const handler = (
        update: Uint8Array,
        origin: unknown,
        _doc: Y.Doc,
        transaction: Y.Transaction,
      ) => listener(update, origin, { commentsOnly: touchesOnlyComments(doc, transaction) });
      doc.on('update', handler);
      return () => doc.off('update', handler);
    },
    links: () => extractLinks(bodyJson(doc)),
    plainText() {
      const lines: string[] = [];
      collectLines(root().toDeltaDeep().toJSON() as DeltaJson, lines);
      return lines.join('\n');
    },
    attribute(actorOf) {
      // One insert attribution per client id, covering everything it ever wrote.
      const inserts = Y.createIdMap();
      for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
        inserts.add(client, 0, clock, [
          Y.createContentAttribute('insert', actorOf(client) ?? UNMAPPED),
        ]);
      }
      const renderer = Y.createAttributionsRenderer(Y.createContentMap(inserts, Y.createIdMap()));
      const runs: AttributedRun[] = [];
      collectRuns(root().toDeltaDeep({ renderer }).toJSON() as DeltaJson, runs);
      return runs;
    },
    destroy: () => doc.destroy(),
  };
}

/**
 * A note body as ProseMirror JSON (node types, attributes, text and marks):
 * for links, headings and sections (`@penmoss/core/links`), and for embeds
 * to render (T13).
 */
export function bodyJson(doc: Y.Doc): DocJson {
  return deltaToJson(doc.get(NOTE_ROOT).toDeltaDeep().toJSON() as DeltaJson, 'doc');
}

function deltaToJson(node: DeltaJson, type: string): DocJson {
  const attrs: Record<string, unknown> = {};
  for (const [name, attr] of Object.entries(node.attrs ?? {})) attrs[name] = attr.value ?? null;
  const content: DocJson[] = [];
  for (const op of node.children ?? []) {
    if (typeof op.insert === 'string') {
      const marks = Object.entries(op.format ?? {}).map(([mark, markAttrs]) =>
        markAttrs && Object.keys(markAttrs).length > 0
          ? { type: mark, attrs: { ...markAttrs } }
          : { type: mark },
      );
      content.push({ type: 'text', text: op.insert, ...(marks.length > 0 ? { marks } : {}) });
    } else if (Array.isArray(op.insert)) {
      for (const child of op.insert) content.push(deltaToJson(child, child.name ?? 'unknown'));
    }
  }
  return { type, attrs, content };
}

function toClientRanges(ids: Y.IdSet): ClientRanges {
  const out = new Map<number, ClockRange[]>();
  for (const [client, ranges] of ids.clients) {
    out.set(
      client,
      ranges.getIds().map((range) => ({ from: range.clock, to: range.clock + range.len })),
    );
  }
  return out;
}

function collectLines(node: DeltaJson, lines: string[]): void {
  let line: string | null = null;
  for (const op of node.children ?? []) {
    if (typeof op.insert === 'string') {
      line = (line ?? '') + op.insert;
    } else if (Array.isArray(op.insert)) {
      for (const child of op.insert) collectLines(child, lines);
    }
  }
  if (line !== null) lines.push(line);
}

function collectRuns(node: DeltaJson, runs: AttributedRun[]): void {
  for (const op of node.children ?? []) {
    if (typeof op.insert === 'string') {
      const actor = op.attribution?.insert?.[0];
      pushRun(runs, actor === undefined || actor === UNMAPPED ? null : actor, op.insert);
    } else if (Array.isArray(op.insert)) {
      for (const child of op.insert) collectRuns(child, runs);
    }
  }
}
