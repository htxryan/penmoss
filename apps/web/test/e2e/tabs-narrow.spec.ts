import { expect, test, type Page } from './fixtures';

// PEN-140 (web, AC13): at 700 px and narrower the tab strip hides, and the app bar's Tabs
// button, with the count, opens a sheet of the tabs (pinned first, the active one marked, × on
// the others) with New Tab. Switching and closing work from it, and a reload keeps the tabs.

const RUN = `${Date.now().toString(36)}${100 + Math.floor(Math.random() * 900)}`;
const ALPHA = `Alpha ${RUN}`;
const BETA = `Beta ${RUN}`;
const GAMMA = `Gamma ${RUN}`;

test.use({
  seed: {
    name: 'Notes',
    notes: [
      { title: ALPHA, markdown: 'The first note.' },
      { title: BETA, markdown: 'The second note.' },
      { title: GAMMA, markdown: 'The third note.' },
    ],
  },
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function shows(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

const button = (page: Page) => page.getByTestId('note-view').getByTestId('tabs-button');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Tabs' });

test('a narrow window lists the tabs in a sheet from the app bar (AC13)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  // Two tabs, opened wide.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const tree = page.getByTestId('note-list');
  await expect(tree.getByRole('link', { name: ALPHA, exact: true })).toBeVisible({
    timeout: 40_000,
  });
  await tree.getByRole('link', { name: ALPHA, exact: true }).click();
  await shows(page, ALPHA);
  await tree.getByRole('link', { name: BETA, exact: true }).click({ button: 'middle' });
  await expect(page.getByRole('tablist', { name: 'Open Tabs' }).getByRole('tab')).toHaveCount(2);
  // Alpha pinned, from its tab's menu.
  await page
    .getByRole('tablist', { name: 'Open Tabs' })
    .getByRole('tab', { name: new RegExp(`^${ALPHA}`) })
    .click({ button: 'right' });
  await page.getByTestId('tab-menu-pin').click();
  await expect(page.getByTestId('tab-pinned')).toHaveCount(1);

  // Narrow: no strip; the Tabs button says how many (44 px, A183).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('tab-strip')).toHaveCount(0);
  await expect(button(page)).toBeVisible();
  await expect(button(page)).toHaveAccessibleName('Tabs, 2');
  // The app bar keeps the note's place (A181).
  await expect(page.getByTestId('note-view').getByTestId('app-bar-path')).toBeVisible();

  await button(page).click();
  await expect(sheet(page)).toBeVisible();
  const rows = sheet(page).getByTestId('tabs-sheet-tab');
  await expect(rows).toHaveCount(2);
  // "2 Tabs"; the pinned one first, its pin before its badge, "Pinned" after its notebook, and
  // no × (ac13).
  await expect(sheet(page).getByTestId('tabs-sheet-heading')).toHaveText('2 Tabs');
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(0)).toContainText(ALPHA);
  const pin = (await rows.nth(0).getByTestId('tabs-sheet-pin').boundingBox())!;
  const badge = (await rows.nth(0).getByTestId('notebook-badge').boundingBox())!;
  expect(pin.x).toBeLessThan(badge.x);
  await expect(rows.nth(0).getByTestId('tabs-sheet-path')).toHaveText('Notes · Pinned');
  await expect(rows.nth(1).getByTestId('tabs-sheet-pin')).toHaveCount(0);
  await expect(sheet(page).getByTestId('tabs-sheet-close')).toHaveCount(1);
  // Each row has its notebook's badge, and where the note is.
  await expect(rows.nth(1).getByTestId('notebook-badge')).toBeVisible();
  await expect(rows.nth(1)).toContainText('Notes');
  // Escape closes it, and focus goes back to the button.
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toBeHidden();
  await expect(button(page)).toBeFocused();

  // Switch from it.
  await button(page).click();
  await sheet(page).getByTestId('tabs-sheet-tab').filter({ hasText: BETA }).click();
  await expect(sheet(page)).toBeHidden();
  await shows(page, BETA);

  // New Tab from it asks which note (A1594): Escape makes no tab, a pick makes one.
  await button(page).click();
  await sheet(page).getByTestId('tabs-sheet-new').click();
  await expect(sheet(page)).toBeHidden();
  const picker = page.getByRole('dialog', { name: 'New Tab' });
  await expect(picker.getByRole('combobox', { name: 'New Tab' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(page.getByTestId('tabs-button')).toHaveAccessibleName('Tabs, 2');
  await shows(page, BETA);
  await button(page).click();
  await sheet(page).getByTestId('tabs-sheet-new').click();
  await picker.getByRole('combobox', { name: 'New Tab' }).fill(GAMMA);
  await expect(picker.getByRole('option').first()).toContainText(GAMMA);
  await page.keyboard.press('Enter');
  await shows(page, GAMMA);
  await expect(page.getByTestId('tabs-button')).toHaveAccessibleName('Tabs, 3');
  await page.getByTestId('tabs-button').click();
  await expect(sheet(page).getByTestId('tabs-sheet-tab')).toHaveCount(3);
  await sheet(page).getByTestId('tabs-sheet-close').last().click();
  await expect(sheet(page).getByTestId('tabs-sheet-tab')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // A reload keeps them.
  await page.reload();
  await expect(button(page)).toHaveAccessibleName('Tabs, 2', { timeout: 40_000 });
  await button(page).click();
  await expect(sheet(page).getByTestId('tabs-sheet-tab')).toHaveCount(2);
  await page.waitForTimeout(2_000);
  await expect(sheet(page)).toBeVisible();
  expect(errors).toEqual([]);
});
