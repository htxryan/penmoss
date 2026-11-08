import { describe, expect, it, vi } from 'vitest';
import { CommandCenter, memoryBindings, type ActiveEditor } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { menuModel, menuOf } from '../../src/desktop/menu';
import { parseRoute } from '../../src/router';

// T29: the web app's side of the Mac app: the menus it describes from the command registry,
// and menu shortcuts dispatched without running twice. Its session, sign-in and admin requests
// went with the server (T59, D49).

// T59 (D49): nothing in the menus signs in, signs out, opens the browser or administers.
describe('the Mac menus without a server (T59)', () => {
  it('has no sign-in, sign-out, browser or admin commands', () => {
    const ids = COMMANDS.map((command) => command.id);
    for (const gone of [
      'app.signOut',
      'app.openInBrowser',
      'sync.signIn',
      'sync.retryUploads',
      'app.sync',
      'app.devices',
      'app.gitMirror',
      'devices.recoveryCode',
      'devices.revokeAll',
      'notebook.manage',
      'notebook.new',
    ]) {
      expect(ids, gone).not.toContain(gone);
    }
  });
});

describe('menus from the command registry (T29, A222)', () => {
  // T39 pass 2 (A526): the Mac's menus grey out what cannot run now.
  it('marks a command that cannot run now, and only then', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const off = center.register('note.delete', { run: () => undefined });
    const byId = () =>
      new Map(
        menuModel(center.definitions.values(), (id) => center.keysOf(id), {
          available: (id) => center.available(id),
        })
          .flatMap((menu) => menu.groups.flat())
          .map((item) => [item.id, item]),
      );
    expect(byId().get('note.delete')).not.toHaveProperty('enabled');
    // No note open: nothing to move to Trash, and no editor for Bold.
    off();
    expect(byId().get('note.delete')?.enabled).toBe(false);
    expect(byId().get('editor.bold')?.enabled).toBe(false);
  });

  const center = new CommandCenter(COMMANDS, memoryBindings({ 'note.new': ['Mod+Shift+U'] }));
  // A Mac app's window, with keep on top (T46); without it, see mac-window.test.tsx.
  const menus = menuModel(center.definitions.values(), (id) => center.keysOf(id), {
    macWindow: true,
  });
  const items = menus.flatMap((menu) => menu.groups.flat());

  it('gives every command a menu item, except ones that act on a focused row or are pending', () => {
    const expected = COMMANDS.filter(
      (command) =>
        !command.pending &&
        command.scope !== 'tree' &&
        (!command.hidden || command.id === 'app.palette'),
    ).map((command) => command.id);
    expect(items.map((item) => item.id).sort()).toEqual(expected.sort());
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(menuOf(COMMANDS.find((command) => command.id === 'folder.rename')!)).toBeNull();
  });

  it('shows each command’s current keys, the user’s binding over the default', () => {
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get('note.new')).toEqual({
      id: 'note.new',
      title: 'New Note',
      keys: ['Mod+Shift+U'],
    });
    expect(byId.get('app.capture')?.keys).toEqual(['Mod+Shift+K']);
    expect(byId.get('editor.bold')?.keys).toEqual(['Mod+B']);
  });

  // T39 pass 3 (A890): as the note's ⋯ menu ends, here and on Android.
  it('ends the File menu’s note commands with Move to Trash, set apart', () => {
    const file = menus.find((menu) => menu.label === 'File')!;
    const at = file.groups.findIndex((group) => group.some((item) => item.id === 'note.delete'));
    expect(file.groups[at]!.map((item) => item.id)).toEqual(['note.delete']);
    const before = file.groups[at - 1]!.map((item) => item.id);
    expect(before[0]).toBe('note.new');
    expect(before).toEqual(expect.arrayContaining(['note.move', 'note.history']));
    // The folders' group follows.
    expect(file.groups[at + 1]!.some((item) => item.id === 'folder.new')).toBe(true);
  });

  it('puts menus in the Mac order, with undo first in Edit and Settings in the app menu', () => {
    expect(menus.map((menu) => menu.label)).toEqual([
      'Penmoss',
      'File',
      'Edit',
      'Format',
      'Insert',
      'View',
      'Go',
      'Help',
    ]);
    const edit = menus.find((menu) => menu.label === 'Edit')!;
    expect(edit.groups[0]!.map((item) => item.id)).toEqual(['editor.undo', 'editor.redo']);
    expect(edit.groups.at(-1)!.map((item) => item.id)).toEqual(['app.search']);
    expect(menus[0]!.groups.flat().map((item) => item.id)).toEqual([
      'app.settings',
      'app.checkForUpdates',
    ]);
  });

  it('puts Send feedback in Help, with the shortcut help (T49, A798)', () => {
    const help = menus.find((menu) => menu.label === 'Help')!;
    expect(help.groups.flat().map((item) => item.id)).toContain('app.sendFeedback');
    expect(help.groups.flat().find((item) => item.id === 'app.sendFeedback')?.title).toBe(
      'Send Feedback',
    );
  });

  it('puts the theme commands in View, together (T28)', () => {
    const view = menus.find((menu) => menu.label === 'View')!;
    const group = view.groups.find((items) => items.some((item) => item.id === 'theme.switch'));
    expect(group?.map((item) => item.id)).toEqual([
      'app.appearance',
      // T42 (A576): Settings → Display, beside Appearance.
      'app.display',
      'theme.switch',
      'theme.toggleDark',
    ]);
  });
});

describe('shortcuts a native menu took (T29)', () => {
  function keydown(code: string, target: unknown = null) {
    return {
      code,
      key: code.replace(/^Key/, '').toLowerCase(),
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      defaultPrevented: false,
      target,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
  }

  it('runs a menu shortcut the page never saw, once', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const run = vi.fn();
    center.register('journal.today', { run });
    expect(center.dispatchMenuShortcut('Mod+D', null)).toBe(true);
    expect(run).toHaveBeenCalledWith({ source: 'menu' });
  });

  it('ignores the menu’s echo of a key the page just handled or declined', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const run = vi.fn();
    center.register('journal.today', { run });
    center.handleKeyDown(keydown('KeyD'));
    expect(run).toHaveBeenCalledOnce();
    expect(center.dispatchMenuShortcut('Mod+D', null)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it('acts where focus is: an editor command only with focus in the note body', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const inside = { id: 'in-editor' } as unknown as EventTarget;
    const calls: string[] = [];
    const chain = () => {
      const api = { toggleBold: () => (calls.push('bold'), api), run: () => true };
      return api;
    };
    center.setEditor({
      editor: {
        view: { dom: { contains: (node: unknown) => node === inside }, hasFocus: () => true },
        state: { selection: { empty: false, from: 1, to: 3 } },
        chain,
      },
    } as unknown as ActiveEditor);
    expect(center.dispatchMenuShortcut('Mod+B', null)).toBe(false);
    expect(center.dispatchMenuShortcut('Mod+B', inside)).toBe(true);
    expect(calls).toEqual(['bold']);
  });
});

describe('the capture route (T30)', () => {
  it('is its own page', () => {
    expect(parseRoute('/capture')).toEqual({ name: 'capture' });
  });
});
