/**
 * The binding rules shared by the web, the Mac app, the Android editor page and the server
 * (T40 P9, A490, A491): `usableBindings` (moved here from apps/web, A90) and the shape every
 * stored `keys.<id>` must have.
 */
import { describe, expect, it } from 'vitest';
import { bindingValueProblem, COMMAND_ID_PATTERN, rawBindings, usableBindings } from '../src/keys';

const defaults: Record<string, readonly string[]> = {
  'editor.undo': ['Mod+Z'],
  'note.new': ['Alt+N'],
};
const defaultsOf = (id: string) => defaults[id];

describe('usableBindings', () => {
  it('normalises, drops what this platform cannot use and keeps a command’s own default', () => {
    const raw = {
      'note.new': ['alt+shift+n', 'Mod+Alt+N'],
      'editor.undo': ['Mod+Z', 'Mod+U'],
      'app.search': ['Mod+C'],
      'app.palette': [],
      broken: 'Mod+K',
    };
    expect(usableBindings(raw, defaultsOf, false)).toEqual({
      // Ctrl+Alt+N is AltGr off Apple platforms: dropped, Alt+Shift+N stays.
      'note.new': ['Alt+Shift+N'],
      'editor.undo': ['Mod+Z', 'Mod+U'],
      // Nothing usable left (Mod+C is the clipboard's): the defaults stay, so it is left out.
      'app.palette': [],
    });
    // On a Mac, ⌘⌥N is fine and ⌥⇧N types (Ø).
    expect(usableBindings(raw, defaultsOf, true)['note.new']).toEqual(['Mod+Alt+N']);
  });

  it('reads the keys.* entries of a settings object', () => {
    expect(rawBindings({ 'keys.app.search': ['Mod+J'], 'theme.id': 'nord' })).toEqual({
      'app.search': ['Mod+J'],
    });
  });
});

describe('bindingValueProblem', () => {
  it.each([[[]], [['Mod+Shift+E']], [['Alt+Up', 'F2']], [['Mod+/', 'Mod++']], [['Delete']]])(
    'takes %j',
    (value) => {
      expect(bindingValueProblem(value)).toBeNull();
    },
  );

  it.each([
    ['Mod+K'],
    [['mod+k']],
    [['Shift+Mod+K']],
    [['Meta+K']],
    [['Mod+']],
    [['Mod+K', 'Mod+K']],
    [['Mod+A', 'Mod+B', 'Mod+C', 'Mod+D', 'Mod+E']],
    [['Mod+Shift+ArrowUpAndAway']],
    [[42]],
    [['Mod+Shift+Alt+Ctrl+Mod+Shift+Alt+Ctrl+Mod+Shift+E']],
  ])('refuses %j', (value) => {
    expect(bindingValueProblem(value)).not.toBeNull();
  });

  it('names commands as the registry does', () => {
    for (const id of [
      'app.palette',
      'editor.insert.callout-tip',
      'copy-markdown',
      'editor.heading1',
    ])
      expect(COMMAND_ID_PATTERN.test(id)).toBe(true);
    for (const id of ['', '.app', 'app..x', 'app palette', 'keys.app/x'])
      expect(COMMAND_ID_PATTERN.test(id)).toBe(false);
  });
});
