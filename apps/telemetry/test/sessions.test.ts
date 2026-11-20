/**
 * The Sessions tab's named queries (PEN-173) against the fixture D1, with more added: an install
 * with 1,200 short sessions (the side list's 500-nearest window and its ties), a session of 5,002
 * events (the timeline's limit) and an event 100 days back (never read). What each query should
 * answer is worked out here from the same events and compared row for row.
 */
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsEvent } from '@penmoss/core/analytics';
import { addDays, dayOf } from '../src/day';
import { insertEvent } from '../src/ingest';
import { NAMED_QUERIES, parameterCount, runQuery, type QueryParams } from '../src/queries';
import { fixtureInstalls, seedFixture } from './fixture';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
const TODAY = dayOf(NOW);
const DAY = 86_400_000;
const ALL: QueryParams = {
  days: 30,
  client: '',
  actor: '',
  channel: '',
  version: '',
  today: TODAY,
};

/** The install with 1,200 sessions, and the one whose one session has 5,002 events. */
const MANY = 'b1'.repeat(16);
const LONG = 'c2'.repeat(16);
const LONG_SESSION = '00000000000c0de0';
/** A session 100 days back, outside every window the dashboard reads. */
const OLD_SESSION = 'ffffffffffffffff';

interface Stored extends AnalyticsEvent {
  readonly install: string;
}

const event = (install: string, fields: Partial<AnalyticsEvent>): Stored => ({
  install,
  session: '0000000000000000',
  seq: 0,
  at: NOW,
  client: 'cli',
  actor: 'person',
  version: '1.4.0',
  channel: 'stable',
  os: 'macos',
  osVersion: '26.1',
  kind: 'cli',
  name: 'search',
  props: { flags: ['json'], exit: 'OK', took: '1–2s', tty: true },
  ...fields,
});

/**
 * MANY's sessions: two start at each minute, so every start is shared by a pair, and the pair's
 * session ids run against their order of making, so only the tie rule puts them in order. One
 * in three has a second event.
 */
function manySessions(): Stored[] {
  const base = NOW - 80 * DAY;
  return Array.from({ length: 1200 }, (_, i) => {
    const session = (i ^ 1).toString(16).padStart(16, '0');
    const at = base + Math.floor(i / 2) * 60_000;
    const first = event(MANY, { session, at });
    return i % 3 === 0
      ? [first, event(MANY, { session, seq: 1, at: at + 5_000, kind: 'cli', name: 'list' })]
      : [first];
  }).flat();
}

function longSession(): Stored[] {
  return Array.from({ length: 5002 }, (_, seq) =>
    event(LONG, {
      session: LONG_SESSION,
      seq,
      at: NOW - 10 * DAY + seq * 1000,
      client: 'mac',
      sizeClass: 'expanded',
      kind: 'command',
      name: 'app.palette',
      props: { source: 'key', keys: 'Mod+K', ran: true },
    }),
  );
}

const EXTRA: Stored[] = [
  ...manySessions(),
  ...longSession(),
  event(MANY, { session: OLD_SESSION, at: NOW - 100 * DAY }),
];

const EVERY: Stored[] = [
  ...fixtureInstalls(NOW).flatMap(({ install, events }) =>
    events.map((e): Stored => ({ ...e, install })),
  ),
  ...EXTRA,
];

beforeAll(async () => {
  await seedFixture(env.DB, NOW);
  const statements = EXTRA.map(({ install, ...e }) => insertEvent(env.DB, install, e, NOW));
  for (let start = 0; start < statements.length; start += 100) {
    await env.DB.batch(statements.slice(start, start + 100));
  }
});

interface SessionRow {
  install: string;
  session: string;
  started: number;
  ended: number;
  events: number;
  took: string | null;
  client: string;
  version: string;
  os: string;
  os_version: string;
  first_screen: string | null;
  last_screen: string | null;
  total: number;
}

const dayOfEvent = (e: Stored) => dayOf(Math.min(e.at, NOW));
const inDays = (e: Stored, days: number) => {
  const day = dayOfEvent(e);
  return day > addDays(TODAY, -Math.min(days, 90)) && day <= TODAY;
};
const keyOf = (e: { install: string; session: string }) => `${e.install}:${e.session}`;

/** What sessions.sql should list for `params`, every page, in order. */
function expectedSessions(params: QueryParams) {
  const window = EVERY.filter((e) => inDays(e, params.days));
  const matches = (e: Stored) =>
    (!params.client || e.client === params.client) &&
    (!params.actor || e.actor === params.actor) &&
    (!params.channel || e.channel === params.channel) &&
    (!params.version || e.version === params.version);
  const matched = new Set(window.filter(matches).map(keyOf));
  const groups = new Map<string, Stored[]>();
  for (const e of window) {
    if (!matched.has(keyOf(e))) continue;
    groups.set(keyOf(e), [...(groups.get(keyOf(e)) ?? []), e]);
  }
  return [...groups.values()]
    .map((events) => {
      const bySeq = [...events].sort((a, b) => a.seq - b.seq);
      const screens = bySeq.filter((e) => e.kind === 'screen');
      const first = bySeq[0]!;
      return {
        install: first.install,
        session: first.session,
        started: Math.min(...events.map((e) => e.at)),
        ended: Math.max(...events.map((e) => e.at)),
        events: events.length,
        client: first.client,
        first_screen: screens[0]?.name ?? null,
        last_screen: screens.at(-1)?.name ?? null,
      };
    })
    .sort(
      (a, b) =>
        b.started - a.started ||
        a.install.localeCompare(b.install) ||
        a.session.localeCompare(b.session),
    );
}

const sessionsPage = (params: QueryParams) => runQuery<SessionRow>(env.DB, 'sessions', params);

describe('sessions.sql', () => {
  it('binds ?1 to ?11', () => {
    expect(parameterCount(NAMED_QUERIES.sessions)).toBe(11);
    expect(parameterCount(NAMED_QUERIES.session)).toBe(10);
    expect(parameterCount(NAMED_QUERIES['install-sessions'])).toBe(10);
  });

  it('lists the newest first, 50 a page, with the total', async () => {
    const expected = expectedSessions(ALL);
    expect(expected.length).toBeGreaterThan(100);
    const first = await sessionsPage(ALL);
    expect(first).toHaveLength(50);
    expect(first.map(keyOf)).toEqual(expected.slice(0, 50).map(keyOf));
    expect(first[0]!.total).toBe(expected.length);
    // Page 2 starts at the 51st.
    const second = await sessionsPage({ ...ALL, page: 2 });
    expect(second.map(keyOf)).toEqual(expected.slice(50, 100).map(keyOf));
    // A page past the end is empty.
    const past = Math.ceil(expected.length / 50) + 1;
    expect(await sessionsPage({ ...ALL, page: past })).toEqual([]);
  });

  it('works out each session: start, end, events, client, version, OS, first and last screen', async () => {
    const expected = expectedSessions(ALL);
    const rows = await sessionsPage(ALL);
    for (const row of rows) {
      const want = expected.find((e) => keyOf(e) === keyOf(row))!;
      expect(row).toMatchObject(want);
    }
    // An everyday session goes from Home to Note; the fixture's sessions all run on a Mac or a
    // phone, so every row has an OS and a version.
    const everyday = rows.find((row) => row.events > 5)!;
    expect(everyday).toMatchObject({ first_screen: 'home', last_screen: 'note', took: null });
    expect(everyday.os).toMatch(/^(macos|android)$/);
  });

  it('has no screens for a first-run session, and a took for a one-event session', async () => {
    const rows = await sessionsPage({ ...ALL, days: 90, page: 1 });
    const all: SessionRow[] = [...rows];
    for (let page = 2; page <= Math.ceil(rows[0]!.total / 50); page++) {
      all.push(...(await sessionsPage({ ...ALL, days: 90, page })));
    }
    expect(all).toHaveLength(rows[0]!.total);
    const firstRun = all.find((row) => row.install === 'abababababababababababababababab')!;
    expect(firstRun).toMatchObject({ first_screen: null, last_screen: null, client: 'android' });
    const oneEvent = all.find((row) => row.install === MANY && row.events === 1)!;
    expect(oneEvent).toMatchObject({ took: '1–2s', client: 'cli', started: oneEvent.ended });
  });

  it('lists a session when any of its events matches every filter', async () => {
    const total = (await sessionsPage(ALL))[0]!.total;
    for (const filter of [
      { client: 'android' },
      { client: 'cli' },
      { actor: 'agent' },
      { channel: 'alpha' },
      { version: '1.3.2' },
      { client: 'mac', channel: 'alpha' },
    ]) {
      const params = { ...ALL, ...filter };
      const expected = expectedSessions(params);
      const rows = await sessionsPage(params);
      expect(rows.map(keyOf), JSON.stringify(filter)).toEqual(expected.slice(0, 50).map(keyOf));
      expect(rows[0]!.total, JSON.stringify(filter)).toBe(expected.length);
      expect(expected.length).toBeLessThan(total);
    }
    // A Mac session matched by its CLI run (an event in it) shows the session as a whole: its
    // first event's client, all of its events.
    const cli = await sessionsPage({ ...ALL, client: 'cli' });
    expect(cli.some((row) => row.client === 'mac' && row.events > 5)).toBe(true);
  });

  it('reads at most the last 90 days, whatever the period', async () => {
    const year = await sessionsPage({ ...ALL, days: 365 });
    const quarter = await sessionsPage({ ...ALL, days: 90 });
    expect(year[0]!.total).toBe(quarter[0]!.total);
    expect(year.map(keyOf)).toEqual(quarter.map(keyOf));
    expect(quarter[0]!.total).toBe(expectedSessions({ ...ALL, days: 90 }).length);
    const all: SessionRow[] = [];
    for (let page = 1; page <= Math.ceil(year[0]!.total / 50); page++) {
      all.push(...(await sessionsPage({ ...ALL, days: 365, page })));
    }
    expect(all.some((row) => row.session === OLD_SESSION)).toBe(false);
  });
});

interface EventRow {
  seq: number;
  at: number;
  client: string;
  kind: string;
  name: string;
  props: string;
  size_class: string | null;
}

describe('session.sql', () => {
  it('gives one session’s events in seq order, with their props', async () => {
    const [{ install, events }] = fixtureInstalls(NOW);
    const session = events.at(-1)!.session;
    const rows = await runQuery<EventRow>(env.DB, 'session', { ...ALL, install, session });
    const own = events.filter((e) => e.session === session);
    expect(rows.map((row) => row.seq)).toEqual(own.map((e) => e.seq));
    expect(rows.map((row) => `${row.kind}:${row.name}`)).toEqual(
      own.map((e) => `${e.kind}:${e.name}`),
    );
    expect(JSON.parse(rows[2]!.props)).toEqual(own[2]!.props);
    expect(rows[0]).toMatchObject({ client: 'mac', size_class: 'expanded' });
  });

  it('reads the last 90 days only, whatever the period and the filters', async () => {
    const old = await runQuery(env.DB, 'session', {
      ...ALL,
      days: 395,
      install: MANY,
      session: OLD_SESSION,
    });
    expect(old).toEqual([]);
    // The period and the filters change nothing.
    const [{ install, events }] = fixtureInstalls(NOW);
    const session = events[0]!.session;
    const narrow = await runQuery(env.DB, 'session', {
      ...ALL,
      days: 7,
      client: 'android',
      install,
      session,
    });
    expect(narrow.length).toBe(events.filter((e) => e.session === session).length);
  });

  it('stops at 5,001 events, so the page can say there were more', async () => {
    const rows = await runQuery<EventRow>(env.DB, 'session', {
      ...ALL,
      install: LONG,
      session: LONG_SESSION,
    });
    expect(rows).toHaveLength(5001);
    expect(rows.at(-1)!.seq).toBe(5000);
  });
});

interface InstallSessionRow {
  session: string;
  started: number;
  ended: number;
  events: number;
  took: string | null;
  client: string;
  total: number;
}

describe('install-sessions.sql', () => {
  /** MANY's sessions in the 90 days, in start order, ties by session. */
  const ordered = [
    ...new Map(
      EXTRA.filter((e) => e.install === MANY && inDays(e, 90)).map((e) => [e.session, e]),
    ).values(),
  ]
    .map((e) => ({
      session: e.session,
      started: Math.min(
        ...EXTRA.filter((x) => x.install === MANY && x.session === e.session).map((x) => x.at),
      ),
    }))
    .sort((a, b) => a.started - b.started || a.session.localeCompare(b.session))
    .map((e) => e.session);

  const around = (session: string) =>
    runQuery<InstallSessionRow>(env.DB, 'install-sessions', {
      ...ALL,
      install: MANY,
      session,
    });

  it('lists the install’s sessions oldest first, ties by session, whatever the filters', async () => {
    const [{ install, events }] = fixtureInstalls(NOW);
    const sessions = [
      ...new Set(events.filter((e) => inDays({ ...e, install }, 90)).map((e) => e.session)),
    ];
    const rows = await runQuery<InstallSessionRow>(env.DB, 'install-sessions', {
      ...ALL,
      days: 7,
      client: 'android',
      actor: 'script',
      install,
      session: sessions[0]!,
    });
    expect(rows.map((row) => row.session)).toEqual(sessions);
    expect(rows[0]!.total).toBe(sessions.length);
    // The install is a Mac: its CLI runs sit inside the app's sessions here.
    expect(rows[0]!.client).toBe('mac');
    const started = rows.map((row) => row.started);
    expect(started).toEqual([...started].sort((a, b) => a - b));
  });

  it('keeps the 500 nearest the open session, a total counted before the cut', async () => {
    expect(ordered).toHaveLength(1200);
    const window = async (index: number, before: number, after: number) => {
      const rows = await around(ordered[index]!);
      expect(rows, `at ${index}`).toHaveLength(500);
      expect(rows.map((row) => row.session)).toEqual(
        ordered.slice(index - before, index + after + 1),
      );
      expect(rows[0]!.total).toBe(1200);
    };
    // The first session, the 51st, the 600th (a tie at 250 goes to the older) and the last.
    await window(0, 0, 499);
    await window(50, 50, 449);
    await window(599, 250, 249);
    await window(1199, 499, 0);
  });

  it('says how long a one-event session took, and its client', async () => {
    const rows = await around(ordered[0]!);
    const one = rows.find((row) => row.events === 1)!;
    expect(one).toMatchObject({ took: '1–2s', client: 'cli' });
    const two = rows.find((row) => row.events === 2)!;
    expect(two.took).toBeNull();
    expect(two.ended - two.started).toBe(5000);
    // The session 100 days back is never read.
    expect(rows.some((row) => row.session === OLD_SESSION)).toBe(false);
  });

  it('is empty for a session the install does not have', async () => {
    expect(await around('0123456789abcdef')).toEqual([]);
  });
});
