import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
// The page's `window.penmossDesktop` (types only).
import type {} from '../../../web/src/desktop/bridge';
import {
  body,
  launch,
  mainBounds,
  removeDataDirs,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// T41: Ryan's Mac app feedback, round 1, in the Mac app: full-width notes, the Info panel,
// the status bar and the sidebar rail, each from the View menu as well as its button. Notes live
// in a git notebook made for each test (T59); full width is turned off again at the end.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

async function start(): Promise<Launched> {
  const launched = await launch();
  opened.push(launched);
  // Wider than the sidebar and a 52rem column (xvfb's screen is 1280 px wide).
  await mainBounds(launched.app, { x: 0, y: 0, width: 1280, height: 900 });
  return launched;
}

/** Chooses a menu item, as a click on it would. */
const chooseMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);

/** The View menu's item ids. */
const viewMenu = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
    return view?.submenu?.items.map((item) => item.id).filter(Boolean) ?? [];
  });

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

const width = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);

test('full width, the Info panel, the status bar and the sidebar rail, from the View menu', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  expect(await viewMenu(app)).toEqual(
    expect.arrayContaining(['note.backlinks', 'note.fullWidth', 'app.toggleSidebar']),
  );
  await newNote(page, `Mac feedback ${RUN}`, 'one two three four five');
  const view = page.getByTestId('note-view');

  // The status bar: saved and synced, and the counts once typing pauses.
  const bar = page.getByTestId('status-bar');
  await expect(bar.getByTestId('save-status')).toHaveAttribute('data-state', 'synced', {
    timeout: 20_000,
  });
  await expect(bar.getByTestId('save-status')).toHaveText('Saved · in git');
  await expect(bar.getByTestId('note-counts')).toContainText('5 words');
  await expect(bar.getByTestId('note-counts')).toContainText('23 characters');
  await body(page).press('Shift+Home');
  await expect(bar.getByTestId('selection-counts')).toHaveText(
    '5 words and 23 characters selected',
  );
  // To the line's end, which drops the selection: on a Mac, End scrolls instead (the web's
  // LINE_END), so ⌘→ there.
  await body(page).press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await expect(bar.getByTestId('selection-counts')).toHaveCount(0);

  // The Info panel: shown and hidden from the menu, with the note's details and tags.
  const info = page.getByRole('complementary', { name: 'Metadata' });
  if (!(await info.isVisible())) await chooseMenu(app, 'note.backlinks');
  await expect(info).toBeVisible();
  await expect(info.getByTestId('info-folder')).toHaveText('Top level');
  await expect(info.getByTestId('info-words')).toHaveText('5');
  await expect(info.getByRole('button', { name: 'Add a Tag', exact: true })).toBeVisible();
  // Its tab's icon down the note's edge shows it open (T53 item 9).
  await expect(page.getByTestId('note-tab-info')).toHaveAttribute('aria-selected', 'true');
  await chooseMenu(app, 'note.backlinks');
  await expect(info).toHaveCount(0);
  await expect(page.getByTestId('note-tab-info')).toHaveAttribute('aria-selected', 'false');

  // Full width: from the menu, then the button; the column grows to the window's width.
  const column = await width(page, '.doc:not([hidden])');
  expect(column).toBe(58 * 16);
  const toggle = page.getByTestId('toggle-full-width');
  try {
    await chooseMenu(app, 'note.fullWidth');
    await expect(view).toHaveAttribute('data-width', 'full');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // The column now fills the note's pane (less its scrollbar and the strip of panel tabs down
    // its edge, T53 item 9), wider than the theme's.
    const pane = (await width(page, '.note-main')) - (await width(page, '.note-rail'));
    const full = await width(page, '.doc:not([hidden])');
    expect(full).toBeGreaterThan(column + 20);
    expect(full).toBeGreaterThan(pane - 20);
  } finally {
    // Leave the setting off, as the rest of the test expects.
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    await expect(view).not.toHaveAttribute('data-width', 'full');
  }

  // The sidebar: an icon rail, then back; remembered across launches.
  const shell = page.getByTestId('app-root');
  await chooseMenu(app, 'app.toggleSidebar');
  await expect(shell).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(page.getByTestId('calendar')).toBeHidden();
  await expect(page.getByTestId('open-search')).toBeVisible();
  await page.reload();
  await expect(shell).toHaveAttribute('data-sidebar', 'collapsed');
  await page.getByTestId('toggle-sidebar').click();
  await expect(shell).not.toHaveAttribute('data-sidebar', 'collapsed');
  expect(launched.errors).toEqual([]);
});

// T39 pass 2 (A526): as in any Mac app, a menu item that cannot run now is greyed out.
test('menu items that cannot run now are greyed out, and come back when they can', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  const enabled = (id: string) =>
    app.evaluate(
      ({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? null,
      id,
    );
  // No note open: nothing to move to Trash or make bold; a new note can always be made.
  await expect(page.getByTestId('app-root')).toBeVisible();
  await expect.poll(() => enabled('note.delete')).toBe(false);
  await expect.poll(() => enabled('editor.bold')).toBe(false);
  expect(await enabled('note.new')).toBe(true);
  await newNote(page, `Menu state ${RUN}`, 'text');
  await expect.poll(() => enabled('note.delete')).toBe(true);
  await expect.poll(() => enabled('editor.bold')).toBe(true);
});
