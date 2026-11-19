/**
 * Checks an event against the format and the catalogue (PEN-137): every client before it stores
 * one, and the ingest Worker again before it writes one to D1. A name must be catalogued and
 * every prop typed for its kind, so no free text can pass: strings are enums, buckets, flag
 * names or a normalised key combination.
 */
import { AGENT_CLIENTS } from './actors';
import { isCatalogued } from './catalogue';
import {
  ACTORS,
  BATCH_VERSION,
  CHANNELS,
  CLIENTS,
  COUNT_BUCKETS,
  DURATION_BUCKETS,
  INSTALL_PATTERN,
  KINDS,
  MAX_BATCH_EVENTS,
  OSES,
  SESSION_PATTERN,
  SIZE_CLASSES,
  type AnalyticsEvent,
  type EventKind,
} from './events';
import { BUILTIN_THEMES } from './themes';

type Check = (value: unknown) => boolean;

const oneOf =
  (values: readonly (string | number | boolean)[]): Check =>
  (value) =>
    values.includes(value as never);
const bool: Check = (value) => typeof value === 'boolean';
const count = oneOf(COUNT_BUCKETS);
const took = oneOf(DURATION_BUCKETS);

/** A normalised key combination: modifiers, then one key name ("Mod+Alt+N", "Ctrl+/"). */
export const KEYS_PATTERN =
  /^(?:(?:Mod|Ctrl|Alt|Shift|Meta|Cmd|Option)\+){0,4}(?:[A-Z0-9]|F\d{1,2}|[[\]\\;',./`=-]|Enter|Escape|Tab|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/;
const keys: Check = (value) => typeof value === 'string' && KEYS_PATTERN.test(value);

/** A CLI flag's name, never its value. */
const FLAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const flags: Check = (value) =>
  Array.isArray(value) &&
  value.length <= 16 &&
  value.every((flag) => typeof flag === 'string' && FLAG_PATTERN.test(flag));

/** A setting's value: an enum-like token, a boolean, a bucket or a small whole number. */
const SETTING_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/;
const settingValue: Check = (value) =>
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000_000) ||
  (typeof value === 'string' && (SETTING_TOKEN.test(value) || count(value)));

const screenKind: Check = (value) => typeof value === 'string' && isCatalogued('screen', value);

export const CLI_EXITS = [
  'OK',
  'ERROR',
  'USAGE',
  'AUTH',
  'NOT_FOUND',
  'CONFLICT',
  'AMBIGUOUS',
  'REFUSED',
] as const;

export const FIRSTRUN_ERRORS = [
  'offline',
  'auth',
  'notFound',
  'conflict',
  'gitMissing',
  'refused',
  'other',
] as const;

/** Each kind's props: the only keys allowed, and what each may hold. */
const PROPS: Readonly<Record<EventKind, Readonly<Record<string, Check>>>> = {
  app: {
    notebooks: count,
    notes: count,
    agents: bool,
    theme: oneOf([...BUILTIN_THEMES, 'custom']),
    active: took,
  },
  command: {
    source: oneOf(['key', 'palette', 'button', 'menu', 'tray', 'hotkey', 'editor', 'other']),
    keys,
    custom: bool,
    ran: bool,
  },
  screen: { from: screenKind },
  dialog: { action: oneOf(['open', 'done', 'cancel']), open: took },
  click: { state: oneOf(['on', 'off']) },
  menu: { source: oneOf(['menubar', 'tray', 'context']) },
  setting: { value: settingValue, changed: oneOf([true]) },
  firstrun: { result: oneOf(['done', 'back', 'failed']), error: oneOf(FIRSTRUN_ERRORS) },
  feedback: {
    type: oneOf(['bug', 'feature']),
    priority: oneOf([1, 2, 3, 4]),
    screenshots: count,
    logs: bool,
    groupsLeftOut: count,
  },
  sync: {
    result: oneOf(['ok', 'conflict', 'offline', 'failed']),
    took,
    changed: count,
  },
  cli: { flags, exit: oneOf(CLI_EXITS), took, tty: bool },
  tool: {
    agentClient: oneOf(AGENT_CLIENTS),
    result: oneOf(['ok', 'invalid', 'notFound', 'conflict', 'failed']),
    took,
  },
};

const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,20})?$/;
const OS_VERSION_PATTERN = /^\d{1,4}(?:\.\d{1,4})?$/;

/** Why `event` is not a valid event, or null when it is. */
export function eventProblem(event: unknown): string | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'not an object';
  const value = event as Record<string, unknown>;
  const allowed = new Set([
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
    'props',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return `unknown field ${key}`;
  if (typeof value.session !== 'string' || !SESSION_PATTERN.test(value.session)) return 'session';
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) return 'seq';
  if (typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at < 0) return 'at';
  if (!CLIENTS.includes(value.client as never)) return 'client';
  if (!ACTORS.includes(value.actor as never)) return 'actor';
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) return 'version';
  if (!CHANNELS.includes(value.channel as never)) return 'channel';
  if (!OSES.includes(value.os as never)) return 'os';
  if (typeof value.osVersion !== 'string' || !OS_VERSION_PATTERN.test(value.osVersion)) {
    return 'osVersion';
  }
  if (value.sizeClass !== undefined && !SIZE_CLASSES.includes(value.sizeClass as never)) {
    return 'sizeClass';
  }
  if (!KINDS.includes(value.kind as never)) return 'kind';
  const kind = value.kind as EventKind;
  if (typeof value.name !== 'string' || !isCatalogued(kind, value.name)) return 'name';
  const props = value.props;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return 'props';
  const checks = PROPS[kind];
  for (const [key, item] of Object.entries(props)) {
    const check = checks[key];
    if (!check) return `prop ${key}`;
    if (!check(item)) return `prop ${key} value`;
  }
  return null;
}

export function isValidEvent(event: unknown): event is AnalyticsEvent {
  return eventProblem(event) === null;
}

export interface BatchCheck {
  /** The valid events, in the order sent. */
  readonly valid: readonly AnalyticsEvent[];
  /** The index in the batch of each event refused. */
  readonly refused: readonly number[];
}

/** Checks a whole batch: null when its envelope is wrong, else the valid events and the rest. */
export function validateBatch(body: unknown): (BatchCheck & { readonly install: string }) | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (value.v !== BATCH_VERSION) return null;
  if (typeof value.install !== 'string' || !INSTALL_PATTERN.test(value.install)) return null;
  if (!Array.isArray(value.events) || value.events.length > MAX_BATCH_EVENTS) return null;
  const valid: AnalyticsEvent[] = [];
  const refused: number[] = [];
  value.events.forEach((event: unknown, index) => {
    if (isValidEvent(event)) valid.push(event);
    else refused.push(index);
  });
  return { install: value.install, valid, refused };
}
