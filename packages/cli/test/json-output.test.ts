/**
 * The `--json` shapes agents parse, against canned replies of a notebook's local API (the real
 * notebook is in notebook.test.ts), plus exit codes, help, and which notebook a note command
 * runs on (A1050).
 */
import { describe, expect, it } from 'vitest';
import { exitCodeFor, EXIT } from '../src/errors';
import type { FetchLike, Io, NotebookIo, NotebookSyncSummary } from '../src/io';
import { COMMANDS, run } from '../src/main';

const ID = '01JB8Y0V5TQ0QW8KZ9C7N3F2XA';
const T = Date.UTC(2026, 9, 22, 12, 0, 0);
const ISO = '2026-10-22T12:00:00.000Z';

type Route = (body: unknown, url: URL, headers: Record<string, string>) => [number, unknown];

const NOTE = {
  id: ID,
  title: 'Trip',
  tags: ['travel'],
  markdown: '---\nid: x\n---\n## Plans\n\nFly.\n',
  body: '## Plans\n\nFly.\n',
  headings: ['## Plans'],
  baseVersion: 7,
  deleted: false,
};
const EDITED = {
  id: ID,
  changed: true,
  version: { id: 8, summary: 'Appended · +1 lines' },
  baseVersion: 8,
};

const ROUTES: Record<string, Route> = {
  'GET /api/search': () => [
    200,
    {
      mode: 'hybrid',
      results: [
        {
          id: ID,
          title: 'Trip',
          titleHighlighted: '\u0002Trip\u0003',
          snippet: 'We \u0002fly\u0003 on Friday',
          heading: null,
          tags: ['travel'],
          kind: 'note',
          updatedAt: T,
          sources: ['full-text', 'semantic'],
        },
      ],
    },
  ],
  [`GET /api/notes/${ID}/content`]: () => [200, NOTE],
  'POST /api/notes': () => [201, EDITED],
  [`POST /api/notes/${ID}/append`]: () => [200, EDITED],
  [`POST /api/notes/${ID}/section`]: () => [200, EDITED],
  [`POST /api/notes/${ID}/tags`]: () => [200, EDITED],
  [`POST /api/notes/${ID}/move`]: () => [200, { id: ID, folderId: null }],
  'POST /api/daily': () => [
    200,
    { ...NOTE, kind: 'daily', date: '2026-10-22', timeZone: 'America/Chicago', created: false },
  ],
  'GET /api/folders': () => [
    200,
    {
      folder: null,
      folders: [{ id: 'f1', name: 'Projects', path: 'Projects' }],
      notes: [{ id: ID, title: 'Trip', updatedAt: T }],
    },
  ],
  'GET /api/notes': (_, url) => [
    200,
    {
      notes: url.searchParams.has('title')
        ? []
        : [
            {
              id: ID,
              title: 'Trip',
              kind: 'note',
              period: null,
              excerpt: 'Fly.',
              createdAt: T,
              updatedAt: T,
              seq: 3,
              tags: ['travel'],
            },
          ],
    },
  ],
  'GET /api/tags': () => [200, { tags: [{ name: 'travel', notes: 1 }] }],
  [`GET /api/notes/${ID}/versions`]: () => [
    200,
    {
      versions: [
        {
          id: 8,
          createdAt: T,
          actorId: 'a',
          actors: ['a'],
          reason: 'edit',
          summary: 'Appended · +1 lines',
          bytes: 10,
          authors: [{ id: 'a', kind: 'agent', label: 'Codex' }],
        },
      ],
      unversioned: null,
    },
  ],
  [`GET /api/notes/${ID}/versions/8`]: () => [
    200,
    {
      id: 8,
      previousId: 7,
      markdown: '## Plans\n\nFly.\nDrive.\n',
      diff: [
        { op: 'same', line: 'Fly.' },
        { op: 'add', line: 'Drive.' },
      ],
    },
  ],
};

const stubFetch: FetchLike = (url, init) => {
  const parsed = new URL(url);
  const route = ROUTES[`${init.method} ${parsed.pathname}`];
  const [status, body] = route
    ? route(init.body ? JSON.parse(init.body) : undefined, parsed, init.headers)
    : [404, { error: { code: 'not_found', message: 'No such endpoint' } }];
  return Promise.resolve({
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
};

const SYNCED: Omit<NotebookSyncSummary, 'name'> = {
  commit: null,
  head: null,
  pulled: 0,
  purged: 0,
  handEdits: [],
  copies: [],
  skipped: {},
  renderSkipped: false,
  attempts: 1,
  filterIgnored: false,
  warnings: [],
};

/**
 * Git notebooks named `names`, each answering with `fetch` as its local API; `opened` records
 * which one each command ran on and how many syncs it made.
 */
function stubNotebooks(names: readonly string[], fetch: FetchLike) {
  const opened: Array<{ name: string; what: string; syncs: number }> = [];
  const notebooks: Pick<NotebookIo, 'list' | 'session'> = {
    list: () =>
      Promise.resolve(
        names.map((name) => ({
          name,
          localId: `id-${name}`,
          remote: `https://github.com/ryan/${name}.git`,
          branch: 'main',
          dir: '',
          writer: { kind: 'device' as const, label: 'test' },
        })),
      ),
    session: (name, what) => {
      if (!names.includes(name)) return Promise.reject(new Error(`no notebook ${name}`));
      const use = { name, what, syncs: 0 };
      opened.push(use);
      return Promise.resolve({
        fetch,
        sync: () => {
          use.syncs++;
          return Promise.resolve({ ...SYNCED, name });
        },
        close: () => Promise.resolve(),
      });
    },
  };
  return { notebooks: notebooks as NotebookIo, opened };
}

async function penmoss(
  argv: string[],
  stdin = '',
  fetch: FetchLike = stubFetch,
  names: readonly string[] = ['notes'],
) {
  let stdout = '';
  let stderr = '';
  const opened: string[] = [];
  const stub = stubNotebooks(names, fetch);
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

async function json(argv: string[], stdin = '') {
  const ran = await penmoss([...argv, '--json'], stdin);
  expect(ran.stderr).toBe('');
  expect(ran.code).toBe(0);
  return JSON.parse(ran.stdout) as unknown;
}

const EDIT_JSON = { id: ID, changed: true, baseVersion: 8, summary: 'Appended · +1 lines' };

describe('--json output', () => {
  it('gives each command one documented JSON document', async () => {
    expect(await json(['search', 'fly'])).toEqual({
      mode: 'hybrid',
      results: [
        {
          id: ID,
          title: 'Trip',
          snippet: 'We **fly** on Friday',
          tags: ['travel'],
          updatedAt: ISO,
          foundBy: ['full-text', 'semantic'],
        },
      ],
    });
    expect(await json(['cat', ID])).toEqual({
      id: ID,
      title: 'Trip',
      tags: ['travel'],
      headings: ['## Plans'],
      baseVersion: 7,
      markdown: NOTE.markdown,
      body: NOTE.body,
    });
    expect(await json(['new', 'Trip', '-'], 'Fly.\n')).toEqual({
      ...EDIT_JSON,
      title: 'Trip',
      created: true,
    });
    expect(await json(['append', ID, '-'], 'Drive.\n')).toEqual(EDIT_JSON);
    expect(await json(['edit', ID, '--section', 'Plans', '-'], 'Drive.\n')).toEqual(EDIT_JSON);
    expect(await json(['tag', ID, 'x'])).toEqual(EDIT_JSON);
    expect(await json(['mv', ID, '/'])).toEqual({ id: ID, folderId: null });
    expect(await json(['daily'])).toEqual({
      id: ID,
      title: 'Trip',
      tags: ['travel'],
      headings: ['## Plans'],
      baseVersion: 7,
      kind: 'daily',
      date: '2026-10-22',
      timeZone: 'America/Chicago',
      created: false,
      markdown: NOTE.markdown,
      body: NOTE.body,
    });
    expect(await json(['daily', '--append', '-'], 'Done.\n')).toEqual({
      ...EDIT_JSON,
      kind: 'daily',
      date: '2026-10-22',
      created: false,
    });
    expect(await json(['ls'])).toEqual({
      folder: null,
      folders: [{ id: 'f1', name: 'Projects', path: 'Projects' }],
      notes: [{ id: ID, title: 'Trip', updatedAt: ISO }],
    });
    expect(await json(['ls', '--recent'])).toEqual({
      notes: [
        { id: ID, title: 'Trip', kind: 'note', tags: ['travel'], excerpt: 'Fly.', updatedAt: ISO },
      ],
    });
    expect(await json(['ls', '--tags'])).toEqual({ tags: [{ name: 'travel', notes: 1 }] });
    expect(await json(['open', ID])).toEqual({
      id: ID,
      url: `penmoss://note/${ID}`,
      opened: false,
    });
    expect(await json(['history', ID])).toEqual({
      id: ID,
      versions: [
        {
          id: 8,
          createdAt: ISO,
          reason: 'edit',
          summary: 'Appended · +1 lines',
          authors: ['Codex'],
        },
      ],
      unversioned: null,
    });
    expect(await json(['history', ID, '--version', '8'])).toEqual({
      id: ID,
      versionId: 8,
      previousId: 7,
      markdown: '## Plans\n\nFly.\nDrive.\n',
      changes: ['+ Drive.'],
    });
  });

  it('writes errors as JSON on stderr with the exit code, and nothing on stdout', async () => {
    const usage = await penmoss(['cat', '--json']);
    expect(usage.code).toBe(EXIT.USAGE);
    expect(usage.stdout).toBe('');
    expect(JSON.parse(usage.stderr)).toEqual({
      error: { code: 'usage', message: 'missing note' },
      exitCode: 2,
    });
    const missing = await penmoss(['cat', 'Nothing', '--json']);
    expect(missing.code).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(missing.stderr)).toEqual({
      error: { code: 'not_found', message: 'No note titled “Nothing”.' },
      exitCode: 4,
    });
    const conflict: FetchLike = (url, init) =>
      url.endsWith('/section')
        ? Promise.resolve({
            status: 409,
            headers: { get: () => null },
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  error: {
                    code: 'conflict',
                    message: 'The section changed',
                    details: { target: 'Plans', base: 'Fly.', current: 'Sail.' },
                  },
                }),
              ),
          })
        : stubFetch(url, init);
    const ran = await penmoss(
      ['edit', ID, '--section', 'Plans', '-', '--json'],
      'Drive.',
      conflict,
    );
    expect(ran.code).toBe(EXIT.CONFLICT);
    expect(ran.stdout).toBe('');
    expect(JSON.parse(ran.stderr)).toEqual({
      error: {
        code: 'conflict',
        message: 'Conflict: The section changed (conflict).',
        details: { target: 'Plans', base: 'Fly.', current: 'Sail.' },
      },
      exitCode: 5,
    });
    const human = await penmoss(['edit', ID, '--section', 'Plans', '-'], 'Drive.', conflict);
    expect(human.stderr).toContain(
      '--- in version 7, which your edit is based on:\nFly.\n--- now:\nSail.\n',
    );
  });
});

describe('requests', () => {
  it('go to the notebook’s local API, never a network', async () => {
    const urls: string[] = [];
    const watching: FetchLike = (url, init) => {
      urls.push(url);
      return stubFetch(url, init);
    };
    expect((await penmoss(['cat', ID], '', watching)).code).toBe(0);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(new URL(url).origin).toBe('http://notebook.invalid');
  });

  it('daily --append sends no baseVersion, as append never does', async () => {
    const appends: unknown[] = [];
    const watching: FetchLike = (url, init) => {
      if (url.endsWith('/append')) appends.push(JSON.parse(init.body ?? '{}'));
      return stubFetch(url, init);
    };
    const ran = await penmoss(['daily', '--append', 'x', '--heading', 'Plans'], '', watching);
    expect(ran.code).toBe(0);
    expect(appends).toEqual([{ markdown: 'x', heading: 'Plans' }]);
  });

  it('say why the notebook could not store the markdown (422 unsupported_markdown)', async () => {
    const refusing: FetchLike = (url, init) =>
      url.endsWith('/append')
        ? Promise.resolve({
            status: 422,
            headers: { get: () => null },
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  error: {
                    code: 'unsupported_markdown',
                    message: 'The markdown would make a note the apps cannot open',
                    details: { problem: 'Invalid content for node bulletList' },
                  },
                }),
              ),
          })
        : stubFetch(url, init);
    const human = await penmoss(['append', ID, '--text', 'x'], '', refusing);
    expect(human.code).toBe(EXIT.REFUSED);
    expect(human.stderr).toContain('Invalid content for node bulletList');
    const json = await penmoss(['append', ID, '--text', 'x', '--json'], '', refusing);
    expect(JSON.parse(json.stderr)).toMatchObject({
      error: { details: { problem: 'Invalid content for node bulletList' } },
    });
  });
});

describe('the review’s nits', () => {
  it('turns on JSON errors only for a real --json flag', async () => {
    const value = await penmoss(['append', ID, '--text', '--json']);
    expect(value.code).toBe(EXIT.USAGE);
    expect(value.stderr).toMatch(/^penmoss: --text needs a value/);
    const after = await penmoss(['cat', '--', '--json']);
    expect(after.stderr).toMatch(/^penmoss: /);
    const real = await penmoss(['cat', '--json']);
    expect(JSON.parse(real.stderr)).toMatchObject({ exitCode: EXIT.USAGE });
    const late = await penmoss(['append', '--json', ID, '--text']);
    expect(JSON.parse(late.stderr)).toMatchObject({ error: { code: 'usage' } });
  });

  it('counts a title shared by more than 20 notes as more than 20', async () => {
    const many: FetchLike = (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/notes' && parsed.searchParams.has('title')) {
        const limit = Number(parsed.searchParams.get('limit'));
        const notes = Array.from({ length: Math.min(limit, 30) }, (_, i) => ({
          id: `01JB8Y0V5TQ0QW8KZ9C7N3F2${String(i).padStart(2, '0')}`,
          title: 'Log',
          updatedAt: T,
        }));
        return Promise.resolve({
          status: 200,
          headers: { get: () => null },
          text: () => Promise.resolve(JSON.stringify({ notes })),
        });
      }
      return stubFetch(url, init);
    };
    const ran = await penmoss(['cat', 'Log'], '', many);
    expect(ran.code).toBe(EXIT.AMBIGUOUS);
    expect(ran.stderr).toMatch(/“Log” matches more than 20 notes/);
    expect(ran.stderr.split('\n').filter((line) => line.includes('  Log  '))).toHaveLength(20);
    const json = await penmoss(['cat', 'Log', '--json'], '', many);
    const error = (JSON.parse(json.stderr) as { error: { details: Record<string, unknown> } })
      .error;
    expect(error.details['matches']).toHaveLength(20);
    expect(error.details['more']).toBe(true);
  });

  it('mv says it does not create a missing folder', async () => {
    const noFolder: FetchLike = (url, init) =>
      new URL(url).pathname === '/api/folders'
        ? Promise.resolve({
            status: 404,
            headers: { get: () => null },
            text: () =>
              Promise.resolve(
                JSON.stringify({ error: { code: 'folder_not_found', message: 'No such folder' } }),
              ),
          })
        : stubFetch(url, init);
    const ran = await penmoss(['mv', ID, 'Projects/Nope'], '', noFolder);
    expect(ran.code).toBe(EXIT.NOT_FOUND);
    expect(ran.stderr).toMatch(/mv does not create folders/);
  });

  it('ls marks a notebook, and --json passes its notebook through (T43)', async () => {
    const personal = { id: 'default', name: 'Personal' };
    const withNotebook: FetchLike = (url, init) =>
      new URL(url).pathname === '/api/folders'
        ? Promise.resolve({
            status: 200,
            headers: { get: () => null },
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  folder: null,
                  folders: [
                    {
                      id: 'f1',
                      name: 'QDK',
                      path: 'QDK',
                      isNotebook: true,
                      notebook: { id: 'f1', name: 'QDK' },
                    },
                    { id: 'f2', name: 'Home', path: 'Home', isNotebook: false, notebook: personal },
                  ],
                  notes: [],
                }),
              ),
          })
        : stubFetch(url, init);
    const text = await penmoss(['ls'], '', withNotebook);
    expect(text.stdout).toMatch(/^f1 +QDK\/ {2}notebook$/m);
    expect(text.stdout).toMatch(/^f2 +Home\/$/m);
    const listed = JSON.parse((await penmoss(['ls', '--json'], '', withNotebook)).stdout) as {
      folders: unknown[];
    };
    expect(listed.folders[1]).toEqual({
      id: 'f2',
      name: 'Home',
      path: 'Home',
      isNotebook: false,
      notebook: personal,
    });
  });

  it('caps ls --recent --limit', async () => {
    const ran = await penmoss(['ls', '--recent', '--limit', '501']);
    expect(ran.code).toBe(EXIT.USAGE);
    expect(ran.stderr).toMatch(/--limit must be at most 500/);
    expect((await penmoss(['ls', '--recent', '--limit', '500'])).code).toBe(0);
  });

  it('says title matching ignores case for A–Z only', async () => {
    for (const name of ['cat', 'append', 'edit']) {
      const help = (await penmoss([name, '--help'])).stdout.replace(/\s+/g, ' ');
      expect(help).toMatch(/ignoring the case of A–Z only/);
    }
  });
});

describe('exit codes', () => {
  it('map the local API’s refusals by status and code', () => {
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
    const ran = await penmoss(['cat', ID, '--json'], '', stubFetch, ['work']);
    expect(ran.code).toBe(0);
    expect(ran.sessions).toEqual([{ name: 'work', what: 'penmoss cat', syncs: 1 }]);
    const wrote = await penmoss(['append', ID, '--text', 'x'], '', stubFetch, ['work']);
    expect(wrote.code).toBe(0);
    // A change syncs before and after (A821).
    expect(wrote.sessions).toEqual([{ name: 'work', what: 'penmoss append', syncs: 2 }]);
    const quiet = await penmoss(['cat', ID, '--no-sync'], '', stubFetch, ['work']);
    expect(quiet.sessions).toEqual([{ name: 'work', what: 'penmoss cat', syncs: 0 }]);
  });

  it('is the one --notebook names, when there are several', async () => {
    const ran = await penmoss(['ls', '--notebook', 'home'], '', stubFetch, ['work', 'home']);
    expect(ran.code).toBe(0);
    expect(ran.sessions.map((each) => each.name)).toEqual(['home']);
  });

  it('must be named when several are on this machine: a usage error naming them', async () => {
    const ran = await penmoss(['cat', ID], '', stubFetch, ['work', 'home']);
    expect(ran.code).toBe(EXIT.USAGE);
    expect(ran.sessions).toEqual([]);
    expect(ran.stderr).toBe(
      'penmoss: 2 git notebooks are on this machine (work, home): pass --notebook <name>\n' +
        'Run `penmoss cat --help` for usage.\n',
    );
    const json = await penmoss(['new', 'Trip', '--json'], '', stubFetch, ['work', 'home']);
    expect(JSON.parse(json.stderr)).toEqual({
      error: {
        code: 'usage',
        message: '2 git notebooks are on this machine (work, home): pass --notebook <name>',
      },
      exitCode: EXIT.USAGE,
    });
  });

  it('says how to add one when there is none', async () => {
    const ran = await penmoss(['daily', '--json'], '', stubFetch, []);
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
    expect((await penmoss(['cat', '--help'], '', stubFetch, [])).code).toBe(0);
    expect((await penmoss(['--version'], '', stubFetch, [])).code).toBe(0);
    const mcp = await penmoss(['mcp'], '', stubFetch, ['work']);
    expect(mcp.code).toBe(EXIT.USAGE);
    expect(mcp.stderr).toMatch(/missing --notebook/);
  });

  it('opens a note in the Mac app by its penmoss:// link', async () => {
    const ran = await penmoss(['open', ID]);
    expect(ran.code).toBe(0);
    expect(ran.opened).toEqual([`penmoss://note/${ID}`]);
    expect(ran.stdout).toBe(`penmoss://note/${ID}\n`);
  });
});

describe('commands of the Penmoss server (T59)', () => {
  it('are gone: login, whoami, logout, channel, export-personal and verify-personal', async () => {
    for (const name of [
      'login',
      'whoami',
      'logout',
      'channel',
      'export-personal',
      'verify-personal',
    ]) {
      const ran = await penmoss([name]);
      expect(ran.code).toBe(EXIT.USAGE);
      expect(ran.stderr).toMatch(new RegExp(`unknown command “${name}”`));
    }
    const api = await penmoss(['cat', ID, '--api', 'https://api.penmoss.app']);
    expect(api.code).toBe(EXIT.USAGE);
    const help = (await penmoss(['--help'])).stdout;
    expect(help).not.toMatch(/PENMOSS_TOKEN|PENMOSS_API|api\.penmoss\.app|app\.penmoss\.app/);
  });
});
