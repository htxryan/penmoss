import { expect, test } from '@playwright/test';
import { collectErrors, gitNotebook, go, launch, removeDataDirs, type Launched } from './support';

// PEN-95 in the Mac app: Settings → Display shows a one-line hint under "Note Metadata in the
// Status Bar".

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

test('Settings → Display hints what the status bar metadata picks', async () => {
  const launched = await launch({ macWindow: true });
  opened.push(launched);
  const { page } = launched;
  const errors = collectErrors(page, false);
  await gitNotebook(launched);
  await go(page, '/settings/display');

  const group = page.getByTestId('metadata-status-bar');
  const hint = group.getByTestId('metadata-status-bar-hint');
  await expect(group.locator('legend')).toHaveText('Note Metadata in the Status Bar');
  await hint.scrollIntoViewIfNeeded();
  await expect(hint).toHaveText('Pick what the status bar shows for the open note.');
  await expect(hint).toBeInViewport();

  // Hold on the hint so the proof video shows it.
  await page.waitForTimeout(2000);
  expect(errors).toEqual([]);
  await expect(hint).toBeVisible();
  await expect(hint).toBeInViewport();
});
