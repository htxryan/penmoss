// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { NotesProvider } from '../../src/notes/context';
import { FolderTree } from '../../src/workspace/FolderTree';
import { TreeActions } from '../../src/workspace/TreeActions';
import { WorkspaceProvider } from '../../src/workspace/context';
import { memoryNotes } from './support/memory-notes';
import { memoryStorage } from './support/memory-storage';
import { testNotes, testWorkspace } from './support/local-sources';
import type { Notes } from '../../src/notes/service';
import type { Workspace } from '../../src/workspace/service';

// T52 items 1, 9 and 10: a folder's New Note Here, no Top Level label, and the notebook's
// actions (the sort order as a menu, Trash at their end), on the notebook's row since T53 items
// 4 and 5, with New Note first; and a folder row's own New Note.

let root: Root;
let host: HTMLDivElement;
let notes: Notes;
let workspace: Workspace;
let garden: string;
let chosen: (string | null)[];

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', memoryStorage());
  const store = memoryNotes();
  notes = testNotes(store);
  workspace = testWorkspace(store);
  await notes.start();
  await workspace.start();
  garden = workspace.createFolder('Garden', null);
  chosen = [];
  history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <CommandsContext.Provider value={new CommandCenter(COMMANDS, memoryBindings())}>
        <NotesProvider notes={notes}>
          <WorkspaceProvider workspace={workspace}>
            <TreeActions
              currentFolder={null}
              onCurrentFolderChange={(id) => chosen.push(id)}
              trash={{ href: '/trash', testId: 'sidebar-trash', current: false }}
            />
            <FolderTree
              activeId={null}
              currentFolder={null}
              onCurrentFolderChange={(id) => chosen.push(id)}
            />
          </WorkspaceProvider>
        </NotesProvider>
      </CommandsContext.Provider>,
    );
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  notes.stop();
  workspace.stop();
  vi.unstubAllGlobals();
});

const bar = () => host.querySelector<HTMLElement>('.tree-actions')!;
const row = (name: string) =>
  host.querySelector<HTMLElement>(`[role="treeitem"][aria-label="${name}"]`)!;
const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].map(
    (item) => item.textContent,
  );

describe('the notebook’s actions (T52, T53)', () => {
  it('has icons only: New Note, Sort, New Folder and Trash, no Top Level label', () => {
    expect(bar().textContent).toBe('');
    expect(host.textContent).not.toContain('Top Level');
    expect(
      [...bar().querySelectorAll<HTMLElement>('button, a')].map((item) =>
        item.getAttribute('aria-label'),
      ),
    ).toEqual([
      'New Note in This Notebook',
      'Sort Order for the Top Level',
      'New Folder',
      'Trash',
      // Shown instead of Sort, New Folder and Trash in a narrow row (styles.css; finding 19).
      'More Notebook Actions',
    ]);
    const trash = bar().querySelector<HTMLAnchorElement>('[data-testid="sidebar-trash"]')!;
    expect(trash.getAttribute('href')).toBe('/trash');
    expect(trash.dataset['tip']).toBe('Trash');
    // No native picker under the sort order any more.
    expect(host.querySelector('select')).toBeNull();
  });

  it('folds Sort, New Folder and Trash into ⋯ in a narrow row, each still there (finding 19)', () => {
    const more = host.querySelector<HTMLButtonElement>('[data-testid="notebook-more"]')!;
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.dataset['tip']).toBe('More Notebook Actions');
    for (const folded of ['sort-order', 'sidebar-trash']) {
      expect(host.querySelector(`[data-testid="${folded}"]`)!.classList).toContain(
        'tree-action-fold',
      );
    }
    act(() => more.click());
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(menuItems()).toEqual(['Sort Order…', 'New Folder', 'Trash']);
    // Sort Order… opens the sort order's own menu, under ⋯, and closing it goes back to ⋯.
    const sortOrder = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!;
    act(() => sortOrder.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('Sort Order for the Top Level');
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('opens the sort order as a menu, the order in use checked, and sets the one chosen', () => {
    const sort = host.querySelector<HTMLButtonElement>('[data-testid="sort-order"]')!;
    expect(sort.getAttribute('aria-haspopup')).toBe('menu');
    expect(sort.dataset['tip']).toBe('Sort Order for the Top Level: Manual');
    act(() => sort.click());
    expect(sort.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('Sort Order for the Top Level');
    const radios = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(radios.map((item) => item.textContent)).toEqual(['Manual', 'A–Z', 'Modified']);
    expect(radios.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(radios[0]!.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(radios[1]!.querySelector('[data-icon="check"]')).toBeNull();
    // Focus starts on the order in use.
    expect(document.activeElement).toBe(radios[0]);

    act(() => radios[1]!.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(sort);
    // Set in the workspace: the button reads it back.
    expect(sort.dataset['sort']).toBe('alpha');

    // Escape closes it, focus back on the button; so does the button itself.
    act(() => sort.click());
    act(() => {
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(sort);
    act(() => sort.click());
    act(() => {
      sort.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      sort.click();
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('makes a note at the notebook’s top level with +, opened (T53 item 4)', () => {
    act(() => bar().querySelector<HTMLElement>('[data-testid="notebook-new-note"]')!.click());
    const id = /^\/notes\/(.+)$/.exec(location.pathname)![1]!;
    expect(workspace.folderOfNote(id)).toBeNull();
    expect(notes.list().some((entry) => entry.id === id)).toBe(true);
    expect(chosen).toEqual([null]);
  });

  it('chooses the top level with a click below the rows', () => {
    act(() => host.querySelector<HTMLElement>('[data-testid="tree-root-drop"]')!.click());
    expect(chosen).toEqual([null]);
  });
});

describe('a folder’s New Note Here (T52)', () => {
  it('is a + on the folder’s row too, its only button: Rename and Delete are in its menu (T53 item 5, A1120)', () => {
    const actions = row('Garden').querySelector<HTMLElement>('.row-actions')!;
    expect(
      [...actions.querySelectorAll('button')].map((item) => item.getAttribute('aria-label')),
    ).toEqual(['New Note in Garden']);
    act(() => actions.querySelector<HTMLElement>('[data-testid="folder-row-new-note"]')!.click());
    const id = /^\/notes\/(.+)$/.exec(location.pathname)![1]!;
    expect(workspace.folderOfNote(id)).toBe(garden);
    expect(chosen).toContain(garden);
  });

  it('leads the folder’s context menu and makes a note in it, opened', () => {
    act(() => {
      row('Garden').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
      );
    });
    expect(menuItems()[0]).toBe('New Note Here');
    const item = document.querySelector<HTMLElement>('[data-testid="folder-new-note"]')!;
    act(() => item.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const match = /^\/notes\/(.+)$/.exec(location.pathname);
    expect(match).not.toBeNull();
    const id = match![1]!;
    expect(workspace.folderOfNote(id)).toBe(garden);
    expect(notes.list().some((entry) => entry.id === id)).toBe(true);
    // New notes and folders go there next.
    expect(chosen).toContain(garden);
  });
});
