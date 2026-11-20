/**
 * Usage analytics from the CLI (PEN-137; AC10, AC11, AC20, AC21, AC29): every run records one
 * `cli` event at exit in the record shared with the Mac app, in the state the answer in
 * `analytics.json` gives it; `penmoss mcp` records each tool call; `penmoss analytics` shows and
 * changes the answer, ID, record and limits, and never asks. Nothing a person types is recorded,
 * no command but `forget` touches the network, and a record that cannot be written changes
 * nothing a command prints or returns. Each test has its own PENMOSS_HOME under $TMPDIR.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_FLAGS,
  CLI_NAMES,
  eventProblem,
  isCatalogued,
  Recorder,
  STATES,
  type AnalyticsEvent,
  type ConsentFile,
  type StoredEvent,
} from '@penmoss/core/analytics';
import { AnalyticsStore, wireEvent } from '@penmoss/core/analytics/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRecorder } from '../src/analytics';
import type { FlagSpec } from '../src/args';
import { COMMANDS, GLOBAL_FLAGS, NOTEBOOK_COMMANDS, NOTEBOOK_FLAGS } from '../src/main';
import type { AnalyticsIo } from '../src/io';
import { channelOf, macosVersionOf, nodeAnalytics } from '../src/node-analytics';
import { HANDSHAKE, machine as machineAt, MemoryHosts, rpc, testRoot } from './support/machine';

const root = testRoot('penmoss-analytics-');
let hosts: MemoryHosts;
let home: string;
/** What the endpoint was asked, and how it answers `forget`. */
let requests: Array<{ url: string; body: string }>;
let endpoint: 'ok' | 'offline' | 'failed';
const fetchStub = ((url: string, init?: RequestInit) => {
  requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
  if (endpoint === 'offline') return Promise.reject(new TypeError('fetch failed'));
  return Promise.resolve(new Response('{}', { status: endpoint === 'ok' ? 200 : 500 }));
}) as typeof fetch;

/** The network is never reached except through the stub. */
const globalFetch = vi.fn(() => Promise.reject(new Error('the CLI reached the network')));

beforeEach(() => {
  hosts = new MemoryHosts();
  home = join(root.path, 'penmoss-home');
  requests = [];
  endpoint = 'ok';
  vi.stubGlobal('fetch', globalFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockClear();
});

function analyticsIo(extra: Partial<AnalyticsIo> = {}): AnalyticsIo {
  return {
    ...nodeAnalytics({
      env: { PENMOSS_HOME: home, PENMOSS_ANALYTICS_URL: 'http://telemetry.test/' },
      platform: 'darwin',
      fetch: fetchStub,
    }),
    ...extra,
  };
}

/** A machine with analytics; `env` is the CLI's own environment. */
function cliWith(env: Record<string, string> = {}, analytics = analyticsIo(), tty = false) {
  const cli = machineAt(root.path, 'mac', { hosts });
  return (argv: string[], input: Parameters<typeof cli>[1] = {}) =>
    cli(argv, { cliEnv: env, analytics, tty, ...input });
}

function events(): StoredEvent[] {
  const store = AnalyticsStore.open(join(home, 'analytics', 'events.db'));
  try {
    return [...store.page({ limit: 1000 }).events].reverse();
  } finally {
    store.close();
  }
}

function consent(): ConsentFile {
  return JSON.parse(readFileSync(join(home, 'analytics.json'), 'utf8')) as ConsentFile;
}

function seed(count: number, at: (index: number) => number, client: 'mcp' | 'cli' = 'cli') {
  const session = client === 'mcp' ? '0000000000000acd' : 'abcdef0123456789';
  const store = AnalyticsStore.open(join(home, 'analytics', 'events.db'));
  try {
    store.insert(
      Array.from({ length: count }, (_, index) => ({
        event: {
          session,
          seq: index,
          at: at(index),
          client,
          actor: 'script',
          version: '0.1.0',
          channel: 'dev',
          os: 'macos',
          osVersion: '15.1',
          kind: client === 'mcp' ? 'tool' : 'cli',
          name: client === 'mcp' ? 'read_note' : 'ls',
          props: {},
        } satisfies AnalyticsEvent,
        state: index % 2 === 0 ? STATES.local : STATES.sent,
      })),
    );
  } finally {
    store.close();
  }
}

/** Every byte the analytics files hold, as text: the record, its WAL and the answer. */
function analyticsBytes(): string {
  const files = [
    join(home, 'analytics.json'),
    ...readdirSync(join(home, 'analytics')).map((file) => join(home, 'analytics', file)),
  ];
  return files
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file).toString('latin1'))
    .join('\n')
    .toLowerCase();
}

const CANARIES = [
  'slothcanary',
  'zebracanary',
  'pangolincanary',
  'okapicanary',
  'narwhalcanary',
  'wombatcanary',
  'kiwicanary',
];

describe('every run records one cli event at exit', () => {
  it('names the command, its flags’ names, the exit code’s name, a duration and the terminal', async () => {
    const cli = cliWith();
    expect((await cli(['--version'])).code).toBe(0);
    const usage = await cli(['ls', '--sort', 'nonsense', '--json']);
    expect(usage.code).toBe(2);
    const [version, ls] = events();
    expect(version).toMatchObject({
      client: 'cli',
      kind: 'cli',
      name: 'version',
      actor: 'script',
      version: '0.1.0',
      channel: 'dev',
      os: 'macos',
      state: 'pending',
      props: { flags: [], exit: 'OK', took: '<1s', tty: false },
    });
    expect(version!.osVersion).toMatch(/^\d+\.\d+$/);
    expect(ls).toMatchObject({ name: 'ls', props: { exit: 'USAGE' } });
    for (const event of events()) expect(eventProblem(wireEvent(event))).toBeNull();
    // One session a run.
    expect(new Set(events().map((event) => event.session)).size).toBe(2);
  });

  it('records flag names, never their values, nor anything typed (AC14, AC21)', async () => {
    const cli = cliWith();
    const url = hosts.url('kiwicanary-repo');
    expect((await cli(['notebook', 'add', url, '--name', 'Wombatcanary'])).code).toBe(0);
    const made = await cli([
      'new',
      'Zebracanary Title Q7',
      '--text',
      'pangolincanary okapicanary',
      '--tag',
      'narwhalcanary',
    ]);
    expect(made.code, made.stderr).toBe(0);
    expect((await cli(['search', 'slothcanary', '--notebook', 'Wombatcanary'])).code).toBe(0);
    expect((await cli(['cat', 'slothcanary'])).code).toBe(4);
    const recorded = events();
    expect(
      recorded.map((event) => [event.name, event.props['flags'], event.props['exit']]),
    ).toEqual([
      ['notebook', ['name'], 'OK'],
      ['new', ['tag', 'text'], 'OK'],
      ['search', ['notebook'], 'OK'],
      ['cat', [], 'NOT_FOUND'],
    ]);
    const bytes = analyticsBytes();
    for (const canary of CANARIES) expect(bytes, canary).not.toContain(canary);
  });

  it('is an agent’s under an agent’s marker, a person’s on a terminal, a script’s otherwise (N5)', async () => {
    await cliWith({ CLAUDECODE: '1' })(['--version']);
    await cliWith({}, analyticsIo(), true)(['--version']);
    await cliWith({ PENMOSS_AGENT: '1' }, analyticsIo(), true)(['--version']);
    await cliWith()(['--version']);
    expect(events().map((event) => [event.actor, event.props['tty']])).toEqual([
      ['agent', false],
      ['person', true],
      ['agent', true],
      ['script', false],
    ]);
  });

  it('DO_NOT_TRACK=1 or PENMOSS_ANALYTICS=off keeps a shell’s events local, whatever the answer', async () => {
    await cliWith()(['analytics', 'on']);
    await cliWith({ DO_NOT_TRACK: '1' })(['--version']);
    await cliWith({ PENMOSS_ANALYTICS: 'off' })(['--version']);
    await cliWith({ DO_NOT_TRACK: '0' })(['--version']);
    expect(events().map((event) => event.state)).toEqual(['waiting', 'local', 'local', 'waiting']);
    const status = await cliWith({ DO_NOT_TRACK: '1' })(['analytics']);
    expect(status.stdout).toContain('DO_NOT_TRACK or PENMOSS_ANALYTICS=off is set here');
  });

  it('a record that cannot be written changes neither the output nor the exit code', async () => {
    const plain = machineAt(root.path, 'plain', { hosts });
    const broken = analyticsIo({
      openStore: () => {
        throw new Error('no node:sqlite');
      },
    });
    for (const argv of [['--version'], ['ls'], ['nonsense'], ['help', 'search']]) {
      const without = await plain(argv);
      const withBroken = await cliWith({}, broken)(argv);
      expect(withBroken).toMatchObject({
        code: without.code,
        stdout: without.stdout,
        stderr: without.stderr,
      });
    }
    // A home that is a file: nothing can be written there.
    writeFileSync(join(root.path, 'file-home'), 'x');
    const unwritable = nodeAnalytics({ env: { PENMOSS_HOME: join(root.path, 'file-home') } });
    const ran = await cliWith({}, unwritable)(['--version']);
    expect(ran).toMatchObject({ code: 0, stdout: 'penmoss 0.1.0\n', stderr: '' });
  });

  it('an unknown command records nothing; the record keeps its limits as it writes', async () => {
    const cli = cliWith();
    await cli(['frobnicate']);
    expect(existsSync(join(home, 'analytics', 'events.db'))).toBe(false);
    seed(10, () => Date.now() - 30 * 86_400_000);
    await cli(['--version']);
    expect(events().map((event) => event.name)).toEqual(['version']);
  });
});

describe('penmoss analytics on, off, status, reset, forget (AC20)', () => {
  it('status says the answer, the ID, the counts, the limits and the files', async () => {
    const cli = cliWith();
    const first = await cli(['analytics']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Sharing: not answered yet.');
    expect(first.stdout).toContain(`Analytics ID: ${consent().install}`);
    expect(first.stdout).toContain('Recorded: Nothing Recorded Yet');
    expect(first.stdout).toContain('Kept: 7 days, at most 5,000 events');
    expect(first.stdout).toContain(join(home, 'analytics.json'));
    expect(first.stdout).toContain(join(home, 'analytics', 'events.db'));
    const json = (await cli(['analytics', 'status', '--json'])).json();
    expect(json).toMatchObject({
      sharing: 'unanswered',
      consent: null,
      id: consent().install,
      counts: { pending: 1 },
      limits: { 'events.days': 7 },
      optedOut: false,
    });
  });

  it('on as the first answer shares what was recorded before it; off stops what waits', async () => {
    const cli = cliWith();
    await cli(['--version']);
    await cli(['--version']);
    const on = await cli(['analytics', 'on']);
    expect(on.stdout).toContain(
      'Sharing usage data. What was recorded before your answer (2 events)',
    );
    expect(consent()).toMatchObject({ consent: 'yes' });
    expect(consent().sharingSince).toEqual(expect.any(Number));
    expect(events().map((event) => event.state)).toEqual(['waiting', 'waiting', 'waiting']);
    expect((await cli(['analytics', 'on'])).stdout).toContain('Already sharing usage data.');
    const off = await cli(['analytics', 'off']);
    expect(off.stdout).toContain('Not sharing. The record stays on this Mac');
    expect(consent()).toMatchObject({ consent: 'no', sharingSince: null });
    expect(events().map((event) => event.state)).toEqual([
      'local',
      'local',
      'local',
      'local',
      'local',
    ]);
    // On again: from now on; what was recorded while off stays local (O3).
    const again = await cli(['analytics', 'on']);
    expect(again.stdout).toContain('Sharing usage data from now on.');
    await cli(['--version']);
    expect(events().map((event) => event.state)).toEqual([
      'local',
      'local',
      'local',
      'local',
      'local',
      'waiting',
      'waiting',
    ]);
  });

  it('off as the first answer keeps everything recorded before it local', async () => {
    const cli = cliWith();
    await cli(['--version']);
    expect((await cli(['analytics', 'off', '--json'])).json()).toMatchObject({
      sharing: 'off',
      changed: true,
      moved: 1,
    });
    await cli(['--version']);
    expect(events().map((event) => event.state)).toEqual(['local', 'local', 'local']);
  });

  it('reset gives a new ID, and what was not sent stays here', async () => {
    const cli = cliWith();
    await cli(['analytics', 'on']);
    const old = consent().install;
    const reset = await cli(['analytics', 'reset']);
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain('A new ID is in use. Events not yet sent stay on this Mac.');
    expect(consent().install).not.toBe(old);
    expect(consent().install).toMatch(/^[0-9a-f]{32}$/);
    expect(reset.stdout).toContain(consent().install);
    expect(events().map((event) => event.state)).toEqual(['local', 'waiting']);
  });

  it('forget asks the server to delete the old ID’s data, then gives a new ID', async () => {
    const cli = cliWith();
    await cli(['analytics']);
    const old = consent().install;
    const done = await cli(['analytics', 'forget']);
    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toContain('Your shared data was deleted, and this Mac has a new ID.');
    expect(requests).toEqual([
      { url: 'http://telemetry.test/v1/forget', body: JSON.stringify({ v: 1, install: old }) },
    ]);
    expect(consent().install).not.toBe(old);
  });

  it('forget offline, or refused, exits with an error and changes nothing', async () => {
    const cli = cliWith();
    await cli(['analytics']);
    const old = consent().install;
    endpoint = 'offline';
    const offline = await cli(['analytics', 'forget']);
    expect(offline.code).toBe(1);
    expect(offline.stderr).toContain('You’re offline, so nothing was deleted.');
    endpoint = 'failed';
    const failed = await cli(['analytics', 'forget', '--json']);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr)).toMatchObject({ error: { code: 'forget_failed' } });
    expect(consent().install).toBe(old);
    expect(requests).toHaveLength(2);
  });

  it('no command but forget reaches the endpoint', async () => {
    const cli = cliWith();
    for (const argv of [
      ['analytics', 'on'],
      ['analytics'],
      ['analytics', 'show'],
      ['analytics', 'limits'],
      ['analytics', 'reset'],
      ['analytics', 'off'],
      ['--version'],
    ]) {
      expect((await cli(argv)).code).toBe(0);
    }
    expect(requests).toEqual([]);
  });

  it('refuses what does not fit, with the usage exit', async () => {
    const cli = cliWith();
    for (const argv of [
      ['analytics', 'maybe'],
      ['analytics', 'on', 'now'],
      ['analytics', 'status', '--client', 'cli'],
      ['analytics', 'show', '--state', 'gone'],
      ['analytics', 'show', '--client', 'web'],
      ['analytics', 'show', '--before', 'x'],
      ['analytics', 'show', '--limit', '5000'],
    ]) {
      const ran = await cli(argv);
      expect(ran.code, argv.join(' ')).toBe(2);
    }
  });

  it('without analytics here, says so', async () => {
    const ran = await machineAt(root.path, 'none', { hosts })(['analytics']);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('This penmoss keeps no usage record here.');
  });
});

describe('penmoss analytics show', () => {
  it('pages the record newest first, 100 at a time, by id', async () => {
    const start = Date.now() - 3_600_000;
    seed(250, (index) => start + index * 1000);
    const cli = cliWith();
    const first = await cli(['analytics', 'show']);
    expect(first.code).toBe(0);
    const lines = first.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^ID\s+Time\s+Client\s+Kind\s+Name\s+State\s+Props$/);
    expect(lines[1]).toMatch(/^250\s/);
    expect(first.stdout).toContain('Showing 1–100 of 250');
    expect(first.stdout).toContain('Earlier: penmoss analytics show --before 151');
    // Each show is a run too, recorded after it reads: the next page counts it.
    const second = await cli(['analytics', 'show', '--before', '151']);
    expect(second.stdout.split('\n')[1]).toMatch(/^150\s/);
    expect(second.stdout).toContain('Showing 102–201 of 251');
    const third = await cli(['analytics', 'show', '--before', '51']);
    expect(third.stdout).toContain('Showing 203–252 of 252');
    expect(third.stdout).not.toContain('Earlier:');
    expect((await cli(['analytics', 'show', '--before', '9999'])).code).toBe(4);
  });

  it('filters by client and state, and prints JSON lines', async () => {
    const start = Date.now() - 3_600_000;
    seed(6, (index) => start + index * 1000, 'mcp');
    seed(4, (index) => start + 10_000 + index * 1000);
    const cli = cliWith();
    const mcp = await cli(['analytics', 'show', '--client', 'mcp', '--json']);
    const rows = mcp.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as StoredEvent);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.client === 'mcp' && row.kind === 'tool')).toBe(true);
    expect(rows[0]!.at).toBeGreaterThan(rows[5]!.at);
    const local = await cli([
      'analytics',
      'show',
      '--client',
      'cli',
      '--state',
      'local',
      '--limit',
      '1',
    ]);
    expect(local.stdout).toContain('Not Shared');
    expect(local.stdout).toContain('Showing 1–1 of 2');
    expect(local.stdout).toContain('--state local --client cli --limit 1');
  });
});

describe('penmoss analytics limits (AC29)', () => {
  it('lists every limit with its value, default and range', async () => {
    const listed = await cliWith()(['analytics', 'limits']);
    expect(listed.stdout).toMatch(/^Key\s+Value\s+Default\s+Range$/m);
    expect(listed.stdout).toMatch(/^events\.days\s+7\s+7\s+1–360 days$/m);
    expect(listed.stdout).toMatch(/^events\.max\s+5,000\s+5,000\s+500–800,000 events$/m);
    expect(listed.stdout).toMatch(/^report\.kb\s+16\s+16\s+4–40 KB$/m);
  });

  it('set changes the same value the app reads; out of range is refused with the range', async () => {
    const cli = cliWith();
    const set = await cli(['analytics', 'limits', 'set', 'events.days', '30']);
    expect(set.code).toBe(0);
    expect(set.stdout).toMatch(/^events\.days\s+30\s+7\s+1–360 days$/m);
    expect(consent().limits).toEqual({ 'events.days': 30 });
    const tooMany = await cli(['analytics', 'limits', 'set', 'events.days', '361']);
    expect(tooMany.code).toBe(2);
    expect(tooMany.stderr).toContain('events.days: Between 1 and 360 days (got 361); it stays 30');
    expect((await cli(['analytics', 'limits', 'set', 'logs.files', 'two'])).code).toBe(2);
    expect((await cli(['analytics', 'limits', 'set', 'events.weeks', '3'])).code).toBe(2);
    expect((await cli(['analytics', 'limits', 'set', 'events.days'])).code).toBe(2);
    expect(consent().limits).toEqual({ 'events.days': 30 });
    await cli(['analytics', 'limits', 'set', 'report.lines', '50']);
    expect(consent().limits).toEqual({ 'events.days': 30, 'report.lines': 50 });
    const json = (await cli(['analytics', 'limits', '--json'])).json() as {
      limits: Array<{ key: string; value: number; min: number; max: number }>;
    };
    expect(json.limits.find((row) => row.key === 'report.lines')).toMatchObject({
      value: 50,
      min: 50,
      max: 2000,
    });
  });

  it('reset puts one, or every, limit back', async () => {
    const cli = cliWith();
    await cli(['analytics', 'limits', 'set', 'events.days', '30']);
    await cli(['analytics', 'limits', 'set', 'logs.files', '5']);
    await cli(['analytics', 'limits', 'reset', 'logs.files']);
    expect(consent().limits).toEqual({ 'events.days': 30 });
    await cli(['analytics', 'limits', 'reset']);
    expect(consent().limits).toEqual({});
  });

  it('lowering an event limit deletes what falls outside it, and the record keeps it after', async () => {
    const start = Date.now() - 3_600_000;
    seed(600, (index) => start + index);
    const cli = cliWith();
    const lowered = await cli(['analytics', 'limits', 'set', 'events.max', '500']);
    expect(lowered.stdout).toContain('Deleted 100 events that fall outside the new limits.');
    expect(events()).toHaveLength(500);
    await cli(['--version']);
    expect(events()).toHaveLength(500);
    expect(events().at(-1)!.name).toBe('version');
  });
});

describe('penmoss mcp records each tool call (AC21)', () => {
  it('by tool name, agent and result: never an argument or what it answered', async () => {
    const cli = cliWith();
    const url = hosts.url('kiwicanary-repo');
    const added = await cli([
      'notebook',
      'add',
      url,
      '--name',
      'Wombatcanary',
      '--agent',
      'Claude Code',
    ]);
    expect(added.code, added.stderr).toBe(0);
    const served = await cli(['mcp'], {
      lines: [
        ...HANDSHAKE,
        rpc(2, 'tools/call', {
          name: 'create_note',
          arguments: {
            title: 'Zebracanary Title Q7',
            markdown: 'pangolincanary [[Axolotlcanary Target]] #narwhalcanary',
          },
        }),
        rpc(3, 'tools/call', { name: 'search_notes', arguments: { query: 'slothcanary' } }),
        rpc(4, 'tools/call', { name: 'read_note', arguments: { id: 'slothcanary' } }),
        rpc(5, 'tools/call', { name: 'read_note', arguments: {} }),
      ],
    });
    expect(served.code, served.stderr).toBe(0);
    const tools = events().filter((event) => event.kind === 'tool');
    expect(tools.map((event) => [event.name, event.props])).toEqual([
      ['create_note', { agentClient: 'claude-code', result: 'ok', took: '<1s' }],
      ['search_notes', { agentClient: 'claude-code', result: 'ok', took: '<1s' }],
      ['read_note', { agentClient: 'claude-code', result: 'notFound', took: '<1s' }],
      ['read_note', { agentClient: 'claude-code', result: 'invalid', took: '<1s' }],
    ]);
    expect(tools.every((event) => event.client === 'mcp' && event.actor === 'agent')).toBe(true);
    // One session for the connection, in order.
    expect(new Set(tools.map((event) => event.session)).size).toBe(1);
    expect(tools.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    // The server's own run is an agent's too.
    expect(events().find((event) => event.name === 'mcp')).toMatchObject({
      kind: 'cli',
      actor: 'agent',
      props: { exit: 'OK' },
    });
    const bytes = analyticsBytes();
    for (const canary of [...CANARIES, 'axolotlcanary']) {
      expect(bytes, canary).not.toContain(canary);
    }
  });

  it('reads the answer again as it writes: off before a write keeps what it writes local', async () => {
    const cli = cliWith();
    expect(
      (await cli(['notebook', 'add', hosts.url('nb'), '--name', 'nb', '--agent', 'Codex'])).code,
    ).toBe(0);
    await cli(['analytics', 'on']);
    await cli(['mcp'], {
      lines: [
        ...HANDSHAKE,
        rpc(2, 'tools/call', { name: 'list_tags', arguments: {} }),
        async () => {
          // Another terminal turns sharing off while the server runs.
          await cliWith()(['analytics', 'off']);
        },
        rpc(3, 'tools/call', { name: 'list_tags', arguments: {} }),
      ],
    });
    const tools = events().filter((event) => event.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.every((event) => event.state === 'local')).toBe(true);
  });
});

describe('the catalogue knows every command, flag and exit (AC15)', () => {
  it('every command, help and version is a catalogued CLI name', () => {
    for (const command of COMMANDS) {
      expect(isCatalogued('cli', command.name), command.name).toBe(true);
    }
    expect(CLI_NAMES).toContain('help');
    expect(CLI_NAMES).toContain('version');
  });

  it('every flag name is one an event can carry', () => {
    const extra: FlagSpec[] = [
      { name: 'notebook', type: 'string', description: '' },
      { name: 'no-sync', type: 'boolean', description: '' },
      { name: 'json', type: 'boolean', description: '' },
      { name: 'help', type: 'boolean', description: '' },
    ];
    for (const command of COMMANDS) {
      const flags = [
        ...command.flags,
        ...(NOTEBOOK_COMMANDS.has(command.name) ? extra : extra.slice(2)),
      ].map((flag) => flag.name);
      for (let at = 0; at < flags.length; at += 16) {
        const event = {
          session: '0123456789abcdef',
          seq: 0,
          at: 1,
          client: 'cli',
          actor: 'person',
          version: '0.1.0',
          channel: 'dev',
          os: 'macos',
          osVersion: '15.1',
          kind: 'cli',
          name: command.name,
          props: { flags: flags.slice(at, at + 16), exit: 'OK', took: '<1s', tty: true },
        };
        expect(eventProblem(event), `${command.name}: ${flags.join(', ')}`).toBeNull();
      }
    }
  });

  it('the catalogue lists every flag a command takes, and no flag none takes', () => {
    const taken = new Set(
      COMMANDS.flatMap((command) => [
        ...command.flags,
        ...(NOTEBOOK_COMMANDS.has(command.name) ? NOTEBOOK_FLAGS : []),
        ...GLOBAL_FLAGS,
      ]).map((flag) => flag.name),
    );
    expect([...taken].sort()).toEqual([...CLI_FLAGS].sort());
  });
});

describe('what every event says of this machine', () => {
  it('macOS’s version from Darwin’s', () => {
    expect(macosVersionOf('25.6.0')).toBe('26.6');
    expect(macosVersionOf('24.1.0')).toBe('15.1');
    expect(macosVersionOf('20.6.0')).toBe('11.6');
    expect(macosVersionOf('19.6.0')).toBe('10.15');
    expect(macosVersionOf('nonsense')).toBe('0');
  });

  it('the channel from the version', () => {
    expect(channelOf('0.3.0-alpha.12', true)).toBe('alpha');
    expect(channelOf('0.3.0', true)).toBe('stable');
    expect(channelOf('0.1.0', false)).toBe('dev');
  });
});

describe('the built CLI (build.js)', () => {
  let bundleDir: string;
  beforeAll(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'penmoss-analytics-bundle-'));
    execFileSync(process.execPath, [
      fileURLToPath(new URL('../build.js', import.meta.url)),
      bundleDir,
    ]);
  }, 60_000);
  afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

  it('loads SQLite only to record, at exit, and says nothing of it', () => {
    const bundle = readFileSync(join(bundleDir, 'penmoss-cli.js'), 'utf8');
    // A static import would load SQLite (and its warning) for every command, and stop a Node
    // without it from starting the CLI.
    expect(bundle).not.toMatch(/^import [^;]*["']node:sqlite["']/m);
    const ran = (env: Record<string, string>) => {
      const done = spawnSync(process.execPath, [join(bundleDir, 'penmoss.js'), '--version'], {
        env: { PATH: process.env['PATH'] ?? '', PENMOSS_HOME: home, ...env },
        encoding: 'utf8',
      });
      return { code: done.status, stdout: done.stdout, stderr: done.stderr };
    };
    const quiet = { code: 0, stdout: 'penmoss 0.1.0\n', stderr: '' };
    expect(ran({})).toEqual(quiet);
    expect(ran({ CLAUDECODE: '1' })).toEqual(quiet);
    expect(events().map((event) => [event.name, event.actor, event.state])).toEqual([
      ['version', 'script', 'pending'],
      ['version', 'agent', 'pending'],
    ]);
  }, 30_000);
});

describe('no window or layout from the CLI or the MCP server (PEN-174)', () => {
  it('records only cli and tool events, and its recorders refuse app window and app layout', async () => {
    const cli = cliWith();
    expect((await cli(['--version'])).code).toBe(0);
    const tools = new ToolRecorder(analyticsIo(), {}, 20);
    tools.record({ tool: 'read_note', agentClient: 'codex', result: 'ok', tookMs: 5 });
    tools.close();
    expect([...new Set(events().map((event) => `${event.client} ${event.kind}`))].sort()).toEqual([
      'cli cli',
      'mcp tool',
    ]);
    // Were either ever asked to, core's check drops it before it is stored: they have no window.
    const fields = analyticsIo().fields;
    for (const client of ['cli', 'mcp'] as const) {
      const kept: unknown[] = [];
      const recorder = new Recorder({
        fields: () => ({ client, actor: 'agent', ...fields }),
        sink: (event) => kept.push(event),
      });
      const window = { window: 'main', width: 1440, height: 900, fullScreen: false };
      expect(recorder.record('app', 'window', window), client).toBe(false);
      expect(
        recorder.record('app', 'layout', {
          window: 'main',
          sidebar: 'hidden',
          panel: 'none',
          fullWidth: false,
          themeMode: 'system',
        }),
        client,
      ).toBe(false);
      expect(kept).toEqual([]);
    }
  });
});

describe('the MCP server’s recorder', () => {
  it('writes once a second while there are events, and the rest at the end', async () => {
    const recorder = new ToolRecorder(analyticsIo(), {}, 20);
    const call = { tool: 'read_note', agentClient: 'codex', result: 'ok', tookMs: 5 } as const;
    recorder.record(call);
    recorder.record({ ...call, tool: 'list_tags' });
    expect(existsSync(join(home, 'analytics', 'events.db'))).toBe(false);
    await vi.waitFor(() =>
      expect(events().map((event) => event.name)).toEqual(['read_note', 'list_tags']),
    );
    recorder.record({ ...call, tool: 'search_notes', result: 'failed', tookMs: 7000 });
    recorder.close();
    expect(events().at(-1)).toMatchObject({
      name: 'search_notes',
      props: { agentClient: 'codex', result: 'failed', took: '5–15s' },
    });
    // Closed: nothing more is recorded.
    recorder.record(call);
    recorder.flush();
    expect(events()).toHaveLength(3);
  });

  it('a record that cannot be opened drops the events and stops trying', () => {
    let opened = 0;
    const recorder = new ToolRecorder(
      analyticsIo({
        openStore: () => {
          opened += 1;
          throw new Error('locked');
        },
      }),
      {},
      60_000,
    );
    const call = { tool: 'read_note', agentClient: 'other', result: 'ok', tookMs: 1 } as const;
    recorder.record(call);
    recorder.flush();
    recorder.record(call);
    recorder.close();
    expect(opened).toBe(1);
  });
});
