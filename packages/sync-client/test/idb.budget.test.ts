// A wall-clock budget (A1244): `task budgets` runs it, never
// `task check`. That the store opens and lists 5,000 notes is a unit test (idb.test.ts).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { NoteStore, type NoteRecord } from '../src/idb';

function record(noteId: string, update: Uint8Array): NoteRecord {
  return {
    noteId,
    engine: 'yjs14',
    update,
    stateVector: new Uint8Array([0]),
    text: `Title of ${noteId}\nbody`,
    epoch: 'epoch-1',
    updatedAt: 1_700_000_000_000,
    unsynced: false,
  };
}

describe('NoteStore', () => {
  it('opens a 5,000-note store and lists its metadata (indicative timing in Node)', async () => {
    const name = 'penmoss-budget-5000';
    const seed = await NoteStore.open(name);
    await seed.putMany(
      Array.from({ length: 5000 }, (_, i) =>
        record(`note-${String(i).padStart(5, '0')}`, new Uint8Array(1500).fill(i % 256)),
      ),
    );
    seed.close();

    const started = performance.now();
    const store = await NoteStore.open(name);
    const meta = await store.listMeta();
    const elapsed = performance.now() - started;
    store.close();

    expect(meta).toHaveLength(5000);
    // fake-indexeddb is in-memory, so this is indicative; the real check runs in Chromium (Playwright).
    console.info(
      `[t4] fake-indexeddb: open + listMeta of 5,000 notes took ${elapsed.toFixed(0)} ms`,
    );
    expect(elapsed).toBeLessThan(1000);
  });
});
