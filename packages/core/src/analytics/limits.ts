/**
 * The adjustable limits (PEN-137, O7 and N8): how much usage record and log a device keeps, and
 * how much of the log a bug report attaches. Each has a default, a minimum and a maximum; the
 * person changes them in Settings → Privacy → Advanced (Mac and Android) or with `penmoss
 * analytics limits`. Every reader goes through `readLimits()`, which falls back to the default
 * for a value that is missing, not a whole number or out of range.
 */

export interface LimitSpec {
  readonly key: LimitKey;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** The unit, as the fields and the CLI write it. */
  readonly unit: 'days' | 'events' | 'KB' | 'files' | 'hours' | 'lines';
  /** The group it is shown in. */
  readonly group: 'usage' | 'logs' | 'report';
}

export const LIMIT_KEYS = [
  'events.days',
  'events.max',
  'logs.fileKb',
  'logs.files',
  'logs.days',
  'report.hours',
  'report.lines',
  'report.kb',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LIMITS: readonly LimitSpec[] = [
  { key: 'events.days', default: 7, min: 1, max: 360, unit: 'days', group: 'usage' },
  { key: 'events.max', default: 5000, min: 500, max: 800_000, unit: 'events', group: 'usage' },
  { key: 'logs.fileKb', default: 1024, min: 256, max: 81_920, unit: 'KB', group: 'logs' },
  { key: 'logs.files', default: 2, min: 1, max: 5, unit: 'files', group: 'logs' },
  { key: 'logs.days', default: 7, min: 1, max: 360, unit: 'days', group: 'logs' },
  { key: 'report.hours', default: 24, min: 1, max: 168, unit: 'hours', group: 'report' },
  { key: 'report.lines', default: 300, min: 50, max: 2000, unit: 'lines', group: 'report' },
  { key: 'report.kb', default: 16, min: 4, max: 40, unit: 'KB', group: 'report' },
];

export type Limits = Readonly<Record<LimitKey, number>>;

const BY_KEY = new Map(LIMITS.map((spec) => [spec.key, spec] as const));

export function limitSpec(key: LimitKey): LimitSpec {
  return BY_KEY.get(key)!;
}

export function isLimitKey(key: string): key is LimitKey {
  return BY_KEY.has(key as LimitKey);
}

export const DEFAULT_LIMITS: Limits = Object.fromEntries(
  LIMITS.map((spec) => [spec.key, spec.default]),
) as Limits;

/** Whether `value` is allowed for `key`: a whole number within the range. */
export function limitAllowed(key: LimitKey, value: unknown): value is number {
  const spec = limitSpec(key);
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max
  );
}

/** The limits in force: each stored value when it is allowed, else its default. */
export function readLimits(stored: unknown): Limits {
  const source =
    stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : ({} as const);
  return Object.fromEntries(
    LIMITS.map((spec) => {
      const value = source[spec.key];
      return [spec.key, limitAllowed(spec.key, value) ? value : spec.default];
    }),
  ) as Limits;
}

/** Only the values that differ from their defaults, as the consent file keeps them. */
export function changedLimits(limits: Limits): Partial<Record<LimitKey, number>> {
  return Object.fromEntries(
    LIMITS.filter((spec) => limits[spec.key] !== spec.default).map((spec) => [
      spec.key,
      limits[spec.key],
    ]),
  );
}

/** "Between 1 and 360": what a field says of a value outside its range. */
export function rangeMessage(key: LimitKey): string {
  const spec = limitSpec(key);
  return `Between ${spec.min.toLocaleString('en-US')} and ${spec.max.toLocaleString('en-US')}`;
}

/** "1–360 days": a field's range, written beside it. */
export function rangeLabel(key: LimitKey): string {
  const spec = limitSpec(key);
  return `${spec.min.toLocaleString('en-US')}–${spec.max.toLocaleString('en-US')} ${spec.unit}`;
}

/** Parses a value typed for `key` (the CLI's and the fields'): a whole number or null. */
export function parseLimit(key: LimitKey, text: string): number | null {
  const trimmed = text.trim().replace(/[,_\s]/g, '');
  if (!/^\d{1,7}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return limitAllowed(key, value) ? value : null;
}

/** About how many bytes one stored event takes with its indexes. */
export const EVENT_BYTES = 400;

/** The most space the usage record takes at these limits, in bytes. */
export function eventSpace(limits: Limits): number {
  return limits['events.max'] * EVENT_BYTES;
}

/** The most space the logs take at these limits, in bytes. */
export function logSpace(limits: Limits): number {
  return limits['logs.fileKb'] * 1024 * limits['logs.files'];
}

/** Bytes as the Advanced section writes them: "2 MB", "400 MB", "640 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** How many hours of logs a bug report may attach: no more than the logs keep. */
export function reportHours(limits: Limits): number {
  return Math.min(limits['report.hours'], limits['logs.days'] * 24);
}
