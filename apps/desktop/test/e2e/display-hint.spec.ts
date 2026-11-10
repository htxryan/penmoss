import { expect, test } from '@playwright/test';
import { collectErrors, gitNotebook, go, launch, removeDataDirs, type Launched } from './support';

// PEN-85 in the Mac app: Settings → Display says, right under its heading, that changes apply
// at once. This is the card's Mac proof spec, so it holds on the hint and ends with it on screen.

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

test('Settings → Display shows "Changes apply at once." under its heading', async () => {
  const launched = await launch({ macWindow: true });
  opened.push(launched);
  const { page } = launched;
  const errors = collectErrors(page, false);
  await gitNotebook(launched);
  await go(page, '/settings/display');

  const section = page.getByTestId('display-settings');
  const heading = section.getByRole('heading', { name: 'Display', exact: true });
  const hint = section.getByTestId('display-applies-hint');
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();
  await expect(hint).toHaveText('Changes apply at once.');
  await expect(hint).toHaveClass(/\bmuted\b/);
  // Right under the heading: it is the heading's next element.
  expect(
    await heading.evaluate((h) => (h.nextElementSibling as HTMLElement | null)?.dataset['testid']),
  ).toBe('display-applies-hint');
  await expect(hint).toBeInViewport();

  // Hold on the hint so the recording shows it, then end with it still on screen.
  await page.waitForTimeout(2000);
  expect(errors).toEqual([]);
  await expect(hint).toBeInViewport();
});
