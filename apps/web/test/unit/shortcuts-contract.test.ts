/// <reference types="node" />
/**
 * The keyboard-shortcuts contract (T40 P9, A490, A492): `apps/android/contract/shortcuts-v1.json`
 * is the web's command registry as a keyboard off Apple platforms sees it (Mod is Ctrl; the
 * unit tests pin that platform, `support/platform.ts`), with the A90 rules as cases. The
 * Android editor page dispatches its keys from it, and the Kotlin tests check the native
 * dispatcher, the recorder's normaliser, the conflict rules and Settings → Keyboard shortcuts
 * against it, so the phone cannot drift from the web. A command added here and not given an
 * Android entry fails the Kotlin coverage test (`AndroidCommandsTest`).
 *
 * After changing a command, its keys or the rules, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/web test shortcuts-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bindingProblem,
  bindingValueProblem,
  comboFromEvent,
  formatCombo,
  MAX_COMBO_CHARS,
  MAX_COMBOS_PER_COMMAND,
  RESERVED_COMBOS,
  usableBindings,
} from '@penmoss/editor/keys';
import { describe, expect, it } from 'vitest';
import contract from '../../../android/contract/shortcuts-v1.json';
import { COMMANDS } from '../../src/commands/definitions';

/** Key events as a hardware keyboard on Android reports them to the page (`code`, `key`). */
const EVENTS = [
  { key: 'k', code: 'KeyK', ctrl: true, alt: false, shift: false, meta: false },
  { key: 'K', code: 'KeyK', ctrl: true, alt: false, shift: true, meta: false },
  { key: 'n', code: 'KeyN', ctrl: false, alt: true, shift: false, meta: false },
  { key: 'N', code: 'KeyN', ctrl: false, alt: true, shift: true, meta: false },
  { key: '/', code: 'Slash', ctrl: true, alt: false, shift: false, meta: false },
  { key: ',', code: 'Comma', ctrl: true, alt: false, shift: false, meta: false },
  { key: '\\', code: 'Backslash', ctrl: true, alt: false, shift: false, meta: false },
  { key: 'ArrowUp', code: 'ArrowUp', ctrl: false, alt: true, shift: false, meta: false },
  { key: 'ArrowDown', code: 'ArrowDown', ctrl: false, alt: true, shift: true, meta: false },
  { key: 'F2', code: 'F2', ctrl: false, alt: false, shift: false, meta: false },
  { key: 'F10', code: 'F10', ctrl: false, alt: true, shift: false, meta: false },
  { key: ')', code: 'Digit0', ctrl: true, alt: false, shift: true, meta: false },
  { key: '1', code: 'Digit1', ctrl: true, alt: false, shift: true, meta: false },
  { key: '*', code: 'Digit8', ctrl: true, alt: false, shift: true, meta: false },
  // A line symbol's key (T44, A744): Alt+Shift+1, whatever the layout types for Shift+1.
  { key: '!', code: 'Digit1', ctrl: false, alt: true, shift: true, meta: false },
  { key: 'Delete', code: 'Delete', ctrl: false, alt: false, shift: false, meta: false },
  { key: 'Enter', code: 'Enter', ctrl: true, alt: false, shift: false, meta: false },
  { key: ' ', code: 'Space', ctrl: true, alt: false, shift: false, meta: false },
  { key: 'k', code: 'KeyK', ctrl: false, alt: false, shift: false, meta: true },
  { key: 'Control', code: 'ControlLeft', ctrl: true, alt: false, shift: false, meta: false },
] as const;

const PROBLEMS = [
  'Mod+K',
  'Mod+Shift+K',
  'Alt+N',
  'Alt+Shift+N',
  'Mod+Alt+N',
  'Mod+Alt+Shift+N',
  'Mod+Alt+Up',
  'Shift+K',
  'K',
  'F2',
  'Shift+F5',
  'Delete',
  'Mod+C',
  'Mod+V',
  'Mod+Shift+Z',
  'Mod+F',
  'Ctrl+A',
  'Mod+/',
  'Alt+Up',
];

const FORMATS = [
  'Mod+Shift+E',
  'Alt+Shift+H',
  'Mod+/',
  'Alt+Up',
  'Mod+,',
  'F2',
  'Escape',
  'Mod+\\',
];

const STORED = {
  valid: [[], ['Mod+Shift+E'], ['Alt+Up', 'F2'], ['Mod+Alt+N'], ['Mod++']],
  invalid: [
    'Mod+K',
    ['mod+k'],
    ['Shift+Mod+K'],
    ['Meta+K'],
    ['Mod+K', 'Mod+K'],
    ['Mod+A', 'Mod+B', 'Mod+D', 'Mod+E', 'Mod+G'],
    [42],
    [''],
  ],
};

const USABLE: ReadonlyArray<Record<string, unknown>> = [
  { 'note.new': ['alt+shift+n', 'Mod+Alt+N'] },
  { 'editor.undo': ['Mod+Z', 'Mod+U'] },
  { 'app.search': ['Mod+C'] },
  { 'app.palette': [] },
  { 'app.recent': 'Mod+E' },
  { 'app.graph': ['Shift+G', 'Mod+Shift+G'] },
];

const DEFAULTS = new Map(COMMANDS.map((command) => [command.id, command.keys]));

function shortcutsContract() {
  return {
    version: 1,
    platform: 'other',
    limits: { combosPerCommand: MAX_COMBOS_PER_COMMAND, comboChars: MAX_COMBO_CHARS },
    commands: COMMANDS.map((command) => ({
      id: command.id,
      title: command.title,
      area: command.area,
      scope: command.scope,
      keys: [...command.keys],
      ...(command.yields ? { yields: true } : {}),
      ...(command.hidden ? { hidden: true } : {}),
      ...(command.pending ? { pending: command.pending } : {}),
    })),
    reserved: [...RESERVED_COMBOS],
    events: EVENTS.map((event) => ({
      ...event,
      combo: comboFromEvent(
        {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrl,
          altKey: event.alt,
          shiftKey: event.shift,
          metaKey: event.meta,
        },
        false,
      ),
    })),
    problems: PROBLEMS.map((combo) => ({ combo, problem: bindingProblem(combo, false) })),
    format: FORMATS.map((combo) => ({ combo, text: formatCombo(combo, false) })),
    stored: {
      valid: STORED.valid.filter((value) => bindingValueProblem(value) === null),
      invalid: STORED.invalid.filter((value) => bindingValueProblem(value) !== null),
    },
    usable: USABLE.map((raw) => ({
      raw,
      usable: usableBindings(raw, (id) => DEFAULTS.get(id), false),
    })),
  };
}

describe('shortcuts contract v1', () => {
  it('is the registry and the binding rules off Apple platforms, exactly', () => {
    const expected = shortcutsContract();
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      // Run from the package, as `pnpm --filter` does.
      const file = resolve(process.cwd(), '../android/contract/shortcuts-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });

  it('keeps every stored case on its side of the rule', () => {
    const expected = shortcutsContract();
    expect(expected.stored.valid).toHaveLength(STORED.valid.length);
    expect(expected.stored.invalid).toHaveLength(STORED.invalid.length);
  });
});
