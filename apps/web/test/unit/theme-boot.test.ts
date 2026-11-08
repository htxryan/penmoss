import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { NORD, PENMOSS, themeVariables } from '@penmoss/ui/theme';
import { describe, expect, it } from 'vitest';
import { THEME_CACHE_KEY, ThemeController } from '../../src/theme/controller';
import { memoryStorage } from './support/memory-storage';

// T28 review: the page's first paint is already in the remembered theme. public/theme-boot.js
// runs from <head>, before the app's bundle, and applies what ThemeController remembered.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const SCRIPT = read('../../public/theme-boot.js');

/** A stand-in for <html> and the theme-color metas. */
function page() {
  const vars = new Map<string, string>();
  const attributes = new Map<string, string>();
  const metas = [{ content: 'initial' }, { content: 'initial' }].map((meta) => ({
    ...meta,
    setAttribute(name: string, value: string) {
      if (name === 'content') meta.content = value;
      this.content = value;
    },
  }));
  const root = {
    style: {
      colorScheme: '',
      setProperty: (name: string, value: string) => void vars.set(name, value),
    },
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
  };
  const document = {
    documentElement: root,
    querySelectorAll: (selector: string) => (selector.includes('theme-color') ? metas : []),
  };
  return { document, root, vars, attributes, metas };
}

function boot(cache: string | null, systemDark = false) {
  const target = page();
  const storage = memoryStorage(cache === null ? {} : { [THEME_CACHE_KEY]: cache });
  const matchMedia = (query: string) => ({
    matches: systemDark && query === '(prefers-color-scheme: dark)',
  });
  runInNewContext(SCRIPT, { localStorage: storage, matchMedia, document: target.document });
  return target;
}

/** What ThemeController leaves in localStorage for `settings`. */
function remembered(settings: Record<string, unknown>): string {
  const storage = memoryStorage({});
  const controller = new ThemeController({
    root: {
      style: { colorScheme: '', setProperty: () => undefined },
      setAttribute: () => undefined,
    },
    storage,
    systemDark: { matches: false, subscribe: () => () => undefined },
  });
  controller.setSettings(settings);
  return storage.getItem(THEME_CACHE_KEY)!;
}

describe('the theme before the app loads (T28, A251)', () => {
  it('runs from <head> as a classic script, ahead of the bundle', () => {
    const html = read('../../index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<script src="/theme-boot.js"></script>');
    expect(html.indexOf('/theme-boot.js')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('applies the remembered theme’s variables, mode and colour scheme', () => {
    const shown = boot(remembered({ 'theme.id': 'nord', 'theme.mode': 'dark' }));
    for (const [name, value] of Object.entries(themeVariables(NORD, 'dark'))) {
      expect(shown.vars.get(name), name).toBe(value);
    }
    expect(shown.attributes.get('data-theme')).toBe('nord');
    expect(shown.attributes.get('data-mode')).toBe('dark');
    expect(shown.root.style.colorScheme).toBe('dark');
    expect(shown.metas.map((meta) => meta.content)).toEqual([NORD.dark.bg, NORD.dark.bg]);
  });

  it('follows the system in System mode', () => {
    const cache = remembered({ 'theme.id': 'nord', 'theme.mode': 'system' });
    expect(boot(cache, false).vars.get('--pm-bg')).toBe(NORD.light.bg);
    expect(boot(cache, true).vars.get('--pm-bg')).toBe(NORD.dark.bg);
    expect(boot(cache, true).attributes.get('data-mode')).toBe('dark');
  });

  it('leaves the page to the stylesheet’s Penmoss defaults with nothing or nonsense remembered', () => {
    for (const cache of [null, 'not json', '{"mode":"dark"}', '{"mode":"dark","vars":42}']) {
      const shown = boot(cache);
      expect(shown.vars.size, String(cache)).toBe(0);
      expect(shown.attributes.size, String(cache)).toBe(0);
    }
  });

  it('sets only theme variables, and only plain values', () => {
    const shown = boot(
      JSON.stringify({
        mode: 'light',
        id: 'nord',
        vars: {
          light: {
            '--pm-bg': '#eceff4',
            '--pm-fg': 'url(https://example.com/x)',
            '--pm-accent': 'red;background:url(x)',
            color: '#000000',
            '--pm-font': '"Iowan Old Style", Georgia, serif',
          },
        },
      }),
    );
    expect(Object.fromEntries(shown.vars)).toEqual({
      '--pm-bg': '#eceff4',
      '--pm-font': '"Iowan Old Style", Georgia, serif',
    });
  });

  it('applies a custom font family in any script (T51 review)', () => {
    const shown = boot(remembered({ 'font.note': 'custom:游明朝' }));
    expect(shown.vars.get('--pm-font-body')).toMatch(/^'游明朝', /);
  });
});

describe('Penmoss in the stylesheet, for a first visit (T28, A251)', () => {
  /** The custom properties set in the first block after `marker`. */
  function block(css: string, marker: string): Record<string, string> {
    const start = css.indexOf('{', css.indexOf(marker)) + 1;
    const body = css.slice(start, css.indexOf('}', start));
    return Object.fromEntries(
      [...body.matchAll(/(--pm-[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [
        name!,
        value!.trim(),
      ]),
    );
  }

  it('sets every Penmoss variable in :root, light, and dark when the system is dark', () => {
    const css = read('../../src/theme/defaults.css');
    expect(block(css, ':root')).toEqual(themeVariables(PENMOSS, 'light'));
    expect(block(css, '@media (prefers-color-scheme: dark)')).toEqual(
      Object.fromEntries(
        Object.entries(themeVariables(PENMOSS, 'dark')).filter(
          ([name, value]) => themeVariables(PENMOSS, 'light')[name] !== value,
        ),
      ),
    );
  });
});
