/**
 * Search by meaning from the CLI (T75): `penmoss models`, `search` with and without the model,
 * and `penmoss mcp` indexing in the background while it holds the lease. The model is a fake
 * `MeaningIo` over core's fake embedder; the notebook's host is in memory (A1516).
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryVectorCache, fakeEmbedder } from '@penmoss/core/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io, MeaningIo, MeaningStatus } from '../src/io';
import { run } from '../src/main';
import { memoryTokenStore } from '../src/memory-store';
import { nodeNotebooks } from '../src/node-notebooks';
import { GIT_ENV, MemoryHosts, testRoot } from './support/machine';

const temp = testRoot('penmoss-meaning-');
/** The notebook's host, in memory (A1516): what is tested here is the CLI's, not git's. */
let hosts: MemoryHosts;
beforeEach(() => {
  hosts = new MemoryHosts();
});

/** The model as a test controls it: here or not, on or off, the lease free or taken. */
function fakeMeaning(initial: { state?: MeaningStatus['state']; leaseFree?: boolean } = {}) {
  const embedder = fakeEmbedder();
  const claims: Array<{ owner: string; keys: Set<string> }> = [];
  const cache = Object.assign(new MemoryVectorCache(), {
    compact: () => Promise.resolve(0),
    claim: (owner: string, keys: ReadonlySet<string>) => {
      claims.push({ owner, keys: new Set(keys) });
      return Promise.resolve();
    },
  });
  const control = {
    state: initial.state ?? 'ready',
    enabled: true,
    leaseFree: initial.leaseFree ?? true,
    /** Whether the lease taken last is still this process's (the app can take it, A1350). */
    leaseHeld: false,
    takes: 0,
    opened: 0,
    closed: 0,
    embedded: 0,
    /** Each claim on the vectors a notebook uses (PEN-134). */
    claims,
  };
  const status = (): Promise<MeaningStatus> =>
    Promise.resolve({
      enabled: control.enabled,
      state: control.state,
      bytes: control.state === 'ready' ? 1_000_000 : 0,
      totalBytes: 1_000_000,
      model: embedder.model,
      repository: 'onnx-community/test',
      revision: '0123456789abcdef',
      dir: join(temp.path, 'models', 'test'),
      license: { name: 'Test terms', url: 'https://example.invalid/terms' },
    });
  const meaning: MeaningIo = {
    status,
    fetch: async (onProgress) => {
      onProgress?.(500_000, 1_000_000);
      onProgress?.(1_000_000, 1_000_000);
      control.state = 'ready';
      return status();
    },
    remove: () => {
      control.state = 'absent';
      return Promise.resolve();
    },
    open: () => {
      if (control.state !== 'ready' || !control.enabled) return Promise.resolve(null);
      control.opened++;
      return Promise.resolve({
        embedder: {
          ...embedder,
          embedQuery: (text: string) => embedder.embedQuery(text),
          embedDocuments: (texts: readonly string[]) => {
            control.embedded += texts.length;
            return embedder.embedDocuments(texts);
          },
        },
        cache,
        lease: () => {
          control.takes++;
          if (!control.leaseFree) return Promise.resolve(undefined);
          control.leaseHeld = true;
          return Promise.resolve({
            held: () => Promise.resolve(control.leaseHeld),
            release: () => Promise.resolve(),
          });
        },
        close: () => {
          control.closed++;
          return Promise.resolve();
        },
      });
    },
  };
  return { meaning, control };
}

function machine(meaning: MeaningIo | undefined, indexEveryMs = 20, leaseRetryMs = 60_000) {
  const notebooks = nodeNotebooks({
    home: join(temp.path, 'home'),
    env: {},
    platform: process.platform,
    secrets: memoryTokenStore(),
    gitEnv: GIT_ENV,
    transport: hosts.transport,
    pushDelayMs: 50,
    pullEveryMs: 60_000,
    lockWaitMs: 300,
    indexEveryMs,
    leaseRetryMs,
    ...(meaning ? { meaning } : {}),
  });
  /** stdin's lines; a function runs between two (it waits for something, or changes it). */
  return async (argv: string[], lines: Array<string | (() => void | Promise<void>)> = []) => {
    let stdout = '';
    let stderr = '';
    const io: Io = {
      env: {},
      stdin: { isTTY: false, read: () => Promise.resolve('') },
      stdout: { isTTY: false, write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
      openUrl: () => Promise.resolve(false),
      readFile: (path) => Promise.resolve(new Uint8Array(readFileSync(path))),
      fileSize: (path) => Promise.resolve(statSync(path).size),
      stdio: {
        lines: async function* () {
          for (const line of lines) {
            if (typeof line === 'function') await line();
            else yield line;
          }
        },
      },
      notebooks,
      ...(meaning ? { meaning } : {}),
    };
    const code = await run(argv, io);
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
  };
}

/**
 * A line that waits until `check` holds: what the server does in the background, seen. The
 * server reads past a line that throws, so a wait that ran out fails the test after it.
 */
const missed: string[] = [];
afterEach(() => {
  const late = missed.splice(0);
  expect(late, 'what a line waited for never happened').toEqual([]);
});
const until = (check: () => boolean) => () =>
  vi
    .waitFor(() => expect(check()).toBe(true), { timeout: 10_000, interval: 5 })
    .catch(() => void missed.push(check.toString()));

async function withNotes(cli: ReturnType<typeof machine>) {
  expect((await cli(['notebook', 'add', hosts.url('nb'), '--name', 'nb'])).code).toBe(0);
  for (const [title, text] of [
    [
      'UPS shutdown',
      'When the power fails the battery keeps the rack up and the guests shut down in order.',
    ],
    ['Sourdough', 'Feed the starter flour and water every morning.'],
  ]) {
    expect((await cli(['new', title!, '--text', text!, '--no-sync'])).code).toBe(0);
  }
}

describe('penmoss models (T75)', () => {
  it('says this penmoss has none without the app', async () => {
    const cli = machine(undefined);
    const status = await cli(['models', 'status', '--json']);
    expect(status.code).toBe(1);
    expect(status.stderr).toContain('"code":"unsupported"');
    expect((await cli(['models'])).code).toBe(2);
  });

  it('reports, fetches and removes the model', async () => {
    const { meaning, control } = fakeMeaning({ state: 'absent' });
    const cli = machine(meaning);
    const before = await cli(['models', 'status']);
    expect(before.code).toBe(0);
    expect(before.stdout).toContain('Search by meaning: on');
    expect(before.stdout).toContain('not downloaded (1 MB): run penmoss models fetch');
    const fetched = await cli(['models', 'fetch']);
    expect(fetched.code).toBe(0);
    expect(fetched.stderr).toContain('Downloading the model: 50% of 1 MB');
    expect(fetched.stdout).toContain('Downloaded the model.');
    const json = await cli(['models', 'status', '--json']);
    expect(json.json()).toMatchObject({ state: 'ready', enabled: true, model: 'fake-hash-1024' });
    const removed = await cli(['models', 'remove', '--json']);
    expect(removed.json()).toMatchObject({ state: 'absent', removed: true });
    expect(control.state).toBe('absent');
    expect((await cli(['models', 'frobnicate'])).code).toBe(2);
  });
});

describe('penmoss search with meaning (T75, A1156)', () => {
  it('refuses semantic with exit 7 only without the model, and hybrid says words only', async () => {
    const { meaning, control } = fakeMeaning({ state: 'absent' });
    const cli = machine(meaning);
    await withNotes(cli);
    const semantic = await cli(['search', 'battery', '--mode', 'semantic', '--no-sync']);
    expect(semantic.code).toBe(7);
    expect(semantic.stderr).toContain('penmoss models fetch');
    const hybrid = await cli(['search', 'battery', '--no-sync', '--json']);
    expect(hybrid.json()).toMatchObject({
      mode: 'full-text',
      notice: expect.stringMatching(/words only/) as string,
    });

    control.state = 'ready';
    const found = await cli([
      'search',
      'battery rack',
      '--mode',
      'semantic',
      '--limit',
      '1',
      '--no-sync',
      '--json',
    ]);
    expect(found.code, found.stderr).toBe(0);
    expect(found.json()).toMatchObject({
      mode: 'semantic',
      results: [{ title: 'UPS shutdown', foundBy: ['semantic'] }],
    });
    const fused = await cli(['search', 'battery', '--no-sync', '--json']);
    expect(fused.json()).toMatchObject({
      mode: 'hybrid',
      results: [{ title: 'UPS shutdown', foundBy: ['full-text', 'semantic'] }],
    });
    expect(fused.json()['notice']).toBeUndefined();
    // Each one-shot search opens the model and lets it go.
    expect(control.closed).toBe(control.opened); // And claims what the notebook uses, so the app's compaction keeps it (PEN-134).
    expect(control.claims.at(-1)?.keys.size).toBe(2);
  });

  it('stays words only for full-text, without opening the model', async () => {
    const { meaning, control } = fakeMeaning();
    const cli = machine(meaning);
    await withNotes(cli);
    const words = await cli(['search', 'battery', '--mode', 'full-text', '--no-sync', '--json']);
    expect(words.json()).toMatchObject({ mode: 'full-text' });
    expect(control.opened).toBe(0);
  });
});

describe('penmoss mcp with meaning (T75, A1157)', () => {
  const rpc = (id: number, method: string, params?: unknown) =>
    JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const searchCall = (id: number, query: string) =>
    rpc(id, 'tools/call', {
      name: 'search_notes',
      arguments: { query, mode: 'semantic', limit: 1 },
    });

  it('describes meaning, indexes in the background as the holder, and answers by meaning', async () => {
    const { meaning, control } = fakeMeaning();
    const cli = machine(meaning);
    await withNotes(cli);
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      [
        rpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
        rpc(2, 'tools/list'),
        // Indexed in the background, as the holder.
        until(() => control.embedded === 2),
        searchCall(3, 'battery rack'),
      ],
    );
    const replies = served.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    expect(replies[0]!.result['instructions']).toMatch(/by their words and their meaning/);
    const tools = replies[1]!.result['tools'] as Array<{ name: string; description: string }>;
    expect(tools.find((tool) => tool.name === 'search_notes')!.description).toMatch(
      /by meaning alone/,
    );
    expect(replies[2]!.result['structuredContent']).toMatchObject({
      mode: 'semantic',
      results: [{ title: 'UPS shutdown', foundBy: ['semantic'] }],
      coverage: { indexed: 2, total: 2 },
    });
    expect(control.embedded).toBe(2);
    expect(control.closed).toBe(1);
  });

  it('indexes an agent’s edit a moment after it, as the holder', async () => {
    const { meaning, control } = fakeMeaning();
    // The background pass is an hour away: only the edit itself can bring the new note in.
    const cli = machine(meaning, 60 * 60_000);
    await withNotes(cli);
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      [
        // The first pass, at start.
        until(() => control.embedded === 2),
        rpc(1, 'tools/call', {
          name: 'create_note',
          arguments: { title: 'Generator', markdown: 'A diesel generator behind the shed.' },
        }),
        until(() => control.embedded === 3),
        searchCall(2, 'battery rack'),
      ],
    );
    const replies = served.stdout
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { result: { structuredContent: Record<string, unknown> } },
      );
    expect(replies[1]!.result.structuredContent).toMatchObject({
      coverage: { indexed: 3, total: 3 },
    });
  });

  it('without the lease, embeds only within its small budget', async () => {
    const { meaning, control } = fakeMeaning({ leaseFree: false });
    const cli = machine(meaning);
    await withNotes(cli);
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      // The model is open and the lease asked for (and refused).
      [until(() => control.takes > 0), searchCall(1, 'battery rack')],
    );
    const reply = JSON.parse(served.stdout.trim()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(reply.result.structuredContent).toMatchObject({
      mode: 'semantic',
      coverage: { total: 2 },
    });
  });

  it('claims every chunk its notes use, without the lease and before they are embedded (PEN-134)', async () => {
    const { meaning, control } = fakeMeaning({ leaseFree: false });
    const cli = machine(meaning);
    await withNotes(cli);
    await cli(['mcp', '--notebook', 'nb'], [until(() => control.claims.at(-1)?.keys.size === 2)]);
    expect(control.embedded).toBe(0);
    const last = control.claims.at(-1)!;
    // One chunk for each of the two notes: the app's compaction keeps both.
    expect(last.keys.size).toBe(2);
    // A one-shot search renews the same claim, not a second one.
    await cli(['search', 'battery', '--mode', 'semantic', '--no-sync']);
    expect(control.claims.at(-1)!.owner).toBe(last.owner);
  });

  it('keeps trying for the lease, and indexes once the holder is gone (A1350)', async () => {
    const { meaning, control } = fakeMeaning({ leaseFree: false });
    const cli = machine(meaning, 20, 20);
    await withNotes(cli);
    let before = -1;
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      [
        until(() => control.takes > 2),
        () => {
          // The app holds the lease: nothing indexed in the background, and still trying.
          before = control.embedded;
          control.leaseFree = true;
        },
        until(() => control.embedded === 2),
        rpc(1, 'tools/list'),
      ],
    );
    expect(before).toBe(0);
    expect(control.takes).toBeGreaterThan(2);
    // Indexed in the background as the new holder, without a search asking.
    expect(control.embedded).toBe(2);
    expect(served.stderr).toMatch(/indexing nb for meaning/);
  });

  it('stops indexing once the app takes the lease (A1350)', async () => {
    const { meaning, control } = fakeMeaning();
    const cli = machine(meaning, 20, 20);
    await withNotes(cli);
    let taken = 0;
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      [
        until(() => control.embedded === 2),
        () => {
          taken = control.takes;
          control.leaseHeld = false;
          control.leaseFree = false;
        },
        // It asks for the lease again: it heard it lost it.
        until(() => control.takes > taken),
        rpc(1, 'tools/list'),
      ],
    );
    expect(served.stderr).toMatch(/another process indexes for meaning now/);
  });

  it('falls back to words once Search by Meaning is switched off (A1158)', async () => {
    const { meaning, control } = fakeMeaning();
    const cli = machine(meaning);
    await withNotes(cli);
    const hybrid = (id: number) =>
      rpc(id, 'tools/call', { name: 'search_notes', arguments: { query: 'battery' } });
    const served = await cli(
      ['mcp', '--notebook', 'nb'],
      [
        until(() => control.embedded === 2),
        searchCall(1, 'battery rack'),
        () => {
          control.enabled = false;
        },
        searchCall(2, 'battery rack'),
        hybrid(3),
      ],
    );
    const replies = served.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { result: Record<string, unknown> });
    expect(replies[0]!.result['structuredContent']).toMatchObject({ mode: 'semantic' });
    expect(replies[1]!.result['isError']).toBe(true);
    expect(JSON.stringify(replies[1]!.result['content'])).toMatch(/not set up here/);
    expect(replies[2]!.result['structuredContent']).toMatchObject({
      mode: 'full-text',
      results: [{ title: 'UPS shutdown' }],
    });
    expect(control.closed).toBe(1);
    expect(served.stderr).toMatch(/Search by Meaning is off/);
  });

  it('keeps the words-only tools without the model', async () => {
    const { meaning } = fakeMeaning({ state: 'absent' });
    const cli = machine(meaning);
    await withNotes(cli);
    const served = await cli(['mcp', '--notebook', 'nb'], [rpc(1, 'tools/list')]);
    const tools = (
      JSON.parse(served.stdout.trim()) as {
        result: { tools: Array<{ name: string; description: string }> };
      }
    ).result.tools;
    expect(tools.find((tool) => tool.name === 'search_notes')!.description).toMatch(
      /no meaning search/,
    );
  });
});
