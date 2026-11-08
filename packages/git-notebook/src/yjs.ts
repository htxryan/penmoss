/** Yjs helpers the engine shares (T50). */
import * as Y from '@y/y';

/** Updates applied from the repository: never a local change, so never marked dirty. */
export const GIT_ORIGIN = Symbol('penmoss-git');
/** The engine's own bookkeeping writes (`changedAt/<writer>`): carried, never marked dirty. */
export const ENGINE_ORIGIN = Symbol('penmoss-git-engine');
/** Changes the engine reads back from the device's store (the Mac app's windows, A851): local. */
export const LOCAL_STORE_ORIGIN = Symbol('penmoss-git-store');

export function sameBytes(
  a: Uint8Array | null | undefined,
  b: Uint8Array | null | undefined,
): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

const isEmpty = (ids: Y.ContentIds) => ids.inserts.isEmpty() && ids.deletes.isEmpty();

/** `Y.mergeUpdates` over bytes from anywhere (a file, a fetch). */
export function mergeUpdates(parts: readonly Uint8Array[]): Uint8Array {
  return Y.mergeUpdates(parts as Uint8Array<ArrayBuffer>[]);
}

/**
 * A writer's own file (A821, G0's change to #147's A741): its file at head plus what the local
 * document has that no file at head has. The difference is taken over content ids, inserts and
 * deletes alike, so a delete another writer already logged is never copied (#147's
 * `encodeStateAsUpdate(local, stateVector(head))` carries the whole delete set, and made 31% more
 * commits in G0). Nothing is marked sent: a lost push loses nothing, and the next sync computes
 * the same difference. Null when the head lacks nothing.
 */
// @y/y rc.29's declarations use ContentIds in updates.d.ts without importing it (as in
// sync-client's yjs14.ts): restate the type.
type ContentIdsOf = (update: Uint8Array) => Y.ContentIds;
const contentIdsOf = Y.createContentIdsFromUpdate as ContentIdsOf;
const intersect = Y.intersectUpdateWithContentIds as (
  update: Uint8Array,
  ids: Y.ContentIds,
) => Uint8Array;

export function ownFile(
  local: Uint8Array,
  headParts: readonly Uint8Array[],
  ownAtHead: Uint8Array | null,
): Uint8Array | null {
  const mine = contentIdsOf(local);
  const missing =
    headParts.length > 0 ? Y.excludeContentIds(mine, contentIdsOf(mergeUpdates(headParts))) : mine;
  if (isEmpty(missing)) return null;
  const delta = intersect(local, missing);
  return ownAtHead ? mergeUpdates([ownAtHead, delta]) : delta;
}

/** An update's content ids (inserts and deletes); null when the bytes are not an update. */
export function contentIds(bytes: Uint8Array): Y.ContentIds | null {
  try {
    return contentIdsOf(bytes);
  } catch {
    return null;
  }
}

/**
 * What `newer` (an update, with its content ids) has that `older`'s ids lack, or null when it
 * lacks something `older` has, inserts and deletes alike: then `newer` is no writer's file that
 * only grew (A821), and applying it over a document with `older` is not the document `newer`
 * alone makes. Empty (an update of nothing) when they are the same.
 */
export function grownBy(
  newer: Uint8Array,
  newerIds: Y.ContentIds,
  olderIds: Y.ContentIds,
): Uint8Array | null {
  if (!isEmpty(Y.excludeContentIds(olderIds, newerIds))) return null;
  return intersect(newer, Y.excludeContentIds(newerIds, olderIds));
}

/** A new document under `clientID` (one per writer session, A821), or Yjs's own random one. */
export function newDoc(clientID?: number): Y.Doc {
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  return doc;
}

/** A copy of `doc` under its own client id: changes to it reach `doc` only when applied. */
export function forkDoc(doc: Y.Doc, clientID: number): Y.Doc {
  const fork = newDoc(clientID);
  applyKeepingId(fork, Y.encodeStateAsUpdate(doc), null);
  return fork;
}

/** A random 31-bit Yjs client id (never 0), as Yjs makes them. */
export function randomClientId(random: () => number = Math.random): number {
  return (Math.floor(random() * 0x7fffffff) || 1) >>> 0;
}

/** A random client id none of `used` is (A821: never one with content anywhere yet). */
export function freshClientId(
  used: ReadonlySet<number>,
  random: () => number = Math.random,
): number {
  for (;;) {
    const id = randomClientId(random);
    if (!used.has(id)) return id;
  }
}

/** Whether `bytes` decode as a Yjs update (a writer's file may be corrupt, A822). */
/**
 * Applies `update` to `doc` and keeps `doc`'s client id (A821). Yjs gives a doc a new random id
 * when a remote update brings content under its own id (and prints a warning): right for a doc
 * that may collide, wrong for a writer's own content coming back from its saved state or the
 * branch, where the engine decides (a persisted id, or a fresh one when the profile is behind).
 * True when the update added content under `doc`'s id.
 */
export function applyKeepingId(doc: Y.Doc, update: Uint8Array, origin: unknown): boolean {
  const own = doc.clientID;
  const theirs = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update));
  const before = Y.decodeStateVector(Y.encodeStateVector(doc));
  if ((theirs.get(own) ?? 0) <= (before.get(own) ?? 0)) {
    Y.applyUpdate(doc, update, origin);
    return false;
  }
  // Apply under a stand-in id that neither side uses, then take the writer's id back.
  let standIn = (own ^ 0x5a5a5a5a) >>> 0;
  while (theirs.has(standIn) || before.has(standIn) || standIn === own) {
    standIn = (standIn + 1) >>> 0;
  }
  doc.clientID = standIn;
  try {
    Y.applyUpdate(doc, update, origin);
  } finally {
    doc.clientID = own;
  }
  return true;
}

/**
 * Whether Yjs holds content for `doc` it has not applied: a struct whose dependency is missing.
 * @y/y rc.29 can drop such a struct when the dependency comes in a later update (A1148), and then
 * only that struct's own update brings it back, so the engine applies the doc's files again.
 */
export function hasPending(doc: Y.Doc): boolean {
  const store = (doc as unknown as { store?: { pendingStructs?: unknown } }).store;
  return store?.pendingStructs != null;
}

export function isUpdate(bytes: Uint8Array): boolean {
  try {
    Y.decodeUpdate(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Content ids are equal: the same inserts and deletes (converged replicas). */
export function sameContent(a: Y.Doc, b: Y.Doc): boolean {
  const x = Y.createContentIdsFromDoc(a, true);
  const y = Y.createContentIdsFromDoc(b, true);
  return Y.equalIdSets(x.inserts, y.inserts) && Y.equalIdSets(x.deletes, y.deletes);
}
