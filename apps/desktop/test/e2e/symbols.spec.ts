import { expect, test, type ElectronApplication } from '@playwright/test';
import {
  body,
  launch,
  mainBounds,
  removeDataDirs,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// T44 (#107, D36, A744, A746) in the Mac app: the line symbol commands are Format menu items,
// with the slot keys (⌃1–9 on a Mac, Alt+Shift+1–9 elsewhere) and the picker, and choosing one
// acts on the note in front exactly as its keys do; Edit line symbols opens Settings → Symbols.
// The web suite (apps/web/test/e2e/symbols.spec.ts) covers drawing, the picker and Settings.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const SYMBOL = (slot: number) => (mac ? `Control+Digit${slot}` : `Alt+Shift+Digit${slot}`);
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** Chooses a menu item, as a click on it would (no key press or click in any page). */
const chooseMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);

/** The Format menu's items, by id. */
const formatItems = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? [])
      .find((top) => top.label === 'Format')
      ?.submenu?.items.filter((item) => item.type !== 'separator')
      .map((item) => ({ id: item.id ?? '', label: item.label })),
  );

test('line symbols: Format menu items and keys toggle them; Edit line symbols opens Settings', async () => {
  const launched = await launch();
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1100, height: 760 });
  await gitNotebook(launched);

  await expect
    .poll(async () => (await formatItems(app))?.map((item) => item.id))
    .toEqual(
      expect.arrayContaining([
        'editor.symbol1',
        'editor.symbol9',
        'editor.symbolPicker',
        'app.symbols',
      ]),
    );
  const items = (await formatItems(app))!;
  // Named by the slot's glyph (T51 item 12, A940).
  await expect
    .poll(async () => (await formatItems(app))?.find((item) => item.id === 'editor.symbol1')?.label)
    .toBe('Toggle Symbol ★');
  expect(items.find((item) => item.id === 'editor.symbolPicker')?.label).toBe('Symbols…');
  expect(items.find((item) => item.id === 'app.symbols')?.label).toBe('Edit Line Symbols');

  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await page.keyboard.type('Symbols on the Mac');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Call the bank');
  await expect(body(page)).toContainText('Call the bank');

  // The menu item: no key press in the page, the caret's line takes ★.
  await chooseMenu(app, 'editor.symbol1');
  const symbols = body(page).getByTestId('line-symbols').locator('.pm-symbol');
  await expect(symbols).toHaveText(['★']);
  // The key, as the menu shows it: ! joins, in the list's order.
  await page.keyboard.press(SYMBOL(3));
  await expect(symbols).toHaveText(['★', '!']);
  // The menu item again takes ★ off; the text itself is untouched.
  await chooseMenu(app, 'editor.symbol1');
  await expect(symbols).toHaveText(['!']);
  await expect(body(page)).toContainText('Call the bank');

  // Symbols… opens the picker at the line; Esc closes it and the note keeps the caret.
  await chooseMenu(app, 'editor.symbolPicker');
  const picker = page.getByTestId('symbol-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('menuitemcheckbox', { name: /!/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  await chooseMenu(app, 'app.symbols');
  await expect(page).toHaveURL(/\/settings\/symbols$/);
  await expect(page.getByTestId('symbols-settings')).toBeVisible();
});
