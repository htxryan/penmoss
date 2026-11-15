/** The Yjs 14 release-candidate stack (@y/y + @y/prosemirror 2). */
import { extractLinks, type DocJson, type NoteLink } from '@penmoss/core/links';
import * as Y from '@y/y';
import { touchesOnlyComments } from './comments';
import { NOTE_ROOT, type Replica, type UpdateListener } from './replica';

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
}

/**
 * An update that changes nothing: no structs and an empty delete set, which Yjs encodes in two
 * bytes. A transaction that wrote nothing new still emits one.
 */
export function isEmptyUpdate(update: Uint8Array): boolean {
  return update.byteLength <= 2;
}

/**
 * Whether Yjs holds back content for `doc` it cannot apply yet: structs whose dependency is
 * missing and, with `deletes` (the default), deletions of content not received.
 *
 * The git engine asks about structs only (`deletes: false`, A1148). Its question is whether to
 * apply a doc's files at head again: @y/y rc.29 can lose a pending struct when its dependency
 * arrives in a later update, and only that struct's own file brings it back. A pending deletion
 * is not lost that way, so it is no reason to read the files again.
 */
export function hasPending(doc: Y.Doc, { deletes = true }: { deletes?: boolean } = {}): boolean {
  return doc.store.pendingStructs != null || (deletes && doc.store.pendingDs != null);
}

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
