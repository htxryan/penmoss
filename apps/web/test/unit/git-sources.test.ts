/**
 * Git notebooks as sources in the Mac app's pages (T50 G3, G4, G5; A822, A827, A860, A862): one
 * window runs a notebook's engine, the others hand their changes over through the store and
 * take the engine over when its window goes; the repository's changes reach every window; no
 * source's ids resolve in another; the Journal notebook, and no personal source (T59, D49).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentActivity, type MemoryTransport } from '@penmoss/git-notebook';
import type { NoteRecord } from '@penmoss/sync-client';
import { readTitle, setTitle } from '@penmoss/sync-client/note';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import { appendMarkdown } from '@penmoss/editor/capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testNotebook } from '../../../../packages/git-notebook/test/support/notebooks';
import type { DesktopGit, GitAnswer, GitNotebookInfo } from '../../src/desktop/bridge';
import { NoteDirectory } from '../../src/notes/directory';
import type { LocalNotes, Notes } from '../../src/notes/service';
import { memoryEngineKv } from '../../src/sources/engine-store';
import { describe as describeFailure } from '../../src/sources/engine-host';
import { GitSource, type EngineLocks, type StatusChannel } from '../../src/sources/git-source';
import { GitRefused } from '../../src/sources/ipc-transport';
import { gitHistory } from '../../src/history/source';
import { isOpen, JOURNAL_KEY, routeChanged, Sources } from '../../src/sources/registry';
import type { Workspace } from '../../src/workspace/service';
import { GitTransportError } from '@penmoss/git-notebook';
import { fitWords, GitNotebooks } from '../../../desktop/src/git-notebooks';
import { memoryNotes } from './support/memory-notes';
import { memoryStorage } from './support/memory-storage';

const NOTEBOOK = '01JBNOTEBOOK00000000000001';

// Undone last first, each awaited: a source halts before the folder it writes in goes (#172).
const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  vi.useRealTimers();
});

/** One window's connection to the shared notes store: its own `onWrite`, as NoteStore's is. */
function connection(shared: ReturnType<typeof memoryNotes>): LocalNotes {
  const listeners = new Set<(ids: readonly string[]) => void>();
  const wrote = (ids: readonly string[]) => {
    for (const listener of listeners) listener(ids);
  };
  return {
    ...shared,
    put: async (record: NoteRecord) => {
      await shared.put(record);
      wrote([record.noteId]);
    },
    update: async (id, fn) => {
      const next = await shared.update(id, fn);
      if (next) wrote([id]);
      return next;
    },
    delete: async (id) => {
      await shared.delete!(id);
      wrote([id]);
    },
    onWrite: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Web Locks: one holder per name, the rest wait in line; an aborted wait leaves it. */
function fifoLocks(): EngineLocks & { holder(name: string): number | null } {
  const queues = new Map<string, Array<{ id: number; run: () => void }>>();
  const held = new Map<string, number>();
  let ids = 0;
  const next = (name: string) => {
    if (held.has(name)) return;
    const first = queues.get(name)?.shift();
    if (first) first.run();
  };
  return {
    holder: (name) => held.get(name) ?? null,
    request(name, options, callback) {
      const id = ++ids;
      return new Promise((resolve, reject) => {
        const entry = {
          id,
          run: () => {
            held.set(name, id);
            callback(null)
              .then(resolve, reject)
              .finally(() => {
                held.delete(name);
                next(name);
              });
          },
        };
        const queue = queues.get(name) ?? [];
        queue.push(entry);
        queues.set(name, queue);
        options.signal?.addEventListener('abort', () => {
          const list = queues.get(name) ?? [];
          const index = list.indexOf(entry);
          if (index >= 0) {
            list.splice(index, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        });
        next(name);
      });
    },
  };
}

/** A BroadcastChannel between the windows of one test. */
function channels() {
  const all = new Set<{ listeners: Set<(event: MessageEvent) => void> }>();
  return (): StatusChannel => {
    const own = { listeners: new Set<(event: MessageEvent) => void>() };
    all.add(own);
    return {
      postMessage: (message) => {
        for (const other of all) {
          if (other === own) continue;
          for (const listener of other.listeners) {
            queueMicrotask(() => listener({ data: structuredClone(message) } as MessageEvent));
          }
        }
      },
      addEventListener: (_type, listener) => own.listeners.add(listener),
      removeEventListener: (_type, listener) => own.listeners.delete(listener),
      close: () => all.delete(own),
    };
  };
}

/** The main process's git calls, over a memory transport (as `GitNotebooks.op` marshals them). */
function fakeGit(transport: MemoryTransport): DesktopGit & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  const run = async (op: string, args: readonly unknown[]): Promise<unknown> => {
    const t = transport as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    switch (op) {
      case 'list':
      case 'sizes':
      case 'read': {
        const out = (await t[op]!(...args)) as ReadonlyMap<string, unknown>;
        return [...out];
      }
      case 'commit':
        return t[op]!(args[0], new Map(args[1] as Array<[string, Uint8Array | null]>), args[2]);
      default:
        return t[op]!(...args);
    }
  };
  return {
    secrets,
    list: () => Promise.resolve([]),
    add: () => Promise.resolve(null),
    remove: () => Promise.resolve(null),
    update: () => Promise.resolve(null),
    setToken: () => Promise.resolve(null),
    purgeCheck: () => Promise.resolve({ ok: true, value: null }),
    restoreCheck: () => Promise.resolve({ ok: true, value: null }),
    purgesToConfirm: () => Promise.resolve({ ok: true, value: [] }),
    writerSecret: (localId, value) => {
      if (value !== undefined) secrets.set(localId, value);
      return Promise.resolve({
        ok: true,
        value: value === undefined ? (secrets.get(localId) ?? null) : null,
      });
    },
    op: async (_localId, op, args) => {
      try {
        return { ok: true, value: await run(op, args) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof GitTransportError ? error.code : 'git',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    cancel: () => Promise.resolve(null),
    identity: () => Promise.resolve({ name: 'Ryan', email: 'ryan@example.invalid' }),
    agents: () => Promise.resolve(null),
    connectAgent: () => Promise.resolve(null),
    disconnectAgent: () => Promise.resolve(null),
    cli: () => Promise.resolve(null),
    installCli: () => Promise.resolve(null),
    removeCli: () => Promise.resolve(null),
    onChange: () => () => undefined,
  };
}

const info = (overrides: Partial<GitNotebookInfo> = {}): GitNotebookInfo => ({
  localId: '01JBLOCAL0000000000000000A',
  notebookId: NOTEBOOK,
  name: 'Work',
  create: false,
  remote: 'file:///tmp/work.git',
  repository: 'this Mac: /tmp/work.git',
  host: 'this Mac',
  branch: 'main',
  dir: '',
  pushDelayS: 1,
  pullEveryMin: 60,
  sign: true,
  author: null,
  hasToken: false,
  filterIgnored: false,
  ...overrides,
});

const directory = (notes: Notes, workspace: Workspace) =>
  new NoteDirectory({
    notes,
    folderOf: () => null,
    folderName: () => null,
    register: (id, folderId) => workspace.registerNote(id, folderId),
    navigate: () => undefined,
  });

/** A notebook made by another device (the CLI) on a memory remote, and the Mac's windows on it. */
async function world() {
  const nb = testNotebook();
  const cli = await nb.open('CLI', { create: true });
  const first = cli.ops.createNote({ title: 'From the CLI', markdown: 'hello' });
  await cli.engine.sync();
  const shared = memoryNotes();
  const kv = memoryEngineKv();
  const locks = fifoLocks();
  const channel = channels();
  const mac = nb.transport('Mac');
  const git = fakeGit(mac);
  const window = (name: string) => {
    const store = connection(shared);
    const source = new GitSource(info(), {
      git,
      directory,
      canHost: true,
      notices: false,
      locks,
      channel: channel(),
      openStore: () => Promise.resolve(store),
      engineKv: () => Promise.resolve(kv),
      log: (message, error) => console.warn(`[${name}] ${message}`, error),
    });
    stops.push(() => source.stop());
    return source;
  };
  return { nb, cli, first, shared, kv, locks, window, git, mac };
}

/** Wires two windows' store announcements, as the Mac app's main process does. */
function announce(from: GitSource, to: GitSource): void {
  stops.push(from.notes.onStored((ids) => void to.storedElsewhere(ids)));
}

/** An edit a window makes: the note's title (the CLI reads it back). */
function retitle(doc: Parameters<typeof setTitle>[0], text: string) {
  setTitle(doc, text);
}

/** One PNG: its signature is all the sniffing reads. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

describe('attachments in a git notebook on the Mac (T59, A1032)', () => {
  it('commits an image added on the Mac with the note that shows it', async () => {
    const { nb, window } = await world();
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
    const image = await a.notes.attachments.add(new Uint8Array(PNG));
    const id = a.notes.create(new Date(), { title: 'With a picture' });
    a.workspace.registerNote(id, null);
    const open = a.notes.openNote(id);
    await open.ready;
    expect(appendMarkdown(open.replica.doc, `![](${image.path})`)).toBe(true);
    open.close();
    await a.notes.saveAll();
    await vi.waitFor(
      () => {
        a.syncNow();
        expect(nb.files()).toContain(image.path);
      },
      { timeout: 20_000, interval: 300 },
    );
    const head = nb.head()!;
    const pushed = await nb.transport('check').read(head, [image.path]);
    expect(pushed.get(image.path)).toEqual(PNG);
  });

  it('shows an image another writer pushed, read from the clone', async () => {
    const { nb, cli, window } = await world();
    const kept = await cli.ops.keepAttachment(new Uint8Array(PNG), 'png');
    cli.ops.createNote({ title: 'From the CLI, with a picture', markdown: `![](${kept.path})` });
    await cli.engine.sync();
    expect(nb.files()).toContain(kept.path);
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
    expect(await a.notes.attachments.info(kept.path)).toEqual({
      size: PNG.byteLength,
      type: 'image/png',
    });
  });
});

describe('closing a source (#172: the flaky cleanup at A855)', () => {
  it('halts only once its running sync and every git call of it have ended', async () => {
    const { window, git } = await world();
    let running = 0;
    let started = 0;
    const op = git.op.bind(git);
    git.op = async (localId, name, args) => {
      running++;
      started++;
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await op(localId, name, args);
      } finally {
        running--;
      }
    };
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.hostsEngine).toBe(true));
    a.syncNow();
    await vi.waitFor(() => expect(running).toBeGreaterThan(0));
    await a.halt();
    expect(running).toBe(0);
    const after = started;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(started).toBe(after);
  });
});

describe('a store that is not a close (#174 review: Quick capture, a title bar change)', () => {
  it('stores what the window holds, and neither syncs nor stops the sync running', async () => {
    const { window, git } = await world();
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.hostsEngine).toBe(true));
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const names: string[] = [];
    let cancels = 0;
    const op = git.op.bind(git);
    git.op = async (localId, name, args) => {
      names.push(name);
      if (name === 'fetch') await held;
      return op(localId, name, args);
    };
    const cancel = git.cancel.bind(git);
    git.cancel = (localId) => {
      cancels++;
      return cancel(localId);
    };
    a.syncNow();
    await vi.waitFor(() => expect(names).toContain('fetch'));
    const before = names.length;
    // As main asks before the capture window reads the store, or before a title bar change.
    await a.store('flush');
    expect(names.length).toBe(before);
    expect(cancels).toBe(0);
    expect(a.feed.status.closing ?? false).toBe(false);
    release();
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
  });
});

describe('Agent activity in a git notebook on the Mac (#172, A920)', () => {
  it("lists an agent's folder change from the branch, and Undo pushes the person's own change", async () => {
    const { nb, cli, window } = await world();
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.hostsEngine).toBe(true));
    const folder = cli.ops.createFolder({ name: 'Projects', parentId: null });
    await cli.engine.sync();
    nb.tick();
    const agent = await nb.open('Claude Code', { kind: 'agent' });
    await agent.engine.sync();
    agent.ops.renameFolder(folder, 'Agent named it');
    await agent.engine.sync();
    const names = (doc: Parameters<typeof readWorkspace>[0]) =>
      readWorkspace(doc).folders.map((each) => each.name);
    a.syncNow();
    await vi.waitFor(() => expect(names(a.workspace.doc)).toContain('Agent named it'));
    const entries = await a.agentActivity();
    expect(entries.map((entry) => [entry.summary, entry.actor.label])).toEqual([
      ['Renamed the folder “Projects” to “Agent named it”', 'Claude Code'],
    ]);
    expect(await a.undoAgentActivity(entries[0]!.id)).toEqual({
      ok: true,
      alreadyUndone: false,
      notice: null,
    });
    expect(names(a.workspace.doc)).toEqual(['Projects']);
    // The next sync pushes it: the agent's own clone has the name back, and every clone reads
    // the entry as undone, by this Mac.
    await vi.waitFor(async () => {
      a.syncNow();
      await agent.engine.sync();
      expect(names(agent.engine.replica.workspace)).toEqual(['Projects']);
    });
    await cli.engine.sync();
    const fromCli = new AgentActivity(cli.engine.transport, cli.engine.layout);
    expect((await fromCli.list(cli.engine.replica.workspace)).entries).toMatchObject([
      { summary: 'Renamed the folder “Projects” to “Agent named it”', undoneBy: 'Penmoss for Mac' },
    ]);
  });
});

describe('one engine per notebook per device (A822)', () => {
  it('runs in one window; the other hands its edits over, and both see the repository’s', async () => {
    const { cli, first, locks, window, nb } = await world();
    const a = window('A');
    const b = window('B');
    announce(a, b);
    announce(b, a);
    a.start();
    b.start();
    await vi.waitFor(() => expect(a.hostsEngine).toBe(true));
    expect(b.hostsEngine).toBe(false);
    expect(locks.holder('penmoss-git-engine:' + NOTEBOOK)).not.toBeNull();
    // The CLI's note reaches both windows' lists.
    await vi.waitFor(() =>
      expect(b.notes.list().map((entry) => entry.title)).toContain('From the CLI'),
    );
    expect(a.notes.list().map((entry) => entry.title)).toContain('From the CLI');
    // An edit in B (which runs no engine) goes through A's engine to the repository.
    const open = b.notes.openNote(first);
    await open.ready;
    retitle(open.replica.doc, 'typed in window B');
    await open.saveNow();
    a.syncNow();
    await vi.waitFor(async () => {
      await cli.engine.sync();
      expect(readTitle(cli.engine.replica.note(first)!)).toBe('typed in window B');
    });
    // B shows A's engine's status.
    await vi.waitFor(() => expect(b.feed.status.phase).toBe('synced'));
    expect(b.feed.status.here).toBe(false);
    expect(a.feed.status.here).toBe(true);
    open.close();
    void nb;
  });

  it('hands the engine over when its window closes, with nothing lost', async () => {
    const { cli, first, window } = await world();
    const a = window('A');
    const b = window('B');
    announce(a, b);
    announce(b, a);
    a.start();
    b.start();
    await vi.waitFor(() => expect(a.hostsEngine).toBe(true));
    await vi.waitFor(() => expect(b.notes.list().map((entry) => entry.id)).toContain(first));
    // B edits while A is closing: A's engine never hears of it.
    a.stop();
    const open = b.notes.openNote(first);
    await open.ready;
    retitle(open.replica.doc, 'after the handover');
    await open.saveNow();
    open.close();
    // B takes the engine and finds the edit in the store.
    await vi.waitFor(() => expect(b.hostsEngine).toBe(true));
    b.syncNow();
    await vi.waitFor(async () => {
      await cli.engine.sync();
      expect(readTitle(cli.engine.replica.note(first)!)).toBe('after the handover');
    });
  });

  it('a note made in a window, offline, is pushed once the host answers', async () => {
    const { cli, window } = await world();
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.hostsEngine).toBe(true));
    const id = a.notes.create(new Date(), { title: 'Made on the Mac' });
    a.workspace.registerNote(id, null);
    await a.notes.settled(id);
    await a.notes.saveAll();
    await vi.waitFor(async () => {
      a.syncNow();
      await cli.engine.sync();
      expect(cli.engine.replica.note(id) && readTitle(cli.engine.replica.note(id)!)).toBe(
        'Made on the Mac',
      );
    });
  });

  it('Delete for good: the notebook’s purged map, and the files leave the branch (A828)', async () => {
    const { cli, first, window, nb } = await world();
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.notes.list().map((entry) => entry.id)).toContain(first));
    await a.notes.deleteNote(first);
    await a.notes.purgeFromTrash(first);
    expect(a.workspace.isPurged(first)).toBe(true);
    await a.notes.saveAll();
    await vi.waitFor(async () => {
      a.syncNow();
      await cli.engine.sync();
      expect(nb.files().some((path) => path.includes(first))).toBe(false);
    });
  });
});

describe('History’s restore and revert ask the Mac’s owner first, as Android does (A901)', () => {
  it('asks main, naming the note, and changes nothing when the owner says no', async () => {
    const { first, window, git } = await world();
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
    const asked: Array<[string, string, boolean]> = [];
    let answer: GitAnswer<null> = {
      ok: false,
      error: { code: 'not_confirmed', message: 'Not done: you cancelled.' },
    };
    git.restoreCheck = (localId, note, revert) => {
      asked.push([localId, note, revert]);
      return Promise.resolve(answer);
    };
    const history = gitHistory(a, a.notes, first);
    await expect(history.restore(1)).rejects.toMatchObject({
      status: 403,
      message: 'Not done: you cancelled.',
    });
    await expect(history.revert(1)).rejects.toMatchObject({ status: 403 });
    expect(asked).toEqual([
      [a.info.localId, first, false],
      [a.info.localId, first, true],
    ]);
    answer = { ok: true, value: null };
    await expect(history.restore(1)).resolves.toMatchObject({ changed: false });
  });
});

describe('History’s Sync Now pushes the note as this window stored it (T59)', () => {
  it('takes in what a window without the engine stored before it commits', async () => {
    const { nb, window } = await world();
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
    // B waits in line for the engine; its store is not announced to A, so A has not taken in
    // what B stored when Sync Now is pressed.
    const b = window('B');
    b.start();
    await vi.waitFor(() => expect(b.feed.status.phase).toBe('synced'));
    const id = b.notes.create(new Date(), { title: 'History probe' });
    b.workspace.registerNote(id, null);
    const open = b.notes.openNote(id);
    await open.ready;
    expect(appendMarkdown(open.replica.doc, 'First words')).toBe(true);
    await open.saveNow();
    await gitHistory(b, b.notes, id).save();
    const rendered = [...nb.rendered().values()].join('\n');
    expect(rendered).toContain('History probe');
    expect(rendered).toContain('First words');
  });
});

describe('History saves the note as it is before a Restore or a Revert (as the server does)', () => {
  it('an edit not pushed yet becomes a version first; with no way to push it, nothing changes', async () => {
    const { cli, first, window, mac } = await world();
    const a = window('A');
    a.start();
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
    const open = a.notes.openNote(first);
    await open.ready;
    retitle(open.replica.doc, 'Typed, not pushed yet');
    await open.saveNow();
    // The push fails: the edit is still only here, so the restore is refused and loses nothing.
    mac.beforePush = () => {
      throw new GitTransportError('network', 'The network dropped');
    };
    const history = gitHistory(a, a.notes, first);
    await expect(history.restore(1)).rejects.toMatchObject({ status: 409 });
    expect(readTitle(open.replica.doc)).toBe('Typed, not pushed yet');
    // Online again: the edit is pushed as a version, then the restore comes after it.
    mac.beforePush = null;
    expect((await history.restore(1)).changed).toBe(true);
    await vi.waitFor(() => expect(readTitle(open.replica.doc)).toBe('From the CLI'));
    const listed = await history.list();
    const saved = await history.detail(listed.versions[0]!.id);
    expect(saved?.markdown).toContain('Typed, not pushed yet');
    open.close();
    void cli;
  });
});

describe('what a sync pulled reaches the windows, whatever its push did', () => {
  for (const change of ['rename', 'purge'] as const) {
    it(`${change}: the CLI's change shows although the Mac's push after it failed`, async () => {
      const { cli, first, window, mac } = await world();
      const second = cli.ops.createNote({ title: 'Second', markdown: 'two' });
      await cli.engine.sync();
      const a = window('A');
      a.start();
      await vi.waitFor(() =>
        expect(a.notes.list().map((entry) => entry.id)).toEqual(
          expect.arrayContaining([first, second]),
        ),
      );
      await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
      // The CLI renames (or deletes for good) a note and pushes.
      if (change === 'rename') setTitle(cli.engine.replica.note(first)!, 'Renamed by the CLI');
      else cli.ops.purge(first);
      await cli.engine.sync();
      // The Mac has an edit not pushed yet, and its next push fails: the fetch before it took the
      // CLI's change in.
      let pushes = 0;
      mac.beforePush = () => {
        if (pushes++ === 0) throw new GitTransportError('network', 'The network dropped');
      };
      const open = a.notes.openNote(second);
      await open.ready;
      retitle(open.replica.doc, 'Edited on the Mac');
      await open.saveNow();
      open.close();
      a.syncNow();
      await vi.waitFor(() => expect(a.feed.status.phase).toBe('offline'));
      const shows = () =>
        change === 'rename'
          ? expect(a.notes.list().find((entry) => entry.id === first)?.title).toBe(
              'Renamed by the CLI',
            )
          : expect(a.notes.list().map((entry) => entry.id)).not.toContain(first);
      await vi.waitFor(shows);
      // The next sync lands, and nothing is undone.
      a.syncNow();
      await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
      shows();
      await cli.engine.sync();
      expect(readTitle(cli.engine.replica.note(second)!)).toBe('Edited on the Mac');
    });
  }
});

describe('Remove counts what is not pushed from any window (A856)', () => {
  it('a window that runs no engine asks the engine’s window, once its edit is taken in', async () => {
    const { first, window } = await world();
    const a = window('A');
    const b = window('B');
    // The main process passes announcements on a moment later, as IPC does.
    stops.push(b.notes.onStored((ids) => void setTimeout(() => void a.storedElsewhere(ids), 300)));
    announce(a, b);
    a.start();
    b.start();
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
    await vi.waitFor(() => expect(b.notes.list().map((entry) => entry.id)).toContain(first));
    expect(b.hostsEngine).toBe(false);
    const open = b.notes.openNote(first);
    await open.ready;
    retitle(open.replica.doc, 'Typed in B, not pushed');
    await open.saveNow();
    open.close();
    // At once, before A's engine has heard of it by itself.
    await expect(b.unpushed()).resolves.toEqual({ notes: 1, folders: false });
  });
});

describe('what a sync pulled outlives the window that ran it', () => {
  it('the CLI renames a note, the Mac’s push hangs, its window goes: the next engine shows it', async () => {
    const { cli, first, window, mac } = await world();
    const second = cli.ops.createNote({ title: 'Second', markdown: 'two' });
    await cli.engine.sync();
    const a = window('A');
    const b = window('B');
    announce(a, b);
    announce(b, a);
    a.start();
    b.start();
    await vi.waitFor(() => expect(a.hostsEngine).toBe(true));
    await vi.waitFor(() => expect(a.feed.status.phase).toBe('synced'));
    await vi.waitFor(() =>
      expect(b.notes.list().map((entry) => entry.id)).toEqual(
        expect.arrayContaining([first, second]),
      ),
    );
    setTitle(cli.engine.replica.note(first)!, 'Renamed by the CLI');
    await cli.engine.sync();
    // The Mac's next push hangs; the fetch before it has taken the rename in and been saved.
    let hung = false;
    let release: () => void = () => undefined;
    mac.beforePush = () => {
      if (hung) return;
      hung = true;
      return new Promise<void>((resolve) => (release = resolve));
    };
    const open = a.notes.openNote(second);
    await open.ready;
    retitle(open.replica.doc, 'Edited on the Mac');
    await open.saveNow();
    open.close();
    a.syncNow();
    await vi.waitFor(() => expect(hung).toBe(true));
    // Window A goes before its sync ends: B takes the engine over.
    a.stop();
    await vi.waitFor(() => expect(b.hostsEngine).toBe(true));
    await vi.waitFor(() =>
      expect(b.notes.list().find((entry) => entry.id === first)?.title).toBe('Renamed by the CLI'),
    );
    release();
  });
});

describe('history of a git note (A858)', () => {
  it('lists the notebook’s commits, and restores and reverts as a change of this Mac', async () => {
    const { cli, first, window } = await world();
    setTitle(cli.engine.replica.note(first)!, 'Second title');
    await cli.engine.sync();
    const a = window('A');
    a.start();
    await vi.waitFor(() =>
      expect(a.notes.list().map((entry) => entry.title)).toContain('Second title'),
    );
    const history = gitHistory(a, a.notes, first);
    const listed = await history.list();
    expect(listed.versions.map((version) => version.id)).toEqual([2, 1]);
    expect(listed.versions[0]!.authors.map((author) => author.label)).toEqual(['CLI']);
    const detail = await history.detail(2);
    expect(detail?.previousId).toBe(1);
    expect(detail?.diff.some((op) => op.op === 'add' && op.line.includes('Second title'))).toBe(
      true,
    );
    // Restore: version 1's content, as a new change that reaches the repository.
    expect((await history.restore(1)).changed).toBe(true);
    await vi.waitFor(async () => {
      a.syncNow();
      await cli.engine.sync();
      expect(readTitle(cli.engine.replica.note(first)!)).toBe('From the CLI');
    });
    // Revert the restore's commit: the title it changed comes back, nothing else moves.
    const after = await history.list();
    expect(after.versions).toHaveLength(3);
    expect((await history.revert(3)).changed).toBe(true);
    await vi.waitFor(async () => {
      a.syncNow();
      await cli.engine.sync();
      expect(readTitle(cli.engine.replica.note(first)!)).toBe('Second title');
    });
    // An id no commit has is refused.
    await expect(history.restore(99)).rejects.toThrow('No such version');
  });
});

describe('sources side by side, git notebooks only (A820, A826, A827, T59)', () => {
  function fakeSource(id: string, ids: string[]): GitSource & { stored: ReturnType<typeof vi.fn> } {
    const stored = vi.fn(() => Promise.resolve());
    return {
      stored,
      kind: 'git',
      id,
      name: id,
      notes: {
        knows: (noteId: string) => ids.includes(noteId),
        list: () => [],
        onStored: () => () => undefined,
      },
      start: () => undefined,
      stop: () => undefined,
      setInfo: () => undefined,
      storedElsewhere: stored,
    } as unknown as GitSource & { stored: ReturnType<typeof vi.fn> };
  }

  function sources(options: { listed: () => string[]; storage?: Storage }) {
    const made = new Map<string, ReturnType<typeof fakeSource>>();
    let changed: (() => void) | null = null;
    const registry = new Sources({
      git: {
        list: () =>
          Promise.resolve(
            options.listed().map((id) => info({ notebookId: id, localId: `${id}L` })),
          ),
        onChange: (listener: () => void) => {
          changed = listener;
          return () => undefined;
        },
      } as unknown as DesktopGit,
      storage: options.storage ?? memoryStorage({}),
      makeGit: (each) => {
        const source = fakeSource(each.notebookId, [`${each.notebookId}-note`]);
        made.set(each.notebookId, source);
        return source;
      },
    });
    return { registry, made, changed: () => changed?.() };
  }

  it('resolves a note to the source that holds it; no id resolves in another', async () => {
    const { registry } = sources({ listed: () => ['NB1', 'NB2'] });
    await registry.load();
    expect(registry.sourceOfNote('NB1-note')?.id).toBe('NB1');
    expect(registry.sourceOfNote('NB2-note')?.id).toBe('NB2');
    expect(registry.getState().all.map((source) => source.id)).toEqual(['NB1', 'NB2']);
  });

  it('has no personal source: the Journal notebook is the root, and holds unknown ids', async () => {
    const { registry } = sources({ listed: () => ['NB1'] });
    await registry.load();
    const state = registry.getState();
    expect(Object.keys(state).sort()).toEqual([
      'all',
      'journal',
      'journalPicked',
      'loaded',
      'root',
    ]);
    expect(state.all.map((source) => source.id)).toEqual(['NB1']);
    expect(state.journal?.id).toBe('NB1');
    expect(state.root?.id).toBe('NB1');
    expect(isOpen(state)).toBe(true);
    // An unknown id opens in the Journal notebook: there is no other store to look in.
    expect(registry.sourceOfNote('nowhere')?.id).toBe('NB1');
  });

  it('with no notebook yet: loaded, no root or Journal, so the first run shows', async () => {
    let listed: string[] = [];
    const { registry, changed } = sources({ listed: () => listed });
    expect(registry.getState().loaded).toBe(false);
    await registry.load();
    const empty = registry.getState();
    expect(empty).toMatchObject({ all: [], journal: null, root: null, loaded: true });
    expect(isOpen(empty)).toBe(false);
    expect(registry.sourceOfNote('anything')).toBeNull();
    // The first one added opens the app.
    listed = ['NB1'];
    changed();
    await vi.waitFor(() => expect(isOpen(registry.getState())).toBe(true));
    expect(registry.getState().root?.id).toBe('NB1');
  });

  it('without the Mac app’s git, has nothing to load and no notebook', () => {
    const registry = new Sources({ git: null });
    expect(registry.getState()).toMatchObject({ all: [], journal: null, root: null, loaded: true });
  });

  it('keeps the Journal notebook this device chose, and falls back when it goes (A827)', async () => {
    const storage = memoryStorage({}) as unknown as Storage;
    let listed = ['NB1', 'NB2'];
    const { registry } = sources({ listed: () => listed, storage });
    await registry.load();
    expect(registry.getState()).toMatchObject({ journalPicked: false });
    expect(registry.getState().journal?.id).toBe('NB1');
    registry.setJournal('NB2');
    expect(storage.getItem(JOURNAL_KEY)).toBe('NB2');
    expect(registry.getState().journal?.id).toBe('NB2');
    expect(registry.getState().root?.id).toBe('NB2');
    expect(registry.getState().journalPicked).toBe(true);
    listed = ['NB1'];
    await registry.refresh();
    expect(registry.getState().journal?.id).toBe('NB1');
  });

  it('routes the windows’ announcements to each source, and drops ids of no notebook', async () => {
    expect(routeChanged(['A1', `${NOTEBOOK}/B1`, `${NOTEBOOK}/workspace`, 'workspace'])).toEqual(
      new Map([[NOTEBOOK, ['B1', 'workspace']]]),
    );
    expect(routeChanged(null)).toBeNull();
    const { registry, made } = sources({ listed: () => ['NB1', 'NB2'] });
    await registry.load();
    await registry.storedElsewhere(['A1', 'NB1/x']);
    expect(made.get('NB1')?.stored).toHaveBeenCalledWith(['x']);
    expect(made.get('NB2')?.stored).not.toHaveBeenCalled();
    await registry.storedElsewhere(null);
    expect(made.get('NB2')?.stored).toHaveBeenCalledWith(null);
  });
});

describe('what Status says when a sync fails (A824, A859)', () => {
  it('auth: “Can’t sign in to <host>”, with the token way out; a refused push: the host’s words', () => {
    expect(
      describeFailure(new GitTransportError('auth', 'Authentication failed'), 'github.com').status,
    ).toMatchObject({
      phase: 'stopped',
      code: 'auth',
      detail: expect.stringContaining("Can't sign in to github.com") as string,
    });
    expect(
      describeFailure(
        new GitTransportError('protected', 'refused', 'GH006: Protected branch update failed'),
        'github.com',
      ).status,
    ).toMatchObject({
      phase: 'stopped',
      detail: expect.stringContaining('GH006: Protected branch update failed') as string,
      hostMessage: 'GH006: Protected branch update failed',
    });
    expect(
      describeFailure(new GitTransportError('network', 'x'), 'github.com').status,
    ).toMatchObject({
      phase: 'offline',
      detail: expect.stringContaining("Can't reach github.com") as string,
    });
    expect(
      describeFailure(
        new GitRefused('remote_credentials', 'The remote has a user name or password in it.'),
        'github.com',
      ).status,
    ).toMatchObject({
      phase: 'stopped',
      code: 'remote_credentials',
      detail: expect.stringContaining('user name or password') as string,
    });
  });
});

describe('Delete for good confirmed again from Settings (A855)', () => {
  const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, args: readonly string[]) => {
    const result = spawnSync('git', args, {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };

  /** The Mac's main process itself, and one window's source on a notebook it added. */
  async function macWorld() {
    const dir = mkdtempSync(join(tmpdir(), 'penmoss-web-purge-'));
    stops.push(() => rmSync(dir, { recursive: true, force: true }));
    const remote = join(dir, 'notes.git');
    git(dir, ['init', '--bare', '--quiet', '-b', 'main', remote]);
    const clock = { now: Date.now() };
    const asked: string[] = [];
    // The Mac app's main process itself, as the page's bridge reaches it.
    const main = new GitNotebooks({
      dir: join(dir, 'userData'),
      seal: (plain) => Promise.resolve(`sealed:${plain}`),
      unseal: (sealed) => Promise.resolve(sealed.startsWith('sealed:') ? sealed.slice(7) : null),
      ownerCheck: (words) => {
        asked.push(words);
        return Promise.resolve({ ok: true });
      },
      platform: 'linux',
      gitEnv: GIT_ENV,
      now: () => clock.now,
    });
    const added = await main.add({
      remote: `file://${remote}`,
      branch: 'main',
      dir: '',
      name: 'Home',
    });
    if (!added.ok || added.value.kind !== 'added') throw new Error('not added');
    // Nobody is asked at add (D51): the owner checks below are the first.
    const base = asked.length;
    const bridge: DesktopGit = {
      list: () => main.list(),
      add: () => Promise.resolve(null),
      remove: () => Promise.resolve(null),
      update: () => Promise.resolve(null),
      setToken: () => Promise.resolve(null),
      purgeCheck: (localId, ids) => main.purgeCheck(localId, ids),
      restoreCheck: (localId, note, revert) => main.restoreCheck(localId, note, revert),
      purgesToConfirm: (localId, also) => main.purgesToConfirm(localId, also ?? []),
      writerSecret: (localId, value) => main.writerSecret(localId, value),
      op: (localId, op, args) => main.op(localId, op, args),
      cancel: (localId) => Promise.resolve(main.cancel(localId)),
      identity: () => Promise.resolve({ name: 'Ryan', email: 'ryan@example.invalid' }),
      agents: () => Promise.resolve(null),
      connectAgent: () => Promise.resolve(null),
      disconnectAgent: () => Promise.resolve(null),
      cli: () => Promise.resolve(null),
      installCli: () => Promise.resolve(null),
      removeCli: () => Promise.resolve(null),
      onChange: () => () => undefined,
    };
    const store = connection(memoryNotes());
    const kv = memoryEngineKv();
    const source = new GitSource(added.value.notebook, {
      git: bridge,
      directory,
      canHost: true,
      notices: false,
      locks: fifoLocks(),
      channel: channels()(),
      openStore: () => Promise.resolve(store),
      engineKv: () => Promise.resolve(kv),
      log: (message, error) => console.warn(message, error),
    });
    // Its engine's sync and git calls end before the folder is removed (#172's ENOTEMPTY).
    stops.push(() => source.halt());
    source.start();
    await vi.waitFor(() => expect(source.hostsEngine).toBe(true), { timeout: 20_000 });
    const onBranch = () => git(remote, ['ls-tree', '-r', '--name-only', 'main']);
    const make = async (title: string) => {
      const id = source.notes.create(new Date(), { title });
      source.workspace.registerNote(id, null);
      await source.notes.settled(id);
      return id;
    };
    return { source, asked, base, remote, clock, onBranch, make };
  }

  it('names the notes from the branch, confirms only those confirmed once, and refuses a note never confirmed', async () => {
    const { source, asked, base, clock, onBranch, make, remote } = await macWorld();
    const old = await make('Old plan');
    const keep = await make('Keep me');
    await source.notes.saveAll();
    await vi.waitFor(
      () => {
        source.syncNow();
        expect(onBranch()).toContain(`.penmoss/notes/${keep}/`);
        expect(onBranch()).toContain(`.penmoss/notes/${old}/`);
      },
      { timeout: 30_000, interval: 500 },
    );
    // Ryan deletes one note for good (Touch ID), then the sync waits past the 10 minutes.
    await source.notes.deleteNote(old);
    await source.notes.purgeFromTrash(old);
    expect(asked).toHaveLength(base + 1);
    expect(asked.at(-1)).toMatch(
      /^delete 1 note for good \(git history keeps it\) in the git notebook at .*: \[\u2068Old plan\u2069\]$/u,
    );
    // A script in the page marks another note deleted for good, with no confirmation.
    source.workspace.markPurged(keep);
    await source.notes.saveAll();
    clock.now += 11 * 60_000;
    await vi.waitFor(
      () => {
        source.syncNow();
        expect(source.feed.status.code).toBe('purge_unconfirmed');
      },
      { timeout: 30_000, interval: 500 },
    );
    // Settings lists both, named by main from the branch: one confirmed before, one never.
    const listed = await source.purgesToConfirm();
    expect([...(listed ?? [])].sort((a, b) => a.title.localeCompare(b.title))).toEqual([
      { id: keep, title: 'Keep me', confirmedBefore: false },
      { id: old, title: 'Old plan', confirmedBefore: true },
    ]);
    // Sent with the note never confirmed, the lot is refused, and nobody is asked.
    expect(await source.reconfirmPurges([old, keep])).toContain('never confirmed');
    expect(await source.reconfirmPurges([keep])).toContain('never confirmed');
    expect(asked).toHaveLength(base + 1);
    // The button sends what was confirmed before: one Touch ID, with the count and "once already".
    const again = listed!.filter((note) => note.confirmedBefore).map((note) => note.id);
    expect(await source.reconfirmPurges(again)).toBeNull();
    expect(asked.slice(base + 1)).toEqual([
      fitWords(
        'delete 1 note for good, confirmed once already on this Mac (git history keeps it), in the git notebook at ',
        `${remote} on this Mac`,
        '',
      ),
    ]);
    // The note never confirmed still stops the sync: it stays on the branch.
    source.syncNow();
    await vi.waitFor(() => expect(source.feed.status.code).toBe('purge_unconfirmed'), {
      timeout: 30_000,
    });
    expect(onBranch()).toContain(`.penmoss/notes/${keep}/`);
    expect(onBranch()).toContain(`.penmoss/notes/${old}/`);
  }, 90_000);

  /** Two notes on the branch, then a page script marks one deleted for good: the sync stops. */
  async function marked() {
    const world = await macWorld();
    const { source, onBranch, make, remote } = world;
    const keep = await make('Keep me');
    const other = await make('Other');
    await source.notes.saveAll();
    await vi.waitFor(
      () => {
        source.syncNow();
        expect(onBranch()).toContain('Keep me.md');
        expect(onBranch()).toContain('Other.md');
      },
      { timeout: 30_000, interval: 500 },
    );
    const logs = () => git(remote, ['ls-tree', '-r', 'main', `.penmoss/notes/${keep}/`]);
    const before = logs();
    source.workspace.markPurged(keep);
    await source.notes.saveAll();
    await vi.waitFor(
      () => {
        source.syncNow();
        expect(source.feed.status.code).toBe('purge_unconfirmed');
      },
      { timeout: 30_000, interval: 500 },
    );
    expect(await source.purgesToConfirm()).toEqual([
      { id: keep, title: 'Keep me', confirmedBefore: false },
    ]);
    return { ...world, keep, other, logs, before };
  }

  it('Keep note takes back a purge never confirmed: undoable, no Touch ID, and the sync goes on', async () => {
    const { source, asked, base, keep, logs, before, onBranch } = await marked();
    expect(await source.keepNote(keep)).toBeNull();
    expect(source.workspace.isPurged(keep)).toBe(false);
    // Undo marks it again, as it was.
    await source.undoKeep(keep);
    expect(source.workspace.isPurged(keep)).toBe(true);
    expect(await source.keepNote(keep)).toBeNull();
    await vi.waitFor(
      () => {
        expect(source.feed.status).toMatchObject({ phase: 'synced', code: null });
      },
      { timeout: 30_000, interval: 200 },
    );
    // Nothing was deleted and nobody was asked: its logs and file are on the branch as they were,
    // and the note is back in the window, from the branch.
    expect(asked).toHaveLength(base);
    expect(logs()).toBe(before);
    expect(onBranch()).toContain('Keep me.md');
    await vi.waitFor(() => expect(source.notes.list().map((entry) => entry.id)).toContain(keep), {
      timeout: 30_000,
    });
    expect(await source.purgesToConfirm()).toEqual([]);
  }, 90_000);

  it('Delete for good on a note never confirmed asks Touch ID naming it as the branch has it', async () => {
    const { source, asked, base, keep, onBranch } = await marked();
    expect(await source.confirmPurge(keep)).toBeNull();
    expect(asked.slice(base)).toEqual([
      expect.stringMatching(
        /^delete 1 note for good \(git history keeps it\) in the git notebook at .*: \[\u2068Keep me\u2069\]$/u,
      ),
    ]);
    await vi.waitFor(
      () => {
        source.syncNow();
        expect(onBranch()).not.toContain('Keep me.md');
      },
      { timeout: 30_000, interval: 500 },
    );
    expect(onBranch()).toContain('Other.md');
    // Landed: Keep note (a list gone stale) does nothing and says why.
    expect(await source.keepNote(keep)).toContain('already deleted for good');
    expect(source.workspace.isPurged(keep)).toBe(true);
  }, 90_000);
});
