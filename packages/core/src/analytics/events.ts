/**
 * Usage analytics' event format (PEN-137): what every client records on its device, and what
 * leaves it in a batch when the person shares. Shared by the page, the Mac app's main process,
 * the CLI, the local MCP server and the ingest Worker (`apps/telemetry`); pinned for Kotlin by
 * `apps/android/contract/analytics-v1.json`.
 *
 * There is no free-text field anywhere: a name is one of the catalogue's ids, and a prop is an
 * enum, a boolean, a bucket, a duration bucket, a limit's value, a window's length rounded to 10
 * (`lengthOf`), a scrolled area's position in hundredths (`fractionOf`, PEN-175), a list of
 * flag names, or session detail's refs, block positions, exact lengths and block tokens
 * (`detail.ts`, PEN-177). So a note's title, a path, a tag, a notebook or repository name, or anything a person typed cannot
 * be recorded, let alone sent (`validate.ts` checks each event before it is stored and again in
 * the Worker).
 */

/** The batch format's version. */
export const BATCH_VERSION = 1;

export const CLIENTS = ['mac', 'android', 'cli', 'mcp'] as const;
export type AnalyticsClient = (typeof CLIENTS)[number];

/** Who did it: a person at the app or a terminal, an agent (MCP, or the CLI under one), or a script. */
export const ACTORS = ['person', 'agent', 'script'] as const;
export type Actor = (typeof ACTORS)[number];

export const CHANNELS = ['stable', 'alpha', 'dev'] as const;
export type Channel = (typeof CHANNELS)[number];

export const OSES = ['macos', 'android', 'linux', 'windows', 'other'] as const;
export type AnalyticsOs = (typeof OSES)[number];

/**
 * Which window an `app window` or `app layout` event is about (PEN-174): the main window (on
 * Android, the launcher and each notebook's), a note window (Mac only), or Quick Capture's
 * window (the Mac's) or sheet (Android's). Settings is a screen in the main window, not one of its own.
 */
export const WINDOWS = ['main', 'note', 'capture'] as const;
export type WindowName = (typeof WINDOWS)[number];

/** How an `app layout` shows the sidebar: in full, as the Mac's icon rail, or not at all. */
export const SIDEBAR_STATES = ['shown', 'rail', 'hidden'] as const;
export type SidebarState = (typeof SIDEBAR_STATES)[number];

/** The shown note's side panel, or `none` with no note on screen. */
export const PANEL_STATES = ['open', 'closed', 'none'] as const;
export type PanelState = (typeof PANEL_STATES)[number];

/** The theme's mode as chosen (not what System resolves to). */
export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeModeName = (typeof THEME_MODES)[number];

/**
 * The longest a window's side is recorded as (PEN-174), in CSS pixels or dp: the second kind of
 * raw number after a limit's value (A1636 as amended).
 */
export const MAX_LENGTH = 10_000;

/** A length as it is recorded: rounded to the nearest 10 and held to 0–MAX_LENGTH. */
export function lengthOf(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  return Math.min(MAX_LENGTH, Math.round(px / 10) * 10);
}

/** The window's width class (Material's), app clients only. */
export const SIZE_CLASSES = ['compact', 'medium', 'expanded'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

export const KINDS = [
  'app',
  'command',
  'screen',
  'dialog',
  'click',
  'menu',
  'setting',
  'firstrun',
  'feedback',
  'sync',
  'cli',
  'tool',
  'scroll',
  // PEN-177: session detail, from the apps only (KIND_CLIENTS).
  'note',
  'input',
  'tree',
] as const;
export type EventKind = (typeof KINDS)[number];

/** Counts are sent as buckets, never as numbers. */
export const COUNT_BUCKETS = [
  '0',
  '1',
  '2–4',
  '5–9',
  '10–49',
  '50–99',
  '100–499',
  '500–999',
  '1000–4999',
  '5000+',
] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

const COUNT_EDGES: ReadonlyArray<readonly [number, CountBucket]> = [
  [5000, '5000+'],
  [1000, '1000–4999'],
  [500, '500–999'],
  [100, '100–499'],
  [50, '50–99'],
  [10, '10–49'],
  [5, '5–9'],
  [2, '2–4'],
  [1, '1'],
];

/** The bucket a count falls in. */
export function countBucket(count: number): CountBucket {
  if (!Number.isFinite(count) || count <= 0) return '0';
  for (const [edge, bucket] of COUNT_EDGES) if (count >= edge) return bucket;
  return '0';
}

/** Durations are sent as buckets too. */
export const DURATION_BUCKETS = [
  '<1s',
  '1–2s',
  '2–5s',
  '5–15s',
  '15–60s',
  '1–5m',
  '5–30m',
  '30m+',
] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

const DURATION_EDGES: ReadonlyArray<readonly [number, DurationBucket]> = [
  [30 * 60_000, '30m+'],
  [5 * 60_000, '5–30m'],
  [60_000, '1–5m'],
  [15_000, '15–60s'],
  [5_000, '5–15s'],
  [2_000, '2–5s'],
  [1_000, '1–2s'],
];

/** The bucket a duration in milliseconds falls in. */
export function durationBucket(ms: number): DurationBucket {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  for (const [edge, bucket] of DURATION_EDGES) if (ms >= edge) return bucket;
  return '<1s';
}

/**
 * An event's state on the device, set when it is recorded from the answer in force then:
 * - `pending`: no answer yet; sent only if the first answer is Yes.
 * - `local`: recorded under No (or DO_NOT_TRACK); never leaves the device.
 * - `waiting`: recorded under Yes; sent next.
 * - `sent`, `refused`: what the endpoint did with it.
 */
export const STATES = { pending: 0, local: 1, waiting: 2, sent: 3, refused: 4 } as const;
export type StateName = keyof typeof STATES;
export type StateCode = (typeof STATES)[StateName];
export const STATE_NAMES: readonly StateName[] = ['pending', 'local', 'waiting', 'sent', 'refused'];

/** How the viewers name each state (Title Case, A938 as amended for PEN-137). */
export const STATE_LABELS: Readonly<Record<StateName, string>> = {
  pending: 'Waiting for Your Answer',
  local: 'Not Shared',
  waiting: 'Waiting to Send',
  sent: 'Sent',
  refused: 'Refused',
};

/** The order counts are written in: "Waiting to Send 2 · Sent 41 · Not Shared 212". */
export const STATE_ORDER: readonly StateName[] = ['pending', 'waiting', 'sent', 'local', 'refused'];

export function stateName(code: number): StateName {
  return STATE_NAMES[code] ?? 'local';
}

/** A prop's value: never free text (see `validate.ts`). */
export type PropValue = string | number | boolean | readonly string[];
export type Props = Readonly<Record<string, PropValue>>;

/** What a client fills in for every event it records. */
export interface ClientFields {
  readonly client: AnalyticsClient;
  readonly actor: Actor;
  readonly version: string;
  readonly channel: Channel;
  readonly os: AnalyticsOs;
  /** major.minor only. */
  readonly osVersion: string;
  readonly sizeClass?: SizeClass | undefined;
}

/** One event as it is recorded and sent. */
export interface AnalyticsEvent extends ClientFields {
  /** One launch, one CLI run or one MCP connection: 16 hex characters. */
  readonly session: string;
  /** Rises within a session. */
  readonly seq: number;
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly kind: EventKind;
  readonly name: string;
  readonly props: Props;
}

/** What leaves the device. */
export interface AnalyticsBatch {
  readonly v: typeof BATCH_VERSION;
  /** 128 random bits as 32 hex characters; the person can reset it. */
  readonly install: string;
  readonly events: readonly AnalyticsEvent[];
}

/** At most this many events in one batch, and this many bytes in its body. */
export const MAX_BATCH_EVENTS = 200;
export const MAX_BATCH_BYTES = 64 * 1024;
/** How the clients pace sending. */
export const SEND_EVERY_MS = 60_000;
export const SEND_AT_WAITING = 25;
export const SEND_TIMEOUT_MS = 10_000;
export const MAX_BACKOFF_MS = 60 * 60_000;

export const INSTALL_PATTERN = /^[0-9a-f]{32}$/;
export const SESSION_PATTERN = /^[0-9a-f]{16}$/;

/** A control's or event's id: lower case, dotted, never built from data. */
export const EVENT_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,4}$/;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A new anonymous install id: 128 random bits. */
export function newInstallId(): string {
  return randomHex(16);
}

/** A new session id: 64 random bits. */
export function newSessionId(): string {
  return randomHex(8);
}

/** An OS version cut to major.minor ("15.1.2" → "15.1"), or "0" when unreadable. */
export function majorMinor(version: string): string {
  const match = /^(\d{1,4})(?:\.(\d{1,4}))?/.exec(version.trim());
  if (!match) return '0';
  return match[2] === undefined ? match[1]! : `${match[1]}.${match[2]}`;
}

/** The OS as events name it, from Node's `process.platform`. */
export function osOf(platform: string): AnalyticsOs {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'other';
}

/**
 * The channel a desktop or CLI build is on, the rule Android's `channelOf` has too: a build that
 * is not packaged (run from source) is `dev` whatever its version, an Alpha build (its version
 * says so) `alpha`, else `stable`.
 */
export function channelOf(version: string, packaged: boolean): Channel {
  if (!packaged) return 'dev';
  return /-alpha\b/.test(version) ? 'alpha' : 'stable';
}

/** The width class of a window `width` CSS pixels (or dp) wide. */
export function sizeClassOf(width: number): SizeClass {
  if (width < 600) return 'compact';
  if (width < 840) return 'medium';
  return 'expanded';
}

/** How the counts by state are written, name first: "Waiting to Send 2 · Sent 41 · Not Shared 212". */
export function countsLine(counts: Readonly<Partial<Record<StateName, number>>>): string {
  const parts = STATE_ORDER.filter((name) => (counts[name] ?? 0) > 0).map(
    (name) => `${STATE_LABELS[name]} ${(counts[name] ?? 0).toLocaleString('en-US')}`,
  );
  return parts.length === 0 ? 'Nothing Recorded Yet' : parts.join(' · ');
}
