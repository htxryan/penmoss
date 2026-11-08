// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { NotesProvider } from '../../src/notes/context';
import { NoteDirectory } from '../../src/notes/directory';
import { DirectoryProvider } from '../../src/notes/links-context';
import {
  MAX_NOTE_MODES,
  paneIsWide,
  parsePanelModes,
  readDefaultPanelMode,
  readNotePanelMode,
  rememberPanelMode,
} from '../../src/notes/panel-mode';
import { WorkspaceProvider } from '../../src/workspace/context';
import { memoryNotes } from './support/memory-notes';
import { testNotes, testWorkspace } from './support/local-sources';

// T51 items 5–7 (A936, A937): the note's side panel as four icon tabs and the ⋯ menu in three
// groups. T53 item 9 (A985): the tabs' icons always down the note's right edge as vertical tabs,
// the panel open on one of them or closed; Comments in the panel alone.

const NOTE = '01JB7Q3V6M8K2T9RZ4XN5C1HPD';
const OTHER = '01JB7Q3V6M8K2T9RZ4XN5C1HPE';

/**
 * The note pane's width, which happy-dom does not lay out: the panel fits beside the note from
 * 60rem (960 px) of it, and lies over the text below that. The window stays as wide.
 */
let paneWidth = 1200;
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains('note-main') ? paneWidth : 0;
  },
});
afterAll(() => {
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
});
function pane(width: number) {
  paneWidth = width;
}

let unmount = () => undefined as void;
beforeEach(() => {
  localStorage.clear();
  pane(1200);
});
afterEach(() => unmount());

function mount(pathname = `/notes/${NOTE}`) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const store = memoryNotes();
  const notes = testNotes(store);
  notes.knows = () => true;
  const workspace = testWorkspace(store);
  const directory = new NoteDirectory({
    notes,
    folderOf: () => null,
    folderName: () => null,
    register: () => undefined,
    navigate: () => undefined,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <NotesProvider notes={notes}>
        <WorkspaceProvider workspace={workspace}>
          <DirectoryProvider directory={directory}>
            <App location={{ pathname, search: '' }} />
          </DirectoryProvider>
        </WorkspaceProvider>
      </NotesProvider>,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  const $ = <T extends HTMLElement = HTMLElement>(testId: string) =>
    container.querySelector<T>(`[data-testid="${testId}"]`);
  return { container, $ };
}

const click = (element: HTMLElement | null) => {
  expect(element).not.toBeNull();
  act(() => element!.click());
};

const key = (element: HTMLElement | null, name: string) =>
  act(() => {
    element!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });

/** The ⋯ menu's items, by group, as their names read. */
function menuGroups(container: HTMLElement): string[][] {
  const menu = container.querySelector('[role="menu"]')!;
  const groups: string[][] = [[]];
  for (const child of menu.children) {
    if (child.getAttribute('role') === 'separator') groups.push([]);
    else if (child.matches('[role^="menuitem"]'))
      groups.at(-1)!.push(child.querySelector('.menu-label')!.textContent ?? '');
  }
  return groups;
}

describe('the note’s panel as vertical tabs (T51, A936; T53 item 9)', () => {
  it('has four icon tabs down the note’s edge, Metadata first, each named and with a tooltip', () => {
    const { container, $ } = mount();
    const tablist = $('note-rail')!.querySelector('[role="tablist"]')!;
    expect(tablist.getAttribute('aria-orientation')).toBe('vertical');
    const tabs = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Metadata',
      'Comments',
      'History',
      'Local Graph',
    ]);
    for (const tab of tabs) {
      expect(tab.dataset['tip']).toBeTruthy();
      expect(tab.querySelector('svg')).not.toBeNull();
    }
    // Open on Metadata by default on a wide pane.
    expect($('note-tab-info')!.getAttribute('aria-selected')).toBe('true');
    expect($('note-tab-info')!.getAttribute('aria-controls')).toBe(`note-tabpanel-${NOTE}`);
    expect($('note-tab-info')!.tabIndex).toBe(0);
    expect($('note-tab-comments')!.tabIndex).toBe(-1);
    const panel = container.querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(`note-tab-${NOTE}-info`);
    expect($('note-info')).not.toBeNull();
    // No tab bar over the open panel: the strip is the only one.
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(container.querySelector('aside.note-side h2')!.textContent).toBe('Metadata');
  });

  it('opens a tab on a click and remembers it on this device; the open one closes it', () => {
    const { container, $ } = mount();
    click($('note-tab-comments'));
    expect($('note-tab-comments')!.getAttribute('aria-selected')).toBe('true');
    expect($('comments-panel')).not.toBeNull();
    expect(localStorage.getItem('penmoss.notePanelTab')).toBe('comments');
    click($('note-tab-history'));
    expect($('history-panel')).not.toBeNull();
    expect(localStorage.getItem('penmoss.notePanelTab')).toBe('history');
    click($('note-tab-history'));
    expect(container.querySelector<HTMLElement>('.note-columns')!.dataset['panel']).toBe('closed');
    expect(container.querySelector('aside.note-side')).toBeNull();
    // The strip stays, nothing selected; the first icon is the Tab stop.
    expect($('note-rail')).not.toBeNull();
    expect($('note-tab-history')!.getAttribute('aria-selected')).toBe('false');
    expect($('note-tab-info')!.tabIndex).toBe(0);
    expect(readNotePanelMode(NOTE)).toBe('closed');
    click($('note-tab-history'));
    unmount();
    const again = mount();
    expect(again.$('note-tab-history')!.getAttribute('aria-selected')).toBe('true');
  });

  it('moves between the tabs with ↑ and ↓, Home and End, opening each', () => {
    const { container, $ } = mount();
    const tablist = container.querySelector<HTMLElement>('[role="tablist"]')!;
    act(() => $('note-tab-info')!.focus());
    key(document.activeElement as HTMLElement, 'ArrowDown');
    expect($('note-tab-comments')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe($('note-tab-comments'));
    key(document.activeElement as HTMLElement, 'End');
    expect($('note-tab-graph')!.getAttribute('aria-selected')).toBe('true');
    key(document.activeElement as HTMLElement, 'ArrowDown');
    expect($('note-tab-info')!.getAttribute('aria-selected')).toBe('true');
    key(document.activeElement as HTMLElement, 'ArrowUp');
    expect($('note-tab-graph')!.getAttribute('aria-selected')).toBe('true');
    key(tablist.querySelector('[data-tab="graph"]'), 'Home');
    expect($('note-tab-info')!.getAttribute('aria-selected')).toBe('true');
  });

  it('leaves the tabs to the strip: none is in the ⋯ menu (A991)', () => {
    const { $ } = mount();
    click($('note-menu'));
    for (const command of [
      'note.backlinks',
      'note.comments',
      'note.addNoteComment',
      'note.history',
      'note.localGraph',
    ]) {
      expect(document.querySelector(`.menu [data-command="${command}"]`)).toBeNull();
    }
    expect($('toggle-markdown')).not.toBeNull();
  });

  it('gives focus to the tab a command opened, for a screen reader to name (T51 review)', () => {
    const { $ } = mount();
    click($('note-panel-close'));
    // The phone's ⋮ sheet still has the tabs (A991): its Version History runs the command.
    click($('note-actions'));
    click(document.querySelector<HTMLElement>('.menu [data-command="note.history"]'));
    expect($('note-tab-history')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe($('note-tab-history'));
  });

  it('closes on Escape inside it, giving focus back to its tab’s icon', () => {
    const { container, $ } = mount();
    const close = $('note-panel-close')!;
    act(() => close.focus());
    key(close, 'Escape');
    expect(container.querySelector('aside.note-side')).toBeNull();
    expect(document.activeElement).toBe($('note-tab-info'));
  });

  it('closes on Escape on its tab’s icon, where a click on the tab left focus (T53 pass)', () => {
    const { container, $ } = mount();
    click($('note-tab-comments'));
    expect(container.querySelector('aside.note-side')).not.toBeNull();
    const tab = $('note-tab-comments')!;
    act(() => tab.focus());
    key(tab, 'Escape');
    expect(container.querySelector('aside.note-side')).toBeNull();
    expect(document.activeElement).toBe(tab);
    // Closed, Escape on the strip changes nothing.
    key(tab, 'Escape');
    expect(container.querySelector('aside.note-side')).toBeNull();
  });

  it('closes from its Close button, for this note only', () => {
    const { container, $ } = mount();
    click($('note-panel-close'));
    expect(container.querySelector('aside.note-side')).toBeNull();
    expect(readNotePanelMode(NOTE)).toBe('closed');
    expect(readNotePanelMode(OTHER)).toBeNull();
  });
});

describe('the note bar (T51, A936; T53 item 9)', () => {
  it('has no Comments or Note Panel button: the strip has them', () => {
    const { $ } = mount();
    expect($('toggle-comments')).toBeNull();
    expect($('toggle-info')).toBeNull();
    expect($('comments-count')).toBeNull();
  });

  it('keeps Full Width, Copy Agent Reference (T52 item 4) and the ⋯ menu', () => {
    const { container } = mount();
    const controls = container.querySelectorAll('.note-top .note-actions > *');
    expect(controls).toHaveLength(3);
    expect(controls[1]!.getAttribute('data-command')).toBe('note.copyAgentReference');
  });
});

describe('the note’s ⋯ menu (T51, A937)', () => {
  it('has three groups, without Add a Tag or Send Feedback', () => {
    const { container, $ } = mount();
    click($('note-menu'));
    // Full Width with Markdown Source: every title bar button is also in ⋯ (A1134).
    expect(menuGroups(container)).toEqual([
      ['Full Width', 'Markdown Source'],
      ['Copy Note as Markdown', 'Copy Note as Rich Text', 'Copy Agent Reference'],
      ['Pin to Quick Access', 'Open in New Window', 'Move to Folder…', 'Move to Trash'],
    ]);
    expect($('pin-quick-access')).not.toBeNull();
  });
});

describe('the panel open or closed (T53 item 9, A985)', () => {
  it('remembers the most recent notes’ states, a bounded list, T52’s modes read too', () => {
    let list = rememberPanelMode([], 'a', 'closed');
    list = rememberPanelMode(list, 'b', 'open');
    list = rememberPanelMode(list, 'a', 'open');
    expect(list).toEqual([
      ['a', 'open'],
      ['b', 'open'],
    ]);
    for (let n = 0; n < MAX_NOTE_MODES + 10; n++) list = rememberPanelMode(list, `n${n}`, 'closed');
    expect(list).toHaveLength(MAX_NOTE_MODES);
    expect(list.some(([id]) => id === 'a')).toBe(false);
    expect(parsePanelModes('not json')).toEqual([]);
    expect(
      parsePanelModes(
        JSON.stringify([
          ['x', 'compact'],
          ['y', 'sideways'],
          ['z', 'expanded'],
          ['w', 'hidden'],
          3,
        ]),
      ),
    ).toEqual([
      ['x', 'closed'],
      ['z', 'open'],
      ['w', 'closed'],
    ]);
  });

  it('defaults to open, closed on a phone, until a default is chosen; T52’s default read too', () => {
    expect(readDefaultPanelMode()).toBe('open');
    expect(readDefaultPanelMode(localStorage, true)).toBe('closed');
    localStorage.setItem('penmoss.notePanelMode', 'compact');
    expect(readDefaultPanelMode()).toBe('closed');
    localStorage.setItem('penmoss.notePanelMode', 'expanded');
    expect(readDefaultPanelMode(localStorage, true)).toBe('open');
    localStorage.setItem('penmoss.notePanelMode', 'closed');
    expect(readDefaultPanelMode()).toBe('closed');
  });

  it('remembers each note’s state on this device; others take the default', () => {
    const first = mount();
    click(first.$('note-tab-info'));
    expect(first.container.querySelector('aside.note-side')).toBeNull();
    unmount();
    expect(mount().container.querySelector('aside.note-side')).toBeNull();
    unmount();
    const other = mount(`/notes/${OTHER}`);
    expect(other.container.querySelector('aside.note-side')).not.toBeNull();
    expect(other.$('note-rail')).not.toBeNull();
  });

  it('takes the default from Settings → Appearance → Note Panel', () => {
    const settings = mount('/settings/appearance');
    const group = settings.$('note-panel-setting')!;
    expect(group.querySelector('legend')!.textContent).toBe('Note Panel');
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.parentElement!.textContent)).toEqual(['Closed', 'Open']);
    expect(radios[1]!.checked).toBe(true);
    click(radios[0]!);
    expect(localStorage.getItem('penmoss.notePanelMode')).toBe('closed');
    expect(radios[0]!.checked).toBe(true);
    unmount();
    const { container, $ } = mount();
    expect($('note-rail')).not.toBeNull();
    expect(container.querySelector('aside.note-side')).toBeNull();
  });

  it('lies over the note’s text where the pane has no room beside it, 60rem', () => {
    expect(paneIsWide(960, 16)).toBe(true);
    expect(paneIsWide(959, 16)).toBe(false);
    expect(paneIsWide(1100, 20)).toBe(false);
    pane(900);
    const { container } = mount();
    const columns = () => container.querySelector<HTMLElement>('.note-columns')!;
    // A note with no state of its own starts closed where the panel would cover its text.
    expect(container.querySelector('aside.note-side')).toBeNull();
    expect(columns().dataset['panel']).toBe('closed');
    // Opened from its strip, it lies over the text.
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="note-tab-info"]')!.click();
    });
    expect(container.querySelector('aside.note-side')).not.toBeNull();
    expect(columns().dataset['panel']).toBe('open');
    expect(columns().dataset['over']).toBe('');
    // The pane widening (the window, or the sidebar collapsing) puts it beside the note.
    pane(1000);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(columns().dataset['over']).toBeUndefined();
  });
});
