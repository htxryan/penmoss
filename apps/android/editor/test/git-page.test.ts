/**
 * The git engine page (T50 G7, A872–A876) through its frames, as the app drives it: a fake app
 * serves git from an in-memory remote, the writer's secret and the owner checks, and calls the
 * page's notes server as Room's sync does. A second engine (the Mac's and the CLI's code, here
 * straight over the same remote) syncs beside it.
 */
import {
  GitNotebookEngine,
  MemoryRemote,
  MemorySecrets,
  MemoryStorage,
  MemoryTransport,
  GitTransportError,
  NotebookOps,
  type GitTransport,
} from '@penmoss/git-notebook';
import { readTitle, initNote, setTitle } from '@penmoss/sync-client/note';
import { readSettings, readWorkspace, setSetting } from '@penmoss/sync-client/workspace';
import { recordAgentSession, sessionKey } from '@penmoss/sync-client/agent-sessions';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryEngineKv } from '../../../web/src/sources/engine-store';
import { Channel, ChannelError, type FramePort } from '../src/git/channel';
import { decodeFrame, encodeFrame, FrameError } from '../src/git/frames';
import { serveEngine, serveGuard } from '../src/git/page';
import { commitPurges } from '@penmoss/git-notebook/purge-check';
import { setBody } from '@penmoss/sync-client/history';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { parseMarkdown } from '@penmoss/core';
import { docToDelta } from '@y/prosemirror';
import { AndroidGitHost, describe as describeFailure, type GitSyncStatus } from '../src/git/host';
import { captureNoteId } from '../src/git/server';
import contract from '../../contract/git-engine-v1.json';

// The engine's real git work (hashing, packing, two engines over one remote) takes about 0.2 s a
// test alone and several seconds when the gate's other suites share the CPUs, past vitest's 5 s
// default: the file gets the 60 s that the engine's own suite (packages/git-notebook) has (A1378).
vi.setConfig({ testTimeout: 60_000 });

const NOTEBOOK = '01JBNOTEBOOK00000000000001';
const NOTE = '01JBNOTE000000000000000001';
const FOLDER = '01JBF0000000000000000000B1';

/** Two ports joined back to back, delivering on a later turn as the WebView does. */
function pipe(): [FramePort, FramePort] {
  const listeners: Array<((frame: Uint8Array) => void) | null> = [null, null];
  const port = (me: 0 | 1): FramePort => ({
    send: (frame) => {
      const copy = frame.slice();
      setTimeout(() => listeners[me === 0 ? 1 : 0]?.(copy), 0);
    },
    listen: (listener) => {
      listeners[me] = listener;
    },
  });
  return [port(0), port(1)];
}

/** The app's side: git over a MemoryTransport, the secret, the owner checks. */
function fakeApp(options: {
  remote: MemoryRemote;
  confirm?: (noteId: string) => boolean;
  transport?: (base: MemoryTransport) => GitTransport;
  /**
   * The app's commit check for copies (A886), as Android's main runs it: a copy whose original is
   * deleted for good at head is refused (`purge_raced`) unless the person confirmed it (`keeps`).
   */
  guard?: boolean;
}) {
  const [appPort, pagePort] = pipe();
  const base = new MemoryTransport({
    remote: options.remote,
    branch: 'main',
    root: '',
    author: { name: 'Ryan on the Pixel', email: 'ryan@example.invalid' },
    clock: () => Date.UTC(2026, 9, 29, 15),
  });
  const git = options.transport ? options.transport(base) : base;
  let secret: string | null = null;
  const purges: string[] = [];
  const restores: Array<[string, number]> = [];
  const cancels = { count: 0 };
  const statuses: GitSyncStatus[] = [];
  const changed = { count: 0 };
  /** What the page handed Room to keep aside (A886): each copy withheld from the push. */
  const withheld: Array<{
    noteId: string;
    origin: string;
    title: string;
    folderId: string | null;
    update: Uint8Array;
  }> = [];
  /** Copies the person confirmed keeping and syncing (the owner check), until they land. */
  const keeps = new Set<string>();
  const wrap = async <T>(run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GitTransportError)
        throw new ChannelError(error.code, error.message, error.hostMessage);
      throw error;
    }
  };
  const app = new Channel(appPort, {
    'git.fetch': () => wrap(() => git.fetch()),
    'git.list': (args) => wrap(async () => [...(await git.list((args as string[])[0]!))]),
    'git.sizes': (args) =>
      wrap(async () => [
        ...(await git.sizes!((args as [string, string[]])[0], (args as [string, string[]])[1])),
      ]),
    'git.changed': (args) =>
      wrap(() => git.changed((args as string[])[0]!, (args as string[])[1]!)),
    'git.read': (args) =>
      wrap(async () => [
        ...(await git.read((args as [string, string[]])[0], (args as [string, string[]])[1])),
      ]),
    'git.commit': (args) => {
      const [head, changes, message] = args as [
        string | null,
        Array<[string, Uint8Array | null]>,
        string,
      ];
      return wrap(async () => {
        if (options.guard) {
          const purges = await commitPurges(base, '', head, new Map(changes));
          if (purges.raced.some((id) => !keeps.has(id))) {
            throw new ChannelError('purge_raced', 'A copy of a note deleted for good');
          }
        }
        return git.commit(head, new Map(changes), message);
      });
    },
    'git.push': (args) => wrap(() => git.push((args as string[])[0]!)),
    'git.log': (args) => wrap(() => git.log((args as [{ paths?: string[]; limit?: number }])[0])),
    'git.readAt': (args) => wrap(() => git.readAt((args as string[])[0]!, (args as string[])[1]!)),
    'git.maintain': () => null,
    'git.cancel': () => {
      cancels.count++;
      return null;
    },
    'secret.get': () => secret,
    'secret.set': (value) => {
      secret = String(value);
      return null;
    },
    'owner.purge': (args) => {
      const noteId = String((args as { noteId: string }).noteId);
      if (options.confirm && !options.confirm(noteId))
        throw new ChannelError('not_confirmed', 'Not confirmed');
      purges.push(noteId);
      return null;
    },
    'copy.withhold': (args) => {
      for (const copy of (args as { copies: typeof withheld }).copies) withheld.push(copy);
      return null;
    },
    'owner.restore': (args) => {
      const input = args as { noteId: string; version: number };
      restores.push([input.noteId, input.version]);
      return null;
    },
  });
  app.on('status', (status) => statuses.push(status as GitSyncStatus));
  app.on('changed', () => changed.count++);
  const kv = memoryEngineKv();
  serveEngine(pagePort, { open: () => Promise.resolve(kv), forget: () => Promise.resolve() });
  const http = async (method: string, path: string, body?: unknown) => {
    const reply = (await app.call('http', {
      method,
      path,
      headers: {},
      body: body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)),
    })) as { status: number; body: Uint8Array };
    const text = new TextDecoder().decode(reply.body);
    return {
      status: reply.status,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
  };
  return { app, http, purges, restores, cancels, statuses, changed, base, kv, withheld, keeps };
}

/** A note as the phone's editor makes one: its own doc, its own client id. */
function editorNote(title: string, clientID = 4242) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  initNote(doc, { id: NOTE, created: '2026-10-29T10:00:00-05:00', kind: 'note' }, title);
  return doc;
}

async function settle(app: Channel) {
  return (await app.call('sync', { reason: 'now' })) as GitSyncStatus;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('frames (A873)', () => {
  it('carry bytes as bytes, and read the contract examples Kotlin reads too', () => {
    const bytes = new Uint8Array([0, 1, 2, 250]);
    const frame = encodeFrame({ k: 'call', id: 7, op: 'git.read', a: ['abc', [['a.yjs', bytes]]] });
    const back = decodeFrame(frame);
    expect(back).toEqual({ k: 'call', id: 7, op: 'git.read', a: ['abc', [['a.yjs', bytes]]] });
    const fromHex = (hex: string) =>
      Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    for (const example of contract.frames) {
      const decoded = decodeFrame(fromHex(example.hex));
      expect(
        JSON.parse(
          JSON.stringify(decoded, (_, value: unknown) =>
            value instanceof Uint8Array ? { bytes: Array.from(value) } : value,
          ),
        ),
      ).toEqual(example.message);
      expect(toHex(encodeFrame(decoded))).toBe(example.hex);
    }
    expect(() => decodeFrame(new Uint8Array([0, 0, 0, 9, 1]))).toThrow(FrameError);
    expect(() => decodeFrame(encodeFrame({ k: 'x', a: new Uint8Array([1]) }).slice(0, -1))).toThrow(
      FrameError,
    );
  });
});

describe('the notes server (A874)', () => {
  it('makes a notebook, takes a note the phone made, files it, pushes it, and the Mac reads it', async () => {
    const remote = new MemoryRemote();
    const phone = fakeApp({ remote });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: true,
      host: 'github.com',
      label: 'Penmoss for Android (Pixel)',
      front: true,
    });
    const first = await settle(phone.app);
    expect(first.phase).toBe('synced');
    const tree = await phone.http('GET', '/sync/tree');
    expect(tree.status).toBe(200);
    expect(tree.json?.['folders']).toEqual([]);
    const made = await phone.http('POST', '/api/folders', {
      id: FOLDER,
      name: 'Plans',
      parentId: null,
    });
    expect(made.status).toBe(201);
    const doc = editorNote('Plan');
    const batch = await phone.http('POST', '/sync/batch', {
      notes: [
        { id: NOTE, update: [toBase64(Y.encodeStateAsUpdate(doc))], folderId: FOLDER, text: true },
      ],
    });
    const reply = (batch.json?.['notes'] as Array<Record<string, unknown>>)[0]!;
    expect(reply['applied']).toBe(1);
    expect(reply['error']).toBeNull();
    expect(reply['filed']).toEqual({ folderId: FOLDER });
    expect(typeof reply['epoch']).toBe('string');
    expect(reply['textHash']).toMatch(/^[0-9a-f]{64}$/);
    const synced = await settle(phone.app);
    expect(synced.phase).toBe('synced');
    expect(synced.pending).toEqual([]);
    // The Mac (the same engine over system git there; the remote itself here) has it, filed.
    const mac = await GitNotebookEngine.open({
      transport: new MemoryTransport({
        remote,
        branch: 'main',
        root: '',
        author: { name: 'Mac', email: 'mac@example.invalid' },
      }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Penmoss for Mac' },
    });
    await mac.sync();
    expect(readTitle(mac.replica.note(NOTE)!)).toBe('Plan');
    expect(
      readWorkspace(mac.replica.workspace).notes.find((note) => note.id === NOTE)?.folderId,
    ).toBe(FOLDER);
    // Every commit carries the writer's trailer and is a fast-forward on the head (A822, A825).
    for (const commit of remote.history('main')) {
      expect(commit.parents.length).toBeLessThanOrEqual(1);
      expect(commit.message).toMatch(
        /Penmoss-Writer: [0-9A-Z]{26} \(device "Penmoss for Android \(Pixel\)"\)/,
      );
    }

    // The Mac renames it; the phone's next pass sees the change and fetches only what it lacks.
    setTitle(mac.replica.note(NOTE)!, 'Plan B');
    await mac.sync();
    const before = phone.changed.count;
    await settle(phone.app);
    expect(phone.changed.count).toBeGreaterThan(before);
    const changes = await phone.http('GET', '/sync/changes?since=0');
    const row = (changes.json?.['notes'] as Array<Record<string, unknown>>).find(
      (each) => each['id'] === NOTE,
    )!;
    expect(row['title']).toBe('Plan B');
    const cursor = reply['stateVector'] as string;
    const again = await phone.http('POST', '/sync/batch', {
      notes: [{ id: NOTE, stateVector: cursor, epoch: reply['epoch'] }],
    });
    const delta = (again.json?.['notes'] as Array<Record<string, unknown>>)[0]!;
    Y.applyUpdate(doc, fromBase64(delta['update'] as string));
    expect(readTitle(doc)).toBe('Plan B');
  });

  it('a copy made on another store (its epoch) is replaced, never merged (A5)', async () => {
    const remote = new MemoryRemote();
    const phone = fakeApp({ remote });
    await phone.app.call('open', { notebookId: NOTEBOOK, name: 'Work', create: true });
    await settle(phone.app);
    const doc = editorNote('Kept');
    await phone.http('POST', '/sync/batch', {
      notes: [{ id: NOTE, update: [toBase64(Y.encodeStateAsUpdate(doc))] }],
    });
    const stale = await phone.http('POST', '/sync/batch', {
      notes: [
        {
          id: NOTE,
          epoch: 'git-000000000000000000000000',
          update: [toBase64(Y.encodeStateAsUpdate(editorNote('Lost', 99)))],
        },
      ],
    });
    const reply = (stale.json?.['notes'] as Array<Record<string, unknown>>)[0]!;
    expect(reply['error']).toBe('Epoch mismatch');
    const whole = new Y.Doc();
    Y.applyUpdate(whole, fromBase64(reply['update'] as string));
    expect(readTitle(whole)).toBe('Kept');
  });

  it('Delete for good asks the owner first; refused, nothing is marked; confirmed, it is gone', async () => {
    const remote = new MemoryRemote();
    let allow = false;
    const phone = fakeApp({ remote, confirm: () => allow });
    await phone.app.call('open', { notebookId: NOTEBOOK, name: 'Work', create: true });
    await settle(phone.app);
    await phone.http('POST', '/sync/batch', {
      notes: [
        {
          id: NOTE,
          update: [toBase64(Y.encodeStateAsUpdate(editorNote('Secret')))],
          folderId: null,
        },
      ],
    });
    await settle(phone.app);
    const refused = await phone.http('DELETE', `/api/notes/${NOTE}`);
    expect(refused.status).toBe(403);
    expect((refused.json?.['error'] as { code: string }).code).toBe('not_confirmed');
    allow = true;
    const done = await phone.http('DELETE', `/api/notes/${NOTE}`);
    expect(done.status).toBe(204);
    expect(phone.purges).toEqual([NOTE]);
    const changes = await phone.http('GET', '/sync/changes?since=0');
    const row = (changes.json?.['notes'] as Array<Record<string, unknown>>).find(
      (each) => each['id'] === NOTE,
    )!;
    expect(row['purged']).toBe(true);
    const gone = await phone.http('POST', '/sync/batch', {
      notes: [{ id: NOTE, epoch: 'x', update: [] }],
    });
    expect((gone.json?.['notes'] as Array<Record<string, unknown>>)[0]!['error']).toBe('Gone');
  });

  it('Keep note takes back a Delete for good that has not landed, and Undo marks it again (A855)', async () => {
    const remote = new MemoryRemote();
    const phone = fakeApp({ remote });
    await phone.app.call('open', { notebookId: NOTEBOOK, name: 'Work', create: true });
    await settle(phone.app);
    await phone.http('POST', '/sync/batch', {
      notes: [
        { id: NOTE, update: [toBase64(Y.encodeStateAsUpdate(editorNote('Kept')))], folderId: null },
      ],
    });
    await settle(phone.app);
    expect((await phone.http('DELETE', `/api/notes/${NOTE}`)).status).toBe(204);
    const purged = async () => {
      const changes = await phone.http('GET', '/sync/changes?since=0');
      return (
        (changes.json?.['notes'] as Array<Record<string, unknown>>).find(
          (each) => each['id'] === NOTE,
        )?.['purged'] === true
      );
    };
    expect(await purged()).toBe(true);
    await phone.app.call('keep', { noteId: NOTE, keep: true });
    // The sync goes on: the note is read back from the branch, and the phone gets it again.
    await settle(phone.app);
    expect(await purged()).toBe(false);
    const mac = await GitNotebookEngine.open({
      transport: new MemoryTransport({
        remote,
        branch: 'main',
        root: '',
        author: { name: 'Mac', email: 'mac@example.invalid' },
      }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Mac' },
    });
    await mac.sync();
    expect(readTitle(mac.replica.note(NOTE)!)).toBe('Kept');
    await phone.app.call('keep', { noteId: NOTE, keep: false });
    expect(await purged()).toBe(true);
    await expect(phone.app.call('keep', { noteId: '../x', keep: true })).rejects.toThrow();
  });

  it('captures go to the Inbox or today, offline, once each', async () => {
    const remote = new MemoryRemote();
    const phone = fakeApp({ remote });
    await phone.app.call('open', { notebookId: NOTEBOOK, name: 'Work', create: true });
    await settle(phone.app);
    const capture = {
      id: '01JBCAPTURE000000000000001',
      text: 'Call Sam\nabout the plan',
      destination: 'inbox',
      capturedAt: Date.UTC(2026, 9, 29, 15),
      timeZone: 'America/Chicago',
    };
    const first = await phone.http('POST', '/api/capture', capture);
    expect(first.json).toMatchObject({ changed: true, destination: 'inbox' });
    const retry = await phone.http('POST', '/api/capture', capture);
    expect(retry.json).toMatchObject({ changed: false, noteId: first.json?.['noteId'] });
    const daily = await phone.http('POST', '/api/capture', {
      ...capture,
      id: '01JBCAPTURE000000000000002',
      destination: 'daily',
    });
    expect(daily.json).toMatchObject({ changed: true, destination: 'daily' });
    const tree = await phone.http('GET', '/sync/tree');
    const folders = (tree.json?.['folders'] as Array<{ name: string }>)
      .map((folder) => folder.name)
      .sort();
    expect(folders).toEqual(['10', '2026', 'Inbox', 'Journal']);
    // The phone's own capture ids are its drafts' UUIDs: taken, the note's id a ULID made from it.
    const uuid = '3f2b8c1e-9d4a-4b7e-8f00-1a2b3c4d5e6f';
    const shared = await phone.http('POST', '/api/capture', {
      ...capture,
      id: uuid,
      text: 'A link\nhttps://example.com',
    });
    expect(shared.status).toBe(200);
    const noteId = String(shared.json?.['noteId']);
    expect(noteId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(await captureNoteId(uuid)).toBe(noteId);
    expect(await captureNoteId('01JBN0000000000000000000P1')).toBe('01JBN0000000000000000000P1');
    expect((await phone.http('POST', '/api/capture', { ...capture, id: '../x' })).status).toBe(400);
  });

  it('a push that fails still delivers what its fetch brought, and says when it tries again', async () => {
    const remote = new MemoryRemote();
    let pushes = 0;
    const phone = fakeApp({
      remote,
      transport: (base) =>
        Object.assign(Object.create(base) as MemoryTransport, {
          push: async (commit: string) => {
            if (++pushes > 1) throw new GitTransportError('network', 'offline');
            return base.push(commit);
          },
        }),
    });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: true,
      host: 'github.com',
    });
    await settle(phone.app);
    const mac = await GitNotebookEngine.open({
      transport: new MemoryTransport({
        remote,
        branch: 'main',
        root: '',
        author: { name: 'Mac', email: 'mac@example.invalid' },
      }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Penmoss for Mac' },
    });
    await mac.sync();
    const ops = new NotebookOps(mac);
    const id = ops.createNote({ title: 'From the Mac', markdown: 'hello' });
    await mac.sync();
    // The phone has an edit to push (so the push runs and fails), and the fetch brings the Mac's.
    await phone.http('POST', '/sync/batch', {
      notes: [{ id: NOTE, update: [toBase64(Y.encodeStateAsUpdate(editorNote('Mine')))] }],
    });
    const changedBefore = phone.changed.count;
    const status = await settle(phone.app);
    expect(status.phase).toBe('offline');
    expect(status.detail).toContain("Can't reach github.com");
    expect(status.nextRetryAt).toBeGreaterThan(Date.now());
    expect(phone.changed.count).toBeGreaterThan(changedBefore);
    const changes = await phone.http('GET', '/sync/changes?since=0');
    expect(
      (changes.json?.['notes'] as Array<{ id: string; title: string }>).find((row) => row.id === id)
        ?.title,
    ).toBe('From the Mac');
  });

  it('a sync that hangs is stopped at its limit, cancels the git running, and counts as offline (A859)', async () => {
    const remote = new MemoryRemote();
    let hang = false;
    const phone = fakeApp({
      remote,
      transport: (base) =>
        Object.assign(Object.create(base) as MemoryTransport, {
          fetch: () => (hang ? new Promise<string | null>(() => undefined) : base.fetch()),
        }),
    });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: true,
      host: 'github.com',
    });
    await settle(phone.app);
    hang = true;
    const status = (await phone.app.call('sync', {
      reason: 'background',
      limitMs: 200,
    })) as GitSyncStatus;
    expect(status.phase).toBe('offline');
    expect(status.code).toBe('timeout');
    expect(phone.cancels.count).toBe(1);
    // Never "syncing" after it: every status it told the app ends the sync.
    expect(phone.statuses.at(-1)?.phase).toBe('offline');
  });
});

describe('the guard (A876)', () => {
  it('names the notes a commit deletes for good from the head the app reads, never the page', async () => {
    const remote = new MemoryRemote();
    const phone = fakeApp({ remote, confirm: () => true });
    await phone.app.call('open', { notebookId: NOTEBOOK, name: 'Work', create: true });
    await settle(phone.app);
    await phone.http('POST', '/sync/batch', {
      notes: [
        {
          id: NOTE,
          update: [toBase64(Y.encodeStateAsUpdate(editorNote('Budget')))],
          folderId: null,
        },
      ],
    });
    await settle(phone.app);
    const head = remote.branches.get('main')!;
    const [appPort, guardPort] = pipe();
    serveGuard(guardPort);
    const reader = phone.base;
    const app = new Channel(appPort, {
      'head.list': async (args) => [...(await reader.list((args as string[])[1]!))],
      'head.read': async (args) => [
        ...(await reader.read(
          (args as [string, string, string[]])[1],
          (args as [string, string, string[]])[2],
        )),
      ],
    });
    const titles = (await app.call('guard.titles', {
      localId: 'L',
      root: '',
      head,
      ids: [NOTE],
    })) as Array<[string, string]>;
    expect(titles).toEqual([[NOTE, 'Budget']]);
    // A workspace log with the note marked deleted for good: the guard says so.
    const mac = await GitNotebookEngine.open({
      transport: new MemoryTransport({
        remote,
        branch: 'main',
        root: '',
        author: { name: 'Mac', email: 'm@example.invalid' },
      }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Mac' },
    });
    await mac.sync();
    new NotebookOps(mac).purge(NOTE);
    const workspaceLog = `.penmoss/workspace/${mac.writer!.id}.yjs`;
    const verdict = (await app.call('guard.commit', {
      localId: 'L',
      root: '',
      head,
      changes: [[workspaceLog, Y.encodeStateAsUpdate(mac.replica.workspace)]],
    })) as { added: string[]; reversed: string[]; shrunk: string[] };
    expect(verdict.added).toEqual([NOTE]);
    expect(verdict.reversed).toEqual([]);
    expect(await app.call('guard.purgedAt', { localId: 'L', root: '', head })).toEqual([]);
  });
});

describe('bringing back Room’s old copies (A886)', () => {
  const macOf = (remote: MemoryRemote, create: boolean) =>
    GitNotebookEngine.open({
      transport: new MemoryTransport({
        remote,
        branch: 'main',
        root: '',
        author: { name: 'Mac', email: 'mac@example.invalid' },
      }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Penmoss for Mac' },
      ...(create ? { create: { id: NOTEBOOK, name: 'Work' } } : {}),
    });
  const clock = () => Date.UTC(2026, 9, 30, 9);
  const headText = (remote: MemoryRemote) => {
    const head = remote.branches.get('main')!;
    return [...remote.commits.get(head)!.tree.values()].map((blob) =>
      new TextDecoder().decode(remote.blobs.get(blob)),
    );
  };

  it('a Delete for good that a waiting sync fetches leaves nothing brought back (the race)', async () => {
    const remote = new MemoryRemote();
    const mac = await macOf(remote, true);
    const ops = new NotebookOps(mac, clock);
    const id = ops.createNote({ title: 'Passwords', markdown: 'hunter2' });
    await mac.sync();
    // Room's old copy: git's note, and an edit the cleared store took in and never pushed.
    const old = new Y.Doc();
    Y.applyUpdate(old, Y.encodeStateAsUpdate(mac.replica.note(id)!));
    setTitle(old, 'Passwords, edited');
    let holding = false;
    let release: (() => void) | null = null;
    const phone = fakeApp({
      remote,
      transport: (base) =>
        Object.assign(Object.create(base) as MemoryTransport, {
          fetch: async () => {
            if (holding) await new Promise<void>((resolve) => (release = resolve));
            return base.fetch();
          },
        }),
    });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: false,
      host: 'github.com',
      roomEpochs: ['the-cleared-store'],
    });
    expect((await settle(phone.app)).phase).toBe('synced');
    // Elsewhere it is deleted for good, and that lands.
    ops.purge(id);
    await mac.sync();
    // The phone's next sync is held at its fetch; recovery of the note queues behind it.
    holding = true;
    const syncing = phone.app.call('sync', { reason: 'now' });
    await vi.waitFor(() => expect(release).not.toBeNull());
    const recovering = phone.app.call('recover', {
      token: 'pass-1',
      noteId: id,
      first: true,
      pieces: [{ n: 0, s: toBase64(Y.encodeStateAsUpdate(old)) }],
      folderId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    holding = false;
    release!();
    await syncing;
    expect(await recovering).toEqual({ status: 'done' });
    expect((await settle(phone.app)).phase).toBe('synced');
    // Nothing of it at head, and no note came back under a new id.
    expect(headText(remote).some((text) => text.includes('hunter2'))).toBe(false);
    const reader = await macOf(remote, false);
    await reader.sync();
    expect(reader.replica.noteIds().map((each) => readTitle(reader.replica.note(each)!))).toEqual(
      [],
    );
  });

  const oldCopyOf = (mac: GitNotebookEngine, noteId: string, title: string) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(mac.replica.note(noteId)!));
    setTitle(doc, title);
    return toBase64(Y.encodeStateAsUpdate(doc));
  };
  const recoverOn = (phone: ReturnType<typeof fakeApp>, noteId: string, s: string, token: string) =>
    phone.app.call('recover', {
      token,
      noteId,
      first: true,
      pieces: [{ n: 0, s }],
      folderId: null,
    }) as Promise<{ status: string; id: string; title: string }>;
  /** The phone's editor types into a note: its body becomes `markdown`, uploaded as Room does. */
  const typeInto = async (phone: ReturnType<typeof fakeApp>, noteId: string, markdown: string) => {
    const down = await phone.http('POST', '/sync/batch', { notes: [{ id: noteId }] });
    const held = (down.json?.['notes'] as Array<Record<string, unknown>>)[0]!;
    const doc = new Y.Doc();
    doc.clientID = 4343;
    Y.applyUpdate(doc, fromBase64(held['update'] as string));
    const before = Y.encodeStateVector(doc);
    setBody(doc, docToDelta(parseMarkdown(markdown).doc));
    const up = await phone.http('POST', '/sync/batch', {
      notes: [
        {
          id: noteId,
          epoch: held['epoch'],
          update: [toBase64(Y.encodeStateAsUpdate(doc, before))],
        },
      ],
    });
    return (up.json?.['notes'] as Array<Record<string, unknown>>)[0]!;
  };
  const bodyText = (doc: Y.Doc) => JSON.stringify(doc.get(NOTE_ROOT).toDeltaDeep());

  it('a Delete for good landing after the phone’s last fetch withholds the copy: kept on the phone only, nothing of it pushed', async () => {
    const remote = new MemoryRemote();
    const mac = await macOf(remote, true);
    const ops = new NotebookOps(mac, clock);
    const id = ops.createNote({ title: 'Passwords', markdown: 'hunter2' });
    const kept = ops.createNote({ title: 'Groceries', markdown: 'milk' });
    await mac.sync();
    const passwords = oldCopyOf(mac, id, 'Passwords, edited');
    const groceries = oldCopyOf(mac, kept, 'Groceries, edited');
    const phone = fakeApp({ remote, guard: true });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: false,
      host: 'github.com',
      roomEpochs: ['the-cleared-store'],
    });
    expect((await settle(phone.app)).phase).toBe('synced');
    // Deleted for good elsewhere after the phone's last fetch: the phone cannot know yet.
    ops.purge(id);
    await mac.sync();
    const copy = await recoverOn(phone, id, passwords, 'p');
    expect(copy).toMatchObject({ status: 'recovered' });
    expect(await recoverOn(phone, kept, groceries, 'g')).toMatchObject({ status: 'recovered' });
    // Its sync fetches the purge first: the copy of the purged note is withheld, handed to Room
    // whole, and the other is pushed.
    expect((await settle(phone.app)).phase).toBe('synced');
    expect(phone.withheld.map((each) => [each.noteId, each.origin, each.title])).toEqual([
      [copy.id, id, 'Passwords, edited (recovered)'],
    ]);
    const kept1 = new Y.Doc();
    Y.applyUpdate(kept1, phone.withheld[0]!.update);
    expect(bodyText(kept1)).toContain('hunter2');
    expect(headText(remote).some((text) => text.includes('hunter2'))).toBe(false);
    const reader = await macOf(remote, false);
    await reader.sync();
    const titles = () =>
      readWorkspace(reader.replica.workspace)
        .notes.map((note) => readTitle(reader.replica.note(note.id)!))
        .sort();
    expect(titles()).toEqual(['Groceries', 'Groceries, edited (recovered)']);
    // Once on the branch the link stays, and a later purge of the original leaves the copy.
    new NotebookOps(reader, clock).purge(kept);
    await reader.sync();
    expect((await settle(phone.app)).phase).toBe('synced');
    await reader.sync();
    expect(titles()).toEqual(['Groceries, edited (recovered)']);
    expect(phone.withheld).toHaveLength(1);
  });

  it('a Delete for good of the original made on this phone pushes its copy, with what was typed on it (the probe)', async () => {
    const remote = new MemoryRemote();
    const mac = await macOf(remote, true);
    const ops = new NotebookOps(mac, clock);
    const id = ops.createNote({ title: 'Passwords', markdown: 'hunter2' });
    await mac.sync();
    const phone = fakeApp({ remote, guard: true });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: false,
      host: 'github.com',
      roomEpochs: ['the-cleared-store'],
    });
    expect((await settle(phone.app)).phase).toBe('synced');
    const copy = await recoverOn(phone, id, oldCopyOf(mac, id, 'Passwords NEWEDIT'), 'p');
    expect(copy).toMatchObject({ status: 'recovered', title: 'Passwords NEWEDIT (recovered)' });
    expect((await typeInto(phone, copy.id, 'hunter2\n\nTYPEDLATER'))['error']).toBeNull();
    // The person deletes the stale original for good; the owner check names only the original.
    expect((await phone.http('DELETE', `/api/notes/${id}`)).status).toBe(204);
    expect(phone.purges).toEqual([id]);
    expect((await settle(phone.app)).phase).toBe('synced');
    // The copy and what was typed on it are pushed: the person chose to delete only the original.
    expect(phone.withheld).toEqual([]);
    expect(headText(remote).some((text) => text.includes('TYPEDLATER'))).toBe(true);
    const reader = await macOf(remote, false);
    await reader.sync();
    const notes = readWorkspace(reader.replica.workspace).notes;
    expect(notes.map((note) => readTitle(reader.replica.note(note.id)!))).toEqual([
      'Passwords NEWEDIT (recovered)',
    ]);
    expect(bodyText(reader.replica.note(copy.id)!)).toContain('TYPEDLATER');
  });

  it('a purge fetched from another device withholds the copy with its typing; Save their text has it all, and Keep and sync pushes it once confirmed', async () => {
    const remote = new MemoryRemote();
    const mac = await macOf(remote, true);
    const ops = new NotebookOps(mac, clock);
    const id = ops.createNote({ title: 'Passwords', markdown: 'hunter2' });
    await mac.sync();
    const phone = fakeApp({ remote, guard: true });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: false,
      host: 'github.com',
      roomEpochs: ['the-cleared-store'],
    });
    expect((await settle(phone.app)).phase).toBe('synced');
    const copy = await recoverOn(phone, id, oldCopyOf(mac, id, 'Passwords NEWEDIT'), 'p');
    expect((await typeInto(phone, copy.id, 'hunter2\n\nTYPEDLATER'))['error']).toBeNull();
    // Room has listed it, as its passes do.
    await phone.http('GET', '/sync/changes?since=0');
    // Offline from the phone, another device deletes the original for good.
    ops.purge(id);
    await mac.sync();
    expect((await settle(phone.app)).phase).toBe('synced');
    // Withheld, never deleted: Room has the whole copy, the typing too, and nothing reached head.
    expect(phone.withheld.map((each) => [each.noteId, each.origin, each.title])).toEqual([
      [copy.id, id, 'Passwords NEWEDIT (recovered)'],
    ]);
    const kept = phone.withheld[0]!;
    const whole = new Y.Doc();
    Y.applyUpdate(whole, kept.update);
    expect(bodyText(whole)).toContain('TYPEDLATER');
    expect(
      headText(remote).some((text) => text.includes('hunter2') || text.includes('TYPEDLATER')),
    ).toBe(false);
    const changes = await phone.http('GET', '/sync/changes?since=0');
    expect(
      (changes.json?.['notes'] as Array<Record<string, unknown>>).find(
        (row) => row['id'] === copy.id,
      ),
    ).toMatchObject({ purged: true });
    // What is typed on it after stays with Room's copy: the page never takes it back in.
    const editor = new Y.Doc();
    editor.clientID = 4343;
    Y.applyUpdate(editor, kept.update);
    const seen = Y.encodeStateVector(editor);
    setBody(editor, docToDelta(parseMarkdown('hunter2\n\nTYPEDLATER\n\nAND MORE').doc));
    const late = await phone.http('POST', '/sync/batch', {
      notes: [
        {
          id: copy.id,
          epoch: null,
          update: [toBase64(Y.encodeStateAsUpdate(editor, seen))],
        },
      ],
    });
    expect((late.json?.['notes'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      error: 'Gone',
    });
    expect(headText(remote).some((text) => text.includes('AND MORE'))).toBe(false);
    // Save their text: the whole copy, the typing included.
    const saved = (await phone.app.call('recover.text', {
      token: 'save',
      noteId: copy.id,
      first: true,
      pieces: [{ n: 0, s: toBase64(kept.update) }],
    })) as { title: string; markdown: string };
    expect(saved.title).toBe('Passwords NEWEDIT (recovered)');
    expect(saved.markdown).toContain('TYPEDLATER');
    const keep = (token: string) =>
      phone.app.call('copy.keep', {
        token,
        noteId: copy.id,
        origin: id,
        folderId: null,
        first: true,
        pieces: [{ n: 0, s: toBase64(kept.update) }],
      });
    // Keep and sync without the person's confirmation: main refuses it and nothing lands; the next
    // sync withholds it again, for the person.
    expect(await keep('k1')).toMatchObject({ status: 'kept' });
    expect((await settle(phone.app)).code).toBe('purge_raced');
    expect(headText(remote).some((text) => text.includes('TYPEDLATER'))).toBe(false);
    expect((await settle(phone.app)).phase).toBe('synced');
    expect(phone.withheld).toHaveLength(2);
    // Confirmed (the owner check names the copy): pushed as a new note, its typing with it.
    phone.keeps.add(copy.id);
    expect(await keep('k2')).toMatchObject({
      status: 'kept',
      title: 'Passwords NEWEDIT (recovered)',
    });
    expect((await settle(phone.app)).phase).toBe('synced');
    expect(headText(remote).some((text) => text.includes('TYPEDLATER'))).toBe(true);
    const reader = await macOf(remote, false);
    await reader.sync();
    expect(
      readWorkspace(reader.replica.workspace).notes.map((note) =>
        readTitle(reader.replica.note(note.id)!),
      ),
    ).toEqual(['Passwords NEWEDIT (recovered)']);
    expect(bodyText(reader.replica.note(copy.id)!)).toContain('TYPEDLATER');
    // On the branch, it stays: later syncs never withhold it again.
    expect((await settle(phone.app)).phase).toBe('synced');
    expect(phone.withheld).toHaveLength(2);
  });

  it('a pass and Save their text on the same copy, over 4 MB, never mix their parts', async () => {
    const remote = new MemoryRemote();
    // A note git never had: a long one, more than 4 MB of base64 in Room.
    const scratch = await macOf(new MemoryRemote(), true);
    const lines = Array.from({ length: 100_000 }, (_, n) => `Line ${n + 1} of the long note, kept`);
    const id = new NotebookOps(scratch, clock).createNote({ title: 'Long notes', markdown: '' });
    // The body parseMarkdown(lines.join('\n')) makes, one paragraph, built from the schema and
    // put in place whole. Parsing 3.6 MB of markdown, and diffing it into the note, took 4–5 s
    // of the test's 5 s on their own (PEN-113); the size is what the test is about.
    const { schema } = parseMarkdown('').doc.type;
    const body = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text(lines.join('\n'))]),
    ]);
    const root = scratch.replica.note(id)!.get(NOTE_ROOT);
    root.delete(0, root.length);
    root.applyDelta(docToDelta(body));
    const encoded = toBase64(Y.encodeStateAsUpdate(scratch.replica.note(id)!));
    expect(encoded.length).toBeGreaterThan(4 * 1024 * 1024);
    const half = Math.floor(encoded.length / 2);
    const phone = fakeApp({ remote });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: true,
      host: 'github.com',
      roomEpochs: ['the-cleared-store'],
    });
    expect((await settle(phone.app)).phase).toBe('synced');
    // Interleaved, as a pass and Save their text running at once send them.
    const piece = (s: string) => [{ n: 0, s }];
    await phone.app.call('recover.part', {
      token: 'pass',
      noteId: id,
      first: true,
      pieces: piece(encoded.slice(0, half)),
    });
    await phone.app.call('recover.part', {
      token: 'save',
      noteId: id,
      first: true,
      pieces: piece(encoded.slice(0, half)),
    });
    const back = (await phone.app.call('recover', {
      token: 'pass',
      noteId: id,
      pieces: piece(encoded.slice(half)),
      folderId: null,
    })) as { status: string; title: string };
    const saved = (await phone.app.call('recover.text', {
      token: 'save',
      noteId: id,
      pieces: piece(encoded.slice(half)),
    })) as { title: string; markdown: string } | null;
    expect(back).toMatchObject({ status: 'recovered', title: 'Long notes (recovered)' });
    expect(saved?.title).toBe('Long notes');
    expect(saved?.markdown).toContain('Line 1 of the long note, kept');
    expect(saved?.markdown).toContain('Line 100000 of the long note, kept');
  });
});

describe('GitHub refuses a private email (GH007, #170 F6)', () => {
  it('says to commit as the no-reply address, set for this notebook in Settings', () => {
    const said = describeFailure(
      new GitTransportError(
        'refused',
        'The host refused the push (rejected_other_reason).',
        'error: GH007: Your push would publish a private email address.',
      ),
      'github.com',
    );
    expect(said.status.phase).toBe('stopped');
    expect(said.status.detail).toContain('(GH007)');
    expect(said.status.detail).toContain('@users.noreply.github.com');
    expect(said.status.detail).toContain(
      'set it as this notebook’s commit email in Settings → Git notebooks',
    );
    // Any other refusal keeps the host's words.
    const other = describeFailure(
      new GitTransportError('protected', 'Protected.', 'GH006: Protected branch update failed'),
      'github.com',
    );
    expect(other.status.detail).toContain('GH006');
    expect(other.status.detail).not.toContain('no-reply');
  });
});

/** A transport whose push takes `ms.push` (the app's JGit over a slow network). */
function slowPush(ms: { push: number }) {
  return (base: MemoryTransport): GitTransport =>
    new Proxy(base, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (key === 'push') {
          return async (commit: string) => {
            if (ms.push) await new Promise((resolve) => setTimeout(resolve, ms.push));
            return target.push(commit);
          };
        }
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
}

/** A note the phone's editor made, sent the way Room sends it. */
async function typed(phone: ReturnType<typeof fakeApp>, id: string, title: string) {
  const doc = new Y.Doc();
  initNote(doc, { id, created: '2026-10-29T10:00:00-05:00', kind: 'note' }, title);
  const sent = await phone.http('POST', '/sync/batch', {
    notes: [{ id, update: [toBase64(Y.encodeStateAsUpdate(doc))], folderId: null, text: true }],
  });
  expect(sent.status).toBe(200);
}

async function onBranch(phone: ReturnType<typeof fakeApp>): Promise<string[]> {
  const head = await phone.base.fetch();
  return head ? [...(await phone.base.list(head)).keys()] : [];
}

const SECOND = '01JBNOTE000000000000000002';

describe('leaving the screen, as on the Mac (#174 review: F8 on Android)', () => {
  it('waits up to 10 s for the push in flight, and two asks share one', async () => {
    const remote = new MemoryRemote();
    const ms = { push: 0 };
    const phone = fakeApp({ remote, transport: slowPush(ms) });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: true,
      host: 'github.com',
      label: 'Penmoss for Android (Pixel)',
      front: true,
    });
    await settle(phone.app);
    await typed(phone, NOTE, 'Plan');
    // Slower than the 5 s the phone once gave it, within the 10 s it has now.
    ms.push = 6500;
    const pushing = phone.app.call('sync', { reason: 'now' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await Promise.all([phone.app.call('close'), phone.app.call('close')]);
    expect(phone.cancels.count).toBe(0);
    expect((await onBranch(phone)).some((path) => path.includes(`/${NOTE}/`))).toBe(true);
    await pushing;
  });

  it('a plain pause (the file picker, the share sheet) never stops a push; leaving does, at the limit (#174 delta review)', async () => {
    const remote = new MemoryRemote();
    const ms = { push: 0 };
    const phone = fakeApp({ remote, transport: slowPush(ms) });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: true,
      host: 'github.com',
      label: 'Penmoss for Android (Pixel)',
      front: true,
      closingSyncMs: 300,
    });
    await settle(phone.app);
    await typed(phone, NOTE, 'Plan');
    ms.push = 1200;
    const pushing = phone.app.call('sync', { reason: 'now' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Paused, not leaving: past the time limit, the push goes on.
    await phone.app.call('close', { leaving: false });
    expect(phone.cancels.count).toBe(0);
    await pushing;
    expect((await onBranch(phone)).some((path) => path.includes(`/${NOTE}/`))).toBe(true);
    expect(phone.cancels.count).toBe(0);

    // Leaving the screen (or finishing): at the limit, a push with something waiting is stopped.
    await typed(phone, SECOND, 'Later');
    const again = phone.app.call('sync', { reason: 'now' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await phone.app.call('close', { leaving: true });
    expect(phone.cancels.count).toBe(1);
    await again;
  });
});

describe('offline, as on the Mac (#174 review: F9 on Android)', () => {
  function network(online: boolean) {
    const net = { online };
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      get onLine() {
        return net.online;
      },
    });
    return net;
  }

  it('an edit with the network down says Offline at once; Sync now still tries; back, it syncs', async () => {
    const net = network(true);
    try {
      const remote = new MemoryRemote();
      const phone = fakeApp({ remote });
      await phone.app.call('open', {
        notebookId: NOTEBOOK,
        name: 'Work',
        create: true,
        host: 'github.com',
        label: 'Penmoss for Android (Pixel)',
        front: true,
        onlineSettleMs: 100,
      });
      await settle(phone.app);
      net.online = false;
      window.dispatchEvent(new Event('offline'));
      await typed(phone, NOTE, 'Offline');
      await vi.waitFor(() => expect(phone.statuses.at(-1)?.phase).toBe('offline'));
      expect(phone.statuses.at(-1)?.pending).toContain(NOTE);
      // Sync now is the person's: tried whatever the network says.
      const tried = await settle(phone.app);
      expect(tried.phase).toBe('synced');
      await typed(phone, SECOND, 'Offline again');
      await vi.waitFor(() => expect(phone.statuses.at(-1)?.phase).toBe('offline'));
      net.online = true;
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(
        async () =>
          expect((await onBranch(phone)).some((path) => path.includes(`/${SECOND}/`))).toBe(true),
        { timeout: 3000 },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Sync now pressed while a sync runs runs after it as a Sync now, never ending on Offline (#174 delta review)', async () => {
    const net = network(true);
    try {
      const remote = new MemoryRemote();
      const ms = { push: 0 };
      const phone = fakeApp({ remote, transport: slowPush(ms) });
      await phone.app.call('open', {
        notebookId: NOTEBOOK,
        name: 'Work',
        create: true,
        host: 'github.com',
        label: 'Penmoss for Android (Pixel)',
        front: true,
      });
      await settle(phone.app);
      await typed(phone, NOTE, 'Plan');
      ms.push = 300;
      const first = phone.app.call('sync', { reason: 'now' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The WebView now says offline (it may be wrong), and the person taps Sync now again.
      net.online = false;
      const before = phone.statuses.length;
      const second = phone.app.call('sync', { reason: 'now' });
      await Promise.all([first, second]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = phone.statuses.slice(before).map((status) => status.phase);
      expect(after).not.toContain('offline');
      expect(after.filter((phase) => phase === 'syncing').length).toBeGreaterThan(0);
      expect(phone.statuses.at(-1)?.phase).toBe('synced');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a repository on the phone never waits for the network', async () => {
    network(false);
    try {
      const remote = new MemoryRemote();
      const phone = fakeApp({ remote });
      await phone.app.call('open', {
        notebookId: NOTEBOOK,
        name: 'Work',
        create: true,
        host: 'this phone',
        label: 'Penmoss for Android (Pixel)',
        front: true,
      });
      await vi.waitFor(() => expect(phone.statuses.at(-1)?.phase).toBe('synced'));
      await typed(phone, NOTE, 'Local');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(phone.statuses.at(-1)?.phase).not.toBe('offline');
      await phone.app.call('close');
      expect((await onBranch(phone)).some((path) => path.includes(`/${NOTE}/`))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the sync cadence (A1013)', () => {
  /** Runs `promise` to its end under fake timers, a millisecond at a time. */
  async function drive<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) await vi.advanceTimersByTimeAsync(1);
    return promise;
  }

  it('pushes 12 s after the last edit settles and pulls every minute while visible, never while hidden', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const reasons: Array<{ reason: string; at: number }> = [];
    const started = Date.now();
    const spy = vi.spyOn(AndroidGitHost.prototype, 'syncNow').mockImplementation(function (
      reason = 'now',
    ) {
      reasons.push({ reason, at: Date.now() - started });
      return Promise.resolve();
    });
    try {
      const phone = fakeApp({ remote: new MemoryRemote() });
      // The app's defaults: the page is opened with no cadence of its own.
      await drive(
        phone.app.call('open', {
          notebookId: NOTEBOOK,
          name: 'Work',
          create: true,
          host: 'github.com',
          label: 'Penmoss for Android (Pixel)',
          front: true,
        }),
      );
      const pulls = () => reasons.filter((each) => each.reason === 'pull').length;
      const pushes = () => reasons.filter((each) => each.reason === 'push');
      reasons.length = 0;

      // Edits: the push waits for them to settle, 12 s after the last.
      await drive(typed(phone, NOTE, 'Plan'));
      await vi.advanceTimersByTimeAsync(5_000);
      await drive(typed(phone, SECOND, 'Later'));
      const lastEdit = Date.now() - started;
      await vi.advanceTimersByTimeAsync(11_800);
      expect(pushes()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(400);
      expect(pushes()).toHaveLength(1);
      expect(Math.abs(pushes()[0]!.at - (lastEdit + 12_000))).toBeLessThan(300);

      // Visible: a pull every 60 s.
      const before = pulls();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pulls() - before).toBe(2);

      // Hidden: none.
      await drive(phone.app.call('front', { front: false }));
      const hidden = pulls();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(pulls()).toBe(hidden);

      // Visible again: a pull at once (focus), then every minute.
      await drive(phone.app.call('front', { front: true }));
      expect(pulls()).toBe(hidden + 1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pulls()).toBe(hidden + 2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the device settings in the Journal notebook (A1014)', () => {
  it('a setting changed on the phone is the Mac’s device/<key>, and the Mac’s reaches the phone’s tree', async () => {
    const remote = new MemoryRemote();
    const phone = fakeApp({ remote });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Journal',
      create: true,
      host: 'github.com',
      label: 'Penmoss for Android (Pixel)',
      front: true,
    });
    await settle(phone.app);

    // The phone's Settings and Quick Access, with no account: the JSON values as they are.
    const pins = [NOTE, SECOND];
    const changed = await phone.http('PUT', '/android/device-settings', {
      set: { 'theme.mode': 'dark', 'quickAccess.notes': pins, 'editor.fontSize': 17 },
    });
    expect(changed.status).toBe(200);
    expect(changed.json?.['device']).toEqual({
      'theme.mode': 'dark',
      'quickAccess.notes': pins,
      'editor.fontSize': 17,
    });
    await settle(phone.app);

    // The Mac (its WorkspaceService writes `setSetting(doc, 'device', key, value)`) reads them.
    const mac = await GitNotebookEngine.open({
      transport: new MemoryTransport({
        remote,
        branch: 'main',
        root: '',
        author: { name: 'Mac', email: 'mac@example.invalid' },
      }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Penmoss for Mac' },
    });
    await mac.sync();
    expect(readSettings(mac.replica.workspace, 'device')).toEqual({
      'theme.mode': 'dark',
      'quickAccess.notes': pins,
      'editor.fontSize': 17,
    });
    // Nothing of the notebook's own map was touched.
    expect(readSettings(mac.replica.workspace, 'notebook')['theme.mode']).toBeUndefined();

    // The Mac unpins one and picks a theme; the phone's next pull and tree have them.
    setSetting(mac.replica.workspace, 'device', 'quickAccess.notes', [SECOND]);
    setSetting(mac.replica.workspace, 'device', 'theme.id', 'nord');
    await mac.sync();
    await settle(phone.app);
    const tree = await phone.http('GET', '/sync/tree');
    expect(tree.json?.['device']).toEqual({
      'theme.mode': 'dark',
      'quickAccess.notes': [SECOND],
      'editor.fontSize': 17,
      'theme.id': 'nord',
    });
    // A null removes one (its default shows), and the read route says the same.
    await phone.http('PUT', '/android/device-settings', { set: { 'theme.id': null } });
    const read = await phone.http('GET', '/android/device-settings');
    expect(read.json?.['device']).not.toHaveProperty('theme.id');
  });

  it('keeps the notebook’s own settings out, and agents’ settings route still refuses the device’s', async () => {
    const phone = fakeApp({ remote: new MemoryRemote() });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Journal',
      create: true,
      host: 'github.com',
      label: 'Penmoss for Android (Pixel)',
      front: true,
    });
    await settle(phone.app);
    const own = await phone.http('PUT', '/android/device-settings', {
      set: { timeZone: 'Europe/Paris' },
    });
    expect(own.status).toBe(403);
    expect(await phone.http('PUT', '/android/device-settings', { set: {} })).toMatchObject({
      status: 400,
    });
    // The CLI's local notes API (what agents use) never writes a device setting.
    const agents = await phone.http('PUT', '/api/settings', {
      set: { 'theme.mode': 'dark' },
      base: { 'theme.mode': null },
    });
    expect(agents.status).toBe(403);
    expect((agents.json?.['error'] as { code: string }).code).toBe('setting_not_allowed');
  });
});

describe('Send to…’s sessions from the WorkspaceDoc (T60, A1060, A1076)', () => {
  it('lists the sessions an agent’s channel wrote: offered ones first, running before them, and says once a sync landed', async () => {
    const remote = new MemoryRemote();
    const phone = fakeApp({ remote });
    await phone.app.call('open', {
      notebookId: NOTEBOOK,
      name: 'Work',
      create: true,
      host: 'github.com',
    });
    await settle(phone.app);

    // Claude Code's clone, an agent writer, as `penmoss mcp --channel` writes its entries.
    const agent = await GitNotebookEngine.open({
      transport: new MemoryTransport({
        remote,
        branch: 'main',
        root: '',
        author: { name: 'Claude', email: 'claude@example.invalid' },
      }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'agent', label: 'Claude Code' },
    });
    await agent.sync();
    const writer = agent.writer!.id;
    const now = Date.now();
    const entry = async (name: string, lastSeen: number) => ({
      key: await sessionKey(writer, name),
      writer,
      label: `Claude Code · ${name}`,
      name: `mac:/src/${name}`,
      host: 'mac',
      lastSeen,
    });
    const idle = await entry('idle', now - 5 * 60 * 60_000);
    const live = await entry('live', now - 60_000);
    const old = await entry('old', now - 8 * 24 * 60 * 60_000);
    for (const each of [old, idle, live]) recordAgentSession(agent.replica.workspace, each);
    await agent.sync();
    await settle(phone.app);

    const listed = await phone.http('GET', '/android/agent-sessions');
    expect(listed.status).toBe(200);
    expect(listed.json?.['synced']).toBe(true);
    const sessions = listed.json?.['sessions'] as Array<Record<string, unknown>>;
    expect(sessions.map((each) => [each['key'], each['active'], each['offered']])).toEqual([
      [live.key, true, true],
      [idle.key, false, true],
      [old.key, false, false],
    ]);
    expect(sessions[0]).toMatchObject({
      writer,
      label: 'Claude Code · live',
      name: 'mac:/src/live',
      host: 'mac',
      lastSeen: live.lastSeen,
    });

    // A page opened afresh whose first sync has not landed says so: the app fails nothing yet.
    const cold = fakeApp({
      remote,
      transport: (base) =>
        Object.assign(Object.create(base) as MemoryTransport, {
          fetch: () => new Promise<string | null>(() => undefined),
        }),
    });
    await cold.app.call('open', { notebookId: NOTEBOOK, name: 'Work', host: 'github.com' });
    const early = await cold.http('GET', '/android/agent-sessions');
    expect(early.status).toBe(200);
    expect(early.json).toMatchObject({ synced: false, sessions: [] });
    await cold.app.call('stop');
    await phone.app.call('stop');
  });
});
