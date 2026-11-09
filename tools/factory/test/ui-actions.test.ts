import { readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Gh } from '../src/github.ts';
import { createWriter, parseAction, type Writer } from '../src/ui/actions.ts';
import type { LinearClient } from '../src/tracker/linear-client.ts';
import { githubOwner, linearOwner } from '../src/ui/owner.ts';
import { pageHtml } from '../src/ui/page.ts';
import { createUiServer, listen } from '../src/ui/server.ts';
import { linearConfig, RYAN_LINEAR, testConfig } from './helpers.ts';

const config = testConfig();

/** A fake gh holding one card (#5, Planning) whose Blocked field is set or not. */
function fakeGh(blocked: boolean) {
  const calls: string[] = [];
  const gh: Gh = {
    run: (args, input) => {
      calls.push(`${args.slice(0, 3).join(' ')}: ${input ?? ''}`);
      return Promise.resolve('');
    },
    json: () => Promise.reject(new Error('unused')),
    graphql: <T>(query: string) => {
      if (query.includes('clearProjectV2ItemFieldValue')) calls.push('clear Blocked');
      else if (query.includes('updateProjectV2ItemFieldValue')) calls.push('set Blocked');
      else
        return Promise.resolve({
          user: {
            projectV2: {
              id: 'P',
              fields: {
                nodes: [
                  { id: 'S', name: 'Status', options: [{ id: 's1', name: 'Planning' }] },
                  { id: 'B', name: 'Blocked', options: [{ id: 'b1', name: 'Blocked' }] },
                ],
              },
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'PVTI_5',
                    content: {
                      number: 5,
                      title: 'X',
                      url: 'u',
                      state: 'OPEN',
                      repository: { nameWithOwner: config.repo },
                      author: { login: 'htxryan' },
                      labels: { nodes: [] },
                    },
                    fieldValues: {
                      nodes: [
                        { name: 'Planning', field: { name: 'Status' } },
                        ...(blocked ? [{ name: 'Blocked', field: { name: 'Blocked' } }] : []),
                      ],
                    },
                  },
                ],
              },
            },
          },
        } as T);
      return Promise.resolve({} as T);
    },
  };
  return { gh, calls };
}

describe("the UI's writes, as Ryan (F21)", () => {
  it('posts a reply, then clears Blocked when asked', async () => {
    const { gh, calls } = fakeGh(true);
    const done = await createWriter(config, githubOwner(config, gh)).perform({
      kind: 'reply',
      issue: 5,
      text: 'A sheet',
      unblock: true,
    });
    expect(calls).toEqual(['issue comment 5: A sheet', 'clear Blocked']);
    expect(done).toBe('Posted, and Blocked cleared');
  });
  it('posts a reply and leaves Blocked alone without unblock', async () => {
    const { gh, calls } = fakeGh(true);
    await createWriter(config, githubOwner(config, gh)).perform({
      kind: 'reply',
      issue: 5,
      text: 'Thinking',
      unblock: false,
    });
    expect(calls).toEqual(['issue comment 5: Thinking']);
  });
  it('posts a picked answer in the form the session reads, and unblocks', async () => {
    const { gh, calls } = fakeGh(true);
    await createWriter(config, githubOwner(config, gh)).perform({
      kind: 'answer',
      issue: 5,
      question: 'Sheet or full screen?',
      option: 'Sheet',
    });
    expect(calls).toEqual(['issue comment 5: On "Sheet or full screen?": Sheet', 'clear Blocked']);
  });
  it('says Complete on the issue: the normal agreement path', async () => {
    const { gh, calls } = fakeGh(false);
    await createWriter(config, githubOwner(config, gh)).perform({ kind: 'complete', issue: 5 });
    expect(calls).toEqual(['issue comment 5: Complete']);
  });
  it('sets and clears Blocked', async () => {
    const off = fakeGh(false);
    await createWriter(config, githubOwner(config, off.gh)).perform({
      kind: 'block',
      issue: 5,
      on: true,
    });
    expect(off.calls).toEqual(['set Blocked']);
    const on = fakeGh(true);
    await createWriter(config, githubOwner(config, on.gh)).perform({
      kind: 'block',
      issue: 5,
      on: false,
    });
    expect(on.calls).toEqual(['clear Blocked']);
  });
  it('refuses an issue that is not on the board', async () => {
    const { gh } = fakeGh(false);
    await expect(
      createWriter(config, githubOwner(config, gh)).perform({ kind: 'complete', issue: 9 }),
    ).rejects.toThrow("isn't on the board");
  });
  it('validates request bodies', () => {
    expect(parseAction({ kind: 'reply', issue: 5, text: '' }).ok).toBe(false);
    expect(parseAction({ kind: 'reply', issue: 5, text: 'x'.repeat(10_001) }).ok).toBe(false);
    expect(parseAction({ kind: 'merge', issue: 5 }).ok).toBe(false);
    expect(parseAction({ kind: 'block', issue: '5', on: true }).ok).toBe(false);
    expect(parseAction({ kind: 'reply', issue: 5, text: 'ok', unblock: 'yes' })).toEqual({
      ok: true,
      action: { kind: 'reply', issue: 5, text: 'ok', unblock: false },
    });
  });
});

/**
 * A fake Linear with PEN-5 (Planning, the Blocked label set) and PEN-6 (Planning, held only by
 * PEN-9, unfinished); it records the writes Ryan's key makes.
 */
function fakeLinear() {
  const writes: string[] = [];
  const card = (n: number, o: object) => ({
    id: `uuid-${n}`,
    identifier: `PEN-${n}`,
    number: n,
    title: `Issue ${n}`,
    url: `https://linear.app/redhale/issue/PEN-${n}`,
    priority: 0,
    sortOrder: n,
    state: { name: 'Planning', type: 'started' },
    creator: { id: RYAN_LINEAR },
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...o,
  });
  const client: LinearClient = {
    request: <T>(q: string, v: Readonly<Record<string, unknown>> = {}) => {
      const answer = (x: unknown) => Promise.resolve(x as T);
      if (q.includes('commentCreate(')) {
        writes.push(`comment ${String(v['issue'])}: ${String(v['body'])}`);
        return answer({ commentCreate: { success: true } });
      }
      for (const [field, what] of [
        ['issueAddLabel', 'add'],
        ['issueRemoveLabel', 'remove'],
      ] as const) {
        if (q.includes(`${field}(`)) {
          writes.push(`${what} ${String(v['label'])} on ${String(v['id'])}`);
          return answer({ [field]: { success: true } });
        }
      }
      if (q.includes('query Team'))
        return answer({
          teams: { nodes: [{ id: 'team-pen', states: { nodes: [] } }] },
          issueLabels: { nodes: [{ id: 'label-blocked', team: null }] },
        });
      if (q.includes('query Board'))
        return answer({
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              card(5, { labels: { nodes: [{ name: 'Blocked', parent: null }] } }),
              card(6, {
                inverseRelations: {
                  nodes: [
                    { type: 'blocks', issue: { identifier: 'PEN-9', state: { type: 'started' } } },
                  ],
                },
              }),
            ],
          },
        });
      return Promise.reject(new Error(`unexpected request: ${q}`));
    },
  };
  const lc = linearConfig();
  return { writer: createWriter(lc, linearOwner(lc, client)), writes };
}

describe("the UI's writes on Linear, with Ryan's key (F21, A1221)", () => {
  it('posts a reply on the card, then removes the Blocked label', async () => {
    const { writer, writes } = fakeLinear();
    expect(await writer.perform({ kind: 'reply', issue: 5, text: 'A sheet', unblock: true })).toBe(
      'Posted, and Blocked cleared',
    );
    expect(writes).toEqual(['comment uuid-5: A sheet', 'remove label-blocked on uuid-5']);
  });
  it('posts a picked answer and Complete in the form the planning session reads', async () => {
    const { writer, writes } = fakeLinear();
    await writer.perform({ kind: 'answer', issue: 5, question: 'Sheet?', option: 'Yes' });
    await writer.perform({ kind: 'complete', issue: 5 });
    expect(writes.filter((w) => w.startsWith('comment'))).toEqual([
      'comment uuid-5: On "Sheet?": Yes',
      'comment uuid-5: Complete',
    ]);
  });
  it('leaves a card held only by an unfinished blocker alone: there is no label to remove (LD8)', async () => {
    const { writer, writes } = fakeLinear();
    expect(await writer.perform({ kind: 'reply', issue: 6, text: 'Noted', unblock: true })).toBe(
      'Posted',
    );
    expect(await writer.perform({ kind: 'block', issue: 6, on: false })).toBe(
      "Blocked isn't set; PEN-9 holds it until it finishes",
    );
    expect(writes).toEqual(['comment uuid-6: Noted']);
  });
  it('sets the Blocked label on a held card when Ryan asks, so it stays paused after PEN-9', async () => {
    const { writer, writes } = fakeLinear();
    expect(await writer.perform({ kind: 'block', issue: 6, on: true })).toBe('Blocked');
    expect(writes).toEqual(['add label-blocked on uuid-6']);
  });
});

describe('POST /action (F21)', () => {
  const token = 'b'.repeat(48);
  const done: string[] = [];
  const writer: Writer = { perform: (a) => (done.push(a.kind), Promise.resolve('ok')) };
  const server = createUiServer({
    port: 0,
    token,
    page: pageHtml,
    view: () => Promise.reject(new Error('unused')),
    writer,
  });
  let port = 0;
  beforeAll(async () => {
    port = await listen(server, 0);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const post = (body: string, headers: Record<string, string>) =>
    new Promise<number>((res, rej) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/action',
          method: 'POST',
          headers: { host: `127.0.0.1:${port}`, ...headers },
        },
        (r) => {
          r.resume();
          r.on('end', () => res(r.statusCode ?? 0));
        },
      );
      req.on('error', rej);
      req.end(body);
    });
  const cookie = `penmoss-factory-ui=${token}`;
  const ok = JSON.stringify({ kind: 'complete', issue: 5 });

  it('runs a valid action from the page', async () => {
    expect(
      await post(ok, {
        cookie,
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
      }),
    ).toBe(200);
    expect(done).toEqual(['complete']);
  });
  it('refuses without the token, without an Origin, or with a foreign one', async () => {
    expect(
      await post(ok, { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }),
    ).toBe(403);
    expect(await post(ok, { cookie, 'content-type': 'application/json' })).toBe(403);
    expect(
      await post(ok, {
        cookie,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      }),
    ).toBe(403);
  });
  it('takes JSON only, and rejects a bad body', async () => {
    const origin = `http://127.0.0.1:${port}`;
    expect(
      await post('kind=complete&issue=5', {
        cookie,
        origin,
        'content-type': 'application/x-www-form-urlencoded',
      }),
    ).toBe(415);
    expect(
      await post('{"kind":"merge","issue":5}', {
        cookie,
        origin,
        'content-type': 'application/json',
      }),
    ).toBe(400);
    expect(done).toEqual(['complete']);
  });
});

describe('the import boundary (F21)', () => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
  /** Every module reachable from `entry` through relative imports. */
  function reachable(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const text = readFileSync(entry, 'utf8');
    for (const m of text.matchAll(
      /(?:import|export)\s[^'"]*?from\s+'(\.[^']+)'|import\(\s*'(\.[^']+)'\s*\)/g,
    )) {
      const spec = m[1] ?? m[2];
      if (spec?.endsWith('.ts')) reachable(join(dirname(entry), spec), seen);
    }
    return seen;
  }
  it("keeps the UI's writer out of the daemon, the runs and the planning", () => {
    for (const entry of [
      'daemon.ts',
      'dispatcher.ts',
      'start.ts',
      'run.ts',
      'revise.ts',
      'merge.ts',
      'plan-run.ts',
    ]) {
      const modules = [...reachable(join(src, entry))].map((p) => p.slice(src.length + 1));
      expect(modules, entry).not.toContain('ui/actions.ts');
      expect(modules, entry).not.toContain('ui/owner.ts');
    }
  });
  it("starts the UI without preparing the runs' clone, which the daemon restarted with it does", () => {
    // Both wrote the clone's config at once after factory:update, and one lost config.lock.
    const text = readFileSync(join(src, 'ui/run.ts'), 'utf8');
    const opens = [...text.matchAll(/openFactory\(([^)]*)\)/g)].map((m) => m[1]);
    expect(opens).toEqual(['config, { clone: false }']);
    expect(text).not.toContain('ensureClone');
  });
  it("leaves clearing Blocked out of the trackers, which the factory's runs use", () => {
    for (const file of ['board.ts', 'tracker/github.ts', 'tracker/linear.ts', 'tracker/port.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text, file).not.toContain('clearProjectV2ItemFieldValue');
      expect(text, file).not.toContain('issueRemoveLabel');
      // port.ts declares OwnerTracker, which only ui/owner.ts implements.
      if (file !== 'tracker/port.ts') expect(text, file).not.toContain('clearBlocked');
    }
  });
  it('talks to the tracker only through src/tracker/ and board.ts (L1)', () => {
    const allowed = new Set([
      'board.ts',
      'issue.ts',
      'tracker/github.ts',
      'tracker/linear.ts',
      'tracker/linear-client.ts',
      'ui/owner.ts',
    ]);
    const files = (dir: string): string[] =>
      readdirSync(join(src, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(join(dir, e.name))
          : e.name.endsWith('.ts')
            ? [join(dir, e.name)]
            : [],
      );
    for (const file of files('.')) {
      if (allowed.has(file)) continue;
      const text = readFileSync(join(src, file), 'utf8');
      expect(text, file).not.toMatch(/\['issue',\s*'(?:comment|close|view|edit)'/);
      expect(text, file).not.toMatch(/ProjectV2|projectV2/);
      expect(text, file).not.toMatch(/api\.linear\.app|commentCreate|issueUpdate|issueAddLabel/);
    }
  });
});
