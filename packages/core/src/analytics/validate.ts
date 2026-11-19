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
export const FLAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** The most flags a CLI event names. */
export const MAX_FLAGS = 16;
const flags: Check = (value) =>
  Array.isArray(value) &&
  value.length <= MAX_FLAGS &&
  value.every((flag) => typeof flag === 'string' && FLAG_PATTERN.test(flag));

/** A setting's value: an enum-like token, a boolean, a bucket or a small whole number. */
export const SETTING_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/;
/** The largest whole number a setting's value may be. */
export const MAX_SETTING_NUMBER = 10_000_000;
const settingValue: Check = (value) =>
  typeof value === 'boolean' ||
  (typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SETTING_NUMBER) ||
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

/**
 * What a prop may hold, as data (the Kotlin twin reads it from `analytics-v1.json`): one of a
 * list; a boolean; a count or a duration bucket; a key combination (KEYS_PATTERN); a list of
 * flag names (FLAG_PATTERN, at most MAX_FLAGS); a setting's value; or a catalogued screen.
 */
export type PropSpec =
  | { readonly type: 'enum'; readonly values: readonly (string | number | boolean)[] }
  | { readonly type: 'bool' | 'count' | 'duration' | 'keys' | 'flags' | 'setting' | 'screen' };

const enumOf = (values: readonly (string | number | boolean)[]): PropSpec => ({
  type: 'enum',
  values,
});
const BOOL: PropSpec = { type: 'bool' };
const COUNT: PropSpec = { type: 'count' };
const TOOK: PropSpec = { type: 'duration' };

/** Each kind's props: the only keys allowed, and what each may hold. */
export const PROP_SPECS: Readonly<Record<EventKind, Readonly<Record<string, PropSpec>>>> = {
  app: {
    notebooks: COUNT,
    notes: COUNT,
    agents: BOOL,
    theme: enumOf([...BUILTIN_THEMES, 'custom']),
    active: TOOK,
  },
  command: {
    source: enumOf(['key', 'palette', 'button', 'menu', 'tray', 'hotkey', 'editor', 'other']),
    keys: { type: 'keys' },
    custom: BOOL,
    ran: BOOL,
  },
  screen: { from: { type: 'screen' } },
  dialog: { action: enumOf(['open', 'done', 'cancel']), open: TOOK },
  click: { state: enumOf(['on', 'off']) },
  menu: { source: enumOf(['menubar', 'tray', 'context']) },
  setting: { value: { type: 'setting' }, changed: enumOf([true]) },
  firstrun: { result: enumOf(['done', 'back', 'failed']), error: enumOf(FIRSTRUN_ERRORS) },
  feedback: {
    type: enumOf(['bug', 'feature']),
    priority: enumOf([1, 2, 3, 4]),
    screenshots: COUNT,
    logs: BOOL,
    groupsLeftOut: COUNT,
  },
  sync: {
    result: enumOf(['ok', 'conflict', 'offline', 'failed']),
    took: TOOK,
    changed: COUNT,
  },
  cli: { flags: { type: 'flags' }, exit: enumOf(CLI_EXITS), took: TOOK, tty: BOOL },
  tool: {
    agentClient: enumOf(AGENT_CLIENTS),
    result: enumOf(['ok', 'invalid', 'notFound', 'conflict', 'failed']),
    took: TOOK,
  },
};

function checkOf(spec: PropSpec): Check {
  switch (spec.type) {
    case 'enum':
      return oneOf(spec.values);
    case 'bool':
      return bool;
    case 'count':
      return count;
    case 'duration':
      return took;
    case 'keys':
      return keys;
    case 'flags':
      return flags;
    case 'setting':
      return settingValue;
    case 'screen':
      return screenKind;
  }
}

const PROPS: Readonly<Record<string, Readonly<Record<string, Check>>>> = Object.fromEntries(
  Object.entries(PROP_SPECS).map(([kind, props]) => [
    kind,
    Object.fromEntries(Object.entries(props).map(([key, spec]) => [key, checkOf(spec)])),
  ]),
);

/** An app's version (`1.4.0`, `1.4.0-alpha.3`) and an OS version cut to major.minor. */
export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,20})?$/;
export const OS_VERSION_PATTERN = /^\d{1,4}(?:\.\d{1,4})?$/;

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
  const checks = PROPS[kind]!;
  for (const [key, item] of Object.entries(props)) {
    // Own keys only: `constructor` or `toString` must not find Object's own.
    const check = Object.hasOwn(checks, key) ? checks[key] : undefined;
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
