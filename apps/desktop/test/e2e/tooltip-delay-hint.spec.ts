import { expect, test } from '@playwright/test';
import { collectErrors, gitNotebook, go, launch, removeDataDirs, type Launched } from './support';

// PEN-86 in the Mac app: Settings → Display shows a one-line muted hint under Show Tooltips
// After. The Mac proof spec: it ends with the hint on screen.

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

test('Settings → Display shows a hint under Show Tooltips After', async () => {
  const launched = await launch({ macWindow: true });
  opened.push(launched);
  const { page } = launched;
  const errors = collectErrors(page, false);
  await gitNotebook(launched);
  await go(page, '/settings/display');
  const field = page.getByLabel('Show Tooltips After');
  const hint = page.getByTestId('tooltip-delay-hint');

  await expect(field).toBeVisible();
  await hint.scrollIntoViewIfNeeded();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('How long you hover before a tooltip shows.');
  await expect(hint).toHaveClass(/\bmuted\b/);
  await expect(field).toHaveAccessibleDescription(/^How long you hover before a tooltip shows\./);
  expect(errors).toEqual([]);
  // Hold on the hint so the recording shows it.
  await page.waitForTimeout(2000);
  await expect(hint).toBeInViewport();
});
