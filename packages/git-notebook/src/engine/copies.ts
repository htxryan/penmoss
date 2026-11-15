/**
 * Copies brought back after a store was cleared (A886). One whose original another device
 * deleted for good before the copy first reached the branch (the purge raced its push) is
 * withheld from the push, never deleted: its whole doc, every edit made on it here included, is
 * kept on this device first (Room on Android, else the engine's store); then it leaves the
 * notebook, so neither its logs nor its entry are committed. Only a purge fetched from the branch
 * counts: one made here leaves the copy, which the person can see, to be pushed. A copy on the
 * branch stays, whatever later happens to the original; one the person confirmed (Keep and sync)
 * is pushed as it is.
 */
import { readTitle } from '@penmoss/sync-client/note';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { racedCopies, recoveredFromOf, unregisterCopy } from '../purge';
import type { NotebookReplica, WithheldCopy } from '../replica';
import type { CopyToWithhold, EngineOptions } from './options';

/** Copies withheld from the push, by copy id: kept on this device only. */
export function withheldCopies(replica: NotebookReplica): Readonly<Record<string, WithheldCopy>> {
  return replica.state.withheld;
}

/**
 * Keep and sync: the person confirmed pushing the withheld copy `id`, whose doc the caller has
 * put back in the notebook with its link. It is pushed as it is from the next sync.
 */
export function keepCopy(replica: NotebookReplica, id: string): void {
  const withheld = { ...replica.state.withheld };
  delete withheld[id];
  const kept = new Set(replica.state.keptCopies);
  kept.add(id);
  replica.update({ withheld, keptCopies: [...kept].sort() });
}

/** A withheld copy the person deleted for good or that another store took over: forgotten. */
export function forgetWithheld(replica: NotebookReplica, id: string): void {
  if (!(id in replica.state.withheld)) return;
  const withheld = { ...replica.state.withheld };
  delete withheld[id];
  replica.update({ withheld });
}

/** The copies the person confirmed that are not on the branch yet: a copy at head leaves the list. */
export function pendingKeptCopies(
  replica: NotebookReplica,
  atHead: (id: string) => boolean,
): readonly string[] {
  const kept = replica.state.keptCopies.filter((id) => !atHead(id));
  if (kept.length !== replica.state.keptCopies.length) replica.update({ keptCopies: kept });
  return kept;
}

/** Withholds every copy whose original's purge raced its first push (see above). */
export async function withholdRaced(
  replica: NotebookReplica,
  options: Pick<EngineOptions, 'clock' | 'withhold' | 'log'>,
  input: {
    /** Purges that landed on the branch. */
    readonly landed: ReadonlySet<string>;
    readonly purged: ReadonlySet<string>;
    readonly atHead: (id: string) => boolean;
    readonly kept: readonly string[];
  },
): Promise<void> {
  const links = recoveredFromOf(replica.workspace);
  const raced = racedCopies(replica.workspace, {
    landed: input.landed,
    purged: input.purged,
    atHead: input.atHead,
    held: (id) => replica.note(id) !== undefined,
    kept: new Set(input.kept),
  });
  if (raced.length === 0) return;
  const filed = new Map(
    readWorkspace(replica.workspace).notes.map((note) => [note.id, note.folderId]),
  );
  const copies = raced.map((id): CopyToWithhold => ({
    id,
    origin: links.get(id)!,
    title: readTitle(replica.note(id)!),
    folderId: filed.get(id) ?? null,
    update: Y.encodeStateAsUpdate(replica.note(id)!),
  }));
  const at = (options.clock ?? Date.now)();
  await options.withhold?.(copies);
  const withheld = { ...replica.state.withheld };
  for (const copy of copies) {
    withheld[copy.id] = {
      origin: copy.origin,
      title: copy.title,
      folderId: copy.folderId,
      at,
      ...(options.withhold ? {} : { update: base64(copy.update) }),
    };
  }
  replica.update({ withheld });
  replica.workspace.transact(() => {
    for (const id of raced) unregisterCopy(replica.workspace, id);
  });
  for (const id of raced) replica.dropNoteFromGit(id);
  replica.showWorkspace();
  options.log?.(
    `${raced.length === 1 ? 'A copy' : `${raced.length} copies`} of a note deleted for good on another device kept on this device only, not pushed`,
  );
}

/** Copies not on the branch yet (and not purged): each is pushed with its entry, or not at all. */
export function unpushedCopies(
  replica: NotebookReplica,
  atHead: (id: string) => boolean,
  purged: ReadonlySet<string>,
): string[] {
  return [...recoveredFromOf(replica.workspace).keys()].filter(
    (id) => !atHead(id) && !purged.has(id),
  );
}

/** A note this device lacks, or holds empty: it has no log to write. */
export function contentless(replica: NotebookReplica, id: string): boolean {
  const doc = replica.note(id);
  return doc === undefined || Y.decodeStateVector(Y.encodeStateVector(doc)).size === 0;
}

/**
 * A copy's entry never lands without its log, so every device agrees on whether it has: one of
 * `unpushed` whose doc this device lacks, or holds empty, leaves the tree before anything is
 * committed.
 */
export function dropOrphans(
  replica: NotebookReplica,
  log: ((message: string) => void) | undefined,
  unpushed: readonly string[],
): void {
  const orphans = unpushed.filter((id) => contentless(replica, id));
  if (orphans.length === 0) return;
  replica.workspace.transact(() => {
    for (const id of orphans) unregisterCopy(replica.workspace, id);
  });
  replica.showWorkspace();
  log?.(
    `${orphans.length === 1 ? 'A recovered copy' : `${orphans.length} recovered copies`} with no content here left the tree`,
  );
}

/** Base64 of `bytes` (a withheld copy kept in the engine's bookkeeping). */
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}
