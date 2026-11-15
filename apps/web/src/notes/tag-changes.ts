/**
 * Tag changes in a notebook's notes (T18, T24; A1508): renames, merges and deletes, journalled so
 * a batch cut short completes at the next start, one batch at a time, with an Undo. The `Notes`
 * service owns one and says which notes are open and stored (`TagChangesHost`).
 */
import { changeRecord } from '@penmoss/sync-client/records';
import {
  changeTagInDoc,
  revertTagEdit,
  type TagChange,
  type TagEditLog,
} from '@penmoss/sync-client/tags';
import type { LocalNotes, TagChangeResult } from './service';

/** Where tag changes (renames, merges, deletes) wait until every note on this device has them (T18). */
const TAG_RENAMES_KEY = 'tagRenames';

const isTagChange = (value: unknown): value is TagChange => {
  const change = value as { from?: unknown; to?: unknown; nested?: unknown } | null;
  return (
    typeof change?.from === 'string' &&
    (typeof change.to === 'string' || change.to === null) &&
    (change.nested === undefined || typeof change.nested === 'boolean')
  );
};

const sameChange = (a: TagChange, b: TagChange) =>
  a.from === b.from && a.to === b.to && (a.nested ?? true) === (b.nested ?? true);

/** A note's Yjs document, as the tag functions take it. */
export type NoteDoc = Parameters<typeof changeTagInDoc>[0];

/** What the tag changes need of the notes service. */
export interface TagChangesHost {
  readonly localStore: () => Promise<LocalNotes>;
  /** Reads the list again once a batch is done. */
  readonly refreshLocal: () => Promise<void>;
  /** The notes the list shows now, with their tags (a tag typed a moment ago is not stored yet). */
  readonly listed: () => Iterable<{ readonly id: string; readonly tags: readonly string[] }>;
  /** An open note's document, edited in its editor's replica; null when it is not open. */
  readonly openDoc: (id: string) => NoteDoc | null;
  /** A record that is not a note (the WorkspaceDoc, the search index). */
  readonly isReserved: (id: string) => boolean;
}

export class TagChanges {
  /** Tag changes in progress, one batch at a time (T18). */
  private running: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: TagChangesHost) {}

  /**
   * Tag changes in order: renames and merges (a rename to a tag that exists), with the levels
   * nested under the tag unless `nested` is false, and deletes (`to` null), in every note in this
   * notebook that has the tag, Trash included, so a restore never brings an old tag back. Each
   * note changes through its own document: open notes in their editor's replica, the rest in the
   * local store. Journalled first, so a batch cut short (the window closed) completes at the next
   * start. Returns the notes changed and an Undo that puts back what each change did in each note
   * (not journalled: it lasts while the page that offers it is open).
   */
  change(changes: readonly TagChange[]): Promise<TagChangeResult> {
    const run = this.running.then(async () => {
      const store = await this.host.localStore();
      const pending = await this.pending(store);
      await store.setState?.(TAG_RENAMES_KEY, [...pending, ...changes]);
      const logs = new Map<string, TagEditLog[]>();
      for (const change of changes) {
        await this.apply(store, change, logs);
        await this.finish(store, change);
      }
      await this.host.refreshLocal();
      return {
        notes: [...logs.keys()],
        undo: () => this.undo(logs),
      };
    });
    this.running = run.catch(() => undefined);
    return run;
  }

  /** Resolves once no tag change is running (tests). */
  async idle(): Promise<void> {
    await this.running;
  }

  /** Completes the tag changes a previous session journalled but did not finish. */
  resume(): Promise<unknown> {
    this.running = this.running
      .then(async () => {
        const store = await this.host.localStore();
        const pending = await this.pending(store);
        for (const change of pending) {
          await this.apply(store, change, new Map());
          await this.finish(store, change);
        }
        if (pending.length > 0) await this.host.refreshLocal();
      })
      .catch((error: unknown) => console.warn('[notes] could not finish a tag rename', error));
    return this.running;
  }

  /** Notes on this device with `tag` or a tag nested under it: stored (Trash included) and open. */
  private async tagged(store: LocalNotes, tag: string): Promise<Set<string>> {
    const has = (tags: readonly string[] | undefined) =>
      (tags ?? []).some((name) => name === tag || name.startsWith(`${tag}/`));
    // Stored notes (Trash included, so a restore never brings the old tag back), and what open
    // notes show now (a tag typed a moment ago is not stored yet).
    const affected = new Set<string>();
    for (const meta of await store.listMeta()) {
      if (!this.host.isReserved(meta.noteId) && has(meta.tags)) affected.add(meta.noteId);
    }
    for (const entry of this.host.listed()) if (has(entry.tags)) affected.add(entry.id);
    return affected;
  }

  private async pending(store: LocalNotes): Promise<TagChange[]> {
    const value = await store.getState?.(TAG_RENAMES_KEY);
    return Array.isArray(value) ? value.filter(isTagChange) : [];
  }

  private async finish(store: LocalNotes, done: TagChange): Promise<void> {
    const pending = await this.pending(store);
    const index = pending.findIndex((change) => sameChange(change, done));
    if (index >= 0) pending.splice(index, 1);
    await store.setState?.(TAG_RENAMES_KEY, pending.length > 0 ? pending : undefined);
  }

  /** One tag change in every note that has the tag; what it did is added to `logs`. */
  private async apply(
    store: LocalNotes,
    change: TagChange,
    logs: Map<string, TagEditLog[]>,
  ): Promise<void> {
    const keep = (id: string, log: TagEditLog | null) => {
      if (!log) return;
      const kept = logs.get(id);
      if (kept) kept.push(log);
      else logs.set(id, [log]);
    };
    for (const id of await this.tagged(store, change.from)) {
      await this.editDoc(store, id, (doc) => {
        const log = changeTagInDoc(doc, change);
        keep(id, log);
        return log !== null;
      });
    }
  }

  /** Undo for `change`: each note's changes put back, the latest first. */
  private undo(logs: ReadonlyMap<string, readonly TagEditLog[]>): Promise<string[]> {
    const run = this.running.then(async () => {
      const store = await this.host.localStore();
      const changed: string[] = [];
      for (const [id, done] of logs) {
        const did = await this.editDoc(store, id, (doc) => {
          let reverted = false;
          for (const log of [...done].reverse()) reverted = revertTagEdit(doc, log) || reverted;
          return reverted;
        });
        if (did) changed.push(id);
      }
      await this.host.refreshLocal();
      return changed;
    });
    this.running = run.catch(() => undefined);
    return run;
  }

  /**
   * Edits one note's document: an open note's in its editor's replica, otherwise its stored
   * record (`edit` says whether it changed anything). Returns whether it did.
   */
  private async editDoc(
    store: LocalNotes,
    id: string,
    edit: (doc: NoteDoc) => boolean,
  ): Promise<boolean> {
    const open = this.host.openDoc(id);
    if (open) return edit(open);
    let did = false;
    await store.update(id, (record) => {
      if (!record) return null;
      let changed = false;
      const next = changeRecord(record, (doc) => {
        changed = edit(doc);
      });
      did = changed;
      return changed ? { ...next, updatedAt: Date.now() } : null;
    });
    return did;
  }
}
