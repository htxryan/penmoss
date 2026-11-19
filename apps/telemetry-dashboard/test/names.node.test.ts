// What the dashboard calls an event (PEN-137, review round 2): a display name in Title Case from
// the shortcut contract or the app's own names, never the raw id alone, with the id kept beside it.
import { describe, expect, it } from 'vitest';
import shortcutsContract from '../../android/contract/shortcuts-v1.json';
import { SCREEN_NAMES } from '@penmoss/core/analytics';
import { commandName, displayName, eventName, kindName, titled } from '../src/client/names';

describe('event names', () => {
  it('names a command by its title in the shortcut contract', () => {
    expect(displayName('command', 'note.new')).toBe('New Note');
    expect(displayName('command', 'app.palette')).toBe('Command Palette');
    expect(commandName('note.new')).toEqual({ title: 'New Note', id: 'note.new' });
    // A menu's ellipsis is left off.
    expect(displayName('command', 'app.quickOpen')).toBe('Quick Open Note');
    for (const command of shortcutsContract.commands) {
      expect(displayName('command', command.id), command.id).not.toMatch(/…$|\.\.\.$/);
    }
  });

  it('names screens, dialogs and first-run steps as the app does, with their kind in the id', () => {
    expect(eventName('screen:note')).toEqual({ title: 'Note', id: 'screen:note' });
    expect(eventName('command:app.palette')).toEqual({
      title: 'Command Palette',
      id: 'app.palette',
    });
    expect(eventName('dialog:palette').title).toBe('Command Palette');
    expect(eventName('screen:settings.privacy').title).toBe('Settings › Privacy');
    expect(eventName('screen:firstrun.github').title).toBe('First Run › Sign In with GitHub');
    expect(eventName('end')).toEqual({ title: 'Session Ended', id: '' });
    expect(kindName('dialog:palette')).toBe('Dialog');
    expect(kindName('command:app.palette')).toBe('Command');
  });

  it('names every catalogued screen without a dot, an underscore or a hyphen', () => {
    for (const screen of SCREEN_NAMES) {
      expect(displayName('screen', screen), screen).not.toMatch(/[._-]/);
    }
  });

  it('puts other ids in Title Case, short words lower case inside', () => {
    expect(titled('read_note')).toBe('Read Note');
    expect(titled('git-missing')).toBe('Git Missing');
    expect(titled('move-to-folder')).toBe('Move to Folder');
    expect(displayName('click', 'sidebar.quick-access.pin')).toBe('Sidebar › Quick Access › Pin');
    expect(displayName('cli', 'search')).toBe('penmoss search');
  });
});
