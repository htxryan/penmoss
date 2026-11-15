// Open Source Notices (A1580): a row on Settings → Updates that shows third-party-notices.txt.
import { expect, test } from './fixtures';
import { collectErrors } from './support/app';

const SHOTS = process.env['PENMOSS_EVIDENCE'];

test('Settings → Updates shows the open source notices in a dialog, and Done closes it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/settings/updates');
  const settings = page.getByTestId('updates-settings');
  const open = settings.getByTestId('open-source-notices');
  await expect(open).toHaveText('Show Notices');
  await expect(open).toHaveAccessibleDescription(
    'The licences of the open source software Penmoss includes, such as Lucide’s icons.',
  );
  await open.click();

  const dialog = page.getByRole('dialog', { name: 'Open Source Notices' });
  await expect(dialog).toBeVisible();
  const text = dialog.getByTestId('notices-text');
  await expect(text).toContainText('Lucide 1.70.0');
  await expect(text).toContainText('ISC License');
  await expect(text).toContainText('emojibase-data');
  await expect(text).toContainText('UNICODE LICENSE V3');
  // Long, so it scrolls inside the dialog, which stays inside the window.
  const scrolls = await text.evaluate((node) => node.scrollHeight > node.clientHeight);
  expect(scrolls).toBe(true);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
  if (SHOTS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${SHOTS}/open-source-notices-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  // Escape closes it too.
  await open.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  expect(errors).toEqual([]);
});

test('Search Settings finds Open Source Notices by “licences”, and opens its row', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/settings');
  const field = page.getByRole('searchbox', { name: 'Search Settings' });
  await field.fill('licences');
  const link = page.getByTestId('settings-search-result');
  await expect(link).toHaveText(/Open Source Notices/);
  await field.press('Enter');
  await expect(page).toHaveURL(/\/settings\/updates$/);
  await expect(page.locator('[data-setting="open-source-notices"]')).toHaveAttribute(
    'data-found',
    '',
  );
  expect(errors).toEqual([]);
});
