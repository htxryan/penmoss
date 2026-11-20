/**
 * Usage analytics' event format (PEN-137): the buckets, the catalogue, the checks every client
 * and the ingest Worker run, and the recorder. No free text can pass: a name is a catalogue id
 * and a prop one of its kind's typed values.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOGUE,
  CLI_FLAGS,
  CLICK_NAMES,
  isCatalogued,
  SETTING_NAMES,
  SETTING_VALUES,
} from '../src/analytics/catalogue';
import {
  COUNT_BUCKETS,
  countBucket,
  countsLine,
  DURATION_BUCKETS,
  durationBucket,
  EVENT_ID_PATTERN,
  INSTALL_PATTERN,
  KINDS,
  majorMinor,
  MAX_BATCH_EVENTS,
  newInstallId,
  newSessionId,
  SESSION_PATTERN,
  sizeClassOf,
  STATE_LABELS,
  STATE_NAMES,
  STATES,
  stateName,
  type AnalyticsEvent,
  type EventKind,
} from '../src/analytics/events';
import { Recorder } from '../src/analytics/recorder';
import { themeForEvent } from '../src/analytics/themes';
import { eventProblem, isValidEvent, KEYS_PATTERN, validateBatch } from '../src/analytics/validate';

const CANARIES = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../test/fixtures/canary-notebook/canaries.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { strings: string[] }
).strings;

/** Free text a bug could try to record: the canaries, and other shapes text takes. */
const FREE_TEXT = [
  ...CANARIES,
  'My plans for the week',
  '/Users/someone/Notes/a.md',
  'https://github.com/owner/repo',
  'a'.repeat(200),
  '',
  ' ',
];

function event(overrides: Partial<Record<keyof AnalyticsEvent, unknown>> = {}): AnalyticsEvent {
  return {
    session: '0123456789abcdef',
    seq: 0,
    at: 1_763_550_000_000,
    client: 'mac',
    actor: 'person',
    version: '1.4.0',
    channel: 'stable',
    os: 'macos',
    osVersion: '26.1',
    sizeClass: 'expanded',
    kind: 'command',
    name: 'note.new',
    props: { source: 'key', keys: 'Mod+N', custom: false, ran: true },
    ...overrides,
  } as AnalyticsEvent;
}

/** One valid event of each kind, with every prop its kind allows. */
const VALID: Readonly<Record<EventKind, AnalyticsEvent>> = {
  app: event({
    kind: 'app',
    name: 'launch',
    props: { notebooks: '2–4', notes: '100–499', agents: true, theme: 'nord', active: '5–30m' },
  }),
  command: event(),
  screen: event({ kind: 'screen', name: 'settings.privacy', props: { from: 'home' } }),
  dialog: event({ kind: 'dialog', name: 'consent', props: { action: 'done', open: '2–5s' } }),
  click: event({ kind: 'click', name: 'privacy.share.on', props: { state: 'on' } }),
  menu: event({ kind: 'menu', name: 'tray.capture', props: { source: 'tray' } }),
  setting: event({ kind: 'setting', name: 'privacy.limits.events.days', props: { value: 30 } }),
  firstrun: event({ kind: 'firstrun', name: 'github', props: { result: 'failed', error: 'auth' } }),
  feedback: event({
    kind: 'feedback',
    name: 'sent',
    props: { type: 'bug', priority: 2, screenshots: '1', logs: true, groupsLeftOut: '0' },
  }),
  sync: event({
    kind: 'sync',
    name: 'pass',
    props: { result: 'ok', took: '1–2s', changed: '5–9' },
  }),
  cli: event({
    client: 'cli',
    actor: 'agent',
    sizeClass: undefined,
    kind: 'cli',
    name: 'search',
    props: { flags: ['notebook', 'json'], exit: 'OK', took: '<1s', tty: false },
  }),
  tool: event({
    client: 'mcp',
    actor: 'agent',
    sizeClass: undefined,
    kind: 'tool',
    name: 'search_notes',
    props: { agentClient: 'claude-code', result: 'ok', took: '<1s' },
  }),
};

describe('buckets', () => {
  it('puts counts in buckets at their edges', () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [-1, '0'],
      [0, '0'],
      [Number.NaN, '0'],
      [0.5, '0'],
      [1, '1'],
      [2, '2–4'],
      [4, '2–4'],
      [5, '5–9'],
      [9, '5–9'],
      [10, '10–49'],
      [49, '10–49'],
      [50, '50–99'],
      [99, '50–99'],
      [100, '100–499'],
      [500, '500–999'],
      [999, '500–999'],
      [1000, '1000–4999'],
      [4999, '1000–4999'],
      [5000, '5000+'],
      [Number.POSITIVE_INFINITY, '0'],
      [1e9, '5000+'],
    ];
    for (const [count, bucket] of cases) expect(countBucket(count), String(count)).toBe(bucket);
    expect(COUNT_BUCKETS).toHaveLength(10);
  });

  it('puts durations in buckets at their edges', () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [-5, '<1s'],
      [Number.NaN, '<1s'],
      [999, '<1s'],
      [1000, '1–2s'],
      [1999, '1–2s'],
      [2000, '2–5s'],
      [5000, '5–15s'],
      [15_000, '15–60s'],
      [59_999, '15–60s'],
      [60_000, '1–5m'],
      [5 * 60_000, '5–30m'],
      [30 * 60_000 - 1, '5–30m'],
      [30 * 60_000, '30m+'],
      [1e12, '30m+'],
    ];
    for (const [ms, bucket] of cases) expect(durationBucket(ms), String(ms)).toBe(bucket);
    expect(DURATION_BUCKETS).toHaveLength(8);
  });
});

describe('majorMinor', () => {
  it('cuts a version to major.minor', () => {
    expect(majorMinor('15.1.2')).toBe('15.1');
    expect(majorMinor('26.1')).toBe('26.1');
    expect(majorMinor('14')).toBe('14');
    expect(majorMinor(' 16.0.1 (build 123) ')).toBe('16.0');
    expect(majorMinor('10.0.22631')).toBe('10.0');
    expect(majorMinor('Darwin 25.6.0')).toBe('0');
    expect(majorMinor('')).toBe('0');
  });
});

describe('sizeClassOf', () => {
  it('follows Material’s width classes', () => {
    expect(sizeClassOf(0)).toBe('compact');
    expect(sizeClassOf(599)).toBe('compact');
    expect(sizeClassOf(600)).toBe('medium');
    expect(sizeClassOf(839)).toBe('medium');
    expect(sizeClassOf(840)).toBe('expanded');
    expect(sizeClassOf(1280)).toBe('expanded');
  });
});

describe('states', () => {
  it('numbers the states and names them as the viewers do', () => {
    expect(STATE_NAMES.map((name) => STATES[name])).toEqual([0, 1, 2, 3, 4]);
    expect(stateName(2)).toBe('waiting');
    expect(stateName(99)).toBe('local');
    expect(STATE_LABELS).toEqual({
      pending: 'Waiting for Your Answer',
      local: 'Not Shared',
      waiting: 'Waiting to Send',
      sent: 'Sent',
      refused: 'Refused',
    });
  });

  it('writes the counts name first, in the plan’s order, leaving out none', () => {
    expect(countsLine({ waiting: 2, sent: 41, local: 212 })).toBe(
      'Waiting to Send 2 · Sent 41 · Not Shared 212',
    );
    expect(countsLine({ local: 41_206, pending: 3, refused: 1 })).toBe(
      'Waiting for Your Answer 3 · Not Shared 41,206 · Refused 1',
    );
    expect(countsLine({})).toBe('Nothing Recorded Yet');
    expect(countsLine({ sent: 0 })).toBe('Nothing Recorded Yet');
  });
});

describe('ids', () => {
  it('makes random install and session ids of the right shape', () => {
    const installs = new Set(Array.from({ length: 50 }, newInstallId));
    expect(installs.size).toBe(50);
    for (const id of installs) expect(id).toMatch(INSTALL_PATTERN);
    expect(newSessionId()).toMatch(SESSION_PATTERN);
  });
});

describe('the catalogue', () => {
  it('lists each kind’s names once', () => {
    const duplicates = KINDS.flatMap((kind) => {
      const names = CATALOGUE[kind];
      return names
        .filter((name, index) => names.indexOf(name) !== index)
        .map((n) => `${kind} ${n}`);
    });
    expect(duplicates).toEqual([]);
    expect(Object.keys(CATALOGUE).sort()).toEqual([...KINDS].sort());
  });

  it('gives every tracked control an id of the pattern', () => {
    expect(CLICK_NAMES.length).toBeGreaterThan(0);
    expect(CLICK_NAMES.filter((name) => !EVENT_ID_PATTERN.test(name))).toEqual([]);
  });

  it('names no catalogue entry after a canary', () => {
    const all = KINDS.flatMap((kind) => CATALOGUE[kind]);
    expect(all.filter((name) => name.toLowerCase().includes('canary'))).toEqual([]);
  });

  it('knows a name only under its own kind', () => {
    expect(isCatalogued('command', 'note.new')).toBe(true);
    expect(isCatalogued('click', 'note.new')).toBe(false);
    expect(isCatalogued('nope', 'note.new')).toBe(false);
    expect(isCatalogued('screen', 'settings.privacy')).toBe(true);
    expect(isCatalogued('screen', 'firstrun.consent')).toBe(true);
    expect(isCatalogued('setting', 'privacy.limits.report.kb')).toBe(true);
  });

  it('accepts ids of the pattern and refuses others', () => {
    for (const id of ['privacy.share.on', 'a.b', 'feedback.logs.toggle', 'a1.b-2.c.d.e']) {
      expect(EVENT_ID_PATTERN.test(id), id).toBe(true);
    }
    for (const id of ['privacy', 'Privacy.share', '1a.b', 'a.b.c.d.e.f', 'a..b', 'a.b ', 'a.B']) {
      expect(EVENT_ID_PATTERN.test(id), id).toBe(false);
    }
  });
});

describe('themeForEvent', () => {
  it('names a built-in theme, and any other as custom', () => {
    expect(themeForEvent('nord')).toBe('nord');
    expect(themeForEvent('My Zebracanary Theme')).toBe('custom');
  });
});

describe('eventProblem', () => {
  it.each(KINDS)('passes a valid %s event', (kind) => {
    expect(eventProblem(VALID[kind])).toBeNull();
    expect(isValidEvent(VALID[kind])).toBe(true);
  });

  it('passes an event without a size class or props', () => {
    expect(eventProblem(event({ sizeClass: undefined, props: {} }))).toBeNull();
    const rest: Record<string, unknown> = { ...event() };
    delete rest['sizeClass'];
    expect(eventProblem(rest)).toBeNull();
  });

  it('refuses what is not an event', () => {
    for (const value of [null, undefined, 1, 'event', [], [event()]]) {
      expect(eventProblem(value)).toBe('not an object');
    }
  });

  it('refuses free text in every field', () => {
    const fields = [
      'session',
      'seq',
      'at',
      'client',
      'actor',
      'version',
      'channel',
      'os',
      'osVersion',
      'sizeClass',
      'kind',
      'name',
    ] as const;
    const passed = fields.flatMap((field) =>
      FREE_TEXT.filter((text) => eventProblem(event({ [field]: text })) === null).map(
        (text) => `${field}: ${text}`,
      ),
    );
    expect(passed).toEqual([]);
  });

  it('refuses a field it does not know, and props that are not an object', () => {
    expect(eventProblem({ ...event(), title: 'Zebracanary Title Q7' })).toBe('unknown field title');
    expect(eventProblem({ ...event(), install: newInstallId() })).toBe('unknown field install');
    expect(eventProblem(event({ props: ['source'] }))).toBe('props');
    expect(eventProblem(event({ props: null }))).toBe('props');
    expect(eventProblem(event({ props: 'source=key' }))).toBe('props');
  });

  it('refuses free text in every prop of every kind', () => {
    const passed = KINDS.flatMap((kind) =>
      Object.keys(VALID[kind].props).flatMap((key) =>
        FREE_TEXT.filter(
          (text) =>
            eventProblem({ ...VALID[kind], props: { ...VALID[kind].props, [key]: text } }) === null,
        ).map((text) => `${kind}.${key}: ${text}`),
      ),
    );
    expect(passed).toEqual([]);
  });

  it('refuses a free-text list of flags, and lists in any other prop', () => {
    const cli = VALID.cli;
    expect(eventProblem({ ...cli, props: { flags: ['Zebracanary Title Q7'] } })).toBe(
      'prop flags value',
    );
    expect(eventProblem({ ...cli, props: { flags: ['--notebook'] } })).toBe('prop flags value');
    expect(eventProblem({ ...cli, props: { flags: Array(17).fill('json') } })).toBe(
      'prop flags value',
    );
    expect(eventProblem({ ...cli, props: { exit: ['OK'] } })).toBe('prop exit value');
  });

  it('takes only the CLI’s own flag names, never another lower-case word', () => {
    const cli = VALID.cli;
    const flags = (list: unknown) => eventProblem({ ...cli, props: { ...cli.props, flags: list } });
    expect(flags(['json', 'notebook', 'no-sync', 'help'])).toBeNull();
    expect(flags([])).toBeNull();
    for (const word of ['zebracanary', 'zebracanary-title-q7', 'my-secret', 'toString', 'Json']) {
      expect(flags([word]), word).toBe('prop flags value');
      expect(flags(['json', word]), word).toBe('prop flags value');
    }
    for (const name of CLI_FLAGS) expect(name).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(new Set(CLI_FLAGS).size).toBe(CLI_FLAGS.length);
  });

  it('refuses a prop named after one of Object’s own', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      const props = JSON.parse(`{"${key}": "Zebracanary Title Q7"}`) as Record<string, string>;
      expect(eventProblem(event({ props })), key).toBe(`prop ${key}`);
    }
  });

  it('refuses props its kind does not allow', () => {
    expect(eventProblem(event({ props: { title: 'x' } }))).toBe('prop title');
    expect(eventProblem({ ...VALID.click, props: { source: 'key' } })).toBe('prop source');
    expect(eventProblem({ ...VALID.tool, props: { args: '{}' } })).toBe('prop args');
  });

  it('refuses names outside the catalogue, and names of another kind', () => {
    expect(eventProblem(event({ name: 'note.zebracanary' }))).toBe('name');
    expect(eventProblem(event({ kind: 'click', name: 'note.new', props: {} }))).toBe('name');
    expect(eventProblem(event({ kind: 'screen', name: '/note/01JB7Q3V6M8K2T9RZ4XN5C1HPD' }))).toBe(
      'name',
    );
  });

  it('checks each field’s shape', () => {
    expect(eventProblem(event({ session: '0123456789ABCDEF' }))).toBe('session');
    expect(eventProblem(event({ seq: -1 }))).toBe('seq');
    expect(eventProblem(event({ seq: 1.5 }))).toBe('seq');
    expect(eventProblem(event({ at: Number.NaN }))).toBe('at');
    expect(eventProblem(event({ version: '1.4' }))).toBe('version');
    expect(eventProblem(event({ version: '1.4.0-alpha.3' }))).toBeNull();
    expect(eventProblem(event({ osVersion: '15.1.2' }))).toBe('osVersion');
    expect(eventProblem(event({ sizeClass: 'huge' }))).toBe('sizeClass');
    expect(eventProblem(event({ kind: 'note' }))).toBe('kind');
  });

  it('takes a key combination, never typed text', () => {
    for (const keys of ['Mod+N', 'Mod+Alt+N', 'Ctrl+/', 'Shift+Enter', 'F12', 'Mod+Shift+[']) {
      expect(KEYS_PATTERN.test(keys), keys).toBe(true);
    }
    for (const keys of ['Mod+Zebracanary', 'hello', 'Mod+n', 'Mod+Alt+Ctrl+Shift+Meta+N']) {
      expect(KEYS_PATTERN.test(keys), keys).toBe(false);
    }
  });

  it('takes a screen’s from only as a catalogued screen', () => {
    expect(eventProblem({ ...VALID.screen, props: { from: 'note' } })).toBeNull();
    expect(eventProblem({ ...VALID.screen, props: { from: '/note/abc' } })).toBe('prop from value');
  });

  it('takes a setting’s value as a bucket, a boolean or a whole number in range', () => {
    const setting = VALID.setting;
    for (const value of [true, 0, 10_000_000, '5000+']) {
      expect(eventProblem({ ...setting, props: { value } }), String(value)).toBeNull();
    }
    for (const value of [-1, 10_000_001, 1.5, 'dark', 'two words', 'a/b', 'x'.repeat(33)]) {
      expect(eventProblem({ ...setting, props: { value } }), String(value)).toBe(
        'prop value value',
      );
    }
    expect(eventProblem({ ...setting, props: { changed: true } })).toBeNull();
    expect(eventProblem({ ...setting, props: { changed: false } })).toBe('prop changed value');
  });

  it('takes a word only from the words its setting may be', () => {
    const setting = (name: string, value: unknown) =>
      eventProblem({ ...VALID.setting, name, props: { value } });
    expect(setting('theme.mode', 'dark')).toBeNull();
    expect(setting('theme.mode', 'system')).toBeNull();
    expect(setting('theme.id', 'nord')).toBeNull();
    expect(setting('theme.id', 'custom')).toBeNull();
    expect(setting('font.note', 'serif')).toBeNull();
    expect(setting('font.interface', 'custom')).toBeNull();
    expect(setting('tooltip.delay', 'never')).toBeNull();
    expect(setting('tooltip.delay', 1500)).toBeNull();
    expect(setting('capture.destination', 'inbox')).toBeNull();
    expect(setting('updates.channel', 'alpha')).toBeNull();
    // Another setting's word, a word the setting never takes, and a word for a setting that
    // takes none (a time zone, a notebook's name, a font's family) are all refused.
    for (const [name, value] of [
      ['theme.mode', 'nord'],
      ['theme.id', 'Zebracanary'],
      ['theme.id', 'my-theme'],
      ['font.note', 'Helvetica'],
      ['font.note', 'custom:Helvetica'],
      ['capture.destination', 'Zebracanary'],
      ['timeZone', 'UTC'],
      ['template.daily', 'Plan'],
      ['note.fullWidth', 'true'],
      ['sidebar.recentCount', 'ten'],
    ] as const) {
      expect(setting(name, value), `${name}: ${value}`).toBe('prop value value');
    }
  });

  it('lists words only for settings the catalogue has, and none from Object', () => {
    for (const name of Object.keys(SETTING_VALUES)) expect(SETTING_NAMES).toContain(name);
    for (const words of Object.values(SETTING_VALUES)) {
      for (const word of words) expect(word).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    }
    expect(
      eventProblem({ ...VALID.setting, name: 'theme.mode', props: { value: 'toString' } }),
    ).toBe('prop value value');
  });
});

describe('validateBatch', () => {
  const install = newInstallId();

  it('returns the valid events and the index of each refused one', () => {
    const events = [VALID.command, { ...VALID.click, name: 'zebracanary.click' }, VALID.tool, 42];
    expect(validateBatch({ v: 1, install, events })).toEqual({
      install,
      valid: [VALID.command, VALID.tool],
      refused: [1, 3],
    });
  });

  it('refuses a wrong envelope', () => {
    expect(validateBatch(null)).toBeNull();
    expect(validateBatch([])).toBeNull();
    expect(validateBatch({ v: 2, install, events: [] })).toBeNull();
    expect(validateBatch({ v: 1, install: 'Zebracanary', events: [] })).toBeNull();
    expect(validateBatch({ v: 1, install: install.toUpperCase(), events: [] })).toBeNull();
    expect(validateBatch({ v: 1, install, events: {} })).toBeNull();
    expect(validateBatch({ v: 1, install })).toBeNull();
  });

  it('takes at most 200 events', () => {
    const events = Array.from({ length: MAX_BATCH_EVENTS }, (_, seq) => ({
      ...VALID.command,
      seq,
    }));
    expect(validateBatch({ v: 1, install, events })?.valid).toHaveLength(200);
    expect(validateBatch({ v: 1, install, events: [...events, VALID.command] })).toBeNull();
  });

  it('takes an empty batch, with nothing valid', () => {
    expect(validateBatch({ v: 1, install, events: [] })).toEqual({
      install,
      valid: [],
      refused: [],
    });
  });
});

describe('Recorder', () => {
  const fields = () => ({
    client: 'mac' as const,
    actor: 'person' as const,
    version: '1.4.0',
    channel: 'alpha' as const,
    os: 'macos' as const,
    osVersion: '26.1',
    sizeClass: undefined,
  });

  it('stamps, checks and hands on each event, its seq rising only for those kept', () => {
    const sunk: AnalyticsEvent[] = [];
    const dropped: string[] = [];
    let now = 1000;
    const recorder = new Recorder({
      fields,
      sink: (each) => sunk.push(each),
      session: 'fedcba9876543210',
      now: () => (now += 5),
      onDropped: (problem, kind, name) => dropped.push(`${kind} ${name}: ${problem}`),
    });
    expect(
      recorder.record('command', 'note.new', { source: 'palette', keys: undefined } as never),
    ).toBe(true);
    expect(recorder.record('command', 'Zebracanary Title Q7')).toBe(false);
    expect(recorder.record('click', 'privacy.share.on', { state: 'pangolincanary' })).toBe(false);
    expect(recorder.record('screen', 'settings.privacy')).toBe(true);
    expect(sunk.map((each) => [each.seq, each.kind, each.name, each.at])).toEqual([
      [0, 'command', 'note.new', 1005],
      [1, 'screen', 'settings.privacy', 1020],
    ]);
    expect(sunk[0]).toEqual({
      session: 'fedcba9876543210',
      seq: 0,
      at: 1005,
      client: 'mac',
      actor: 'person',
      version: '1.4.0',
      channel: 'alpha',
      os: 'macos',
      osVersion: '26.1',
      kind: 'command',
      name: 'note.new',
      props: { source: 'palette' },
    });
    expect(dropped).toEqual([
      'command Zebracanary Title Q7: name',
      'click privacy.share.on: prop state value',
    ]);
    expect(JSON.stringify(sunk)).not.toMatch(/canary/i);
  });

  it('never throws: a sink or fields that fail drop the event', () => {
    const throwing = new Recorder({
      fields,
      sink: () => {
        throw new Error('full');
      },
    });
    expect(throwing.record('command', 'note.new')).toBe(false);
    const broken = new Recorder({
      fields: () => {
        throw new Error('no window');
      },
      sink: () => undefined,
    });
    expect(broken.record('command', 'note.new')).toBe(false);
    const onDropped = new Recorder({
      fields,
      sink: () => undefined,
      onDropped: () => {
        throw new Error('test');
      },
    });
    expect(onDropped.record('command', 'nope.nope')).toBe(false);
  });

  it('makes a session id of its own', () => {
    expect(new Recorder({ fields, sink: () => undefined }).session).toMatch(SESSION_PATTERN);
  });
});
