/**
 * The `--json` shapes agents parse, from real notebooks in memory (a `LocalNotebook` over the
 * engine and `MemoryTransport`; `notebook.test.ts` runs them over system git), plus exit codes,
 * help, and which notebook a note command runs on (A1050).
 */
import { LocalError } from '@penmoss/git-notebook/local';
import { describe, expect, it, vi } from 'vitest';
import { exitCodeFor, EXIT } from '../src/errors';
import type { Io } from '../src/io';
import { COMMANDS, run } from '../src/main';
import { memoryNotebook, memoryNotebooks, type MemoryNotebook } from './support/memory-notebooks';

/** A folder's id, as `mkdir` would make one. */
const PROJECTS = '01JB8Y0V5TQ0QW8KZ9C7N3F2FA';

/** A notebook named `notes` holding the folder Projects and the note Trip, committed once. */
async function tripNotebook(name = 'notes') {
  const nb = await memoryNotebook(name);
  nb.notebook.createFolder({ id: PROJECTS, name: 'Projects', parentId: null });
  const trip = nb.notebook.create({
    title: 'Trip',
    markdown: '## Plans\n\nFly.\n',
    tags: ['travel'],
  }).reply;
  await nb.engine.sync();
  nb.tick();
  return { nb, id: trip.id };
}

async function penmoss(argv: string[], stdin = '', on: readonly MemoryNotebook[] = []) {
  let stdout = '';
  let stderr = '';
  const opened: string[] = [];
  const stub = memoryNotebooks(on);
  const io: Io = {
    env: {},
    stdin: { isTTY: false, read: () => Promise.resolve(stdin) },
    stdout: { isTTY: false, write: (text) => void (stdout += text) },
    stderr: { write: (text) => void (stderr += text) },
    openUrl: (url) => (opened.push(url), Promise.resolve(true)),
    notebooks: stub.notebooks,
  };
  const code = await run(argv, io);
  return { code, stdout, stderr, opened, sessions: stub.opened };
}

/** `argv --json` on `nb`, which must succeed with nothing on stderr: its one JSON document. */
async function json(nb: MemoryNotebook, argv: string[], stdin = '') {
  const ran = await penmoss([...argv, '--json'], stdin, [nb]);
  expect(ran.stderr).toBe('');
  expect(ran.code).toBe(0);
  return JSON.parse(ran.stdout) as unknown;
}

/** 22 Oct 2026, 12:00 UTC (the notebooks' clock starts there) and a minute after it. */
const NOON = '2026-10-22T12:00:00.000Z';
const NOON_1 = '2026-10-22T12:01:00.000Z';

describe('--json output', () => {
  it('gives each command one documented JSON document', async () => {
    const { nb, id } = await tripNotebook();
    expect(await json(nb, ['search', 'fly'])).toEqual({
      mode: 'full-text',
      results: [
        {
          id,
          title: 'Trip',
          snippet: 'Plans\n**Fly**',
          tags: ['travel'],
          updatedAt: '2026-10-22T12:00:00.001Z',
          foundBy: ['full-text'],
        },
      ],
      notice: 'A git notebook searches words only: these are keyword results.',
    });
    const markdown = `---\nid: ${id}\ntitle: Trip\ncreated: 2026-10-22T07:00:00-05:00\nupdated: 2026-10-22T07:00:00-05:00\ntags: [travel]\n---\n\n## Plans\n\nFly.\n`;
    expect(await json(nb, ['cat', id])).toEqual({
      id,
      title: 'Trip',
      tags: ['travel'],
      headings: ['## Plans'],
      baseVersion: 4,
      markdown,
      body: '## Plans\n\nFly.\n',
    });
    const made = (await json(nb, ['new', 'Packing', '-'], 'Socks.\n')) as { id: string };
    expect(made).toEqual({
      id: made.id,
      title: 'Packing',
      created: true,
      changed: true,
      baseVersion: 3,
      summary: 'Created · +1 −0 line',
    });
    expect(made.id).not.toBe(id);
    expect(await json(nb, ['append', id, '-'], 'Drive.\n')).toEqual({
      id,
      changed: true,
      baseVersion: 5,
      summary: 'Appended · +1 −0 line',
    });
    expect(await json(nb, ['edit', id, '--section', 'Plans', '-'], 'Sail.\n')).toEqual({
      id,
      changed: true,
      baseVersion: 7,
      summary: 'Replaced section “Plans” · +1 −2 lines',
    });
    expect(await json(nb, ['tag', id, 'x'])).toEqual({
      id,
      changed: true,
      baseVersion: 8,
      summary: 'Tagged · Tags changed',
    });
    expect(await json(nb, ['mv', id, 'Projects'])).toEqual({ id, folderId: PROJECTS });
    expect(await json(nb, ['mv', id, '/'])).toEqual({ id, folderId: null });
    const daily = (await json(nb, ['daily'])) as { id: string };
    expect(daily).toEqual({
      id: daily.id,
      title: '2026-10-22',
      tags: [],
      headings: ['## Plan', '## Notes'],
      baseVersion: 2,
      kind: 'daily',
      date: '2026-10-22',
      timeZone: 'America/Chicago',
      created: true,
      markdown: `---\nid: ${daily.id}\ntitle: 2026-10-22\ncreated: 2026-10-22\nupdated: 2026-10-22T12:01:00Z\ntype: daily\n---\n\n## Plan\n\n## Notes\n`,
      body: '## Plan\n\n## Notes\n',
    });
    expect(await json(nb, ['daily', '--append', '-'], 'Done.\n')).toEqual({
      id: daily.id,
      changed: true,
      baseVersion: 4,
      summary: 'Appended · +1 −0 line',
      kind: 'daily',
      date: '2026-10-22',
      created: false,
    });
    const journal = nb.notebook.listFolder({ path: 'Journal' }).folder!.id;
    expect(await json(nb, ['ls'])).toEqual({
      folder: null,
      folders: [
        { id: PROJECTS, name: 'Projects', path: 'Projects' },
        { id: journal, name: 'Journal', path: 'Journal' },
      ],
      notes: [
        { id: made.id, title: 'Packing', updatedAt: '2026-10-22T12:01:00.001Z' },
        { id, title: 'Trip', updatedAt: NOON_1 },
      ],
    });
    expect(await json(nb, ['ls', '--recent', '--limit', '2'])).toEqual({
      notes: [
        {
          id: made.id,
          title: 'Packing',
          kind: 'note',
          tags: [],
          excerpt: 'Socks.',
          updatedAt: '2026-10-22T12:01:00.001Z',
        },
        {
          id,
          title: 'Trip',
          kind: 'note',
          tags: ['travel', 'x'],
          excerpt: 'Plans Sail.',
          updatedAt: NOON_1,
        },
      ],
    });
    expect(await json(nb, ['ls', '--tags'])).toEqual({
      tags: [
        { name: 'travel', notes: 1 },
        { name: 'x', notes: 1 },
      ],
    });
    expect(await json(nb, ['open', id])).toEqual({
      id,
      url: `penmoss://note/${id}`,
      opened: false,
    });
    // Each command synced after its change (A821): a version each.
    const version = (id: number, summary: string, createdAt = NOON_1) => ({
      id,
      createdAt,
      reason: 'edit',
      summary,
      authors: ['Codex'],
    });
    expect(await json(nb, ['history', id])).toEqual({
      id,
      versions: [
        version(4, 'Tags changed'),
        version(3, '+1 −2 lines'),
        version(2, '+1 −0 line'),
        version(1, '+2 −0 lines', NOON),
      ],
      unversioned: null,
    });
    expect(await json(nb, ['history', id, '--version', '3'])).toEqual({
      id,
      versionId: 3,
      previousId: 2,
      markdown: '---\ntitle: Trip\ntags: [travel]\n---\n\n## Plans\n\nSail.\n',
      changes: ['- Fly.', '- ', '- Drive.', '+ Sail.'],
    });
  });

  it('writes errors as JSON on stderr with the exit code, and nothing on stdout', async () => {
    const { nb, id } = await tripNotebook();
    const usage = await penmoss(['cat', '--json'], '', [nb]);
    expect(usage.code).toBe(EXIT.USAGE);
    expect(usage.stdout).toBe('');
    expect(JSON.parse(usage.stderr)).toEqual({
      error: { code: 'usage', message: 'missing note' },
      exitCode: 2,
    });
    const missing = await penmoss(['cat', 'Nothing', '--json'], '', [nb]);
    expect(missing.code).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(missing.stderr)).toEqual({
      error: { code: 'not_found', message: 'No note titled “Nothing”.' },
      exitCode: 4,
    });
    // The section changes after the version the edit is based on: the edit is refused.
    const { baseVersion } = nb.notebook.content(id);
    nb.notebook.edit(
      id,
      { op: 'section', heading: 'Plans', markdown: 'Sail.\n', mode: 'replace' },
      null,
    );
    const base = String(baseVersion);
    const edit = ['edit', id, '--section', 'Plans', '-', '--base', base];
    const ran = await penmoss([...edit, '--json'], 'Drive.', [nb]);
    expect(ran.code).toBe(EXIT.CONFLICT);
    expect(ran.stdout).toBe('');
    expect(JSON.parse(ran.stderr)).toEqual({
      error: {
        code: 'conflict',
        message:
          'Conflict: The section “Plans” changed since the base version; read the note again (conflict).',
        details: {
          target: 'The section “Plans”',
          base: '## Plans\n\nFly.\n',
          current: '## Plans\n\nSail.\n',
        },
      },
      exitCode: 5,
    });
    const human = await penmoss(edit, 'Drive.', [nb]);
    expect(human.stderr).toContain(
      `--- in version ${base}, which your edit is based on:\n## Plans\n\nFly.\n--- now:\n## Plans\n\nSail.\n`,
    );
    expect(nb.notebook.content(id).body).toBe('## Plans\n\nSail.\n');
  });
});

describe('the notes API', () => {
  it('saves the clone after every change, refused or not, and never after a read', async () => {
    const { nb, id } = await tripNotebook();
    const read = await penmoss(['cat', id], '', [nb]);
    expect(read.sessions).toMatchObject([{ saves: 0 }]);
    const wrote = await penmoss(['append', id, '--text', 'x'], '', [nb]);
    expect(wrote.sessions).toMatchObject([{ saves: 1 }]);
    const refused = await penmoss(['append', id, '--text', 'x', '--heading', 'Nope'], '', [nb]);
    expect(refused.code).toBe(EXIT.NOT_FOUND);
    expect(refused.stderr).toContain('The note’s headings: ## Plans.');
    expect(refused.sessions).toMatchObject([{ saves: 1 }]);
  });

  it('daily --append passes no baseVersion, as append never does', async () => {
    const nb = await memoryNotebook();
    const edit = vi.spyOn(nb.notebook, 'edit');
    const ran = await penmoss(['daily', '--append', 'x', '--heading', 'Plan'], '', [nb]);
    expect(ran.code).toBe(0);
    expect(edit.mock.calls.map(([, op, base]) => [op, base])).toEqual([
      [{ op: 'append', markdown: 'x', heading: 'Plan' }, null],
    ]);
  });

  it('say why the notebook could not store the markdown (422 unsupported_markdown)', async () => {
    const { nb, id } = await tripNotebook();
    // A backstop the codec never reaches (A159): the notebook's refusal, as it gives it.
    vi.spyOn(nb.notebook, 'edit').mockImplementation(() => {
      throw new LocalError(
        422,
        'unsupported_markdown',
        'The markdown would make a note the apps cannot open',
        { problem: 'Invalid content for node bulletList' },
      );
    });
    const human = await penmoss(['append', id, '--text', 'x'], '', [nb]);
    expect(human.code).toBe(EXIT.REFUSED);
    expect(human.stderr).toContain('Invalid content for node bulletList');
    const json = await penmoss(['append', id, '--text', 'x', '--json'], '', [nb]);
    expect(JSON.parse(json.stderr)).toMatchObject({
      error: { details: { problem: 'Invalid content for node bulletList' } },
    });
  });
});

describe('the review’s nits', () => {
  it('turns on JSON errors only for a real --json flag', async () => {
    const { nb, id } = await tripNotebook();
    const value = await penmoss(['append', id, '--text', '--json'], '', [nb]);
    expect(value.code).toBe(EXIT.USAGE);
    expect(value.stderr).toMatch(/^penmoss: --text needs a value/);
    const after = await penmoss(['cat', '--', '--json'], '', [nb]);
    expect(after.stderr).toMatch(/^penmoss: /);
    const real = await penmoss(['cat', '--json'], '', [nb]);
    expect(JSON.parse(real.stderr)).toMatchObject({ exitCode: EXIT.USAGE });
    const late = await penmoss(['append', '--json', id, '--text'], '', [nb]);
    expect(JSON.parse(late.stderr)).toMatchObject({ error: { code: 'usage' } });
  });

  it('counts a title shared by more than 20 notes as more than 20', async () => {
    const nb = await memoryNotebook();
    for (let i = 0; i < 30; i++) nb.notebook.create({ title: 'Log' });
    const ran = await penmoss(['cat', 'Log'], '', [nb]);
    expect(ran.code).toBe(EXIT.AMBIGUOUS);
    expect(ran.stderr).toMatch(/“Log” matches more than 20 notes/);
    expect(ran.stderr.split('\n').filter((line) => line.includes('  Log  '))).toHaveLength(20);
    const json = await penmoss(['cat', 'Log', '--json'], '', [nb]);
    const error = (JSON.parse(json.stderr) as { error: { details: Record<string, unknown> } })
      .error;
    expect(error.details['matches']).toHaveLength(20);
    expect(error.details['more']).toBe(true);
  });

  it('mv says it does not create a missing folder', async () => {
    const { nb, id } = await tripNotebook();
    const ran = await penmoss(['mv', id, 'Projects/Nope'], '', [nb]);
    expect(ran.code).toBe(EXIT.NOT_FOUND);
    expect(ran.stderr).toMatch(/mv does not create folders/);
    expect(nb.notebook.describe(id)!.folderId).toBeNull();
  });

  it('ls lists each folder by id and name, and --json passes the folders through', async () => {
    const nb = await memoryNotebook();
    const QDK = '01JB8Y0V5TQ0QW8KZ9C7N3F2F1';
    const HOME = '01JB8Y0V5TQ0QW8KZ9C7N3F2F2';
    nb.notebook.createFolder({ id: QDK, name: 'QDK', parentId: null });
    nb.notebook.createFolder({ id: HOME, name: 'Home', parentId: null });
    const text = await penmoss(['ls'], '', [nb]);
    expect(text.stdout).toMatch(new RegExp(`^${QDK} +QDK/$`, 'm'));
    expect(text.stdout).toMatch(new RegExp(`^${HOME} +Home/$`, 'm'));
    const listed = JSON.parse((await penmoss(['ls', '--json'], '', [nb])).stdout) as {
      folders: unknown[];
    };
    expect(listed.folders).toEqual([
      { id: QDK, name: 'QDK', path: 'QDK' },
      { id: HOME, name: 'Home', path: 'Home' },
    ]);
  });

  it('caps ls --recent --limit', async () => {
    const nb = await memoryNotebook();
    const ran = await penmoss(['ls', '--recent', '--limit', '501'], '', [nb]);
    expect(ran.code).toBe(EXIT.USAGE);
    expect(ran.stderr).toMatch(/--limit must be at most 500/);
    expect((await penmoss(['ls', '--recent', '--limit', '500'], '', [nb])).code).toBe(0);
  });

  it('says title matching ignores case for A–Z only', async () => {
    for (const name of ['cat', 'append', 'edit']) {
      const help = (await penmoss([name, '--help'])).stdout.replace(/\s+/g, ' ');
      expect(help).toMatch(/ignoring the case of A–Z only/);
    }
  });
});

describe('exit codes', () => {
  it('map the notes API’s refusals by status and code', () => {
    expect(exitCodeFor(403, 'setting_not_allowed')).toBe(EXIT.AUTH);
    expect(exitCodeFor(403, 'agent_not_allowed')).toBe(EXIT.AUTH);
    expect(exitCodeFor(404, 'not_found')).toBe(EXIT.NOT_FOUND);
    expect(exitCodeFor(422, 'heading_not_found')).toBe(EXIT.NOT_FOUND);
    expect(exitCodeFor(422, 'text_not_found')).toBe(EXIT.NOT_FOUND);
    expect(exitCodeFor(422, 'heading_ambiguous')).toBe(EXIT.AMBIGUOUS);
    expect(exitCodeFor(422, 'text_ambiguous')).toBe(EXIT.AMBIGUOUS);
    expect(exitCodeFor(409, 'conflict')).toBe(EXIT.CONFLICT);
    expect(exitCodeFor(409, 'base_unknown')).toBe(EXIT.CONFLICT);
    expect(exitCodeFor(428, 'base_required')).toBe(EXIT.REFUSED);
    expect(exitCodeFor(413, 'too_large')).toBe(EXIT.REFUSED);
    expect(exitCodeFor(500, 'internal')).toBe(EXIT.ERROR);
  });
});

describe('help', () => {
  it('every command has --help, and help <command> says the same', async () => {
    for (const command of COMMANDS) {
      const own = await penmoss([command.name, '--help']);
      expect(own.code).toBe(0);
      expect(own.stdout).toMatch(new RegExp(`^Usage: penmoss ${command.name}`));
      expect(own.stdout).toContain('--json');
      expect((await penmoss(['help', command.name])).stdout).toBe(own.stdout);
    }
    const main = await penmoss(['--help']);
    expect(main.stdout).toMatch(/Exit codes:/);
    for (let code = 0; code <= 7; code++) expect(main.stdout).toContain(`  ${code}  `);
    const unknown = await penmoss(['frobnicate']);
    expect(unknown.code).toBe(EXIT.USAGE);
    expect(unknown.stderr).toMatch(/unknown command “frobnicate”/);
  });
});

describe('the notebook a note command runs on (A1050)', () => {
  it('is the only git notebook on this machine when --notebook is not given', async () => {
    const { nb, id } = await tripNotebook('work');
    const ran = await penmoss(['cat', id, '--json'], '', [nb]);
    expect(ran.code).toBe(0);
    expect(ran.sessions).toEqual([{ name: 'work', what: 'penmoss cat', syncs: 1, saves: 0 }]);
    const wrote = await penmoss(['append', id, '--text', 'x'], '', [nb]);
    expect(wrote.code).toBe(0);
    // A change syncs before and after (A821).
    expect(wrote.sessions).toEqual([{ name: 'work', what: 'penmoss append', syncs: 2, saves: 1 }]);
    const quiet = await penmoss(['cat', id, '--no-sync'], '', [nb]);
    expect(quiet.sessions).toEqual([{ name: 'work', what: 'penmoss cat', syncs: 0, saves: 0 }]);
  });

  it('is the one --notebook names, when there are several', async () => {
    const on = [await memoryNotebook('work'), await memoryNotebook('home')];
    const ran = await penmoss(['ls', '--notebook', 'home'], '', on);
    expect(ran.code).toBe(0);
    expect(ran.sessions.map((each) => each.name)).toEqual(['home']);
  });

  it('must be named when several are on this machine: a usage error naming them', async () => {
    const on = [await memoryNotebook('work'), await memoryNotebook('home')];
    const ran = await penmoss(['cat', 'Trip'], '', on);
    expect(ran.code).toBe(EXIT.USAGE);
    expect(ran.sessions).toEqual([]);
    expect(ran.stderr).toBe(
      'penmoss: 2 git notebooks are on this machine (work, home): pass --notebook <name>\n' +
        'Run `penmoss cat --help` for usage.\n',
    );
    const json = await penmoss(['new', 'Trip', '--json'], '', on);
    expect(JSON.parse(json.stderr)).toEqual({
      error: {
        code: 'usage',
        message: '2 git notebooks are on this machine (work, home): pass --notebook <name>',
      },
      exitCode: EXIT.USAGE,
    });
  });

  it('says how to add one when there is none', async () => {
    const ran = await penmoss(['daily', '--json']);
    expect(ran.code).toBe(EXIT.USAGE);
    expect(JSON.parse(ran.stderr)).toMatchObject({
      error: {
        code: 'usage',
        message:
          'no git notebook on this machine: add one with `penmoss notebook add <remote>` (see `penmoss notebook --help`)',
      },
    });
  });

  it('is not looked for by help, or by commands that are not about notes', async () => {
    const work = [await memoryNotebook('work')];
    expect((await penmoss(['cat', '--help'])).code).toBe(0);
    expect((await penmoss(['--version'])).code).toBe(0);
    const mcp = await penmoss(['mcp', '--name', 'x'], '', work);
    expect(mcp.code).toBe(EXIT.USAGE);
    expect(mcp.stderr).toMatch(/--name names a channel session/);
  });

  it('opens a note in the Mac app by its penmoss:// link', async () => {
    const { nb, id } = await tripNotebook();
    const ran = await penmoss(['open', id], '', [nb]);
    expect(ran.code).toBe(0);
    expect(ran.opened).toEqual([`penmoss://note/${id}`]);
    expect(ran.stdout).toBe(`penmoss://note/${id}\n`);
  });
});

describe('commands of the Penmoss server (T59)', () => {
  it('are gone: login, whoami, logout, channel, export-personal and verify-personal', async () => {
    const on = [await memoryNotebook()];
    for (const name of [
      'login',
      'whoami',
      'logout',
      'channel',
      'export-personal',
      'verify-personal',
    ]) {
      const ran = await penmoss([name], '', on);
      expect(ran.code).toBe(EXIT.USAGE);
      expect(ran.stderr).toMatch(new RegExp(`unknown command “${name}”`));
    }
    const api = await penmoss(['cat', 'Trip', '--api', 'https://api.penmoss.app'], '', on);
    expect(api.code).toBe(EXIT.USAGE);
    const help = (await penmoss(['--help'])).stdout;
    expect(help).not.toMatch(/PENMOSS_TOKEN|PENMOSS_API|api\.penmoss\.app|app\.penmoss\.app/);
  });
});
