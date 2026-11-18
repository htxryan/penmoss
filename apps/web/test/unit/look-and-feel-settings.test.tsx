// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SYMBOLS } from '@penmoss/core/line-symbols';
import { DEVICE_MAP, readSettings, setSetting } from '@penmoss/model/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { NoteSettings } from '../../src/notes/NoteSettings';
import { SymbolsSettings } from '../../src/notes/SymbolsSettings';
import { AppearanceSettings } from '../../src/theme/AppearanceSettings';
import { ThemeController } from '../../src/theme/controller';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { SidebarSettings } from '../../src/shell/SidebarSettings';
import { SourcesProvider } from '../../src/sources/context';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';
import { oneSource, type OneSource } from './support/one-source';

// PEN-146: Settings → Sidebar and Note (split from Display) and Symbols. Each row is findable
// by Search Settings (`data-setting`), sections and symbols reorder by Alt+↑ and Alt+↓ as well
// as by drag, and the previews follow the switches.

let root: Root | null = null;
let host: HTMLDivElement;
let writes: Array<[string, unknown]>;

// A real notebook (its notes in memory), as the previews draw the app's own sidebar and note
// (A1564). Its workspace holds the settings; each write is recorded.
let one: OneSource;
let workspace: Workspace;
/** The settings now. */
const settings = () => workspace.settings();
/** A setting set as another device would, before or while the page shows. */
const preset = (key: string, value: unknown) =>
  act(() => {
    workspace.setSetting(key, value);
    writes.pop();
  });

const center = new CommandCenter(COMMANDS, memoryBindings());

function render(children: React.ReactNode) {
  act(() =>
    root!.render(
      <CommandsContext.Provider value={center}>
        <SourcesProvider sources={one.sources}>
          <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
        </SourcesProvider>
      </CommandsContext.Provider>,
    ),
  );
}

beforeEach(async () => {
  one = await oneSource();
  workspace = one.source.workspace;
  const set = workspace.setSetting.bind(workspace);
  workspace.setSetting = (key: string, value: unknown) => {
    writes.push([key, value]);
    set(key, value);
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writes = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  one.stop();
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
    preset('sidebar.recentCount', 49);
    render(<SidebarSettings />);
    expect(byTest('recent-count').textContent).toBe('49');
    click(byTest('recent-count-more'));
    expect(writes.at(-1)).toEqual(['sidebar.recentCount', 50]);
    expect(byTest<HTMLButtonElement>('recent-count-more').disabled).toBe(true);
    preset('sidebar.recentCount', 1);
    expect(byTest<HTMLButtonElement>('recent-count-fewer').disabled).toBe(true);
    click(byTest('recent-count-more'));
    expect(writes.at(-1)).toEqual(['sidebar.recentCount', 2]);
  });

  it('marks the shortcuts and sections as this device’s own, and keeps a change out of the notebook (A1626)', () => {
    // What every device shared before: Graph hidden on all of them.
    act(() => setSetting(workspace.doc, DEVICE_MAP, 'sidebar.graph', false));
    render(<SidebarSettings />);
    const marks = [...host.querySelectorAll<HTMLElement>('.lf-sub .lf-scope')];
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.dataset['scope']).toBe('device');
      expect(mark.querySelector('[data-icon="laptop"]')).not.toBeNull();
      expect(mark.getAttribute('aria-label')).toBe(
        'These settings are kept only on this device and aren’t synced to your other devices.',
      );
    }
    // The synced value shows until this device has its own.
    expect(byTest<HTMLInputElement>('display-graph').checked).toBe(false);
    click(byTest('display-graph'));
    expect(byTest<HTMLInputElement>('display-graph').checked).toBe(true);
    expect(readSettings(workspace.doc, 'desktop')).toEqual({});
    expect(readSettings(workspace.doc, DEVICE_MAP)['sidebar.graph']).toBe(false);
    expect(readSettings(workspace.doc, 'mobile')).toEqual({});
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

  it('draws the app’s own sidebar, which hides and moves with the switches (A1564)', () => {
    render(<SidebarSettings />);
    // The sidebar itself, inert: its row of shortcuts, then its sections, the app's own.
    const frame = byTest('sidebar-preview');
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(
      frame.querySelector('.sidebar > .sb-actions [data-testid="sidebar-shortcuts"]'),
    ).not.toBeNull();
    expect(frame.querySelector('.sidebar > nav.sb-list')).not.toBeNull();
    expect(frame.querySelector('[data-testid="source-section"]')?.textContent).toContain('Notes');
    const preview = () =>
      [...byTest('sidebar-preview').querySelectorAll('[data-section]')].map((part) =>
        part.getAttribute('data-section'),
      );
    expect(preview()).toEqual(['quickAccess', 'recent', 'notebooks', 'calendar', 'tags']);
    click(byTest('display-section-recent'));
    expect(writes.at(-1)![0]).toBe('sidebar.hiddenSections');
    expect(preview()).toEqual(['quickAccess', 'notebooks', 'calendar', 'tags']);
    const icons = () =>
      byTest('sidebar-preview').querySelectorAll('[data-testid="sidebar-shortcuts"] svg').length;
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
    // Note Panel is this device's own: a laptop, its sentence its name and its tooltip (A1559),
    // beside the label, so the radios' group keeps the label alone as its name.
    const mark = byTest('note-panel-setting').querySelector<HTMLElement>('.lf-scope')!;
    const sentence =
      'This setting is kept only on this device and isn’t synced to your other devices.';
    expect(mark.querySelector('[data-icon="laptop"]')).not.toBeNull();
    expect(mark.getAttribute('role')).toBe('img');
    expect(mark.getAttribute('aria-label')).toBe(sentence);
    expect(mark.dataset['tip']).toBe(sentence);
    expect(mark.tabIndex).toBe(0);
    expect(mark.textContent).toBe('');
    expect(mark.closest('label, .lf-row-label')).toBeNull();
    // The status bar never offers Tags.
    expect(host.querySelector('[data-testid="metadata-status-tags"]')).toBeNull();
  });

  it('draws each title bar button as one row: icon, name, then its switch at the end', () => {
    render(<NoteSettings />);
    const cells = [...byTest('note-bar-settings').children];
    expect(cells).toHaveLength(9);
    for (const cell of cells) {
      expect(cell.className).toBe('lf-row');
      expect([...cell.children].map((child) => child.className)).toEqual([
        'lf-row-text',
        'lf-row-control',
      ]);
      const label = cell.querySelector('.lf-row-text > label')!;
      expect(label.firstElementChild!.tagName.toLowerCase()).toBe('svg');
      expect(label.textContent.trim()).not.toBe('');
      const control = cell.lastElementChild!;
      expect(control.children).toHaveLength(1);
      expect(control.firstElementChild!.getAttribute('role')).toBe('switch');
      expect(label.getAttribute('for')).toBe(control.firstElementChild!.id);
    }
    // The grid's cells never wrap the switch under the name (PEN-148), in either column.
    // Run from the package, as `pnpm --filter` does.
    const css = readFileSync(resolve(process.cwd(), 'src/theme/look-settings.css'), 'utf8');
    expect(css).toMatch(/\.lf-group-two > \.lf-row \{\s*flex-wrap: nowrap;/);
  });

  it('turns a detail on as a chip', () => {
    render(<NoteSettings />);
    click(byTest('metadata-title-edited'));
    expect(writes.at(-1)).toEqual(['metadata.underTitle', ['edited']]);
  });

  it('turns a title bar button on', () => {
    render(<NoteSettings />);
    click(byTest('display-note-bar-delete'));
    expect(writes.at(-1)).toEqual(['noteBar.delete', true]);
  });

  // The preview is the app's own note view (A1564), so what it shows of a note's details and
  // bar buttons is proved with a note in it: settings-previews.spec.ts. Here, with no note yet,
  // it is the app's own page for no note open, inert.
  it('previews the app itself, inert, not a picture of it', () => {
    render(<NoteSettings />);
    const preview = byTest('note-preview');
    expect(preview.hasAttribute('inert')).toBe(true);
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    expect(preview.querySelector('.notes-app > main.note-main')).not.toBeNull();
    expect(preview.querySelector('.sidebar')).toBeNull();
    expect(preview.querySelector('[data-testid="empty-state"]')).not.toBeNull();
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
    const stored = settings()['symbols.list'] as Array<{ glyph: string }>;
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
    expect(String(settings()['theme.id'])).not.toBe('penmoss');
    expect(settings()['theme.id']).toBeTruthy();
    expect(byTest('custom-theme-editor')).not.toBeNull();
    expect(byTest('theme-preview').className).toBe('app-preview');
    expect(host.querySelector('[data-testid="theme-grid"]')).toBeNull();
    click(byTest('theme-editor-done'));
    expect(host.querySelector('[data-testid="theme-editor"]')).toBeNull();
    expect(byTest('theme-customize').textContent).toBe('Customize Penmoss copy…');
  });
});
