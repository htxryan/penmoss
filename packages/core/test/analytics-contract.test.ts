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
import {
  CATALOGUE,
  CLI_FLAGS,
  RETIRED_CLICK_NAMES,
  SETTING_VALUES,
} from '../src/analytics/catalogue';
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
  MAX_LENGTH,
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
  BLOCK_PATTERN,
  clampUsage,
  INPUT_FIELDS,
  INPUT_SETTLE_MS,
  MAX_CHARS,
  MAX_INDEX,
  MAX_LIST_DEPTH,
  MAX_SHAPE_BYTES,
  MAX_SHAPE_TOKENS,
  MAX_TABLE_SIDE,
  REF_PATTERN,
  TYPING_GAP_MS,
  type ClampType,
} from '../src/analytics/detail';
import { PROPS_LIST_SHOWN, propsLine } from '../src/analytics/viewer';
import { refOf } from '../src/analytics/node/ref-key';
import { DETAIL_CASES } from './support/detail-cases';
import { SCROLL_MIN_GAP_MS, SCROLL_SETTLE_MS } from '../src/analytics/scroll';
import {
  eventProblem,
  KEYS_PATTERN,
  KIND_CLIENTS,
  MAX_FLAGS,
  MAX_SETTING_NUMBER,
  NAME_PROP_SPECS,
  OS_VERSION_PATTERN,
  PROP_SPECS,
  VERSION_PATTERN,
} from '../src/analytics/validate';

const FILE = fileURLToPath(
  new URL('../../../apps/android/contract/analytics-v1.json', import.meta.url),
);

const COMMENT =
  'The usage analytics event format (PEN-137), written from packages/core/src/analytics by packages/core/test/analytics-contract.test.ts, which also checks it. Android records events in this format and checks them as validate.ts does: a name must be in `catalogue` under its kind, and each prop one of `props` for its kind (`enum`: one of `values`; `bool`; `count`: one of `countBuckets`; `duration`: one of `durationBuckets`; `keys`: matches `patterns.keys`; `flags`: at most `maxFlags` names, each one of `cliFlags`; `setting`: a boolean, a whole number 0 to `maxSettingNumber`, a count bucket, or one of the words `settingValues` lists for the event name (a setting not listed takes no word); `screen`: a name in `catalogue.screen`; `length`: a whole number, a multiple of 10, 0 to `maxLength`; `fraction`: a number from 0 to 1 that is a whole number of hundredths). An event whose `kind.name` is a key of `nameProps` takes the props of that entry instead of those of its kind, and no other name of the kind takes them. A kind listed in `kindClients` comes only from those clients. A `scroll` event is recorded `scroll.settleMs` after its area stops moving, at most one per area every `scroll.minGapMs` (scroll-v1.json pins the rules). Session detail (PEN-177): `ref` matches `patterns.ref` (16 hex characters, the first of hex(HMAC-SHA256(the key’s 32 bytes, type + ":" + id)), `refVectors` pinning it); `index` is a whole number 0 to `detail.maxIndex`; `chars` a whole number 0 to `detail.maxChars`; `shape` a list of at most `detail.maxShapeTokens` tokens, each matching `patterns.block` with a length of at most `detail.maxChars`, and at most `detail.maxShapeBytes` as JSON. `clamp` holds clampUsage’s cases ([type, value, clamped]), `propsLine` the viewers’ line for each props object, and `eventCases` events of the new kinds with the problem eventProblem finds (null: valid). No control records a click id in `retiredClickNames`; they stay catalogued. States are stored as their `code`. The catalogue only grows.';

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
      ref: source(REF_PATTERN),
      block: source(BLOCK_PATTERN),
    },
    maxFlags: MAX_FLAGS,
    cliFlags: CLI_FLAGS,
    maxSettingNumber: MAX_SETTING_NUMBER,
    maxLength: MAX_LENGTH,
    settingValues: SETTING_VALUES,
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
    nameProps: NAME_PROP_SPECS,
    kindClients: KIND_CLIENTS,
    scroll: { settleMs: SCROLL_SETTLE_MS, minGapMs: SCROLL_MIN_GAP_MS },
    catalogue: CATALOGUE,
    retiredClickNames: RETIRED_CLICK_NAMES,
    detail: {
      maxIndex: MAX_INDEX,
      maxChars: MAX_CHARS,
      maxShapeTokens: MAX_SHAPE_TOKENS,
      maxShapeBytes: MAX_SHAPE_BYTES,
      maxTableSide: MAX_TABLE_SIDE,
      maxListDepth: MAX_LIST_DEPTH,
      typingGapMs: TYPING_GAP_MS,
      inputSettleMs: INPUT_SETTLE_MS,
      inputFields: INPUT_FIELDS,
      propsListShown: PROPS_LIST_SHOWN,
    },
    refVectors: REF_VECTORS.map(([key, type, id]) => ({
      key,
      type,
      id,
      ref: refOf(key, type, id),
    })),
    clamp: CLAMP_CASES.map(([type, value]) => [type, value, clampUsage(type, value)]),
    propsLine: PROPS_LINE_CASES.map((props) => ({ props, line: propsLine(props) })),
    eventCases: DETAIL_CASES.map((event) => ({ event, problem: eventProblem(event) })),
  };
}

/** Keys, types and ids whose refs Kotlin must make the same. */
const REF_VECTORS: ReadonlyArray<readonly [string, 'note' | 'folder', string]> = [
  ['00'.repeat(32), 'note', '01JB7Q3V6M8K2T9RZ4XN5C1HPD'],
  ['00'.repeat(32), 'folder', 'Projects/Penmoss'],
  ['0123456789abcdef'.repeat(4), 'note', '01JB7Q3V6M8K2T9RZ4XN5C1HPD'],
  ['0123456789abcdef'.repeat(4), 'note', 'notebook-1/Plans for the week.md'],
  ['f'.repeat(64), 'folder', 'Journal/2026/Ünïcødé ✓'],
  ['a1b2c3d4'.repeat(8), 'folder', ''],
];

const CLAMP_CASES: ReadonlyArray<readonly [ClampType, number]> = [
  ['chars', 0],
  ['chars', 182],
  ['chars', 1_000_000],
  ['chars', 2_000_000],
  ['chars', -3],
  ['chars', 12.7],
  ['index', 4999],
  ['index', 5000],
  ['index', 6000],
  ['side', 0],
  ['side', 4],
  ['side', 999],
  ['side', 1200],
  ['depth', 1],
  ['depth', 9],
  ['depth', 12],
];

const PROPS_LINE_CASES: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  {},
  { source: 'key', keys: 'Mod+K' },
  { state: 'on', remote: true, typed: 12 },
  { flags: ['json', 'notebook'] },
  { shape: Array.from({ length: 12 }, (_, i) => `p:${i}`) },
  { note: '0123456789abcdef', shape: Array.from({ length: 500 }, (_, i) => `p:${i}`), more: true },
];

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

  it('ties name props to catalogued names only', () => {
    for (const key of Object.keys(stored.nameProps)) {
      const [kind, ...rest] = key.split('.');
      expect(stored.catalogue[kind as keyof typeof stored.catalogue], key).toContain(
        rest.join('.'),
      );
    }
    expect(Object.keys(stored.nameProps).sort()).toEqual([
      'app.layout',
      'app.window',
      'note.blocks',
      'note.cursor',
      'note.open',
      'note.select',
      'note.typing',
      'tree.collapse',
      'tree.expand',
      'tree.open',
    ]);
  });

  it('has a case for every prop of every new name, valid and refused (PEN-177)', () => {
    for (const [named, props] of Object.entries(stored.nameProps)) {
      if (!/^(note|tree)\./.test(named)) continue;
      for (const prop of Object.keys(props)) {
        const cases = stored.eventCases.filter(
          (each) => `${each.event.kind}.${each.event.name}` === named && prop in each.event.props,
        );
        expect(
          cases.some((each) => each.problem === null),
          `${named}.${prop} valid`,
        ).toBe(true);
        expect(
          cases.some((each) => each.problem === `prop ${prop} value`),
          `${named}.${prop} refused`,
        ).toBe(true);
      }
    }
    for (const prop of ['field', 'chars']) {
      const cases = stored.eventCases.filter(
        (each) => each.event.kind === 'input' && prop in each.event.props,
      );
      expect(cases.some((each) => each.problem === null)).toBe(true);
      expect(cases.some((each) => each.problem === `prop ${prop} value`)).toBe(true);
    }
    for (const kind of ['note', 'input', 'tree']) {
      for (const client of ['cli', 'mcp']) {
        expect(
          stored.eventCases.some(
            (each) =>
              each.event.kind === kind && each.event.client === client && each.problem === 'client',
          ),
          `${kind} from ${client}`,
        ).toBe(true);
      }
    }
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
