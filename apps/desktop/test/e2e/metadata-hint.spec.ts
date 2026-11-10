import { expect, test } from '@playwright/test';
import { collectErrors, gitNotebook, go, launch, removeDataDirs, type Launched } from './support';

// PEN-89 in the Mac app: Settings → Display shows a one-line hint under the "Note Metadata Under
// the Title" heading.

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

test('Settings → Display hints at what Note Metadata Under the Title picks', async () => {
  const launched = await launch({ macWindow: true });
  opened.push(launched);
  const { page } = launched;
  const errors = collectErrors(page, false);
  await gitNotebook(launched);
  await go(page, '/settings/display');

  const group = page.getByTestId('metadata-under-title');
  const hint = page.getByTestId('metadata-under-title-hint');
  await expect(group.locator('legend')).toHaveText('Note Metadata Under the Title');
  await hint.scrollIntoViewIfNeeded();
  await expect(hint).toHaveText("Pick what shows under each note's title.");
  await expect(hint).toBeInViewport();
  await page.waitForTimeout(2000);

  expect(errors).toEqual([]);
  await expect(hint).toBeInViewport();
});
