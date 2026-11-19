/**
 * The event format Android records in (PEN-137): `apps/android/contract/analytics-v1.json` holds
 * the kinds, the fields' values, the buckets, the states, the id pattern, the catalogue by kind,
 * each kind's props, the limits and the agent clients, all from `@penmoss/core/analytics`. The
 * Kotlin `TrackedControlsTest` checks Android's ids against its catalogue, and Android's store
 * and validator follow the rest.
 *
 * The catalogue only grows: after adding a name, write the contract again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/core exec vitest run test/analytics-contract`,
 * then `pnpm exec prettier --write apps/android/contract/analytics-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_CLIENTS } from '../src/analytics/actors';
import { CATALOGUE } from '../src/analytics/catalogue';
import {
  ACTORS,
  BATCH_VERSION,
  CHANNELS,
  CLIENTS,
  COUNT_BUCKETS,
  DURATION_BUCKETS,
  EVENT_ID_PATTERN,
  INSTALL_PATTERN,
  KINDS,
  MAX_BACKOFF_MS,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  OSES,
  SEND_AT_WAITING,
  SEND_EVERY_MS,
  SEND_TIMEOUT_MS,
  SESSION_PATTERN,
  SIZE_CLASSES,
  STATE_LABELS,
  STATE_NAMES,
  STATE_ORDER,
  STATES,
} from '../src/analytics/events';
import { LIMITS } from '../src/analytics/limits';
import {
  FLAG_PATTERN,
  KEYS_PATTERN,
  MAX_FLAGS,
  MAX_SETTING_NUMBER,
  OS_VERSION_PATTERN,
  PROP_SPECS,
  SETTING_TOKEN,
  VERSION_PATTERN,
} from '../src/analytics/validate';

const FILE = fileURLToPath(
  new URL('../../../apps/android/contract/analytics-v1.json', import.meta.url),
);

const COMMENT =
  'The usage analytics event format (PEN-137), written from packages/core/src/analytics by packages/core/test/analytics-contract.test.ts, which also checks it. Android records events in this format and checks them as validate.ts does: a name must be in `catalogue` under its kind, and each prop one of `props` for its kind (`enum`: one of `values`; `bool`; `count`: one of `countBuckets`; `duration`: one of `durationBuckets`; `keys`: matches `patterns.keys`; `flags`: at most `maxFlags` names matching `patterns.flag`; `setting`: a boolean, a whole number 0 to `maxSettingNumber`, a count bucket or a word matching `patterns.settingToken`; `screen`: a name in `catalogue.screen`). States are stored as their `code`. The catalogue only grows.';

/** A pattern as Kotlin's Regex takes it: the source, no flags. */
const source = (pattern: RegExp) => {
  expect(pattern.flags).toBe('');
  return pattern.source;
};

function contract() {
  return {
    $comment: COMMENT,
    version: BATCH_VERSION,
    kinds: KINDS,
    clients: CLIENTS,
    actors: ACTORS,
    channels: CHANNELS,
    oses: OSES,
    sizeClasses: SIZE_CLASSES,
    countBuckets: COUNT_BUCKETS,
    durationBuckets: DURATION_BUCKETS,
    states: STATE_NAMES.map((name) => ({ name, code: STATES[name], label: STATE_LABELS[name] })),
    stateOrder: STATE_ORDER,
    patterns: {
      eventId: source(EVENT_ID_PATTERN),
      install: source(INSTALL_PATTERN),
      session: source(SESSION_PATTERN),
      version: source(VERSION_PATTERN),
      osVersion: source(OS_VERSION_PATTERN),
      keys: source(KEYS_PATTERN),
      flag: source(FLAG_PATTERN),
      settingToken: source(SETTING_TOKEN),
    },
    maxFlags: MAX_FLAGS,
    maxSettingNumber: MAX_SETTING_NUMBER,
    sending: {
      maxBatchEvents: MAX_BATCH_EVENTS,
      maxBatchBytes: MAX_BATCH_BYTES,
      everyMs: SEND_EVERY_MS,
      atWaiting: SEND_AT_WAITING,
      timeoutMs: SEND_TIMEOUT_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
    },
    agentClients: AGENT_CLIENTS,
    limits: LIMITS,
    props: PROP_SPECS,
    catalogue: CATALOGUE,
  };
}

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') writeFileSync(FILE, text(contract()));

describe('apps/android/contract/analytics-v1.json', () => {
  const stored = JSON.parse(readFileSync(FILE, 'utf8')) as ReturnType<typeof contract>;

  it('holds the event format as core has it', () => {
    expect(stored).toEqual(JSON.parse(text(contract())));
  });

  it('lists a catalogue for every kind and props for every kind', () => {
    expect(Object.keys(stored.catalogue).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(stored.props).sort()).toEqual([...KINDS].sort());
  });

  it('has patterns Kotlin can read as they are', () => {
    for (const [name, pattern] of Object.entries(stored.patterns)) {
      expect(() => new RegExp(pattern), name).not.toThrow();
      // Kotlin's (Java's) Regex differs from JavaScript's for these; none is used.
      expect(pattern, name).not.toMatch(/\(\?<[!=]|\\p\{|\(\?<\w+>/);
      // A [ inside a class starts a nested class in Java: it must be escaped.
      expect(pattern, name).not.toMatch(/(?<!\\)\[(?:[^\]\\]|\\.)*(?<!\\)\[/);
    }
  });
});
