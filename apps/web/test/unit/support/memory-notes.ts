import {
  toMeta,
  type NoteRecord,
  type PendingUpload,
  type StoredAttachment,
} from '@penmoss/sync-client';
import type { LocalNotes } from '../../../src/notes/service';

/** An in-memory stand-in for NoteStore (IndexedDB), attachments included (T10). */
export function memoryNotes(): LocalNotes & {
  records: Map<string, NoteRecord>;
  clock: number;
  state: Map<string, unknown>;
  attachments: Map<string, StoredAttachment>;
  uploads: Map<string, PendingUpload>;
} {
  const records = new Map<string, NoteRecord>();
  const attachments = new Map<string, StoredAttachment>();
  const uploads = new Map<string, PendingUpload>();
  const store = {
    records,
    attachments,
    uploads,
    clock: 0,
    get: (noteId: string) => Promise.resolve(records.get(noteId)),
    put: (record: NoteRecord) => {
      records.set(record.noteId, record);
      return Promise.resolve();
    },
    update: (noteId: string, fn: (current: NoteRecord | undefined) => NoteRecord | null) => {
      const next = fn(records.get(noteId));
      if (next) records.set(noteId, next);
      return Promise.resolve(next);
    },
    updateAll: (
      noteId: string,
      fn: (current: NoteRecord | undefined) => readonly NoteRecord[] | null,
    ) => {
      const next = fn(records.get(noteId));
      for (const record of next ?? []) records.set(record.noteId, record);
      return Promise.resolve(next);
    },
    listMeta: () => Promise.resolve([...records.values()].map(toMeta)),
    getMeta: (noteId: string) => {
      const record = records.get(noteId);
      return Promise.resolve(record ? toMeta(record) : undefined);
    },
    listTexts: () =>
      Promise.resolve(
        [...records.values()].map((record) => ({
          noteId: record.noteId,
          title: toMeta(record).title,
          text: record.text,
          headings: record.headings ?? '',
          tags: record.tags ?? [],
          updatedAt: record.updatedAt,
          deleted: record.deleted ?? false,
        })),
      ),
    delete: (noteId: string) => {
      records.delete(noteId);
      return Promise.resolve();
    },
    state: new Map<string, unknown>(),
    getState: (key: string) => Promise.resolve(store.state.get(key)),
    setState: (key: string, value: unknown) => {
      if (value === undefined) store.state.delete(key);
      else store.state.set(key, structuredClone(value));
      return Promise.resolve();
    },
    getClock: () => Promise.resolve(store.clock),
    setClock: (clock: number) => {
      store.clock = clock;
      return Promise.resolve();
    },
    getAttachment: (sha256: string) => Promise.resolve(attachments.get(sha256)),
    saveAttachment: (attachment: StoredAttachment, upload: PendingUpload | null) => {
      const current = attachments.get(attachment.sha256);
      if (current?.uploaded) return Promise.resolve(false);
      attachments.set(
        attachment.sha256,
        current ? { ...current, bytes: attachment.bytes } : attachment,
      );
      const pending = uploads.get(attachment.sha256);
      if (upload && (!pending || pending.failed)) uploads.set(upload.sha256, upload);
      return Promise.resolve(!current);
    },
    touchAttachment: (sha256: string, at: number) => {
      const current = attachments.get(sha256);
      if (current) attachments.set(sha256, { ...current, lastUsedAt: at });
      return Promise.resolve();
    },
    evictDownloads: () => Promise.resolve([]),
    listUploads: () => Promise.resolve([...uploads.values()]),
    updateUpload: (
      sha256: string,
      fn: (current: PendingUpload | undefined) => PendingUpload | null,
    ) => {
      const next = fn(uploads.get(sha256));
      if (next) uploads.set(sha256, next);
      return Promise.resolve(next);
    },
    completeUpload: (sha256: string) => {
      uploads.delete(sha256);
      const current = attachments.get(sha256);
      if (current) attachments.set(sha256, { ...current, uploaded: true });
      return Promise.resolve();
    },
  };
  return store;
}
