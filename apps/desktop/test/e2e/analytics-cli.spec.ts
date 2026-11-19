import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  analyticsEnv,
  analyticsStatus,
  canaryFiles,
  canaryHits,
  CANARIES,
  fakeAnalytics,
  sendNow,
  type FakeAnalytics,
} from './fake-analytics';
import {
  bareRepository,
  dataDir,
  DESKTOP,
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  type Launched,
} from './support';

// PEN-137 in the Mac app: the CLI and the local MCP server share the app's answer and record
// (~/.penmoss/analytics.json and analytics/events.db). The app is the CLI (`--penmoss-cli`, as
// local-agents.spec.ts runs it): `penmoss analytics status|on|off` report and change the same
// answer the app shows, and never ask (AC20); a search for a canary word and MCP tool calls with
// canary arguments are recorded by name only, the record and every other file under the home
// holding none of them (AC14); nothing reaches the endpoint while the answer is No (AC11); and
// the app's Analytics Data lists the CLI's and the MCP server's events, filtered by client
// (ac36).

/** The Electron binary the suite runs, as Playwright finds it. */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const opened: Launched[] = [];
const endpoints: FakeAnalytics[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
test.afterAll(() => removeDataDirs());

/** A home for the CLI, its git identity, and the CLI as the app runs it. */
function world() {
  const root = dataDir();
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(
    gitconfig,
    '[user]\n  name = Ryan on the Mac\n  email = ryan@example.invalid\n[commit]\n  gpgSign = false\n',
  );
  const home = join(root, 'penmoss');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENMOSS_HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // Nothing in the suite's own environment keeps the CLI's events out of the answer.
    DO_NOT_TRACK: '0',
    PENMOSS_ANALYTICS: 'on',
  };
  const cli = (args: readonly string[], input?: string) =>
    spawnSync(ELECTRON, [DESKTOP, '--penmoss-cli', ...args], {
      env,
      encoding: 'utf8',
      timeout: 90_000,
      ...(input === undefined ? {} : { input }),
    });
  return { home, gitconfig, cli };
}

interface StatusJson {
  readonly sharing: 'on' | 'off' | 'unanswered';
  readonly consent: 'yes' | 'no' | null;
  readonly id: string;
}

interface ShownEvent {
  readonly client: string;
  readonly actor: string;
  readonly kind: string;
  readonly name: string;
  readonly state: string;
  readonly props: Readonly<Record<string, unknown>>;
}

test('the CLI and its MCP server keep the app’s answer and record, by name only; Analytics Data lists them (AC20, AC11, AC14, ac36)', async () => {
  test.setTimeout(300_000);
  const w = world();
  const status = (): StatusJson => {
    const run = w.cli(['analytics', 'status', '--json']);
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as StatusJson;
  };

  // No answer yet: the CLI says so, and asks nothing.
  const first = status();
  expect(first.sharing).toBe('unanswered');
  expect(first.consent).toBeNull();
  expect(first.id).toMatch(/^[0-9a-f]{32}$/);
  // On and off are the CLI's only way to answer; the ID stays.
  const on = w.cli(['analytics', 'on']);
  expect(on.status, on.stderr).toBe(0);
  expect(on.stdout).toContain('Sharing usage data.');
  expect(status()).toMatchObject({ sharing: 'on', consent: 'yes', id: first.id });
  const off = w.cli(['analytics', 'off']);
  expect(off.status, off.stderr).toBe(0);
  expect(off.stdout).toContain('Not sharing.');
  expect(status()).toMatchObject({ sharing: 'off', consent: 'no', id: first.id });
  const file = JSON.parse(readFileSync(join(w.home, 'analytics.json'), 'utf8')) as {
    consent: string;
    install: string;
  };
  expect(file).toMatchObject({ consent: 'no', install: first.id });

  // A notebook for the CLI, a search for a canary word, and an agent's calls with canary
  // arguments.
  const remote = bareRepository();
  const added = w.cli(['notebook', 'add', `file://${remote}`, '--name', 'notes']);
  expect(added.status, added.stderr).toBe(0);
  const searched = w.cli(['search', CANARIES.search, '--mode', 'full-text']);
  expect(searched.status, searched.stderr).not.toBeNull();
  const calls: [string, Record<string, unknown>][] = [
    ['search_notes', { query: CANARIES.search, mode: 'full-text' }],
    ['read_note', { id: CANARIES.notes[0]!.title }],
    ['list_folder', { path: CANARIES.folders[0]! }],
    ['list_tags', { tag: CANARIES.tags[0]! }],
  ];
  const requests = [
    {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '1' },
      },
    },
    ...calls.map(([name, args], index) => ({
      id: index + 2,
      method: 'tools/call',
      params: { name, arguments: args },
    })),
  ];
  const served = w.cli(
    ['mcp', '--notebook', 'notes'],
    requests.map((each) => `${JSON.stringify({ jsonrpc: '2.0', ...each })}\n`).join(''),
  );
  expect(served.status, served.stderr).toBe(0);
  const replies = served.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id?: unknown })
    .filter((reply) => typeof reply.id === 'number');
  expect(replies.map((reply) => reply.id)).toEqual(requests.map((request) => request.id));

  // The record, as `penmoss analytics show --json` lists it: names, never what was asked.
  const show = (client: string): ShownEvent[] => {
    const run = w.cli(['analytics', 'show', '--json', '--client', client]);
    expect(run.status, run.stderr).toBe(0);
    expect(canaryHits(run.stdout, [CANARIES.pattern])).toEqual([]);
    return run.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ShownEvent);
  };
  const cliEvents = show('cli');
  expect(cliEvents.every((event) => event.client === 'cli' && event.kind === 'cli')).toBe(true);
  expect(cliEvents.map((event) => event.name)).toEqual(
    expect.arrayContaining(['analytics', 'notebook', 'search', 'mcp']),
  );
  const search = cliEvents.find((event) => event.name === 'search')!;
  // A flag's name, never its value; the query not at all.
  expect(search.props['flags']).toEqual(['mode']);
  expect(cliEvents.find((event) => event.name === 'mcp')!.actor).toBe('agent');
  // Recorded with No: Not Shared, every one (the first, recorded before any answer, too).
  expect(cliEvents.every((event) => event.state === 'local')).toBe(true);
  const toolEvents = show('mcp');
  expect(toolEvents.map((event) => event.name).sort()).toEqual(calls.map(([name]) => name).sort());
  for (const event of toolEvents) {
    expect(event).toMatchObject({ client: 'mcp', actor: 'agent', kind: 'tool', state: 'local' });
    expect(event.props['agentClient']).toBe('claude-code');
    expect(Object.keys(event.props).sort()).toEqual(['agentClient', 'result', 'took']);
  }
  // No canary in any file the CLI and the MCP server keep: the record, the answer, the notebook.
  expect(canaryFiles(w.home)).toEqual([]);
  expect(canaryFiles(join(w.home, 'analytics'), [CANARIES.pattern])).toEqual([]);

  // The app on the same home: the answer is No, so nothing reaches the endpoint (AC11).
  const fake = await fakeAnalytics();
  endpoints.push(fake);
  const launched = await launch({ env: { PENMOSS_HOME: w.home, ...analyticsEnv(fake) } });
  opened.push(launched);
  const { app, page } = launched;
  expect(launched.home).toBe(w.home);
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched);
  expect(await analyticsStatus(page)).toMatchObject({ consent: 'no', install: first.id });
  await sendNow(app);
  // A check that something didn't happen.
  await page.waitForTimeout(1_000);
  expect(fake.requests).toEqual([]);

  // The same answer in Settings → Privacy, and a terminal's change shows there at once.
  await go(page, '/settings/privacy');
  const share = page.getByRole('switch', { name: 'Share Usage Data' });
  await expect(share).not.toBeChecked();
  const onAgain = w.cli(['analytics', 'on']);
  expect(onAgain.status, onAgain.stderr).toBe(0);
  await expect(share).toBeChecked({ timeout: 15_000 });
  await holdForProof(page);
  const offAgain = w.cli(['analytics', 'off']);
  expect(offAgain.status, offAgain.stderr).toBe(0);
  await expect(share).not.toBeChecked({ timeout: 15_000 });

  // Analytics Data: the MCP server's calls, then the CLI's commands, by name.
  await go(page, '/settings/privacy/data');
  const data = page.getByTestId('analytics-data');
  await expect(data.getByRole('heading', { level: 1 })).toHaveText('Analytics Data');
  const rows = data.getByTestId('analytics-data-row');
  await data.getByTestId('analytics-data-client').getByText('MCP', { exact: true }).click();
  await expect(rows).toHaveCount(calls.length);
  await expect(rows.locator('td:nth-child(2)')).toHaveText(Array(calls.length).fill('MCP'));
  expect((await rows.locator('td:nth-child(4)').allTextContents()).sort()).toEqual(
    calls.map(([name]) => name).sort(),
  );
  await expect(rows.locator('td:nth-child(5)').first()).toContainText('agentClient: claude-code');
  await holdForProof(page);
  await data.getByTestId('analytics-data-client').getByText('CLI', { exact: true }).click();
  await expect(rows.locator('td:nth-child(4)', { hasText: /^search$/ })).toHaveCount(1);
  const names = await rows.locator('td:nth-child(4)').allTextContents();
  expect(names).toEqual(expect.arrayContaining(['analytics', 'notebook', 'search', 'mcp']));
  await expect(rows.locator('td:nth-child(2)')).toHaveText(Array(names.length).fill('CLI'));
  expect(canaryHits((await data.textContent()) ?? '', [CANARIES.pattern])).toEqual([]);
  await data.getByTestId('analytics-data-table').scrollIntoViewIfNeeded();
  await holdForProof(page);
});
