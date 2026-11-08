import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CHANNELS } from '../../src/channels';
import {
  body,
  launch,
  removeDataDirs,
  runInMainPage,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// T51 item 17 (A945, A946): the menu bar icon. On by default (T53 item 6); Settings → Display
// turns it off for this Mac, and it stays off after a restart. Its menu holds Quick Capture (with the hotkey),
// Open Today's Journal and the Quick Access notes the main window's page sends as they change,
// each opening in the main window. Under xvfb the app stands in for a Mac (A725) but shows no
// icon: these read and click the menu through the main process's hooks. The icon itself, its
// template image in a light and a dark menu bar, is checked by hand on a Mac.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

type MenuEntry = { id?: string; label?: string; accelerator?: string } | '-';

/** The main process's test hooks (main.ts). */
interface Hooks {
  penmossDesktop: {
    mainWindow(): Electron.BrowserWindow | null;
    hotkey(): { accelerator: string; registered: boolean };
    trayMenu(): MenuEntry[] | null;
    trayShown(): boolean;
    clickTrayItem(id: string): boolean;
  };
}

async function start(userData?: string): Promise<Launched> {
  const launched = await launch({ macWindow: true, ...(userData ? { userData } : {}) });
  opened.push(launched);
  return launched;
}

const trayMenu = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.trayMenu());

const clickTray = (app: ElectronApplication, id: string) =>
  app.evaluate(
    (_electron, itemId) => (globalThis as unknown as Hooks).penmossDesktop.clickTrayItem(itemId),
    id,
  );

/** Opens an in-app path in the main window, as a deep link does. */
const openPath = (app: ElectronApplication, path: string) =>
  app.evaluate(
    (_electron, [channel, target]) =>
      (globalThis as unknown as Hooks).penmossDesktop
        .mainWindow()!
        .webContents.send(channel, target),
    [CHANNELS.openPath, path] as const,
  );

/** Runs a page command in the main window, as its menu item would. */
const runCommand = (app: ElectronApplication, id: string) =>
  app.evaluate(
    (_electron, [channel, command]) =>
      (globalThis as unknown as Hooks).penmossDesktop
        .mainWindow()!
        .webContents.send(channel, { id: command, accelerator: null }),
    [CHANNELS.menuCommand, id] as const,
  );

async function newNote(page: Page, title: string, text: string): Promise<string> {
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

test('the menu bar icon: on by default, off and on from Settings → Display, its menu lists Quick Access and opens notes', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  await expect.poll(() => trayMenu(app)).not.toBeNull();

  // Settings → Display → Show Penmoss in the Menu Bar: on, this Mac's own.
  await openPath(app, '/settings/display');
  const setting = page.getByTestId('menu-bar-icon');
  await expect(setting).toBeChecked();
  await expect(setting).toBeEnabled();
  await setting.uncheck();
  await expect.poll(() => trayMenu(app)).toBeNull();
  await setting.check();
  await expect(setting).toBeChecked();
  const { accelerator, registered } = await app.evaluate(() =>
    (globalThis as unknown as Hooks).penmossDesktop.hotkey(),
  );
  // Pins may follow the first separator: only the fixed items.
  await expect
    .poll(async () => (await trayMenu(app))?.slice(0, 3))
    .toEqual([
      {
        id: 'tray.capture',
        label: 'Quick Capture',
        ...(registered ? { accelerator } : {}),
      },
      { id: 'tray.today', label: "Open Today's Journal" },
      '-',
    ]);
  expect((await trayMenu(app))?.at(-1)).toEqual({ id: 'tray.open', label: 'Open Penmoss' });
  // The icon itself only on a Mac; the suite keeps the menu.
  expect(
    await app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.trayShown()),
  ).toBe(mac);

  // Pinned notes join the menu in pin order, by title; a new title follows.
  await openPath(app, '/');
  const title = `Pinned ${RUN}`;
  const id = await newNote(page, title, `Reach me from the menu bar ${RUN}.`);
  await runCommand(app, 'note.pinQuickAccess');
  await expect
    .poll(async () => (await trayMenu(app))?.find((item) => item !== '-' && item.id?.endsWith(id)))
    .toEqual({ id: `tray.note.${id}`, label: title });
  const titleField = page.getByTestId('note-title');
  await titleField.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' renamed');
  await expect
    .poll(async () => (await trayMenu(app))?.find((item) => item !== '-' && item.id?.endsWith(id)))
    .toEqual({ id: `tray.note.${id}`, label: `${title} renamed` });
  expect((await trayMenu(app))?.at(-2)).toBe('-');

  // A pinned note opens in the main window, from wherever it was.
  await openPath(app, '/settings/display');
  await expect(page).toHaveURL(/\/settings\/display$/);
  expect(await clickTray(app, `tray.note.${id}`)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
  await expect(page.getByTestId('note-title')).toHaveValue(`${title} renamed`);

  // Open Today's Journal: today's note in the main window.
  expect(await clickTray(app, 'tray.today')).toBe(true);
  await expect(page).toHaveURL(ULID);
  await expect(page).not.toHaveURL(new RegExp(`/notes/${id}$`));

  // Unpinned: the menu loses it.
  await clickTray(app, `tray.note.${id}`);
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
  await runCommand(app, 'note.pinQuickAccess');
  await expect
    .poll(async () => (await trayMenu(app))?.some((item) => item !== '-' && item.id?.endsWith(id)))
    .toBe(false);

  // Off again: no icon, no menu.
  await openPath(app, '/settings/display');
  await setting.uncheck();
  await expect.poll(() => trayMenu(app)).toBeNull();
});

test('the menu bar icon stays off after a restart, and is this Mac’s alone', async () => {
  const first = await start();
  await gitNotebook(first);
  await openPath(first.app, '/settings/display');
  await first.page.getByTestId('menu-bar-icon').uncheck();
  await expect.poll(() => trayMenu(first.app)).toBeNull();
  opened.splice(opened.indexOf(first), 1);
  await first.app.close();

  const again = await start(first.userData);
  // The hook sends straight to the page, past main's inbox (A945): only once the page listens.
  await expect(again.page.locator('button[data-command="note.new"]')).toBeVisible();
  expect(await trayMenu(again.app)).toBeNull();
  await openPath(again.app, '/settings/display');
  await expect(again.page.getByTestId('menu-bar-icon')).not.toBeChecked();

  // A script in the page, with no key press or click behind it, cannot change it. Playwright's
  // own calls in the page count as a person's for a few seconds (transient activation): the
  // script runs after that has passed.
  await expect
    .poll(() => runInMainPage(again.app, 'navigator.userActivation.isActive', false), {
      timeout: 15_000,
    })
    .toBe(false);
  const refused: unknown = await again.app.evaluate(
    () =>
      (globalThis as unknown as Hooks).penmossDesktop
        .mainWindow()!
        .webContents.executeJavaScript(
          'window.penmossDesktop.menuBar.setShown(true)',
          false,
        ) as Promise<unknown>,
  );
  expect(refused).toBeNull();
  expect(await trayMenu(again.app)).toBeNull();
});
