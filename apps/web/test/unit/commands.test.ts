import { describe, expect, it, vi } from 'vitest';
import { bindingsFromSettings, settingsBindings } from '../../src/commands/bindings';
import { CommandCenter, memoryBindings, type ActiveEditor } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { fuzzy, highlightRuns } from '../../src/commands/fuzzy';

/** A keydown as the dispatcher reads it (Ctrl is Mod off Apple platforms). */
function key(
  code: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
  target: unknown = null,
) {
  const event = {
    code,
    key: code.replace(/^Key/, '').toLowerCase(),
    ctrlKey: mods.ctrl ?? false,
    metaKey: false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    isComposing: false,
    defaultPrevented: false,
    target,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
    stopPropagation: vi.fn(),
  };
  return event;
}
type FakeEvent = ReturnType<typeof key>;
const dispatch = (center: CommandCenter, event: FakeEvent) =>
  center.handleKeyDown(event as unknown as KeyboardEvent);

/** An editor stand-in: its DOM contains `inside`, and toggleBold records calls. */
function fakeEditor(selected: boolean) {
  const inside = { id: 'editor-child' };
  const calls: string[] = [];
  const chain = () => {
    const api = {
      toggleBold: () => (calls.push('bold'), api),
      run: () => true,
    };
    return api;
  };
  const editor = {
    view: { dom: { contains: (node: unknown) => node === inside }, hasFocus: () => true },
    state: {
      selection: { empty: !selected, from: 1, to: selected ? 5 : 1 },
    },
    chain,
  };
  return { active: { editor } as unknown as ActiveEditor, inside, calls };
}

/** The app's commands as a platform loads them (some default keys depend on it). */
async function commandsOn(platform: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { ...navigator, platform, userAgent: platform });
  try {
    const { COMMANDS: commands } = await import('../../src/commands/definitions');
    const keys = await import('@penmoss/editor/keys');
    return { commands, keys };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('default keys on each platform (A90)', () => {
  it('can all be bound there: none is AltGr on Windows or types on a Mac', async () => {
    for (const [platform, apple] of [
      ['MacIntel', true],
      ['Win32', false],
      ['Linux x86_64', false],
    ] as const) {
      const { commands, keys } = await commandsOn(platform);
      const bad = commands
        // Folder rows take Delete and Backspace while one has focus (not typing).
        .filter((command) => command.scope !== 'tree')
        .flatMap((command) =>
          command.keys
            .filter((combo) => keys.bindingProblem(combo, apple) !== null)
            .filter((combo) => !(keys.RESERVED_COMBOS.has(combo) && /undo|redo/.test(command.id)))
            .map((combo) => `${platform}: ${command.id} ${combo}`),
        );
      expect(bad).toEqual([]);
      const keysOf = (id: string) => commands.find((command) => command.id === id)!.keys;
      expect(keysOf('note.new')).toEqual([apple ? 'Mod+Alt+N' : 'Alt+N']);
      expect(keysOf('folder.new')).toEqual([apple ? 'Mod+Alt+Shift+N' : 'Alt+Shift+N']);
      expect(keysOf('note.history')).toEqual([apple ? 'Mod+Alt+Shift+H' : 'Alt+Shift+H']);
      expect(keysOf('journal.thisWeek')).toEqual(['Mod+Shift+W', apple ? 'Mod+Alt+W' : 'Alt+W']);
    }
  });
});

describe('the command registry (T20)', () => {
  it('has unique ids and only bindable or editor-default keys', () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts with no conflicts among the defaults', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    expect(center.allConflicts()).toEqual([]);
  });

  it('runs a global command for its key and stops the event', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const run = vi.fn();
    center.register('app.recent', { run });
    const event = key('KeyE', { ctrl: true });
    expect(dispatch(center, event)).toBe(true);
    expect(run).toHaveBeenCalledWith({ source: 'key', event });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('leaves a key nothing handles alone', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const event = key('KeyE', { ctrl: true });
    expect(dispatch(center, event)).toBe(false); // No handler registered: the browser's key.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('passes Mod+K on to the palette when the link command declines (A42)', () => {
    const palette = vi.fn();
    for (const selected of [true, false]) {
      const center = new CommandCenter(COMMANDS, memoryBindings());
      center.register('app.palette', { run: palette });
      const { active, inside } = fakeEditor(selected);
      center.setEditor(active);
      // Without the toolbar the link command declines (editor-commands.test.ts covers it there).
      dispatch(center, key('KeyK', { ctrl: true }, inside));
    }
    expect(palette).toHaveBeenCalledTimes(2);
    const center = new CommandCenter(COMMANDS, memoryBindings());
    expect(center.conflicts('app.palette', 'Mod+K')).toEqual([]);
  });

  it('runs editor commands only while the note has focus', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const { active, inside, calls } = fakeEditor(true);
    center.setEditor(active);
    expect(dispatch(center, key('KeyB', { ctrl: true }, { id: 'title field' }))).toBe(false);
    expect(dispatch(center, key('KeyB', { ctrl: true }, inside))).toBe(true);
    expect(calls).toEqual(['bold']);
  });

  it('rebinding takes effect at once, and the old editor key stops working', () => {
    const store = memoryBindings();
    const center = new CommandCenter(COMMANDS, store);
    const { active, inside, calls } = fakeEditor(true);
    center.setEditor(active);
    const changed = vi.fn();
    center.subscribe(changed);
    center.rebind('editor.bold', ['Mod+Shift+L']);
    expect(changed).toHaveBeenCalled();
    expect(center.keysOf('editor.bold')).toEqual(['Mod+Shift+L']);
    expect(store.read()).toEqual({ 'editor.bold': ['Mod+Shift+L'] });
    // The old key is swallowed in the editor (TipTap's own keymap would still bold).
    const old = key('KeyB', { ctrl: true }, inside);
    expect(dispatch(center, old)).toBe(true);
    expect(calls).toEqual([]);
    expect(dispatch(center, key('KeyL', { ctrl: true, shift: true }, inside))).toBe(true);
    expect(calls).toEqual(['bold']);
    center.reset('editor.bold');
    expect(center.keysOf('editor.bold')).toEqual(['Mod+B']);
  });

  it('reports conflicts in overlapping scopes only', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    expect(center.conflicts('note.new', 'Mod+E').map((command) => command.id)).toEqual([
      'app.recent',
    ]);
    // Bold lives in the editor, the tree's commands in the tree: they never act together.
    expect(center.conflicts('folder.rename', 'Mod+B')).toEqual([]);
    // A global command clashes with an editor one (it would never run while typing).
    expect(center.conflicts('note.new', 'Mod+B').map((command) => command.id)).toEqual([
      'editor.bold',
    ]);
    center.rebind('note.new', ['Mod+E']);
    expect(center.allConflicts()).toEqual([{ combo: 'Mod+E', ids: ['app.recent', 'note.new'] }]);
  });

  it("registers T15's copy commands under their own ids and per-platform keys", () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    // Tests run as a non-Apple platform: Ctrl+Shift+C, and no default for rich text (AltGr).
    expect(center.definitions.get('copy-markdown')).toMatchObject({
      keys: ['Mod+Shift+C'],
      scope: 'editor',
    });
    expect(center.definitions.get('copy-rich-text')?.keys).toEqual([]);
    expect(center.conflicts('note.new', 'Mod+Shift+C').map((command) => command.id)).toEqual([
      'copy-markdown',
    ]);
    // The header's whole-note copies have no keys of their own.
    expect(center.keysOf('note.copyMarkdown')).toEqual([]);
  });

  it('keeps pending commands out of the palette and the dispatcher, but reserves their keys', () => {
    const center = new CommandCenter(
      [
        ...COMMANDS,
        {
          id: 'later.thing',
          title: 'Later',
          area: 'General',
          keys: ['Mod+Shift+J'],
          scope: 'global',
          pending: 'T99',
        },
      ],
      memoryBindings(),
    );
    const run = vi.fn();
    center.register('later.thing', { run });
    expect(center.available('later.thing')).toBe(false);
    expect(dispatch(center, key('KeyJ', { ctrl: true, shift: true }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(center.conflicts('note.new', 'Mod+Shift+J').map((command) => command.id)).toEqual([
      'later.thing',
    ]);
  });

  it('stands aside while the shortcut editor records a key', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const run = vi.fn();
    center.register('app.recent', { run });
    const resume = center.suspend();
    expect(dispatch(center, key('KeyE', { ctrl: true }))).toBe(false);
    resume();
    expect(dispatch(center, key('KeyE', { ctrl: true }))).toBe(true);
  });

  it('uses the latest registration, and an enabled check', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const first = vi.fn();
    const second = vi.fn();
    center.register('note.new', { run: first });
    const off = center.register('note.new', { run: second, enabled: () => false });
    expect(center.run('note.new')).toBe(false);
    off();
    expect(center.run('note.new')).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('lets an earlier registration answer when a later one cannot run and yields (A862)', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings());
    let secondActive = false;
    const first = vi.fn();
    const second = vi.fn();
    // Two sources' folder trees in the sidebar: the one in use answers.
    center.register('folder.new', { run: first, enabled: () => !secondActive, yields: true });
    center.register('folder.new', { run: second, enabled: () => secondActive, yields: true });
    expect(center.run('folder.new')).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    secondActive = true;
    expect(center.run('folder.new')).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    // None can: unavailable, and nothing runs.
    const lone = new CommandCenter(COMMANDS, memoryBindings());
    lone.register('folder.new', { run: first, enabled: () => false, yields: true });
    expect(lone.available('folder.new')).toBe(false);
  });
});

describe('bindings in synced settings', () => {
  it('keeps one setting per command and ignores malformed values', () => {
    expect(
      bindingsFromSettings({
        'keys.note.new': ['Mod+Shift+U'],
        'keys.bad': 'Mod+X',
        theme: 'dark',
      }),
    ).toEqual({ 'note.new': ['Mod+Shift+U'] });
  });

  it('ignores synced bindings that would take typing, the clipboard or AltGr (A90)', () => {
    const read = bindingsFromSettings({
      // Typing, and Shift with a letter.
      'keys.note.new': ['N'],
      'keys.app.graph': ['Shift+G'],
      // Paste and select all.
      'keys.app.recent': ['Mod+V', 'Mod+A'],
      // Ctrl+Alt is AltGr on Windows (Polish ń).
      'keys.app.quickOpen': ['Mod+Alt+N'],
      // A bad combination next to a good one: only the good one stays, normalised.
      'keys.app.cheatsheet': ['mod+shift+o', 'X'],
      // Undo keeps its own default; [] still means "no shortcut".
      'keys.editor.undo': ['Mod+Z'],
      'keys.note.toggleSource': [],
    });
    expect(read).toEqual({
      'app.cheatsheet': ['Mod+Shift+O'],
      'editor.undo': ['Mod+Z'],
      'note.toggleSource': [],
    });
  });

  it('keeps the defaults when a bad binding reaches the registry, and never runs it', () => {
    const center = new CommandCenter(
      COMMANDS,
      memoryBindings({ 'app.recent': ['E'], 'editor.bold': ['Mod+C'] }),
    );
    const recent = vi.fn();
    center.register('app.recent', { run: recent });
    expect(center.keysOf('app.recent')).toEqual(['Mod+E']);
    expect(center.keysOf('editor.bold')).toEqual(['Mod+B']);
    expect(dispatch(center, key('KeyE'))).toBe(false);
    expect(recent).not.toHaveBeenCalled();
    const { active, inside, calls } = fakeEditor(true);
    center.setEditor(active);
    expect(dispatch(center, key('KeyC', { ctrl: true }, inside))).toBe(false);
    expect(calls).toEqual([]);
    expect(() => center.rebind('app.recent', ['Mod+V'])).toThrow(/clipboard|editing/);
  });

  it('never takes a key typed with AltGr', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings({ 'note.new': ['Mod+Shift+U'] }));
    const run = vi.fn();
    center.register('note.new', { run });
    const altGr = {
      ...key('KeyU', { ctrl: true, shift: true }),
      getModifierState: (name: string) => name === 'AltGraph',
    };
    expect(dispatch(center, altGr)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(dispatch(center, key('KeyU', { ctrl: true, shift: true }))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('writes through the workspace settings and re-reads on change', () => {
    const settings: Record<string, unknown> = {};
    const listeners = new Set<() => void>();
    const store = settingsBindings({
      settings: () => settings,
      setSetting: (name, value) => {
        if (value === undefined) delete settings[name];
        else settings[name] = value;
        for (const listener of listeners) listener();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const center = new CommandCenter(COMMANDS, store);
    center.rebind('app.recent', ['Mod+Shift+E']);
    expect(settings).toEqual({ 'keys.app.recent': ['Mod+Shift+E'] });
    // Another device's change arrives as a settings update.
    settings['keys.note.new'] = [];
    for (const listener of listeners) listener();
    expect(center.keysOf('note.new')).toEqual([]);
    center.reset('app.recent');
    expect(settings).toEqual({ 'keys.note.new': [] });
  });
});

describe('fuzzy search', () => {
  it('matches characters in order and ranks word starts and runs higher', () => {
    expect(fuzzy('tdy', 'Open today’s note')).not.toBeNull();
    expect(fuzzy('xyz', 'Open today’s note')).toBeNull();
    const start = fuzzy('new', 'New note')!.score;
    const middle = fuzzy('new', 'Rename the newest')!.score;
    expect(start).toBeGreaterThan(middle);
  });

  it('rejects letters scattered across a long title', () => {
    expect(fuzzy('ae', 'a long title that eventually ends')).toBeNull();
  });

  it('splits text into highlighted runs', () => {
    const match = fuzzy('nn', 'New note')!;
    expect(highlightRuns('New note', match.indices)).toEqual([
      { text: 'N', match: true },
      { text: 'ew ', match: false },
      { text: 'n', match: true },
      { text: 'ote', match: false },
    ]);
  });
});

describe('the registry across remounts', () => {
  it('follows the store again after dispose and start (React StrictMode)', () => {
    const store = memoryBindings();
    const center = new CommandCenter(COMMANDS, store);
    center.dispose();
    center.start();
    center.rebind('note.new', ['Mod+Shift+U']);
    expect(center.keysOf('note.new')).toEqual(['Mod+Shift+U']);
  });
});
