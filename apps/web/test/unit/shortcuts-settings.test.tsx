// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandCenter, memoryBindings, type BindingStore } from '../../src/commands/center';
import type { CommandDefinition } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { searchesByKeys } from '../../src/commands/recorder';
import { ShortcutsSettings } from '../../src/commands/ShortcutsSettings';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';

// PEN-146 (option B): Settings → Keyboard Shortcuts groups the commands by area, filters to
// All, Changed (with a count) or None Set, searches by name or by the keys pressed in the
// search field, says what a changed shortcut replaced, and resets them all after asking.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const global = (
  id: string,
  title: string,
  area: CommandDefinition['area'],
  keys: string[] = [],
): CommandDefinition => ({ id, title, area, keys, scope: 'global' });

const DEFINITIONS: CommandDefinition[] = [
  global('app.palette', 'Command Palette', 'General', ['Mod+K']),
  global('nav.recent', 'Switch to a Recent Note', 'Navigation', ['Mod+E']),
  global('note.new', 'New Note', 'Note', ['Mod+Alt+N']),
  global('note.move', 'Move to Folder…', 'Note'),
  global('journal.today', 'Today’s Note', 'Daily notes', ['Mod+D']),
];

const workspace = {
  getState: () => ({ loaded: true }),
  subscribe: () => () => undefined,
} as unknown as Workspace;

let root: Root | null = null;
let host: HTMLDivElement;
let store: BindingStore;
let commands: CommandCenter;

function render() {
  act(() =>
    root!.render(
      <WorkspaceContext.Provider value={workspace}>
        <CommandsContext.Provider value={commands}>
          <ShortcutsSettings />
        </CommandsContext.Provider>
      </WorkspaceContext.Provider>,
    ),
  );
}

beforeEach(() => {
  store = memoryBindings();
  commands = new CommandCenter(DEFINITIONS, store);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  commands.dispose();
});

const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
const shownRows = () =>
  [...host.querySelectorAll<HTMLElement>('[data-command-row]')].map(
    (row) => row.dataset.commandRow,
  );
const filterTo = (value: string) =>
  act(() => $<HTMLInputElement>(`[data-testid="shortcut-filter"] input[value="${value}"]`).click());
const press = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });

describe('Settings → Keyboard Shortcuts', () => {
  it('groups the commands by area, under Title Case subheads, without the capture hotkey', () => {
    render();
    expect([...host.querySelectorAll('.lf-sub')].map((sub) => sub.textContent)).toEqual([
      'General',
      'Navigation',
      'Daily Notes',
      'Note',
    ]);
    expect($('[data-area="Note"]').querySelectorAll('[data-command-row]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="capture-hotkey"]')).toBeNull();
    expect($('[data-command-row="note.new"]').dataset.setting).toBe('new-note');
    expect(host.querySelector('[data-setting="keyboard-shortcuts"]')).not.toBeNull();
  });

  it('offers Add Shortcut for a command with none, and says it has none', () => {
    render();
    const row = $('[data-command-row="note.move"]');
    expect(row.textContent).toContain('No shortcut');
    expect(row.querySelector('[data-testid="keys-note.move"] button')?.textContent).toBe(
      'Add Shortcut',
    );
  });

  it('records keys, then says what a changed shortcut replaced and resets it', () => {
    render();
    act(() =>
      $<HTMLButtonElement>('button[aria-label^="Change the Shortcut for New Note"]').click(),
    );
    press({ key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true });
    expect(store.read()['note.new']).toEqual(['Mod+Shift+L']);
    const row = $('[data-command-row="note.new"]');
    expect(row.className).toContain('changed');
    expect(row.textContent).toContain('Changed from Ctrl+Alt+N');
    act(() => $<HTMLButtonElement>('button[aria-label="Reset the Shortcut for New Note"]').click());
    expect(store.read()['note.new']).toBeUndefined();
    expect($('[data-command-row="note.new"]').textContent).not.toContain('Changed from');
  });

  it('filters to the changed ones, with their count, and to the ones with none set', () => {
    store.write('nav.recent', ['Mod+Shift+E']);
    store.write('app.palette', []);
    render();
    const changed = $('[data-testid="shortcut-filter"]').textContent;
    expect(changed).toContain('Changed · 2');
    filterTo('changed');
    expect(shownRows()).toEqual(['app.palette', 'nav.recent']);
    filterTo('none');
    expect(shownRows()).toEqual(['app.palette', 'note.move']);
    filterTo('all');
    expect(shownRows()).toHaveLength(DEFINITIONS.length);
  });

  it('finds the command a combination pressed in the search field belongs to', () => {
    render();
    const search = $<HTMLInputElement>('input[type="search"]');
    act(() => search.focus());
    // Typing still types: a plain letter is not a search by keys.
    press({ key: 'n', code: 'KeyN' });
    expect(host.querySelector('[data-testid="shortcut-key-filter"]')).toBeNull();
    press({ key: 'e', code: 'KeyE', ctrlKey: true });
    expect($('[data-testid="shortcut-key-filter"]').textContent).toContain('E');
    expect(shownRows()).toEqual(['nav.recent']);
    expect($('.kb-found').textContent).toBe('One command uses Ctrl+E.');
    // Escape clears the keys.
    act(() => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-testid="shortcut-key-filter"]')).toBeNull();
    expect(shownRows()).toHaveLength(DEFINITIONS.length);
    press({ key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true });
    expect($('.kb-found').textContent).toBe('No command uses Ctrl+Shift+J.');
  });

  it('asks before resetting every changed shortcut', () => {
    store.write('nav.recent', ['Mod+Shift+E']);
    store.write('note.new', ['Mod+Shift+L']);
    render();
    const resetAll = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reset All Changed…',
    )!;
    act(() => resetAll.click());
    const dialog = document.querySelector('[data-testid="shortcuts-reset-all"]')!;
    expect(dialog.textContent).toContain('Reset 2 Shortcuts?');
    expect(store.read()['nav.recent']).toEqual(['Mod+Shift+E']);
    act(() => dialog.querySelector<HTMLFormElement>('form')!.requestSubmit());
    expect(store.read()).toEqual({});
    expect(resetAll.disabled).toBe(true);
  });
});

describe('searching by keys', () => {
  it('takes a combination a command could have, and leaves typing and editing to the field', () => {
    expect(searchesByKeys('Mod+E', false)).toBe(true);
    expect(searchesByKeys('F2', false)).toBe(true);
    expect(searchesByKeys('N', false)).toBe(false);
    expect(searchesByKeys('Shift+N', false)).toBe(false);
    expect(searchesByKeys('Mod+V', false)).toBe(false);
    expect(searchesByKeys('Mod+A', false)).toBe(false);
    expect(searchesByKeys('Alt+Left', false)).toBe(false);
    expect(searchesByKeys('Mod+Backspace', false)).toBe(false);
  });
});
