/**
 * Actor files (T50, A829; #147's A749): `actors/<writer>.json` says which Yjs client ids a writer
 * used, and whether it is a device or an agent, so the app attributes every change (A3) without a
 * server. A writer rewrites its own as the union of the file at head and its own client ids, so a
 * lost push or a crash never shrinks it.
 */
import { encodeJson } from './layout';
import type { WriterKind, WriterRecord } from './writer';

export interface ActorFile {
  readonly kind: WriterKind;
  readonly label: string;
  /** Sorted, unique. */
  readonly clientIds: readonly number[];
}

const decoder = new TextDecoder();

export function parseActor(bytes: Uint8Array | null | undefined): ActorFile | null {
  if (!bytes) return null;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as Partial<ActorFile>;
    const ids = Array.isArray(value.clientIds)
      ? value.clientIds.filter((id): id is number => Number.isSafeInteger(id) && id > 0)
      : [];
    return {
      kind: value.kind === 'agent' ? 'agent' : 'device',
      label: typeof value.label === 'string' ? value.label : '',
      clientIds: [...new Set(ids)].sort((a, b) => a - b),
    };
  } catch {
    return null;
  }
}

/**
 * The actor file this writer should have: the union of head's and its own ids, with its current
 * kind and label. Null when the file at head already says exactly that.
 */
export function actorFile(
  writer: WriterRecord,
  atHead: ActorFile | null,
  own: Iterable<number>,
): { file: ActorFile; bytes: Uint8Array } | null {
  const clientIds = [...new Set([...(atHead?.clientIds ?? []), ...own])].sort((a, b) => a - b);
  const file: ActorFile = { kind: writer.kind, label: writer.label, clientIds };
  if (
    atHead &&
    atHead.kind === file.kind &&
    atHead.label === file.label &&
    atHead.clientIds.length === clientIds.length
  ) {
    return null;
  }
  return { file, bytes: encodeJson(file) };
}

/** Who wrote with each client id (A829): what `Replica.attribute` takes, from every actor file. */
export function attributionMap(
  actors: ReadonlyMap<string, ActorFile>,
): Map<number, { readonly writer: string; readonly kind: WriterKind; readonly label: string }> {
  const out = new Map<number, { writer: string; kind: WriterKind; label: string }>();
  for (const [writer, file] of [...actors].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const id of file.clientIds) {
      if (!out.has(id)) out.set(id, { writer, kind: file.kind, label: file.label });
    }
  }
  return out;
}
