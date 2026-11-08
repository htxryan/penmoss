/**
 * Client ids across processes (T50 Mac lane, A850) and changes taken in from the device's store
 * (A851). Every writing process adds a client id to its writer's actor file (A821: never a reused
 * one, since a profile cannot prove another device lacks its clocks); a writer that has used many
 * retires for a new writer, so the file stays small.
 */
import { bodyMarkdown } from '@penmoss/editor/markdown';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { GitTransportError, MemorySecrets, MemoryTransport, parseActor } from '../src';
import { testNotebook, type TestClone } from './support/notebooks';

function append(clone: TestClone, noteId: string, text: string): void {
  const doc = clone.engine.replica.note(noteId)!;
  doc.transact(() => {
    const p = new Y.Node('paragraph');
    doc.get(NOTE_ROOT).insert(doc.get(NOTE_ROOT).length, [p]);
    p.insert(0, text);
  });
}

/** A transport that can be cut off, as a laptop on a network that drops connections. */
class Unplugged extends MemoryTransport {
  offline = false;
  override fetch(): Promise<string | null> {
    if (this.offline) {
      return Promise.reject(new GitTransportError('network', 'Could not reach the git host.'));
    }
    return super.fetch();
  }
}

function actorIds(nb: ReturnType<typeof testNotebook>, writer: string): readonly number[] {
  const bytes = nb.remote.read(nb.head()!, `.penmoss/actors/${writer}.json`);
  return parseActor(bytes)?.clientIds ?? [];
}

describe('client ids across processes (A850)', () => {
  it('every process writes under a new client id, never its last process’s', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const seen = new Set([a.engine.replica.clientID]);
    for (let i = 0; i < 5; i++) {
      const next = await nb.open('A', { storage: a.storage, secrets: a.secrets });
      const report = await next.engine.sync();
      expect(seen.has(report.clientId)).toBe(false);
      seen.add(report.clientId);
      append(next, id, `edit ${i}`);
      await next.engine.sync();
      await next.engine.save();
    }
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toContain('edit 4');
  });

  it('a profile restored from a backup after the branch was rewound never repeats a clock another device holds', async () => {
    // The review of #166 found that taking the last id back corrupted a note here: B showed
    // "one\n\ntwoee" and never converged.
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const backup = a.storage.copy();
    const rewoundTo = nb.head()!;
    append(a, id, 'two');
    await a.engine.sync();
    // B pulls A's "two".
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe('one\n\ntwo\n');
    // Someone rewinds the branch past A's push, and A's profile comes back from the backup.
    nb.remote.branches.set(nb.branch, rewoundTo);
    const restored = await nb.open('A', { storage: backup, secrets: a.secrets });
    await restored.engine.sync();
    append(restored, id, 'ee');
    await restored.engine.sync();
    for (let round = 0; round < 3; round++) {
      await b.engine.sync();
      await restored.engine.sync();
    }
    const c = await nb.open('C');
    await c.engine.sync();
    const bodies = [b, restored, c].map((clone) => bodyMarkdown(clone.engine.replica.note(id)!));
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('two');
    expect(bodies[0]).toContain('ee');
    expect(bodies[0]).not.toContain('twoee');
  });

  it('a writer that has used enough client ids retires: a new writer, and nothing is lost', async () => {
    const nb = testNotebook();
    const engine = { retireWriterAfterIds: 3 };
    const a = await nb.open('A', { create: true, engine });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const firstWriter = a.engine.writer!.id;
    let last = a;
    for (let i = 0; i < 4; i++) {
      const next = await nb.open('A', { storage: a.storage, secrets: a.secrets, engine });
      append(next, id, `edit ${i}`);
      await next.engine.sync();
      await next.engine.save();
      last = next;
    }
    const writer = last.engine.writer!.id;
    expect(writer).not.toBe(firstWriter);
    // The retired writer's actor file stays as it was; the new one's starts small.
    expect(actorIds(nb, firstWriter).length).toBeGreaterThanOrEqual(2);
    expect(actorIds(nb, writer).length).toBeLessThanOrEqual(2);
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe(
      'one\n\nedit 0\n\nedit 1\n\nedit 2\n\nedit 3\n',
    );
  });

  it('a writer whose actor file at head is too large retires at once: the edit is pushed', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    let last = a;
    for (let i = 0; i < 3; i++) {
      const next = await nb.open('A', { storage: a.storage, secrets: a.secrets });
      append(next, id, `edit ${i}`);
      await next.engine.sync();
      await next.engine.save();
      last = next;
    }
    const full = last.engine.writer!.id;
    const size = nb.remote.read(nb.head()!, `.penmoss/actors/${full}.json`)!.byteLength;
    // Another process of that writer, with an edit, where the file is over the limit already.
    const over = await nb.open('A', {
      storage: a.storage,
      secrets: a.secrets,
      engine: { maxActorBytes: size - 1 },
    });
    append(over, id, 'past the limit');
    const report = await over.engine.sync();
    const writer = over.engine.writer!.id;
    expect(writer).not.toBe(full);
    expect(report.newWriter).toBe(writer);
    expect(actorIds(nb, writer)).toContain(over.engine.replica.clientID);
    // It carries only what the old writer never pushed: the ids its file at head lists stay there.
    const pushed = actorIds(nb, full);
    expect(pushed).toContain(a.engine.replica.clientID);
    expect(actorIds(nb, writer).filter((one) => pushed.includes(one))).toEqual([]);
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toContain('past the limit');
    void last;
  });

  it('a writer retiring with its file at head too large carries every id it never pushed', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    for (let i = 0; i < 3; i++) {
      const next = await nb.open('A', { storage: a.storage, secrets: a.secrets });
      append(next, id, `edit ${i}`);
      await next.engine.sync();
      await next.engine.save();
    }
    const full = a.engine.writer!.id;
    const pushed = actorIds(nb, full);
    const size = nb.remote.read(nb.head()!, `.penmoss/actors/${full}.json`)!.byteLength;
    // A process edits offline: its id is used, never pushed.
    const transport = new Unplugged({
      remote: nb.remote,
      branch: nb.branch,
      root: nb.root,
      author: { name: 'A', email: 'a@example.invalid' },
      clock: nb.clock,
    });
    transport.offline = true;
    const offline = await nb.open('A', { storage: a.storage, secrets: a.secrets, transport });
    append(offline, id, 'offline edit');
    await expect(offline.engine.sync()).rejects.toMatchObject({ code: 'network' });
    await offline.engine.save();
    const unpushed = offline.engine.replica.clientID;
    expect(pushed).not.toContain(unpushed);
    // The next process finds the file at head over the limit: the writer retires.
    const over = await nb.open('A', {
      storage: a.storage,
      secrets: a.secrets,
      engine: { maxActorBytes: size - 1 },
    });
    append(over, id, 'past the limit');
    await over.engine.sync();
    const writer = over.engine.writer!.id;
    expect(writer).not.toBe(full);
    // Both ids never pushed are listed under the new writer, and none the old file lists.
    expect(actorIds(nb, writer)).toEqual(
      expect.arrayContaining([unpushed, over.engine.replica.clientID]),
    );
    expect(actorIds(nb, writer).filter((one) => pushed.includes(one))).toEqual([]);
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toContain('offline edit');
  });

  it('a writer whose own log at head is too large to read retires, never writes over it', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one '.repeat(2_000) });
    await a.engine.sync();
    const old = a.engine.writer!.id;
    const path = `.penmoss/notes/${id}/${old}.yjs`;
    const before = nb.remote.read(nb.head()!, path)!;
    // The next process of that writer reads no log that large.
    const next = await nb.open('A', {
      storage: a.storage,
      secrets: a.secrets,
      engine: { maxLogBytes: before.byteLength - 1 },
    });
    append(next, id, 'later edit');
    const report = await next.engine.sync();
    expect(report.commit).not.toBeNull();
    const writer = next.engine.writer!.id;
    expect(writer).not.toBe(old);
    // The log it could not read is as it was; the edit is in the new writer's own log.
    expect(nb.remote.read(nb.head()!, path)).toEqual(before);
    expect(nb.remote.read(nb.head()!, `.penmoss/notes/${id}/${writer}.yjs`)).toBeTruthy();
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toContain('later edit');
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toContain('one one');
  });

  it('offline before the write, a process writes under its new id, listed once it syncs', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const first = a.engine.replica.clientID;
    const transport = new Unplugged({
      remote: nb.remote,
      branch: nb.branch,
      root: nb.root,
      author: { name: 'A', email: 'a@example.invalid' },
      clock: nb.clock,
    });
    transport.offline = true;
    const next = await nb.open('A', { storage: a.storage, secrets: a.secrets, transport });
    await expect(next.engine.sync()).rejects.toMatchObject({ code: 'network' });
    const fresh = next.engine.replica.clientID;
    expect(fresh).not.toBe(first);
    append(next, id, 'offline edit');
    transport.offline = false;
    const report = await next.engine.sync();
    expect(next.engine.replica.state.ownClients).toContain(fresh);
    expect(report.commit).not.toBeNull();
    expect(actorIds(nb, next.engine.writer!.id)).toContain(fresh);
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toContain('offline edit');
  });

  it('a copied profile (a new writer) never takes up the original writer’s id', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const first = a.engine.replica.clientID;
    const copy = await nb.open('A', { storage: a.storage.copy(), secrets: new MemorySecrets() });
    const report = await copy.engine.sync();
    expect(report.newWriter).not.toBeNull();
    expect(copy.engine.replica.clientID).not.toBe(first);
  });
});

describe('changes taken in from the store (A851)', () => {
  it('adopts a window’s edit as a local change, its author listed in the actor file', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    // A window's own copy of the note, under its own client id, edited and stored.
    const window = new Y.Doc();
    Y.applyUpdate(window, Y.encodeStateAsUpdate(a.engine.replica.note(id)!));
    window.transact(() => {
      const p = new Y.Node('paragraph');
      window.get(NOTE_ROOT).insert(window.get(NOTE_ROOT).length, [p]);
      p.insert(0, 'typed in a window');
    });
    expect(a.engine.replica.adopt(id, Y.encodeStateAsUpdate(window))).toBe(true);
    // Nothing new the second time.
    expect(a.engine.replica.adopt(id, Y.encodeStateAsUpdate(window))).toBe(false);
    expect(Object.keys(a.engine.replica.state.dirty)).toEqual([id]);
    expect(a.engine.replica.state.ownClients).toContain(window.clientID);
    await a.engine.sync();
    expect(actorIds(nb, a.engine.writer!.id)).toContain(window.clientID);
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe('one\n\ntyped in a window\n');
  });

  it('adopts the WorkspaceDoc too (a folder made in a window)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    await a.engine.sync();
    const window = new Y.Doc();
    Y.applyUpdate(window, Y.encodeStateAsUpdate(a.engine.replica.workspace));
    window.get('settings').setAttr('probe', true);
    expect(a.engine.replica.adopt(null, Y.encodeStateAsUpdate(window))).toBe(true);
    expect(a.engine.replica.state.workspaceDirty).toBe(true);
    expect(a.engine.replica.state.ownClients).toContain(window.clientID);
  });
});
