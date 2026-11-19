/**
 * A fixture D1 (PEN-137): five weeks of made-up usage from twelve installs, eight Macs (with the
 * CLI and agents' MCP calls) and four phones, through the first run and everyday use, rolled up as
 * the nightly cron would. The named-query tests, the dashboard's tests and its Playwright spec
 * all read it. Every event passes core's checks, so nothing here could not have been sent.
 */
import { isValidEvent, type AnalyticsEvent } from '@penmoss/core/analytics';
import { addDays, dayOf } from '../src/day';
import { insertEvent } from '../src/ingest';
import { refreshCatalogue, rollUp } from '../src/nightly';

/** How many days back the fixture's usage goes. */
export const FIXTURE_DAYS = 35;
/** The Paths start every fixture session has, and the next events most of them have. */
export const FIXTURE_START = 'command:app.palette';

export interface FixtureInstall {
  readonly install: string;
  readonly events: AnalyticsEvent[];
}

const hex = (n: number, length: number) =>
  n
    .toString(16)
    .padStart(2, '0')
    .repeat(length / 2);

type Draft = Pick<AnalyticsEvent, 'kind' | 'name' | 'props'> &
  Partial<Pick<AnalyticsEvent, 'client' | 'actor'>>;

const FIRST_RUN_DONE = ['welcome', 'goal', 'way', 'github', 'accounts', 'repo', 'name', 'setup'];

function dayDrafts(index: number, day: number, phone: boolean): Draft[] {
  const drafts: Draft[] = [
    { kind: 'app', name: 'launch', props: { notebooks: '1', notes: '10–49' } },
    { kind: 'screen', name: 'home', props: {} },
    { kind: 'command', name: 'app.palette', props: { source: 'key', keys: 'Mod+K', ran: true } },
    { kind: 'command', name: 'note.new', props: { source: 'palette', ran: true } },
    { kind: 'screen', name: 'note', props: { from: 'home' } },
  ];
  // One session in five finds a note by search instead; one Mac takes a rare turn once (a
  // path seen in fewer than 5 sessions, which Paths never shows).
  if ((index + day) % 5 === 0) {
    drafts.splice(3, 1, { kind: 'command', name: 'app.search', props: { source: 'palette' } });
  }
  if (index === 3 && day === 4) {
    drafts.splice(3, 1, { kind: 'command', name: 'app.trash', props: { source: 'palette' } });
  }
  drafts.push(
    {
      kind: 'command',
      name: 'note.new',
      // Two Macs set their own shortcut for New Note.
      props: { source: 'key', keys: index < 2 ? 'Mod+Alt+N' : 'Mod+N', custom: index < 2 },
    },
    { kind: 'dialog', name: 'search', props: { action: 'open' } },
    { kind: 'dialog', name: 'search', props: { action: 'done', open: '2–5s' } },
    { kind: 'click', name: 'privacy.share.on', props: { state: 'on' } },
    {
      kind: 'sync',
      name: 'pass',
      props: { result: day % 9 === 0 ? 'offline' : 'ok', took: '<1s' },
    },
  );
  if (day % 6 === 0) {
    drafts.push({ kind: 'setting', name: 'tooltip.delay', props: { value: 500 } });
    drafts.push({ kind: 'setting', name: 'privacy.limits.events.days', props: { value: 30 } });
  }
  if (!phone) {
    drafts.push(
      { kind: 'menu', name: 'copy', props: { source: 'menubar' } },
      {
        kind: 'command',
        name: 'app.quickOpen',
        props: { source: index % 2 === 0 ? 'menu' : 'tray' },
      },
      {
        kind: 'cli',
        name: 'search',
        client: 'cli',
        actor: index % 3 === 0 ? 'agent' : 'person',
        props: { flags: ['json'], exit: 'OK', took: '<1s', tty: index % 3 !== 0 },
      },
      {
        kind: 'tool',
        name: 'search_notes',
        client: 'mcp',
        actor: 'agent',
        props: {
          agentClient: index % 2 === 0 ? 'claude-code' : 'codex',
          result: day % 7 === 0 ? 'failed' : 'ok',
          took: '<1s',
        },
      },
    );
  }
  if (index === 2 && day % 10 === 1) {
    drafts.push({
      kind: 'feedback',
      name: 'sent',
      props: { type: 'bug', priority: 2, screenshots: '1', logs: true },
    });
  }
  drafts.push({ kind: 'app', name: 'quit', props: {} });
  return drafts;
}

function firstRunDrafts(index: number): Draft[] {
  // Two phones give up: one at GitHub's sign-in, one going back from the repository step.
  if (index === 10) {
    return [
      ...['welcome', 'goal', 'way'].map((step) => ({
        kind: 'firstrun' as const,
        name: step,
        props: { result: 'done' },
      })),
      { kind: 'firstrun', name: 'github', props: { result: 'failed', error: 'auth' } },
    ];
  }
  if (index === 11) {
    return [
      ...['welcome', 'goal', 'way', 'github', 'accounts'].map((step) => ({
        kind: 'firstrun' as const,
        name: step,
        props: { result: 'done' },
      })),
      { kind: 'firstrun', name: 'repo', props: { result: 'back' } },
    ];
  }
  return [
    ...FIRST_RUN_DONE.map((step) => ({
      kind: 'firstrun' as const,
      name: step,
      props: { result: 'done' },
    })),
    { kind: 'firstrun', name: 'consent', props: { result: 'done' } },
  ];
}

/** The fixture's installs and their events, the last FIXTURE_DAYS days before `now`. */
export function fixtureInstalls(now: number): FixtureInstall[] {
  const today = dayOf(now);
  const startOfToday = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: 12 }, (_, index) => {
    const phone = index >= 8;
    const install = hex(index + 0xa0, 32);
    const events: AnalyticsEvent[] = [];
    // Phones 10 and 11 never got past the first run.
    const lastDay = index >= 10 ? FIXTURE_DAYS - index : 0;
    for (let ago = FIXTURE_DAYS - index; ago >= lastDay; ago--) {
      const first = ago === FIXTURE_DAYS - index;
      // Each install skips a day now and then; its first day and today are always there.
      if (!first && ago > 0 && (index + ago) % 4 === 0) continue;
      const drafts = first ? firstRunDrafts(index) : dayDrafts(index, ago, phone);
      const session = ago.toString(16).padStart(8, '0') + index.toString(16).padStart(8, '0');
      const base = startOfToday - ago * 86_400_000 + (9 + (index % 8)) * 3_600_000;
      // Older days ran the version before.
      const version = ago > 20 ? '1.3.0' : index < 4 || phone ? '1.4.0' : '1.3.2';
      drafts.forEach((draft, seq) => {
        const event: AnalyticsEvent = {
          session,
          seq,
          at: Math.min(base + seq * 30_000, now),
          client: draft.client ?? (phone ? 'android' : 'mac'),
          actor: draft.actor ?? 'person',
          version: index >= 10 ? '1.2.0' : version,
          channel: index % 4 === 0 ? 'alpha' : 'stable',
          os: phone ? 'android' : 'macos',
          osVersion: phone ? (index % 2 === 0 ? '16' : '15') : index % 2 === 0 ? '26.1' : '15.6',
          ...(draft.client === 'cli' || draft.client === 'mcp'
            ? {}
            : { sizeClass: phone ? 'compact' : 'expanded' }),
          kind: draft.kind,
          name: draft.name,
          props: draft.props,
        };
        if (!isValidEvent(event)) {
          throw new Error(`fixture event ${draft.kind}:${draft.name} is not valid`);
        }
        events.push(event);
      });
    }
    return { install, events };
  });
}

/** Fills `db` (migrated, empty) with the fixture as it stands at `now`, rolled up. */
export async function seedFixture(db: D1Database, now: number): Promise<void> {
  const statements = fixtureInstalls(now).flatMap(({ install, events }) =>
    events.map((event) => insertEvent(db, install, event, now)),
  );
  for (let start = 0; start < statements.length; start += 100) {
    await db.batch(statements.slice(start, start + 100));
  }
  const today = dayOf(now);
  await rollUp(db, today, FIXTURE_DAYS + 1);
  // The ingest Worker's own counts, as it would have kept them.
  const health = Array.from({ length: FIXTURE_DAYS }, (_, ago) =>
    db
      .prepare(
        `INSERT INTO ingest_daily (day, batches, accepted, dropped, forgets, written)
         VALUES (?1, ?2, ?3, ?4, ?5, ?3)`,
      )
      .bind(addDays(today, -ago), 40 + (ago % 7), 400 + ago * 3, ago % 5, ago === 12 ? 1 : 0),
  );
  await db.batch(health);
  await refreshCatalogue(db);
}
