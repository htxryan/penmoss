/**
 * `penmoss analytics` (PEN-137, N4): the same answer, ID, record and limits as the Mac app's
 * Settings → Privacy, in `~/.penmoss/analytics.json` and `~/.penmoss/analytics/events.db`. It
 * never asks: `on` and `off` are the only way the CLI answers. The CLI and the MCP server only
 * record; the app sends, so only `forget` reaches the network.
 */
import {
  analyticsCopy,
  answer,
  countsLine,
  DEFAULT_LIMITS,
  envOptsOut,
  isLimitKey,
  LIMITS,
  limitsOf,
  limitSpec,
  parseLimit,
  rangeLabel,
  rangeMessage,
  resetId,
  STATE_LABELS,
  STATE_NAMES,
  changedLimits,
  type ClientFilter,
  type ConsentFile,
  type LimitKey,
  type Limits,
  type StateName,
  type StoredEvent,
} from '@penmoss/core/analytics';
import { forgetShared, type AnalyticsStore } from '@penmoss/core/analytics/node';
import { UsageError } from '../args';
import type { Command, Context } from '../command';
import { CliError, EXIT } from '../errors';
import { iso, when } from '../format';
import type { AnalyticsIo } from '../io';
import { VERSION } from '../version';

const ACTIONS = ['status', 'on', 'off', 'reset', 'forget', 'show', 'limits'] as const;
type Action = (typeof ACTIONS)[number];

const CLIENTS: readonly ClientFilter[] = ['all', 'app', 'cli', 'mcp'];

function analyticsOf(context: Context): AnalyticsIo {
  const analytics = context.io.analytics;
  if (!analytics) {
    throw new CliError(EXIT.ERROR, 'This penmoss keeps no usage record here.', 'unsupported');
  }
  return analytics;
}

/** The record, or null where it cannot be opened (no node:sqlite, a read-only home). */
function openRecord(analytics: AnalyticsIo): AnalyticsStore | null {
  try {
    return analytics.openStore();
  } catch {
    return null;
  }
}

/** Runs `work` on the record, or returns null where there is none. */
function withRecord<T>(analytics: AnalyticsIo, work: (record: AnalyticsStore) => T): T | null {
  const record = openRecord(analytics);
  if (!record) return null;
  try {
    return work(record);
  } finally {
    record.close();
  }
}

/** The record must be there: `show` reads it. */
function needRecord<T>(analytics: AnalyticsIo, work: (record: AnalyticsStore) => T): T {
  const record = openRecord(analytics);
  if (!record) {
    throw new CliError(
      EXIT.ERROR,
      `The usage record (${analytics.eventsPath}) cannot be opened here: it needs Node 22.13 or later.`,
      'unsupported',
    );
  }
  try {
    return work(record);
  } finally {
    record.close();
  }
}

type Sharing = 'on' | 'off' | 'unanswered';

const sharingOf = (file: ConsentFile): Sharing =>
  file.consent === 'yes' ? 'on' : file.consent === 'no' ? 'off' : 'unanswered';

function sharingLine(file: ConsentFile): string {
  if (file.consent === 'yes') {
    return `Sharing: on, since ${when(file.sharingSince)}. Penmoss for Mac sends the record.`;
  }
  if (file.consent === 'no') return 'Sharing: off. The record stays on this Mac.';
  return 'Sharing: not answered yet. Events wait for your answer (penmoss analytics on or off, or Penmoss for Mac).';
}

const DNT_NOTE =
  'DO_NOT_TRACK or PENMOSS_ANALYTICS=off is set here: what this shell records stays on this Mac.';

function status(context: Context, analytics: AnalyticsIo): void {
  const file = analytics.readConsent();
  const counts = withRecord(analytics, (record) => record.counts());
  const limits = limitsOf(file);
  const optedOut = envOptsOut(context.io.env);
  const data = {
    sharing: sharingOf(file),
    consent: file.consent,
    id: file.install,
    answeredAt: iso(file.answeredAt),
    sharingSince: iso(file.sharingSince),
    counts,
    limits,
    optedOut,
    files: { answer: analytics.consentPath, record: analytics.eventsPath },
  };
  context.emit(data, () => [
    sharingLine(file),
    `Analytics ID: ${file.install}`,
    `Recorded: ${counts ? countsLine(counts) : 'the record cannot be opened here'}`,
    `Kept: ${limits['events.days'].toLocaleString('en-US')} days, at most ${limits['events.max'].toLocaleString('en-US')} events (penmoss analytics limits)`,
    `Answer and ID: ${analytics.consentPath}`,
    `Record: ${analytics.eventsPath}`,
    ...(optedOut ? [DNT_NOTE] : []),
  ]);
}

function turn(context: Context, analytics: AnalyticsIo, consent: 'yes' | 'no'): void {
  const before = analytics.readConsent();
  const now = analytics.now();
  const same = before.consent === consent;
  const after = same ? before : answer(before, consent, now, before.askedVersion ?? VERSION);
  if (!same) analytics.writeConsent(after);
  // The first answer decides what was recorded before it (O3); a later Off stops what waits.
  let moved = 0;
  if (!same) {
    moved =
      withRecord(analytics, (record) =>
        before.consent === null
          ? record.applyAnswer(consent)
          : consent === 'no'
            ? record.sharingOff()
            : 0,
      ) ?? 0;
  }
  const optedOut = envOptsOut(context.io.env);
  context.emit(
    { sharing: sharingOf(after), changed: !same, moved, id: after.install, optedOut },
    () => {
      const lines: string[] = [];
      if (same) {
        lines.push(consent === 'yes' ? 'Already sharing usage data.' : 'Already not sharing.');
      } else if (consent === 'yes') {
        lines.push(
          before.consent === null
            ? `Sharing usage data. What was recorded before your answer${moved ? ` (${moved.toLocaleString('en-US')} events)` : ''} is sent too, by Penmoss for Mac.`
            : 'Sharing usage data from now on. What was recorded while it was off stays on this Mac.',
        );
      } else {
        lines.push(
          `Not sharing. The record stays on this Mac${moved ? `, ${moved.toLocaleString('en-US')} events that were waiting to be sent among it` : ''}.`,
        );
      }
      if (optedOut) lines.push(DNT_NOTE);
      return lines;
    },
  );
}

function newId(analytics: AnalyticsIo): { file: ConsentFile; moved: number } {
  const file = resetId(analytics.readConsent());
  analytics.writeConsent(file);
  const moved = withRecord(analytics, (record) => record.unsentToLocal()) ?? 0;
  return { file, moved };
}

function reset(context: Context, analytics: AnalyticsIo): void {
  const { file, moved } = newId(analytics);
  context.emit({ id: file.install, moved }, () => [
    analyticsCopy('privacy.resetId.done', 'mac'),
    `Analytics ID: ${file.install}`,
  ]);
}

async function forget(context: Context, analytics: AnalyticsIo): Promise<void> {
  const old = analytics.readConsent().install;
  const outcome = await forgetShared(old, {
    base: analytics.base,
    ...(analytics.fetch ? { fetch: analytics.fetch } : {}),
  });
  if (outcome === 'offline') {
    throw new CliError(EXIT.ERROR, analyticsCopy('forget.offline', 'mac'), 'offline');
  }
  if (outcome === 'failed') {
    throw new CliError(
      EXIT.ERROR,
      'Penmoss’s server could not delete your shared data, so nothing changed. Try again later.',
      'forget_failed',
    );
  }
  const { file } = newId(analytics);
  context.emit({ deleted: old, id: file.install }, () => [
    analyticsCopy('forget.done', 'mac'),
    `Analytics ID: ${file.install}`,
  ]);
}

function stateFilter(value: string | undefined): StateName | 'all' | undefined {
  if (value === undefined) return undefined;
  const wanted = value.trim().toLowerCase();
  if (wanted === 'all' || (STATE_NAMES as readonly string[]).includes(wanted)) {
    return wanted as StateName | 'all';
  }
  throw new UsageError(`--state is one of all, ${STATE_NAMES.join(', ')} (got ${value})`);
}

function clientFilter(value: string | undefined): ClientFilter | undefined {
  if (value === undefined) return undefined;
  const wanted = value.trim().toLowerCase();
  if ((CLIENTS as readonly string[]).includes(wanted)) return wanted as ClientFilter;
  throw new UsageError(`--client is one of ${CLIENTS.join(', ')} (got ${value})`);
}

function propsText(props: StoredEvent['props']): string {
  return Object.entries(props)
    .filter(([, value]) => !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join(' ');
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_cell, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ')
      .trimEnd(),
  );
}

function show(context: Context, analytics: AnalyticsIo): void {
  const state = stateFilter(context.string('state'));
  const client = clientFilter(context.string('client'));
  const limit = context.number('limit') ?? 100;
  if (limit > 1000) throw new UsageError('--limit is at most 1000');
  const beforeText = context.string('before');
  const beforeId = beforeText === undefined ? undefined : Number(beforeText);
  if (beforeId !== undefined && !(Number.isSafeInteger(beforeId) && beforeId > 0)) {
    throw new UsageError(`--before takes an event’s id, a whole number (got ${beforeText})`);
  }
  const page = needRecord(analytics, (record) => {
    const before = beforeId === undefined ? undefined : record.cursor(beforeId);
    if (beforeId !== undefined && !before) {
      throw new CliError(EXIT.NOT_FOUND, `No event ${beforeId} in the record.`, 'not_found');
    }
    return record.page({ state, client, limit, before: before ?? undefined });
  });
  const { events, total, newer } = page;
  if (context.json) {
    // JSON lines: one event a line, newest first.
    for (const event of events) context.io.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (events.length === 0) {
    context.io.stdout.write(
      total === 0 && newer === 0 ? 'Nothing recorded yet.\n' : 'No earlier events.\n',
    );
    return;
  }
  const rows = [
    ['ID', 'Time', 'Client', 'Kind', 'Name', 'State', 'Props'],
    ...events.map((event) => [
      String(event.id),
      when(event.at),
      event.client,
      event.kind,
      event.name,
      STATE_LABELS[event.state],
      propsText(event.props),
    ]),
  ];
  const last = events[events.length - 1]!;
  const lines = [
    ...table(rows),
    '',
    `Showing ${(newer + 1).toLocaleString('en-US')}–${(newer + events.length).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`,
  ];
  if (newer + events.length < total) {
    const again = ['penmoss analytics show', `--before ${last.id}`];
    if (state) again.push(`--state ${state}`);
    if (client) again.push(`--client ${client}`);
    if (limit !== 100) again.push(`--limit ${limit}`);
    lines.push(`Earlier: ${again.join(' ')}`);
  }
  context.io.stdout.write(`${lines.join('\n')}\n`);
}

function limitRows(limits: Limits) {
  return LIMITS.map((spec) => ({
    key: spec.key,
    value: limits[spec.key],
    default: spec.default,
    min: spec.min,
    max: spec.max,
    unit: spec.unit,
  }));
}

function printLimits(context: Context, limits: Limits, extra: readonly string[] = []): void {
  const rows = limitRows(limits);
  context.emit({ limits: rows }, () => [
    ...table([
      ['Key', 'Value', 'Default', 'Range'],
      ...rows.map((row) => [
        row.key,
        row.value.toLocaleString('en-US'),
        row.default.toLocaleString('en-US'),
        rangeLabel(row.key),
      ]),
    ]),
    ...extra,
  ]);
}

/** Writes new limits; lowered event limits delete what falls outside them now. */
function saveLimits(analytics: AnalyticsIo, next: Limits): string[] {
  const file = analytics.readConsent();
  analytics.writeConsent({ ...file, limits: changedLimits(next) });
  const removed = withRecord(analytics, (record) => record.pruneNow(next, analytics.now())) ?? 0;
  return removed > 0
    ? [`Deleted ${removed.toLocaleString('en-US')} events that fall outside the new limits.`]
    : [];
}

function limitKey(text: string | undefined): LimitKey {
  if (text === undefined) throw new UsageError('missing key');
  if (!isLimitKey(text)) {
    throw new UsageError(
      `unknown limit “${text}”: one of ${LIMITS.map((spec) => spec.key).join(', ')}`,
    );
  }
  return text;
}

function limits(context: Context, analytics: AnalyticsIo, args: readonly string[]): void {
  const [action, ...rest] = args;
  const current = limitsOf(analytics.readConsent());
  if (action === undefined) {
    printLimits(context, current);
    return;
  }
  if (action === 'set') {
    if (rest.length !== 2)
      throw new UsageError('usage: penmoss analytics limits set <key> <value>');
    const key = limitKey(rest[0]);
    const value = parseLimit(key, rest[1]!);
    if (value === null) {
      throw new UsageError(
        `${key}: ${rangeMessage(key)} ${limitSpec(key).unit} (got ${rest[1]}); it stays ${current[key].toLocaleString('en-US')}`,
      );
    }
    const next = { ...current, [key]: value };
    printLimits(context, next, saveLimits(analytics, next));
    return;
  }
  if (action === 'reset') {
    if (rest.length > 1) throw new UsageError(`unexpected argument “${rest[1]}”`);
    const next =
      rest.length === 0
        ? DEFAULT_LIMITS
        : (() => {
            const key = limitKey(rest[0]);
            return { ...current, [key]: limitSpec(key).default };
          })();
    printLimits(context, next, saveLimits(analytics, next));
    return;
  }
  throw new UsageError(`unknown limits action “${action}”: set or reset`);
}

export const analytics: Command = {
  name: 'analytics',
  summary: 'See and change usage analytics: sharing, ID, the record and its limits',
  usage: [
    'analytics [status]',
    'analytics on|off',
    'analytics reset|forget',
    'analytics show [--client <client>] [--state <state>] [--limit <n>] [--before <id>]',
    'analytics limits [set <key> <value> | reset [<key>]]',
  ],
  description: [
    'Penmoss records what you do in it by name (commands, buttons, the CLI’s commands and their flags’ names, agents’ MCP tool calls), on this Mac, and never anything you write or name: no note, title, tag, search, path, notebook or argument. Penmoss for Mac sends the record to Penmoss’s developer only if you share it. This command shows and changes the same answer, ID, record and limits as Settings → Privacy in the app, kept in ~/.penmoss/analytics.json and ~/.penmoss/analytics/events.db. It never asks.',
    'status shows whether you share, your analytics ID, what is recorded by state, the limits and the files. on shares from now on; as your first answer, it also shares what was recorded before it. off stops sharing: what waits to be sent stays on this Mac. reset gives this Mac a new ID, and what was not yet sent stays here. forget asks Penmoss’s server to delete everything shared under your ID, then gives this Mac a new ID; offline, nothing changes.',
    'show lists the record, newest first, 100 events at a time: --before <id> pages to earlier ones, --client app, cli or mcp and --state pending, waiting, sent, local or refused filter it, and --json prints one event a line.',
    'limits lists how much is kept (Settings → Privacy → Advanced); limits set <key> <value> changes one, refusing a value out of its range, and limits reset puts one, or all, back to the default. Lowering an event limit deletes what falls outside it at once.',
    'DO_NOT_TRACK=1 or PENMOSS_ANALYTICS=off keeps what a shell records on this Mac, whatever the answer.',
  ],
  flags: [
    {
      name: 'client',
      type: 'string',
      value: 'client',
      description: 'show: only all, app, cli or mcp',
    },
    {
      name: 'state',
      type: 'string',
      value: 'state',
      description: 'show: only all, pending, waiting, sent, local or refused',
    },
    {
      name: 'limit',
      type: 'integer',
      value: 'n',
      description: 'show: at most this many events (default 100, at most 1000)',
    },
    {
      name: 'before',
      type: 'string',
      value: 'id',
      description: 'show: the events before this one (the Earlier line gives it)',
    },
  ],
  examples: [
    'penmoss analytics',
    'penmoss analytics off',
    'penmoss analytics show --client cli',
    'penmoss analytics limits set events.days 30',
    'penmoss analytics limits reset',
  ],
  async run(context) {
    const [first, ...rest] = context.positionals;
    const action: Action = first === undefined ? 'status' : (first as Action);
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw new UsageError(`unknown action “${first}”: ${ACTIONS.join(', ')}`);
    }
    const showOnly = ['client', 'state', 'limit', 'before'].filter(
      (flag) => context.flags[flag] !== undefined,
    );
    if (action !== 'show' && showOnly.length > 0) {
      throw new UsageError(`--${showOnly[0]} is for penmoss analytics show`);
    }
    if (action !== 'limits' && rest.length > 0) {
      throw new UsageError(`unexpected argument “${rest[0]}”`);
    }
    const analytics = analyticsOf(context);
    switch (action) {
      case 'status':
        return status(context, analytics);
      case 'on':
        return turn(context, analytics, 'yes');
      case 'off':
        return turn(context, analytics, 'no');
      case 'reset':
        return reset(context, analytics);
      case 'forget':
        return forget(context, analytics);
      case 'show':
        return show(context, analytics);
      case 'limits':
        return limits(context, analytics, rest);
    }
  },
};
