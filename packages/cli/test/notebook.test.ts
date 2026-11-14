/**
 * Git notebooks from the CLI (T50 G2, #150; T59, A1050), end to end with real git: `penmoss
 * notebook …`, the note commands on a notebook (`--notebook`, or the only one), and `penmoss mcp
 * --notebook`, against bare repositories on this machine. The CLI's `Io` has no network of its
 * own: git talks to the notebook's host, and nothing else is reached.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GitNotebookEngine,
  MemorySecrets,
  MemoryStorage,
  NotebookOps,
} from '@penmoss/git-notebook';
import { lockNotebook, NodeGitTransport } from '@penmoss/git-notebook/node';
import { notebookTag, shortNoteRef } from '@penmoss/core/note-ref';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io } from '../src/io';
import { run } from '../src/main';
import { memoryTokenStore } from '../src/memory-store';
import { nodeNotebooks } from '../src/node-notebooks';
import { httpHost } from '../../git-notebook/test/support/git';
import {
  deliveryOn,
  readAgentSessions,
  sendFromMac,
} from '../../git-notebook/test/support/comments';
import { markUndoneInStore } from '../../git-notebook/test/support/marks';

// Each test runs many git processes; the Mac CI runners take over 5 s for the longest
// (as packages/git-notebook's config allows).
vi.setConfig({ testTimeout: 60_000 });

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const env = () => ({ ...process.env, ...GIT_ENV, GIT_TERMINAL_PROMPT: '0' });

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, env: env(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'penmoss-nb-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bare(name: string): string {
  const path = join(root, `${name}.git`);
  mkdirSync(path, { recursive: true });
  git(path, ['init', '--bare', '--quiet', '--initial-branch=main']);
  git(path, ['config', 'uploadpack.allowFilter', 'true']);
  git(path, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  return path;
}

/** `penmoss mcp`'s own push delay (node-notebooks.ts): longer than any test runs. */
const SERVER_PUSH_DELAY_MS = 60_000;

/** A machine: its own ~/.penmoss, keychain (in memory) and stdin. */
function machine(
  name: string,
  extra: {
    env?: Readonly<Record<string, string>>;
    gitEnv?: Readonly<Record<string, string>>;
    channelCheckMs?: number;
    /**
     * How long `penmoss mcp` waits after an edit before it pushes. 50 ms by default, so a test
     * sees the server's own push; a test of what a stopped server leaves to its detached sync
     * passes the product's default, so that push cannot come before the stop.
     */
    pushDelayMs?: number;
  } = {},
) {
  const secrets = memoryTokenStore();
  const notebooks = nodeNotebooks({
    home: join(root, name),
    env: extra.env ?? {},
    platform: process.platform,
    secrets,
    gitEnv: { ...GIT_ENV, ...extra.gitEnv },
    pushDelayMs: extra.pushDelayMs ?? 50,
    pullEveryMs: 60_000,
    lockWaitMs: 300,
    ...(extra.channelCheckMs !== undefined ? { channelCheckMs: extra.channelCheckMs } : {}),
  });
  return async (
    argv: string[],
    input: {
      stdin?: string;
      /** Each line in turn; a function runs between two lines (another terminal, say). */
      lines?: Array<string | (() => Promise<void>)>;
      /** Stop with this signal once the lines are read, instead of ending stdin. */
      signal?: string;
      /** Where detached syncs are recorded; given, the CLI can detach. */
      detached?: string[][];
      /** The log each detached sync was given. */
      logs?: string[];
      /** The CLI's own environment (`io.env`). */
      cliEnv?: Readonly<Record<string, string>>;
    } = {},
  ) => {
    let stop: (signal: string) => void = () => undefined;
    let stdout = '';
    let stderr = '';
    const io: Io = {
      env: input.cliEnv ?? {},
      stdin: { isTTY: false, read: () => Promise.resolve(input.stdin ?? '') },
      stdout: { isTTY: false, write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
      openUrl: () => Promise.resolve(false),
      readFile: (path) => Promise.resolve(new Uint8Array(readFileSync(path))),
      fileSize: (path) => Promise.resolve(statSync(path).size),
      stdio: {
        lines: async function* () {
          for (const line of input.lines ?? []) {
            if (typeof line === 'string') yield line;
            else await line();
          }
          if (input.signal === undefined) return;
          stop(input.signal);
          await new Promise(() => undefined);
        },
        ...(input.signal === undefined
          ? {}
          : { stopped: () => new Promise<string>((resolve) => (stop = resolve)) }),
        ...(input.detached === undefined
          ? {}
          : {
              detach: (args: readonly string[], log?: string) => {
                input.detached!.push([...args]);
                if (log) input.logs?.push(log);
                return true;
              },
            }),
      },
      notebooks,
    };
    const code = await run(argv, io);
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
  };
}

describe('penmoss notebook', () => {
  it('runs a note command on the only notebook without --notebook; with two, names them (A1050)', async () => {
    const cli = machine('one');
    const none = await cli(['ls']);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('no git notebook on this machine: add one with');
    await cli(['notebook', 'add', `file://${bare('first')}`, '--name', 'first']);
    const made = await cli(['new', 'Only', '--text', 'here', '--json']);
    expect(made.code, made.stderr).toBe(0);
    const id = made.json()['id'] as string;
    expect((await cli(['cat', id, '--body'])).stdout).toBe('here\n');
    await cli(['notebook', 'add', `file://${bare('second')}`, '--name', 'second']);
    const which = await cli(['cat', id]);
    expect(which.code).toBe(2);
    expect(which.stderr).toContain(
      '2 git notebooks are on this machine (first, second): pass --notebook <name>',
    );
    expect((await cli(['cat', id, '--notebook', 'first', '--body'])).stdout).toBe('here\n');
    expect((await cli(['cat', id, '--notebook', 'second'])).code).toBe(4);
  });

  it('finds the notebook from a short id alone, and penmoss mcp names the notebook a short id is of (PEN-69)', async () => {
    const cli = machine('refs');
    await cli(['notebook', 'add', `file://${bare('first')}`, '--name', 'first']);
    await cli(['notebook', 'add', `file://${bare('second')}`, '--name', 'second']);
    const made = await cli(['new', 'Short', '--text', 'by ref', '--notebook', 'first', '--json']);
    expect(made.code, made.stderr).toBe(0);
    const id = made.json()['id'] as string;
    const listed = await cli(['notebook', 'ls', '--json']);
    const entries = (listed.json()['notebooks'] ?? listed.json()) as unknown as Array<{
      name: string;
      notebookId: string;
    }>;
    const first = entries.find((entry) => entry.name === 'first')!;
    const ref = shortNoteRef(first.notebookId, id);
    // Two notebooks here, no --notebook: the short id says which.
    const read = await cli(['cat', ref.toLowerCase(), '--body']);
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout).toBe('by ref\n');
    const wrong = await cli(['cat', ref, '--notebook', 'second']);
    expect(wrong.code).toBe(4);
    const nowhere = await cli(['cat', `${notebookTag('elsewhere')}-${id.slice(-8)}`]);
    expect(nowhere.code).toBe(4);
    expect(nowhere.stderr).toContain('No git notebook on this machine holds');
    const served = await cli(['mcp', '--notebook', 'second'], {
      lines: [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'read_note', arguments: { id: ref } },
        }),
      ],
    });
    const reply = JSON.parse(served.stdout.trim().split('\n')[0]!) as McpReply;
    expect(reply.result.isError).toBe(true);
    expect(JSON.stringify(reply.result)).toContain('penmoss mcp --notebook \\"');
  });

  it('adds a notebook, edits it from two machines offline, and they converge with no merges', async () => {
    const remote = bare('notes');
    const laptop = machine('laptop');
    const added = await laptop(['notebook', 'add', `file://${remote}`, '--name', 'work', '--json']);
    // Nothing is said: nobody is asked whether the repository is private (D61).
    expect(added.stderr).toBe('');
    expect(added.code).toBe(0);
    expect(added.json()).toMatchObject({
      name: 'work',
      created: true,
      branch: 'main',
      writer: { kind: 'device' },
    });
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain(
      '.penmoss/notebook.json',
    );

    const made = await laptop([
      'new',
      'Standup',
      '--text',
      '## Notes\n\nShip the CLI',
      '--tag',
      'work',
      '--notebook',
      'work',
      '--json',
    ]);
    expect(made.code).toBe(0);
    const id = made.json()['id'] as string;
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Standup.md');
    expect(git(remote, ['log', '-1', '--format=%s', 'main'])).toBe('Penmoss: 1 note [skip ci]');

    const agent = machine('agent');
    // On the agent's machine, a person's clone and an agent's, each added on its own.
    expect((await agent(['notebook', 'add', `file://${remote}`, '--name', 'work-ryan'])).code).toBe(
      0,
    );
    expect(
      (
        await agent([
          'notebook',
          'add',
          `file://${remote}`,
          '--name',
          'work',
          '--agent',
          'Claude Code',
        ])
      ).code,
    ).toBe(0);
    const found = await agent(['search', 'ship', '--notebook', 'work', '--json']);
    expect((found.json()['results'] as { id: string }[]).map((r) => r.id)).toEqual([id]);
    expect(found.json()['notice']).toMatch(/words only/);
    const read = await agent(['cat', 'Standup', '--notebook', 'work', '--body']);
    expect(read.stdout).toBe('## Notes\n\nShip the CLI\n');

    // Both edit offline, then sync.
    expect(
      (
        await laptop([
          'append',
          'Standup',
          '--text',
          '- from the laptop',
          '--notebook',
          'work',
          '--no-sync',
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await agent([
          'append',
          'Standup',
          '--text',
          '- from the agent',
          '--heading',
          'Notes',
          '--notebook',
          'work',
          '--no-sync',
        ])
      ).code,
    ).toBe(0);
    expect((await agent(['new', 'Agent note', '--notebook', 'work', '--no-sync'])).code).toBe(0);
    const pushed = await laptop(['notebook', 'sync', 'work', '--json']);
    expect((pushed.json()['synced'] as { commit: string }[])[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
    await agent(['notebook', 'sync']);
    await laptop(['notebook', 'sync', 'work']);
    const one = (await laptop(['cat', 'Standup', '--notebook', 'work', '--body'])).stdout;
    const two = (await agent(['cat', 'Standup', '--notebook', 'work', '--body'])).stdout;
    expect(one).toBe(two);
    expect(one).toContain('from the laptop');
    expect(one).toContain('from the agent');
    const listed = (await laptop(['ls', '--notebook', 'work', '--json'])).json();
    expect((listed['notes'] as { title: string }[]).map((n) => n.title).sort()).toEqual([
      'Agent note',
      'Standup',
    ]);
    expect(git(remote, ['rev-list', '--merges', 'main'])).toBe('');
    const authors = git(remote, ['log', '--format=%an', 'main']).split('\n');
    expect(authors).toContain('Claude Code');

    const status = await agent(['notebook', 'status', 'work', '--json']);
    expect(status.json()).toMatchObject({
      name: 'work',
      writer: { kind: 'agent', label: 'Claude Code' },
      unsynced: 0,
      notes: 2,
    });
    expect(status.json()['writerId']).toMatch(/^[0-9A-Z]{26}$/);
    expect((await agent(['notebook', 'ls', '--json'])).json()['notebooks']).toHaveLength(2);
  });

  it('an agent clone never commits an undo mark, even one written into its store (#174 merge check)', async () => {
    const remote = bare('marks');
    const agent = machine('agent');
    expect((await agent(['notebook', 'add', `file://${remote}`, '--name', 'ryan'])).code).toBe(0);
    expect(
      (
        await agent([
          'notebook',
          'add',
          `file://${remote}`,
          '--name',
          'work',
          '--agent',
          'Claude Code',
        ])
      ).code,
    ).toBe(0);
    expect((await agent(['mkdir', 'From the agent', '--notebook', 'work'])).code).toBe(0);
    await agent(['notebook', 'sync', 'work']);
    const made = git(remote, ['rev-parse', 'main']);
    // The agent marks its own change undone "by Ryan", past every command.
    const listed = (await agent(['notebook', 'ls', '--json'])).json()['notebooks'] as Array<{
      name: string;
      localId: string;
    }>;
    const work = listed.find((entry) => entry.name === 'work')!;
    await markUndoneInStore(join(root, 'agent', 'git', work.localId), made, 'Ryan');
    const synced = await agent(['notebook', 'sync', 'work']);
    expect(synced.code).not.toBe(0);
    expect(synced.stderr).toContain('only a person marks an agent’s change undone');
    expect(git(remote, ['rev-parse', 'main'])).toBe(made);
  });

  it('runs every note command on the notebook', async () => {
    const remote = bare('all');
    const cli = machine('m');
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    const nb = ['--notebook', 'nb', '--no-sync'];
    expect((await cli(['mkdir', 'Projects/Garden', '-p', ...nb])).code).toBe(0);
    const beds = await cli([
      'new',
      'Beds',
      '--text',
      '## Plan\n\nTomatoes',
      '--folder',
      'Projects/Garden',
      ...nb,
      '--json',
    ]);
    expect(beds.code).toBe(0);
    const bedsId = beds.json()['id'] as string;
    expect(
      (await cli(['edit', 'Beds', '--section', 'Plan', '--text', 'Peppers', ...nb])).code,
    ).toBe(0);
    expect(
      (await cli(['edit', 'Beds', '--replace', 'Peppers', '--with', 'Chillies', ...nb])).code,
    ).toBe(0);
    expect((await cli(['tag', 'Beds', 'garden', ...nb])).code).toBe(0);
    expect((await cli(['retag', 'garden', 'veg', ...nb])).code).toBe(0);
    expect((await cli(['ls', '--tags', ...nb, '--json'])).json()).toEqual({
      tags: [{ name: 'veg', notes: 1 }],
    });
    expect((await cli(['mv', 'Beds', '/', ...nb])).code).toBe(0);
    expect((await cli(['rename', 'Projects/Garden', 'Allotment', ...nb])).code).toBe(0);
    expect((await cli(['sort', 'Projects', 'alpha', ...nb])).code).toBe(0);
    expect((await cli(['rmdir', 'Projects/Allotment', ...nb])).code).toBe(0);
    expect((await cli(['trash', 'Beds', ...nb])).code).toBe(0);
    expect((await cli(['cat', 'Beds', ...nb])).code).toBe(4);
    expect((await cli(['restore', bedsId, ...nb, '--json'])).json()).toEqual({
      id: bedsId,
      restored: true,
      folderId: null,
    });
    const settings = await cli(['settings', 'template.daily', '## Plan', ...nb]);
    expect(settings.code).toBe(0);
    expect((await cli(['settings', 'theme.mode', 'dark', ...nb])).code).toBe(3);
    const day = await cli(['daily', '--date', '2026-10-29', '--notebook', 'nb', '--json']);
    expect(day.json()).toMatchObject({
      kind: 'daily',
      date: '2026-10-29',
      created: true,
      body: '## Plan\n',
    });
    const png = join(root, 'pic.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const attached = await cli(['attach', '2026-10-29', png, '--notebook', 'nb']);
    expect(attached.stderr).toBe('');
    expect(attached.code).toBe(0);
    const files = git(remote, ['ls-tree', '-r', '--name-only', 'main']);
    expect(files).toMatch(/attachments\/[0-9a-f]{64}\.png/);
    expect(files).toContain('Journal/2026/10/2026-10-29.md');
    expect((await cli(['search', 'x', '--mode', 'semantic', '--notebook', 'nb'])).code).toBe(7);
    // History (G6, A858): the commits that touched the note.
    const history = await cli(['history', 'Beds', '--notebook', 'nb', '--json']);
    expect(history.code).toBe(0);
    expect((history.json()['versions'] as unknown[]).length).toBeGreaterThan(0);
    expect((await cli(['ls', '--notebook', 'nope'])).code).toBe(4);
  });

  it('commits only inside a directory of a code repository, with [skip ci], beside a colleague', async () => {
    const remote = bare('code');
    const work = join(root, 'colleague');
    mkdirSync(work);
    git(work, ['init', '--quiet', '--initial-branch=main']);
    git(work, ['config', 'user.name', 'Colleague']);
    git(work, ['config', 'user.email', 'c@example.invalid']);
    mkdirSync(join(work, 'docs', 'notes'), { recursive: true });
    writeFileSync(join(work, 'README.md'), '# App\n');
    writeFileSync(join(work, 'docs', 'notes', 'Mine.md'), '# By hand\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '--quiet', '-m', 'Code']);
    git(work, ['remote', 'add', 'origin', `file://${remote}`]);
    git(work, ['push', '--quiet', 'origin', 'main']);
    const cli = machine('dev');
    const added = await cli([
      'notebook',
      'add',
      `file://${remote}`,
      '--dir',
      'docs/notes',
      '--json',
    ]);
    expect(added.json()).toMatchObject({ name: 'code-notes', dir: 'docs/notes', created: true });
    expect(
      (await cli(['new', 'Mine', '--text', 'from penmoss', '--notebook', 'code-notes'])).code,
    ).toBe(0);
    git(work, ['pull', '--quiet', '--ff-only', 'origin', 'main']);
    expect(git(work, ['show', 'HEAD:docs/notes/Mine.md'])).toBe('# By hand');
    expect(git(work, ['ls-tree', '-r', '--name-only', 'HEAD', 'docs/notes'])).toMatch(
      /docs\/notes\/Mine \([0-9A-Z]{7}\)\.md/,
    );
    for (const sha of git(work, ['log', '--format=%H', '--author=dev|Penmoss', '-E'])
      .split('\n')
      .filter(Boolean)) {
      expect(git(work, ['log', '-1', '--format=%s', sha])).toMatch(/\[skip ci\]$/);
      for (const path of git(work, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
        .split('\n')
        .filter(Boolean)) {
        expect(path.startsWith('docs/notes/')).toBe(true);
      }
    }
  });

  it("prints the host's reason for a refused push, and keeps the edit for the next sync", async () => {
    const remote = bare('guarded');
    const cli = machine('m');
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    writeFileSync(
      join(remote, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const made = await cli(['new', 'Kept', '--notebook', 'nb']);
    expect(made.code).toBe(0);
    expect(made.stderr).toContain('saved here, not synced yet');
    expect(made.stderr).toContain('GH006: Protected branch update failed');
    expect((await cli(['notebook', 'status', 'nb', '--json'])).json()['unsynced']).toBeGreaterThan(
      0,
    );
    const sync = await cli(['notebook', 'sync', 'nb']);
    expect(sync.code, sync.stderr + sync.stdout).toBe(7);
    expect(sync.stderr).toMatch(/protected/i);
    // Removing it now would drop the edit.
    expect((await cli(['notebook', 'remove', 'nb'])).code).toBe(5);
    rmSync(join(remote, 'hooks', 'pre-receive'));
    expect((await cli(['notebook', 'sync', 'nb'])).code).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Kept.md');
    expect((await cli(['notebook', 'remove', 'nb'])).code).toBe(0);
    expect((await cli(['notebook', 'ls', '--json'])).json()['notebooks']).toEqual([]);
  });

  it('takes a token only from stdin, and says so when one is put on the command line', async () => {
    const cli = machine('m');
    expect(
      (await cli(['notebook', 'add', 'https://example.com/x.git', '--token', 'secret123'])).code,
    ).toBe(2);
  });

  it('one engine per clone: a held lock is a clear refusal', async () => {
    const remote = bare('locked');
    const cli = machine('m');
    const added = (
      await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb', '--json'])
    ).json();
    const lock = await lockNotebook(
      join(root, 'm', 'git', added['localId'] as string),
      'penmoss mcp',
    );
    try {
      const busy = await cli(['ls', '--notebook', 'nb']);
      expect(busy.code).toBe(5);
      expect(busy.stderr).toMatch(/in use by penmoss mcp/);
    } finally {
      await lock.release();
    }
    expect((await cli(['ls', '--notebook', 'nb'])).code).toBe(0);
  });

  it('syncs any repository with nobody confirming it and nothing said about it (D51, D61)', async () => {
    const remote = `file://${bare('elsewhere')}`;
    const cli = machine('m');
    const added = await cli(['notebook', 'add', remote, '--name', 'nb']);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toBe('');
    expect((await cli(['new', 'Unasked', '--notebook', 'nb'])).code).toBe(0);
    expect(git(join(root, 'elsewhere.git'), ['ls-tree', '-r', '--name-only', 'main'])).toContain(
      'Unasked.md',
    );
    const synced = await cli(['notebook', 'sync', 'nb']);
    expect(synced.code).toBe(0);
    expect(synced.stderr).toBe('');
    // status has no visibility line any more.
    expect((await cli(['notebook', 'status', 'nb'])).stdout).not.toMatch(/visibility/);
    // The confirmation is gone: its flag and its command are unknown.
    const flag = await cli(['notebook', 'add', remote, '--name', 'nb2', '--confirm-private']);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain('unknown option --confirm-private');
    expect((await cli(['notebook', 'confirm-private', 'nb'])).code).toBe(2);
    expect((await cli(['notebook', 'ls', '--json'])).json()['notebooks']).toHaveLength(1);
  });

  it('an agent clone of such a repository syncs on its own, and so does its MCP server (D51)', async () => {
    const remote = `file://${bare('elsewhere')}`;
    const cli = machine('m');
    const added = await cli([
      'notebook',
      'add',
      remote,
      '--name',
      'nb-agent',
      '--agent',
      'Claude Code',
    ]);
    expect(added.code, added.stderr).toBe(0);
    const served = await cli(['mcp', '--notebook', 'nb-agent'], {
      lines: [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'create_note', arguments: { title: 'From the agent', markdown: 'x' } },
        }),
      ],
    });
    expect(served.code).toBe(0);
    expect(served.stderr).not.toContain('could not sync');
    expect(git(join(root, 'elsewhere.git'), ['ls-tree', '-r', '--name-only', 'main'])).toContain(
      'From the agent.md',
    );
  });

  it('sends PENMOSS_GIT_TOKEN to its own host, and syncs with it', async () => {
    mkdirSync(join(root, 'host', 'o'), { recursive: true });
    const repo = join(root, 'host', 'o', 'r.git');
    mkdirSync(repo);
    git(repo, ['init', '--bare', '--quiet', '--initial-branch=main']);
    git(repo, ['config', 'uploadpack.allowFilter', 'true']);
    git(repo, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    git(repo, ['config', 'http.receivepack', 'true']);
    const host = await httpHost(join(root, 'host'), { user: 'x-access-token', password: 'pat' });
    try {
      const cli = machine('m', {
        env: { PENMOSS_GIT_TOKEN: 'pat', PENMOSS_GIT_TOKEN_HOST: '127.0.0.1' },
      });
      const added = await cli(['notebook', 'add', `${host.origin}/o/r.git`, '--name', 'nb']);
      expect(added.code, added.stderr).toBe(0);
      expect(added.stderr).toBe('');
      expect((await cli(['new', 'Over HTTP', '--notebook', 'nb'])).code).toBe(0);
      expect(git(repo, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Over HTTP.md');
    } finally {
      await host.close();
    }
  });

  it('adds and syncs a github.com repository without asking GitHub anything (D61)', async () => {
    // github.com over SSH, served from this machine: git's ssh command runs git here.
    const served = join(root, 'gh');
    mkdirSync(join(served, 'acme'), { recursive: true });
    const repo = join(served, 'acme', 'hidden.git');
    mkdirSync(repo);
    git(repo, ['init', '--bare', '--quiet', '--initial-branch=main']);
    git(repo, ['config', 'uploadpack.allowFilter', 'true']);
    git(repo, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    const ssh = join(root, 'ssh.sh');
    writeFileSync(
      ssh,
      `#!/bin/sh\nfor last; do :; done\ncd '${served}' && exec sh -c "git \${last#git-}"\n`,
      { mode: 0o755 },
    );
    const fetch = vi.fn(() => Promise.reject(new Error('nothing may be fetched')));
    vi.stubGlobal('fetch', fetch);
    try {
      const cli = machine('m', { gitEnv: { GIT_SSH_COMMAND: ssh } });
      const added = await cli([
        'notebook',
        'add',
        'git@github.com:acme/hidden.git',
        '--name',
        'nb',
      ]);
      expect(added.code, added.stderr).toBe(0);
      expect(added.stderr).toBe('');
      expect((await cli(['new', 'First', '--notebook', 'nb'])).code).toBe(0);
      expect(git(repo, ['ls-tree', '-r', '--name-only', 'main'])).toContain('First.md');
      expect((await cli(['notebook', 'sync', 'nb'])).code).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('loads a registry with an old confirmation or visibility, and the next write leaves them out (D51, D61, A1081)', async () => {
    const remote = `file://${bare('old')}`;
    const cli = machine('m');
    expect((await cli(['notebook', 'add', remote, '--name', 'nb'])).code).toBe(0);
    const registryPath = join(root, 'm', 'notebooks.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      notebooks: Array<Record<string, unknown>>;
    };
    // What a CLI before D51 kept for a repository a person confirmed private.
    registry.notebooks[0]!['confirmedPrivate'] = {
      remote,
      at: '2026-10-30T12:00:00.000Z',
      by: 'Penmoss for Mac',
    };
    // What a CLI before D61 kept: the last answer about the repository's visibility.
    registry.notebooks[0]!['visibility'] = { kind: 'unknown', at: 1_800_000_000_000, detail: 'x' };
    writeFileSync(registryPath, JSON.stringify(registry));
    const status = await cli(['notebook', 'status', 'nb', '--json']);
    expect(status.code).toBe(0);
    expect(status.json()).not.toHaveProperty('confirmedPrivate');
    expect(status.json()).not.toHaveProperty('visibility');
    expect(readFileSync(registryPath, 'utf8')).toContain('confirmedPrivate');
    expect((await cli(['notebook', 'set', 'nb', '--no-sign'])).code).toBe(0);
    expect(readFileSync(registryPath, 'utf8')).not.toContain('confirmedPrivate');
    expect(readFileSync(registryPath, 'utf8')).not.toContain('"visibility"');
    expect((await cli(['notebook', 'sync', 'nb'])).code).toBe(0);
  });

  it('bounds the sync before a write; the write is saved and its sync left to the background (A852)', async () => {
    const remote = bare('stall');
    const cli = machine('m');
    expect((await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb'])).code).toBe(0);
    const registry = JSON.parse(readFileSync(join(root, 'm', 'notebooks.json'), 'utf8')) as {
      notebooks: Array<{ localId: string }>;
    };
    const gitDir = join(root, 'm', 'git', registry.notebooks[0]!.localId, 'repo.git');
    // Every fetch hangs, as on a network that drops connections.
    const sleep = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();
    const hang = join(root, 'hang.sh');
    writeFileSync(hang, `#!/bin/sh\nexec '${sleep}' 60\n`, { mode: 0o755 });
    git(gitDir, ['config', 'remote.origin.uploadpack', hang]);
    const detached: string[][] = [];
    const started = Date.now();
    const made = await cli(['new', 'Stalled', '--notebook', 'nb'], {
      detached,
      cliEnv: { PENMOSS_NOTEBOOK_SYNC_TIMEOUT: '1' },
    });
    const took = Date.now() - started;
    expect(made.code).toBe(0);
    expect(made.stdout).toContain('Created');
    expect(made.stderr).toContain('the host did not answer within 1 s');
    expect(made.stderr).toContain('the sync is pending and runs in the background');
    expect(detached).toEqual([['notebook', 'sync', 'nb', '--wait', '120']]);
    // One bounded sync, not a second after the write.
    expect(took).toBeLessThan(10_000);
    git(gitDir, ['config', '--unset', 'remote.origin.uploadpack']);
    expect((await cli(['notebook', 'sync', 'nb'])).code).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Stalled.md');
  });

  it('turns signing off and on for a notebook', async () => {
    const remote = bare('set');
    const cli = machine('m');
    expect((await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb'])).code).toBe(0);
    expect((await cli(['notebook', 'set', 'nb', '--no-sign'])).code).toBe(0);
    expect((await cli(['notebook', 'status', 'nb'])).stdout).toMatch(/signing +off/);
    expect((await cli(['notebook', 'set', 'nb', '--sign'])).code).toBe(0);
    expect((await cli(['notebook', 'status', 'nb'])).stdout).toMatch(/signing +as git config says/);
    expect((await cli(['notebook', 'set', 'nb'])).code).toBe(2);
  });

  it('changes a git note’s title with set-title, and edit --replace says the title is not its text (#170 F10)', async () => {
    const remote = bare('titles');
    const cli = machine('m');
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    expect((await cli(['new', 'From the CLI', '--notebook', 'nb', '--text', 'body'])).code).toBe(0);
    const replaced = await cli([
      'edit',
      'From the CLI',
      '--replace',
      'From the CLI',
      '--with',
      'Renamed',
      '--notebook',
      'nb',
    ]);
    expect(replaced.code).toBe(4);
    expect(replaced.stderr).toContain('is in the note’s title, which edit does not change');
    expect(replaced.stderr).toContain('penmoss set-title');
    // Single-quoted for the shell, never JSON (#174 review).
    expect(replaced.stderr).toContain('set-title ');
    expect(replaced.stderr).toMatch(/set-title \S+ 'Renamed'/);
    const retitled = await cli(['set-title', 'From the CLI', 'Renamed', '--notebook', 'nb']);
    expect(retitled.code, retitled.stderr).toBe(0);
    expect(retitled.stdout).toContain('Retitled');
    const files = git(remote, ['ls-tree', '-r', '--name-only', 'main']);
    expect(files).toContain('Renamed.md');
    expect(files).not.toContain('From the CLI.md');
    expect((await cli(['cat', 'Renamed', '--notebook', 'nb', '--body'])).stdout).toContain('body');
    expect((await cli(['set-title', 'Renamed', '  ', '--notebook', 'nb'])).code).toBe(2);
    // A title of only bidi and format characters is empty too (#174 review).
    expect(
      (await cli(['set-title', 'Renamed', '\u202e\u200b\u2066', '--notebook', 'nb'])).code,
    ).toBe(2);
    // A title the shell would expand: quoted so it never is.
    expect((await cli(['new', 'Cost $5', '--notebook', 'nb', '--text', 'x'])).code).toBe(0);
    const costly = await cli([
      'edit',
      'Cost $5',
      '--replace',
      '$5',
      '--with',
      "it's $(id)",
      '--notebook',
      'nb',
    ]);
    expect(costly.stderr).toContain(`'Cost it'\\''s $(id)'`);
  });

  it('penmoss mcp commits as the identity set while it runs, from its next commit (#174 review)', async () => {
    const remote = bare('mcp-who');
    const global = join(root, 'gitconfig-mcp');
    writeFileSync(global, '[user]\n\tname = Ryan\n\temail = ryan@example.invalid\n');
    const cli = machine('mw', { gitEnv: { GIT_CONFIG_GLOBAL: global } });
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'ryan']);
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb', '--agent', 'Claude Code']);
    const rpc = (id: number, method: string, params?: unknown) =>
      JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const create = (id: number, title: string) =>
      rpc(id, 'tools/call', { name: 'create_note', arguments: { title, markdown: title } });
    const emails = () => git(remote, ['log', '--format=%ae', 'main']).split('\n');
    const served = await cli(['mcp', '--notebook', 'nb'], {
      lines: [
        rpc(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '1' },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
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

  it('commits as git’s identity now, or as the notebook’s own (#170 F3, F6)', async () => {
    const remote = bare('who');
    const global = join(root, 'gitconfig');
    const identity = (email: string) =>
      writeFileSync(global, `[user]\n\tname = Ryan\n\temail = ${email}\n`);
    identity('ryan@example.invalid');
    const cli = machine('m', { gitEnv: { GIT_CONFIG_GLOBAL: global } });
    const added = await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    expect(added.code, added.stderr).toBe(0);
    const lastEmail = () => git(remote, ['log', '-1', '--format=%an <%ae>', 'main']);
    expect((await cli(['new', 'One', '--notebook', 'nb'])).code).toBe(0);
    expect(lastEmail()).toBe('Ryan <ryan@example.invalid>');
    // git's user.email changed after the notebook was added: the next commit has it.
    identity('1234+ryan@users.noreply.github.com');
    expect((await cli(['new', 'Two', '--notebook', 'nb'])).code).toBe(0);
    expect(lastEmail()).toBe('Ryan <1234+ryan@users.noreply.github.com>');
    // This notebook's own, over git's.
    const set = await cli([
      'notebook',
      'set',
      'nb',
      '--author-email',
      '9+rh@users.noreply.github.com',
    ]);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain('nb commits as Ryan <9+rh@users.noreply.github.com> from now on.');
    expect((await cli(['notebook', 'status', 'nb'])).stdout).toMatch(
      /commits as +Ryan <9\+rh@users\.noreply\.github\.com> \(this notebook’s own\)/,
    );
    expect((await cli(['new', 'Three', '--notebook', 'nb'])).code).toBe(0);
    expect(lastEmail()).toBe('Ryan <9+rh@users.noreply.github.com>');
    expect(
      (await cli(['notebook', 'set', 'nb', '--author-name', 'R H', '--author-email', 'x@y.z']))
        .code,
    ).toBe(0);
    expect((await cli(['notebook', 'set', 'nb', '--author-email', 'not-an-email'])).code).toBe(2);
    expect((await cli(['notebook', 'set', 'nb', '--author-name', 'Only'])).code).toBe(2);
    // Plain text only (#174 review): no NUL, control, bidi or other format character.
    for (const [flag, value] of [
      ['--author-email', 'a\u202e@b.c'],
      ['--author-email', 'a\u0000@b.c'],
      ['--author-name', 'R\u2066H'],
    ] as const) {
      const extra = flag === '--author-name' ? ['--author-email', 'x@y.z'] : [];
      expect((await cli(['notebook', 'set', 'nb', flag, value, ...extra])).code, value).toBe(2);
    }
    expect((await cli(['notebook', 'set', 'nb', '--git-author'])).code).toBe(0);
    expect((await cli(['new', 'Four', '--notebook', 'nb'])).code).toBe(0);
    expect(lastEmail()).toBe('Ryan <1234+ryan@users.noreply.github.com>');
  });

  it('says to commit as the GitHub no-reply address when GitHub refuses a private email (GH007, #170 F6)', async () => {
    const remote = bare('gh007');
    const cli = machine('m');
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    writeFileSync(
      join(remote, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "error: GH007: Your push would publish a private email address." >&2\nexit 1\n',
      { mode: 0o755 },
    );
    expect((await cli(['new', 'Kept', '--notebook', 'nb'])).code).toBe(0);
    const sync = await cli(['notebook', 'sync', 'nb']);
    expect(sync.code).toBe(7);
    expect(sync.stderr).toContain(
      'GitHub refused the push: its commits would make your private email address public (GH007).',
    );
    expect(sync.stderr).toContain('penmoss notebook set nb --author-email <that address>');
  });

  it('says to add again with --author-email when GitHub refuses add’s first push, and add takes it (#198)', async () => {
    const remote = bare('gh007-add');
    const global = join(root, 'gitconfig-198');
    writeFileSync(global, '[user]\n\tname = Ryan\n\temail = ryan@example.invalid\n');
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n  git log --format=%ae "$new" | grep -q "@users.noreply.github.com" || { echo "error: GH007: Your push would publish a private email address." >&2; exit 1; }\ndone\n',
      { mode: 0o755 },
    );
    const cli = machine('m', { gitEnv: { GIT_CONFIG_GLOBAL: global } });
    const refused = await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    expect(refused.code).toBe(7);
    expect(refused.stderr).toContain('(GH007)');
    // add rolled back, so the advice is add again, not `notebook set` on a notebook not there.
    expect(refused.stderr).toContain(
      'Nothing was added: run the same penmoss notebook add again with --author-email <that address>',
    );
    expect(refused.stderr).not.toContain('notebook set nb');
    expect(refused.stderr).not.toContain('nothing is lost');
    expect((await cli(['notebook', 'ls'])).stdout).toContain('No git notebooks yet');

    const added = await cli([
      'notebook',
      'add',
      `file://${remote}`,
      '--name',
      'nb',
      '--author-email',
      '1234+ryan@users.noreply.github.com',
    ]);
    expect(added.code, added.stderr).toBe(0);
    const lastAuthor = () => git(remote, ['log', '-1', '--format=%an <%ae>', 'main']);
    // The name is git's user.name when only the email is given.
    expect(lastAuthor()).toBe('Ryan <1234+ryan@users.noreply.github.com>');
    expect((await cli(['notebook', 'status', 'nb'])).stdout).toMatch(
      /commits as +Ryan <1234\+ryan@users\.noreply\.github\.com> \(this notebook’s own\)/,
    );
    expect((await cli(['new', 'Later', '--notebook', 'nb'])).code).toBe(0);
    expect(lastAuthor()).toBe('Ryan <1234+ryan@users.noreply.github.com>');
    // The same checks as set's.
    const bad = await cli(['notebook', 'add', `file://${remote}`, '--author-email', 'nope']);
    expect(bad.code).toBe(2);
    const nameOnly = await cli(['notebook', 'add', `file://${remote}`, '--author-name', 'R']);
    expect(nameOnly.code).toBe(2);
  });

  it('follows a rewrite in git’s configuration, as git does (D62)', async () => {
    const remote = bare('rewritten');
    const elsewhere = bare('rewritten-to');
    const cli = machine('m', {
      gitEnv: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${elsewhere}.insteadOf`,
        GIT_CONFIG_VALUE_0: `file://${remote}`,
      },
    });
    const added = await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    expect(added.code, added.stderr).toBe(0);
    // The notebook went where git's configuration sends the remote, as any git command would.
    expect(git(elsewhere, ['ls-tree', '-r', '--name-only', 'main'])).toContain(
      '.penmoss/notebook.json',
    );
    expect(git(remote, ['branch', '--list'])).toBe('');
  });

  it('refuses a remote with a credential, and a bad branch', async () => {
    const cli = machine('m', { env: { PENMOSS_GIT_TOKEN: 'ghp_fromtheenvironment' } });
    const withSecret = await cli([
      'notebook',
      'add',
      'https://x-access-token:ghp_inside123@github.com/acme/notes.git',
    ]);
    expect(withSecret.code).toBe(2);
    expect(withSecret.stderr).toContain('notebook token');
    expect(withSecret.stderr).not.toContain('ghp_inside123');
    const badBranch = await cli([
      'notebook',
      'add',
      'https://github.com/acme/notes.git',
      '--branch',
      'main..x',
    ]);
    expect(badBranch.code).toBe(2);
    expect(badBranch.stderr).toContain('not a branch name');
    expect((await cli(['notebook', 'ls', '--json'])).json()['notebooks']).toEqual([]);
  });

  it('sends PENMOSS_GIT_TOKEN only to its own host', async () => {
    mkdirSync(join(root, 'other', 'o'), { recursive: true });
    const repo = join(root, 'other', 'o', 'r.git');
    mkdirSync(repo);
    git(repo, ['init', '--bare', '--quiet', '--initial-branch=main']);
    git(repo, ['config', 'http.receivepack', 'true']);
    const host = await httpHost(join(root, 'other'), { user: 'x-access-token', password: 'pat' });
    try {
      const cli = machine('m', {
        env: { PENMOSS_GIT_TOKEN: 'pat', PENMOSS_GIT_TOKEN_HOST: 'git.example.com' },
        gitEnv: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
      });
      // 127.0.0.1 is not the token's host, so git asks with no token and the host refuses.
      const added = await cli(['notebook', 'add', `${host.origin}/o/r.git`, '--name', 'nb']);
      expect(added.code).not.toBe(0);
      expect((await cli(['notebook', 'ls', '--json'])).json()['notebooks']).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

interface McpReply {
  id: number;
  result: {
    tools?: unknown[];
    structuredContent?: Record<string, unknown> & { results?: { title: string }[] };
    isError?: boolean;
  };
}

describe('penmoss mcp --notebook', () => {
  it('serves the tools over stdio, and pushes what was written when it stops', async () => {
    const remote = bare('mcp');
    const cli = machine('m');
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'ryan']);
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb', '--agent', 'Claude Code']);
    const rpc = (id: number, method: string, params?: unknown) =>
      JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const served = await cli(['mcp', '--notebook', 'nb'], {
      lines: [
        rpc(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '1' },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        rpc(2, 'tools/list'),
        rpc(3, 'tools/call', {
          name: 'create_note',
          arguments: { title: 'From the agent', markdown: 'Hello [[Nowhere]]' },
        }),
        rpc(4, 'tools/call', { name: 'search_notes', arguments: { query: 'hello' } }),
        rpc(5, 'tools/call', {
          name: 'get_history',
          arguments: { id: '01JBAAAAAA0000000000000001' },
        }),
      ],
    });
    expect(served.code).toBe(0);
    const replies = served.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as McpReply);
    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3, 4, 5]);
    expect(replies[1]!.result.tools).toHaveLength(35);
    expect(replies[2]!.result.structuredContent).toMatchObject({ created: true, changed: true });
    expect(replies[3]!.result.structuredContent?.results?.[0]?.title).toBe('From the agent');
    expect(replies[4]!.result.isError).toBe(true);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('From the agent.md');
    expect(git(remote, ['log', '-1', '--format=%an', 'main'])).toBe('Claude Code');
  });

  it('leaves the push to a detached sync when its client stops it with a signal', async () => {
    const remote = bare('mcp-signal');
    // The edit is not pushed before the signal: with a 50 ms push delay, a loaded machine could
    // take longer than that between the reply and the signal, and the server pushed it itself.
    const cli = machine('m', { pushDelayMs: SERVER_PUSH_DELAY_MS });
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'ryan']);
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb', '--agent', 'Claude Code']);
    const call = (id: number, name: string, args: unknown) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'c', version: '1' },
      },
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
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'search_notes', arguments: { query: 'desk' } },
      });
    const create = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { title: 'Agent', markdown: 'x' } },
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

  it('takes the notebook’s own name, as the Mac app shows it, and serves an agent’s clone of it (D52)', async () => {
    const remote = bare('by-name');
    // The notebook is “Quanta” in notebook.json, as the Mac app shows it.
    expect(
      (await machine('mac')(['notebook', 'add', `file://${remote}`, '--name', 'Quanta'])).code,
    ).toBe(0);
    const cli = machine('m');
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'quanta-ryan']);
    await cli([
      'notebook',
      'add',
      `file://${remote}`,
      '--name',
      'quanta-agent',
      '--agent',
      'Agent',
    ]);
    const rpc = (id: number, method: string, params?: unknown) =>
      JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const served = await cli(['mcp', '--notebook', 'Quanta'], {
      lines: [
        rpc(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '1' },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        rpc(2, 'tools/call', {
          name: 'create_note',
          arguments: { title: 'By name', markdown: 'Found it' },
        }),
      ],
    });
    expect(served.code, served.stderr).toBe(0);
    // The agent's clone wrote it, as itself.
    expect(git(remote, ['log', '-1', '--format=%an', 'main'])).toBe('Agent');
    // A person's command takes the person's clone; the name's case does not matter.
    const read = await cli(['cat', 'By name', '--notebook', 'quanta', '--body']);
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout).toBe('Found it\n');
    expect((await cli(['notebook', 'status', 'QUANTA', '--json'])).json()).toMatchObject({
      name: 'quanta-ryan',
    });
    // Two notebooks of one name: the clone's own name says which.
    await machine('mac2')(['notebook', 'add', `file://${bare('other')}`, '--name', 'Quanta']);
    await cli(['notebook', 'add', `file://${join(root, 'other.git')}`, '--name', 'other-quanta']);
    const two = await cli(['cat', 'By name', '--notebook', 'Quanta']);
    expect(two.code).toBe(2);
    expect(two.stderr).toContain('Several git notebooks on this machine are named “Quanta”.');
    expect(two.stderr).toContain('quanta-ryan');
  });

  it('adds only a notebook the target holds already when asked to (D52)', async () => {
    const remote = bare('empty');
    const notebooks = nodeNotebooks({
      home: join(root, 'app'),
      env: {},
      platform: process.platform,
      secrets: memoryTokenStore(),
      gitEnv: GIT_ENV,
    });
    await expect(
      notebooks.add({
        remote: `file://${remote}`,
        branch: 'main',
        dir: '',
        name: 'empty-agent',
        agent: 'Agent',
        existing: true,
      }),
    ).rejects.toMatchObject({ code: 'notebook_not_there' });
    expect(await notebooks.list()).toEqual([]);
    expect(git(remote, ['branch', '--list'])).toBe('');
  });

  it('needs --notebook', async () => {
    const cli = machine('m');
    const usage = await cli(['mcp']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('missing --notebook: name the git notebook to serve');
    const named = await cli(['mcp', '--notebook', 'nb', '--name', 'x']);
    expect(named.code).toBe(2);
    expect(named.stderr).toContain('--name names a channel session: add --channel');
  });

  it('is a channel with --channel: a thread the Mac sends arrives once, then seen reaches the Mac (A1063)', async () => {
    const remote = bare('mcp-channel');
    const cli = machine('m', { channelCheckMs: 50 });
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'ryan']);
    await cli(['notebook', 'add', `file://${remote}`, '--name', 'nb', '--agent', 'Claude Code']);
    // The Mac: a person's clone of its own, over real git.
    const macTransport = new NodeGitTransport({
      gitDir: join(root, 'mac.git'),
      remote: `file://${remote}`,
      branch: 'main',
      root: '',
      author: { name: 'Ryan', email: 'ryan@example.invalid' },
      env: GIT_ENV,
    });
    await macTransport.init();
    const mac = await GitNotebookEngine.open({
      transport: macTransport,
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'device', label: 'Mac' },
    });
    const macOps = new NotebookOps(mac);
    await mac.sync();
    const noteId = macOps.createNote({ title: 'Garden', markdown: 'Plant the garden in May.' });
    await mac.sync();
    const sessions = async () => {
      await mac.sync();
      return readAgentSessions(mac.replica.workspace);
    };
    const rpc = (id: number, method: string, params?: unknown) =>
      JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    let threadId = '';
    const served = await cli(['mcp', '--notebook', 'nb', '--channel', '--name', 'laptop:/garden'], {
      lines: [
        rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        // The session is listed in the notebook; the Mac's Send to… sends the thread to it.
        async () => {
          await vi.waitFor(async () => expect(await sessions()).toHaveLength(1), {
            timeout: 20_000,
            interval: 100,
          });
          const [session] = await sessions();
          expect(session).toMatchObject({
            name: 'laptop:/garden',
            label: 'Claude Code · laptop:/garden',
          });
          threadId = (
            await sendFromMac({ ops: macOps, engine: mac }, noteId, 'garden', {
              writer: session!.writer,
              session: session!.key,
              label: session!.label,
            })
          ).threadId;
          await vi.waitFor(
            async () => {
              await mac.sync();
              expect(deliveryOn({ ops: macOps, engine: mac }, noteId, threadId)).toBe('sent');
            },
            { timeout: 20_000, interval: 100 },
          );
        },
        () => Promise.resolve(),
        rpc(2, 'tools/list'),
      ],
    });
    expect(served.code, served.stderr).toBe(0);
    const messages = served.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages[0]).toMatchObject({
      id: 1,
      result: {
        capabilities: { experimental: { 'claude/channel': {} } },
        instructions: expect.stringContaining('read_comment_thread with its note_id') as string,
      },
    });
    const notified = messages.filter((m) => m['method'] === 'notifications/claude/channel');
    expect(notified).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: expect.stringContaining('Comment:\nmake this tighter') as string,
          meta: { thread_id: threadId, note_id: noteId, comment_id: `${threadId}c1` },
        },
      },
    ]);
    const tools = messages.find((m) => m['id'] === 2) as unknown as McpReply;
    expect(tools.result.tools).toHaveLength(35);

    // Read by Claude in a new run: seen, pushed at once (no detach, nothing left).
    const read = await cli(['mcp', '--notebook', 'nb', '--channel', '--name', 'laptop:/garden'], {
      lines: [
        rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        rpc(2, 'tools/call', { name: 'read_comment_thread', arguments: { id: noteId, threadId } }),
        async () => {
          await vi.waitFor(
            async () => {
              await mac.sync();
              expect(deliveryOn({ ops: macOps, engine: mac }, noteId, threadId)).toBe('seen');
            },
            { timeout: 20_000, interval: 100 },
          );
        },
      ],
    });
    expect(read.code, read.stderr).toBe(0);
    // A restart sends nothing again.
    expect(read.stdout).not.toContain('notifications/claude/channel');
    expect(read.stdout).toContain('"delivery":"seen"');
  });
});

/**
 * Puts a tool on a test's PATH as a script that runs it by its own path. A symlink isn't enough:
 * the Command Line Tools' git (first on PATH in the factory's sandbox, where Apple's /usr/bin/git
 * shim can't run) finds `git-upload-pack` and its templates relative to the path it was started
 * from, so behind a symlink it can't clone.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function onPath(tool: string, at: string): void {
  writeFileSync(at, `#!/bin/sh\nexec '${tool.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
}

describe('the built CLI', () => {
  it('runs a git notebook from the bundle, with credentials in ~/.penmoss and no keychain', () => {
    const bundleDir = join(root, 'bundle');
    execFileSync(process.execPath, [
      fileURLToPath(new URL('../build.js', import.meta.url)),
      bundleDir,
    ]);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // Only git (and on a Mac its tool check) on PATH: no keychain tool, so the file store is used.
    for (const tool of ['git', 'xcode-select']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], {
        encoding: 'utf8',
      }).stdout.trim();
      if (found) onPath(found, join(bin, tool));
    }
    const remote = bare('bundle');
    const penmoss = (args: string[]) =>
      spawnSync(process.execPath, [join(bundleDir, 'penmoss.js'), ...args], {
        env: {
          PATH: bin,
          HOME: join(root, 'h'),
          PENMOSS_HOME: join(root, 'h', '.penmoss'),
          ...GIT_ENV,
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const added = penmoss(['notebook', 'add', `file://${remote}`, '--name', 'nb']);
    // Nothing is said: nobody is asked whether the repository is private (D61).
    expect(added.stderr).toBe('');
    expect(added.status).toBe(0);
    expect(penmoss(['new', 'Bundled', '--notebook', 'nb']).status).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Bundled.md');
    expect(statSync(join(root, 'h', '.penmoss', 'credentials.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, 'h', '.penmoss', 'credentials.json'), 'utf8')).toMatch(
      /"writer:[0-9A-Z]{26}"/,
    );
  }, 120_000);

  it('serves requests piped in at once, and leaves the push to a logged detached sync', async () => {
    const bundleDir = join(root, 'bundle');
    execFileSync(process.execPath, [
      fileURLToPath(new URL('../build.js', import.meta.url)),
      bundleDir,
    ]);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const tool of ['git', 'xcode-select']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], {
        encoding: 'utf8',
      }).stdout.trim();
      if (found) onPath(found, join(bin, tool));
    }
    const remote = bare('piped');
    const home = join(root, 'h', '.penmoss');
    const penmoss = (args: string[], input?: string) =>
      spawnSync(process.execPath, [join(bundleDir, 'penmoss.js'), ...args], {
        env: { PATH: bin, HOME: join(root, 'h'), PENMOSS_HOME: home, ...GIT_ENV },
        encoding: 'utf8',
        timeout: 60_000,
        ...(input === undefined ? {} : { input }),
      });
    expect(penmoss(['notebook', 'add', `file://${remote}`, '--name', 'nb']).status).toBe(0);
    const requests = [
      {
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'p', version: '1' },
        },
      },
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'create_note', arguments: { title: 'Piped', markdown: 'x' } },
      },
      { id: 3, method: 'tools/call', params: { name: 'constructor', arguments: {} } },
    ];
    // Everything is on stdin before the server reads it, and stdin closes at once.
    const served = penmoss(
      ['mcp', '--notebook', 'nb'],
      requests.map((each) => `${JSON.stringify({ jsonrpc: '2.0', ...each })}\n`).join(''),
    );
    expect(served.status).toBe(0);
    const replies = served.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; error?: { message: string } });
    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3]);
    expect(replies[2]!.error?.message).toBe('Unknown tool: constructor');
    expect(served.stderr).toContain('stdin closed: syncing nb in the background');
    const registry = JSON.parse(readFileSync(join(home, 'notebooks.json'), 'utf8')) as {
      notebooks: Array<{ localId: string; name: string }>;
    };
    const log = join(
      home,
      'git',
      registry.notebooks.find((each) => each.name === 'nb')!.localId,
      'detached-sync.log',
    );
    await vi.waitFor(
      () => {
        expect(readFileSync(log, 'utf8')).toMatch(/Synced nb: pushed [0-9a-f]{7}/);
      },
      { timeout: 30_000, interval: 200 },
    );
    expect(readFileSync(log, 'utf8')).toMatch(
      /^--- \d{4}-\d\d-\d\dT.* penmoss notebook sync nb --wait 120$/m,
    );
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Piped.md');
    // The detached sync has gone before its folder is removed (#172): it may still be writing.
    // By its pid from the log, since a sandbox (the factory's) can't list processes for pgrep.
    const pid = Number(/^--- pid (\d+)$/m.exec(readFileSync(log, 'utf8'))?.[1]);
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000, interval: 200 });
  }, 120_000);

  it('keeps an edit when the command is killed during the sync after it (B1 of #165)', async () => {
    const bundleDir = join(root, 'bundle');
    execFileSync(process.execPath, [
      fileURLToPath(new URL('../build.js', import.meta.url)),
      bundleDir,
    ]);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // Only git on PATH (no keychain tool, as above): the CI Macs' keychains stay untouched.
    for (const tool of ['git', 'xcode-select']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], {
        encoding: 'utf8',
      }).stdout.trim();
      if (found) onPath(found, join(bin, tool));
    }
    const sleep = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();
    const remote = bare('killed');
    const home = join(root, 'h', '.penmoss');
    const environment = {
      PATH: bin,
      HOME: join(root, 'h'),
      PENMOSS_HOME: home,
      ...GIT_ENV,
    };
    const penmoss = (args: string[]) =>
      spawnSync(process.execPath, [join(bundleDir, 'penmoss.js'), ...args], {
        env: environment,
        encoding: 'utf8',
        timeout: 60_000,
      });
    expect(penmoss(['notebook', 'add', `file://${remote}`, '--name', 'nb']).status).toBe(0);
    const registry = JSON.parse(readFileSync(join(home, 'notebooks.json'), 'utf8')) as {
      notebooks: Array<{ localId: string; name: string }>;
    };
    const gitDir = join(
      home,
      'git',
      registry.notebooks.find((each) => each.name === 'nb')!.localId,
      'repo.git',
    );
    // The sync before the edit fetches; the fetch of the sync after it hangs, as on a network
    // that stalls.
    const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const hang = join(root, 'hang.sh');
    const hung = join(root, 'hang.pid');
    const once = join(root, 'fetched-once');
    writeFileSync(
      hang,
      `#!/bin/sh\nif [ -e '${once}' ]; then echo $$ > '${hung}'; exec '${sleep}' 30; fi\n: > '${once}'\nexec '${gitPath}' upload-pack "$@"\n`,
      { mode: 0o755 },
    );
    git(gitDir, ['config', 'remote.origin.uploadpack', hang]);
    const child = spawn(
      process.execPath,
      [join(bundleDir, 'penmoss.js'), 'new', 'Survivor', '--notebook', 'nb'],
      {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await new Promise<void>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.includes('Created')) resolve();
      });
      child.on('exit', () => reject(new Error(`exited before the sync: ${out}`)));
    });
    // Inside the sync now (its fetch hangs): killed with no chance to clean up.
    await vi.waitFor(() => expect(statSync(hung).size).toBeGreaterThan(0), {
      timeout: 20_000,
      interval: 50,
    });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    try {
      process.kill(Number(readFileSync(hung, 'utf8').trim()), 'SIGKILL');
    } catch {
      // Gone already.
    }
    git(gitDir, ['config', '--unset', 'remote.origin.uploadpack']);
    const synced = penmoss(['notebook', 'sync', 'nb']);
    expect(synced.stderr).toBe('');
    expect(synced.status).toBe(0);
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'main'])).toContain('Survivor.md');
  }, 120_000);
});
