/**
 * The replica keeper (T59, A1031): the persistence half of the provider that went with the
 * server. It stores a note's replica in this device's store, reads another writer's record in,
 * and stores everything before it lets go.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { NoteStore } from '../src/idb';
import { ReplicaKeeper } from '../src/keeper';
import { recordFromDoc } from '../src/records';
import { appendParagraph, createReplica } from './support/editing';

let dbCount = 0;
const openStore = () => NoteStore.open(`penmoss-keeper-${++dbCount}`);

describe('ReplicaKeeper', () => {
  it('stores an edit, marked unsynced, and says when it is on this device', async () => {
    const store = await openStore();
    const replica = createReplica();
    const keeper = new ReplicaKeeper({ noteId: 'n1', replica, store, title: () => 'One' });
    await keeper.load();
    expect(keeper.savedLocally).toBe(true);
    const changes: boolean[] = [];
    keeper.onChange(() => changes.push(keeper.savedLocally));
    appendParagraph(replica, 'hello');
    expect(keeper.unsynced).toBe(true);
    expect(keeper.unsavedLocalEdits).toBe(true);
    await keeper.flush();
    expect(keeper.unsavedLocalEdits).toBe(false);
    expect(keeper.savedLocally).toBe(true);
    expect(changes).toContain(true);
    const record = await store.get('n1');
    expect(record?.unsynced).toBe(true);
    expect(record?.title).toBe('One');
    expect(record?.text).toContain('hello');
    await keeper.destroy();
    store.close();
  });

  it('opens from the stored record, which is not a local edit', async () => {
    const store = await openStore();
    const first = createReplica();
    appendParagraph(first, 'kept');
    await store.put(recordFromDoc('n2', first.doc, { epoch: null, unsynced: false }));
    const replica = createReplica();
    const keeper = new ReplicaKeeper({ noteId: 'n2', replica, store });
    await keeper.load();
    expect(replica.plainText()).toContain('kept');
    expect(keeper.unsynced).toBe(false);
    expect(keeper.unsavedLocalEdits).toBe(false);
    await keeper.destroy();
    store.close();
  });

  it('reads in what another writer stored, and keeps both when it writes', async () => {
    const store = await openStore();
    const mine = createReplica();
    const keeper = new ReplicaKeeper({ noteId: 'n3', replica: mine, store });
    await keeper.load();
    appendParagraph(mine, 'mine');
    await keeper.flush();
    // Another window adds to the stored record.
    const stored = await store.get('n3');
    const theirs = createReplica();
    theirs.applyUpdate(stored!.update);
    appendParagraph(theirs, 'theirs');
    await store.put(recordFromDoc('n3', theirs.doc, { epoch: null, unsynced: true }));
    expect(await keeper.pullStored()).toBe(true);
    expect(mine.plainText()).toContain('theirs');
    // Read already: nothing new to read.
    expect(await keeper.pullStored()).toBe(false);
    appendParagraph(mine, 'after');
    await keeper.destroy();
    const last = await store.get('n3');
    expect(last?.text).toContain('mine');
    expect(last?.text).toContain('theirs');
    expect(last?.text).toContain('after');
    store.close();
  });

  it('stores every change before destroy resolves', async () => {
    const store = await openStore();
    const replica = createReplica();
    const keeper = new ReplicaKeeper({ noteId: 'n4', replica, store, persistDelayMs: 10_000 });
    await keeper.load();
    appendParagraph(replica, 'late');
    await keeper.destroy();
    expect((await store.get('n4'))?.text).toContain('late');
    // A destroyed keeper writes nothing more.
    appendParagraph(replica, 'ignored');
    await keeper.flush();
    expect((await store.get('n4'))?.text).not.toContain('ignored');
    store.close();
  });
});
