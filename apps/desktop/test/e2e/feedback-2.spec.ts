import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  body,
  launch,
  mainBounds,
  removeDataDirs,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// T42 (#104 items 1–9) in the Mac app: what differs from the browser. The page's own context
// menu opens on a right-click (Electron shows no native one), the menus list Settings → Display
// and Sync, and Sync stopped leads to Settings → Sync. The web suite covers the rest.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

async function start(): Promise<Launched> {
  const launched = await launch();
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1280, height: 900 });
  return launched;
}

/** Chooses a menu item, as a click on it would. */
const chooseMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);

/** The ids of a menu's items. */
const menuIds = (app: ElectronApplication, label: string) =>
  app.evaluate(({ Menu }, name) => {
    const menu = Menu.getApplicationMenu()?.items.find((item) => item.label === name);
    return menu?.submenu?.items.map((item) => item.id).filter(Boolean) ?? [];
  }, label);

async function newNote(page: Page, title: string, text: string): Promise<void> {
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text);
}

test('a right-click opens the page’s own menu; the note’s ⋯ menu; Display settings', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  // Electron would show nothing of its own on a right-click; no native menu is ever popped up.
  await app.evaluate(({ Menu }) => {
    const shown: string[] = [];
    (globalThis as unknown as { popups: string[] }).popups = shown;
    const popup = Reflect.get(Menu.prototype, 'popup') as (
      this: Electron.Menu,
      ...args: unknown[]
    ) => void;
    Reflect.set(Menu.prototype, 'popup', function (this: Electron.Menu, ...args: unknown[]) {
      shown.push('popup');
      popup.apply(this, args);
    });
  });
  await newNote(page, `Mac ctx one ${RUN}`, 'One.');
  await newNote(page, `Mac ctx two ${RUN}`, 'Two.');
  const tree = page.getByRole('tree', { name: 'Folders and notes' });
  const one = tree.getByRole('treeitem', { name: `Mac ctx one ${RUN}`, exact: true });
  const two = tree.getByRole('treeitem', { name: `Mac ctx two ${RUN}`, exact: true });
  await one.click();
  // One more: ⌘ on a Mac, where Ctrl-click is a right-click; Ctrl elsewhere.
  await two.click({ modifiers: [mac ? 'Meta' : 'Control'] });
  await expect(one).toHaveAttribute('aria-selected', 'true');
  await expect(two).toHaveAttribute('aria-selected', 'true');
  await two.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '2 notes' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Move 2 notes…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Move 2 notes to Trash' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(
    await app.evaluate(() => (globalThis as unknown as { popups: string[] }).popups.length),
  ).toBe(0);

  // The note's actions in one ⋯ menu.
  await page.getByTestId('note-menu').click();
  await expect(page.getByRole('menu', { name: 'Note Actions' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Settings → Display from the View menu. Settings → Sync went with the server (T59, A1035).
  expect(await menuIds(app, 'View')).toContain('app.display');
  expect(await menuIds(app, 'File')).not.toContain('app.sync');
  await chooseMenu(app, 'app.display');
  await expect(page.getByTestId('display-settings')).toBeVisible();
});
