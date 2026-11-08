/**
 * The relay's notebook (T55) in Node, against a fake GitHub over an in-memory remote: MCP over
 * HTTP in front of the local tools, a Mac over git as the other writer, pulls before reads,
 * pushes on the alarm, and a public repository refused (A841).
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
import { COMMENT_TOOL_NAMES } from '@penmoss/core/mcp';
import { localTools, RELAY_ABSENT_TOOLS } from '@penmoss/git-notebook/local';
import { readTitle } from '@penmoss/sync-client/note';
import { describe, expect, it } from 'vitest';
import {
  FAKE_API,
  FAKE_REPO,
  FAKE_TOKEN,
  fakeGitHub,
} from '../../../packages/git-notebook/test/support/fake-github';
import { readConfig, type RelayConfig } from '../src/config';
import { PULL_AFTER_MS, PUSH_AFTER_MS, Relay, RELAY_INSTRUCTIONS } from '../src/relay';
import { BlobStorage, MemoryBlobs } from '../src/storage';

const NOTEBOOK = { id: '01JBNOTEBOOK00000000000001', name: 'Personal' };

function config(overrides: Partial<Record<string, string>> = {}): RelayConfig {
  const read = readConfig({
    NOTES_REPOSITORY: FAKE_REPO,
    NOTES_DIR: 'notes',
    ALLOWED_GITHUB_LOGIN: 'htxryan',
    GITHUB_TOKEN: FAKE_TOKEN,
    GITHUB_API: FAKE_API,
    ...overrides,
  });
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

describe('the relay over MCP', () => {
  it('introduces itself as Penmoss and lists the local tools', async () => {
    const { rpc } = await setup();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { title: 'Penmoss' },
      instructions: RELAY_INSTRUCTIONS,
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
    expect(RELAY_INSTRUCTIONS).not.toMatch(/comment/i);
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

  it('never syncs a public repository', async () => {
    const { tool, remote } = await setup({ private: false });
    const before = remote.branches.get('main');
    const read = await tool('list_recent', {});
    expect(read.isError).toBe(true);
    expect(read.content[0]!.text).toMatch(/public/);
    expect(remote.branches.get('main')).toBe(before);
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
    const snapshot = await new BlobStorage(blobs).load();
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

  it('starts again from the repository when its settings name another notebook', async () => {
    const { blobs, github } = await setup();
    blobs.put('config', new TextEncoder().encode('someone/else#main::claude.ai'));
    blobs.put('note:01JBSTALE0000000000000000A', new Uint8Array([1]));
    const relay = new Relay(
      config(),
      { blobs, scheduleSync: () => Promise.resolve(), log: () => undefined },
      { fetch: github.fetch },
    );
    await relay.handle(
      new Request('https://x/mcp', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_recent', arguments: {} },
        }),
      }),
    );
    expect(blobs.get('note:01JBSTALE0000000000000000A')).toBeNull();
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
