// Settings' laptop mark (A1559): a setting kept on this device alone, its sentence the app's
// tooltip on hover and on keyboard focus, and the mark's accessible name. The suite runs behind a
// stand-in for the Mac app, so it says "this Mac".
import { expect, test } from './fixtures';
import { collectErrors } from './support/app';

const SENTENCE = 'This setting is kept only on this Mac and isn’t synced to your other devices.';

test('the laptop mark says why on hover and on focus, and is named by it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/note');
  const row = page.getByTestId('note-panel-setting');
  const mark = row.getByRole('img', { name: SENTENCE });
  await expect(mark).toBeVisible();
  // The laptop, no words; the radios keep the label alone as their group's name.
  await expect(mark.locator('[data-icon="laptop"]')).toHaveCount(1);
  await expect(mark).toHaveText('');
  await expect(row.getByRole('radiogroup', { name: 'Note Panel', exact: true })).toBeVisible();

  const tooltip = page.getByTestId('tooltip');
  await mark.hover();
  await expect(tooltip).toHaveText(SENTENCE);
  await page.mouse.move(1400, 880);
  await expect(tooltip).toHaveCount(0);

  // From the keyboard: Tab from the label's row reaches it, and the tip shows at once.
  await row.getByRole('radio', { name: 'Closed' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(mark).toBeFocused();
  await expect(tooltip).toHaveText(SENTENCE);
  // A click on it changes nothing.
  const open = row.getByRole('radio', { name: 'Open' });
  const before = await open.isChecked();
  await mark.click();
  expect(await open.isChecked()).toBe(before);
  expect(errors).toEqual([]);
});
