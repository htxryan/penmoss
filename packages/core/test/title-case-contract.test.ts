/**
 * Title Case on Android (PEN-137, T12): `apps/android/contract/title-case-v1.json` holds texts and
 * what core's `titleCase()` makes of each, and the short words. Android's `TitleCase.kt` replays
 * every case (`TitleCaseTest`), so the phone's Settings and dialog checks follow the same rule as
 * the Mac's.
 *
 * After changing the rule or the cases, write the contract again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/core exec vitest run test/title-case-contract`,
 * then `pnpm exec prettier --write apps/android/contract/title-case-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHORT_WORDS, titleCase } from '../src/title-case';

const FILE = fileURLToPath(
  new URL('../../../apps/android/contract/title-case-v1.json', import.meta.url),
);

/** The texts replayed: core's examples, the sweep's old texts, Android's own labels and the edges. */
const TEXTS = [
  // Already right (title-case.test.ts's examples).
  'Move to Folder',
  'Search by Meaning',
  'Show in the Sidebar',
  'Keep at Most',
  'Attach Logs from the Last',
  'Sign In with GitHub',
  'Claude Code: Run in a Terminal',
  'Run the CLI As',
  'Raised (Menus, Cards, Dialogs)',
  'Note, Info, To-Do',
  'System Sans-Serif',
  'Delete “X” for Good?',
  'Send To…',
  'penmoss Command Installed',
  'Codex: Add to ~/.codex/config.toml',
  'Share How You Use Penmoss?',
  'Delete Your Shared Data?',
  'Reset My Analytics ID',
  'Waiting for Your Answer',
  'Delete {count} Events?',
  'Don’t Share',
  'Shortcut from Any App',
  'Nothing Waits to Be Pushed',
  'Signed In with GitHub',
  'Use the Compact Title Bar?',
  // The sweep's old texts.
  'Move to folder',
  'Raised (menus, cards, dialogs)',
  'Note, info, to-do',
  'System sans-serif',
  'Delete “X” for good?',
  'Send to…',
  'penmoss command installed',
  'Codex: add to ~/.codex/config.toml',
  'Claude Code: run in a terminal',
  'Run the CLI as',
  'Signed in with GitHub',
  'Shortcut From Any App',
  'Pictures From the Web',
  'Discard this draft?',
  'the end of the line',
  'Not synced yet',
  'Hue and saturation',
  'Turn off sharing',
  'Log in to GitHub',
  'Back up on the phone',
  // Android's labels (T12 inventory).
  'Load Pictures From the Web',
  'Clear Pictures From the Web?',
  'Waiting to upload',
  'Pictures failed',
  'Not synced',
  'Not signed in',
  'Sync stopped.',
  'Notes not brought back',
  'Delete for good, waiting',
  'Commits From This Phone',
  'Change the shortcut for Search',
  'Every shortcut on Home',
  'This theme’s colours',
  'Captures not added',
  'Primary · Synced 3 min ago',
  'Wi-Fi only',
  // The edges: spacing, a colon, a dash, words written their own way.
  '  move   to folder ',
  '',
  'Agents: the list',
  'Logs — of today',
  'Open in macOS',
  'Use npm and pnpm',
  'Press ⌘K',
  'Set {device} Name',
  'connect with MCP',
  'edit config.toml',
  'Move To folder',
  ...[...SHORT_WORDS].map((word) => `${word} x ${word} y ${word}`),
];

function contract() {
  return {
    $comment:
      'Title Case as core writes it (PEN-137, A938 as amended): each case is a text and what packages/core/src/title-case.ts titleCase() makes of it. Written and checked by packages/core/test/title-case-contract.test.ts; Android’s TitleCase.kt replays every case (TitleCaseTest).',
    version: 1,
    shortWords: [...SHORT_WORDS],
    cases: TEXTS.map((text) => [text, titleCase(text)]),
  };
}

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') writeFileSync(FILE, text(contract()));

describe('title-case-v1.json', () => {
  it('holds what titleCase() makes of each text', () => {
    const stored = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    expect(stored).toEqual(contract());
  });
});
