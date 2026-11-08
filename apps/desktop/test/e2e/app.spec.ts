import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { NORD } from '@penmoss/ui/theme';
// The page's `window.penmossDesktop` (types only).
import type {} from '../../../web/src/desktop/bridge';
import {
  body,
  gitNotebook,
  launch,
  mainBounds,
  removeDataDirs,
  repositoryFile,
  repositoryFiles,
  runInMainPage,
  ULID,
  type Launched,
} from './support';

// T29: the Mac app's shell, under Electron on Linux (xvfb) as the CI stand-in for the Mac. Notes
// live in a git notebook on a bare repository here (T59: there is no Penmoss server).

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  const launched = await launch(options);
  opened.push(launched);
  return launched;
}

async function quit(launched: Launched): Promise<void> {
  opened.splice(opened.indexOf(launched), 1);
  await launched.app.close();
}

async function newNote(launched: Launched, title: string, text: string): Promise<string> {
  const { page } = launched;
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text);
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

const isEditable = async (app: Launched) =>
  (await app.page.getByTestId('note-view').getAttribute('data-ready')) === 'true' &&
  (await body(app.page).getAttribute('contenteditable')) === 'true';

test('edits a note in a git notebook, opens it again with the network blocked, and pushes it', async () => {
  const tag = `d${Date.now().toString(36)}`;
  const first = await start();
  // The bundle comes from app://, under the app's CSP, which connects nowhere else (T59).
  expect(first.page.url()).toBe('app://penmoss/');
  const csp = await first.page.evaluate(async () =>
    (await fetch(location.href)).headers.get('content-security-policy'),
  );
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'self' blob:;");
  expect(csp).not.toMatch(/localhost|penmoss\.app|wss?:/);
  // No Node in the page; only the bridge. (T45: `stored` tells the other windows, A711. T49:
  // `feedback` hands the page the window's capture, A798. T50: `git` runs a git notebook's git in
  // the main process, which checks each call itself, A853. T57: `githubToken`, A1012. T59: no
  // session, admin requests or open-in-browser: there is no server.)
  expect(
    await first.page.evaluate(() => [
      typeof (globalThis as { require?: unknown }).require,
      typeof (globalThis as { process?: unknown }).process,
      Object.keys(window.penmossDesktop ?? {}).sort(),
    ]),
  ).toEqual([
    'undefined',
    'undefined',
    [
      'capture',
      'clipboard',
      'feedback',
      'git',
      'githubToken',
      // The Mac's window behaviours (A720–A725) and its menu bar icon (T51, A945): a Mac only.
      ...(mac ? ['macWindow'] : []),
      // Search by meaning's service, through main's named calls (T76, A1152).
      'meaning',
      'menu',
      ...(mac ? ['menuBar'] : []),
      'onBeforeClose',
      'onOpenPath',
      'onStoreChanged',
      'platform',
      'stored',
      'theme',
      // Auto-Update's switch and Install and Restart (T64, A1112).
      'updates',
      'version',
      'window',
    ],
  ]);

  const { remote } = await gitNotebook(first);
  const title = `Desktop ${tag}`;
  const id = await newNote(first, title, `typed in the Mac app ${tag}`);
  // Quitting pushes it (the closing sync, A825).
  await quit(first);
  const file = () => repositoryFiles(remote).find((path) => path.endsWith(`${title}.md`));
  await expect.poll(file, { timeout: 20_000 }).toBeTruthy();
  expect(repositoryFile(remote, file()!)).toContain(`typed in the Mac app ${tag}`);

  // Relaunch with no network at all: the note is there and takes typing.
  const launchedAt = Date.now();
  const offline = await start({
    userData: first.userData,
    offline: true,
    args: [`penmoss://note/${id}`],
  });
  await expect(offline.page).toHaveURL(`app://penmoss/notes/${id}`);
  await expect.poll(() => isEditable(offline), { timeout: 20_000, intervals: [25] }).toBe(true);
  const coldStart = Date.now() - launchedAt;
  test
    .info()
    .annotations.push({ type: 'cold start to an editable note (ms)', description: `${coldStart}` });
  console.log(`[desktop] cold start to an editable note, offline: ${coldStart} ms`);
  await expect(offline.page.getByTestId('note-title')).toHaveValue(`Desktop ${tag}`);
  await expect(body(offline.page)).toContainText(`typed in the Mac app ${tag}`);
  await body(offline.page).click();
  await offline.page.keyboard.press('ControlOrMeta+End');
  await offline.page.keyboard.type(` and offline ${tag}`);
  await expect(body(offline.page)).toContainText(`and offline ${tag}`);
  // No sign-in anywhere (T59).
  await expect(offline.page.getByTestId('sign-in-banner')).toHaveCount(0);
  expect(offline.errors).toEqual([]);
  // The page has no network, but main's git does: quitting pushes the edit.
  await quit(offline);
  await expect
    .poll(() => repositoryFile(remote, file()!), { timeout: 30_000 })
    .toContain(`and offline ${tag}`);
});

test('quitting straight after typing keeps the last keystrokes', async () => {
  const tag = `k${Date.now().toString(36)}`;
  const first = await start();
  await gitNotebook(first);
  const id = await newNote(first, `Quit ${tag}`, `first words ${tag}`);
  await first.page.keyboard.type(` and the very last ${tag}`);
  // ⌘Q at once, before any debounce has stored the last keys: the app stores them first.
  await quit(first);
  const again = await start({
    userData: first.userData,
    offline: true,
    args: [`penmoss://note/${id}`],
  });
  await expect(again.page).toHaveURL(`app://penmoss/notes/${id}`);
  await expect.poll(() => isEditable(again), { timeout: 20_000 }).toBe(true);
  await expect(body(again.page)).toContainText(`first words ${tag} and the very last ${tag}`);
});

test('keeps the window size and place between launches', async () => {
  const first = await start();
  await mainBounds(first.app, { x: 40, y: 30, width: 900, height: 640 });
  await first.page.waitForTimeout(600); // The state is saved 400 ms after the last move.
  await quit(first);
  const second = await start({ userData: first.userData });
  const bounds = await mainBounds(second.app);
  expect(bounds).toMatchObject({ width: 900, height: 640 });
});

/** The clipboard's one entry, every type it carries as text. */
function clipboardEntry(app: ElectronApplication): Promise<Record<string, string>> {
  return app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read();
    const out: Record<string, string> = {};
    for (const type of item?.types ?? []) {
      const value = await item!.getType(type);
      if (value instanceof Blob) out[type] = await value.text();
    }
    return out;
  });
}

type MenuDump = Array<{
  label: string;
  items: Array<{ id: string; label: string; accelerator: string; role: string }>;
}>;

async function menus(app: ElectronApplication): Promise<MenuDump> {
  return app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((top) => ({
      label: top.label,
      items: (top.submenu?.items ?? [])
        .filter((item) => item.type !== 'separator')
        .map((item) => ({
          id: item.id ?? '',
          label: item.label,
          accelerator: String(item.accelerator ?? ''),
          role: item.role ?? '',
        })),
    })),
  );
}

test('builds its menus from the command registry, with each command’s shortcut', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  await expect.poll(async () => (await menus(app)).map((menu) => menu.label)).toContain('Format');
  const all = await menus(app);
  const items = all.flatMap((menu) => menu.items);
  // Every item is a command (or one of the system's own roles: cut, copy, quit…).
  const commandItems = items.filter((item) => !item.role);
  expect(commandItems.length).toBeGreaterThan(40);
  for (const item of commandItems) expect(item.id).toMatch(/^[a-z][\w.-]+$/);
  const byId = new Map(commandItems.map((item) => [item.id, item]));
  expect(byId.get('note.new')).toMatchObject({
    label: 'New Note',
    accelerator: mac ? 'CommandOrControl+Alt+N' : 'Alt+N',
  });
  expect(byId.get('app.capture')).toMatchObject({
    label: 'Quick Capture…',
    accelerator: 'CommandOrControl+Shift+K',
  });
  expect(byId.get('editor.bold')).toMatchObject({ accelerator: 'CommandOrControl+B' });
  expect(byId.get('copy-markdown')).toMatchObject({ accelerator: 'CommandOrControl+Shift+C' });
  expect(byId.get('journal.today')).toMatchObject({ accelerator: 'CommandOrControl+D' });
  expect(all.find((menu) => menu.label === 'Edit')?.items.map((item) => item.role)).toEqual(
    expect.arrayContaining(['cut', 'copy', 'paste', 'selectall']),
  );

  // Choosing an item runs its command.
  await app.evaluate(({ Menu }) => {
    (
      Menu.getApplicationMenu()?.getMenuItemById('app.settings') as unknown as { click(): void }
    ).click();
  });
  await expect(page).toHaveURL(/\/settings/);

  // The shortcut itself runs the command once (not again through the menu).
  await page.evaluate(() => window.history.back());
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  const created = page.url();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(created);
  expect(launched.errors).toEqual([]);
});

test('opens penmoss://note links in the running app', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  const id = await newNote(launched, `Linked ${Date.now().toString(36)}`, 'deep link target');
  await page.evaluate(() => window.history.pushState(null, '', '/'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await expect(page).toHaveURL('app://penmoss/');
  // macOS delivers links as open-url; Linux and Windows as a second instance's arguments.
  await app.evaluate(({ app: electron }, link) => {
    electron.emit('open-url', { preventDefault: () => undefined }, link);
  }, `penmoss://note/${id}`);
  await expect(page).toHaveURL(`app://penmoss/notes/${id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  // Anything else is ignored.
  await app.evaluate(({ app: electron }) => {
    electron.emit('open-url', { preventDefault: () => undefined }, 'penmoss://note/../../etc');
    electron.emit('open-url', { preventDefault: () => undefined }, 'https://example.com/');
  });
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(`app://penmoss/notes/${id}`);

  // A link to an id no note has says so, and makes no note (B12).
  const unknown = '01M5ZZZZZZZZZZZZZZZZZZZZZZ';
  await app.evaluate(({ app: electron }, link) => {
    electron.emit('open-url', { preventDefault: () => undefined }, link);
  }, `penmoss://note/${unknown}`);
  await expect(page).toHaveURL(`app://penmoss/notes/${unknown}`);
  await expect(page.getByTestId('note-not-found')).toContainText('Note not found');
  await expect(page.getByTestId('note-view')).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.locator(`[data-note-id="${unknown}"]`)).toHaveCount(0);
  expect(launched.errors).toEqual([]);
});

test('reopens the last note on launch, and Settings goes back to it (B13)', async () => {
  const first = await start();
  await gitNotebook(first);
  const id = await newNote(first, `Last ${Date.now().toString(36)}`, 'reopened on launch');
  await quit(first);
  const again = await start({ userData: first.userData });
  await expect(again.page).toHaveURL(`app://penmoss/notes/${id}`);
  await expect(again.page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  // "← Notes" in Settings goes back to the note, not the empty home page.
  await again.page.keyboard.press('ControlOrMeta+Comma');
  await expect(again.page).toHaveURL(/\/settings/);
  await again.page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(again.page).toHaveURL(`app://penmoss/notes/${id}`);
  expect(again.errors).toEqual([]);
});

test('a page script alone cannot write the clipboard: it needs a key press, click or menu command', async () => {
  const launched = await start();
  const { app } = launched;
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  // Run in the page as a script would, with no user activation (executeJavaScript, no gesture).
  const write = (gesture: boolean) =>
    runInMainPage(app, 'window.penmossDesktop.clipboard.write({ text: "planted" })', gesture);
  expect(await write(false)).toBe(false);
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('before');
  // With a user's key press or click behind it, the same call writes.
  expect(await write(true)).toBe(true);
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('planted');
});

test('copies a note as rich text with HTML, plain text and markdown in one clipboard entry', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  await newNote(launched, 'Clipboard', '');
  await page.keyboard.type('Some **bold** words');
  await expect(body(page).locator('strong')).toHaveText('bold');
  await app.evaluate(({ clipboard }) => clipboard.clear());
  // Copy as rich text from the menu (the command T15 registers), with nothing selected:
  // the whole note. The page sends the menus again as the note opens: once they have it.
  await expect
    .poll(() =>
      app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('copy-rich-text') != null,
      ),
    )
    .toBe(true);
  await app.evaluate(({ Menu }) => {
    (
      Menu.getApplicationMenu()?.getMenuItemById('copy-rich-text') as unknown as { click(): void }
    ).click();
  });
  await expect
    .poll(async () => (await clipboardEntry(app))['text/html'] ?? '')
    .toContain('<strong>bold</strong>');
  const entry = await clipboardEntry(app);
  expect(entry['text/plain']).toBe('Some bold words');
  // The markdown under the platform's own type: a Mac's is net.daringfireball.markdown.
  const markdownType = `electron application/osclipboard;format="${mac ? 'net.daringfireball.markdown' : 'text/markdown'}"`;
  expect(entry[markdownType]).toContain('Some **bold** words');
  // Copy as Markdown: the markdown as plain text too, and no HTML.
  await app.evaluate(({ Menu }) => {
    (
      Menu.getApplicationMenu()?.getMenuItemById('copy-markdown') as unknown as { click(): void }
    ).click();
  });
  await expect
    .poll(async () => (await clipboardEntry(app))['text/plain'] ?? '')
    .toContain('Some **bold** words');
  expect((await clipboardEntry(app))['text/html']).toBeUndefined();
  await expect(page.getByTestId('copy-status')).toBeVisible();
  expect(launched.errors).toEqual([]);
});

test('opens outside links in the browser, never in the app', async () => {
  const launched = await start();
  const { app, page } = launched;
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedUrls: opened });
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
  await page.evaluate(() => {
    window.open('https://example.com/a', '_blank');
    window.location.href = 'https://example.com/b';
  });
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls))
    .toEqual(['https://example.com/a', 'https://example.com/b']);
  expect(page.url()).toBe('app://penmoss/');
  for (const window of app.windows()) expect(window.url()).toMatch(/^app:\/\/penmoss\//);
  // file: and javascript: links go nowhere.
  await page.evaluate(() => window.open('file:///etc/passwd'));
  await page.waitForTimeout(200);
  expect(
    await app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls),
  ).toHaveLength(2);
});

test('paints its windows in the theme’s background, and opens in it next time (T28)', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  const backgrounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.getBackgroundColor().toLowerCase()),
    );
  await page.goto('app://penmoss/settings/appearance');
  const settings = page.getByTestId('appearance-settings');
  try {
    await settings.locator('label.theme-card[data-theme-id="nord"]').click();
    await settings.getByTestId('theme-mode').getByText('Dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    // The main window and the capture window behind it.
    await expect.poll(backgrounds).toEqual([NORD.dark.bg, NORD.dark.bg]);
    // The title bar, menus and dialogs take the mode too.
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
    // Kept for the next launch once changes pause.
    const stored = () => {
      try {
        return (
          JSON.parse(readFileSync(join(launched.userData, 'preferences.json'), 'utf8')) as {
            windowTheme?: unknown;
          }
        ).windowTheme;
      } catch {
        return undefined;
      }
    };
    await expect.poll(stored).toEqual({ light: NORD.light.bg, dark: NORD.dark.bg, mode: 'dark' });
    await settings.getByTestId('theme-mode').getByText('Light').click();
    await expect.poll(backgrounds).toEqual([NORD.light.bg, NORD.light.bg]);
    // A page script cannot paint the window in anything but a colour.
    await runInMainPage(
      app,
      'window.penmossDesktop.theme.set({ light: "url(x)", dark: "#000000", mode: "dark" })',
      false,
    );
    await page.waitForTimeout(200);
    expect(await backgrounds()).toEqual([NORD.light.bg, NORD.light.bg]);
  } finally {
    // Put Penmoss and System back, as the next test expects.
    await settings.locator('label.theme-card[data-theme-id="penmoss"]').click();
    await settings.getByTestId('theme-mode').getByText('System').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'penmoss');
  }
  expect(launched.errors).toEqual([]);
});
