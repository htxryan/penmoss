import { describe, expect, it } from 'vitest';
import { NORD, PENMOSS } from '../src/theme/builtins';
import { deleteCustomTheme, saveCustomTheme, type ThemeSettingsStore } from '../src/theme/actions';
import { duplicateTheme, parseTheme, storedTheme } from '../src/theme/schema';
import {
  CUSTOM_THEME_PREFIX,
  MODE_SETTING,
  resolveThemeSettings,
  THEME_SETTING,
} from '../src/theme/settings';
import { themeVariables } from '../src/theme/css';
import { COLOUR_KEYS } from '../src/theme/tokens';

const nordCopy = () => storedTheme(duplicateTheme(NORD, 'custom-a1', 'My Nord'));

describe('theme schema: validated on read (T28)', () => {
  it('round-trips a duplicated theme through its stored JSON', () => {
    const stored = nordCopy();
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    const { theme, problems } = parseTheme(stored)!;
    expect(problems).toEqual([]);
    expect(theme).toEqual({
      ...NORD,
      id: 'custom-a1',
      name: 'My Nord',
      description: 'Based on Nord',
      base: 'nord',
    });
  });

  it('refuses data that is not a theme at all', () => {
    for (const bad of [null, 1, 'nord', [], {}, { id: 'custom-a1' }, { id: 42, name: 'x' }]) {
      expect(parseTheme(bad), JSON.stringify(bad)).toBeNull();
    }
    // Only custom ids: a synced theme can never replace a built-in.
    expect(parseTheme({ ...nordCopy(), id: 'penmoss' })).toBeNull();
    expect(parseTheme({ ...nordCopy(), id: 'custom-../../x' })).toBeNull();
  });

  it('replaces a bad colour with its base theme’s, and says so', () => {
    const stored = nordCopy();
    const raw = {
      ...stored,
      light: { ...stored.light, bg: 'red', fg: 'url(https://evil.test/x)' },
      dark: { ...stored.dark, accent: '#12345' },
    };
    const { theme, problems } = parseTheme(raw)!;
    expect(theme.light.bg).toBe(NORD.light.bg);
    expect(theme.light.fg).toBe(NORD.light.fg);
    expect(theme.dark.accent).toBe(NORD.dark.accent);
    expect(problems).toEqual(['light.bg', 'light.fg', 'dark.accent']);
  });

  it('fills tokens a theme lacks (written by an older build) from its base', () => {
    const stored = nordCopy();
    const lightWithout: Record<string, string> = { ...stored.light };
    delete lightWithout['codeKeyword'];
    const { theme, problems } = parseTheme({ ...stored, light: lightWithout })!;
    expect(theme.light.codeKeyword).toBe(NORD.light.codeKeyword);
    expect(problems).toEqual(['light.codeKeyword']);
  });

  it('ignores fields a newer build added, and keeps them when the theme is written back', () => {
    const raw = {
      ...nordCopy(),
      version: 2,
      light: { ...nordCopy().light, sparkle: '#ffffff' },
      shape: { radius: 8 },
    };
    const { theme, problems } = parseTheme(raw)!;
    expect(problems).toEqual([]);
    expect(theme.light).not.toHaveProperty('sparkle');
    const edited = storedTheme({ ...theme, name: 'Renamed' }, raw);
    expect(edited).toMatchObject({ version: 2, shape: { radius: 8 }, name: 'Renamed' });
    expect(edited.light).toMatchObject({ sparkle: '#ffffff', bg: NORD.light.bg });
  });

  it('keeps values in a newer format when an older build edits something else (A20)', () => {
    // A newer build stored an 8-digit colour, a base and a font this build does not know,
    // and a wider note column; this build renames the theme.
    const raw = {
      ...nordCopy(),
      version: 2,
      base: 'dracula',
      fonts: { ...nordCopy().fonts, mono: 'Iosevka Term', heading: 'Fraunces' },
      editorWidth: 80,
      light: { ...nordCopy().light, bg: '#eceff4cc' },
    };
    const { theme, problems } = parseTheme(raw)!;
    expect(problems).toEqual(expect.arrayContaining(['base', 'editorWidth', 'light.bg']));
    const edited = storedTheme({ ...theme, name: 'Renamed' }, raw);
    expect(edited).toMatchObject({
      version: 2,
      name: 'Renamed',
      base: 'dracula',
      editorWidth: 80,
      fonts: { mono: 'Iosevka Term', heading: 'Fraunces' },
    });
    expect(edited.light.bg).toBe('#eceff4cc');
    // What the user does change is written, and only that.
    const widened = storedTheme({ ...theme, editorWidth: 50 }, raw);
    expect(widened).toMatchObject({ editorWidth: 50, base: 'dracula', name: 'My Nord' });
    expect(widened.light.bg).toBe('#eceff4cc');
  });

  it('merges an edit onto a newer stored version: only the fields that changed since it began', () => {
    const start = parseTheme(nordCopy())!.theme;
    // Another device changed the accent and the name meanwhile.
    const latest = storedTheme({
      ...start,
      name: 'Theirs',
      light: { ...start.light, accent: '#205080' },
    });
    // This device changed the background and the code font.
    const mine = {
      ...start,
      light: { ...start.light, bg: '#f0f0f0' },
      fonts: { ...start.fonts, mono: 'Menlo' },
    };
    const merged = parseTheme(storedTheme(mine, latest, start))!.theme;
    expect(merged.name).toBe('Theirs');
    expect(merged.light.accent).toBe('#205080');
    expect(merged.light.bg).toBe('#f0f0f0');
    expect(merged.fonts.mono).toBe('Menlo');
    expect(merged.dark).toEqual(start.dark);
  });

  it('falls back to Penmoss as the base when the named base is unknown', () => {
    const { theme, problems } = parseTheme({
      id: 'custom-b',
      name: 'Odd',
      base: 'a-theme-from-the-future',
    })!;
    expect(theme.base).toBe('penmoss');
    expect(theme.light).toEqual(PENMOSS.light);
    expect(problems).toContain('base');
  });

  it('accepts only plain font stacks and a sensible editor width', () => {
    const stored = nordCopy();
    const { theme, problems } = parseTheme({
      ...stored,
      name: '  ',
      fonts: { ui: 'Inter, sans-serif', body: 'x; } body { display: none', mono: 'url(x)' },
      editorWidth: 9000,
    })!;
    expect(theme.fonts.ui).toBe('Inter, sans-serif');
    expect(theme.fonts.body).toBe(NORD.fonts.body);
    expect(theme.fonts.mono).toBe(NORD.fonts.mono);
    expect(theme.editorWidth).toBe(NORD.editorWidth);
    expect(theme.name).toBe('Untitled theme');
    expect(problems).toEqual(['name', 'fonts.body', 'fonts.mono', 'editorWidth']);
  });
});

describe('theme settings (T28)', () => {
  it('defaults to Penmoss following the system', () => {
    const resolved = resolveThemeSettings({});
    expect(resolved.theme.id).toBe('penmoss');
    expect(resolved.mode).toBe('system');
    expect(resolved.custom).toEqual([]);
  });

  it('reads the chosen theme, the mode and the custom themes', () => {
    const stored = nordCopy();
    const resolved = resolveThemeSettings({
      [THEME_SETTING]: 'custom-a1',
      [MODE_SETTING]: 'dark',
      [`${CUSTOM_THEME_PREFIX}custom-a1`]: stored,
      timeZone: 'America/Chicago',
    });
    expect(resolved.mode).toBe('dark');
    expect(resolved.theme.name).toBe('My Nord');
    expect(resolved.custom.map((theme) => theme.id)).toEqual(['custom-a1']);
  });

  it('falls back safely from bad synced data', () => {
    const resolved = resolveThemeSettings({
      [THEME_SETTING]: 'custom-missing',
      [MODE_SETTING]: 'sepia',
      [`${CUSTOM_THEME_PREFIX}custom-x`]: 'not a theme',
      [`${CUSTOM_THEME_PREFIX}custom-y`]: { ...nordCopy(), id: 'custom-other' },
    });
    expect(resolved.theme.id).toBe('penmoss');
    expect(resolved.mode).toBe('system');
    // A theme stored under another id's key is not that theme.
    expect(resolved.custom).toEqual([]);
  });

  it('chooses a built-in by id', () => {
    expect(resolveThemeSettings({ [THEME_SETTING]: 'gruvbox' }).theme.name).toBe('Gruvbox');
  });
});

describe('theme variables (T28)', () => {
  it('sets every colour token, its aliases, the fonts and the editor width', () => {
    const vars = themeVariables(NORD, 'dark');
    expect(vars['--pm-bg']).toBe(NORD.dark.bg);
    expect(vars['--pm-callout-info']).toBe(NORD.dark.calloutNote);
    expect(vars['--pm-callout-bug']).toBe(NORD.dark.calloutFailure);
    expect(vars['--pm-font']).toBe(NORD.fonts.ui);
    expect(vars['--pm-font-body']).toBe(NORD.fonts.body);
    expect(vars['--pm-mono']).toBe(NORD.fonts.mono);
    expect(vars['--pm-editor-width']).toBe(`${NORD.editorWidth}rem`);
    expect(NORD.editorWidth).toBe(52); // T41 (A500); 46 before.
    expect(Object.keys(vars).length).toBeGreaterThan(COLOUR_KEYS.length);
  });
});

describe('saving and deleting custom themes (T28)', () => {
  function memoryStore(initial: Record<string, unknown> = {}): ThemeSettingsStore {
    const values: Record<string, unknown> = { ...initial };
    return {
      settings: () => ({ ...values }),
      setSetting: (key, value) => {
        if (value === undefined) delete values[key];
        else values[key] = value;
      },
    };
  }

  it('does not bring back a theme deleted since the edit began', () => {
    const store = memoryStore();
    const start = duplicateTheme(NORD, 'custom-a1', 'My Nord');
    saveCustomTheme(store, start);
    store.setSetting(THEME_SETTING, start.id);
    deleteCustomTheme(store, start);
    const saved = saveCustomTheme(store, { ...start, name: 'Late edit' }, start);
    expect(saved).toBeNull();
    expect(resolveThemeSettings(store.settings()).custom).toEqual([]);
  });

  it('falls back to a deleted theme’s base, wherever it is still chosen', () => {
    const store = memoryStore();
    const theme = duplicateTheme(NORD, 'custom-a1', 'My Nord');
    saveCustomTheme(store, theme);
    deleteCustomTheme(store, theme);
    // Chosen again by a device that had not heard of the deletion.
    store.setSetting(THEME_SETTING, theme.id);
    expect(resolveThemeSettings(store.settings()).theme).toBe(NORD);
  });

  it('saves the merged theme and returns it', () => {
    const store = memoryStore();
    const start = duplicateTheme(NORD, 'custom-a1', 'My Nord');
    saveCustomTheme(store, start);
    saveCustomTheme(store, { ...start, name: 'Theirs' });
    const saved = saveCustomTheme(store, { ...start, editorWidth: 50 }, start);
    expect(saved).toMatchObject({ name: 'Theirs', editorWidth: 50 });
  });
});
