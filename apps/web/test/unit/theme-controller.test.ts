import { readFileSync } from 'node:fs';
import {
  CUSTOM_THEME_PREFIX,
  duplicateTheme,
  GRUVBOX,
  MODE_SETTING,
  NORD,
  PENMOSS,
  storedTheme,
  THEME_SETTING,
  fontVariables,
  themeVariables,
} from '@penmoss/ui/theme';
import { FONT_PRESET_STACKS } from '@penmoss/core/fonts';
import { describe, expect, it } from 'vitest';
import {
  THEME_CACHE_KEY,
  ThemeController,
  type ThemeApplied,
  type ThemeEnvironment,
} from '../../src/theme/controller';
import type { KeyValueStore } from '../../src/shell/key-value';
import { memoryStorage } from './support/memory-storage';

/** A stand-in for <html>, localStorage and the system's colour scheme. */
function environment(options: { dark?: boolean; storage?: KeyValueStore } = {}) {
  const vars = new Map<string, string>();
  const attributes = new Map<string, string>();
  const style = {
    colorScheme: '',
    setProperty: (name: string, value: string) => void vars.set(name, value),
  };
  let dark = options.dark ?? false;
  const listeners = new Set<() => void>();
  const applied: ThemeApplied[] = [];
  const env: ThemeEnvironment = {
    root: { style, setAttribute: (name, value) => void attributes.set(name, value) },
    storage: options.storage ?? memoryStorage({}),
    systemDark: {
      get matches() {
        return dark;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    onApplied: (detail) => applied.push(detail),
  };
  return {
    env,
    vars,
    attributes,
    style,
    applied,
    setSystemDark(value: boolean) {
      dark = value;
      for (const listener of listeners) listener();
    },
  };
}

const myNord = () => storedTheme(duplicateTheme(NORD, 'custom-n1', 'My Nord'));

describe('ThemeController (T28)', () => {
  it('starts with Penmoss following the system, before any settings are read', () => {
    const page = environment({ dark: true });
    const controller = new ThemeController(page.env);
    controller.start();
    expect(page.attributes.get('data-theme')).toBe('penmoss');
    expect(page.attributes.get('data-mode')).toBe('dark');
    expect(page.style.colorScheme).toBe('dark');
    expect(page.vars.get('--pm-bg')).toBe(PENMOSS.dark.bg);
    expect(page.applied.at(-1)).toMatchObject({
      id: 'penmoss',
      variant: 'dark',
      background: PENMOSS.dark.bg,
    });
  });

  it('applies the synced theme and mode, and follows the system in system mode', () => {
    const page = environment({ dark: false });
    const controller = new ThemeController(page.env);
    controller.start();
    controller.setSettings({ [THEME_SETTING]: 'gruvbox' });
    expect(page.vars.get('--pm-bg')).toBe(GRUVBOX.light.bg);
    page.setSystemDark(true);
    expect(page.vars.get('--pm-bg')).toBe(GRUVBOX.dark.bg);
    controller.setSettings({ [THEME_SETTING]: 'gruvbox', [MODE_SETTING]: 'light' });
    expect(page.attributes.get('data-mode')).toBe('light');
    page.setSystemDark(false);
    page.setSystemDark(true);
    expect(page.vars.get('--pm-bg')).toBe(GRUVBOX.light.bg);
  });

  it('remembers the last theme on this device, custom ones included, for the next start', () => {
    const storage = memoryStorage({});
    const first = environment({ storage });
    const controller = new ThemeController(first.env);
    controller.start();
    controller.setSettings({
      [THEME_SETTING]: 'custom-n1',
      [MODE_SETTING]: 'dark',
      [`${CUSTOM_THEME_PREFIX}custom-n1`]: myNord(),
    });
    const next = environment({ storage });
    new ThemeController(next.env).start();
    expect(next.attributes.get('data-theme')).toBe('custom-n1');
    expect(next.vars.get('--pm-bg')).toBe(NORD.dark.bg);
  });

  it('keeps the remembered theme while settings are unknown (signed out, still loading)', () => {
    const storage = memoryStorage({});
    const page = environment({ storage });
    const controller = new ThemeController(page.env);
    controller.start();
    controller.setSettings({ [THEME_SETTING]: 'nord', [MODE_SETTING]: 'dark' });
    controller.setSettings(null);
    expect(page.attributes.get('data-theme')).toBe('nord');
    expect(page.attributes.get('data-mode')).toBe('dark');
  });

  it('ignores a bad remembered theme', () => {
    const storage = memoryStorage({ 'penmoss.theme': '{"mode":"dark","theme":{"id":"custom-x"}}' });
    const page = environment({ storage, dark: false });
    new ThemeController(page.env).start();
    expect(page.attributes.get('data-theme')).toBe('penmoss');
    expect(page.attributes.get('data-mode')).toBe('dark');
    const garbage = environment({ storage: memoryStorage({ 'penmoss.theme': '{' }) });
    new ThemeController(garbage.env).start();
    expect(garbage.attributes.get('data-theme')).toBe('penmoss');
  });

  it('previews a theme without saving it, then goes back', () => {
    const page = environment();
    const controller = new ThemeController(page.env);
    controller.start();
    controller.setSettings({ [THEME_SETTING]: 'nord' });
    controller.preview(GRUVBOX);
    expect(page.attributes.get('data-theme')).toBe('gruvbox');
    expect(controller.getState().theme.id).toBe('nord');
    controller.preview(null);
    expect(page.attributes.get('data-theme')).toBe('nord');
  });

  it('keeps one preview per owner: closing the picker goes back to the editor’s draft', () => {
    const page = environment();
    const controller = new ThemeController(page.env);
    controller.start();
    controller.setSettings({ [THEME_SETTING]: 'nord' });
    const editor = {};
    const picker = {};
    const draft = { ...duplicateTheme(NORD, 'custom-d1', 'Draft') };
    controller.preview(draft, editor);
    controller.preview(GRUVBOX, picker);
    expect(page.attributes.get('data-theme')).toBe('gruvbox');
    controller.preview(null, picker);
    expect(page.attributes.get('data-theme')).toBe('custom-d1');
    controller.preview(null, editor);
    expect(page.attributes.get('data-theme')).toBe('nord');
  });

  it('notifies subscribers when what is shown changes', () => {
    const page = environment();
    const controller = new ThemeController(page.env);
    controller.start();
    let calls = 0;
    const off = controller.subscribe(() => calls++);
    controller.setSettings({ [THEME_SETTING]: 'nord' });
    page.setSystemDark(true);
    off();
    controller.setSettings({ [THEME_SETTING]: 'slate' });
    expect(calls).toBe(2);
    expect(controller.getState()).toMatchObject({ variant: 'dark', mode: 'system' });
  });
});

describe('remembering the theme on this device (T28 review)', () => {
  it('writes only when the theme or mode changes, with both variants ready for the next start', () => {
    const storage = memoryStorage({});
    let writes = 0;
    const counted = {
      ...storage,
      setItem: (key: string, value: string) => (writes++, storage.setItem(key, value)),
    };
    const controller = new ThemeController(environment({ storage: counted }).env);
    controller.setSettings({ [THEME_SETTING]: 'nord', [MODE_SETTING]: 'dark' });
    controller.setSettings({
      [THEME_SETTING]: 'nord',
      [MODE_SETTING]: 'dark',
      'journal.zone': 'UTC',
    });
    expect(writes).toBe(1);
    const cached = JSON.parse(storage.getItem(THEME_CACHE_KEY)!) as {
      vars: Record<string, Record<string, string>>;
    };
    // The note size rides along (A944): the theme's fonts stay while no font is chosen.
    expect(cached.vars['light']).toEqual({
      ...themeVariables(NORD, 'light'),
      ...fontVariables({}),
    });
    expect(cached.vars['dark']).toEqual({ ...themeVariables(NORD, 'dark'), ...fontVariables({}) });
    controller.setSettings({ [THEME_SETTING]: 'nord', [MODE_SETTING]: 'light' });
    expect(writes).toBe(2);
  });
});

describe('the page before any script (T28, A249)', () => {
  it('starts with Penmoss’s backgrounds in theme-color, the one place outside builtins.ts', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const metas = [...html.matchAll(/<meta name="theme-color" content="([^"]+)" media="([^"]+)"/g)];
    expect(metas.map(([, content, media]) => [media, content])).toEqual([
      ['(prefers-color-scheme: light)', PENMOSS.light.bg],
      ['(prefers-color-scheme: dark)', PENMOSS.dark.bg],
    ]);
  });
});

describe('the font settings over the theme (T51 item 16, A944)', () => {
  it('lays the chosen fonts and size over the theme’s, and gives the theme’s back', () => {
    const page = environment();
    const controller = new ThemeController(page.env);
    controller.start();
    expect(page.vars.get('--pm-font')).toBe(PENMOSS.fonts.ui);
    expect(page.vars.get('--pm-note-size')).toBe('16px');
    controller.setSettings({
      [THEME_SETTING]: 'nord',
      'font.interface': 'serif',
      'font.note': 'custom:Avenir Next',
      'font.noteSize': 20,
    });
    expect(page.vars.get('--pm-bg')).toBe(NORD.light.bg);
    expect(page.vars.get('--pm-font')).toBe(FONT_PRESET_STACKS.serif);
    expect(page.vars.get('--pm-font-body')).toBe(`'Avenir Next', ${FONT_PRESET_STACKS.system}`);
    expect(page.vars.get('--pm-note-size')).toBe('20px');
    // Code keeps the theme's mono font.
    expect(page.vars.get('--pm-mono')).toBe(NORD.fonts.mono);
    // A preview keeps the person's fonts over its own.
    const owner = {};
    controller.preview(GRUVBOX, owner);
    expect(page.vars.get('--pm-font')).toBe(FONT_PRESET_STACKS.serif);
    controller.preview(null, owner);
    // Back to the theme's own.
    controller.setSettings({ [THEME_SETTING]: 'nord' });
    expect(page.vars.get('--pm-font')).toBe(NORD.fonts.ui);
    expect(page.vars.get('--pm-font-body')).toBe(NORD.fonts.body);
    expect(page.vars.get('--pm-note-size')).toBe('16px');
  });

  it('remembers the fonts for the next start, before settings are read', () => {
    const storage = memoryStorage({});
    const first = new ThemeController(environment({ storage }).env);
    first.setSettings({ 'font.note': 'mono', 'font.noteSize': 24 });
    const cached = JSON.parse(storage.getItem(THEME_CACHE_KEY)!) as {
      vars: Record<string, Record<string, string>>;
    };
    expect(cached.vars['light']!['--pm-font-body']).toBe(FONT_PRESET_STACKS.mono);
    expect(cached.vars['dark']!['--pm-note-size']).toBe('24px');
    const page = environment({ storage });
    new ThemeController(page.env).start();
    expect(page.vars.get('--pm-font-body')).toBe(FONT_PRESET_STACKS.mono);
    expect(page.vars.get('--pm-note-size')).toBe('24px');
  });

  it('remembers a custom family in any script (T51 review)', () => {
    const storage = memoryStorage({});
    new ThemeController(environment({ storage }).env).setSettings({
      'font.note': 'custom:Hiragino Mincho ProN',
      'font.interface': 'custom:Ünïcode Sans',
    });
    const page = environment({ storage });
    new ThemeController(page.env).start();
    expect(page.vars.get('--pm-font')).toBe(`'Ünïcode Sans', ${FONT_PRESET_STACKS.system}`);
    expect(page.vars.get('--pm-font-body')).toBe(
      `'Hiragino Mincho ProN', ${FONT_PRESET_STACKS.system}`,
    );
  });
});
