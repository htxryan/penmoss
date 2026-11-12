import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  body,
  gitNotebook,
  launch,
  mainBounds,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-67 (A1331, amends A712): the Dock icon brings back the window minimized last when no
// Penmoss window is visible, even with the main window closed; with one visible and the main
// window closed, it makes the main window as before. The Dock click is the app's `activate`
// event, as macOS sends it. Mac only: xvfb on Linux has no window manager to minimize into and
// no Dock (A1331).

const mac = process.platform === 'darwin';
test.skip(!mac, 'Minimizing and the Dock are macOS’s (A1331)');

const NEW_NOTE = 'Meta+Alt+KeyN';
const RUN = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const WINDOW = /^app:\/\/penmoss\/window\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** The main process's test hooks (main.ts). */
interface Hooks {
  penmossDesktop: {
    mainWindow(): Electron.BrowserWindow | null;
    noteWindows(): Electron.BrowserWindow[];
    activeWindow(): Electron.BrowserWindow | null;
  };
}

type Which = 'main' | 'note';

async function start(): Promise<Launched> {
  const launched = await launch();
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1100, height: 760 });
  return launched;
}

/** Opens a note in a window of its own (File → Open in New Window) and returns its page. */
async function noteWindow(launched: Launched): Promise<Page> {
  const { app, page } = launched;
  await gitNotebook(launched);
  const title = `Dock ${RUN}`;
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`Minimized into the Dock ${RUN}.`);
  await expect(body(page)).toContainText(`Minimized into the Dock ${RUN}.`);
  const [window] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('note.openInNewWindow');
      (item as unknown as { click(): void }).click();
    }),
  ]);
  await expect(window).toHaveURL(WINDOW);
  await expect(window.getByTestId('note-title')).toHaveValue(title);
  return window;
}

/** Minimizes a window, as the yellow button or ⌘M does, and waits until it is. */
async function minimize(app: ElectronApplication, which: Which): Promise<void> {
  await app.evaluate((_electron, target) => {
    const hooks = (globalThis as unknown as Hooks).penmossDesktop;
    const window = target === 'main' ? hooks.mainWindow() : hooks.noteWindows()[0];
    window!.minimize();
  }, which);
  await expect.poll(() => state(app, which)).toMatchObject({ minimized: true });
}

/** A click on the Dock icon: macOS's `activate`, saying whether a window is visible. */
const clickDock = (app: ElectronApplication, hasVisibleWindows: boolean) =>
  app.evaluate(({ app: electronApp }, visible) => {
    electronApp.emit('activate', { preventDefault: () => undefined }, visible);
  }, hasVisibleWindows);

/** A window's state: null when it is not open. */
const state = (app: ElectronApplication, which: Which) =>
  app.evaluate((_electron, target) => {
    const hooks = (globalThis as unknown as Hooks).penmossDesktop;
    const window = target === 'main' ? hooks.mainWindow() : hooks.noteWindows()[0];
    if (!window) return null;
    return {
      minimized: window.isMinimized(),
      visible: window.isVisible() && !window.isMinimized(),
      active: hooks.activeWindow() === window,
    };
  }, which);

const noteWindowCount = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.noteWindows().length);

async function closeMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.close());
  await expect
    .poll(() => state(app, 'main'), { timeout: 30_000 }) // Closing waits for git (A825).
    .toBeNull();
}

test('AC1: the Dock icon brings back the minimized main window', async () => {
  const { app, page, errors } = await start();
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await minimize(app, 'main');
  await page.waitForTimeout(1500); // Ryan sees the window gone into the Dock.

  await clickDock(app, false);
  await expect
    .poll(() => state(app, 'main'))
    .toEqual({ minimized: false, visible: true, active: true });
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.waitForTimeout(2000);
  expect(errors).toEqual([]);
});

test('AC2: with both minimized, the Dock icon brings back only the window minimized last', async () => {
  const launched = await start();
  const { app } = launched;
  const note = await noteWindow(launched);
  await minimize(app, 'main');
  await minimize(app, 'note');
  await note.waitForTimeout(1000);

  await clickDock(app, false);
  await expect
    .poll(() => state(app, 'note'))
    .toEqual({ minimized: false, visible: true, active: true });
  expect(await state(app, 'main')).toMatchObject({ minimized: true, visible: false });
  await expect(note.getByTestId('note-title')).toHaveValue(`Dock ${RUN}`);
  await note.waitForTimeout(2000);
  expect(await state(app, 'main')).toMatchObject({ minimized: true });
  expect(launched.errors).toEqual([]);
});

test('AC3: with the main window closed, the Dock icon brings back the minimized note window', async () => {
  const launched = await start();
  const { app } = launched;
  const note = await noteWindow(launched);
  await closeMain(app);
  await minimize(app, 'note');
  await note.waitForTimeout(1000);

  await clickDock(app, false);
  await expect
    .poll(() => state(app, 'note'))
    .toEqual({ minimized: false, visible: true, active: true });
  // No main window was made.
  await note.waitForTimeout(2000);
  expect(await state(app, 'main')).toBeNull();
  expect(await noteWindowCount(app)).toBe(1);
  await expect(note.getByTestId('note-title')).toHaveValue(`Dock ${RUN}`);
  expect(launched.errors).toEqual([]);
});

test('AC4: with the main window closed and a note window visible, the Dock icon makes the main window', async () => {
  const launched = await start();
  const { app } = launched;
  await noteWindow(launched);
  await closeMain(app);

  const [main] = await Promise.all([app.waitForEvent('window'), clickDock(app, true)]);
  await expect(main).toHaveURL(/^app:\/\/penmoss\//);
  await expect.poll(() => state(app, 'main')).toMatchObject({ minimized: false, visible: true });
  expect(await noteWindowCount(app)).toBe(1);
  expect(await state(app, 'note')).toMatchObject({ minimized: false, visible: true });
  await expect(main.locator('button[data-command="note.new"]')).toBeVisible();
  await main.waitForTimeout(2000);
  expect(launched.errors).toEqual([]);
});
