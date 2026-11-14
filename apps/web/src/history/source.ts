/**
 * Where the History panel reads a note's versions (T21; T50 G6, #154, A858): the note's git
 * notebook's commits, read through the Mac app's main process (`penmoss:git:op`). Since T59
 * (D49) that is the only place: the server's versions went with the server. Restore (A80) and
 * Revert (A81) are ordinary changes to the note: this window makes them, and they sync as any
 * other edit does, so an agent's change stays undoable on the Mac too.
 */
import { Layout, NotebookHistory, type GitVersion } from '@penmoss/git-notebook';
import { revertChange } from '@penmoss/editor/revert';
import { restoreContent } from '@penmoss/sync-client/history';
import type { Notes } from '../notes/service';
import type { GitSource } from '../sources/git-source';
import { IpcGitTransport } from '../sources/ipc-transport';

export interface HistoryAuthor {
  readonly id: string;
  readonly kind: 'device' | 'agent';
  readonly label: string;
}
export interface HistoryVersion {
  readonly id: number;
  readonly createdAt: number;
  readonly reason: string;
  readonly summary: string;
  readonly authors: HistoryAuthor[];
}
export interface HistoryList {
  readonly versions: HistoryVersion[];
  readonly unversioned: { readonly authors: HistoryAuthor[]; readonly since: number } | null;
}
export interface DiffOp {
  readonly op: 'same' | 'add' | 'del';
  readonly line: string;
}
export interface HistoryDetail {
  readonly id: number;
  readonly previousId: number | null;
  readonly markdown: string;
  readonly diff: DiffOp[];
}
export interface HistoryConflict {
  readonly part: 'body' | 'title';
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
}
export interface HistoryChange {
  readonly changed: boolean;
  readonly conflicts?: readonly HistoryConflict[];
}

/** A reply that was not a success: the history's keeper is reachable, unlike offline. */
export class HistoryRefused extends Error {
  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
  ) {
    super(message);
  }
}

export interface HistorySource {
  /** Words for "it could not be reached" (git). */
  readonly offline: string;
  /** How versions are made, as the panel says it. */
  readonly automatic: string;
  /** The Save button's words. */
  readonly saveLabel: string;
  /**
   * The versions, fast (Ryan's review of #192): when and who from the log alone. A version's
   * `summary` is '' until `summaries` has read it.
   */
  list(): Promise<HistoryList>;
  /** What each of these versions (ids from `list`) changed, read together: id → summary. */
  summaries(versions: readonly number[]): Promise<ReadonlyMap<number, string>>;
  detail(version: number): Promise<HistoryDetail | null>;
  /** Makes a version of the note as it is now. */
  save(): Promise<void>;
  restore(version: number): Promise<HistoryChange>;
  revert(version: number): Promise<HistoryChange>;
}

/** No git notebook in scope (a view without one): nothing to read, and nothing changes. */
export function noHistory(): HistorySource {
  const refused = () => Promise.reject(new HistoryRefused(404, 'No git notebook holds this note'));
  return {
    offline: 'Version history is the note’s git notebook’s, and none is open here.',
    automatic: 'Versions are the git notebook’s commits.',
    saveLabel: 'Sync Now',
    list: refused,
    summaries: () => Promise.resolve(new Map()),
    detail: () => Promise.resolve(null),
    save: refused,
    restore: refused,
    revert: refused,
  };
}

/** How long Save waits for the engine's sync (its own limit is 90 s). */
const SAVE_WAIT_MS = 95_000;

/** One reader per notebook, so commits read once stay read (they never change). */
const readers = new WeakMap<GitSource, NotebookHistory>();

export function readerOf(source: GitSource): NotebookHistory {
  let reader = readers.get(source);
  if (!reader) {
    const info = source.info;
    const root = info.dir ? `${info.dir}/` : '';
    reader = new NotebookHistory(
      new IpcGitTransport(source.git, info.localId, root),
      new Layout(root),
    );
    readers.set(source, reader);
  }
  return reader;
}

/** This Mac, as the author of what it changed and has not committed yet. */
const THIS_MAC: HistoryAuthor = { id: 'this-mac', kind: 'device', label: 'This Mac' };

/**
 * A git notebook's versions (A858): its commits that touched the note. Save is Sync now (a sync
 * commits what changed); Restore and Revert edit the note here, as an ordinary change.
 */
export function gitHistory(source: GitSource, notes: Notes, noteId: string): HistorySource {
  const reader = () => readerOf(source);
  const missing = () => new HistoryRefused(404, 'No such version');
  const pushNote = () => pushNoteOf(source, notes, noteId);
  const saveCurrentFirst = () => saveFirst(source, notes, noteId);
  const ownerFirst = (revert: boolean) => ownerCheck(source, noteId, revert);
  /** The versions `list` gave last, by id: their commits, for `summaries`. */
  let listed = new Map<number, GitVersion>();
  return {
    offline: `Version history could not read ${source.name}’s git history.`,
    automatic:
      'Each sync with git is a version: this Mac commits its changes when it pushes, and every agent’s commit is a version of its own.',
    saveLabel: 'Sync Now',
    list: async () => {
      const history = await reader().versions(noteId, { limit: 100 });
      listed = new Map(history.versions.map((version) => [version.id, version]));
      const pending = source.feed.status.pending.includes(noteId);
      const since = notes.list().find((entry) => entry.id === noteId)?.updatedAt ?? Date.now();
      return {
        versions: history.versions,
        unversioned: pending ? { authors: [THIS_MAC], since } : null,
      };
    },
    summaries: (ids) =>
      reader().summaries(
        noteId,
        ids.flatMap((id) => {
          const version = listed.get(id);
          return version ? [version] : [];
        }),
      ),
    detail: (version) => reader().detail(noteId, version),
    save: pushNote,
    restore: async (version) => {
      await ownerFirst(false);
      const found = await reader().commitOf(noteId, version);
      if (!found) throw missing();
      return restoreToCommit(source, notes, noteId, found.commit.id, { ownerChecked: true });
    },
    revert: async (version) => {
      await ownerFirst(true);
      if (!(await reader().commitOf(noteId, version))) throw missing();
      await saveCurrentFirst();
      const pair = await reader().revertPair(noteId, version);
      if (!pair) throw missing();
      let result: HistoryChange = { changed: false, conflicts: [] };
      try {
        await notes.editNote(noteId, (doc) => {
          let changed = false;
          const mark = () => {
            changed = true;
          };
          doc.on('update', mark);
          let conflicts: readonly HistoryConflict[] = [];
          try {
            doc.transact(() => {
              conflicts = revertChange(doc, pair.before, pair.after).conflicts;
            });
          } finally {
            doc.off('update', mark);
          }
          result = { changed, conflicts };
        });
      } finally {
        pair.before.destroy();
        pair.after.destroy();
      }
      return result;
    },
  };
}

/**
 * Pushes the note as this window holds it: the editor's last keystrokes stored, the engine's
 * copy holding every record the windows stored (its window may not have taken them in yet), then
 * a sync. A sync already under way when Sync Now was pressed may have committed the note
 * before it took them in, so one more runs while the note is still not pushed.
 */
async function pushNoteOf(source: GitSource, notes: Notes, noteId: string): Promise<void> {
  await notes.saveAll();
  await source.feed.settled();
  await syncAndWait(source);
  if (source.feed.status.pending.includes(noteId)) await syncAndWait(source);
}

/**
 * The note as it is now becomes a version before a Restore or a Revert replaces it, as the
 * server saves one first: the restore can then be undone too. Not pushed (offline, refused),
 * the restore is refused rather than replacing what history would not keep.
 */
async function saveFirst(source: GitSource, notes: Notes, noteId: string): Promise<void> {
  await pushNoteOf(source, notes, noteId).catch(() => undefined);
  if (source.feed.status.pending.includes(noteId)) {
    throw new HistoryRefused(
      409,
      'The note has changes not pushed yet, and they could not be saved as a version first. Sync, then try again: nothing was changed.',
    );
  }
}

/**
 * The owner check first, while the click's activation lasts (A877, A901): Touch ID, as
 * Android's BiometricPrompt, before a restore or a revert changes the note.
 */
async function ownerCheck(source: GitSource, noteId: string, revert: boolean): Promise<void> {
  const refused = await source.restoreCheck(noteId, revert);
  if (refused !== null) throw new HistoryRefused(403, refused);
}

/**
 * Restore (A80, A858) to the note as it was at `commit`: the owner checked, the note as it is
 * now saved as a version first, then the old content applied as an ordinary change. History's
 * Restore This Version and the Time Machine's (PEN-21) both come here.
 */
export async function restoreToCommit(
  source: GitSource,
  notes: Notes,
  noteId: string,
  commit: string,
  options: { readonly ownerChecked?: boolean } = {},
): Promise<HistoryChange> {
  // First, while the click's activation lasts (A877).
  if (!options.ownerChecked) await ownerCheck(source, noteId, false);
  await saveFirst(source, notes, noteId);
  const old = await readerOf(source).docAt(noteId, commit);
  let changed = false;
  try {
    await notes.editNote(noteId, (doc) => {
      changed = restoreContent(doc, old);
    });
  } finally {
    old.destroy();
  }
  return { changed };
}

/** Sync now, resolved once a sync after it ended; refused when it ended without syncing. */
function syncAndWait(source: GitSource): Promise<void> {
  const asked = Date.now();
  return new Promise((resolve, reject) => {
    let off = () => undefined as void;
    const timer = setTimeout(() => {
      off();
      reject(new Error('The sync did not finish.'));
    }, SAVE_WAIT_MS);
    const check = () => {
      const status = source.feed.status;
      if (status.phase === 'syncing' || status.phase === 'starting') return false;
      if (status.phase === 'synced' && (status.lastSyncAt ?? 0) >= asked) {
        resolve();
        return true;
      }
      if (status.phase === 'offline' || status.phase === 'stopped') {
        if ((status.lastSyncAt ?? 0) >= asked) return false;
        // Only once this sync has ended: a status from before it says nothing yet.
        if (seenSyncing) {
          reject(new Error(status.detail ?? 'The sync did not finish.'));
          return true;
        }
      }
      return false;
    };
    let seenSyncing = false;
    off = source.feed.subscribe(() => {
      const phase = source.feed.status.phase;
      if (phase === 'syncing' || phase === 'starting') seenSyncing = true;
      if (check()) {
        clearTimeout(timer);
        off();
      }
    });
    source.syncNow();
  });
}
