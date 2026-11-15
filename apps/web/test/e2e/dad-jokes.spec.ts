import { expect, test, type Page } from './fixtures';
import { storedSetting } from './stored';
import { collectErrors } from './support/app';

// Settings → Appearance → Dad Jokes (A1598): on by default, the empty window's heading is a dad
// joke (A1576); off, it reads Welcome to Penmoss, the two hints under it either way. Search
// Settings finds it by "joke" and by "welcome". Stored as the synced `home.dadJokes`.

const field = (page: Page) => page.getByRole('searchbox', { name: 'Search Settings' });
const heading = (page: Page) => page.getByTestId('empty-state').getByRole('heading', { level: 2 });
const hints = (page: Page) => page.getByTestId('empty-state').getByTestId('empty-hint');

test('Dad Jokes: a joke in the empty window, Welcome to Penmoss when it is off', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  // On by default: a joke.
  await expect(heading(page)).toHaveText(/\S/, { timeout: 40_000 });
  await expect(heading(page)).not.toHaveText('Welcome to Penmoss');
  await expect(hints(page)).toHaveCount(2);

  // Search Settings finds it by "joke" and by "welcome", on Appearance's Text group.
  await page.goto('/settings');
  const results = page.getByTestId('settings-search-results');
  for (const query of ['joke', 'welcome']) {
    await field(page).fill(query);
    const found = results.getByTestId('settings-search-result');
    await expect(found).toHaveCount(1);
    await expect(found).toContainText('Dad Jokes');
    await expect(found).toContainText('Appearance › Text');
  }
  await field(page).press('Enter');
  const toggle = page.getByRole('switch', { name: 'Dad Jokes' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAccessibleDescription(
    'A joke in place of the heading when no note is open.',
  );

  // Off: the heading welcomes; the hints stay.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => storedSetting(page, 'home.dadJokes')).toBe(false);
  await page.goto('/');
  await expect(heading(page)).toHaveText('Welcome to Penmoss', { timeout: 40_000 });
  await expect(hints(page)).toHaveText([
    /^Open a note or create one with New Note/,
    /^Or open the Command Palette/,
  ]);

  // On again: a joke.
  await page.goto('/settings/appearance');
  await page.getByRole('switch', { name: 'Dad Jokes' }).click();
  await expect.poll(() => storedSetting(page, 'home.dadJokes')).toBe(true);
  await page.goto('/');
  await expect(heading(page)).toHaveText(/\S/, { timeout: 40_000 });
  await expect(heading(page)).not.toHaveText('Welcome to Penmoss');
  expect(errors).toEqual([]);
});
