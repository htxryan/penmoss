import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { EVENT } from '../../src/ipc-contract';
import { TITLE_BAR_INSET, TITLE_BAR_ROW } from '../../src/mac-window';
import {
  body,
  launch,
  mainBounds,
  removeDataDirs,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// PEN-140 in the Mac app: note tabs in the main window. The File menu has New Tab ⌘T, Reopen
// Closed Tab ⇧⌘T, Close Tab ⌘W, Close Other Tabs and Close Window ⇧⌘W; ⌃Tab and ⌘2 switch; the
// strip is the compact title bar's first row, dragging the window by its empty part while its
// tabs and the note's buttons at its end still click; each tab starts with its notebook's badge
// and the note has no title row; a quit and relaunch brings the tabs back (AC3, AC7, AC11,
// AC14, AC19, AC20). The menu bar icon's Open Today's Journal and a deep link switch to the note's
// tab, else open a new one, and Move to New Window takes a tab to a note window (AC11). The web
// suite (apps/web/test/e2e/tabs.spec.ts) covers the rest.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  // The Mac's window behaviours, the compact title bar among them (as mac-window.spec.ts).
  const launched = await launch({ macWindow: true, ...options });
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1280, height: 800 });
  return launched;
}

async function quit(launched: Launched): Promise<void> {
  opened.splice(opened.indexOf(launched), 1);
  await launched.app.close();
}

/** Chooses a menu item, as a click on it would (no key press or click in any page). */
const chooseMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);

/** The main process's test hooks (main.ts). */
interface Hooks {
  penmossDesktop: {
    mainWindow(): Electron.BrowserWindow | null;
    clickTrayItem(id: string): boolean;
  };
}

/** A click on the menu bar icon's item, as the suite cannot open a menu bar menu. */
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
    [EVENT.openPath, path] as const,
  );

/** The File menu's items: id (or role), label and accelerator. */
const fileMenu = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) =>
    (
      Menu.getApplicationMenu()
        ?.items.find((item) => item.label === 'File')
        ?.submenu?.items.filter((item) => item.type !== 'separator') ?? []
    ).map((item) => ({
      id: item.id || item.role || '',
      label: item.label,
      accelerator: String(item.accelerator ?? ''),
    })),
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

const strip = (page: Page) => page.getByRole('tablist', { name: 'Open Tabs' });

/** The tabs' titles in strip order, the active one starred. */
async function titles(page: Page): Promise<string[]> {
  return strip(page)
    .getByRole('tab')
    .evaluateAll((items) =>
      items.map(
        (item) =>
          `${item.getAttribute('aria-selected') === 'true' ? '*' : ''}${item.querySelector('.tab-title bdi')?.textContent ?? ''}`,
      ),
    );
}

/** `-webkit-app-region` at a point of the page. */
const regionAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      for (let element = document.elementFromPoint(px!, py!); element;) {
        const value = getComputedStyle(element).getPropertyValue('-webkit-app-region');
        if (value === 'drag' || value === 'no-drag') return value;
        element = element.parentElement;
      }
      return 'none';
    },
    [x, y],
  );

test('tabs in the Mac app: the File menu, the keys, the title bar, and a relaunch', async () => {
  test.setTimeout(240_000);
  const first = await start();
  const { app, page } = first;
  await gitNotebook(first);
  const a = `Mac tab A ${RUN}`;
  const b = `Mac tab B ${RUN}`;
  const c = `Mac tab C ${RUN}`;
  await newNote(page, a, 'The first tab.');
  // File → New Tab… asks which note (A1594): Escape makes no tab; its New Note, at the top,
  // makes a note in a new tab; and once more.
  const picker = page.getByRole('dialog', { name: 'New Tab' });
  await chooseMenu(app, 'tab.new');
  await expect(picker.getByRole('combobox', { name: 'New Tab' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  expect(await titles(page)).toEqual([`*${a}`]);
  const pickNewNote = async (title: string, text: string): Promise<string> => {
    await chooseMenu(app, 'tab.new');
    await expect(picker.getByRole('option').first()).toContainText('New Note');
    await page.keyboard.press('Enter');
    await expect(picker).toBeHidden();
    await expect(page).toHaveURL(ULID);
    await expect(page.getByTestId('note-title')).toBeFocused();
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
    await expect(body(page)).toContainText(text);
    return ULID.exec(new URL(page.url()).pathname)![1]!;
  };
  const bId = await pickNewNote(b, 'The second tab.');
  expect(await titles(page)).toEqual([a, `*${b}`]);
  await pickNewNote(c, 'The third tab.');
  expect(await titles(page)).toEqual([a, b, `*${c}`]);

  // The File menu's tab items, with their keys; Close Window takes ⇧⌘W (AC3).
  const file = await fileMenu(app);
  const item = (id: string) => file.find((entry) => entry.id === id);
  expect(item('tab.new')).toMatchObject({ label: 'New Tab…', accelerator: 'CommandOrControl+T' });
  expect(item('tab.reopenClosed')).toMatchObject({
    label: 'Reopen Closed Tab',
    accelerator: 'CommandOrControl+Shift+T',
  });
  expect(item('tab.close')).toMatchObject({
    label: 'Close Tab',
    accelerator: 'CommandOrControl+W',
  });
  expect(item('tab.closeOthers')).toMatchObject({ label: 'Close Other Tabs' });
  if (mac) {
    expect(item('close')).toMatchObject({
      label: 'Close Window',
      accelerator: 'Shift+CommandOrControl+W',
    });
  }
  // Where they sit, as in other tabbed Mac apps: New Tab after New Note, Reopen Closed Tab
  // after Open in New Window, and Close Tab, Close Other Tabs and Close Window last.
  const order = file.map((entry) => entry.id);
  expect(order[order.indexOf('note.new') + 1]).toBe('tab.new');
  expect(order[order.indexOf('note.openInNewWindow') + 1]).toBe('tab.reopenClosed');
  if (mac) expect(order.slice(-3)).toEqual(['tab.close', 'tab.closeOthers', 'close']);

  // ⌃Tab wraps to the first tab; ⌘2 shows the second.
  await page.keyboard.press('Control+Tab');
  expect(await titles(page)).toEqual([`*${a}`, b, c]);
  await expect(page.getByTestId('note-title')).toHaveValue(a);
  await page.keyboard.press('ControlOrMeta+Digit2');
  expect(await titles(page)).toEqual([a, `*${b}`, c]);
  await expect(page.getByTestId('note-title')).toHaveValue(b);
  // Close Tab and Reopen Closed Tab from the menu.
  await chooseMenu(app, 'tab.close');
  expect(await titles(page)).toEqual([a, `*${c}`]);
  await chooseMenu(app, 'tab.reopenClosed');
  expect(await titles(page)).toEqual([a, `*${b}`, c]);
  await expect(page.getByTestId('note-title')).toHaveValue(b);
  // Two closed and two reopened in a row: each back where it was, one tab active throughout.
  await chooseMenu(app, 'tab.close');
  await expect.poll(() => titles(page)).toEqual([a, `*${c}`]);
  await chooseMenu(app, 'tab.close');
  await expect.poll(() => titles(page)).toEqual([`*${a}`]);
  await chooseMenu(app, 'tab.reopenClosed');
  await expect.poll(() => titles(page)).toEqual([a, `*${c}`]);
  await chooseMenu(app, 'tab.reopenClosed');
  await expect.poll(() => titles(page)).toEqual([a, `*${b}`, c]);
  await expect(page.getByTestId('note-title')).toHaveValue(b);

  // Each tab starts with its notebook's badge; the note has no title row (AC19, AC20).
  for (const tab of await strip(page).getByRole('tab').all()) {
    await expect(tab.getByTestId('notebook-badge')).toHaveAttribute('aria-label', 'Notes');
  }
  await expect(page.locator('.note-main .note-top')).toHaveCount(0);
  const end = page.locator('.tab-strip-end');
  await expect(end.getByTestId('note-menu')).toBeVisible();

  // The compact title bar: the strip is the first row, beside the sidebar's head (AC14).
  const row = (await page.getByTestId('tab-strip').boundingBox())!;
  expect(row.y).toBe(0);
  expect(row.height).toBe(TITLE_BAR_ROW + 1);
  const empty = { x: (await end.boundingBox())!.x - 40, y: row.y + row.height / 2 };
  expect(await regionAt(page, empty.x, empty.y)).toBe('drag');
  const active = (await strip(page).getByRole('tab', { selected: true }).boundingBox())!;
  expect(await regionAt(page, active.x + 20, active.y + active.height / 2)).toBe('no-drag');
  // Every tab runs from 0.3 rem below the window's top edge down to the rule (A1573, A1631),
  // and clicks from its top; the gap above it drags the window, as the rest of the row does.
  for (const each of await strip(page).getByRole('tab').all()) {
    const box = (await each.boundingBox())!;
    expect(box.y).toBeCloseTo(4.8, 0);
    expect(box.y + box.height).toBeGreaterThanOrEqual(TITLE_BAR_ROW);
    expect(await regionAt(page, box.x + 20, box.y + 2)).toBe('no-drag');
    expect(await regionAt(page, box.x + 20, 2)).toBe('drag');
  }
  const menuButton = (await end.getByTestId('note-menu').boundingBox())!;
  expect(await regionAt(page, menuButton.x + 10, menuButton.y + 10)).toBe('no-drag');
  // Beside the rail, the strip holds Back and Forward after the lights.
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  const back = (await page.getByTestId('tab-strip').getByTestId('app-back').boundingBox())!;
  expect(back.x).toBeGreaterThanOrEqual(TITLE_BAR_INSET);
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-sidebar', 'collapsed');
  // A click on a tab still switches.
  await strip(page)
    .getByRole('tab', { name: new RegExp(`^${c}`) })
    .click();
  await expect(page.getByTestId('note-title')).toHaveValue(c);
  expect(first.errors).toEqual([]);

  // Quit and relaunch: the same tabs, in order, the same one active (AC7).
  await page.waitForTimeout(500);
  await quit(first);
  const again = await start({ userData: first.userData });
  await expect(strip(again.page).getByRole('tab')).toHaveCount(3, { timeout: 30_000 });
  expect(await titles(again.page)).toEqual([a, b, `*${c}`]);
  await expect(again.page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  await expect(again.page.getByTestId('note-title')).toHaveValue(c);
  await again.page.waitForTimeout(2_000);
  await expect(strip(again.page).getByRole('tab', { selected: true })).toBeVisible();

  // The menu bar icon's Open Today's Journal: a new tab in front, never in place of C (AC11).
  const shown = again.page;
  await expect.poll(() => clickTray(again.app, 'tray.today'), { timeout: 15_000 }).toBe(true);
  await expect(strip(shown).getByRole('tab')).toHaveCount(4);
  await expect(shown.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  const today = (await shown.getByTestId('note-title').inputValue()) || 'Untitled';
  expect(await titles(shown)).toEqual([a, b, c, `*${today}`]);
  // Again from another tab: the same tab, not a second one.
  await shown.keyboard.press('ControlOrMeta+Digit1');
  await expect(shown.getByTestId('note-title')).toHaveValue(a);
  expect(await clickTray(again.app, 'tray.today')).toBe(true);
  await expect.poll(() => titles(shown)).toEqual([a, b, c, `*${today}`]);
  // A deep link to an open note switches to its tab.
  await openPath(again.app, `/notes/${bId}`);
  await expect.poll(() => titles(shown)).toEqual([a, `*${b}`, c, today]);
  await expect(shown.getByTestId('note-title')).toHaveValue(b);

  // Move to New Window: the tab's note in a note window, which has no strip; the tab closes.
  const [window] = await Promise.all([
    again.app.waitForEvent('window'),
    chooseMenu(again.app, 'tab.moveToWindow'),
  ]);
  await expect(window.getByTestId('note-view')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  await expect(window.getByTestId('note-title')).toHaveValue(b);
  await expect(window.getByTestId('tab-strip')).toHaveCount(0);
  await expect.poll(() => titles(shown)).toEqual([a, `*${c}`, today]);
  // The main window in front again, ending on its strip.
  await again.app.evaluate(() =>
    (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.focus(),
  );
  await shown.waitForTimeout(2_000);
  await expect(strip(shown).getByRole('tab', { selected: true })).toBeVisible();
  expect(again.errors).toEqual([]);
});
