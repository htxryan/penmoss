/**
 * A source's Trash (T21, A16, A828): deleting a note to it, listing what it holds, restoring a
 * note to its folder, and deleting one for good. The notes service (service.ts) keeps one and
 * hands it what it needs.
 */
import type { NoteMeta } from '@penmoss/model/record';
import { setDeleted } from '@penmoss/model/note';
import { deleteRecord } from '@penmoss/model/records';
import type { OpenNote } from './open-note';
import {
  isReserved,
  type LocalNotes,
  type LocalSyncBackend,
  type NoteRegistry,
} from './service-types';
import { untilStored } from './until-stored';

/**
 * A note could not come out of Trash on its own (T43 review B2, A757): the folder it was deleted
 * from is gone and Trash no longer knows where that was, so there is no place for it. Nothing was
 * restored; the app asks where to put it.
 */
export class RestoreNeedsFolder extends Error {
  constructor(readonly noteId: string) {
    super('The folder the note was in is gone. Choose a folder for it.');
    this.name = 'RestoreNeedsFolder';
  }
}

/** A note in Trash (T21). */
export interface TrashEntry {
  readonly id: string;
  readonly title: string;
  /** When it was deleted (epoch ms). */
  readonly deletedAt: number;
  /** Its folder when deleted (null: top level; undefined: not recorded here). */
  readonly folderId?: string | null;
}

/** What Trash needs from the notes service. */
export interface TrashHost {
  readonly localStore: () => Promise<LocalNotes>;
  readonly refreshLocal: () => Promise<void>;
  /** The notes as the list last read them. */
  readonly listed: () => Iterable<NoteMeta>;
  readonly registry: () => NoteRegistry | undefined;
  readonly backend: () => LocalSyncBackend;
  /** Notes deleted here, hidden at once (their records follow). */
  readonly deleted: () => Set<string>;
  /** This window's loaded copy of a note, if one is open. */
  readonly openLoaded: (id: string) => OpenNote | undefined;
  /** Resolves once this note's local writes in flight have finished. */
  readonly settled: (id: string) => Promise<void>;
  /** The list changed. */
  readonly changed: () => void;
}

export class Trash {
  constructor(private readonly host: TrashHost) {}

  /**
   * Soft-deletes a note (A16): the flag syncs like any edit and lists hide it. It also leaves
   * the workspace registry (T7).
   */
  async deleteNote(id: string, options: { readonly folderId?: string | null } = {}): Promise<void> {
    this.host.deleted().add(id);
    this.host.changed();
    // Trash (T21) remembers when and from which folder, so a restore puts it back; a caller
    // whose note has left the registry already gives its folder.
    const folderId =
      options.folderId !== undefined
        ? options.folderId
        : (this.host.registry()?.folderOf?.(id) ?? null);
    const info = { at: Date.now(), folderId };
    const open = this.host.openLoaded(id);
    if (open) {
      setDeleted(open.replica.doc, true, null, info);
    } else {
      await this.host.settled(id);
      await untilStored(async () =>
        (await this.host.localStore()).update(id, (current) =>
          current ? deleteRecord(current, true, info) : null,
        ),
      );
    }
    this.host.registry()?.unregister(id);
  }

  /** Notes in Trash on this device, newest deletion first (T21), from the last list read. */
  localTrash(metas: Iterable<NoteMeta> = this.host.listed()): TrashEntry[] {
    return [...metas]
      .filter((meta) => meta.deleted && !isReserved(meta.noteId))
      .map((meta) => ({
        id: meta.noteId,
        title: meta.title,
        deletedAt: meta.deletedAt ?? meta.updatedAt,
        ...(meta.deletedFrom !== undefined ? { folderId: meta.deletedFrom } : {}),
      }))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Trash (T21): this source's deleted notes, read from storage. */
  async trash(): Promise<TrashEntry[]> {
    // Read from storage: a note deleted while open is written when it closes.
    return this.localTrash(await (await this.host.localStore()).listMeta());
  }

  /**
   * Takes a note out of Trash and files it back in the folder it was deleted from (T21), or where
   * the person chose. Restored on this device, offline too; it syncs like any edit. The note keeps
   * its id, so links to it still resolve.
   */
  async restoreFromTrash(
    id: string,
    options: {
      /** Where the person chose to put it (a folder, or null for the top level). */
      readonly folderId?: string | null;
    } = {},
  ): Promise<void> {
    const chosen = 'folderId' in options;
    const store = await this.host.localStore();
    const record = await store.get(id);
    if (!record?.deleted) throw new Error('This note is not in Trash on this device.');
    let folderId = chosen ? (options.folderId ?? null) : (record.deletedFrom ?? null);
    if (!chosen) {
      const place = this.host.registry()?.restorePlace?.(id, folderId);
      if (place && 'refused' in place) throw new RestoreNeedsFolder(id);
      if (place) folderId = place.folderId;
    }
    this.host.deleted().delete(id);
    this.host.registry()?.restore?.(id, folderId);
    await untilStored(() =>
      store.update(id, (current) => (current?.deleted ? deleteRecord(current, false) : null)),
    );
    await this.host.refreshLocal();
  }

  /**
   * Deletes a note in Trash for good (T21, A828): the notebook's `purged` map, then this device's
   * copy. Git keeps its history.
   */
  async purgeFromTrash(id: string): Promise<void> {
    const store = await this.host.localStore();
    await this.host.backend().purge(id);
    await store.delete?.(id);
    // Gone, not hidden: a daily note made again under its derived id (T19) is listed.
    this.host.deleted().delete(id);
    await this.host.refreshLocal();
  }
}
