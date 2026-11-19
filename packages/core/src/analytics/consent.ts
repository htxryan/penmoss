/**
 * The person's answer, and the state each event is recorded in (PEN-137, O3). Events are always
 * recorded on the device; the answer only decides whether they leave it:
 * - no answer yet: `pending`, sent only if the first answer is Yes;
 * - No, or DO_NOT_TRACK / PENMOSS_ANALYTICS=off for the CLI and MCP: `local`, never sent;
 * - Yes: `waiting`, then `sent` or `refused`.
 *
 * On the Mac the answer lives in `~/.penmoss/analytics.json`, shared by the app, the CLI and the
 * MCP server (`node/consent-file.ts`); on Android, in a DataStore file excluded from backup.
 * Never in synced settings.
 */
import { newInstallId, STATES, type StateCode } from './events';
import { changedLimits, readLimits, type LimitKey, type Limits } from './limits';

export type ConsentAnswer = 'yes' | 'no';

export interface ConsentFile {
  readonly v: 1;
  /** null until the person answers. */
  readonly consent: ConsentAnswer | null;
  /** The anonymous install id: 32 hex characters. */
  readonly install: string;
  /** When the answer was given (ms). */
  readonly answeredAt: number | null;
  /** The app version that asked. */
  readonly askedVersion: string | null;
  /** Since when sharing has been on (ms), for the viewer's summary. */
  readonly sharingSince: number | null;
  /** The limits that differ from their defaults. */
  readonly limits: Partial<Record<LimitKey, number>>;
}

export function newConsentFile(): ConsentFile {
  return {
    v: 1,
    consent: null,
    install: newInstallId(),
    answeredAt: null,
    askedVersion: null,
    sharingSince: null,
    limits: {},
  };
}

/** Reads a consent file's JSON; anything unreadable is a fresh file (no answer, a new id). */
export function parseConsentFile(raw: unknown): ConsentFile {
  if (!raw || typeof raw !== 'object') return newConsentFile();
  const value = raw as Record<string, unknown>;
  const install =
    typeof value.install === 'string' && /^[0-9a-f]{32}$/.test(value.install)
      ? value.install
      : newInstallId();
  const consent = value.consent === 'yes' || value.consent === 'no' ? value.consent : null;
  const number = (key: string): number | null =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) ? (value[key] as number) : null;
  return {
    v: 1,
    consent,
    install,
    answeredAt: number('answeredAt'),
    askedVersion: typeof value.askedVersion === 'string' ? value.askedVersion.slice(0, 40) : null,
    sharingSince: consent === 'yes' ? number('sharingSince') : null,
    limits: changedLimits(readLimits(value.limits)),
  };
}

export function limitsOf(file: ConsentFile): Limits {
  return readLimits(file.limits);
}

/** Whether an environment opts this process out: DO_NOT_TRACK=1 or PENMOSS_ANALYTICS=off. */
export function envOptsOut(env: Readonly<Record<string, string | undefined>>): boolean {
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  const own = env.PENMOSS_ANALYTICS?.trim().toLowerCase();
  return (
    (dnt !== undefined && dnt !== '' && dnt !== '0' && dnt !== 'false') ||
    own === 'off' ||
    own === '0' ||
    own === 'false' ||
    own === 'no'
  );
}

/** The state an event recorded now takes. */
export function stateFor(consent: ConsentAnswer | null, optedOut = false): StateCode {
  if (optedOut) return STATES.local;
  if (consent === null) return STATES.pending;
  return consent === 'yes' ? STATES.waiting : STATES.local;
}

/** The person answered: the file with the answer, and what becomes of pending events. */
export function answer(
  file: ConsentFile,
  consent: ConsentAnswer,
  now: number,
  version: string | null,
): ConsentFile {
  return {
    ...file,
    consent,
    answeredAt: now,
    askedVersion: version ?? file.askedVersion,
    sharingSince: consent === 'yes' ? (file.sharingSince ?? now) : null,
  };
}

/** A new install id (Reset My Analytics ID, or after Delete My Shared Data). */
export function resetId(file: ConsentFile): ConsentFile {
  return { ...file, install: newInstallId() };
}
