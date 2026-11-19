import { expect, test, type Page } from './fixtures';
import { holdForProof } from './support/app';

// PEN-146: Settings' nav in five groups, under Search Settings. A query's results stand in for
// the page, each with its label (the match marked) and the page › group it is on; Enter opens
// the first on its page, which scrolls to it and marks it; Escape clears. The renamed sections'
// old addresses (Display, Status) open the new ones (Sidebar, GitHub).

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });
const field = (page: Page) => page.getByRole('searchbox', { name: 'Search Settings' });

test('the nav is in five groups, This Mac’s saying it is not synced', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/settings');
  await expect(nav(page).locator('.settings-nav-heading')).toHaveText([
    'Look and Feel',
    'Writing',
    'Notebooks',
    'Agents',
    'This Mac · Not Synced',
  ]);
  // This stand-in Mac has no search by meaning unless a spec asks for it.
  const mac = nav(page).getByRole('group', { name: /This Mac/ });
  await expect(mac.getByRole('link')).toHaveText(['GitHub', 'Updates']);
  await expect(page.getByTestId('settings-home')).toContainText(
    'Settings are synced through your primary notebook',
  );
  expect(errors).toEqual([]);
});

test('Search Settings finds a setting, Enter opens it on its page, Escape clears', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/settings/shortcuts');
  await field(page).fill('font');
  const results = page.getByTestId('settings-search-results');
  await expect(results.getByRole('heading', { level: 1 })).toHaveText('Search Results');
  await expect(results.getByTestId('settings-intro')).toHaveText('3 settings match “font”.');
  const links = results.getByTestId('settings-search-result');
  await expect(links).toHaveCount(3);
  await expect(links.first()).toContainText('Interface Font');
  await expect(links.first()).toContainText('Appearance › Text');
  await expect(links.first().locator('mark')).toHaveText('Font');
  // The page's own content is gone while there is a query.
  await expect(page.locator('.settings-content > :not(.settings-results)')).toHaveCount(0);

  // Escape clears, and the page is back.
  await field(page).press('Escape');
  await expect(field(page)).toHaveValue('');
  await expect(results).toHaveCount(0);

  // Another name for it finds it too; Enter opens the first, marked on its page.
  await field(page).fill('text size');
  await expect(links).toHaveCount(1);
  await field(page).press('Enter');
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(field(page)).toHaveValue('');
  const row = page.locator('[data-setting="note-font-size"]');
  await expect(row).toHaveAttribute('data-found', '');
  await expect(row).toBeInViewport();
  await expect(row.locator(':focus')).toHaveCount(1);
  await expect(row).not.toHaveAttribute('data-found', { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test('the results are reached with the arrow keys, and a click opens one', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/settings');
  await field(page).fill('channel');
  const link = page.getByTestId('settings-search-result');
  await expect(link).toHaveText(/Update Channel/);
  await field(page).press('ArrowDown');
  await expect(link).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(field(page)).toBeFocused();
  await field(page).fill('channel');
  await link.click();
  await expect(page).toHaveURL(/\/settings\/updates$/);
  await expect(page.locator('[data-setting="update-channel"]')).toHaveAttribute('data-found', '');
  expect(errors).toEqual([]);
});

test('a renamed section’s old address opens the new one', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/settings/display');
  await expect(page).toHaveURL(/\/settings\/sidebar$/);
  await expect(nav(page).getByRole('link', { name: 'Sidebar', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.goto('/settings/status');
  await expect(page).toHaveURL(/\/settings\/github$/);
  await expect(page.getByTestId('github-token').getByRole('heading', { level: 1 })).toHaveText(
    'GitHub',
  );
  expect(errors).toEqual([]);
});

// PEN-137 (ac46): Privacy's rows are found by what people call analytics, each placed on
// Privacy or under its Advanced; a limit opens Privacy with Advanced open, the row marked.
test.describe('Privacy in Search Settings (PEN-137)', () => {
  test.use({ analytics: { consent: 'no', events: 20 } });

  test('finds Privacy’s rows for “telemetry”, and opens a limit inside Advanced', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/settings');
    const results = page.getByTestId('settings-search-results');
    const links = results.getByTestId('settings-search-result');
    await field(page).fill('telemetry');
    await expect(links.filter({ hasText: 'Share Usage Data' })).toContainText('Privacy');
    await expect(links.filter({ hasText: 'Keep Events For' })).toContainText('Privacy › Advanced');
    for (const query of ['analytics', 'tracking', 'usage', 'diagnostics', 'logs']) {
      await field(page).fill(query);
      await expect(links.filter({ hasText: /Privacy/ }).first(), query).toBeVisible();
    }
    // “privacy” lists every row of the page.
    await field(page).fill('privacy');
    await expect(links.filter({ hasText: 'Privacy' })).toHaveCount(15);

    await field(page).fill('keep at most');
    await expect(links).toHaveCount(1);
    await expect(links).toContainText('Privacy › Advanced');
    await links.click();
    await expect(page).toHaveURL(/\/settings\/privacy$/);
    await expect(page.getByTestId('privacy-advanced')).toHaveAttribute('open', '');
    const row = page.locator('[data-setting="keep-at-most"]');
    await expect(row).toHaveAttribute('data-found', '');
    await expect(row).toBeInViewport();
    await expect(row.getByRole('textbox')).toBeFocused();
    await holdForProof(page, 2_000);
    expect(errors).toEqual([]);
  });
});
