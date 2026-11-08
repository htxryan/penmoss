import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { desktopConfig, GITHUB_CLIENT_ID, originOf } from '../../src/config';
import { deepLinkFromArgv, parseDeepLink } from '../../src/deep-link';
import {
  afterCapture,
  defaultCaptureHotkey,
  launchLog,
  HotkeyChangeGate,
  normaliseHotkey,
  registrationCertain,
} from '../../src/hotkey';
import {
  MENU_LIMITS,
  menuTemplate,
  parseMenus,
  toAccelerator,
  type MenuModel,
} from '../../src/menu';
import { resolveAsset, serveAsset } from '../../src/protocol';
import {
  ALLOWED_PERMISSIONS,
  appPath,
  ClipboardGate,
  isAppFrame,
  isExternalUrl,
  isAppUrl,
} from '../../src/security';
import { DEFAULT_WINDOW, fitToDisplays, parseWindowState } from '../../src/window-state';

// T29: the Mac app's main-process pieces that do not need Electron.

const ID = '01JB7Q3V6M8K2T9RZ4XN5C1HPD';

describe('configuration', () => {
  it('ignores the test overrides when packaged, whatever the environment says', () => {
    const env = {
      PENMOSS_USER_DATA: '/tmp/x',
      PENMOSS_WEB_ROOT: '/tmp/evil-web',
      PENMOSS_TEST_BASIC_TEXT_STORAGE: '1',
      PENMOSS_TEST_GITHUB_API: 'http://127.0.0.1:8791',
    };
    const packaged = desktopConfig({ env, packaged: true, appPath: '/Applications/P/app.asar' });
    expect(packaged).toMatchObject({
      userData: null,
      devTools: false,
      // A packaged app never seals a token with Linux's fixed-key basic_text backend.
      allowBasicTextStorage: false,
      githubApi: null,
    });
    expect(packaged.webRoot).toBe('/Applications/P/app.asar/dist/web');
    // No Penmoss server to point at (D49): nothing in the configuration names one.
    expect(Object.keys(packaged)).not.toContain('apiOrigin');
    expect(Object.keys(packaged)).not.toContain('appOrigin');
    const dev = desktopConfig({ env, packaged: false, appPath: '/src/desktop' });
    expect(dev).toMatchObject({
      webRoot: '/tmp/evil-web',
      userData: '/tmp/x',
      allowBasicTextStorage: true,
      githubApi: 'http://127.0.0.1:8791',
    });
    expect(desktopConfig({ env: {}, packaged: false, appPath: '/src/desktop' })).toMatchObject({
      allowBasicTextStorage: false,
    });
  });

  it('signs in with Penmoss’s own OAuth app, unless a test points GitHub at a stand-in (A1173)', () => {
    const config = (env: Record<string, string>, packaged = false) =>
      desktopConfig({ env, packaged, appPath: '/src/desktop' }).githubClientId;
    expect(config({}, true)).toBe(GITHUB_CLIENT_ID);
    expect(GITHUB_CLIENT_ID).toMatch(/^Ov23li[0-9A-Za-z]{14}$/);
    expect(config({})).toBe(GITHUB_CLIENT_ID);
    // A suite with a stand-in GitHub API never reaches the real github.com's sign-in.
    expect(config({ PENMOSS_TEST_GITHUB_API: 'http://127.0.0.1:8791' })).toBeNull();
    expect(
      config({
        PENMOSS_TEST_GITHUB_API: 'http://127.0.0.1:8791',
        PENMOSS_TEST_GITHUB_WEB: 'http://127.0.0.1:8791',
        PENMOSS_TEST_GITHUB_CLIENT_ID: 'Iv1.e2e0penmoss',
      }),
    ).toBe('Iv1.e2e0penmoss');
    // A packaged app takes neither from its environment.
    expect(
      config(
        { PENMOSS_TEST_GITHUB_API: 'http://127.0.0.1:8791', PENMOSS_TEST_GITHUB_CLIENT_ID: 'x' },
        true,
      ),
    ).toBe(GITHUB_CLIENT_ID);
  });

  it('finds the owner check in the app, and never takes another from a packaged app’s environment (T41, A504)', () => {
    const env = { PENMOSS_TEST_AUTH_HELPER: '/tmp/always-yes' };
    const packaged = (platform: NodeJS.Platform) =>
      desktopConfig({
        env,
        packaged: true,
        appPath: '/Applications/Penmoss.app/Contents/Resources/app.asar',
        resourcesPath: '/Applications/Penmoss.app/Contents/Resources',
        platform,
      }).authHelper;
    expect(packaged('darwin')).toBe('/Applications/Penmoss.app/Contents/Resources/auth/Penmoss');
    expect(packaged('linux')).toBeNull();
    const dev = (platform: NodeJS.Platform, vars: Record<string, string> = {}) =>
      desktopConfig({ env: vars, packaged: false, appPath: '/src/desktop', platform }).authHelper;
    expect(dev('darwin')).toBe('/src/desktop/dist/native/Penmoss');
    expect(dev('linux')).toBeNull();
    // The Playwright suite's stand-in, in an unpackaged build only.
    expect(dev('linux', env)).toBe('/tmp/always-yes');
  });

  it('accepts only bare http(s) origins', () => {
    expect(originOf('http://localhost:8787', 'X')).toBe('http://localhost:8787');
    expect(() => originOf('https://api.penmoss.app/api', 'X')).toThrow(/origin/);
    expect(() => originOf('file:///etc', 'X')).toThrow(/origin/);
  });
});

describe('deep links', () => {
  it('opens notes and the capture window', () => {
    expect(parseDeepLink(`penmoss://note/${ID}`)).toEqual({ kind: 'path', path: `/notes/${ID}` });
    expect(parseDeepLink(`penmoss://note/${ID.toLowerCase()}/`)).toEqual({
      kind: 'path',
      path: `/notes/${ID}`,
    });
    expect(parseDeepLink('penmoss://capture')).toEqual({ kind: 'capture' });
  });

  it('ignores anything else', () => {
    for (const link of [
      'penmoss://note/../../settings',
      'penmoss://note/not-an-id',
      `penmoss://note/${ID}/extra`,
      `https://app.penmoss.app/notes/${ID}`,
      'penmoss://settings/devices',
      'penmoss://note/%E0',
      // Android's sign-in callback (the Mac app owns the scheme too): its code never reaches a
      // page (re-review of PR #100, N-c).
      'penmoss://auth/callback?code=x&state=y',
      'not a url',
    ]) {
      expect(parseDeepLink(link)).toBeNull();
    }
  });

  it('finds the link among command-line arguments', () => {
    expect(deepLinkFromArgv(['/app', '--flag', `penmoss://note/${ID}`])).toBe(
      `penmoss://note/${ID}`,
    );
    expect(deepLinkFromArgv(['/app'])).toBeNull();
  });
});

describe('menu accelerators', () => {
  it('turns registry combinations into Electron accelerators', () => {
    expect(toAccelerator('Mod+Alt+N')).toBe('CommandOrControl+Alt+N');
    expect(toAccelerator('Mod+Ctrl+Shift+7')).toBe('CommandOrControl+Control+Shift+7');
    expect(toAccelerator('Mod+/')).toBe('CommandOrControl+/');
    expect(toAccelerator('Mod++')).toBe('CommandOrControl+Plus');
    expect(toAccelerator('Alt+Up')).toBe('Alt+Up');
    expect(toAccelerator('F2')).toBe('F2');
    expect(toAccelerator('Mod+Enter')).toBe('CommandOrControl+Return');
    expect(toAccelerator('Meta+K')).toBeNull();
    expect(toAccelerator('Mod+Ä')).toBeNull();
  });

  const menus: MenuModel[] = [
    { label: 'Penmoss', groups: [[{ id: 'app.settings', title: 'Settings', keys: ['Mod+,'] }]] },
    {
      label: 'File',
      groups: [
        [{ id: 'note.new', title: 'New note', keys: ['Mod+Alt+N'] }],
        [{ id: 'note.delete', title: 'Move to Trash', keys: [] }],
      ],
    },
    {
      label: 'Edit',
      groups: [
        [{ id: 'editor.undo', title: 'Undo', keys: ['Mod+Z'] }],
        [{ id: 'copy-markdown', title: 'Copy as Markdown', keys: ['Mod+Shift+C'] }],
      ],
    },
  ];

  it('surrounds the page’s command menus with the system’s own items on a Mac', () => {
    const chosen: Array<[string, string | null]> = [];
    const template = menuTemplate(menus, {
      platform: 'darwin',
      appName: 'Penmoss',
      devTools: false,
      onCommand: (id, accelerator) => chosen.push([id, accelerator]),
    });
    expect(template.map((menu) => menu.label ?? menu.role)).toEqual([
      'Penmoss',
      'File',
      'Edit',
      'View',
      'Window',
      'Help',
    ]);
    // The system's Window menu, which lists the open windows (role `window`).
    expect(template[4]!.role).toBe('window');
    const app = template[0]!.submenu as Electron.MenuItemConstructorOptions[];
    expect(app.map((item) => item.role ?? item.id ?? item.type)).toEqual([
      'about',
      'separator',
      'app.settings',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ]);
    const edit = template[2]!.submenu as Electron.MenuItemConstructorOptions[];
    expect(edit.map((item) => item.role ?? item.id ?? item.type)).toEqual([
      'editor.undo',
      'separator',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'selectAll',
      'separator',
      'copy-markdown',
    ]);
    const file = template[1]!.submenu as Electron.MenuItemConstructorOptions[];
    expect(file[0]).toMatchObject({
      id: 'note.new',
      label: 'New note',
      accelerator: 'CommandOrControl+Alt+N',
    });
    expect(file[2]).not.toHaveProperty('accelerator');
    // A click runs the command; a shortcut the menu took says so.
    type Click = (
      item: unknown,
      window: unknown,
      event?: { triggeredByAccelerator?: boolean },
    ) => void;
    (file[0]!.click as unknown as Click)(null, null, { triggeredByAccelerator: false });
    (file[0]!.click as unknown as Click)(null, null, { triggeredByAccelerator: true });
    (file[0]!.click as unknown as Click)(null, null);
    expect(chosen).toEqual([
      ['note.new', null],
      ['note.new', 'CommandOrControl+Alt+N'],
      ['note.new', null],
    ]);
  });

  // T45 (A712): Window → Penmoss shows the main window, also when only note windows are open.
  it('puts Penmoss in the Window menu, for the main window', () => {
    let shown = 0;
    for (const platform of ['darwin', 'linux'] as const) {
      const template = menuTemplate(menus, {
        platform,
        appName: 'Penmoss',
        devTools: false,
        onCommand: () => undefined,
        onShowMain: () => shown++,
      });
      const window = template.find((menu) => menu.label === 'Window')!
        .submenu as Electron.MenuItemConstructorOptions[];
      expect(window.map((item) => item.role ?? item.id ?? item.type)).toEqual(
        platform === 'darwin'
          ? ['minimize', 'zoom', 'separator', 'window.main', 'separator', 'front']
          : ['minimize', 'close', 'separator', 'window.main'],
      );
      const main = window.find((item) => item.id === 'window.main')!;
      expect(main.label).toBe('Penmoss');
      (main.click as unknown as () => void)();
    }
    expect(shown).toBe(2);
  });

  // T39 pass 2 (A526): what cannot run now is greyed out, as in any Mac app.
  it('greys out an item the page says cannot run now', () => {
    const template = menuTemplate(
      [
        {
          label: 'File',
          groups: [
            [
              { id: 'note.new', title: 'New note', keys: ['Mod+Alt+N'] },
              { id: 'note.delete', title: 'Move to Trash', keys: [], enabled: false },
            ],
          ],
        },
      ],
      { platform: 'darwin', appName: 'Penmoss', devTools: false, onCommand: () => undefined },
    );
    const file = template[1]!.submenu as Electron.MenuItemConstructorOptions[];
    expect(file.slice(0, 2).map((item) => [item.id, item.enabled])).toEqual([
      ['note.new', true],
      ['note.delete', false],
    ]);
  });

  it('puts Settings and Quit in File elsewhere, and development tools only in development', () => {
    const template = menuTemplate(menus, {
      platform: 'linux',
      appName: 'Penmoss',
      devTools: true,
      onCommand: () => undefined,
    });
    expect(template[0]!.label).toBe('File');
    const file = template[0]!.submenu as Electron.MenuItemConstructorOptions[];
    expect(file.map((item) => item.role ?? item.id ?? item.type).slice(-2)).toEqual([
      'app.settings',
      'quit',
    ]);
    const view = template.find((menu) => menu.label === 'View')!
      .submenu as Electron.MenuItemConstructorOptions[];
    expect(view.map((item) => item.role)).toContain('toggleDevTools');
  });
});

describe('the bundled app on app://penmoss', () => {
  const root = mkdtempSync(join(tmpdir(), 'penmoss-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Penmoss</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, '..', 'penmoss-secret.txt'), 'outside');
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, '..', 'penmoss-secret.txt'), { force: true });
  });
  const get = (url: string, method = 'GET') => serveAsset(root, new Request(url, { method }));

  it('never resolves a path outside the bundle', () => {
    expect(resolveAsset(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(resolveAsset(root, '/')).toBe(join(root, 'index.html'));
    expect(resolveAsset(root, '/../penmoss-secret.txt')).toBeNull();
    expect(resolveAsset(root, '/%2e%2e/penmoss-secret.txt')).toBeNull();
    expect(resolveAsset(root, '/assets/..%2f..%2fpenmoss-secret.txt')).toBeNull();
    expect(resolveAsset(root, '/a%00b')).toBeNull();
    expect(resolveAsset(root, '/%E0')).toBeNull();
    expect(resolveAsset(root, '/..\\penmoss-secret.txt')).toBeNull();
  });

  it('serves files with their types, app routes as index.html, and pages with the CSP', async () => {
    const script = await get('app://penmoss/assets/app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    expect(script.headers.get('content-security-policy')).toBeNull();

    const route = await get(`app://penmoss/notes/${ID}`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<title>Penmoss</title>');
    const csp = route.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    // Pages connect nowhere but the app itself (T59): git notebooks sync through main.
    expect(csp).toContain("connect-src 'self' blob:;");
    expect(csp).not.toMatch(/penmoss\.app|wss?:/);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('refuses missing files, other hosts and writes', async () => {
    expect((await get('app://penmoss/assets/missing.js')).status).toBe(404);
    expect((await get('app://other/index.html')).status).toBe(404);
    expect((await get('app://penmoss/', 'POST')).status).toBe(405);
    expect(await (await get('app://penmoss/', 'HEAD')).text()).toBe('');
  });
});

describe('links and navigation', () => {
  it('keeps the app on app://penmoss and sends only web and mail links outside', () => {
    expect(isAppUrl('app://penmoss/notes/x')).toBe(true);
    expect(isAppUrl('app://penmoss.evil/')).toBe(false);
    expect(isAppUrl('https://app.penmoss.app/')).toBe(false);
    expect(appPath(`app://penmoss/notes/${ID}?heading=Plan`)).toBe(`/notes/${ID}?heading=Plan`);
    expect(isExternalUrl('https://example.com')).toBe(true);
    expect(isExternalUrl('mailto:a@b.c')).toBe(true);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y', 'penmoss://x']) {
      expect(isExternalUrl(url)).toBe(false);
    }
  });
});

describe('window state', () => {
  const screen = [{ x: 0, y: 0, width: 1440, height: 900 }];

  it('restores a place a display still shows', () => {
    const saved = parseWindowState({ x: 100, y: 80, width: 1000, height: 700, maximized: true });
    expect(fitToDisplays(saved, screen)).toEqual({
      x: 100,
      y: 80,
      width: 1000,
      height: 700,
      maximized: true,
      fullScreen: false,
      keepOnTop: false,
    });
  });

  it('drops a place no display shows, and shrinks to fit', () => {
    const saved = parseWindowState({ x: 3000, y: 80, width: 2000, height: 1200 });
    expect(fitToDisplays(saved, screen)).toEqual({
      width: 1440,
      height: 900,
      maximized: false,
      fullScreen: false,
      keepOnTop: false,
    });
  });

  it('ignores malformed state', () => {
    expect(parseWindowState('nonsense')).toEqual(DEFAULT_WINDOW);
    expect(parseWindowState({ width: 'big', x: 1 })).toEqual(DEFAULT_WINDOW);
    expect(parseWindowState({ width: 10, height: 10 })).toMatchObject({ width: 480, height: 360 });
  });
});

describe('where focus goes when the capture window closes (T30, A904)', () => {
  it('hides the app only when it was in the background, or started on its own', () => {
    const base = {
      mac: true,
      focusedBefore: false,
      openedWhileStarting: false,
      startedOnItsOwn: false,
    };
    // The hotkey pressed in another app: back to that app.
    expect(afterCapture(base)).toBe('hide-app');
    // Pressed in a Penmoss window: back to it.
    expect(afterCapture({ ...base, focusedBefore: true })).toBe('focus-before');
    // Pressed while Ryan's own launch was starting: the main window he opened stays.
    expect(afterCapture({ ...base, openedWhileStarting: true })).toBe('focus-main');
    // A launch at login or in the background: hidden again, as before.
    expect(afterCapture({ ...base, openedWhileStarting: true, startedOnItsOwn: true })).toBe(
      'hide-app',
    );
    // Off a Mac there is no app to hide.
    expect(afterCapture({ ...base, mac: false })).toBe('nothing');
  });

  it('logs how each launch started, to check wasOpenedAtLogin on a Mac (A904)', () => {
    const at = new Date('2026-10-30T14:05:00Z');
    const first = launchLog('', { wasOpenedAtLogin: true, openAtLogin: true }, at);
    expect(first).toBe(
      '2026-10-30T14:05:00.000Z launch: wasOpenedAtLogin=true openAtLogin=true (A904)\n',
    );
    // Each launch adds a line; only the last 20 are kept.
    let log = first;
    for (let n = 0; n < 25; n += 1) log = launchLog(log, { wasOpenedAtLogin: false }, at);
    const lines = log.trimEnd().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toBe('2026-10-30T14:05:00.000Z launch: wasOpenedAtLogin=false (A904)');
  });
});

describe('the capture hotkey (T30)', () => {
  it('defaults to ⌃⌥⌘N on a Mac, and to a combination A90 allows elsewhere', () => {
    expect(defaultCaptureHotkey('darwin')).toBe('Control+Alt+Command+N');
    // Ctrl+Alt with a letter is AltGr off a Mac (A90), so the test default is Ctrl+Shift+Space.
    expect(defaultCaptureHotkey('linux')).toBe('Control+Shift+Space');
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(normaliseHotkey(defaultCaptureHotkey(platform), platform)).not.toHaveProperty('error');
    }
  });

  it('normalises what Ryan types, and refuses hotkeys that would take typing', () => {
    expect(normaliseHotkey('cmd+option+ctrl+n', 'darwin')).toEqual({
      accelerator: 'Command+Control+Alt+N',
    });
    expect(normaliseHotkey(' Control + Shift + Space ', 'linux')).toEqual({
      accelerator: 'Control+Shift+Space',
    });
    for (const bad of [
      'N',
      'Shift+N',
      'Alt+Shift+N',
      'Command+N+X',
      'Hyper+N',
      'Control+Shift+Ä',
      '',
    ]) {
      expect(normaliseHotkey(bad, 'darwin')).toHaveProperty('error');
    }
  });

  it('applies A90 too: never the clipboard, undo, find or text-editing keys, nor AltGr', () => {
    // A system-wide hotkey would take these from every app, not only Penmoss.
    for (const reserved of ['Command+Shift+Z', 'CommandOrControl+Shift+Z']) {
      expect(normaliseHotkey(reserved, 'darwin')).toMatchObject({ error: /keeps/ });
    }
    expect(normaliseHotkey('Control+Shift+Z', 'linux')).toMatchObject({ error: /keeps/ });
    // Ctrl+Alt+letter is AltGr on Windows-style layouts (Polish ń is AltGr+N).
    expect(normaliseHotkey('Control+Alt+N', 'linux')).toMatchObject({ error: /AltGr/ });
    expect(normaliseHotkey('Control+Alt+Shift+N', 'win32')).toMatchObject({ error: /AltGr/ });
    // ⌥ with ⌃ or ⌘ is fine on a Mac; function keys are fine anywhere.
    expect(normaliseHotkey('Control+Alt+N', 'darwin')).toEqual({ accelerator: 'Control+Alt+N' });
    expect(normaliseHotkey('Control+Alt+F7', 'linux')).toEqual({ accelerator: 'Control+Alt+F7' });
  });

  it('takes a change only from the Settings page, after a key press or click, a few a minute', () => {
    const gate = new HotkeyChangeGate();
    const settings = 'app://penmoss/settings/shortcuts';
    expect(gate.check({ url: 'app://penmoss/notes/x', gesture: true, now: 0 })).toMatch(/Settings/);
    expect(gate.check({ url: settings, gesture: false, now: 0 })).toMatch(/Settings/);
    expect(gate.check({ url: 'https://evil.example/settings', gesture: true, now: 0 })).toMatch(
      /Settings/,
    );
    for (let i = 0; i < HotkeyChangeGate.PER_MINUTE; i++) {
      expect(gate.check({ url: settings, gesture: true, now: i * 1000 })).toBeNull();
    }
    expect(gate.check({ url: settings, gesture: true, now: 30_000 })).toMatch(/Too many/);
    expect(gate.check({ url: settings, gesture: true, now: 61_000 })).toBeNull();
  });

  it('can be sure a registration holds only off a Mac', () => {
    // On macOS another app (or the system) can hold the keys although register() succeeds.
    expect(registrationCertain('darwin')).toBe(false);
    expect(registrationCertain('linux')).toBe(true);
  });
});

describe('what pages may ask of the main process (T29 review)', () => {
  const frame = (url: string) => ({ url });
  it('answers only the main frame of an app page', () => {
    const main = frame('app://penmoss/');
    expect(isAppFrame({ senderFrame: main, sender: { mainFrame: main } })).toBe(true);
    // A subframe, even one of the app's own pages, gets nothing.
    const sub = frame('app://penmoss/notes/x');
    expect(isAppFrame({ senderFrame: sub, sender: { mainFrame: main } })).toBe(false);
    // A main frame somewhere else (were it ever to navigate away) gets nothing.
    const away = frame('https://evil.example/');
    expect(isAppFrame({ senderFrame: away, sender: { mainFrame: away } })).toBe(false);
    expect(isAppFrame({ senderFrame: null, sender: { mainFrame: main } })).toBe(false);
  });

  it('writes the clipboard only just after a key press or click, or a menu command', () => {
    const gate = new ClipboardGate();
    expect(gate.allows({ gesture: false, now: 10_000 })).toBe(false);
    expect(gate.allows({ gesture: true, now: 10_000 })).toBe(true);
    gate.menuCommand(20_000);
    expect(gate.allows({ gesture: false, now: 20_500 })).toBe(true);
    expect(gate.allows({ gesture: false, now: 20_000 + ClipboardGate.MENU_MS + 1 })).toBe(false);
  });

  it('caps what a page may put in the menus', () => {
    const item = { id: 'note.new', title: 'New note', keys: ['Mod+N'] };
    expect(parseMenus([{ label: 'File', groups: [[item]] }])).toEqual([
      { label: 'File', groups: [[item]] },
    ]);
    const many = <T>(count: number, value: T) => Array.from({ length: count }, () => value);
    expect(parseMenus(many(MENU_LIMITS.menus + 1, { label: 'M', groups: [] }))).toBeNull();
    expect(
      parseMenus([{ label: 'File', groups: many(MENU_LIMITS.groups + 1, [item]) }]),
    ).toBeNull();
    expect(parseMenus([{ label: 'File', groups: [many(MENU_LIMITS.items + 1, item)] }])).toBeNull();
    expect(
      parseMenus(
        many(MENU_LIMITS.menus, { label: 'M', groups: many(MENU_LIMITS.groups, many(40, item)) }),
      ),
    ).toBeNull();
    expect(
      parseMenus([
        { label: 'File', groups: [[{ ...item, keys: many(MENU_LIMITS.keys + 1, 'Mod+N') }]] },
      ]),
    ).toBeNull();
    expect(parseMenus([{ label: 'File', groups: [[{ ...item, title: 7 }]] }])).toBeNull();
    // Greyed out is a boolean, and only false is kept.
    expect(parseMenus([{ label: 'File', groups: [[{ ...item, enabled: false }]] }])).toEqual([
      { label: 'File', groups: [[{ ...item, enabled: false }]] },
    ]);
    expect(parseMenus([{ label: 'File', groups: [[{ ...item, enabled: true }]] }])).toEqual([
      { label: 'File', groups: [[item]] },
    ]);
    expect(parseMenus([{ label: 'File', groups: [[{ ...item, enabled: 'no' }]] }])).toBeNull();
  });
});

interface BuilderConfig {
  publish: unknown;
  buildVersion?: string;
  mac: { identity?: string | null; sign?: (opts: Record<string, unknown>) => Promise<void> };
}

describe('the package configuration: update feed and signing (T29, A225, A403)', () => {
  const require = createRequire(import.meta.url);
  const configPath = require.resolve('../../electron-builder.config.cjs');
  /** electron-builder's configuration as it reads with `env` (it reads the environment on load). */
  function builderConfig(env: Record<string, string>): BuilderConfig {
    const saved = { ...process.env };
    for (const name of ['CSC_LINK', 'CSC_NAME', 'PENMOSS_BUILD_NUMBER', 'PENMOSS_APP_VERSION']) {
      delete process.env[name];
    }
    Object.assign(process.env, env);
    delete require.cache[configPath];
    try {
      return require(configPath) as BuilderConfig;
    } finally {
      process.env = saved;
    }
  }

  it('updates from GitHub Releases on its channel, and only signed builds (P6, A1188)', () => {
    const releases = 'https://github.com/htxryan/penmoss/releases';
    const latest = [{ provider: 'generic', url: `${releases}/latest/download`, channel: 'latest' }];
    const alpha = [{ provider: 'generic', url: `${releases}/download/alpha`, channel: 'alpha' }];
    expect(builderConfig({ CSC_NAME: 'Dev' }).publish).toEqual(latest);
    expect(builderConfig({ CSC_LINK: 'cert.p12', PENMOSS_APP_VERSION: '0.2.0' }).publish).toEqual(
      latest,
    );
    expect(
      builderConfig({ CSC_LINK: 'cert.p12', PENMOSS_APP_VERSION: '0.2.0-rc.1' }).publish,
    ).toEqual(latest);
    expect(
      builderConfig({ CSC_LINK: 'cert.p12', PENMOSS_APP_VERSION: '0.2.1-alpha.1510' }).publish,
    ).toEqual(alpha);
    expect(builderConfig({}).publish).toBeNull();
    expect(builderConfig({ PENMOSS_APP_VERSION: '0.2.1-alpha.1510' }).publish).toBeNull();
  });

  it('takes the version CI gives it (P5): alpha builds keep build names, stable ones version names (P2)', () => {
    type Built = BuilderConfig & {
      extraMetadata?: { version?: string };
      mac: { artifactName?: string };
    };
    const alpha = builderConfig({
      PENMOSS_BUILD_NUMBER: '1510',
      PENMOSS_APP_VERSION: '0.2.0-alpha.1510',
    }) as Built;
    expect(alpha.extraMetadata).toEqual({ version: '0.2.0-alpha.1510' });
    expect(alpha.buildVersion).toBe('1510');
    expect(alpha.mac.artifactName).toBe('penmoss-mac-1510.${ext}');
    const stable = builderConfig({
      PENMOSS_BUILD_NUMBER: '1520',
      PENMOSS_APP_VERSION: '0.2.0',
    }) as Built;
    expect(stable.extraMetadata).toEqual({ version: '0.2.0' });
    expect(stable.mac.artifactName).toBe('penmoss-mac-0.2.0.${ext}');
    expect(() => builderConfig({ PENMOSS_APP_VERSION: '0.2' })).toThrow(/not a version/);
    expect(() => builderConfig({ PENMOSS_APP_VERSION: '1.0.0; rm' })).toThrow(/not a version/);
  });

  it('versions each CI build 0.1.<run> and names its zip for the build (A1015)', () => {
    const built = builderConfig({ PENMOSS_BUILD_NUMBER: '412' }) as BuilderConfig & {
      extraMetadata?: { version?: string };
      mac: { artifactName?: string };
    };
    expect(built.extraMetadata).toEqual({ version: '0.1.412' });
    // electron-builder's own macro: penmoss-mac-412.zip and penmoss-mac-412.dmg.
    expect(built.mac.artifactName).toBe('penmoss-mac-412.${ext}');
    const local = builderConfig({}) as typeof built;
    expect(local.extraMetadata).toBeUndefined();
    expect(local.mac.artifactName).toBeUndefined();
    expect(() => builderConfig({ PENMOSS_BUILD_NUMBER: '1; rm' })).not.toThrow();
    expect(builderConfig({ PENMOSS_BUILD_NUMBER: '1; rm' }).buildVersion).toBeUndefined();
  });

  it('signs ad hoc without a certificate, never with an identity from the keychain (A403)', async () => {
    const signed = builderConfig({ CSC_LINK: 'cert.p12' }).mac;
    expect(signed.identity).toBeUndefined();
    expect(signed.sign).toBeUndefined();

    const { mac } = builderConfig({});
    expect(mac.identity).toBe('-');
    // electron-builder may hand the hook an identity it matched in the keychain: it must not
    // reach codesign.
    const osxSign = require.resolve('@electron/osx-sign');
    const calls: Record<string, unknown>[] = [];
    require.cache[osxSign] = {
      exports: { signAsync: (opts: Record<string, unknown>) => void calls.push(opts) },
    } as unknown as NodeJS.Module;
    try {
      await mac.sign?.({
        app: '/out/Penmoss.app',
        identity: 'ABCDEF Developer ID Application: Someone-Else (TEAM)',
        keychain: '/Users/me/Library/Keychains/login.keychain-db',
        optionsForFile: () => ({ entitlements: 'entitlements.plist', hardenedRuntime: true }),
      });
    } finally {
      delete require.cache[osxSign];
    }
    expect(calls).toHaveLength(1);
    const [opts] = calls as [{ optionsForFile: (file: string) => unknown }];
    expect(opts).toMatchObject({
      app: '/out/Penmoss.app',
      identity: '-',
      identityValidation: false,
      keychain: undefined,
    });
    expect(opts.optionsForFile('/out/Penmoss.app')).toEqual({
      entitlements: 'entitlements.plist',
      hardenedRuntime: true,
      timestamp: 'none',
    });
  });

  it('ships the owner check in a Mac app, built before packing (T41, A504)', async () => {
    const config = builderConfig({}) as BuilderConfig & {
      beforePack: (context: { electronPlatformName: string }) => Promise<void>;
      mac: { extraResources?: unknown };
    };
    expect(config.mac.extraResources).toEqual([
      { from: 'dist/native/Penmoss', to: 'auth/Penmoss' },
    ]);
    // Nothing to build for another platform's package.
    await expect(config.beforePack({ electronPlatformName: 'linux' })).resolves.toBeUndefined();
    if (process.platform !== 'darwin') {
      // A Mac package built where swiftc cannot run fails, rather than ship without the check.
      await expect(config.beforePack({ electronPlatformName: 'darwin' })).rejects.toThrow(
        /only on macOS/,
      );
    }
  });

  it('numbers the build with the CI run (A403)', () => {
    expect(builderConfig({ PENMOSS_BUILD_NUMBER: '123' }).buildVersion).toBe('123');
    expect(builderConfig({}).buildVersion).toBeUndefined();
  });
});

describe('permissions a page may have', () => {
  it('writes to the clipboard, keeps its stores under low storage and shows an image full screen, and nothing else (A886, A948)', () => {
    expect([...ALLOWED_PERMISSIONS].sort()).toEqual([
      'clipboard-sanitized-write',
      'fullscreen',
      'persistent-storage',
    ]);
    for (const refused of [
      'geolocation',
      'notifications',
      'media',
      'clipboard-read',
      'openExternal',
    ]) {
      expect(ALLOWED_PERMISSIONS.has(refused)).toBe(false);
    }
  });
});
