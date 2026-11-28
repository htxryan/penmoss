/**
 * The relay's notebook (T55) in Node, against a fake GitHub over an in-memory remote: MCP over
 * HTTP in front of the local tools, a Mac over git as the other writer, pulls before reads,
 * pushes on the alarm, and a public repository synced like any other (D61).
 */
import {
  GitNotebookEngine,
  MemoryRemote,
  MemorySecrets,
  MemoryStorage,
  MemoryTransport,
  NotebookOps,
  commitWriter,
} from '@penmoss/git-notebook';
import { COMMENT_TOOL_NAMES } from '@penmoss/git-notebook/local';
import { localTools, RELAY_ABSENT_TOOLS } from '@penmoss/git-notebook/local';
import { notebookTag, shortNoteRef } from '@penmoss/core/note-ref';
import { readTitle } from '@penmoss/model/note';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FAKE_API,
  FAKE_REPO,
  FAKE_TOKEN,
  fakeGitHub,
} from '../../../packages/git-notebook/test/support/fake-github';
import { readConfig, type RelayConfig } from '../src/config';
import { PULL_AFTER_MS, PUSH_AFTER_MS, Relay, relayInstructions } from '../src/relay';
import { BlobStorage, MemoryBlobs, PrefixedBlobs } from '../src/storage';

const NOTEBOOK = { id: '01JBNOTEBOOK00000000000001', name: 'Personal' };
const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
/** Where the one notebook's copy is kept in the relay's storage. */
const COPY = `copy:${FAKE_REPO}#main:notes//`;

async function call(relay: Relay, name: string, args: Record<string, unknown>) {
  const response = await relay.handle(
    new Request('https://x/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
  return (
    await response.json<{
      result: {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
      };
    }>()
  ).result;
}

function config(): RelayConfig {
  const read = readConfig({ OWNER_GITHUB_LOGIN: 'htxryan', GITHUB_API: FAKE_API }, null, [
    {
      repository: FAKE_REPO,
      branch: 'main',
      root: 'notes/',
      access: { kind: 'token', token: FAKE_TOKEN },
    },
  ]);
  if ('problem' in read) throw new Error(read.problem);
  return read;
}

async function setup(options: { private?: boolean } = {}) {
  const remote = new MemoryRemote();
  let time = Date.UTC(2026, 10, 4, 9, 0, 0);
  const clock = () => time;
  const mac = await GitNotebookEngine.open({
    transport: new MemoryTransport({ remote, branch: 'main', root: 'notes/', clock }),
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    writer: { kind: 'device', label: 'Mac' },
    create: NOTEBOOK,
    clock,
  });
  const macOps = new NotebookOps(mac, clock);
  const garden = macOps.createNote({ title: 'Garden plan', markdown: 'Tomatoes and basil' });
  await mac.sync();

  const github = fakeGitHub(remote, { private: options.private ?? true });
  const blobs = new MemoryBlobs();
  const alarms: number[] = [];
  const logs: string[] = [];
  const relay = new Relay(
    config(),
    {
      blobs,
      scheduleSync: (at) => {
        alarms.push(at);
        return Promise.resolve();
      },
      log: (text) => logs.push(text),
    },
    { fetch: github.fetch, clock },
  );
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await relay.handle(
      new Request('https://mcp.penmoss.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      }),
    );
    return response.json<{ result?: Record<string, unknown>; error?: unknown }>();
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply = await rpc('tools/call', { name, arguments: args });
    return reply.result as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    };
  };
  return {
    remote,
    mac,
    macOps,
    garden,
    github,
    blobs,
    alarms,
    logs,
    relay,
    rpc,
    tool,
    tick: (ms: number) => {
      time += ms;
    },
  };
}

/** The Notebooks page's rows from a relay built again over the same storage, before any call. */
const rebuiltRows = (rebuilt: () => Relay) => rebuilt().rows();

describe('the relay over MCP', () => {
  it('introduces itself as Penmoss and lists the local tools', async () => {
    const { rpc } = await setup();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { title: 'Penmoss' },
      instructions: relayInstructions('htxryan', 'claude.ai', [
        { name: 'Personal', tag: notebookTag(NOTEBOOK.id) },
      ]),
    });
    const list = await rpc('tools/list');
    const names = (list.result!['tools'] as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search_notes', 'read_note', 'create_note']));
  });

  it('has no comment tools: they are the local MCP’s only (D50, A1064)', async () => {
    const { rpc, tool, garden } = await setup();
    const list = await rpc('tools/list');
    const names = (list.result!['tools'] as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(localTools(RELAY_ABSENT_TOOLS).map((t) => t.name));
    expect(names.filter((name) => name.includes('comment'))).toEqual([]);
    expect(
      localTools()
        .filter((t) => t.name.includes('comment'))
        .map((t) => t.name),
    ).toEqual([...COMMENT_TOOL_NAMES]);
    for (const name of COMMENT_TOOL_NAMES) {
      const called = await tool(name, { id: garden, threadId: 'x', body: 'hi' });
      expect(called.isError).toBe(true);
      expect(called.content[0]!.text).toMatch(/not available here/);
    }
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result!['capabilities']).not.toHaveProperty('experimental');
    expect(init.result!['instructions']).not.toMatch(/comment/i);
  });

  it("reads the Mac's notes, and a write reaches the Mac after the alarm", async () => {
    const { tool, garden, alarms, relay, mac, macOps, remote, tick } = await setup();
    const read = await tool('read_note', { id: garden });
    expect(read.isError).toBeFalsy();
    expect(read.content.map((c) => c.text).join('\n')).toContain('Tomatoes and basil');

    const made = await tool('create_note', {
      title: 'From claude.ai',
      markdown: 'Hello from the web',
    });
    expect(made.isError).toBeFalsy();
    const id = made.structuredContent!['id'] as string;
    expect(alarms.at(-1)).toBeGreaterThan(Date.UTC(2026, 10, 4, 9, 0, 0));

    tick(PUSH_AFTER_MS);
    await relay.alarm();
    await mac.sync();
    expect(readTitle(macOps.requireNote(id))).toBe('From claude.ai');
    // The commit names the relay's writer as an agent.
    const head = remote.branches.get('main')!;
    const writers = remote
      .history('main')
      .map((c) => commitWriter(c.message))
      .filter(Boolean);
    expect(writers.some((w) => w!.kind === 'agent' && w!.label === 'claude.ai')).toBe(true);
    expect(head).toBeTruthy();
  });

  it('pulls before a read once the last sync is old', async () => {
    const { tool, macOps, mac, tick } = await setup();
    await tool('list_recent', {});
    const later = macOps.createNote({ title: 'Typed on the Mac', markdown: 'later' });
    await mac.sync();
    // Within the window the copy answers as it is.
    const soon = await tool('read_note', { id: later });
    expect(soon.isError).toBe(true);
    tick(PULL_AFTER_MS);
    const after = await tool('read_note', { id: later });
    expect(after.isError).toBeFalsy();
  });

  it('syncs a public repository like any other (D61)', async () => {
    const { tool, remote, mac, macOps } = await setup({ private: false });
    const before = remote.branches.get('main');
    const read = await tool('list_recent', {});
    expect(read.isError).toBeFalsy();
    expect(JSON.stringify(read.structuredContent)).toContain('Garden plan');
    const created = await tool('create_note', {
      title: 'From claude.ai',
      markdown: 'public is fine',
    });
    const id = created.structuredContent!['id'] as string;
    // save_version pushes at once, past the same checks as any sync.
    expect((await tool('save_version', { id })).isError).toBeFalsy();
    expect(remote.branches.get('main')).not.toBe(before);
    await mac.sync();
    expect(readTitle(macOps.requireNote(id))).toBe('From claude.ai');
  });

  it('keeps what it wrote across a restart, and pushes it then', async () => {
    const { tool, blobs, github, mac, macOps, tick } = await setup();
    const made = await tool('create_note', { title: 'Before the restart', markdown: 'kept' });
    const id = made.structuredContent!['id'] as string;
    // A new Durable Object instance on the same storage: the edit is there, and the alarm pushes it.
    const again = new Relay(
      config(),
      { blobs, scheduleSync: () => Promise.resolve(), log: () => undefined },
      { fetch: github.fetch, clock: () => Date.UTC(2026, 10, 4, 9, 1, 0) },
    );
    tick(60_000);
    await again.alarm();
    await mac.sync();
    expect(readTitle(macOps.requireNote(id))).toBe('Before the restart');
    const snapshot = await new BlobStorage(new PrefixedBlobs(blobs, COPY)).load();
    expect(snapshot?.notes.has(id)).toBe(true);
  });

  it('starts again from the repository when its history is replaced (an import)', async () => {
    const { tool, remote, logs, tick } = await setup();
    expect((await tool('list_recent', {})).isError).toBeFalsy();
    // An import writes a new notebook as a new history and points the branch at it.
    const imported = await GitNotebookEngine.open({
      transport: new MemoryTransport({ remote, branch: 'import', root: 'notes/' }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Export' },
      create: { id: '01JBNOTEBOOK00000000000002', name: 'Personal' },
    });
    const kept = new NotebookOps(imported).createNote({ title: 'Imported', markdown: 'kept' });
    await imported.sync();
    remote.branches.set('main', remote.branches.get('import')!);
    tick(PULL_AFTER_MS);
    const read = await tool('read_note', { id: kept });
    expect(read.isError).toBeFalsy();
    expect(read.content.map((c) => c.text).join('\n')).toContain('kept');
    expect(logs.some((line) => line.includes('Starting again from the repository'))).toBe(true);
  });

  it('starts again from the repository when its settings name another writer', async () => {
    const { blobs, github } = await setup();
    const copy = new PrefixedBlobs(blobs, COPY);
    copy.put('config', new TextEncoder().encode(`${FAKE_REPO}#main:notes/:someone-else`));
    copy.put('note:01JBSTALE0000000000000000A', new Uint8Array([1]));
    const relay = new Relay(
      config(),
      { blobs, scheduleSync: () => Promise.resolve(), log: () => undefined },
      { fetch: github.fetch },
    );
    await call(relay, 'list_recent', {});
    expect(copy.get('note:01JBSTALE0000000000000000A')).toBeNull();
  });

  it('keeps the one copy it held before it served several notebooks, edits and all', async () => {
    const { tool, blobs, github, mac, macOps, tick } = await setup();
    const made = await tool('create_note', { title: 'Not pushed yet', markdown: 'kept' });
    const id = made.structuredContent!['id'] as string;
    // The copy as the relay stored it before PEN-192: its keys at the top.
    const copy = new PrefixedBlobs(blobs, COPY);
    for (const key of copy.keys('')) {
      blobs.put(key, copy.get(key)!);
      blobs.delete(`${COPY}${key}`);
    }
    const logs: string[] = [];
    const again = new Relay(
      config(),
      { blobs, scheduleSync: () => Promise.resolve(), log: (text) => logs.push(text) },
      { fetch: github.fetch, clock: () => Date.UTC(2026, 10, 4, 9, 1, 0) },
    );
    expect(blobs.keys('note:')).toEqual([]);
    expect(blobs.get('config')).toBeNull();
    expect(logs.some((line) => line.includes('moved the stored copy'))).toBe(true);
    tick(60_000);
    await again.alarm();
    await mac.sync();
    expect(readTitle(macOps.requireNote(id))).toBe('Not pushed yet');
  });

  it('drops a stored copy of a notebook it no longer serves', async () => {
    const { blobs, github } = await setup();
    blobs.put('config', new TextEncoder().encode('someone/else#main::claude.ai'));
    blobs.put('note:01JBSTALE0000000000000000A', new Uint8Array([1]));
    const relay = new Relay(
      config(),
      { blobs, scheduleSync: () => Promise.resolve(), log: () => undefined },
      { fetch: github.fetch },
    );
    await call(relay, 'list_recent', {});
    expect(blobs.get('note:01JBSTALE0000000000000000A')).toBeNull();
    expect(blobs.get('config')).toBeNull();
  });
});

describe('MCP over HTTP', () => {
  it('answers notifications with 202, other methods with 405, bad JSON with 400, and batches', async () => {
    const { relay } = await setup();
    const post = (body: string) =>
      relay.handle(new Request('https://x/mcp', { method: 'POST', body }));
    expect(
      (await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status,
    ).toBe(202);
    expect((await relay.handle(new Request('https://x/mcp'))).status).toBe(405);
    expect((await post('{nope')).status).toBe(400);
    const batch = await post(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ]),
    );
    expect(await batch.json()).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });
});

describe('several notebooks in one relay (PEN-192)', () => {
  const PERSONAL = { id: '01JBNOTEBOOK00000000000001', name: 'Personal' };
  const QUANTA = { id: '01JBNOTEBOOK0000000000000Q', name: 'Quanta' };
  const WORK_REPO = 'quanta/scratch';

  async function notebookOn(
    remote: MemoryRemote,
    branch: string,
    root: string,
    create: { id: string; name: string },
    clock: () => number,
  ) {
    const mac = await GitNotebookEngine.open({
      transport: new MemoryTransport({ remote, branch, root, clock }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Mac' },
      create,
      clock,
    });
    return { mac, ops: new NotebookOps(mac, clock) };
  }

  async function two(
    options: {
      names?: [string, string];
      app?: boolean;
      /** Quanta's id and name kept as it was added, as the Notebooks page keeps them. */
      kept?: boolean;
      env?: Record<string, string>;
    } = {},
  ) {
    let time = Date.UTC(2026, 10, 26, 9, 0, 0);
    const clock = () => time;
    const personalRemote = new MemoryRemote();
    const quantaRemote = new MemoryRemote();
    const personal = await notebookOn(
      personalRemote,
      'main',
      '',
      { ...PERSONAL, name: options.names?.[0] ?? PERSONAL.name },
      clock,
    );
    const quanta = await notebookOn(
      quantaRemote,
      'dev',
      'penmoss/',
      { ...QUANTA, name: options.names?.[1] ?? QUANTA.name },
      clock,
    );
    const garden = personal.ops.createNote({ title: 'Garden plan', markdown: 'Tomatoes #garden' });
    const roadmap = quanta.ops.createNote({ title: 'Roadmap', markdown: 'Tomatoes ship #work' });
    const quantaFolder = quanta.ops.createFolder({ name: 'Projects', parentId: null });
    await personal.mac.sync();
    await quanta.mac.sync();

    const personalGitHub = fakeGitHub(personalRemote, { repository: FAKE_REPO, token: 'ghs_app' });
    const quantaGitHub = fakeGitHub(quantaRemote, { repository: WORK_REPO, token: 'github_pat_q' });
    const calls: string[] = [];
    const down = new Set<string>();
    /** Repositories GitHub is slow to answer for: each call waits until `release()`. */
    const stalled = new Set<string>();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url);
      for (const repository of stalled) {
        if (url.pathname.startsWith(`/repos/${repository}`)) {
          return held.then(() => fetcher(input, init));
        }
      }
      return fetcher(input, init);
    };
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url);
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === `/repos/${FAKE_REPO}/installation`) {
        return Promise.resolve(Response.json({ id: 41 }));
      }
      if (url.pathname.endsWith('/installation')) {
        return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }));
      }
      if (url.pathname === '/app/installations/41/access_tokens') {
        return Promise.resolve(
          Response.json(
            { token: 'ghs_app', expires_at: new Date(time + 3_600_000).toISOString() },
            { status: 201 },
          ),
        );
      }
      for (const repository of down) {
        if (url.pathname.startsWith(`/repos/${repository}`)) {
          return Promise.resolve(Response.json({ message: 'Server Error' }, { status: 500 }));
        }
      }
      if (url.pathname.startsWith(`/repos/${WORK_REPO}`)) return quantaGitHub.fetch(input, init);
      return personalGitHub.fetch(input, init);
    }) as typeof fetch;

    const read = readConfig(
      { OWNER_GITHUB_LOGIN: 'htxryan', GITHUB_API: FAKE_API, ...options.env },
      { appId: '1', privateKey: APP_KEY },
      [
        {
          repository: FAKE_REPO,
          branch: 'main',
          root: '',
          access: options.app === false ? { kind: 'token', token: 'ghs_app' } : { kind: 'app' },
        },
        {
          repository: WORK_REPO,
          branch: 'dev',
          root: 'penmoss/',
          access: { kind: 'token', token: 'github_pat_q' },
          ...(options.kept ? { id: QUANTA.id, name: QUANTA.name } : {}),
        },
      ],
    );
    if ('problem' in read) throw new Error(read.problem);
    const blobs = new MemoryBlobs();
    const alarms: number[] = [];
    const logs: string[] = [];
    const relay = new Relay(
      read,
      {
        blobs,
        scheduleSync: (at) => {
          alarms.push(at);
          return Promise.resolve();
        },
        log: (text) => logs.push(text),
      },
      { fetch: answer, clock },
    );
    let id = 0;
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await relay.handle(
        new Request('https://mcp.penmoss.test/mcp', {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        }),
      );
      return response.json<{ result?: Record<string, unknown> }>();
    };
    const tool = (name: string, args: Record<string, unknown>) => call(relay, name, args);
    /** The relay as the Durable Object builds it again: a new notebook list, or after eviction. */
    const rebuilt = () =>
      new Relay(
        read,
        { blobs, scheduleSync: () => Promise.resolve(), log: (text) => logs.push(text) },
        { fetch: fetcher, clock },
      );
    return {
      relay,
      rebuilt,
      rpc,
      tool,
      blobs,
      alarms,
      logs,
      calls,
      down,
      stalled,
      release,
      personal,
      quanta,
      personalRemote,
      quantaRemote,
      garden,
      roadmap,
      quantaFolder,
      tick: (ms: number) => {
        time += ms;
      },
    };
  }

  const PERSONAL_COPY = `copy:${FAKE_REPO}#main:/`;
  const QUANTA_COPY = `copy:${WORK_REPO}#dev:penmoss//`;
  const notebooksOf = (items: unknown) =>
    (items as { notebook: string }[]).map((each) => each.notebook).sort();

  it('searches, lists and tags across both, each result naming its notebook', async () => {
    const { tool } = await two();
    const search = await tool('search_notes', { query: 'Tomatoes' });
    expect(search.isError).toBeFalsy();
    expect(notebooksOf(search.structuredContent!['results'])).toEqual(['Personal', 'Quanta']);
    const recent = await tool('list_recent', {});
    expect(notebooksOf(recent.structuredContent!['notes'])).toEqual(['Personal', 'Quanta']);
    const tags = await tool('list_tags', {});
    expect(tags.structuredContent!['tags']).toEqual([
      expect.objectContaining({ name: 'garden', notebooks: ['Personal'] }),
      expect.objectContaining({ name: 'work', notebooks: ['Quanta'] }),
    ]);
  });

  it('reaches a note by its short id or its full id in its own notebook', async () => {
    const { tool, roadmap, garden } = await two();
    const short = shortNoteRef(QUANTA.id, roadmap);
    const byShort = await tool('read_note', { id: short });
    expect(byShort.isError).toBeFalsy();
    expect(byShort.structuredContent).toMatchObject({ notebook: 'Quanta', id: roadmap });
    const byId = await tool('read_note', { id: garden });
    expect(byId.structuredContent).toMatchObject({ notebook: 'Personal', id: garden });
  });

  it('refuses a write that names no note or notebook, naming both notebooks', async () => {
    const { tool } = await two();
    const made = await tool('create_note', { title: 'Where?', markdown: 'x' });
    expect(made.isError).toBe(true);
    expect(made.content[0]!.text).toMatch(/needs notebook/);
    expect(made.content[0]!.text).toMatch(/“Personal”.*“Quanta”/);
    const there = await tool('create_note', { title: 'Here', markdown: 'x', notebook: 'Quanta' });
    expect(there.structuredContent).toMatchObject({ notebook: 'Quanta' });
  });

  it('refuses to move a note into the other notebook’s folder', async () => {
    const { tool, garden, quantaFolder } = await two();
    const moved = await tool('move_note', { id: garden, folderId: quantaFolder });
    expect(moved.isError).toBe(true);
    expect(moved.content[0]!.text).toMatch(/cross_notebook/);
  });

  it('pushes each notebook on its own timing, and one failing leaves the other serving', async () => {
    const { tool, relay, tick, down, personalRemote, quantaRemote, logs, alarms } = await two();
    const personalHead = personalRemote.branches.get('main');
    const quantaHead = quantaRemote.branches.get('dev');
    await tool('create_note', { title: 'Quanta only', markdown: 'x', notebook: 'Quanta' });
    tick(PUSH_AFTER_MS);
    await relay.alarm();
    expect(quantaRemote.branches.get('dev')).not.toBe(quantaHead);
    // Personal had nothing to push, so nothing was pushed there.
    expect(personalRemote.branches.get('main')).toBe(personalHead);

    // Quanta's GitHub goes down: Personal keeps serving, and pushes on its own.
    down.add(WORK_REPO);
    tick(PULL_AFTER_MS);
    const recent = await tool('list_recent', {});
    expect(recent.isError).toBeFalsy();
    expect(notebooksOf(recent.structuredContent!['notes'])).toContain('Personal');
    await tool('create_note', { title: 'Personal still', markdown: 'x', notebook: 'Personal' });
    await tool('create_note', { title: 'Quanta waits', markdown: 'x', notebook: 'Quanta' });
    tick(PUSH_AFTER_MS);
    await relay.alarm();
    expect(personalRemote.branches.get('main')).not.toBe(personalHead);
    expect(logs.some((line) => line.includes(`${WORK_REPO}: push failed`))).toBe(true);
    // Quanta tries again in a minute; that is the next alarm.
    const retry = alarms.at(-1)!;
    down.delete(WORK_REPO);
    tick(retry - Date.UTC(2026, 10, 26, 9, 0, 0) - 2 * PUSH_AFTER_MS - PULL_AFTER_MS);
    await relay.alarm();
    const titles = [...quantaRemote.branches.keys()];
    expect(titles).toContain('dev');
    expect(quantaRemote.branches.get('dev')).not.toBe(quantaHead);
  });

  it('serves the other notebook when one never synced, and names that one by its repository', async () => {
    const { tool, down, calls, tick } = await two();
    down.add(WORK_REPO);
    const recent = await tool('list_recent', {});
    expect(recent.isError).toBeFalsy();
    expect(notebooksOf(recent.structuredContent!['notes'])).toEqual(['Personal']);
    expect(recent.structuredContent!['skipped']).toEqual([
      { notebook: WORK_REPO, reason: expect.stringMatching(/500/) as string },
    ]);
    // Its first sync is tried again once a pull's interval has passed, not on every call.
    const tried = calls.filter((each) => each.includes(WORK_REPO)).length;
    const soon = await tool('list_recent', {});
    expect(soon.structuredContent!['skipped']).toEqual([
      { notebook: WORK_REPO, reason: expect.stringMatching(/500/) as string },
    ]);
    expect(calls.filter((each) => each.includes(WORK_REPO)).length).toBe(tried);
    tick(PULL_AFTER_MS);
    down.delete(WORK_REPO);
    const again = await tool('list_recent', {});
    expect(notebooksOf(again.structuredContent!['notes'])).toEqual(['Personal', 'Quanta']);
    expect(calls.filter((each) => each.includes(WORK_REPO)).length).toBeGreaterThan(tried);
  });

  it('starts one notebook again when its repository was replaced, leaving the other', async () => {
    const { tool, blobs, quantaRemote, tick, logs } = await two();
    await tool('list_recent', {});
    const personalKeys = blobs.keys(PERSONAL_COPY).map((key) => [key, blobs.get(key)] as const);
    const imported = await GitNotebookEngine.open({
      transport: new MemoryTransport({ remote: quantaRemote, branch: 'import', root: 'penmoss/' }),
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Export' },
      create: { id: '01JBNOTEBOOK0000000000000R', name: 'Quanta' },
    });
    const kept = new NotebookOps(imported).createNote({ title: 'Imported', markdown: 'kept' });
    await imported.sync();
    quantaRemote.branches.set('dev', quantaRemote.branches.get('import')!);
    tick(PULL_AFTER_MS);
    const read = await tool('read_note', { id: kept });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({ notebook: 'Quanta' });
    expect(
      logs.some((line) => line.includes(`${WORK_REPO}: `) && line.includes('Starting again')),
    ).toBe(true);
    // Personal's copy is as it was (its sync this time wrote only its bookkeeping).
    const after = new Map(blobs.keys(PERSONAL_COPY).map((key) => [key, blobs.get(key)]));
    for (const [key, bytes] of personalKeys) {
      if (key.endsWith('/meta') || key.endsWith('/synced-at')) continue;
      expect(after.get(key)).toEqual(bytes);
    }
    expect(blobs.keys(QUANTA_COPY).length).toBeGreaterThan(0);
  });

  it('pushes a notebook’s edits before it is removed, and refuses while they can’t be', async () => {
    const { tool, relay, down, quantaRemote } = await two();
    const head = quantaRemote.branches.get('dev');
    await tool('create_note', { title: 'Unpushed', markdown: 'x', notebook: 'Quanta' });
    down.add(WORK_REPO);
    await expect(relay.flush(`${WORK_REPO}#dev:penmoss/`)).rejects.toThrow();
    down.delete(WORK_REPO);
    await relay.flush(`${WORK_REPO}#dev:penmoss/`);
    expect(quantaRemote.branches.get('dev')).not.toBe(head);
    const rows = await relay.rows();
    expect(rows.find((row) => row.name === 'Quanta')).toMatchObject({
      access: 'token',
      tokenEnd: 'at_q'.slice(-4),
      problem: null,
    });
    expect(rows.find((row) => row.name === 'Quanta')!.syncedAt).toBeGreaterThan(0);
  });

  it('keeps when each notebook last synced across a rebuilt relay', async () => {
    const { tool, rebuilt } = await two();
    await tool('list_recent', {});
    const before = await rebuiltRows(rebuilt);
    expect(before.every((row) => typeof row.syncedAt === 'number' && row.syncedAt > 0)).toBe(true);
  });

  it('lists the notebooks at once, a first sync still running, as Setting Up asks', async () => {
    const { relay, stalled, release } = await two({ kept: true });
    stalled.add(WORK_REPO);
    const first = await relay.rows();
    expect(first.find((row) => row.repository === WORK_REPO)).toMatchObject({
      name: QUANTA.name,
      id: QUANTA.id,
      syncedAt: null,
      problem: null,
    });
    release();
    await vi.waitFor(async () => {
      const rows = await relay.rows();
      expect(rows.every((row) => typeof row.syncedAt === 'number' && row.syncedAt > 0)).toBe(true);
    });
  });

  it('names each notebook from its notebook.json, adding its repository on a clash', async () => {
    const { rpc } = await two({ names: ['Personal', 'Personal'] });
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    const instructions = String(init.result!['instructions']);
    expect(instructions).toContain(
      `Personal (${FAKE_REPO}) (short ids ${notebookTag(PERSONAL.id)}-…), Personal (${WORK_REPO}) (short ids ${notebookTag(QUANTA.id)}-…)`,
    );
  });

  it('finds the App’s installation for each repository, and never uses it for a token', async () => {
    const { tool, calls } = await two();
    await tool('list_recent', {});
    expect(calls).toContain(`GET /repos/${FAKE_REPO}/installation`);
    expect(calls).toContain('POST /app/installations/41/access_tokens');
    expect(calls.filter((each) => each.includes(`/repos/${WORK_REPO}/installation`))).toEqual([]);
  });

  it('tells claude.ai whose notebooks these are, and which', async () => {
    const { rpc } = await two();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    const instructions = String(init.result!['instructions']);
    expect(instructions).toMatch(
      /^These are the Penmoss notebooks of the user \(htxryan on GitHub\)/,
    );
    expect(instructions).toContain(
      `Personal (short ids ${notebookTag(PERSONAL.id)}-…), Quanta (short ids ${notebookTag(QUANTA.id)}-…)`,
    );
    expect(instructions).not.toMatch(/Ryan/);
  });
});
