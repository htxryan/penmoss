/**
 * The CLI's usage analytics in Node (PEN-137): `~/.penmoss/analytics.json` (or under
 * `PENMOSS_HOME`), the shared record in `~/.penmoss/analytics/events.db` over `node:sqlite`, and
 * what every event says of this process: its version, channel and system.
 */
import { release } from 'node:os';
import { majorMinor, type AnalyticsOs, type Channel } from '@penmoss/core/analytics';
import {
  AnalyticsStore,
  analyticsBase,
  consentPath,
  eventsPath,
  readConsentFile,
  sqliteModule,
  writeConsentFile,
} from '@penmoss/core/analytics/node';
import type { AnalyticsIo } from './io';
import { VERSION } from './version';

/** The OS as events name it. */
export function osOf(platform: NodeJS.Platform): AnalyticsOs {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'other';
}

/**
 * macOS's version from Darwin's (`os.release()`), major.minor: Darwin 20–24 is macOS 11–15
 * (major − 9), Darwin 25 on is macOS 26 on (major + 1, the year-named versions), and Darwin's
 * minor is macOS's (Darwin 24.1 is macOS 15.1). Older Darwin is 10.x (Darwin 19 is 10.15).
 */
export function macosVersionOf(darwin: string): string {
  const match = /^(\d+)(?:\.(\d+))?/.exec(darwin.trim());
  if (!match) return '0';
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (major >= 25) return `${major + 1}.${minor}`;
  if (major >= 20) return `${major - 9}.${minor}`;
  if (major >= 5) return `10.${major - 4}`;
  return '0';
}

/** This system's version, major.minor: Electron's own answer for macOS where there is one. */
export function osVersionOf(platform: NodeJS.Platform, kernel: string = release()): string {
  if (platform === 'darwin') {
    const system = (process as { getSystemVersion?: () => string }).getSystemVersion?.();
    return system ? majorMinor(system) : macosVersionOf(kernel);
  }
  return majorMinor(kernel);
}

/** The channel a version was built for: an Alpha build's says so; a packaged one is stable. */
export function channelOf(version: string, packaged: boolean): Channel {
  if (/-alpha\b/.test(version)) return 'alpha';
  return packaged ? 'stable' : 'dev';
}

/**
 * Loads `node:sqlite` without Node's ExperimentalWarning, which would land in the output of a
 * command that never asked for it. Once loaded, the store's own load is silent.
 */
function quietSqlite(): void {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  const original = Object.getOwnPropertyDescriptor(process, 'emitWarning');
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/sqlite/i.test(text)) return;
    emit(warning, ...rest);
  };
  try {
    sqliteModule();
  } finally {
    if (original) Object.defineProperty(process, 'emitWarning', original);
    else delete (process as { emitWarning?: unknown }).emitWarning;
  }
}

export interface NodeAnalyticsOptions {
  /** The version events carry: the Mac app's, when it runs the CLI (default the CLI's). */
  readonly version?: string;
  /** Default: from the version, `dev` for the CLI on its own. */
  readonly channel?: Channel;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function nodeAnalytics(options: NodeAnalyticsOptions = {}): AnalyticsIo {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const version = options.version ?? VERSION;
  const consent = consentPath(env);
  const events = eventsPath(env);
  return {
    consentPath: consent,
    eventsPath: events,
    readConsent: () => readConsentFile(consent),
    writeConsent: (file) => writeConsentFile(file, consent),
    openStore: () => {
      quietSqlite();
      return AnalyticsStore.open(events);
    },
    base: analyticsBase(env),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now: options.now ?? Date.now,
    fields: {
      version,
      channel: options.channel ?? channelOf(version, false),
      os: osOf(platform),
      osVersion: osVersionOf(platform),
    },
  };
}
