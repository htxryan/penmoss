// What the dashboard calls an event (PEN-137, review round 2): a display name in Title Case from
// the shortcut contract or the app's own names, never the raw id alone, with the id kept beside it.
import { describe, expect, it } from 'vitest';
import shortcutsContract from '../../android/contract/shortcuts-v1.json';
import { NAME_PROP_SPECS, PROP_SPECS, SCREEN_NAMES } from '@penmoss/core/analytics';
import {
  NAME_PROP_WORDS,
  PROP_WORDS,
  commandName,
  cutLine,
  displayName,
  duration,
  eventName,
  gap,
  kindName,
  propsInWords,
  sessionLength,
  shortInstall,
  sinceStart,
  stretches,
  titled,
  windowName,
  type StretchEvent,
} from '../src/client/names';

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

// Sessions (PEN-173): props in words, times, lengths, the cut line and stretches.

/** Title Case as A938 has it: each word capitalised but the short ones inside. */
const TITLE_CASE = /^(?:[A-Z0-9][\w+<–-]*|[a-z]{1,4})(?: (?:[A-Z0-9][\w+<–-]*|of|to|in|for))*$/;

describe('props in words', () => {
  it('labels every key of every kind in PROP_SPECS, in its order', () => {
    for (const [kind, props] of Object.entries(PROP_SPECS)) {
      expect(Object.keys(PROP_WORDS[kind] ?? {}), kind).toEqual(Object.keys(props));
      for (const key of Object.keys(props)) {
        expect(PROP_WORDS[kind]![key]!.label, `${kind}.${key}`).toMatch(TITLE_CASE);
      }
    }
  });

  it('has a word for every value a prop can be one of', () => {
    for (const [kind, props] of Object.entries(PROP_SPECS)) {
      for (const [key, spec] of Object.entries(props)) {
        if (spec.type !== 'enum') continue;
        const words = PROP_WORDS[kind]![key]!;
        for (const value of spec.values) {
          // A map keyed as recorded, or a function that gives the word.
          expect(
            words.word !== undefined || Object.hasOwn(words.values ?? {}, String(value)),
            `${kind}.${key} = ${String(value)}`,
          ).toBe(true);
          const [pair] = propsInWords(kind, { [key]: value });
          expect(pair!.value, `${kind}.${key} = ${String(value)}`).toMatch(/^[A-Z0-9]/);
          expect(pair!.value).not.toMatch(/[_]|^[a-z]/);
        }
      }
    }
  });

  it('labels every prop tied to a name in NAME_PROP_SPECS, with a word for each value', () => {
    expect(Object.keys(NAME_PROP_WORDS)).toEqual(Object.keys(NAME_PROP_SPECS));
    for (const [key, props] of Object.entries(NAME_PROP_SPECS)) {
      const [kind, name] = key.split('.') as [string, string];
      expect(Object.keys(NAME_PROP_WORDS[key]!), key).toEqual(Object.keys(props));
      for (const [prop, spec] of Object.entries(props)) {
        expect(NAME_PROP_WORDS[key]![prop]!.label, `${key}.${prop}`).toMatch(TITLE_CASE);
        if (spec.type !== 'enum') continue;
        for (const value of spec.values) {
          expect(Object.hasOwn(NAME_PROP_WORDS[key]![prop]!.values ?? {}, String(value))).toBe(
            true,
          );
          const [pair] = propsInWords(kind, { [prop]: value }, name);
          expect(pair!.value, `${key}.${prop} = ${String(value)}`).toMatch(/^[A-Z0-9]/);
        }
      }
    }
  });

  it("reads a window's size and a layout in words", () => {
    expect(
      propsInWords(
        'app',
        { window: 'main', width: 1440, height: 900, fullScreen: false, maximised: true },
        'window',
      ),
    ).toEqual([
      { label: 'Window', value: 'Main' },
      { label: 'Width', value: '1440' },
      { label: 'Height', value: '900' },
      { label: 'Full Screen', value: 'No' },
      { label: 'Maximised', value: 'Yes' },
    ]);
    expect(
      propsInWords(
        'app',
        { window: 'note', sidebar: 'rail', panel: 'none', themeMode: 'system', tabs: '2–4' },
        'layout',
      ),
    ).toEqual([
      { label: 'Window', value: 'Note' },
      { label: 'Sidebar', value: 'Rail' },
      { label: 'Note Panel', value: 'None' },
      { label: 'Theme Mode', value: 'System' },
      { label: 'Tabs', value: '2–4' },
    ]);
  });

  it('reads a command as its chips, No included', () => {
    expect(
      propsInWords('command', { ran: true, keys: 'Mod+K', source: 'key', custom: false }),
    ).toEqual([
      { label: 'Source', value: 'Key' },
      { label: 'Keys', value: 'Mod+K' },
      { label: 'Own Shortcut', value: 'No' },
      { label: 'Ran', value: 'Yes' },
    ]);
  });

  it('gives each kind its words', () => {
    const words = (kind: string, props: Record<string, string | number | boolean | string[]>) =>
      propsInWords(kind, props).map(({ label, value }) => `${label} ${value}`);
    expect(words('screen', { from: 'home' })).toEqual(['From Home']);
    expect(words('screen', { from: 'settings.privacy' })).toEqual(['From Settings › Privacy']);
    expect(words('dialog', { action: 'done', open: '2–5s' })).toEqual([
      'Action Done',
      'Open For 2–5s',
    ]);
    expect(words('menu', { source: 'menubar' })).toEqual(['Source Menu Bar']);
    expect(words('setting', { value: 500 })).toEqual(['Value 500']);
    expect(words('setting', { value: true, changed: true })).toEqual(['Value Yes', 'Changed Yes']);
    expect(words('setting', { value: 'system' })).toEqual(['Value System']);
    expect(words('firstrun', { result: 'failed', error: 'gitMissing' })).toEqual([
      'Result Failed',
      'Error Git Missing',
    ]);
    expect(words('feedback', { type: 'bug', priority: 2, screenshots: '1', logs: false })).toEqual([
      'Type Bug',
      'Priority 2',
      'Screenshots 1',
      'Logs No',
    ]);
    expect(words('sync', { result: 'ok', took: '<1s', changed: '2–4' })).toEqual([
      'Result OK',
      'Took <1s',
      'Changed 2–4',
    ]);
    // CLI_FLAGS are stored without their dashes.
    expect(
      words('cli', { flags: ['json', 'all'], exit: 'NOT_FOUND', took: '<1s', tty: false }),
    ).toEqual(['Flags --json --all', 'Exit Not Found', 'Took <1s', 'Terminal No']);
    // The tool records notFound, where the Agents query's column is not_found.
    expect(words('tool', { agentClient: 'claude-code', result: 'notFound', took: '1–2s' })).toEqual(
      ['Agent Claude Code', 'Result Not Found', 'Took 1–2s'],
    );
    expect(
      words('app', {
        notebooks: '1',
        notes: '10–49',
        agents: true,
        theme: 'solarized-dark',
        active: '5–30m',
      }),
    ).toEqual([
      'Notebooks 1',
      'Notes 10–49',
      'Agents Yes',
      'Theme Solarized Dark',
      'Active For 5–30m',
    ]);
  });

  it('keeps a key it does not know, from a newer client, in Title Case at the end', () => {
    expect(propsInWords('command', { newThing: 'some_value', source: 'palette' })).toEqual([
      { label: 'Source', value: 'Palette' },
      { label: 'New Thing', value: 'Some Value' },
    ]);
    expect(propsInWords('mystery', { a: 1 })).toEqual([{ label: 'A', value: '1' }]);
    expect(propsInWords('command', {})).toEqual([]);
  });
});

describe('times in a session', () => {
  it('says the time since the start as a clock', () => {
    expect(sinceStart(0)).toBe('0:00');
    expect(sinceStart(12_000)).toBe('0:12');
    expect(sinceStart(59_999)).toBe('0:59');
    expect(sinceStart(62_000)).toBe('1:02');
    expect(sinceStart(3_600_000)).toBe('1:00:00');
    expect(sinceStart(3_723_000)).toBe('1:02:03');
  });

  it('says a gap with its sign, negative when the clock moved back', () => {
    expect(gap(0)).toBe('+0s');
    expect(gap(11_000)).toBe('+11s');
    expect(gap(59_000)).toBe('+59s');
    expect(gap(81_000)).toBe('+1m 21s');
    expect(gap(3_600_000)).toBe('+1h 00m');
    expect(gap(2 * 3_600_000 + 5 * 60_000)).toBe('+2h 05m');
    expect(gap(-3_000)).toBe('−3s');
    expect(duration(18 * 60_000 + 4_000)).toBe('18m 04s');
  });

  it('gives a one-event session its took bucket as its length, or 0s', () => {
    expect(sessionLength({ started: 0, ended: 1_084_000, events: 40 })).toBe('18m 04s');
    expect(sessionLength({ started: 5, ended: 5, events: 1, took: '1–2s' })).toBe('1–2s');
    expect(sessionLength({ started: 5, ended: 5, events: 1, took: null })).toBe('0s');
    expect(sessionLength({ started: 5, ended: 5, events: 1 })).toBe('0s');
  });

  it('shows an install by its first 8 hex characters, and a window in words', () => {
    expect(shortInstall('a3'.repeat(16))).toBe('a3a3a3a3…');
    expect(windowName('expanded')).toBe('Expanded Window');
    expect(windowName('compact')).toBe('Compact Window');
    expect(windowName(null)).toBe('');
  });
});

describe('the cut line', () => {
  it('says what This Install’s Sessions holds, in each of its forms', () => {
    expect(cutLine(1250, 0, 499)).toBe('Showing 500 of 1,250: this session and the 499 after it.');
    expect(cutLine(1250, 250, 249)).toBe(
      'Showing 500 of 1,250: this session, the 250 before it and the 249 after it.',
    );
    expect(cutLine(1250, 50, 449)).toBe(
      'Showing 500 of 1,250: this session, the 50 before it and the 449 after it.',
    );
    expect(cutLine(1250, 499, 0)).toBe('Showing 500 of 1,250: this session and the 499 before it.');
    expect(cutLine(1250, 200, 200)).toBe(
      'Showing 401 of 1,250: this session and the 200 either side of it.',
    );
  });

  it('is empty when the list holds every session', () => {
    expect(cutLine(21, 5, 15)).toBe('');
    expect(cutLine(1, 0, 0)).toBe('');
  });
});

describe('stretches', () => {
  const at = (s: number) => 1_000_000 + s * 1000;
  const mac = (s: number, kind: string, name: string, props = {}): StretchEvent => ({
    at: at(s),
    client: 'mac',
    kind,
    name,
    props,
  });

  it('splits a session where the screen changes, events before the first under their own', () => {
    const events = [
      mac(0, 'app', 'launch'),
      mac(1, 'screen', 'home'),
      mac(12, 'command', 'app.palette'),
      mac(15, 'screen', 'home'),
      mac(20, 'command', 'note.new'),
      mac(21, 'screen', 'note', { from: 'home' }),
      mac(102, 'dialog', 'search'),
    ];
    const parts = stretches(events);
    expect(parts.map((p) => [p.title, p.id, p.first, p.end])).toEqual([
      ['Before Any Screen', '', 0, 1],
      // A screen event repeating the screen showing stays in its stretch.
      ['Home', 'screen:home', 1, 5],
      ['Note', 'screen:note', 5, 7],
    ]);
    expect(parts.map((p) => p.summary)).toEqual([
      'from 0:00 · 1s here',
      'from 0:01 · 20s here',
      'from 0:21 · 1m 21s here · came from Home',
    ]);
  });

  it('starts with the screen when the first event is one', () => {
    const parts = stretches([mac(0, 'screen', 'journal'), mac(5, 'command', 'note.new')]);
    expect(parts.map((p) => p.title)).toEqual(['Daily Notes']);
    expect(parts[0]!.summary).toBe('from 0:00 · 5s here');
  });

  it('names a session with no screens for what it is', () => {
    const cli: StretchEvent = {
      at: at(0),
      client: 'cli',
      kind: 'cli',
      name: 'search',
      props: { took: '1–2s' },
    };
    expect(stretches([cli]).map((p) => [p.title, p.id, p.summary])).toEqual([
      // A one-event session stays its length: its took bucket.
      ['CLI Run', '', 'from 0:00 · 1–2s here'],
    ]);
    const mcp = [
      { at: at(0), client: 'mcp', kind: 'tool', name: 'search_notes' },
      { at: at(3), client: 'mcp', kind: 'tool', name: 'read_note' },
    ];
    expect(stretches(mcp).map((p) => [p.title, p.summary])).toEqual([
      ['MCP Connection', 'from 0:00 · 3s here'],
    ]);
    const firstRun = ['welcome', 'goal', 'way'].map((step, i) => mac(i * 10, 'firstrun', step));
    expect(stretches(firstRun).map((p) => p.title)).toEqual(['First Run']);
    expect(stretches([mac(0, 'app', 'launch'), mac(4, 'app', 'quit')]).map((p) => p.title)).toEqual(
      ['No Screens'],
    );
    expect(stretches([mac(0, 'app', 'launch')])[0]!.summary).toBe('from 0:00 · 0s here');
    expect(stretches([])).toEqual([]);
  });
});
