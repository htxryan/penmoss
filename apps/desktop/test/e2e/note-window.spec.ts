import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  body,
  launch,
  mainBounds,
  removeDataDirs,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// T45 (#108, D37, A710–A712) in the Mac app: note windows the main process makes itself, menus
// and menu commands that follow the window in front, the main window made again when only note
// windows are open, none restored after a relaunch, and edits shown in every window, offline
// too. The web suite (apps/web/test/e2e/note-window.spec.ts) covers the shell itself.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const WINDOW = /^app:\/\/penmoss\/window\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  const launched = await launch(options);
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1100, height: 760 });
  return launched;
}

async function quit(launched: Launched): Promise<void> {
  opened.splice(opened.indexOf(launched), 1);
  await launched.app.close();
}

/** The main process's test hooks (main.ts). */
interface Hooks {
  penmossDesktop: {
    mainWindow(): Electron.BrowserWindow | null;
    noteWindows(): Electron.BrowserWindow[];
    activeWindow(): Electron.BrowserWindow | null;
  };
}

/** Chooses a menu item, as a click on it would (no key press or click in any page). */
const chooseMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);

/** Whether the menu bar's item can be chosen now. */
const menuEnabled = (app: ElectronApplication, id: string) =>
  app.evaluate(
    ({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled,
    id,
  );

/** Brings a window to the front as macOS does: its `focus` event (xvfb has no window manager). */
/** Which window the menu bar's commands go to (A712): `main`, or a note window's index. */
const activeWindow = (app: ElectronApplication) =>
  app.evaluate(() => {
    const hooks = (globalThis as unknown as Hooks).penmossDesktop;
    const active = hooks.activeWindow();
    return active === hooks.mainWindow() ? 'main' : hooks.noteWindows().indexOf(active!);
  });

/**
 * Brings a window to the front, as far as the menu bar knows, and waits until it is the one
 * menu commands go to.
 */
async function focus(app: ElectronApplication, which: 'main' | number) {
  await app.evaluate((_electron, target) => {
    const hooks = (globalThis as unknown as Hooks).penmossDesktop;
    const window = target === 'main' ? hooks.mainWindow() : hooks.noteWindows()[target];
    window!.emit('focus');
  }, which);
  await expect.poll(() => activeWindow(app)).toBe(which);
}

const noteWindowCount = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.noteWindows().length);

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

/** Runs `open` and returns the note window it made, once its note shows. */
async function noteWindowFrom(
  app: ElectronApplication,
  open: () => Promise<unknown>,
  title: string,
): Promise<Page> {
  const [window] = await Promise.all([app.waitForEvent('window'), open()]);
  await expect(window).toHaveURL(WINDOW);
  await expect(window.getByTestId('note-window')).toBeVisible();
  await expect(window.getByTestId('note-title')).toHaveValue(title);
  await expect(window.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return window;
}

test('note windows: made by the app, menus follow the window in front, the main window comes back', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  const title = `Mac window ${RUN}`;
  const id = await newNote(page, title, `In the main window ${RUN}.`);

  // File → Open in new window: a menu command, with no key press or click in the page.
  const first = await noteWindowFrom(app, () => chooseMenu(app, 'note.openInNewWindow'), title);
  expect(new URL(first.url()).pathname).toBe(`/window/notes/${id}`);
  await expect(first).toHaveTitle(`${title} – Penmoss`);
  await expect(first.locator('#app-sidebar')).toHaveCount(0);
  await expect(first.getByTestId('status-bar')).toBeVisible();
  // The main process made it: no opener, and the page knows it is a note window.
  expect(await first.evaluate(() => window.opener === null)).toBe(true);
  expect(await first.evaluate(() => window.penmossDesktop?.window)).toBe('note');
  // 720×800 (no bigger than the display), a step from the window in front.
  const [mainBox, noteBox, area] = await app.evaluate(({ screen }) => {
    const hooks = (globalThis as unknown as Hooks).penmossDesktop;
    return [
      hooks.mainWindow()!.getBounds(),
      hooks.noteWindows()[0]!.getBounds(),
      screen.getPrimaryDisplay().workArea,
    ];
  });
  expect(noteBox.width).toBe(Math.min(720, area.width));
  expect(noteBox.height).toBe(Math.min(800, area.height));
  expect([noteBox.x, noteBox.y]).not.toEqual([mainBox.x, mainBox.y]);

  // The note's ⋯ menu in the main window opens another, on the same note.
  const second = await noteWindowFrom(
    app,
    async () => {
      await page.getByTestId('note-menu').click();
      await page.getByTestId('open-in-window').click();
    },
    title,
  );
  expect(await noteWindowCount(app)).toBe(2);
  // The new window comes to the front by itself (the system's focus event). Wait for it: on a
  // loaded machine it can come after the focus below, and the menu commands then went to it.
  await expect.poll(() => activeWindow(app)).toBe(1);

  // The menu bar is the window in front's: a note window has no sidebar to collapse.
  await focus(app, 0);
  await expect.poll(() => menuEnabled(app, 'app.toggleSidebar')).toBe(false);
  // Its menu commands act on it, not on the main window.
  // Beside the note or, in a window too narrow for the side panel, over its text (T53 item 9).
  const info = (view: Page) => view.getByTestId('note-info');
  const infoShown = async (view: Page) => (await info(view).count()) > 0;
  const mainInfo = await infoShown(page);
  const noteInfo = await infoShown(first);
  await chooseMenu(app, 'note.backlinks');
  await expect.poll(() => infoShown(first)).toBe(!noteInfo);
  expect(await infoShown(page)).toBe(mainInfo);
  expect(await infoShown(second)).toBe(noteInfo);
  await focus(app, 'main');
  await expect.poll(() => menuEnabled(app, 'app.toggleSidebar')).toBe(true);
  await chooseMenu(app, 'note.backlinks');
  await expect.poll(() => infoShown(page)).toBe(!mainInfo);
  expect(await infoShown(first)).toBe(!noteInfo);

  // Typing in a note window shows in the main window and the other note window, through this Mac.
  // A panel over the text in a narrow window: Close puts it away first (T53 item 9).
  if ((await first.locator('.note-columns[data-over]').count()) > 0) {
    await first.getByTestId('note-panel-close').click();
    await expect(first.locator('.note-columns')).toHaveAttribute('data-panel', 'closed');
  }
  await body(first).click();
  await first.keyboard.press('ControlOrMeta+End');
  await first.keyboard.type(` From a note window ${RUN}.`);
  await expect(body(page)).toContainText(`From a note window ${RUN}.`, { timeout: 1000 });
  await expect(body(second)).toContainText(`From a note window ${RUN}.`, { timeout: 1000 });

  // Note windows are never kept in window-state.json.
  await page.waitForTimeout(600); // The main window's state is saved 400 ms after a change.
  const state = JSON.parse(
    readFileSync(join(launched.userData, 'window-state.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(state).toMatchObject({ width: 1100, height: 760 });

  // Closing the main window leaves the note windows open.
  await app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.close());
  await expect
    .poll(
      () =>
        app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.mainWindow() === null),
      // Closing waits for the window's git notebooks to push (A825, #170 F8).
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(await noteWindowCount(app)).toBe(2);
  await expect(first.getByTestId('note-title')).toHaveValue(title);

  // A page a note window does not show (Settings, from the menu) makes the main window again.
  await focus(app, 1);
  const [main] = await Promise.all([app.waitForEvent('window'), chooseMenu(app, 'app.settings')]);
  await expect(main).toHaveURL(/^app:\/\/penmoss\/settings/);
  await expect(second).toHaveURL(WINDOW);
  // Window → Penmoss shows it too, with the note windows open.
  await app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.close());
  await expect
    .poll(
      () =>
        app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.mainWindow() === null),
      // Closing waits for the window's git notebooks to push (A825, #170 F8).
      { timeout: 30_000 },
    )
    .toBe(true);
  const [again] = await Promise.all([app.waitForEvent('window'), chooseMenu(app, 'window.main')]);
  await expect(again).toHaveURL(/^app:\/\/penmoss\//);
  expect(await noteWindowCount(app)).toBe(2);
  expect(launched.errors).toEqual([]);
});

test('no note window comes back after a relaunch; offline, edits show between windows', async () => {
  const first = await start();
  await gitNotebook(first);
  const title = `Mac offline window ${RUN}`;
  const id = await newNote(first.page, title, `Before going offline ${RUN}.`);
  await noteWindowFrom(first.app, () => chooseMenu(first.app, 'note.openInNewWindow'), title);
  expect(await noteWindowCount(first.app)).toBe(1);
  // Quitting closes every window.
  await quit(first);

  const offline = await start({
    userData: first.userData,
    offline: true,
    args: [`penmoss://note/${id}`],
  });
  const { app, page } = offline;
  await expect(page).toHaveURL(`app://penmoss/notes/${id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true', {
    timeout: 20_000,
  });
  await page.waitForTimeout(500);
  expect(await noteWindowCount(app)).toBe(0);
  expect(app.windows().some((window) => WINDOW.test(window.url()))).toBe(false);

  const window = await noteWindowFrom(app, () => chooseMenu(app, 'note.openInNewWindow'), title);
  // With no network, between the windows through the main process (A711).
  await body(window).click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(` Offline in the note window ${RUN}.`);
  await expect(body(page)).toContainText(`Offline in the note window ${RUN}.`, { timeout: 1000 });
  await body(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(` Offline in the main window ${RUN}.`);
  await expect(body(window)).toContainText(`Offline in the main window ${RUN}.`, {
    timeout: 1000,
  });
  // Each edit once, in both.
  const text = `Before going offline ${RUN}. Offline in the note window ${RUN}. Offline in the main window ${RUN}.`;
  await expect(body(page)).toHaveText(text);
  await expect(body(window)).toHaveText(text);
  expect(offline.errors).toEqual([]);
});
