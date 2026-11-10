import { expect, test } from './fixtures';

// PEN-86: Settings → Display shows a one-line muted hint under Show Tooltips After. The web
// proof spec: it ends with the hint on screen.

test('Settings → Display shows a hint under Show Tooltips After', async ({ page }) => {
  await page.goto('/settings/display');
  const field = page.getByLabel('Show Tooltips After');
  const hint = page.getByTestId('tooltip-delay-hint');

  await expect(field).toBeVisible();
  await hint.scrollIntoViewIfNeeded();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('How long you hover before a tooltip shows.');
  await expect(hint).toHaveClass(/\bmuted\b/);
  await expect(field).toHaveAccessibleDescription(/^How long you hover before a tooltip shows\./);
  // Hold on the hint so the recording shows it.
  await page.waitForTimeout(2000);
  await expect(hint).toBeInViewport();
});
