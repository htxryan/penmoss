// @vitest-environment happy-dom
import { DEFAULT_SYMBOLS } from '@penmoss/core/line-symbols';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { NoteSettings } from '../../src/notes/NoteSettings';
import type { Notes } from '../../src/notes/service';
import { SymbolsSettings } from '../../src/notes/SymbolsSettings';
import { AppearanceSettings } from '../../src/theme/AppearanceSettings';
import { ThemeController } from '../../src/theme/controller';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { SidebarSettings } from '../../src/shell/SidebarSettings';
import { SourcesProvider } from '../../src/sources/context';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';
import { standInSources } from './support/one-source';

// PEN-146: Settings → Sidebar and Note (split from Display) and Symbols. Each row is findable
// by Search Settings (`data-setting`), sections and symbols reorder by Alt+↑ and Alt+↓ as well
// as by drag, and the previews follow the switches.

let root: Root | null = null;
let host: HTMLDivElement;
let settings: Record<string, unknown>;
let writes: Array<[string, unknown]>;
let state: { loaded: boolean };
const listeners = new Set<() => void>();

const notify = () => {
  state = { ...state };
  for (const listener of listeners) listener();
};

const workspace = {
  settings: () => ({ ...settings }),
  setSetting: (key: string, value: unknown) => {
    writes.push([key, value]);
    if (value === undefined) delete settings[key];
    else settings[key] = value;
    notify();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,
} as unknown as Workspace;

const { sources } = standInSources({ notes: {} as Notes, workspace });
const center = new CommandCenter(COMMANDS, memoryBindings());

function render(children: React.ReactNode) {
  act(() =>
    root!.render(
      <CommandsContext.Provider value={center}>
        <SourcesProvider sources={sources}>
          <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
        </SourcesProvider>
      </CommandsContext.Provider>,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  settings = {};
  writes = [];
  state = { loaded: true };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
const byTest = <T extends Element = HTMLElement>(id: string) => $<T>(`[data-testid="${id}"]`);
const ids = () =>
  [...host.querySelectorAll('[data-setting]')].map((row) => row.getAttribute('data-setting'));
const click = (element: Element) =>
  act(() => {
    (element as HTMLElement).click();
  });
const altKey = (element: Element, key: 'ArrowUp' | 'ArrowDown') =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true }));
  });

describe('Settings → Sidebar (PEN-146)', () => {
  it('has a row for every shortcut and section, Search always shown', () => {
    render(<SidebarSettings />);
    expect(ids()).toEqual([
      'search',
      'tags',
      'today',
      'this-week',
      'graph',
      'commands',
      'quick-access',
      'show-notebook-names',
      'recent-notes',
      'notebooks',
      'calendar',
      'tags-section',
    ]);
    const search = $<HTMLInputElement>('input[aria-label="Search"]');
    expect(search.checked).toBe(true);
    expect(search.disabled).toBe(true);
    expect(host.textContent).toContain(
      'A hidden shortcut still works from its keys and the command palette.',
    );
  });

  it('steps Recent Notes within 1 to 50', () => {
    settings['sidebar.recentCount'] = 49;
    render(<SidebarSettings />);
    expect(byTest('recent-count').textContent).toBe('49');
    click(byTest('recent-count-more'));
    expect(writes.at(-1)).toEqual(['sidebar.recentCount', 50]);
    expect(byTest<HTMLButtonElement>('recent-count-more').disabled).toBe(true);
    settings['sidebar.recentCount'] = 1;
    act(() => notify());
    expect(byTest<HTMLButtonElement>('recent-count-fewer').disabled).toBe(true);
    click(byTest('recent-count-more'));
    expect(writes.at(-1)).toEqual(['sidebar.recentCount', 2]);
  });

  it('moves a section with Alt+↓ and Alt+↑, and says where it went', () => {
    render(<SidebarSettings />);
    const order = () =>
      [...host.querySelectorAll('[data-testid="section-settings"] > li')].map((row) =>
        row.getAttribute('data-reorder-id'),
      );
    expect(order()).toEqual(['quickAccess', 'recent', 'notebooks', 'calendar', 'tags']);
    // From the section's switch, not only its handle.
    altKey(byTest('display-section-recent'), 'ArrowDown');
    expect(writes.at(-1)).toEqual([
      'sidebar.sectionOrder',
      ['quickAccess', 'notebooks', 'recent', 'calendar', 'tags'],
    ]);
    expect(order()).toEqual(['quickAccess', 'notebooks', 'recent', 'calendar', 'tags']);
    expect(byTest('section-move-said').textContent).toBe('Recent Notes moved to 3 of 5.');
    altKey(byTest('display-section-move-quickAccess'), 'ArrowUp');
    // Already first: nothing to move.
    expect(writes).toHaveLength(1);
  });

  it('draws a sidebar that hides and moves with the switches', () => {
    render(<SidebarSettings />);
    const preview = () =>
      [...byTest('sidebar-preview').querySelectorAll('[data-section]')].map((part) =>
        part.getAttribute('data-section'),
      );
    expect(preview()).toEqual(['quickAccess', 'recent', 'notebooks', 'calendar', 'tags']);
    click(byTest('display-section-recent'));
    expect(writes.at(-1)![0]).toBe('sidebar.hiddenSections');
    expect(preview()).toEqual(['quickAccess', 'notebooks', 'calendar', 'tags']);
    const icons = () => byTest('sidebar-preview-shortcuts').querySelectorAll('svg').length;
    const before = icons();
    click(byTest('display-graph'));
    expect(writes.at(-1)).toEqual(['sidebar.graph', false]);
    expect(icons()).toBe(before - 1);
  });
});

describe('Settings → Note (PEN-146)', () => {
  it('has Layout, Title Bar Buttons and the two sets of details, each findable', () => {
    render(<NoteSettings />);
    for (const id of [
      'note-width',
      'note-panel',
      'title-bar-buttons',
      'full-width',
      'move-to-trash',
      'under-the-title',
      'in-the-status-bar',
    ]) {
      expect(ids(), id).toContain(id);
    }
    expect(host.querySelectorAll('[data-testid^="display-note-bar-"]')).toHaveLength(9);
    // Note Panel is this device's own.
    expect(byTest('note-panel-setting').querySelector('.lf-scope')!.textContent).toBe(
      'This Device',
    );
    // The status bar never offers Tags.
    expect(host.querySelector('[data-testid="metadata-status-tags"]')).toBeNull();
  });

  it('turns a detail on as a chip, and the preview shows it', () => {
    render(<NoteSettings />);
    expect(host.querySelector('[data-testid="note-preview-under-title"]')).toBeNull();
    click(byTest('metadata-title-edited'));
    expect(writes.at(-1)).toEqual(['metadata.underTitle', ['edited']]);
    expect(byTest('note-preview-under-title').textContent).toBe('Edited 4:02 PM');
    expect(byTest('note-preview-status-bar').textContent).toBe(
      'Saved · 412 words · 2,190 characters · 2 min',
    );
  });

  it('shows the title bar’s buttons that are on, and ⋯', () => {
    render(<NoteSettings />);
    const buttons = () =>
      [...byTest('note-preview').querySelectorAll('[data-button]')].map((button) =>
        button.getAttribute('data-button'),
      );
    expect(buttons()).toEqual(['fullWidth', 'copyAgentReference']);
    click(byTest('display-note-bar-delete'));
    expect(writes.at(-1)).toEqual(['noteBar.delete', true]);
    expect(buttons()).toEqual(['fullWidth', 'copyAgentReference', 'delete']);
  });
});

describe('Settings → Symbols (PEN-146, Show the Keys)', () => {
  it('shows each row’s keys, the count against the limit and a quiet Restore Defaults', () => {
    render(<SymbolsSettings />);
    expect(host.querySelectorAll('[data-testid="symbol-row"]')).toHaveLength(
      DEFAULT_SYMBOLS.length,
    );
    expect(byTest('symbol-keys-1').textContent).toMatch(/⌃1|Ctrl\+1|Alt\+Shift\+1/);
    expect(byTest('symbols-count').textContent).toBe(`${DEFAULT_SYMBOLS.length} of 9`);
    // No Move Up or Move Down: a handle instead.
    expect(host.querySelector('[aria-label$=" Up"]')).toBeNull();
    expect(byTest('symbol-move-1').getAttribute('aria-keyshortcuts')).toBe(
      'Alt+ArrowUp Alt+ArrowDown',
    );
    const restore = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Restore Defaults',
    )!;
    expect(restore.className).toBe('btn quiet');
    expect(restore.disabled).toBe(true);
    expect(ids()).toEqual([
      'symbols',
      'add-a-symbol',
      'change-their-shortcuts',
      'restore-defaults',
    ]);
  });

  it('moves a symbol with Alt+↓ and says its new place and key', () => {
    render(<SymbolsSettings />);
    const first = DEFAULT_SYMBOLS[0]!.glyph;
    const second = DEFAULT_SYMBOLS[1]!.glyph;
    altKey(byTest('symbol-glyph-1'), 'ArrowDown');
    const stored = settings['symbols.list'] as Array<{ glyph: string }>;
    expect(stored.slice(0, 2).map((symbol) => symbol.glyph)).toEqual([second, first]);
    expect(byTest('symbols-notice').textContent).toMatch(
      new RegExp(`^${first} is now symbol 2, .+2\\.$`),
    );
    expect(byTest('symbols-count').textContent).toBe(`${DEFAULT_SYMBOLS.length} of 9`);
  });
});

describe('Settings → Appearance (PEN-146, Live Preview Studio)', () => {
  const themed = () => {
    const controller = new ThemeController({
      root: {
        style: { colorScheme: '', setProperty: () => undefined },
        setAttribute: () => undefined,
      },
      storage: null,
      systemDark: { matches: false, subscribe: () => () => undefined },
    });
    render(
      <ThemeProvider controller={controller}>
        <AppearanceSettings />
      </ThemeProvider>,
    );
  };

  it('previews a note size as it is dragged', () => {
    themed();
    const range = byTest<HTMLInputElement>('note-size');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '22');
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(byTest('app-preview').style.getPropertyValue('--pm-note-size')).toBe('22px');
  });

  it('customizes a built-in as a copy, in the editor beside the same preview, and goes back', () => {
    themed();
    expect(host.querySelector('[data-testid="theme-editor"]')).toBeNull();
    click(byTest('theme-customize'));
    expect(String(settings['theme.id'])).not.toBe('penmoss');
    expect(settings['theme.id']).toBeTruthy();
    expect(byTest('custom-theme-editor')).not.toBeNull();
    expect(byTest('theme-preview').className).toBe('theme-preview');
    expect(host.querySelector('[data-testid="theme-grid"]')).toBeNull();
    click(byTest('theme-editor-done'));
    expect(host.querySelector('[data-testid="theme-editor"]')).toBeNull();
    expect(byTest('theme-customize').textContent).toBe('Customize Penmoss copy…');
  });
});
