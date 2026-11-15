/**
 * `penmoss mcp --notebook` over system git (T50 G2, A1050): what it leaves to a detached sync
 * when it is stopped or its stdin closes, a repository that is away and back, and the identity
 * it commits as while it runs. Its tools, names and channel are `notebook-commands.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bare as bareAt,
  git,
  HANDSHAKE,
  machine as machineAt,
  rpc,
  SERVER_PUSH_DELAY_MS,
  testRoot,
} from './support/machine';

// Each test runs many git processes; the Mac CI runners take over 5 s for the longest.
vi.setConfig({ testTimeout: 60_000 });

const root = testRoot('penmoss-nb-');
const machine = (name: string, extra?: Parameters<typeof machineAt>[2]) =>
  machineAt(root.path, name, extra);
const bare = (name: string) => bareAt(root.path, name);

describe('penmoss mcp --notebook over system git', () => {
  it('leaves the push to a detached sync when its client stops it with a signal', async () => {
    const remote = bare('mcp-signal');
    // The edit is not pushed before the signal: with a 50 ms push delay, a loaded machine could
    // take longer than that between the reply and the signal, and the server pushed it itself.
    const cli = machine('m', { pushDelayMs: SERVER_PUSH_DELAY_MS });
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'ryan']);
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb', '--agent', 'Claude Code']);
    const call = (id: number, name: string, args: unknown) =>
      rpc(id, 'tools/call', { name, arguments: args });
    const initialize = rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'c', version: '1' },
    });
    const before = git(remote, ['rev-parse', 'main']);

    // Only reads: nothing to push, so nothing is left behind.
    const reading: string[][] = [];
    const read = await cli(['mcp', '--notebook', 'nb'], {
      lines: [initialize, call(2, 'list_recent', {})],
      signal: 'SIGTERM',
      detached: reading,
    });
    expect(read.code).toBe(0);
    expect(reading).toEqual([]);

    const detached: string[][] = [];
    const served = await cli(['mcp', '--notebook', 'nb'], {
      lines: [initialize, call(2, 'create_note', { title: 'Before the kill', markdown: 'Saved' })],
      signal: 'SIGINT',
      detached,
    });
    expect(served.code).toBe(0);
    expect(served.stdout).toContain('"created":true');
    expect(served.stderr).toContain('stopped by SIGINT: syncing nb in the background');
    expect(detached).toEqual([['notebook', 'sync', 'nb', '--wait', '120']]);
    expect(git(remote, ['rev-parse', 'main'])).toBe(before);

    // The detached process, as it runs once the server is gone.
    const synced = await cli(detached[0]!);
    expect(synced.code).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Before the kill.md');
    expect(git(remote, ['log', '-1', '--format=%an', 'main'])).toBe('Claude Code');
    expect((await cli(['notebook', 'sync', 'nb', '--wait', '-1'])).code).toBe(2);
  });

  it('syncs at start, and hands what is left to a detached sync when stdin closes', async () => {
    const remote = bare('mcp-start');
    const desk = machine('desk');
    // As above: the edit is not pushed before stdin closes.
    const agent = machine('agent', { pushDelayMs: SERVER_PUSH_DELAY_MS });
    await desk(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    await agent(['notebook', 'add', `file://${remote}`, '--name', 'ryan']);
    await agent(['notebook', 'add', `file://${remote}`, '--name', 'nb', '--agent', 'Claude Code']);
    expect((await desk(['new', 'From the desk', '--notebook', 'nb'])).code).toBe(0);
    const search = (id: number) =>
      rpc(id, 'tools/call', { name: 'search_notes', arguments: { query: 'desk' } });
    const create = rpc(2, 'tools/call', {
      name: 'create_note',
      arguments: { title: 'Agent', markdown: 'x' },
    });
    const detached: string[][] = [];
    const logs: string[] = [];
    const served = await agent(['mcp', '--notebook', 'nb'], {
      lines: [search(1), create],
      detached,
      logs,
    });
    expect(served.code).toBe(0);
    // The startup sync ran before the first call.
    expect(served.stdout).toContain('From the desk');
    expect(served.stderr).toContain('stdin closed: syncing nb in the background');
    expect(detached).toEqual([['notebook', 'sync', 'nb', '--wait', '120']]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/detached-sync\.log$/);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('Agent.md');

    // The detached sync failed (the repository was away): the next server starts by pushing.
    const away = `${remote}.away`;
    execFileSync('mv', [remote, away]);
    expect((await agent(detached[0]!)).code).not.toBe(0);
    execFileSync('mv', [away, remote]);
    const again = await agent(['mcp', '--notebook', 'nb'], { lines: [search(3)], detached: [] });
    expect(again.code).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Agent.md');

    // Saved but not synced, and the startup sync cannot reach the repository: still handed off.
    expect((await agent(['new', 'Offline', '--notebook', 'nb', '--no-sync'])).code).toBe(0);
    execFileSync('mv', [remote, away]);
    const offline: string[][] = [];
    const stranded = await agent(['mcp', '--notebook', 'nb'], { lines: [], detached: offline });
    execFileSync('mv', [away, remote]);
    expect(stranded.code).toBe(0);
    expect(offline).toEqual([['notebook', 'sync', 'nb', '--wait', '120']]);
    expect((await agent(offline[0]!)).code).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Offline.md');
  });

  it('serves two notebooks over git at once, and leaves each its own detached sync (PEN-151)', async () => {
    const personal = bare('mcp-personal');
    const work = bare('mcp-work');
    const cli = machine('m', { pushDelayMs: SERVER_PUSH_DELAY_MS });
    for (const [url, name] of [
      [personal, 'Personal'],
      [work, 'Work'],
    ] as const) {
      expect((await cli(['notebook', 'add', `file://${url}`, '--name', name])).code).toBe(0);
      const agent = ['notebook', 'add', `file://${url}`, '--name', `${name.toLowerCase()}-agent`];
      expect((await cli([...agent, '--agent', 'Agent'])).code).toBe(0);
    }
    const create = (id: number, notebook: string, title: string) =>
      rpc(id, 'tools/call', { name: 'create_note', arguments: { notebook, title, markdown: 'x' } });
    const detachedA: string[][] = [];
    const detachedB: string[][] = [];
    const [a, b] = await Promise.all([
      cli(['mcp'], {
        lines: [...HANDSHAKE, create(2, 'Personal', 'From A'), create(3, 'Work', 'Work from A')],
        detached: detachedA,
      }),
      cli(['mcp'], {
        lines: [...HANDSHAKE, create(2, 'Personal', 'From B'), create(3, 'Work', 'Work from B')],
        detached: detachedB,
      }),
    ]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(a.stdout).not.toContain('"isError":true');
    expect(b.stdout).not.toContain('"isError":true');
    const wanted = [
      ['notebook', 'sync', 'personal-agent', '--wait', '120'],
      ['notebook', 'sync', 'work-agent', '--wait', '120'],
    ];
    expect([...detachedA].sort()).toEqual(wanted);
    expect([...detachedB].sort()).toEqual(wanted);
    for (const args of [...detachedA, ...detachedB]) expect((await cli(args)).code).toBe(0);
    const files = (url: string) => git(url, ['ls-tree', '-r', '--name-only', 'main']);
    expect(files(personal)).toContain('From A.md');
    expect(files(personal)).toContain('From B.md');
    expect(files(personal)).not.toContain('Work from A.md');
    expect(files(work)).toContain('Work from A.md');
    expect(files(work)).toContain('Work from B.md');
    expect(git(work, ['log', '-1', '--format=%an', 'main'])).toBe('Agent');
  });

  it('commits as the identity set while it runs, from its next commit (#174 review)', async () => {
    const remote = bare('mcp-who');
    const global = join(root.path, 'gitconfig-mcp');
    writeFileSync(global, '[user]\n\tname = Ryan\n\temail = ryan@example.invalid\n');
    const cli = machine('mw', { gitEnv: { GIT_CONFIG_GLOBAL: global } });
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'ryan']);
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb', '--agent', 'Claude Code']);
    const create = (id: number, title: string) =>
      rpc(id, 'tools/call', { name: 'create_note', arguments: { title, markdown: title } });
    const emails = () => git(remote, ['log', '--format=%ae', 'main']).split('\n');
    const served = await cli(['mcp', '--notebook', 'nb'], {
      lines: [
        ...HANDSHAKE,
        create(2, 'Before'),
        async () => {
          // Its push lands; then, from another terminal, the notebook gets its own email.
          await vi.waitFor(
            () =>
              expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Before.md'),
            { timeout: 10_000 },
          );
          const set = await cli([
            'notebook',
            'set',
            'nb',
            '--author-email',
            '7+agent@users.noreply.github.com',
          ]);
          expect(set.code, set.stderr).toBe(0);
        },
        create(3, 'After'),
      ],
    });
    expect(served.code, served.stderr).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('After.md');
    expect(emails()[0]).toBe('7+agent@users.noreply.github.com');
    expect(emails()).toContain('ryan@example.invalid');
  });
});
