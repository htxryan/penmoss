/**
 * Checks an event against the format and the catalogue (PEN-137): every client before it stores
 * one, and the ingest Worker again before it writes one to D1. A name must be catalogued and
 * every prop typed for its kind, or for its name where NAME_PROP_SPECS lists one, so no free text
 * can pass: strings are enums, buckets, flag names, a normalised key combination or one of the
 * words a setting may be (SETTING_VALUES), refs (16 hex characters, PEN-177) or block tokens
 * (BLOCK_PATTERN), and numbers a limit's value, a rounded length, a scrolled area's position in
 * whole hundredths, or session detail's block positions and exact lengths.
 */
import { AGENT_CLIENTS } from './actors';
import { CLI_FLAGS, isCatalogued, isSettingWord } from './catalogue';
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
  MAX_LENGTH,
  OSES,
  PANEL_STATES,
  SESSION_PATTERN,
  SIDEBAR_STATES,
  SIZE_CLASSES,
  THEME_MODES,
  WINDOWS,
  type AnalyticsEvent,
  type EventKind,
} from './events';
import { BUILTIN_THEMES } from './themes';
import { INPUT_FIELDS, isShape, MAX_CHARS, MAX_INDEX, REF_PATTERN } from './detail';

/** Whether a prop's value is allowed, for an event called `name`. */
type Check = (value: unknown, name: string) => boolean;

const oneOf =
  (values: readonly (string | number | boolean)[]): Check =>
  (value) =>
    values.includes(value as never);
const bool: Check = (value) => typeof value === 'boolean';
const count = oneOf(COUNT_BUCKETS);
const took = oneOf(DURATION_BUCKETS);

/**
 * A normalised key combination: modifiers, then one key name ("Mod+Alt+N", "Ctrl+/"). `[` is
 * written `\x5B` so Kotlin's Regex, which reads `[` in a class as a nested class, takes it too.
 */
export const KEYS_PATTERN =
  /^(?:(?:Mod|Ctrl|Alt|Shift|Meta|Cmd|Option)\+){0,4}(?:[A-Z0-9]|F\d{1,2}|[\x5B\]\\;',./`=-]|Enter|Escape|Tab|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/;
const keys: Check = (value) => typeof value === 'string' && KEYS_PATTERN.test(value);

/** The most flags a CLI event names. */
export const MAX_FLAGS = 16;
/** A list of the CLI's own flag names (CLI_FLAGS), never a value or any other word. */
const flags: Check = (value) =>
  Array.isArray(value) &&
  value.length <= MAX_FLAGS &&
  value.every((flag) => typeof flag === 'string' && CLI_FLAGS.includes(flag));

/** The largest whole number a setting's value may be. */
export const MAX_SETTING_NUMBER = 10_000_000;
/**
 * A setting's value: a boolean, a whole number 0 to MAX_SETTING_NUMBER, a count bucket, or one
 * of the words that setting may be (SETTING_VALUES). Any other word is refused.
 */
const settingValue: Check = (value, name) =>
  typeof value === 'boolean' ||
  (typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SETTING_NUMBER) ||
  (typeof value === 'string' && (count(value, name) || isSettingWord(name, value)));

/** A window's length (PEN-174): a whole number of CSS px or dp, a multiple of 10, 0 to MAX_LENGTH. */
const length: Check = (value) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value % 10 === 0 &&
  value >= 0 &&
  value <= MAX_LENGTH;

/**
 * A scrolled area's position (PEN-175): a number from 0 to 1 that is a whole number of
 * hundredths (`fractionOf` rounds it). The third raw number A1636 allows, after a limit's value
 * and a window's length.
 */
const fraction: Check = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1 &&
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;

/** A note's or folder's ref (PEN-177): 16 lower-case hex characters, a keyed hash of its id. */
const ref: Check = (value) => typeof value === 'string' && REF_PATTERN.test(value);
/** A block's position, a count of blocks or a depth (PEN-177): a whole number 0 to MAX_INDEX. */
const index: Check = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_INDEX;
/**
 * A length in characters (PEN-177, O1): a whole number 0 to MAX_CHARS, exact. The fourth raw
 * number A1636 allows, after a limit's value, a window's length and a scroll position.
 */
const chars: Check = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_CHARS;
/** A note's shape (PEN-177): block tokens matching BLOCK_PATTERN, within both caps. */
const shape: Check = (value) => isShape(value);

const screenKind: Check = (value) => typeof value === 'string' && isCatalogued('screen', value);

const CLI_EXITS = [
  'OK',
  'ERROR',
  'USAGE',
  'AUTH',
  'NOT_FOUND',
  'CONFLICT',
  'AMBIGUOUS',
  'REFUSED',
] as const;

const FIRSTRUN_ERRORS = [
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
 * the CLI's flag names (CLI_FLAGS, at most MAX_FLAGS); a setting's value (`settingValue`, by the
 * event's name); a catalogued screen; a window's length (`length`: a whole multiple of 10,
 * 0 to MAX_LENGTH); a scrolled area's position (`fraction`: 0 to 1 in whole hundredths); or
 * session detail's (PEN-177) `ref` (REF_PATTERN), `index` (a whole number 0 to MAX_INDEX),
 * `chars` (a whole number 0 to MAX_CHARS) and `shape` (block tokens, `detail.ts`).
 */
export type PropSpec =
  | { readonly type: 'enum'; readonly values: readonly (string | number | boolean)[] }
  | {
      readonly type:
        | 'bool'
        | 'count'
        | 'duration'
        | 'keys'
        | 'flags'
        | 'setting'
        | 'screen'
        | 'length'
        | 'fraction'
        | 'ref'
        | 'index'
        | 'chars'
        | 'shape';
    };

const enumOf = (values: readonly (string | number | boolean)[]): PropSpec => ({
  type: 'enum',
  values,
});
const BOOL: PropSpec = { type: 'bool' };
const COUNT: PropSpec = { type: 'count' };
const TOOK: PropSpec = { type: 'duration' };
const LENGTH: PropSpec = { type: 'length' };
const REF: PropSpec = { type: 'ref' };
const INDEX: PropSpec = { type: 'index' };
const CHARS: PropSpec = { type: 'chars' };
const SHAPE: PropSpec = { type: 'shape' };
const TRUE = enumOf([true]);

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
  // PEN-175: the area is the event's name; how far down it is, in hundredths.
  scroll: { position: { type: 'fraction' } },
  // PEN-177: each `note` and `tree` name takes its own props (NAME_PROP_SPECS); an `input`'s
  // name is the dialog its field is in, and it says which field and how long its text is.
  note: {},
  input: { field: enumOf(INPUT_FIELDS), chars: CHARS },
  tree: {},
};

/**
 * Props tied to one name, keyed `kind.name` (PEN-174): an event of that name takes these and
 * nothing else, and no other name of its kind takes them (PROP_SPECS.app stays as it is, so
 * `app launch` with a width is refused). `sidebarWidth` is sent only when `sidebar` is shown;
 * `maximised` only from the Mac; `tabs` only where there are tabs (the Mac).
 */
export const NAME_PROP_SPECS: Readonly<Record<string, Readonly<Record<string, PropSpec>>>> = {
  'app.window': {
    window: enumOf(WINDOWS),
    width: LENGTH,
    height: LENGTH,
    fullScreen: BOOL,
    maximised: BOOL,
  },
  'app.layout': {
    window: enumOf(['main', 'note']),
    sidebar: enumOf(SIDEBAR_STATES),
    sidebarWidth: LENGTH,
    panel: enumOf(PANEL_STATES),
    fullWidth: BOOL,
    themeMode: enumOf(THEME_MODES),
    tabs: COUNT,
  },
  // PEN-177: session detail. `note` and `folder` are refs (a keyed hash of the real id), added
  // where the key is (the Mac's main process, Android's Kotlin); `folder` is absent at the top level.
  'note.open': {
    note: REF,
    folder: REF,
    how: enumOf(['open', 'switch', 'resync']),
    titleChars: CHARS,
    shape: SHAPE,
    more: TRUE,
  },
  'note.typing': {
    note: REF,
    block: INDEX,
    title: TRUE,
    typed: CHARS,
    deleted: CHARS,
    remote: TRUE,
  },
  'note.blocks': { note: REF, block: INDEX, removed: INDEX, inserted: SHAPE, remote: TRUE },
  'note.cursor': { note: REF, block: INDEX, title: TRUE },
  'note.select': { note: REF, block: INDEX, chars: CHARS, span: INDEX },
  'tree.expand': { folder: REF, depth: INDEX, source: enumOf(['click', 'key', 'reveal']) },
  'tree.collapse': { folder: REF, depth: INDEX, source: enumOf(['click', 'key', 'reveal']) },
  'tree.open': { note: REF, folder: REF, depth: INDEX, source: enumOf(['click', 'key']) },
};

/**
 * The clients that may send a name NAME_PROP_SPECS lists: the apps, which have windows. The CLI
 * and the MCP server never record a window or a layout (PEN-174), so the check refuses one from them.
 */
const NAME_CLIENTS: Readonly<Record<string, readonly string[]>> = {
  'app.window': ['mac', 'android'],
  'app.layout': ['mac', 'android'],
};

/**
 * The clients that may send a kind at all (PEN-175): a scroll comes only from the apps, which have
 * areas to scroll. A kind not listed may come from any client.
 */
export const KIND_CLIENTS: Readonly<Partial<Record<EventKind, readonly string[]>>> = {
  scroll: ['mac', 'android'],
  // PEN-177: session detail comes from the apps, which have notes open, fields and a tree.
  note: ['mac', 'android'],
  input: ['mac', 'android'],
  tree: ['mac', 'android'],
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
    case 'length':
      return length;
    case 'fraction':
      return fraction;
    case 'ref':
      return ref;
    case 'index':
      return index;
    case 'chars':
      return chars;
    case 'shape':
      return shape;
  }
}

const checksOf = (
  specs: Readonly<Record<string, Readonly<Record<string, PropSpec>>>>,
): Readonly<Record<string, Readonly<Record<string, Check>>>> =>
  Object.fromEntries(
    Object.entries(specs).map(([key, props]) => [
      key,
      Object.fromEntries(Object.entries(props).map(([prop, spec]) => [prop, checkOf(spec)])),
    ]),
  );

const PROPS = checksOf(PROP_SPECS);
const NAME_PROPS = checksOf(NAME_PROP_SPECS);

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
  const kindClients = KIND_CLIENTS[kind];
  if (kindClients && !kindClients.includes(value.client as string)) return 'client';
  if (typeof value.name !== 'string' || !isCatalogued(kind, value.name)) return 'name';
  const props = value.props;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return 'props';
  const named = `${kind}.${value.name}`;
  if (
    Object.hasOwn(NAME_CLIENTS, named) &&
    !NAME_CLIENTS[named]!.includes(value.client as string)
  ) {
    return 'client';
  }
  const checks = Object.hasOwn(NAME_PROPS, named) ? NAME_PROPS[named]! : PROPS[kind]!;
  for (const [key, item] of Object.entries(props)) {
    // Own keys only: `constructor` or `toString` must not find Object's own.
    const check = Object.hasOwn(checks, key) ? checks[key] : undefined;
    if (!check) return `prop ${key}`;
    if (!check(item, value.name)) return `prop ${key} value`;
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
