/**
 * The Android app's place for every command (T40 P6, FD6, A466):
 * apps/android/contract/commands-v1.json lists each command of the registry
 * (`COMMANDS`: the app's, then the editor's) with an `android` entry that says
 * how a phone reaches it: `{ "search": true }`, an action in Search's Actions
 * section; `{ "elsewhere": "…" }`, another screen or menu; or `{ "na": "…" }`,
 * why it does not apply. A command added here without an entry fails this
 * test, so parity holds as the app grows. The Kotlin `SearchActionsTest`
 * reads the same file: the phone's actions are exactly the `search` entries,
 * with these titles, and rank as `fuzzy` ranks them (the `fuzzy` cases).
 *
 * After changing the registry, write the file again (entries are kept by id;
 * a new command gets `null`, which fails until it is filled in):
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/web test android-commands-contract`, then
 * `pnpm exec prettier --write apps/android/contract/commands-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/commands/definitions';
import { fuzzy } from '../../src/commands/fuzzy';

const FILE = fileURLToPath(new URL('../../../android/contract/commands-v1.json', import.meta.url));
const PARITY = fileURLToPath(
  new URL('../../../../docs/evidence/t40/parity-matrix.md', import.meta.url),
);

/** Queries whose ranking the phone must match: the plan's examples, and some edges. */
const QUERIES = ['dark', 'week', 'folder', 'today', 'set', 'tr', 'new', 'theme', 'nw', 'zzz'];

type Android = { search: true } | { elsewhere: string } | { na: string } | null;

interface Entry {
  readonly id: string;
  readonly title: string;
  readonly area: string;
  readonly scope: string;
  readonly android: Android;
}

interface Contract {
  readonly $comment: string;
  readonly version: 1;
  readonly commands: readonly Entry[];
  readonly fuzzy: ReadonlyArray<{ readonly query: string; readonly ids: readonly string[] }>;
}

const COMMENT =
  'Every command of apps/web/src/commands/definitions.ts and how the Android app reaches it (T40 P6, FD6, A466): {"search": true} is an action in Search, {"elsewhere": …} another screen or menu, {"na": …} why it does not apply. Checked and written by apps/web/test/unit/android-commands-contract.test.ts; read by the Kotlin SearchActionsTest. `fuzzy`: the Search actions each query finds, best first, as the palette ranks them.';

function read(): Contract | null {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Contract;
  } catch {
    return null;
  }
}

/** The search actions a query finds, as the palette ranks commands (Palette.tsx). */
function ranked(entries: readonly Entry[], query: string): string[] {
  return entries
    .filter((entry) => entry.android !== null && 'search' in entry.android)
    .map((entry) => ({ entry, match: fuzzy(query, entry.title) }))
    .filter((found) => found.match !== null)
    .sort((a, b) => b.match!.score - a.match!.score)
    .map((found) => found.entry.id);
}

function contract(existing: Contract | null): Contract {
  const kept = new Map(existing?.commands.map((entry) => [entry.id, entry.android]));
  const commands = COMMANDS.map((command): Entry => ({
    id: command.id,
    title: command.title,
    area: command.area,
    scope: command.scope,
    android: kept.get(command.id) ?? null,
  }));
  return {
    $comment: COMMENT,
    version: 1,
    commands,
    fuzzy: QUERIES.map((query) => ({ query, ids: ranked(commands, query) })),
  };
}

const text = (value: Contract) => `${JSON.stringify(value, null, 2)}\n`;

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') writeFileSync(FILE, text(contract(read())));

describe('apps/android/contract/commands-v1.json (FD6)', () => {
  const stored = read();

  it('lists every command of the registry, in its order, with its title', () => {
    expect(stored).not.toBeNull();
    expect(stored).toEqual(contract(stored));
  });

  it('says for every command how a phone reaches it, or why it does not apply', () => {
    const missing = stored!.commands.filter((entry) => {
      const android = entry.android as Record<string, unknown> | null;
      if (android === null || typeof android !== 'object') return true;
      const keys = Object.keys(android);
      if (keys.length !== 1) return true;
      const [key] = keys;
      if (key === 'search') return android['search'] !== true;
      return !(key === 'elsewhere' || key === 'na') || !String(android[key]).trim();
    });
    expect(missing.map((entry) => entry.id)).toEqual([]);
  });

  it('names only parity rows that exist in its free text', () => {
    // Each `| XX9 |` row of the parity matrix; an entry's `(…)` cites them (review nit).
    const rows = new Set(
      [...readFileSync(PARITY, 'utf8').matchAll(/^\| ([A-Z]{2}\d+) +\|/gm)].map((m) => m[1]),
    );
    const cited = stored!.commands.flatMap((entry) => {
      const android = entry.android as Record<string, unknown> | null;
      const free = android?.['elsewhere'] ?? android?.['na'];
      const words = typeof free === 'string' ? free : '';
      return [...words.matchAll(/\(([^)]*)\)/g)].flatMap((group) =>
        [...group[1]!.matchAll(/\b([A-Z]{2}\d+)\b/g)].map((m) => ({ id: entry.id, row: m[1]! })),
      );
    });
    expect(cited.length).toBeGreaterThan(10);
    expect(cited.filter((each) => !rows.has(each.row))).toEqual([]);
  });

  it('offers only commands that run anywhere as Search actions, never hidden ones', () => {
    const hidden = new Set(
      COMMANDS.filter((command) => command.hidden).map((command) => command.id),
    );
    const offered = stored!.commands.filter(
      (entry) => entry.android !== null && 'search' in entry.android,
    );
    expect(offered.length).toBeGreaterThan(10);
    expect(offered.filter((entry) => entry.scope !== 'global' || hidden.has(entry.id))).toEqual([]);
  });

  it('finds the plan’s examples: dark, week and folder', () => {
    const first = (query: string) => stored!.fuzzy.find((each) => each.query === query)?.ids[0];
    expect(first('dark')).toBe('theme.toggleDark');
    expect(first('week')).toBe('journal.thisWeek');
    expect(first('folder')).toBe('folder.new');
  });
});
