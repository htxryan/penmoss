/**
 * Git notebooks from the CLI (T50 G2, #150; T59, A1050): what is the CLI's own, over an
 * in-memory host (A1516). `penmoss notebook …`, the note commands on a notebook (`--notebook`,
 * or the only one) and `penmoss mcp --notebook` run as the binary runs them, with the registry,
 * each clone's state and its lock on disk; only git is in memory. What git itself does (tokens,
 * hooks, identity, rewrites, a hung fetch) is `notebook-git.test.ts`, over system git.
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  GitNotebookEngine,
  MemorySecrets,
  MemoryStorage,
  MemoryTransport,
  NotebookOps,
} from '@penmoss/git-notebook';
import { lockNotebook } from '@penmoss/git-notebook/node';
import { MAX_ATTACHMENT_BYTES } from '@penmoss/core/attachments';
import { notebookTag, shortNoteRef } from '@penmoss/core/note-ref';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryTokenStore } from '../src/memory-store';
import { nodeNotebooks } from '../src/node-notebooks';
import {
  deliveryOn,
  readAgentSessions,
  sendFromMac,
} from '../../git-notebook/test/support/comments';
import { markUndoneInStore } from '../../git-notebook/test/support/marks';
import {
  GIT_ENV,
  HANDSHAKE,
  machine as machineAt,
  MemoryHosts,
  rpc,
  testRoot,
  type MachineOptions,
  type McpReply,
} from './support/machine';

const root = testRoot('penmoss-nb-');
let hosts: MemoryHosts;
beforeEach(() => {
  hosts = new MemoryHosts();
});
const machine = (name: string, extra: MachineOptions = {}) =>
  machineAt(root.path, name, { ...extra, hosts });
const remote = (name: string) => hosts.url(name);

describe('penmoss notebook', () => {
  it('runs a note command on the only notebook without --notebook; with two, names them (A1050)', async () => {
    const first = remote('first');
    const cli = machine('one');
    const none = await cli(['ls']);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('no git notebook on this machine: add one with');
    await cli(['notebook', 'add', first, '--name', 'first']);
    const made = await cli(['new', 'Only', '--text', 'here', '--json']);
    expect(made.code, made.stderr).toBe(0);
    const id = made.json()['id'] as string;
    expect((await cli(['cat', id, '--body'])).stdout).toBe('here\n');
    await cli(['notebook', 'add', hosts.url('second'), '--name', 'second']);
    const which = await cli(['cat', id]);
    expect(which.code).toBe(2);
    expect(which.stderr).toContain(
      '2 git notebooks are on this machine (first, second): pass --notebook <name>',
    );
    expect((await cli(['cat', id, '--notebook', 'first', '--body'])).stdout).toBe('here\n');
    expect((await cli(['cat', id, '--notebook', 'second'])).code).toBe(4);
  });

  it('finds the notebook from a short id alone, and penmoss mcp names the notebook a short id is of (PEN-69)', async () => {
    const first = remote('first');
    const cli = machine('refs');
    await cli(['notebook', 'add', first, '--name', 'first']);
    await cli(['notebook', 'add', hosts.url('second'), '--name', 'second']);
    const made = await cli(['new', 'Short', '--text', 'by ref', '--notebook', 'first', '--json']);
    expect(made.code, made.stderr).toBe(0);
    const id = made.json()['id'] as string;
    const listed = await cli(['notebook', 'ls', '--json']);
    const entries = (listed.json()['notebooks'] ?? listed.json()) as unknown as Array<{
      name: string;
      notebookId: string;
    }>;
    const entry = entries.find((each) => each.name === 'first')!;
    const ref = shortNoteRef(entry.notebookId, id);
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
      lines: [rpc(1, 'tools/call', { name: 'read_note', arguments: { id: ref } })],
    });
    const reply = JSON.parse(served.stdout.trim().split('\n')[0]!) as McpReply;
    expect(reply.result.isError).toBe(true);
    expect(JSON.stringify(reply.result)).toContain('penmoss mcp --notebook \\"');
  });

  it('an agent clone never commits an undo mark, even one written into its store (#174 merge check)', async () => {
    const url = remote('marks');
    const agent = machine('agent');
    expect((await agent(['notebook', 'add', url, '--name', 'ryan'])).code).toBe(0);
    expect(
      (await agent(['notebook', 'add', url, '--name', 'work', '--agent', 'Claude Code'])).code,
    ).toBe(0);
    expect((await agent(['mkdir', 'From the agent', '--notebook', 'work'])).code).toBe(0);
    await agent(['notebook', 'sync', 'work']);
    const made = hosts.head(url)!;
    // The agent marks its own change undone "by Ryan", past every command.
    const listed = (await agent(['notebook', 'ls', '--json'])).json()['notebooks'] as Array<{
      name: string;
      localId: string;
    }>;
    const work = listed.find((entry) => entry.name === 'work')!;
    await markUndoneInStore(join(root.path, 'agent', 'git', work.localId), made, 'Ryan');
    const synced = await agent(['notebook', 'sync', 'work']);
    expect(synced.code).not.toBe(0);
    expect(synced.stderr).toContain('only a person marks an agent’s change undone');
    expect(hosts.head(url)).toBe(made);
  });

  it('runs every note command on the notebook', async () => {
    const url = remote('all');
    const cli = machine('m');
    await cli(['notebook', 'add', url, '--name', 'nb']);
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
    const png = join(root.path, 'pic.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const attached = await cli(['attach', '2026-10-29', png, '--notebook', 'nb']);
    expect(attached.stderr).toBe('');
    expect(attached.code).toBe(0);
    const files = hosts.files(url).join('\n');
    expect(files).toMatch(/attachments\/[0-9a-f]{64}\.png/);
    expect(files).toContain('Journal/2026/10/2026-10-29.md');
    expect((await cli(['search', 'x', '--mode', 'semantic', '--notebook', 'nb'])).code).toBe(7);
    // History (G6, A858): the commits that touched the note.
    const history = await cli(['history', 'Beds', '--notebook', 'nb', '--json']);
    expect(history.code).toBe(0);
    expect((history.json()['versions'] as unknown[]).length).toBeGreaterThan(0);
    expect((await cli(['ls', '--notebook', 'nope'])).code).toBe(4);
  });

  it('attaches a file of 50 MB, as the app does, and refuses one byte more (A1533)', async () => {
    const cli = machine('m');
    await cli(['notebook', 'add', remote('big'), '--name', 'nb']);
    const nb = ['--notebook', 'nb', '--no-sync'];
    expect((await cli(['new', 'Scans', '--text', 'x', ...nb])).code).toBe(0);
    // A PDF's first bytes, then zeros: the largest file Penmoss keeps.
    const file = Buffer.alloc(MAX_ATTACHMENT_BYTES);
    file.write('%PDF-1.7\n');
    const largest = join(root.path, 'scan.pdf');
    writeFileSync(largest, file);
    const kept = await cli(['attach', 'Scans', largest, ...nb, '--json']);
    expect(kept.code, kept.stderr).toBe(0);
    expect(kept.json()).toMatchObject({ added: true, bytes: MAX_ATTACHMENT_BYTES });
    const over = join(root.path, 'over.pdf');
    writeFileSync(over, Buffer.concat([file, Buffer.from([1])]));
    const refused = await cli(['attach', 'Scans', over, ...nb]);
    expect(refused.code).toBe(7);
    expect(refused.stderr).toContain('Penmoss keeps files of at most 50 MB');
  });

  it('takes a token only from stdin, and says so when one is put on the command line', async () => {
    const cli = machine('m');
    expect(
      (await cli(['notebook', 'add', 'https://example.com/x.git', '--token', 'secret123'])).code,
    ).toBe(2);
  });

  it('one engine per clone: a held lock is a clear refusal', async () => {
    const url = remote('locked');
    const cli = machine('m');
    const added = (await cli(['notebook', 'add', url, '--name', 'nb', '--json'])).json();
    const lock = await lockNotebook(
      join(root.path, 'm', 'git', added['localId'] as string),
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
    const url = remote('elsewhere');
    const cli = machine('m');
    const added = await cli(['notebook', 'add', url, '--name', 'nb']);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toBe('');
    expect((await cli(['new', 'Unasked', '--notebook', 'nb'])).code).toBe(0);
    expect(hosts.files(url)).toContain('Unasked.md');
    const synced = await cli(['notebook', 'sync', 'nb']);
    expect(synced.code).toBe(0);
    expect(synced.stderr).toBe('');
    // status has no visibility line any more.
    expect((await cli(['notebook', 'status', 'nb'])).stdout).not.toMatch(/visibility/);
    // The confirmation is gone: its flag and its command are unknown.
    const flag = await cli(['notebook', 'add', url, '--name', 'nb2', '--confirm-private']);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain('unknown option --confirm-private');
    expect((await cli(['notebook', 'confirm-private', 'nb'])).code).toBe(2);
    expect((await cli(['notebook', 'ls', '--json'])).json()['notebooks']).toHaveLength(1);
  });

  it('an agent clone of such a repository syncs on its own, and so does its MCP server (D51)', async () => {
    const url = remote('elsewhere');
    const cli = machine('m');
    const added = await cli([
      'notebook',
      'add',
      url,
      '--name',
      'nb-agent',
      '--agent',
      'Claude Code',
    ]);
    expect(added.code, added.stderr).toBe(0);
    const served = await cli(['mcp', '--notebook', 'nb-agent'], {
      lines: [
        rpc(1, 'tools/call', {
          name: 'create_note',
          arguments: { title: 'From the agent', markdown: 'x' },
        }),
      ],
    });
    expect(served.code).toBe(0);
    expect(served.stderr).not.toContain('could not sync');
    expect(hosts.files(url)).toContain('From the agent.md');
  });

  it('loads a registry with an old confirmation or visibility, and the next write leaves them out (D51, D61, A1081)', async () => {
    const url = remote('old');
    const cli = machine('m');
    expect((await cli(['notebook', 'add', url, '--name', 'nb'])).code).toBe(0);
    const registryPath = join(root.path, 'm', 'notebooks.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      notebooks: Array<Record<string, unknown>>;
    };
    // What a CLI before D51 kept for a repository a person confirmed private.
    registry.notebooks[0]!['confirmedPrivate'] = {
      remote: url,
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

  it('turns signing off and on for a notebook', async () => {
    const url = remote('set');
    const cli = machine('m');
    expect((await cli(['notebook', 'add', url, '--name', 'nb'])).code).toBe(0);
    expect((await cli(['notebook', 'set', 'nb', '--no-sign'])).code).toBe(0);
    expect((await cli(['notebook', 'status', 'nb'])).stdout).toMatch(/signing +off/);
    expect((await cli(['notebook', 'set', 'nb', '--sign'])).code).toBe(0);
    expect((await cli(['notebook', 'status', 'nb'])).stdout).toMatch(/signing +as git config says/);
    expect((await cli(['notebook', 'set', 'nb'])).code).toBe(2);
  });

  it('changes a git note’s title with set-title, and edit --replace says the title is not its text (#170 F10)', async () => {
    const url = remote('titles');
    const cli = machine('m');
    await cli(['notebook', 'add', url, '--name', 'nb']);
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
    const files = hosts.files(url);
    expect(files).toContain('Renamed.md');
    expect(files).not.toContain('From the CLI.md');
    expect((await cli(['cat', 'Renamed', '--notebook', 'nb', '--body'])).stdout).toContain('body');
    expect((await cli(['set-title', 'Renamed', '  ', '--notebook', 'nb'])).code).toBe(2);
    // A title of only bidi and format characters is empty too (#174 review).
    expect((await cli(['set-title', 'Renamed', '‮​⁦', '--notebook', 'nb'])).code).toBe(2);
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
});

describe('penmoss mcp --notebook', () => {
  it('serves the tools over stdio, and pushes what was written when it stops', async () => {
    const url = remote('mcp');
    const cli = machine('m');
    await cli(['notebook', 'add', url, '--name', 'ryan']);
    await cli(['notebook', 'add', url, '--name', 'nb', '--agent', 'Claude Code']);
    const served = await cli(['mcp', '--notebook', 'nb'], {
      lines: [
        ...HANDSHAKE,
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
    expect(hosts.files(url)).toContain('From the agent.md');
    expect(hosts.log(url)[0]!.author).toBe('Claude Code');
  });

  it('takes the notebook’s own name, as the Mac app shows it, and serves an agent’s clone of it (D52)', async () => {
    const url = remote('by-name');
    // The notebook is “Quanta” in notebook.json, as the Mac app shows it.
    expect((await machine('mac')(['notebook', 'add', url, '--name', 'Quanta'])).code).toBe(0);
    const cli = machine('m');
    await cli(['notebook', 'add', url, '--name', 'quanta-ryan']);
    await cli(['notebook', 'add', url, '--name', 'quanta-agent', '--agent', 'Agent']);
    const served = await cli(['mcp', '--notebook', 'Quanta'], {
      lines: [
        ...HANDSHAKE,
        rpc(2, 'tools/call', {
          name: 'create_note',
          arguments: { title: 'By name', markdown: 'Found it' },
        }),
      ],
    });
    expect(served.code, served.stderr).toBe(0);
    // The agent's clone wrote it, as itself.
    expect(hosts.log(url)[0]!.author).toBe('Agent');
    // A person's command takes the person's clone; the name's case does not matter.
    const read = await cli(['cat', 'By name', '--notebook', 'quanta', '--body']);
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout).toBe('Found it\n');
    expect((await cli(['notebook', 'status', 'QUANTA', '--json'])).json()).toMatchObject({
      name: 'quanta-ryan',
    });
    // Two notebooks of one name: the clone's own name says which.
    await machine('mac2')(['notebook', 'add', hosts.url('other'), '--name', 'Quanta']);
    await cli(['notebook', 'add', hosts.url('other'), '--name', 'other-quanta']);
    const two = await cli(['cat', 'By name', '--notebook', 'Quanta']);
    expect(two.code).toBe(2);
    expect(two.stderr).toContain('Several git notebooks on this machine are named “Quanta”.');
    expect(two.stderr).toContain('quanta-ryan');
  });

  it('still takes a renamed notebook’s old name, and a notebook named that now comes first (Ryan’s review of PR #192)', async () => {
    const url = remote('renamed');
    expect((await machine('mac')(['notebook', 'add', url, '--name', 'Quanta'])).code).toBe(0);
    const cli = machine('m');
    await cli(['notebook', 'add', url, '--name', 'quanta-agent', '--agent', 'Agent']);
    // Renamed on another device: notebook.json's name, pushed like any change.
    const host = hosts.remote(url);
    const info = JSON.parse(
      new TextDecoder().decode(host.read(hosts.head(url)!, '.penmoss/notebook.json')),
    ) as Record<string, unknown>;
    await host.commitAs('main', {
      '.penmoss/notebook.json': `${JSON.stringify({ ...info, name: 'Quanta (old)' }, null, 2)}\n`,
    });
    expect((await cli(['notebook', 'sync', 'quanta-agent'])).code).toBe(0);
    const listed = (await cli(['notebook', 'ls', '--json'])).json() as {
      notebooks: Array<Record<string, unknown>>;
    };
    expect(listed.notebooks.find((each) => each['name'] === 'quanta-agent')).toMatchObject({
      notebookName: 'Quanta (old)',
      formerNames: ['Quanta'],
    });
    // The new name and the old one, any case, both find it: an agent's MCP config keeps working.
    expect((await cli(['notebook', 'status', 'quanta (OLD)', '--json'])).json()).toMatchObject({
      name: 'quanta-agent',
    });
    expect((await cli(['notebook', 'status', 'Quanta', '--json'])).json()).toMatchObject({
      name: 'quanta-agent',
    });
    // Another notebook named Quanta now: the current name wins over the former one.
    await machine('mac2')(['notebook', 'add', hosts.url('new-quanta'), '--name', 'Quanta']);
    await cli(['notebook', 'add', hosts.url('new-quanta'), '--name', 'new-quanta']);
    expect((await cli(['notebook', 'status', 'Quanta', '--json'])).json()).toMatchObject({
      name: 'new-quanta',
    });
  });

  it('a clone told its notebook’s new name by the Mac app keeps the old one too (Ryan’s review of PR #192)', async () => {
    const url = remote('told');
    expect((await machine('mac')(['notebook', 'add', url, '--name', 'Personal'])).code).toBe(0);
    const cli = machine('m');
    await cli(['notebook', 'add', url, '--name', 'personal-agent', '--agent', 'Agent']);
    const notebooks = nodeNotebooks({
      home: join(root.path, 'm'),
      env: {},
      platform: process.platform,
      secrets: memoryTokenStore(),
      gitEnv: GIT_ENV,
      transport: hosts.transport,
    });
    await notebooks.set('personal-agent', { notebookName: 'Personal (2)' });
    const entry = (await notebooks.list()).find((each) => each.name === 'personal-agent');
    expect(entry).toMatchObject({ notebookName: 'Personal (2)', formerNames: ['Personal'] });
    for (const name of ['Personal (2)', 'Personal', 'personal-agent']) {
      expect((await cli(['notebook', 'status', name, '--json'])).json()).toMatchObject({
        name: 'personal-agent',
      });
    }
  });

  it('adds only a notebook the target holds already when asked to (D52)', async () => {
    const url = remote('empty');
    const notebooks = nodeNotebooks({
      home: join(root.path, 'app'),
      env: {},
      platform: process.platform,
      secrets: memoryTokenStore(),
      gitEnv: GIT_ENV,
      transport: hosts.transport,
    });
    await expect(
      notebooks.add({
        remote: url,
        branch: 'main',
        dir: '',
        name: 'empty-agent',
        agent: 'Agent',
        existing: true,
      }),
    ).rejects.toMatchObject({ code: 'notebook_not_there' });
    expect(await notebooks.list()).toEqual([]);
    expect(hosts.head(url)).toBeNull();
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
    const url = remote('mcp-channel');
    const cli = machine('m', { channelCheckMs: 50 });
    await cli(['notebook', 'add', url, '--name', 'ryan']);
    await cli(['notebook', 'add', url, '--name', 'nb', '--agent', 'Claude Code']);
    // The Mac: a person's clone of its own, on the same host.
    const mac = await GitNotebookEngine.open({
      transport: new MemoryTransport({
        remote: hosts.remote(url),
        branch: 'main',
        root: '',
        author: { name: 'Ryan', email: 'ryan@example.invalid' },
      }),
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
