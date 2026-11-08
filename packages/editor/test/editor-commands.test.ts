import { getExtensionField, type AnyConfig } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';
import { EDITING_KEYS, EDITOR_COMMANDS } from '../src/commands';
import { BLOCK_ITEMS } from '../src/extensions/block-items';
import {
  ariaKeyShortcuts,
  bindable,
  bindingProblem,
  isAltGraph,
  comboFromEvent,
  comboFromKeymapName,
  formatCombo,
  normaliseCombo,
} from '../src/keys';
import { openEditor, select } from './support/editor';

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});

/** Every key name the editor's extensions bind (TipTap's addKeyboardShortcuts). */
function boundKeys(): Map<string, string> {
  const { editor } = openEditor();
  const keys = new Map<string, string>();
  for (const extension of editor.extensionManager.extensions) {
    const context = {
      name: extension.name,
      options: extension.options as unknown,
      storage: (editor.extensionStorage as unknown as Record<string, unknown>)[extension.name],
      editor,
      type: null,
    };
    const shortcuts = getExtensionField<AnyConfig['addKeyboardShortcuts']>(
      extension,
      'addKeyboardShortcuts',
      context,
    );
    for (const name of Object.keys(shortcuts?.call(context as never) ?? {})) {
      keys.set(comboFromKeymapName(name), extension.name);
    }
  }
  return keys;
}

describe('key combinations', () => {
  const event = (code: string, key: string, mods: Partial<Record<string, boolean>> = {}) => ({
    code,
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('reads Mod from Ctrl elsewhere and ⌘ on Apple devices', () => {
    expect(comboFromEvent(event('KeyK', 'k', { ctrlKey: true }), false)).toBe('Mod+K');
    expect(comboFromEvent(event('KeyK', 'k', { metaKey: true }), true)).toBe('Mod+K');
    // Control on a Mac is its own modifier (Ctrl-E moves to the line end there).
    expect(comboFromEvent(event('KeyE', 'e', { ctrlKey: true }), true)).toBe('Ctrl+E');
  });

  it('reads letters from the physical key, so ⌥ on macOS does not change them', () => {
    expect(comboFromEvent(event('KeyN', 'Dead', { metaKey: true, altKey: true }), true)).toBe(
      'Mod+Alt+N',
    );
    expect(comboFromEvent(event('ArrowUp', 'ArrowUp', { altKey: true }), false)).toBe('Alt+Up');
    expect(comboFromEvent(event('BracketLeft', '“', { altKey: true }), true)).toBe('Alt+[');
    expect(comboFromEvent(event('ShiftLeft', 'Shift', { shiftKey: true }), false)).toBeNull();
  });

  it('converts TipTap key names, treating an upper-case letter as Caps Lock', () => {
    expect(comboFromKeymapName('Mod-Shift-e')).toBe('Mod+Shift+E');
    expect(comboFromKeymapName('Mod-B')).toBe('Mod+B');
    expect(comboFromKeymapName('Alt-Shift-ArrowUp')).toBe('Alt+Shift+Up');
    expect(comboFromKeymapName('Shift-Enter')).toBe('Shift+Enter');
  });

  it('formats for each platform', () => {
    expect(formatCombo('Mod+Shift+E', true)).toBe('⌘⇧E');
    expect(formatCombo('Mod+Shift+E', false)).toBe('Ctrl+Shift+E');
    expect(ariaKeyShortcuts(['Mod+K', 'Alt+Up'], false)).toBe('Control+K Alt+ArrowUp');
    expect(normaliseCombo('shift+mod+e')).toBe('Mod+Shift+E');
  });

  it('only binds combinations that cannot be typed', () => {
    for (const apple of [true, false]) {
      expect(bindable('Mod+E', apple)).toBe(true);
      expect(bindable('F2', apple)).toBe(true);
      expect(bindable('Alt+Up', apple)).toBe(true);
      expect(bindable('Mod+Alt+Up', apple)).toBe(true);
      expect(bindable('Shift+E', apple)).toBe(false);
      expect(bindable('E', apple)).toBe(false);
      expect(bindable('Shift+1', apple)).toBe(false);
      expect(bindable('Space', apple)).toBe(false);
      expect(bindable('Shift+/', apple)).toBe(false);
      expect(bindable('Delete', apple)).toBe(false);
    }
    // ⌥ with a printable key types on a Mac (⌥E is a dead key, ⌥/ is ÷).
    expect(bindable('Alt+E', true)).toBe(false);
    expect(bindable('Alt+/', true)).toBe(false);
    expect(bindable('Mod+Alt+N', true)).toBe(true);
    // Ctrl+Alt is AltGr on Windows: Polish ń is AltGr+N, German } is AltGr+0.
    expect(bindingProblem('Mod+Alt+N', false)).toBe('altgr');
    expect(bindingProblem('Mod+Alt+0', false)).toBe('altgr');
    expect(bindingProblem('Mod+Alt+Shift+N', false)).toBe('altgr');
    expect(bindable('Alt+N', false)).toBe(true);
  });

  it('keeps clipboard and editing keys for themselves', () => {
    for (const apple of [true, false]) {
      for (const combo of ['C', 'V', 'X', 'A', 'Z', 'Shift+Z', 'Y', 'F', 'R']) {
        expect(bindingProblem(`Mod+${combo}`, apple)).toBe('reserved');
        expect(bindingProblem(`mod+${combo.toLowerCase()}`, apple)).toBe('reserved');
      }
    }
    // A Mac's Control-key text editing (Cocoa): line start and end, kill, delete, …
    for (const letter of 'AEKDHNPBF')
      expect(bindingProblem(`Ctrl+${letter}`, true)).toBe('reserved');
    expect(bindable('Ctrl+G', true)).toBe(true);
  });

  it('read AltGr as typing, never as a shortcut', () => {
    const altGr = { getModifierState: (key: string) => key === 'AltGraph' };
    expect(isAltGraph(altGr)).toBe(true);
    expect(isAltGraph({ getModifierState: () => false })).toBe(false);
  });
});

/** The editor's commands as a platform loads them (their default keys depend on it). */
async function commandsOn(platform: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { ...navigator, platform, userAgent: platform });
  try {
    const commands = await import('../src/commands');
    const keys = await import('../src/keys');
    return { commands: commands.EDITOR_COMMANDS, keys };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('editor commands (T20)', () => {
  it('have defaults that can be bound on each platform: none is AltGr on Windows (A90)', async () => {
    for (const [platform, apple] of [
      ['MacIntel', true],
      ['Win32', false],
      ['Linux x86_64', false],
    ] as const) {
      const { commands, keys } = await commandsOn(platform);
      const bad = commands.flatMap((command) =>
        command.keys
          .filter((combo) => keys.bindingProblem(combo, apple) !== null)
          // Undo and Redo keep the keys reserved for them.
          .filter((combo) => !(keys.RESERVED_COMBOS.has(combo) && /undo|redo/.test(command.id)))
          .map((combo) => `${platform}: ${command.id} ${combo}`),
      );
      expect(bad).toEqual([]);
      const heading = commands.find((command) => command.id === 'editor.heading1')!;
      expect(heading.keys).toEqual([apple ? 'Mod+Alt+1' : 'Mod+Shift+1']);
      const text = commands.find((command) => command.id === 'editor.paragraph')!;
      expect(text.keys).toEqual([apple ? 'Mod+Alt+0' : 'Mod+Shift+0']);
      const code = commands.find((command) => command.id === 'editor.codeBlock')!;
      expect(code.keys).toEqual([apple ? 'Mod+Alt+C' : 'Alt+C']);
      // Line symbols (T44, A744): ⌃1–9 and ⌃0 on a Mac, Alt+Shift+1–9 and Alt+Shift+0 elsewhere.
      for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const symbol = commands.find((command) => command.id === `editor.symbol${slot}`)!;
        expect(symbol.keys).toEqual([apple ? `Ctrl+${slot}` : `Alt+Shift+${slot}`]);
      }
      const picker = commands.find((command) => command.id === 'editor.symbolPicker')!;
      expect(picker.keys).toEqual([apple ? 'Ctrl+0' : 'Alt+Shift+0']);
      // No two editor commands share a default on any platform.
      const combos = commands.flatMap((command) => command.keys);
      expect(combos.filter((combo, index) => combos.indexOf(combo) !== index)).toEqual([]);
    }
  });

  it('cover every modified key the editor binds', () => {
    const defaults = new Set(EDITOR_COMMANDS.flatMap((command) => command.keys));
    const missing = [...boundKeys()]
      .filter(([combo]) => !EDITING_KEYS.has(combo) && !defaults.has(combo))
      .map(([combo, extension]) => `${combo} (${extension})`);
    expect(missing).toEqual([]);
  });

  it('never bind Mod+E, which belongs to the recent-notes switcher (A42)', () => {
    expect(boundKeys().has('Mod+E')).toBe(false);
    expect(EDITOR_COMMANDS.some((command) => command.keys.includes('Mod+E'))).toBe(false);
  });

  it('have unique ids, and one insert command per slash-menu block', () => {
    const ids = EDITOR_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of BLOCK_ITEMS) expect(ids).toContain(`editor.insert.${item.id}`);
  });

  it('name a command (or say what they are) on every toolbar control', () => {
    const { editor } = openEditor([paragraph('Some words')]);
    const storage = editor.storage as unknown as {
      selectionToolbar: { toolbar: { element: HTMLElement } };
    };
    const ids = new Set(EDITOR_COMMANDS.map((command) => command.id));
    const controls = [...storage.selectionToolbar.toolbar.element.querySelectorAll('button')];
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) {
      const command = control.dataset['command'];
      if (command) expect(ids).toContain(command);
      else expect(['menu', 'option', 'submit']).toContain(control.dataset['ui']);
    }
  });

  it('run formatting on the selection', () => {
    const { editor } = openEditor([paragraph('Some words')]);
    select(editor.view, 1, 5);
    const bold = EDITOR_COMMANDS.find((command) => command.id === 'editor.bold')!;
    expect(bold.run({ editor })).toBe(true);
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
  });

  it('leave Mod+K to the palette when no text is selected (A42)', () => {
    const { editor } = openEditor([paragraph('Some words')]);
    select(editor.view, 2);
    const link = EDITOR_COMMANDS.find((command) => command.id === 'editor.link')!;
    expect(link.yields).toBe(true);
    expect(link.run({ editor })).toBe(false);
    select(editor.view, 1, 5);
    expect(link.run({ editor })).toBe(true);
  });

  it('insert blocks at the caret', () => {
    const { editor } = openEditor([paragraph('')]);
    select(editor.view, 1);
    const table = EDITOR_COMMANDS.find((command) => command.id === 'editor.insert.table')!;
    expect(table.run({ editor })).toBe(true);
    expect(editor.getJSON().content?.some((node) => node.type === 'table')).toBe(true);
    const image = EDITOR_COMMANDS.find((command) => command.id === 'editor.insert.image')!;
    expect(image.run({ editor })).toBe(false); // No image storage here.
  });
});
