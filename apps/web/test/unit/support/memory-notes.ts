import { type StoredAttachment } from '../../../src/store/attachment-store';
import { type NoteRecord } from '@penmoss/model/record';
import { toMeta } from '@penmoss/model/records';
import type { LocalNotes } from '../../../src/notes/service';

/** An in-memory stand-in for NoteStore (IndexedDB), attachments included (T10). */
export function memoryNotes(): LocalNotes & {
  records: Map<string, NoteRecord>;
  state: Map<string, unknown>;
  attachments: Map<string, StoredAttachment>;
} {
  const records = new Map<string, NoteRecord>();
  const attachments = new Map<string, StoredAttachment>();
  const store = {
    records,
    attachments,
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
    getAttachment: (sha256: string) => Promise.resolve(attachments.get(sha256)),
    saveAttachment: (attachment: StoredAttachment) => {
      const current = attachments.get(attachment.sha256);
      attachments.set(
        attachment.sha256,
        current ? { ...current, bytes: attachment.bytes } : attachment,
      );
      return Promise.resolve(!current);
    },
  };
  return store;
}
