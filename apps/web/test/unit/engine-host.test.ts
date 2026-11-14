/**
 * The Mac's engine host (T50 G3; A852, A859): a sync out of time is stopped for good (no git
 * call after the cancel), and a push that landed after all is shown as synced, not offline.
 */
import {
  GitTransportError,
  MemorySecrets,
  NotebookReplica,
  type MemoryTransport,
} from '@penmoss/git-notebook';
import {
  addComment,
  createNoteThread,
  readThread,
  setThreadDelivery,
  setThreadTarget,
} from '@penmoss/sync-client/comments';
import { initNote, readTitle, setTitle } from '@penmoss/sync-client/note';
import { recordFromDoc } from '@penmoss/sync-client/records';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testNotebook } from '../../../../packages/git-notebook/test/support/notebooks';
import { memoryEngineKv } from '../../src/sources/engine-store';
import {
  describe as describeFailure,
  FOCUS_PULL_GAP_MS,
  GitEngineHost,
} from '../../src/sources/engine-host';
import { memoryNotes } from './support/memory-notes';

const hosts: GitEngineHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
});

/** A transport whose calls can be held: `hold(op)` makes that op wait until `cancel`. */
function controlled(inner: MemoryTransport) {
  const calls: string[] = [];
  let cancels = 0;
  const held = new Set<string>();
  /** Ops that take this long whatever `cancel` does (a git between two calls of a sync). */
  const slowOps = new Map<string, number>();
  const waiting: Array<(error: Error) => void> = [];
  let slowPush: Promise<void> | null = null;
  const transport = new Proxy(inner, {
    get(target, key, receiver) {
      if (key === 'cancel') {
        return () => {
          cancels++;
          for (const fail of waiting.splice(0)) fail(new GitTransportError('timeout', 'killed'));
          return Promise.resolve();
        };
      }
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const op = String(key);
        calls.push(op);
        const slow = slowOps.get(op);
        if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
        if (held.has(op)) {
          await new Promise<never>((_resolve, reject) => waiting.push(reject));
        }
        if (op === 'push' && slowPush) await slowPush;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    transport,
    calls,
    cancels: () => cancels,
    hold: (op: string) => held.add(op),
    slowOp: (op: string, ms: number) => slowOps.set(op, ms),
    release: (op: string) => held.delete(op),
    /** The push lands only once `land` is called (a cancel does not stop it). */
    slow: () => {
      let land = () => undefined as void;
      slowPush = new Promise<void>((resolve) => (land = resolve));
      return () => {
        slowPush = null;
        land();
      };
    },
  };
}

async function setup(
  extra: {
    closingSyncMs?: number;
    syncLimitMs?: number;
    kv?: ReturnType<typeof memoryEngineKv>;
    remote?: string;
    onlineSettleMs?: number;
    pushDelayS?: number;
    pullEveryMin?: number;
  } = {},
) {
  const nb = testNotebook();
  const cli = await nb.open('CLI', { create: true });
  cli.ops.createNote({ title: 'From the CLI', markdown: 'hello' });
  await cli.engine.sync();
  const git = controlled(nb.transport('Mac'));
  const store = memoryNotes();
  const host = new GitEngineHost({
    notebookId: '01JBNOTEBOOK00000000000001',
    name: 'Work',
    create: false,
    host: 'example.test',
    transport: git.transport,
    secrets: new MemorySecrets(),
    kv: extra.kv ?? memoryEngineKv(),
    store: () => Promise.resolve(store),
    written: () => Promise.resolve(),
    pushDelayS: extra.pushDelayS ?? 3600,
    pullEveryMin: extra.pullEveryMin ?? 60,
    // Read each time, so fake timers' clock is the host's too.
    now: () => Date.now(),
    // A limit no sync reaches by being slow (PEN-126, as PEN-115 found on the fake clock): at
    // 200 ms, a sync that a loaded Mac paused for a moment counted as offline and waited 30 s to
    // try again. Tests of the limit set their own.
    syncLimitMs: extra.syncLimitMs ?? 600_000,
    ...(extra.closingSyncMs !== undefined ? { closingSyncMs: extra.closingSyncMs } : {}),
    ...(extra.remote !== undefined ? { remote: extra.remote } : {}),
    ...(extra.onlineSettleMs !== undefined ? { onlineSettleMs: extra.onlineSettleMs } : {}),
  });
  hosts.push(host);
  return { nb, cli, git, host, store };
}

/** An edit the window stored, as `changed` hears of it. */
async function storeEdit(
  store: ReturnType<typeof memoryNotes>,
  id: string,
  title: string,
  updatedAt = 1,
) {
  const replica = createYjs14Replica();
  initNote(replica.doc, { id, created: '2026-10-30T09:00:00-05:00', kind: 'note' }, title);
  await store.put(recordFromDoc(id, replica.doc, { epoch: null, unsynced: true, updatedAt }));
}

describe('a sync out of time (A852, A859)', () => {
  it('is stopped for good: a call that ends after the cancel is the last git call', async () => {
    const { git, host } = await setup({ syncLimitMs: 200 });
    // The fetch outlasts the limit and ends anyway (the cancel came between two calls).
    git.slowOp('fetch', 400);
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('offline'), { timeout: 3000 });
    expect(host.status.code).toBe('timeout');
    expect(git.cancels()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(git.calls).toEqual(['fetch']);
  });

  it('a push that landed after the time ran out shows as synced, not offline', async () => {
    // Far above the first sync (a few ms), and the held push below outlasts any limit.
    const { git, host } = await setup({ syncLimitMs: 1000 });
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    // An edit, pushed by a push that takes longer than the limit and lands anyway.
    const land = git.slow();
    setTitle(host.engineForTests!.replica.ensureNote('01JBNOTEMAC000000000000001'), 'On the Mac');
    void host.syncNow('push');
    await vi.waitFor(() => expect(host.status.phase).toBe('offline'), { timeout: 3000 });
    land();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    expect(host.status.nextRetryAt).toBeNull();
  });
});

describe('Push after and Pull every (A825)', () => {
  it('reach the running engine at once, not at its next start', async () => {
    const { host, store } = await setup();
    const NOTE = '01JBNOTEMAC000000000000002';
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    vi.useFakeTimers();
    try {
      const syncs = vi.spyOn(host, 'syncNow');
      // Pull every 60 minutes, then 1: a pull within the minute.
      host.setCadence(3600, 1);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(syncs).toHaveBeenCalledWith('pull');
      syncs.mockClear();
      // A push waiting at an hour's delay goes at the new 5 seconds.
      host.setCadence(3600, 60);
      // A window stored an edit: taken in, and a push waits an hour.
      const replica = createYjs14Replica();
      initNote(
        replica.doc,
        { id: NOTE, created: '2026-10-29T09:00:00-05:00', kind: 'note' },
        'Soon',
      );
      await store.put(
        recordFromDoc(NOTE, replica.doc, { epoch: null, unsynced: true, updatedAt: 1 }),
      );
      host.changed([NOTE]);
      await vi.advanceTimersByTimeAsync(10);
      host.setCadence(5, 60);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(syncs).toHaveBeenCalledWith('push');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the default cadence: 12 s after edits settle, every minute while shown (A1013)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pulls every 60 s while the window is shown, none while hidden, and one when shown again', async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    // Syncs on the fake clock get a limit they never reach (setup's, PEN-115): with 200 ms, a
    // sync whose git outlasts the clock's jumps on a slow runner timed out, and its retry
    // started a sync of its own that the focus below measured its gap from.
    const { host } = await setup({ pushDelayS: 12, pullEveryMin: 1 });
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    vi.useFakeTimers();
    // The interval started on real timers: started again on the fake ones.
    host.setCadence(12, 2);
    host.setCadence(12, 1);
    const syncs = vi.spyOn(host, 'syncNow');
    const pulls = () => syncs.mock.calls.filter(([reason]) => reason === 'pull').length;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(pulls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(pulls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pulls()).toBe(2);
    doc.hidden = true;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(pulls()).toBe(2);
    // The last pull may still be running on a slow runner: a pull asked for during it only
    // follows it, and leaves lastPullAt as it was, so the focus below would pull again.
    // Let it finish first, so the shown window's pull is the one the focus is measured from.
    // idle() resolves once no sync runs; the fake clock moves on until it does.
    let idle = false;
    void host.idle().then(() => (idle = true));
    while (!idle) await vi.advanceTimersByTimeAsync(100);
    // However long that took, the last sync began more than FOCUS_PULL_GAP_MS ago, as it would
    // after three hidden minutes on a fast machine.
    await vi.advanceTimersByTimeAsync(FOCUS_PULL_GAP_MS);
    expect(pulls()).toBe(2);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(pulls()).toBe(3);
    // A focus right after it does not pull again (FOCUS_PULL_GAP_MS).
    await vi.advanceTimersByTimeAsync(1_000);
    win.dispatchEvent(new Event('focus'));
    expect(pulls()).toBe(3);
  });

  it('pushes 12 s after the last edit, and edits that keep coming within a minute', async () => {
    // Syncs on the fake clock get a limit they never reach (setup's).
    const { host, store } = await setup({ pushDelayS: 12, pullEveryMin: 60 });
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    vi.useFakeTimers();
    const syncs = vi.spyOn(host, 'syncNow');
    const pushedAt: number[] = [];
    syncs.mockImplementation(function (this: GitEngineHost, reason) {
      if (reason === 'push') pushedAt.push(Date.now());
      return GitEngineHost.prototype.syncNow.call(this, reason);
    });
    const settled = async () => {
      while (host.status.phase !== 'synced') await vi.advanceTimersByTimeAsync(100);
    };
    const NOTE = '01JBNOTEMAC000000000000010';
    const edited = Date.now();
    await storeEdit(store, NOTE, 'One', 2);
    host.changed([NOTE]);
    await vi.advanceTimersByTimeAsync(11_500);
    expect(pushedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushedAt).toHaveLength(1);
    expect(pushedAt[0]! - edited).toBeGreaterThanOrEqual(12_000);
    await settled();
    // Typing that never settles: an edit every 8 s is still pushed within 5 delays (60 s).
    const typing = Date.now();
    for (let second = 0; second < 72; second += 8) {
      await storeEdit(store, NOTE, `Two ${second}`, 10 + second);
      host.changed([NOTE]);
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(pushedAt).toHaveLength(2);
    expect(pushedAt[1]! - typing).toBeLessThanOrEqual(61_000);
    expect(pushedAt[1]! - typing).toBeGreaterThan(48_000);
  });
});

describe('a store cleared since it last synced here (A886)', () => {
  it('says what was lost when the windows’ copies went too, and what was kept when they did not', async () => {
    // First, a Mac that synced: main holds its writer secret.
    const nb = testNotebook();
    const cli = await nb.open('CLI', { create: true });
    cli.ops.createNote({ title: 'From the CLI', markdown: 'hello' });
    await cli.engine.sync();
    const secrets = new MemorySecrets();
    const make = (kv = memoryEngineKv(), store = memoryNotes()) => {
      const host = new GitEngineHost({
        notebookId: '01JBNOTEBOOK00000000000001',
        name: 'Work',
        create: false,
        host: 'example.test',
        transport: nb.transport('Mac'),
        secrets,
        kv,
        store: () => Promise.resolve(store),
        written: () => Promise.resolve(),
        pushDelayS: 3600,
        pullEveryMin: 60,
      });
      hosts.push(host);
      return { host, store };
    };
    const kv = memoryEngineKv();
    const first = make(kv);
    await first.host.start();
    await vi.waitFor(() => expect(first.host.status.phase).toBe('synced'), { timeout: 3000 });
    expect(first.host.status.cleared ?? null).toBeNull();
    first.host.stop();
    // Started again on its own store: nothing was cleared.
    const again = make(kv);
    await again.host.start();
    expect(again.host.status.cleared ?? null).toBeNull();
    again.host.stop();
    // Every store cleared: the person is told the changes not pushed could not be kept.
    const lost = make();
    await lost.host.start();
    expect(lost.host.status.cleared).toBe('lost');
    lost.host.stop();
    // The engine's store cleared, the windows' copies still there: taken in, nothing lost.
    const windows = memoryNotes();
    const replica = createYjs14Replica();
    initNote(
      replica.doc,
      { id: '01JBNOTEMAC000000000000009', created: '2026-10-29T09:00:00-05:00', kind: 'note' },
      'Kept',
    );
    await windows.put(
      recordFromDoc('01JBNOTEMAC000000000000009', replica.doc, {
        epoch: null,
        unsynced: true,
        updatedAt: 1,
      }),
    );
    const kept = make(memoryEngineKv(), windows);
    await kept.host.start();
    expect(kept.host.status.cleared).toBe('kept');
    expect(kept.host.engineForTests!.replica.note('01JBNOTEMAC000000000000009')).toBeTruthy();
  });

  it('never brings back a note deleted for good from a window’s copy (the PR #167 probe)', async () => {
    // The Mac takes the windows' copies in under their own ids (A851), so a Delete for good that
    // landed meanwhile applies to them at the first fetch: none comes back under a new id.
    const nb = testNotebook();
    const cli = await nb.open('CLI', { create: true });
    const secret = { id: cli.ops.createNote({ title: 'Passwords', markdown: 'hunter2' }) };
    cli.ops.createNote({ title: 'Groceries', markdown: 'milk' });
    await cli.engine.sync();
    const secrets = new MemorySecrets();
    const windows = memoryNotes();
    const make = (kv = memoryEngineKv()) => {
      const host = new GitEngineHost({
        notebookId: '01JBNOTEBOOK00000000000001',
        name: 'Work',
        create: false,
        host: 'example.test',
        transport: nb.transport('Mac'),
        secrets,
        kv,
        store: () => Promise.resolve(windows),
        written: () => Promise.resolve(),
        pushDelayS: 3600,
        pullEveryMin: 60,
      });
      hosts.push(host);
      return host;
    };
    const first = make();
    await first.start();
    await vi.waitFor(() => expect(first.status.phase).toBe('synced'), { timeout: 3000 });
    expect(windows.records.has(secret.id)).toBe(true);
    first.stop();
    // Deleted for good elsewhere, and it landed; the windows have not heard yet.
    await cli.engine.sync();
    cli.ops.purge(secret.id);
    await cli.engine.sync();
    // The engine's store cleared, the windows' copies still there, the purged note among them.
    const again = make();
    await again.start();
    expect(again.status.cleared).toBe('kept');
    await again.syncNow('now');
    await vi.waitFor(() => expect(again.status.phase).toBe('synced'), { timeout: 3000 });
    const engine = again.engineForTests!;
    expect(engine.replica.note(secret.id)).toBeUndefined();
    expect(windows.records.has(secret.id)).toBe(false);
    // Nothing of it at head: no file holds its text, and no note came back under a new id.
    const head = nb.head()!;
    const blobs = [...nb.remote.commits.get(head)!.tree.values()].map((blob) =>
      new TextDecoder().decode(nb.remote.blobs.get(blob)),
    );
    expect(blobs.some((text) => text.includes('hunter2'))).toBe(false);
    const reader = await nb.open('Reader');
    await reader.engine.sync();
    const left = reader.engine.replica
      .noteIds()
      .map((id) => readTitle(reader.engine.replica.note(id)!));
    expect(left).toEqual(['Groceries']);
  });

  it('tries a copy that failed to be taken in again, after a restart too', async () => {
    const nb = testNotebook();
    const cli = await nb.open('CLI', { create: true });
    cli.ops.createNote({ title: 'From the CLI', markdown: 'hello' });
    await cli.engine.sync();
    const id = '01JBNOTEMAC000000000000006';
    const windows = memoryNotes();
    const replica = createYjs14Replica();
    initNote(replica.doc, { id, created: '2026-10-29T09:00:00-05:00', kind: 'note' }, 'Made here');
    await windows.put(
      recordFromDoc(id, replica.doc, { epoch: null, unsynced: true, updatedAt: 1 }),
    );
    const kv = memoryEngineKv();
    const secrets = new MemorySecrets();
    const make = () => {
      const host = new GitEngineHost({
        notebookId: '01JBNOTEBOOK00000000000001',
        name: 'Work',
        create: false,
        host: 'example.test',
        transport: nb.transport('Mac'),
        secrets,
        kv,
        store: () => Promise.resolve(windows),
        written: () => Promise.resolve(),
        pushDelayS: 3600,
        pullEveryMin: 60,
      });
      hosts.push(host);
      return host;
    };
    // A moment's trouble taking it in: it is named, and left as it is.
    const adopt = Object.getOwnPropertyDescriptor(NotebookReplica.prototype, 'adopt')!.value as (
      this: NotebookReplica,
      noteId: string | null,
      update: Uint8Array,
    ) => boolean;
    let trouble = true;
    const spy = vi.spyOn(NotebookReplica.prototype, 'adopt').mockImplementation(function (
      this: NotebookReplica,
      noteId,
      update,
    ) {
      if (trouble && noteId === id) throw new Error('a moment of trouble');
      return adopt.call(this, noteId, update);
    });
    try {
      const first = make();
      await first.start();
      await vi.waitFor(() => expect(first.status.phase).toBe('synced'), { timeout: 3000 });
      expect(first.status.unreadable).toEqual([id]);
      expect(first.engineForTests!.replica.note(id)).toBeUndefined();
      first.stop();
      // Started again on the same store, the trouble gone: taken in, and no longer named.
      trouble = false;
      const again = make();
      await again.start();
      expect(again.engineForTests!.replica.note(id)).toBeTruthy();
      expect(again.status.unreadable ?? []).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('opens whatever a window’s copy holds: one it cannot read is kept, named and skipped', async () => {
    const nb = testNotebook();
    const cli = await nb.open('CLI', { create: true });
    cli.ops.createNote({ title: 'From the CLI', markdown: 'hello' });
    await cli.engine.sync();
    const windows = memoryNotes();
    const good = createYjs14Replica();
    initNote(
      good.doc,
      { id: '01JBNOTEMAC000000000000007', created: '2026-10-29T09:00:00-05:00', kind: 'note' },
      'Readable',
    );
    await windows.put(
      recordFromDoc('01JBNOTEMAC000000000000007', good.doc, {
        epoch: null,
        unsynced: true,
        updatedAt: 1,
      }),
    );
    const broken = recordFromDoc('01JBNOTEMAC000000000000008', createYjs14Replica().doc, {
      epoch: null,
      unsynced: true,
      updatedAt: 1,
    });
    await windows.put({ ...broken, update: new TextEncoder().encode('not a yjs update at all') });
    const host = new GitEngineHost({
      notebookId: '01JBNOTEBOOK00000000000001',
      name: 'Work',
      create: false,
      host: 'example.test',
      transport: nb.transport('Mac'),
      secrets: new MemorySecrets(),
      kv: memoryEngineKv(),
      store: () => Promise.resolve(windows),
      written: () => Promise.resolve(),
      pushDelayS: 3600,
      pullEveryMin: 60,
    });
    hosts.push(host);
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    // The rest is taken in and syncs; the unreadable copy stays in the store, named.
    expect(host.engineForTests!.replica.note('01JBNOTEMAC000000000000007')).toBeTruthy();
    expect(windows.records.has('01JBNOTEMAC000000000000008')).toBe(true);
    expect(host.status.unreadable).toEqual(['01JBNOTEMAC000000000000008']);
  });
});

describe('quitting waits for the push (#170 F8)', () => {
  it('a push in flight finishes within the closing time, shown as Pushing…', async () => {
    const { git, host, cli } = await setup({ closingSyncMs: 3000, syncLimitMs: 5000 });
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    // A push slower than the 2.5 s the closing sync once had, but within the closing time.
    const land = git.slow();
    setTitle(host.engineForTests!.replica.ensureNote('01JBNOTEMAC000000000000003'), 'Typed');
    void host.syncNow('push');
    await vi.waitFor(() => expect(git.calls).toContain('push'), { timeout: 3000 });
    const closing = host.beforeClose();
    await vi.waitFor(() => expect(host.status.closing).toBe(true), { timeout: 1000 });
    setTimeout(land, 400);
    await closing;
    expect(git.cancels()).toBe(0);
    expect(host.status).toMatchObject({ phase: 'synced', closing: false });
    await cli.engine.sync();
    expect(readTitle(cli.engine.replica.note('01JBNOTEMAC000000000000003')!)).toBe('Typed');
  });

  it('every window asks at once as the app quits: none is answered before the push lands', async () => {
    const { git, host, cli } = await setup({ closingSyncMs: 3000, syncLimitMs: 5000 });
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    const land = git.slow();
    setTitle(host.engineForTests!.replica.ensureNote('01JBNOTEMAC000000000000005'), 'Both');
    // Two windows, so two asks; the app quits when every answer is in.
    const answered: string[] = [];
    const first = host.beforeClose().then(() => answered.push('first'));
    const second = host.beforeClose().then(() => answered.push('second'));
    await vi.waitFor(() => expect(git.calls).toContain('push'), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(answered).toEqual([]);
    land();
    await Promise.all([first, second]);
    expect(git.cancels()).toBe(0);
    await cli.engine.sync();
    expect(readTitle(cli.engine.replica.note('01JBNOTEMAC000000000000005')!)).toBe('Both');
  });

  it('a pull longer than the closing time is never stopped when nothing waits (#174 review)', async () => {
    const { git, host } = await setup({ closingSyncMs: 300, syncLimitMs: 5000 });
    await host.start();
    await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
    const fetches = git.calls.filter((call) => call === 'fetch').length;
    git.slowOp('fetch', 800);
    void host.syncNow('pull');
    await vi.waitFor(
      () => expect(git.calls.filter((call) => call === 'fetch').length).toBe(fetches + 1),
      { timeout: 3000 },
    );
    await host.beforeClose();
    expect(git.cancels()).toBe(0);
    await host.idle();
  });

  it('one that cannot finish is stopped, kept, and pushed first at the next start', async () => {
    const kv = memoryEngineKv();
    const first = await setup({ closingSyncMs: 300, syncLimitMs: 5000, kv });
    await first.host.start();
    await vi.waitFor(() => expect(first.host.status.phase).toBe('synced'), { timeout: 3000 });
    first.git.hold('push');
    setTitle(first.host.engineForTests!.replica.ensureNote('01JBNOTEMAC000000000000004'), 'Late');
    void first.host.syncNow('push');
    await vi.waitFor(() => expect(first.git.calls).toContain('push'), { timeout: 3000 });
    await first.host.beforeClose();
    expect(first.git.cancels()).toBeGreaterThan(0);
    expect(await kv.get('pushOwed')).toBeTypeOf('number');
    first.host.stop();
    // The next launch: the same store, and it says what it pushes first.
    first.git.release('push');
    const next = new GitEngineHost({
      notebookId: '01JBNOTEBOOK00000000000001',
      name: 'Work',
      create: false,
      host: 'example.test',
      transport: first.git.transport,
      secrets: new MemorySecrets(),
      kv,
      store: () => Promise.resolve(first.store),
      written: () => Promise.resolve(),
      pushDelayS: 3600,
      pullEveryMin: 60,
      syncLimitMs: 2000,
    });
    hosts.push(next);
    const said: Array<string | null> = [];
    next.onStatus((status) => said.push(status.detail));
    await next.start();
    expect(said).toContain('Pushing what was not pushed when Penmoss last quit.');
    await vi.waitFor(() => expect(next.status.phase).toBe('synced'), { timeout: 3000 });
    expect(await kv.get('pushOwed')).toBeUndefined();
  });
});

describe('offline, said at once (#170 F9)', () => {
  it('an edit with the network down says Offline at once, and the network back syncs at once', async () => {
    const events = new EventTarget();
    let online = true;
    vi.stubGlobal('window', events);
    vi.stubGlobal('navigator', {
      get onLine() {
        return online;
      },
    });
    try {
      const { git, host, store } = await setup();
      await host.start();
      await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
      online = false;
      events.dispatchEvent(new Event('offline'));
      expect(host.status.phase).toBe('offline');
      expect(host.status.detail).toContain('This Mac is offline');
      const NOTE = '01JBNOTEMAC000000000000005';
      await storeEdit(store, NOTE, 'Offline edit');
      host.changed([NOTE]);
      await vi.waitFor(() => expect(host.status.pending).toContain(NOTE), { timeout: 1000 });
      expect(host.status.phase).toBe('offline');
      // Sync now still tries: a person asked, and the browser's word may be wrong (#174 review).
      const before = git.calls.length;
      await host.syncNow('now');
      expect(git.calls.length).toBeGreaterThan(before);
      // Another edit offline: Offline at once again.
      const NEXT = '01JBNOTEMAC000000000000006';
      await storeEdit(store, NEXT, 'Offline again');
      host.changed([NEXT]);
      await vi.waitFor(() => expect(host.status.pending).toContain(NEXT), { timeout: 1000 });
      expect(host.status.phase).toBe('offline');
      // Back online: once the network has stayed up a moment, at once, not after a backoff.
      const at = git.calls.length;
      online = true;
      events.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 4000 });
      expect(host.status.pending).not.toContain(NEXT);
      expect(git.calls.slice(at)).toContain('push');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('offline, and what it is not (#174 review)', () => {
  function offlineWorld() {
    const events = new EventTarget();
    const net = { online: false };
    vi.stubGlobal('window', events);
    vi.stubGlobal('navigator', {
      get onLine() {
        return net.online;
      },
    });
    return { events, net };
  }

  it('a remote on this Mac (file://, loopback) syncs whatever the network says', async () => {
    offlineWorld();
    try {
      for (const remote of ['file:///Users/ryan/notes.git', 'http://127.0.0.1:8080/notes.git']) {
        const { git, host, store } = await setup({ remote });
        await host.start();
        await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
        const NOTE = '01JBNOTEMAC000000000000007';
        await storeEdit(store, NOTE, 'Local');
        host.changed([NOTE]);
        await vi.waitFor(() => expect(host.status.pending).toContain(NOTE), { timeout: 1000 });
        expect(host.status.phase).not.toBe('offline');
        const before = git.calls.length;
        await host.syncNow('push');
        expect(git.calls.slice(before)).toContain('push');
        expect(host.status.pending).not.toContain(NOTE);
        host.stop();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a network that flaps is not chased: the backoff is kept until it stays up', async () => {
    const { events, net } = offlineWorld();
    net.online = true;
    try {
      const { git, host } = await setup({ onlineSettleMs: 300 });
      await host.start();
      await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
      net.online = false;
      events.dispatchEvent(new Event('offline'));
      expect(host.status.phase).toBe('offline');
      const before = git.calls.length;
      // Up and down again within the moment: nothing is tried.
      for (let flap = 0; flap < 3; flap++) {
        net.online = true;
        events.dispatchEvent(new Event('online'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        net.online = false;
        events.dispatchEvent(new Event('offline'));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(git.calls.length).toBe(before);
      // Up for good: one sync.
      net.online = true;
      events.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
      expect(git.calls.length).toBeGreaterThan(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Sync now pressed while a sync runs (#174 delta review)', () => {
  it('runs as a Sync now after it, whatever the network says, and never ends on Offline', async () => {
    const events = new EventTarget();
    const net = { online: true };
    vi.stubGlobal('window', events);
    vi.stubGlobal('navigator', {
      get onLine() {
        return net.online;
      },
    });
    try {
      const { git, host } = await setup({ syncLimitMs: 5000 });
      await host.start();
      await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
      git.slowOp('fetch', 300);
      const first = host.syncNow('now');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The browser now says offline (it may be wrong), and the person presses Sync now again.
      net.online = false;
      const second = host.syncNow('now');
      const fetches = git.calls.filter((call) => call === 'fetch').length;
      await Promise.all([first, second]);
      await vi.waitFor(
        () => expect(git.calls.filter((call) => call === 'fetch').length).toBe(fetches + 1),
        { timeout: 3000 },
      );
      await vi.waitFor(() => expect(host.status.phase).toBe('synced'), { timeout: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(host.status.phase).toBe('synced');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('GitHub refuses a private email (GH007, #170 F6)', () => {
  it('says to commit as the no-reply address, set for this notebook or as git’s user.email', () => {
    const said = describeFailure(
      new GitTransportError(
        'rules',
        "The host's repository rules refused the push.",
        'error: GH007: Your push would publish a private email address.\nYou can make your email public or disable this protection by visiting:\nhttps://github.com/settings/emails',
      ),
      'github.com',
    );
    expect(said.status).toMatchObject({ phase: 'stopped', code: 'rules' });
    expect(said.status.detail).toContain(
      'GitHub refused the push: its commits would make your private email address public (GH007).',
    );
    expect(said.status.detail).toContain(
      'set it as this notebook’s commit email in Settings → Notebooks, or as git’s user.email',
    );
  });
});

describe('after a Send to: at once, then every 10 s until the reply (A1061, A1065, A1072)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const NOTE = '01JBNOTEMAC000000000000020';
  const THREAD = 'thread-sent';
  const RYAN = { id: 'device:this-device', kind: 'device', label: 'You' } as const;
  const CLAUDE = { id: 'agent:W1', kind: 'agent', label: 'Claude Code' } as const;
  const TARGET = { writer: 'W1', session: 'session-key', label: 'Claude Code · penmoss' };

  /** The window's note, with a thread sent to a session and waiting, stored. */
  async function storeSent(store: ReturnType<typeof memoryNotes>) {
    const replica = createYjs14Replica();
    initNote(replica.doc, { id: NOTE, created: '2026-11-04T09:00:00-06:00', kind: 'note' }, 'Ask');
    createNoteThread(replica.doc, {
      id: THREAD,
      author: RYAN,
      at: 1,
      comment: { id: 'c-1', body: 'Plant the tomatoes?' },
      target: TARGET,
    });
    setThreadDelivery(replica.doc, THREAD, {
      state: 'waiting',
      commentId: 'c-1',
      session: TARGET.session,
      at: 1,
    });
    await store.put(
      recordFromDoc(NOTE, replica.doc, { epoch: null, unsynced: true, updatedAt: 5 }),
    );
  }

  async function started() {
    // The usual cadence (A1013); setup's syncs never run out of time on the fake clock.
    const ready = await setup({ pushDelayS: 12, pullEveryMin: 60 });
    await ready.host.start();
    await vi.waitFor(() => expect(ready.host.status.phase).toBe('synced'), { timeout: 3000 });
    vi.useFakeTimers();
    const syncs = vi.spyOn(ready.host, 'syncNow');
    const count = (reason: string) => syncs.mock.calls.filter(([r]) => r === reason).length;
    const settled = async () => {
      await vi.advanceTimersByTimeAsync(0);
      await ready.host.idle();
    };
    return { ...ready, count, settled };
  }

  it('pushes at once, not 12 s later, pulls every 10 s, and stops once the thread is replied', async () => {
    const { cli, host, store, count, settled } = await started();
    await storeSent(store);
    void host.agentSent(NOTE, THREAD);
    expect(count('push')).toBe(1);
    await settled();
    // The agent's clone has it at once, without the push delay.
    await cli.engine.sync();
    const agentDoc = cli.ops.note(NOTE)!;
    expect(readThread(agentDoc, THREAD)?.delivery?.state).toBe('waiting');
    expect(host.watchedThreads).toEqual([`${NOTE}/${THREAD}`]);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(count('pull')).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(count('pull')).toBe(1);
    await settled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count('pull')).toBe(2);
    await settled();
    // The agent replies, and its clone pushes.
    addComment(agentDoc, THREAD, { id: 'c-2', author: CLAUDE, body: 'Yes, in May.', at: 2 });
    setThreadDelivery(agentDoc, THREAD, {
      state: 'replied',
      commentId: 'c-1',
      session: TARGET.session,
      at: 2,
    });
    await cli.engine.sync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count('pull')).toBe(3);
    await settled();
    // The reply reached the engine, and the watch is over: back to the usual pull.
    expect(readThread(host.engineForTests!.replica.note(NOTE)!, THREAD)?.delivery?.state).toBe(
      'replied',
    );
    expect(host.watchedThreads).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(count('pull')).toBe(3);
  });

  it('pulls for 10 minutes with no reply, then only at the usual cadence', async () => {
    const { host, store, count, settled } = await started();
    await storeSent(store);
    void host.agentSent(NOTE, THREAD);
    await settled();
    for (let second = 0; second < 10 * 60; second += 10) {
      await vi.advanceTimersByTimeAsync(10_000);
      await settled();
    }
    const pulled = count('pull');
    // One every 10 s for 10 minutes (the last tick finds the watch over).
    expect(pulled).toBeGreaterThanOrEqual(58);
    expect(pulled).toBeLessThanOrEqual(60);
    expect(host.watchedThreads).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(count('pull')).toBe(pulled);
  });

  it('a thread sent to nobody again ends its watch at the next pull', async () => {
    const { cli, host, store, count, settled } = await started();
    await storeSent(store);
    void host.agentSent(NOTE, THREAD);
    await settled();
    await cli.engine.sync();
    setThreadTarget(cli.ops.note(NOTE)!, THREAD, null);
    await cli.engine.sync();
    await vi.advanceTimersByTimeAsync(10_000);
    await settled();
    expect(host.watchedThreads).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count('pull')).toBe(1);
  });
});
